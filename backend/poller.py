"""Binance K线轮询与触发告警

标准价（合约优先）：
- 每 POLL_INTERVAL 秒（默认 5 分钟）对每个被监控的交易对同时拉取现货和合约的 5m K 线（最近 2 根）
- 该交易对有 USDT 永续合约 → 只看合约价；没有合约 → 用现货价（price_source 记录来源）

告警类型一（type=price）：价格触及目标价
- 判定规则：K 线的 开/收/高/低 四个价格中，任意一个满足方向条件即触发
  - direction=above：max(开,收,高,低) >= 目标价
  - direction=below：min(开,收,高,低) <= 目标价
- 同时检查「最近一根已收盘 K 线」和「正在走的 K 线」，窗口内瞬时插针也能捕获

告警类型二（type=ema_cross）：EMA 均线穿越
- 支持 EMA21/55/100/200，周期 15m/1h/4h/1d；EMA 基于合约优先的收盘价序列计算
- 只在对应周期出现新收盘 K 线时评估一次（启动后首轮只记录水位，不补发历史信号）
- 上穿（收盘从 EMA 下方到上方）、下穿（反向）、插针（K线高低区间覆盖 EMA）均触发

到达触发条件：先把监控标记为已触发（保证只触发一次），再调用饭碗告警 webhook
- webhook 失败自动重试 3 次，结果（成功/失败原因）写回监控记录
"""
import asyncio
import logging
import time
from datetime import datetime, timezone, timedelta

import httpx

from . import config, database

log = logging.getLogger("poller")

# 内存态：最新综合价 {symbol: (price, epoch)}，供前端展示（取自最新综合 K 线收盘价）
last_prices: dict[str, tuple[float, float]] = {}
poller_status = {"ok": None, "error": "", "last_poll": None}

# 交易对列表缓存（供前端选择）
_symbols_cache: dict = {"data": [], "ts": 0.0}


async def _binance_get(client: httpx.AsyncClient, path: str, params: dict | None = None):
    """现货节点：依次尝试，全部失败则抛异常"""
    last_err: Exception | None = None
    for base in config.BINANCE_BASE_URLS:
        try:
            resp = await client.get(f"{base}{path}", params=params, timeout=10)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:  # noqa: BLE001 - 逐个节点回退
            last_err = e
            log.warning("行情节点 %s%s 请求失败: %s", base, path, e)
    raise last_err or RuntimeError("所有 Binance 节点均不可用")


async def _fetch_klines(
    client: httpx.AsyncClient,
    base_urls: list[str],
    path: str,
    symbol: str,
    interval: str | None = None,
    limit: int = 2,
) -> list[dict] | None:
    """拉取 K 线。交易对不存在（400 Invalid symbol）返回 None；网络错误也返回 None（由调用方降级）"""
    for base in base_urls:
        try:
            resp = await client.get(
                f"{base}{path}",
                params={"symbol": symbol, "interval": interval or config.KLINE_INTERVAL, "limit": limit},
                timeout=10,
            )
            if resp.status_code == 400:
                return None  # 该市场没有这个交易对
            resp.raise_for_status()
            return _parse_klines(resp.json())
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 400:
                return None
            log.warning("K线节点 %s 请求失败: %s", base, e)
        except Exception as e:  # noqa: BLE001
            log.warning("K线节点 %s 请求失败: %s", base, e)
    return None


async def fetch_symbols(client: httpx.AsyncClient) -> list[str]:
    """可选交易对列表：现货 USDT 交易对 + USDT 永续合约（含仅合约的标的），缓存 1 小时"""
    if _symbols_cache["data"] and time.time() - _symbols_cache["ts"] < 3600:
        return _symbols_cache["data"]
    merged: set[str] = set()
    # 现货 USDT 交易对
    for base in config.BINANCE_BASE_URLS:
        try:
            resp = await client.get(f"{base}/api/v3/exchangeInfo", timeout=15)
            resp.raise_for_status()
            merged |= {
                s["symbol"]
                for s in resp.json().get("symbols", [])
                if s.get("status") == "TRADING"
                and s.get("quoteAsset") == "USDT"
                and s.get("isSpotTradingAllowed", True)
                and s["symbol"].isascii()
            }
        except Exception as e:  # noqa: BLE001
            log.warning("获取现货交易对列表失败(%s): %s", base, e)
    # USDT 永续合约（覆盖没有现货、只有合约的标的，如部分小币种）
    for base in config.FUTURES_BASE_URLS:
        try:
            resp = await client.get(f"{base}/fapi/v1/exchangeInfo", timeout=15)
            resp.raise_for_status()
            merged |= {
                s["symbol"]
                for s in resp.json().get("symbols", [])
                if s.get("status") == "TRADING"
                and s.get("contractType") == "PERPETUAL"
                and s.get("quoteAsset") == "USDT"
                and s["symbol"].isascii()
            }
        except Exception as e:  # noqa: BLE001
            log.warning("获取合约交易对列表失败(%s): %s", base, e)
    if merged:
        symbols = sorted(merged)
        _symbols_cache.update(data=symbols, ts=time.time())
        return symbols
    return _symbols_cache["data"]


def _fmt_price(p: float | None) -> str:
    if p is None:
        return "—"
    return f"{p:,.8f}".rstrip("0").rstrip(".") if p < 1 else f"{p:,.2f}".rstrip("0").rstrip(".")


def _parse_klines(raw: list) -> list[dict]:
    """Binance klines -> [{'open_time','open','high','low','close','qvol'}, ...]
    k[7] 为成交额（quote asset volume），用作现货/合约加权的权重"""
    candles = []
    for k in raw:
        candles.append(
            {
                "open_time": int(k[0]),
                "open": float(k[1]),
                "high": float(k[2]),
                "low": float(k[3]),
                "close": float(k[4]),
                "qvol": float(k[7]),
            }
        )
    return candles


def _merge_candle(spot: dict | None, fut: dict | None) -> dict:
    """按成交额加权合成一根综合 K 线；某一边缺失时退化为另一边"""
    if spot and fut:
        ws, wf = spot["qvol"], fut["qvol"]
        total = ws + wf
        if total <= 0:
            ws = wf = 1.0
            total = 2.0

        def wavg(a: float, b: float) -> float:
            return (a * ws + b * wf) / total

        return {
            "open_time": max(spot["open_time"], fut["open_time"]),
            "open": wavg(spot["open"], fut["open"]),
            "high": wavg(spot["high"], fut["high"]),
            "low": wavg(spot["low"], fut["low"]),
            "close": wavg(spot["close"], fut["close"]),
            "spot_close": spot["close"],
            "fut_close": fut["close"],
            "fused": True,
        }
    c = spot or fut
    assert c is not None
    return {
        **{k: c[k] for k in ("open_time", "open", "high", "low", "close")},
        "spot_close": spot["close"] if spot else None,
        "fut_close": fut["close"] if fut else None,
        "fused": False,
    }


def select_series(spot: list[dict] | None, fut: list[dict] | None) -> list[dict]:
    """合约优先选择 K 线序列：有 USDT 永续合约只用合约价；无合约用现货价。

    返回的 K 线带 price_source 标记（futures/spot），供告警文案说明价格来源。
    """
    if fut:
        out = [_merge_candle(None, c) for c in fut]
        for c in out:
            c["price_source"] = "futures"
    elif spot:
        out = [_merge_candle(c, None) for c in spot]
        for c in out:
            c["price_source"] = "spot"
    else:
        return []
    out.sort(key=lambda c: c["open_time"])
    return out


def select_candles(spot: list[dict] | None, fut: list[dict] | None, limit: int = 2) -> list[dict]:
    """合约优先，返回最近 limit 根 K 线（供价格触发性判定）"""
    return select_series(spot, fut)[-limit:]


# ---------------- EMA 均线穿越监控 ----------------
EMA_PERIODS = (21, 55, 100, 200)
EMA_INTERVALS = ("15m", "1h", "4h", "1d")
# 拉取的历史 K 线数：保证 EMA200 收敛
EMA_KLINE_LIMIT = 500

# (symbol, interval) -> 最近已评估的收盘 K 线 open_time（ms）。
# 启动后首轮只记录水位不评估，避免补发历史信号
_ema_checked: dict[tuple[str, str], int] = {}


def ema_series(closes: list[float], period: int) -> list[float | None]:
    """标准 EMA：以首 period 个收盘价的 SMA 为种子递推；前 period-1 位为 None"""
    if len(closes) < period:
        return [None] * len(closes)
    k = 2 / (period + 1)
    ema = sum(closes[:period]) / period
    out: list[float | None] = [None] * (period - 1) + [ema]
    for c in closes[period:]:
        ema = c * k + ema * (1 - k)
        out.append(ema)
    return out


def _ema_cross_kind(
    prev_close: float, prev_ema: float, close: float, ema: float, low: float, high: float
) -> str | None:
    """判断刚收盘 K 线与 EMA 的关系：上穿 / 下穿 / 插针（影线触及），无交集返回 None"""
    if prev_close <= prev_ema and close > ema:
        return "上穿"
    if prev_close >= prev_ema and close < ema:
        return "下穿"
    if low <= ema <= high:
        return "插针"
    return None


async def _send_webhook(
    client: httpx.AsyncClient, m: dict, candle: dict, extreme: float
) -> tuple[bool, str]:
    """调用饭碗告警 webhook。饭碗告警会把 JSON 请求体的键自动提取为模板变量（{{键名}}）。"""
    if not config.FWALERT_WEBHOOK:
        return False, "未配置 FWALERT_WEBHOOK"
    direction_cn = "高于" if m["direction"] == "above" else "低于"
    cn_tz = timezone(timedelta(hours=8))
    time_str = datetime.now(cn_tz).strftime("%Y-%m-%d %H:%M:%S")
    candle_time = datetime.fromtimestamp(candle["open_time"] / 1000, cn_tz).strftime(
        "%Y-%m-%d %H:%M"
    )
    basis = (
        "现货+合约加权综合价"
        if candle.get("fused")
        else "合约价（合约优先）"
        if candle.get("price_source") == "futures"
        else "现货价（该交易对无合约或合约不可达）"
        if candle.get("price_source") == "spot"
        else ("仅现货价（该交易对无合约或合约不可达）" if candle.get("spot_close") is not None else "仅合约价（无现货或现货不可达）")
    )
    text = (
        f"【价格告警】{m['symbol']} {config.KLINE_INTERVAL} K线综合价{direction_cn}目标价 "
        f"{_fmt_price(m['target_price'])}（{basis}）：该K线开 {_fmt_price(candle['open'])} / "
        f"高 {_fmt_price(candle['high'])} / 低 {_fmt_price(candle['low'])} / "
        f"收 {_fmt_price(candle['close'])}（K线时间 {candle_time}）"
    )
    if m.get("note"):
        text += f"｜备注：{m['note']}"
    payload = {
        "message": text,
        "content": text,
        "brief": f"{m['symbol']} {direction_cn} {_fmt_price(m['target_price'])}",
        "text": text,
        "symbol": m["symbol"],
        "direction": "above" if m["direction"] == "above" else "below",
        "target": str(m["target_price"]),
        "price": str(extreme),
        "open": str(candle["open"]),
        "high": str(candle["high"]),
        "low": str(candle["low"]),
        "close": str(candle["close"]),
        "spot_close": "" if candle.get("spot_close") is None else str(candle["spot_close"]),
        "futures_close": "" if candle.get("fut_close") is None else str(candle["fut_close"]),
        "candle_time": candle_time,
        "interval": config.KLINE_INTERVAL,
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


async def _trigger(client: httpx.AsyncClient, m: dict, candle: dict, extreme: float) -> None:
    # 先落库，保证即使 webhook 发送中进程崩溃也不会重复触发
    database.mark_triggered(m["id"], extreme)
    log.info("监控 #%d %s 触发，综合K线极值 %s", m["id"], m["symbol"], extreme)
    ok, err = await _send_webhook(client, m, candle, extreme)
    database.set_webhook_result(m["id"], ok, err)
    if not ok:
        log.error("监控 #%d webhook 发送失败: %s", m["id"], err)


async def _send_ema_webhook(
    client: httpx.AsyncClient, m: dict, candle: dict, ema_value: float, kind: str
) -> tuple[bool, str]:
    """EMA 穿越告警 webhook，消息体风格与价格告警一致（饭碗告警提取 JSON 键为模板变量）"""
    if not config.FWALERT_WEBHOOK:
        return False, "未配置 FWALERT_WEBHOOK"
    cn_tz = timezone(timedelta(hours=8))
    time_str = datetime.now(cn_tz).strftime("%Y-%m-%d %H:%M:%S")
    candle_time = datetime.fromtimestamp(candle["open_time"] / 1000, cn_tz).strftime(
        "%Y-%m-%d %H:%M"
    )
    basis = (
        "现货+合约加权综合价"
        if candle.get("fused")
        else "合约价（合约优先）"
        if candle.get("price_source") == "futures"
        else "现货价（该交易对无合约或合约不可达）"
        if candle.get("price_source") == "spot"
        else ("仅现货价（该交易对无合约或合约不可达）" if candle.get("spot_close") is not None else "仅合约价（无现货或现货不可达）")
    )
    text = (
        f"【EMA告警】{m['symbol']} {m['interval']} K线收盘{kind} EMA{m['ema_period']}"
        f"（{basis}）：EMA={_fmt_price(ema_value)}，该K线开 {_fmt_price(candle['open'])} / "
        f"高 {_fmt_price(candle['high'])} / 低 {_fmt_price(candle['low'])} / "
        f"收 {_fmt_price(candle['close'])}（K线时间 {candle_time}）"
    )
    if m.get("note"):
        text += f"｜备注：{m['note']}"
    payload = {
        "message": text,
        "content": text,
        "brief": f"{m['symbol']} {m['interval']} {kind} EMA{m['ema_period']}",
        "text": text,
        "symbol": m["symbol"],
        "type": "ema_cross",
        "kind": kind,
        "interval": m["interval"],
        "ema_period": str(m["ema_period"]),
        "ema": str(ema_value),
        "open": str(candle["open"]),
        "high": str(candle["high"]),
        "low": str(candle["low"]),
        "close": str(candle["close"]),
        "spot_close": "" if candle.get("spot_close") is None else str(candle["spot_close"]),
        "futures_close": "" if candle.get("fut_close") is None else str(candle["fut_close"]),
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


async def _trigger_ema(
    client: httpx.AsyncClient, m: dict, candle: dict, ema_value: float, kind: str
) -> None:
    # 先落库，保证即使 webhook 发送中进程崩溃也不会重复触发
    database.mark_triggered(m["id"], candle["close"])
    log.info(
        "EMA监控 #%d %s %s 收盘%s EMA%d (EMA=%s)",
        m["id"], m["symbol"], m["interval"], kind, m["ema_period"], ema_value,
    )
    ok, err = await _send_ema_webhook(client, m, candle, ema_value, kind)
    database.set_webhook_result(m["id"], ok, err)
    if not ok:
        log.error("EMA监控 #%d webhook 发送失败: %s", m["id"], err)


def _check_monitor(m: dict, candles: list[dict]) -> tuple[dict, float] | None:
    """返回 (命中K线, 极值) 或 None。检查最近一根已收盘 K 线 + 正在走的 K 线。"""
    for candle in candles:
        o, h, l, c = candle["open"], candle["high"], candle["low"], candle["close"]
        if m["direction"] == "above" and max(o, h, l, c) >= m["target_price"]:
            return candle, h
        if m["direction"] == "below" and min(o, h, l, c) <= m["target_price"]:
            return candle, l
    return None


async def _poll_ema(client: httpx.AsyncClient, active: list[dict]) -> None:
    """EMA 穿越监控：按 (交易对, 周期) 分组，只在该周期出现新收盘 K 线时评估一次"""
    groups: dict[tuple[str, str], list[dict]] = {}
    for m in active:
        if m["type"] == "ema_cross":
            groups.setdefault((m["symbol"], m["interval"]), []).append(m)
    for (sym, interval), group in sorted(groups.items()):
        spot, fut = await asyncio.gather(
            _fetch_klines(client, config.BINANCE_BASE_URLS, "/api/v3/klines", sym, interval, EMA_KLINE_LIMIT),
            _fetch_klines(client, config.FUTURES_BASE_URLS, "/fapi/v1/klines", sym, interval, EMA_KLINE_LIMIT),
        )
        if not spot and not fut:
            log.warning("交易对 %s %s 现货与合约均不可用，跳过 EMA 本轮", sym, interval)
            continue
        closed = select_series(spot, fut)[:-1]  # 最后一根为未收盘 K 线，剔除
        if len(closed) < 2:
            continue
        key = (sym, interval)
        last_open = closed[-1]["open_time"]
        if _ema_checked.get(key, 0) >= last_open:
            continue  # 该周期尚无新收盘 K 线
        first_seen = key not in _ema_checked
        _ema_checked[key] = last_open
        if first_seen:
            continue  # 启动/新建后首轮只记录水位，不补发历史信号
        closes = [c["close"] for c in closed]
        cur, prev = closed[-1], closed[-2]
        for m in group:
            emas = ema_series(closes, m["ema_period"])
            ema_cur, ema_prev = emas[-1], emas[-2]
            if ema_cur is None or ema_prev is None:
                log.warning("交易对 %s %s 历史不足以计算 EMA%d", sym, interval, m["ema_period"])
                continue
            kind = _ema_cross_kind(
                prev["close"], ema_prev, cur["close"], ema_cur, cur["low"], cur["high"]
            )
            if kind:
                await _trigger_ema(client, m, cur, ema_cur, kind)
        await asyncio.sleep(0.2)  # 轻微间隔，避免打满权重


async def poller_loop() -> None:
    """后台主循环：逐交易对拉 现货+合约 5m K 线 -> 加权合成 -> OHLC 判定触发"""
    async with httpx.AsyncClient(
        headers={"User-Agent": "price-alert/1.0"}, follow_redirects=True
    ) as client:
        await fetch_symbols(client)
        while True:
            try:
                active = database.active_monitors()
                price_monitors = [m for m in active if m["type"] == "price"]
                active_symbols = {m["symbol"] for m in price_monitors}
                # 有活跃监控的交易对才需要拉 K 线做判定
                for sym in sorted(active_symbols):
                    spot, fut = await asyncio.gather(
                        _fetch_klines(client, config.BINANCE_BASE_URLS, "/api/v3/klines", sym),
                        _fetch_klines(client, config.FUTURES_BASE_URLS, "/fapi/v1/klines", sym),
                    )
                    if not spot and not fut:
                        log.warning("交易对 %s 现货与合约均不可用，跳过本轮", sym)
                        continue
                    candles = select_candles(spot, fut)
                    if candles:
                        last_prices[sym] = (candles[-1]["close"], time.time())
                    for m in price_monitors:
                        if m["symbol"] != sym:
                            continue
                        hit = _check_monitor(m, candles)
                        if hit:
                            candle, extreme = hit
                            await _trigger(client, m, candle, extreme)
                    await asyncio.sleep(0.2)  # 轻微间隔，避免打满权重
                await _poll_ema(client, active)
                poller_status.update(
                    ok=True,
                    error="",
                    last_poll=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                )
            except Exception as e:  # noqa: BLE001 - 轮询失败不让进程死
                poller_status.update(ok=False, error=str(e)[:300])
                log.error("轮询失败: %s", e)
            await asyncio.sleep(config.POLL_INTERVAL)
