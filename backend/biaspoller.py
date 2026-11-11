"""BTC 乖离率图表与价格告警：BIAS20 + 前 20 根均量倍数 + RSI14。"""
import asyncio
import json
import logging
import time
from datetime import datetime, timedelta, timezone

import httpx

from . import config, database, divpoller, poller, secpoller

log = logging.getLogger("biaspoller")

SYMBOL = "BTCUSDT"
INTERVALS = ("15m", "1h", "4h")
BIAS_PERIOD = 20
VOLUME_PERIOD = 20
VOLUME_SPIKE = 5.0
EXTREME_BIAS = {"15m": 1.5, "1h": 2.5, "4h": 4.0}
CHART_CANDLES = 600
KLINE_LIMIT = 700  # 600 根展示 + 100 根指标与历史量能预热
BIAS_CONFIG_KEY = "bias_alert_config"
BIAS_BASELINE_KEY = "bias_alert_baseline"

bias_status: dict = {"ok": None, "error": "", "last_poll": None}
bias_cache: dict = {}
_webhook_tasks: set[asyncio.Task] = set()


def get_alert_config() -> dict:
    """只执行用户显式保存的配置；默认关闭且仅网页通知。"""
    try:
        saved = json.loads(database.get_state(BIAS_CONFIG_KEY) or "{}")
    except ValueError:
        saved = {}
    price = saved.get("trigger_price")
    return {
        "enabled": bool(saved.get("enabled", False)) and isinstance(price, (int, float)) and price > 0,
        "trigger_price": price if isinstance(price, (int, float)) and price > 0 else None,
        "notify_webhook": bool(saved.get("notify_webhook", False)),
    }


def _load_baselines() -> dict:
    try:
        value = json.loads(database.get_state(BIAS_BASELINE_KEY) or "{}")
        return value if isinstance(value, dict) else {}
    except ValueError:
        return {}


def reset_alert_baseline() -> None:
    """保存配置时以当前已收盘 K 线为水位，不回放任何历史识别信号。"""
    baselines = {}
    for interval in INTERVALS:
        candles = bias_cache.get(interval, {}).get("candles", [])
        if len(candles) >= 2:
            baselines[interval] = candles[-2]["open_time"]
    database.set_state(BIAS_BASELINE_KEY, json.dumps(baselines))


def sma_series(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    if len(values) < period:
        return out
    rolling = sum(values[:period])
    out[period - 1] = rolling / period
    for i in range(period, len(values)):
        rolling += values[i] - values[i - period]
        out[i] = rolling / period
    return out


def compute_indicators(candles: list[dict]) -> dict:
    closes = [c["close"] for c in candles]
    volumes = [c.get("volume", 0.0) for c in candles]
    ma20 = sma_series(closes, BIAS_PERIOD)
    volume_ma20 = sma_series(volumes, VOLUME_PERIOD)
    bias = [
        ((close - ma) / ma * 100) if ma is not None and ma != 0 else None
        for close, ma in zip(closes, ma20)
    ]
    # 当前根只与之前已经完成的 20 根均量比较，避免当前成交量参与自己的基准。
    volume_ratio: list[float | None] = [None] * len(candles)
    for i in range(VOLUME_PERIOD, len(candles)):
        baseline = sum(volumes[i - VOLUME_PERIOD:i]) / VOLUME_PERIOD
        volume_ratio[i] = volumes[i] / baseline if baseline > 0 else None
    return {
        "ma20": ma20,
        "bias": bias,
        "volume_ma20": volume_ma20,
        "volume_ratio": volume_ratio,
        "rsi": divpoller.rsi_series(closes),
    }


def detect_signals(candles: list[dict], ind: dict, interval: str, end: int | None = None) -> list[dict]:
    """只标记已收盘 K 线；强乖离与放量偏离共用同一方向、量能和 RSI 基础条件。"""
    last = len(candles) - 2 if end is None else min(end, len(candles) - 1)
    signals: list[dict] = []
    threshold = EXTREME_BIAS[interval]
    for i in range(BIAS_PERIOD, last + 1):
        bias = ind["bias"][i]
        ratio = ind["volume_ratio"][i]
        rsi = ind["rsi"][i]
        if bias is None or ratio is None or rsi is None or ratio < VOLUME_SPIKE:
            continue
        direction = "negative" if bias < 0 and rsi <= 50 else "positive" if bias > 0 and rsi >= 50 else None
        if direction is None:
            continue
        extreme = abs(bias) >= threshold and (rsi <= 30 if direction == "negative" else rsi >= 70)
        signals.append({
            "open_time": candles[i]["open_time"],
            "direction": direction,
            "strength": "extreme" if extreme else "watch",
            "bias": bias,
            "volume_ratio": ratio,
            "rsi": rsi,
            "ma20": ind["ma20"][i],
            "threshold": threshold,
            "price": candles[i]["close"],
            "high": candles[i]["high"],
            "low": candles[i]["low"],
        })
    return signals


async def _send_bias_webhook(client: httpx.AsyncClient, alert: dict) -> tuple[bool, str]:
    if not config.FWALERT_WEBHOOK:
        return False, "未配置 FWALERT_WEBHOOK"
    cn_tz = timezone(timedelta(hours=8))
    time_str = datetime.now(cn_tz).strftime("%Y-%m-%d %H:%M:%S")
    candle_time = datetime.fromtimestamp(alert["open_time"] / 1000, cn_tz).strftime("%Y-%m-%d %H:%M")
    direction_cn = "负乖离" if alert["direction"] == "negative" else "正乖离"
    strength_cn = "强" if alert["strength"] == "extreme" else "放量"
    text = (
        f"【乖离率价格告警】{alert['symbol']} {alert['interval']} {strength_cn}{direction_cn}："
        f"最低价 {divpoller._fmt(alert['low'])} ≤ 触发价 {divpoller._fmt(alert['trigger_price'])}；"
        f"BIAS20 {alert['bias']:.3f}%，量比 {alert['volume_ratio']:.2f}×，"
        f"RSI14 {alert['rsi']:.1f}（K 线 {candle_time}；检测时间 {time_str}）"
    )
    payload = {
        "message": text,
        "content": text,
        "text": text,
        "brief": f"{alert['symbol']} {alert['interval']} {strength_cn}{direction_cn}触及触发价",
        "symbol": alert["symbol"],
        "interval": alert["interval"],
        "type": "bias",
        "direction": alert["direction"],
        "strength": alert["strength"],
        "bias": f"{alert['bias']:.6f}",
        "volume_ratio": f"{alert['volume_ratio']:.4f}",
        "rsi": f"{alert['rsi']:.2f}",
        "low": str(alert["low"]),
        "trigger_price": str(alert["trigger_price"]),
        "candle_time": candle_time,
        "time": time_str,
    }
    try:
        resp = await client.post(config.FWALERT_WEBHOOK, json=payload, timeout=10)
        if resp.status_code < 400:
            return True, ""
        return False, f"HTTP {resp.status_code}"
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:300]


async def _bias_webhook_with_retry(client: httpx.AsyncClient, alert_id: int, alert: dict) -> None:
    """首次失败后每 2 分钟重试，最多重试 3 次，不阻塞行情检测。"""
    try:
        for attempt in range(divpoller.WEBHOOK_MAX_RETRIES + 1):
            ok, err = await _send_bias_webhook(client, alert)
            if ok:
                database.set_bias_alert_webhook(alert_id, True, "")
                return
            if attempt >= divpoller.WEBHOOK_MAX_RETRIES:
                database.set_bias_alert_webhook(
                    alert_id, False, f"{err}（已重试 {divpoller.WEBHOOK_MAX_RETRIES} 次）"
                )
                log.error("乖离率告警 #%d webhook 最终发送失败: %s", alert_id, err)
                return
            retry_no = attempt + 1
            database.set_bias_alert_webhook(
                alert_id, False,
                f"{err}（2 分钟后进行第 {retry_no}/{divpoller.WEBHOOK_MAX_RETRIES} 次重试）",
            )
            await asyncio.sleep(divpoller.WEBHOOK_RETRY_INTERVAL)
    except asyncio.CancelledError:
        raise
    except Exception as e:  # noqa: BLE001
        log.error("乖离率告警 #%d webhook 重试任务异常: %s", alert_id, e)


def _schedule_bias_webhook(client: httpx.AsyncClient, alert_id: int, alert: dict) -> None:
    task = asyncio.create_task(_bias_webhook_with_retry(client, alert_id, alert))
    _webhook_tasks.add(task)
    task.add_done_callback(_webhook_tasks.discard)


async def _eval_price_alert(
    client: httpx.AsyncClient, interval: str, candles: list[dict], signals: list[dict]
) -> None:
    """新收盘 K 线同时满足乖离率识别与最低价条件才告警；每轮最多评估最新一根。"""
    alert_config = get_alert_config()
    if not alert_config["enabled"] or alert_config["trigger_price"] is None or len(candles) < 2:
        return
    latest_closed = candles[-2]
    latest_time = latest_closed["open_time"]
    baselines = _load_baselines()
    baseline = int(baselines.get(interval, 0) or 0)
    if baseline <= 0:
        baselines[interval] = latest_time
        database.set_state(BIAS_BASELINE_KEY, json.dumps(baselines))
        return
    if latest_time <= baseline:
        return

    # 先推进水位：服务离线期间不批量补发，每轮只判断最新收盘的一根。
    baselines[interval] = latest_time
    database.set_state(BIAS_BASELINE_KEY, json.dumps(baselines))
    signal = next((s for s in reversed(signals) if s["open_time"] == latest_time), None)
    if signal is None or signal["low"] > alert_config["trigger_price"]:
        return
    alert_id = database.add_bias_alert(SYMBOL, interval, signal, alert_config["trigger_price"])
    if alert_id is None:
        return
    alert = database.get_bias_alert(alert_id)
    log.info(
        "乖离率价格告警 %s %s %s：最低价 %.8f ≤ %.8f",
        SYMBOL, interval, signal["strength"], signal["low"], alert_config["trigger_price"],
    )
    secpoller.publish({"type": "bias_alert", "alert": alert})
    if alert_config["notify_webhook"]:
        _schedule_bias_webhook(client, alert_id, alert)


async def _series(client: httpx.AsyncClient, interval: str) -> list[dict]:
    spot, fut = await asyncio.gather(
        poller._fetch_klines(client, config.BINANCE_BASE_URLS, "/api/v3/klines", SYMBOL, interval, KLINE_LIMIT),
        poller._fetch_klines(client, config.FUTURES_BASE_URLS, "/fapi/v1/klines", SYMBOL, interval, KLINE_LIMIT),
    )
    series = poller.select_series(spot, fut)
    if series:
        poller.last_prices[SYMBOL] = (series[-1]["close"], time.time())
    return series


async def bias_poller_loop() -> None:
    async with httpx.AsyncClient(headers={"User-Agent": "price-alert/1.0"}, follow_redirects=True) as client:
        while True:
            try:
                for interval in INTERVALS:
                    candles = await _series(client, interval)
                    if len(candles) < BIAS_PERIOD + 2:
                        continue
                    ind = compute_indicators(candles)
                    signals = detect_signals(candles, ind, interval)
                    n = min(len(candles), CHART_CANDLES)
                    visible_start = candles[-n]["open_time"]
                    bias_cache[interval] = {
                        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        "candles": candles[-n:],
                        "indicators": {k: v[-n:] for k, v in ind.items()},
                        "signals": [s for s in signals if s["open_time"] >= visible_start],
                        "settings": {
                            "bias_period": BIAS_PERIOD,
                            "volume_period": VOLUME_PERIOD,
                            "volume_spike": VOLUME_SPIKE,
                            "extreme_bias": EXTREME_BIAS[interval],
                        },
                    }
                    await _eval_price_alert(client, interval, candles, signals)
                bias_status.update(
                    ok=True,
                    error="",
                    last_poll=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                )
            except Exception as e:  # noqa: BLE001
                bias_status.update(ok=False, error=str(e)[:300])
                log.error("乖离率轮询失败: %s", e)
            await asyncio.sleep(config.POLL_INTERVAL)
