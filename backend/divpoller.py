"""BTC 背离监控：量价 / RSI / OBV / MACD(DIF) / MACD面积 顶底背离 + 数量组合告警

- 标的固定 BTCUSDT（合约优先），周期 1h / 4h / 1d，每 POLL_INTERVAL 秒（默认 5 分钟）检测一次
- **使用正在走的 K 线**，不等收盘；最近 100 根 K 线与指标缓存供前端画图
- 摆动点：左右各 3 根确认的 swing high/low；背离比较采用「前一个已确认摆动点 + 当前即时极值」，
  后一个点未确认，因此背离可能随行情形成/消失，告警按方向状态机去重
- 五种背离口径：
  volume    量价：顶=价创新高但量缩，底=价创新低但量缩（后摆动点成交量均低于前一摆动点）
  rsi       RSI(14) Wilder：价格 HH/LL，RSI LH/HL
  obv       OBV：价格 HH/LL，OBV LH/HL
  macd      MACD(12,26,9) 的 DIF：价格 HH/LL，DIF LH/HL
  macd_area MACD 面积：柱体按零轴分波，最近两波同向区域，后波价格更极端但柱体面积绝对值更小
- 告警：同方向「启用的背离种类数 ≥ min_count（2/3/4/5）」才触发，顶/底独立计数；
  进入告警状态只告警一次，种类数跌回阈值以下后重新武装
- 通知：网页（SSE + 告警记录）必选，饭碗 webhook 可选
"""
import asyncio
import json
import logging
import time
from datetime import datetime, timedelta, timezone

import httpx

from . import config, database, poller, secpoller

log = logging.getLogger("divpoller")

SYMBOL = "BTCUSDT"
DIV_INTERVALS = ("1h", "4h", "1d")
KINDS = ("volume", "rsi", "obv", "macd", "macd_area")
KIND_CN = {
    "volume": "量价",
    "rsi": "RSI",
    "obv": "OBV",
    "macd": "MACD(DIF)",
    "macd_area": "MACD面积",
}
PIVOT_LEFT = 3
PIVOT_RIGHT = 3
CHART_CANDLES = 100
KLINE_LIMIT = 200  # 保证 EMA26 / DEA9 / RSI14 收敛

DIV_CONFIG_KEY = "div_config"
DIV_STATE_KEY = "div_alert_state"

div_status: dict = {"ok": None, "error": "", "last_poll": None}
# interval -> {candles, indicators, divergences, updated_at}（内存缓存，供 API 直接返回）
div_cache: dict = {}


def default_interval_config() -> dict:
    return {
        "min_count": 2,
        "notify_webhook": True,
        "enabled": {k: True for k in KINDS},
    }


def get_config() -> dict:
    raw = database.get_state(DIV_CONFIG_KEY)
    saved = {}
    if raw:
        try:
            saved = json.loads(raw)
        except ValueError:
            saved = {}
    cfg = {}
    for interval in DIV_INTERVALS:
        base = default_interval_config()
        override = saved.get(interval) or {}
        base["min_count"] = override.get("min_count", base["min_count"])
        base["notify_webhook"] = override.get("notify_webhook", base["notify_webhook"])
        base["enabled"].update(override.get("enabled") or {})
        cfg[interval] = base
    return cfg


# ---------------- 指标计算 ----------------

def rsi_series(closes: list[float], period: int = 14) -> list[float | None]:
    """Wilder RSI：初始均值用前 period 个涨跌的 SMA，此后递推平滑"""
    out: list[float | None] = [None] * len(closes)
    if len(closes) <= period:
        return out
    gains = [max(closes[i] - closes[i - 1], 0.0) for i in range(1, len(closes))]
    losses = [max(closes[i - 1] - closes[i], 0.0) for i in range(1, len(closes))]
    avg_g = sum(gains[:period]) / period
    avg_l = sum(losses[:period]) / period

    def value() -> float:
        if avg_l == 0:
            return 100.0 if avg_g > 0 else 50.0
        return 100 - 100 / (1 + avg_g / avg_l)

    out[period] = value()
    for i in range(period + 1, len(closes)):
        avg_g = (avg_g * (period - 1) + gains[i - 1]) / period
        avg_l = (avg_l * (period - 1) + losses[i - 1]) / period
        out[i] = value()
    return out


def obv_series(candles: list[dict]) -> list[float]:
    out = [0.0]
    for i in range(1, len(candles)):
        prev, cur = candles[i - 1]["close"], candles[i]["close"]
        vol = candles[i].get("volume", 0.0)
        if cur > prev:
            out.append(out[-1] + vol)
        elif cur < prev:
            out.append(out[-1] - vol)
        else:
            out.append(out[-1])
    return out


def macd_series(closes: list[float]) -> tuple[list[float | None], list[float | None], list[float | None]]:
    """标准 MACD(12,26,9)：DIF=EMA12−EMA26，DEA=DIF 的 9EMA，柱=DIF−DEA"""
    ema12 = poller.ema_series(closes, 12)
    ema26 = poller.ema_series(closes, 26)
    dif: list[float | None] = [
        (a - b) if a is not None and b is not None else None for a, b in zip(ema12, ema26)
    ]
    valid = [v for v in dif if v is not None]
    dea_valid = poller.ema_series(valid, 9) if valid else []
    dea: list[float | None] = [None] * len(closes)
    hist: list[float | None] = [None] * len(closes)
    vi = 0
    for i, v in enumerate(dif):
        if v is None:
            continue
        d = dea_valid[vi] if vi < len(dea_valid) else None
        dea[i] = d
        if d is not None:
            hist[i] = v - d
        vi += 1
    return dif, dea, hist


def compute_indicators(candles: list[dict]) -> dict:
    closes = [c["close"] for c in candles]
    dif, dea, hist = macd_series(closes)
    return {
        "rsi": rsi_series(closes),
        "obv": obv_series(candles),
        "dif": dif,
        "dea": dea,
        "hist": hist,
        "volume": [c.get("volume", 0.0) for c in candles],
    }


# ---------------- 背离检测 ----------------

def confirmed_pivots(candles: list[dict], left: int = PIVOT_LEFT, right: int = PIVOT_RIGHT) -> tuple[list[int], list[int]]:
    """已确认的 swing high / low 下标：左右各 right/left 根内的极值"""
    highs, lows = [], []
    for i in range(left, len(candles) - right):
        h, l = candles[i]["high"], candles[i]["low"]
        if all(h >= candles[j]["high"] for j in range(i - left, i + right + 1) if j != i):
            highs.append(i)
        if all(l <= candles[j]["low"] for j in range(i - left, i + right + 1) if j != i):
            lows.append(i)
    return highs, lows


def _price_divergence(
    candles: list[dict], values: list, pivots: list[int], direction: str, volume_contraction: bool = False
) -> dict | None:
    """价格类背离通用判定：最近一个已确认摆动点 vs 其后即时极值。
    顶：价格更高且指标更低；底：价格更低且指标更高。
    volume_contraction=True（量价背离专用）：底背离同样是「量缩」（v2 < v1），
    即价格创新低但成交量低于前一低点（杀跌量能衰竭），与 RSI/OBV/DIF 的底背离方向相反。"""
    if not pivots:
        return None
    p1 = pivots[-1]
    seg = list(range(p1 + 1, len(candles)))
    if not seg:
        return None
    if direction == "top":
        p2 = max(seg, key=lambda i: candles[i]["high"])
        price1, price2 = candles[p1]["high"], candles[p2]["high"]
        if price2 <= price1:
            return None
    else:
        p2 = min(seg, key=lambda i: candles[i]["low"])
        price1, price2 = candles[p1]["low"], candles[p2]["low"]
        if price2 >= price1:
            return None
    v1, v2 = values[p1], values[p2]
    if v1 is None or v2 is None:
        return None
    if direction == "top" and v2 >= v1:
        return None
    if direction == "bottom":
        if volume_contraction and v2 >= v1:
            return None
        if not volume_contraction and v2 <= v1:
            return None
    return {
        "p1_time": candles[p1]["open_time"],
        "p1_price": price1,
        "p2_time": candles[p2]["open_time"],
        "p2_price": price2,
        "v1": v1,
        "v2": v2,
    }


def _area_divergence(candles: list[dict], hist: list[float | None], direction: str) -> dict | None:
    """MACD 面积背离：柱体按零轴分波，最近两波同向区域比较"""
    regions: list[dict] = []
    cur: dict | None = None
    for i, h in enumerate(hist):
        if h is None:
            continue
        sign = 1 if h > 0 else (-1 if h < 0 else 0)
        if cur is not None and sign == cur["sign"]:
            cur["area"] += abs(h)
            cur["end"] = i
        else:
            if cur is not None:
                regions.append(cur)
            cur = {"sign": sign, "start": i, "end": i, "area": abs(h)} if sign else None
    if cur is not None:
        regions.append(cur)
    want = 1 if direction == "top" else -1
    same = [r for r in regions if r["sign"] == want]
    if len(same) < 2:
        return None
    a1, a2 = same[-2], same[-1]
    seg1 = candles[a1["start"] : a1["end"] + 1]
    seg2 = candles[a2["start"] : a2["end"] + 1]
    if direction == "top":
        p1 = max(c["high"] for c in seg1)
        p2 = max(c["high"] for c in seg2)
        if p2 <= p1:
            return None
    else:
        p1 = min(c["low"] for c in seg1)
        p2 = min(c["low"] for c in seg2)
        if p2 >= p1:
            return None
    if a2["area"] >= a1["area"]:
        return None
    return {
        "a1_start": seg1[0]["open_time"],
        "a1_end": seg1[-1]["open_time"],
        "a2_start": seg2[0]["open_time"],
        "a2_end": seg2[-1]["open_time"],
        "p1": p1,
        "p2": p2,
        "area1": a1["area"],
        "area2": a2["area"],
    }


def detect_divergences(candles: list[dict], ind: dict) -> dict:
    """返回 {'top': {kind: detail}, 'bottom': {kind: detail}}，未启用过滤在告警层做"""
    highs, lows = confirmed_pivots(candles)
    out = {"top": {}, "bottom": {}}
    for direction, pivots in (("top", highs), ("bottom", lows)):
        for kind in ("volume", "rsi", "obv", "macd"):
            key = "dif" if kind == "macd" else kind
            detail = _price_divergence(
                candles, ind[key], pivots, direction, volume_contraction=(kind == "volume")
            )
            if detail:
                out[direction][kind] = detail
        area = _area_divergence(candles, ind["hist"], direction)
        if area:
            out[direction]["macd_area"] = area
    return out


# ---------------- 告警 ----------------

def _fmt(v: float) -> str:
    return f"{v:,.2f}" if abs(v) >= 1 else f"{v:.6f}"


async def _send_div_webhook(client: httpx.AsyncClient, alert: dict) -> tuple[bool, str]:
    if not config.FWALERT_WEBHOOK:
        return False, "未配置 FWALERT_WEBHOOK"
    cn_tz = timezone(timedelta(hours=8))
    time_str = datetime.now(cn_tz).strftime("%Y-%m-%d %H:%M:%S")
    direction_cn = "顶背离" if alert["direction"] == "top" else "底背离"
    kinds_cn = "、".join(KIND_CN[k] for k in alert["kinds"])
    text = (
        f"【背离告警】{alert['symbol']} {alert['interval']} {direction_cn}组合"
        f"（{len(alert['kinds'])} 种 ≥ 阈值 {alert['min_count']}）：{kinds_cn}（检测时间 {time_str}）"
    )
    payload = {
        "message": text,
        "content": text,
        "brief": f"{alert['symbol']} {alert['interval']} {direction_cn}×{len(alert['kinds'])}",
        "text": text,
        "symbol": alert["symbol"],
        "interval": alert["interval"],
        "type": "divergence",
        "direction": alert["direction"],
        "kinds": ",".join(alert["kinds"]),
        "kinds_cn": kinds_cn,
        "count": str(len(alert["kinds"])),
        "min_count": str(alert["min_count"]),
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


async def _eval_alerts(client: httpx.AsyncClient, interval: str, cfg: dict, divs: dict) -> None:
    try:
        state = json.loads(database.get_state(DIV_STATE_KEY) or "{}")
    except ValueError:
        state = {}
    st = state.get(interval) or {"top": False, "bottom": False}
    changed = False
    for direction in ("top", "bottom"):
        kinds = [k for k in KINDS if cfg["enabled"].get(k, True) and k in divs[direction]]
        active = bool(st.get(direction))
        if len(kinds) >= cfg["min_count"] and not active:
            details = {k: divs[direction][k] for k in kinds}
            alert_id = database.add_div_alert(
                SYMBOL, interval, direction, kinds, details, cfg["min_count"]
            )
            log.info("背离告警 %s %s %s：%s", SYMBOL, interval, direction, kinds)
            alert = database.get_div_alert(alert_id)
            secpoller.publish({"type": "div_alert", "alert": alert})
            if cfg["notify_webhook"]:
                ok, err = await _send_div_webhook(client, alert)
                database.set_div_alert_webhook(alert_id, ok, err)
                if not ok:
                    log.error("背离告警 webhook 发送失败: %s", err)
            st[direction] = True
            changed = True
        elif len(kinds) < cfg["min_count"] and active:
            st[direction] = False  # 组合解除，重新武装
            changed = True
    if changed:
        state[interval] = st
        database.set_state(DIV_STATE_KEY, json.dumps(state))


# ---------------- 主循环 ----------------

async def _series(client: httpx.AsyncClient, interval: str) -> list[dict]:
    """合约优先拉取 K 线，**保留正在走的一根**（背离检测不等收盘）"""
    spot, fut = await asyncio.gather(
        poller._fetch_klines(client, config.BINANCE_BASE_URLS, "/api/v3/klines", SYMBOL, interval, KLINE_LIMIT),
        poller._fetch_klines(client, config.FUTURES_BASE_URLS, "/fapi/v1/klines", SYMBOL, interval, KLINE_LIMIT),
    )
    series = poller.select_series(spot, fut)
    if series:
        poller.last_prices[SYMBOL] = (series[-1]["close"], time.time())
    return series


async def div_poller_loop() -> None:
    async with httpx.AsyncClient(
        headers={"User-Agent": "price-alert/1.0"}, follow_redirects=True
    ) as client:
        while True:
            try:
                cfg = get_config()
                for interval in DIV_INTERVALS:
                    candles = await _series(client, interval)
                    if len(candles) < 40:
                        continue
                    ind = compute_indicators(candles)
                    divs = detect_divergences(candles, ind)
                    n = min(len(candles), CHART_CANDLES)
                    div_cache[interval] = {
                        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        "candles": candles[-n:],
                        "indicators": {k: v[-n:] for k, v in ind.items()},
                        "divergences": divs,
                    }
                    await _eval_alerts(client, interval, cfg[interval], divs)
                div_status.update(
                    ok=True,
                    error="",
                    last_poll=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                )
            except Exception as e:  # noqa: BLE001
                div_status.update(ok=False, error=str(e)[:300])
                log.error("背离轮询失败: %s", e)
            await asyncio.sleep(config.POLL_INTERVAL)
