"""相关度计算：指定交易对 vs BTC 的滚动相关性监控

- 算法：对数收益率序列上的滚动 Pearson 相关系数（r ∈ [-1, 1]）
  价格非平稳，直接对价格水平算相关性会得到伪相关，因此先转对数收益率
- 周期与固定滚动窗口（不可调）：1h=24 根、4h=30 根、1d=14 根
- 价格源（防插针可选，基准与标的同口径）：
  close=收盘价；oc2=(开盘价+收盘价)/2；typical=典型价 (高+低+收)/3
- 只在新收盘 K 线出现时计算；价格取「合约优先」（复用 poller.select_series）
- 首次监控回填最近 100 个相关性点（只写历史，不补发告警），此后每周期保留最近 100 点供折线图
- 告警两类，每交易对 × 每周期独立阈值（None = 关闭）：
  decorr 脱钩：|r| ≤ 阈值；进入脱钩状态告警一次，|r| 回到阈值上方后重新武装
  shift  突变：|r − 上一根 r| ≥ 阈值；同周期 4 根 K 线冷却，避免连续突变刷屏
- 通知：网页（SSE + 告警记录）必选，饭碗 webhook 可选（notify_webhook）
"""
import asyncio
import logging
import math
import time
from datetime import datetime, timedelta, timezone

import httpx

from . import config, database, poller, secpoller

log = logging.getLogger("corrpoller")

BENCHMARK = "BTCUSDT"
# 固定滚动窗口（根数）：需求明确不再支持调整
INTERVALS: dict[str, int] = {"1h": 24, "4h": 30, "1d": 14}
INTERVAL_MS: dict[str, int] = {"1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}
HISTORY_KEEP = 100
# 突变告警冷却：同周期 4 根 K 线
SHIFT_COOLDOWN_CANDLES = 4

PRICE_SOURCES = ("close", "oc2", "typical")
PRICE_SOURCE_CN = {"close": "收盘价", "oc2": "(开+收)/2", "typical": "典型价(高+低+收)/3"}

corr_status: dict = {"ok": None, "error": "", "last_poll": None, "active": 0}


def _price(candle: dict, source: str) -> float:
    if source == "oc2":
        return (candle["open"] + candle["close"]) / 2
    if source == "typical":
        return (candle["high"] + candle["low"] + candle["close"]) / 3
    return candle["close"]


def pearson(xs: list[float], ys: list[float]) -> float | None:
    """Pearson 相关系数；任一方差为 0（如长期横盘）返回 None"""
    n = len(xs)
    if n < 2 or n != len(ys):
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    if vx <= 0 or vy <= 0:
        return None
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return cov / math.sqrt(vx * vy)


def rolling_corr(
    pairs: list[tuple[int, float, float]], window: int
) -> list[tuple[int, float]]:
    """pairs=(open_time, 标的价格, BTC价格) 已按时间对齐。
    对每个可计算的位置输出 (open_time, r)：取该位置及之前共 window 个对数收益率。"""
    if len(pairs) < window + 1:
        return []
    times = [p[0] for p in pairs]
    ra = [math.log(pairs[i][1] / pairs[i - 1][1]) for i in range(1, len(pairs))]
    rb = [math.log(pairs[i][2] / pairs[i - 1][2]) for i in range(1, len(pairs))]
    out: list[tuple[int, float]] = []
    for end in range(window, len(ra) + 1):
        r = pearson(ra[end - window : end], rb[end - window : end])
        if r is not None:
            out.append((times[end], max(-1.0, min(1.0, r))))
    return out


def _align(sym_closed: list[dict], btc_closed: list[dict], source: str) -> list[tuple[int, float, float]]:
    """按 open_time 内连接两个已收盘 K 线序列，剔除任一方缺失的时段"""
    btc_map = {c["open_time"]: c for c in btc_closed}
    pairs = []
    for c in sym_closed:
        b = btc_map.get(c["open_time"])
        if b is None:
            continue
        pa, pb = _price(c, source), _price(b, source)
        if pa > 0 and pb > 0:
            pairs.append((c["open_time"], pa, pb))
    return pairs


async def _closed_series(
    client: httpx.AsyncClient, symbol: str, interval: str, limit: int
) -> list[dict]:
    """合约优先拉取 K 线并剔除正在走的一根；失败返回空列表"""
    spot, fut = await asyncio.gather(
        poller._fetch_klines(client, config.BINANCE_BASE_URLS, "/api/v3/klines", symbol, interval, limit),
        poller._fetch_klines(client, config.FUTURES_BASE_URLS, "/fapi/v1/klines", symbol, interval, limit),
    )
    series = poller.select_series(spot, fut)
    if series:
        poller.last_prices[symbol] = (series[-1]["close"], time.time())
    return series[:-1]


async def _send_corr_webhook(client: httpx.AsyncClient, m: dict, alert: dict) -> tuple[bool, str]:
    """相关性告警 webhook，消息体风格与其他告警一致（饭碗提取 JSON 键为模板变量）"""
    if not config.FWALERT_WEBHOOK:
        return False, "未配置 FWALERT_WEBHOOK"
    cn_tz = timezone(timedelta(hours=8))
    time_str = datetime.now(cn_tz).strftime("%Y-%m-%d %H:%M:%S")
    candle_time = datetime.fromtimestamp(alert["open_time"] / 1000, cn_tz).strftime("%Y-%m-%d %H:%M")
    window = INTERVALS[alert["interval"]]
    source_cn = PRICE_SOURCE_CN[m["price_source"]]
    if alert["kind"] == "decorr":
        brief = f"{m['symbol']} {alert['interval']} 与 BTC 脱钩"
        text = (
            f"【相关度告警】{m['symbol']} {alert['interval']} 与 BTC 脱钩："
            f"|r|={abs(alert['r']):.4f} ≤ 阈值 {alert['threshold']:.2f}"
            f"（当前 r={alert['r']:.4f}，{window} 根 {alert['interval']} K线滚动窗口，"
            f"价格源 {source_cn}，K线时间 {candle_time}）"
        )
    else:
        brief = f"{m['symbol']} {alert['interval']} 与 BTC 相关性突变"
        text = (
            f"【相关度告警】{m['symbol']} {alert['interval']} 与 BTC 相关性突变："
            f"|Δr|={abs(alert['r'] - alert['prev_r']):.4f} ≥ 阈值 {alert['threshold']:.2f}"
            f"（r 由 {alert['prev_r']:.4f} 变为 {alert['r']:.4f}，{window} 根 {alert['interval']} "
            f"K线滚动窗口，价格源 {source_cn}，K线时间 {candle_time}）"
        )
    payload = {
        "message": text,
        "content": text,
        "brief": brief,
        "text": text,
        "symbol": m["symbol"],
        "benchmark": BENCHMARK,
        "type": "correlation",
        "kind": alert["kind"],
        "interval": alert["interval"],
        "r": f"{alert['r']:.4f}",
        "prev_r": "" if alert["prev_r"] is None else f"{alert['prev_r']:.4f}",
        "threshold": str(alert["threshold"]),
        "window": str(window),
        "price_source": m["price_source"],
        "candle_time": candle_time,
        "time": time_str,
    }
    err = ""
    for attempt in range(3):
        try:
            resp = await client.post(config.FWALERT_WEBHOOK, json=payload, timeout=10)
            if resp.status_code < 400:
                return True, ""
            err = f"HTTP {resp.status_code}"
        except Exception as e:  # noqa: BLE001
            err = str(e)[:300]
        await asyncio.sleep(2 * (attempt + 1))
    return False, err


async def _fire(
    client: httpx.AsyncClient,
    m: dict,
    interval: str,
    kind: str,
    r: float,
    prev_r: float | None,
    threshold: float,
    open_time: int,
) -> None:
    """先落库再发通知；同一 K 线的同类事件不重复记录或补发"""
    if database.find_corr_alert(m["id"], interval, kind, open_time) is not None:
        log.info("相关度告警已存在，跳过重复事件: %s %s %s open_time=%d", m["symbol"], interval, kind, open_time)
        return
    alert_id = database.add_corr_alert(m["id"], m["symbol"], interval, kind, r, prev_r, threshold, open_time)
    log.info("相关度告警 #%d %s %s %s r=%.4f prev=%s th=%.2f", alert_id, m["symbol"], interval, kind, r, prev_r, threshold)
    alert = database.get_corr_alert(alert_id)
    secpoller.publish({"type": "corr_alert", "alert": alert})
    if not m["notify_webhook"]:
        return
    ok, err = await _send_corr_webhook(client, m, {**alert, "alert_id": alert_id})
    database.set_corr_alert_webhook(alert_id, ok, err)
    if not ok:
        log.error("相关度告警 #%d webhook 发送失败: %s", alert_id, err)


async def _process_interval(
    client: httpx.AsyncClient, monitors: list[dict], interval: str
) -> None:
    window = INTERVALS[interval]
    states = {m["id"]: database.get_corr_state(m["id"], interval) for m in monitors}
    # 有需要回填（首次/重启后无水位）的监控时，K 线要拉到覆盖 100 个历史点
    need_backfill = any(states[m["id"]]["last_open_time"] == 0 for m in monitors)
    limit = window + 5 if not need_backfill else HISTORY_KEEP + window + 5
    btc_closed = await _closed_series(client, BENCHMARK, interval, limit)
    if len(btc_closed) < window + 1:
        log.warning("BTC %s K线不足（%d 根），本轮跳过该周期", interval, len(btc_closed))
        return
    for m in monitors:
        st = states[m["id"]]
        m_limit = window + 5 if st["last_open_time"] else HISTORY_KEEP + window + 5
        sym_closed = await _closed_series(client, m["symbol"], interval, m_limit)
        pairs = _align(sym_closed, btc_closed, m["price_source"])
        points = rolling_corr(pairs, window)
        if not points:
            log.info("%s %s 有效对齐K线不足 %d 根，暂无法计算相关性", m["symbol"], interval, window + 1)
            continue
        backfill = st["last_open_time"] == 0
        new_points = [(ot, r) for ot, r in points if ot > st["last_open_time"]]
        if backfill:
            # 首次回填最近 100 点：只写历史不告警，水位推到最新
            database.corr_history_add(m["id"], interval, points[-HISTORY_KEEP:])
            ot, r = points[-1]
            database.save_corr_state(m["id"], interval, ot, r, False, 0)
            log.info("%s %s 回填 %d 个相关性点，最新 r=%.4f", m["symbol"], interval, min(len(points), HISTORY_KEEP), r)
            continue
        if not new_points:
            continue  # 尚无新收盘 K 线
        ot, r = new_points[-1]
        database.corr_history_add(m["id"], interval, [(ot, r)])
        prev_r = st["last_r"]
        decorr_active = bool(st["decorr_active"])
        last_shift_open = st["last_shift_open"]
        th = (m["thresholds"].get(interval) or {})
        d_th, s_th = th.get("decorr"), th.get("shift")
        # 脱钩：进入才告警，恢复后重新武装
        if d_th is not None:
            if abs(r) <= d_th and not decorr_active:
                decorr_active = True
                await _fire(client, m, interval, "decorr", r, prev_r, d_th, ot)
            elif abs(r) > d_th and decorr_active:
                decorr_active = False
                log.info("%s %s 脱钩恢复 |r|=%.4f > %.2f", m["symbol"], interval, abs(r), d_th)
        # 突变：与上一根比较，4 根 K 线冷却
        if (
            s_th is not None
            and prev_r is not None
            and abs(r - prev_r) >= s_th
            and ot - last_shift_open >= SHIFT_COOLDOWN_CANDLES * INTERVAL_MS[interval]
        ):
            last_shift_open = ot
            await _fire(client, m, interval, "shift", r, prev_r, s_th, ot)
        database.save_corr_state(m["id"], interval, ot, r, decorr_active, last_shift_open)
        await asyncio.sleep(0.2)  # 轻微间隔，避免打满权重


async def backfill_monitor_now(m: dict) -> dict[str, int]:
    """新建监控后立即回填三个周期，返回各周期实际历史点数。

    创建接口调用；失败仍由后台轮询按 last_open_time=0 自动重试。
    """
    counts: dict[str, int] = {}
    async with httpx.AsyncClient(
        headers={"User-Agent": "price-alert/1.0"}, follow_redirects=True
    ) as client:
        for interval in INTERVALS:
            try:
                await _process_interval(client, [m], interval)
            except Exception as e:  # noqa: BLE001 - 单周期失败不阻塞其他周期和创建操作
                log.error("%s %s 创建后即时回填失败: %s", m["symbol"], interval, e)
            counts[interval] = len(database.corr_history_list(m["id"], interval))
    return counts


async def corr_poller_loop() -> None:
    """后台主循环：每 POLL_INTERVAL 秒检查一轮，各周期只在新收盘 K 线时计算"""
    async with httpx.AsyncClient(
        headers={"User-Agent": "price-alert/1.0"}, follow_redirects=True
    ) as client:
        while True:
            try:
                active = database.active_corr_monitors()
                corr_status["active"] = len(active)
                if not active:
                    await asyncio.sleep(config.POLL_INTERVAL)
                    continue
                for interval in INTERVALS:
                    await _process_interval(client, active, interval)
                corr_status.update(
                    ok=True,
                    error="",
                    last_poll=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                )
            except Exception as e:  # noqa: BLE001 - 轮询失败不让进程死
                corr_status.update(ok=False, error=str(e)[:300])
                log.error("相关度轮询失败: %s", e)
            await asyncio.sleep(config.POLL_INTERVAL)
