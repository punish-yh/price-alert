"""BTC 候选/确认背离监控 + 用户自定义信号组合告警

- 标的固定 BTCUSDT（合约优先），周期 15m / 1h / 4h / 1d，每 POLL_INTERVAL 秒（默认 5 分钟）检测。
- 候选背离：完整保留旧实时逻辑，左右各 3 根摆动点，比较已确认摆动点与其后即时极值；
  包含正在走的 K 线，可能随行情形成或消失。
- 确认背离：与参考网站公开算法一致，只使用已收盘 K 线；价格拐点左 5、右 2，
  指标取拐点前后各 2 根极值，两拐点间隔 5~60 根，右侧第 2 根收盘时确认。
- 确认量价：比较两段走势的累计成交量；确认 MACD 面积：从拐点附近同号柱定位连续区域，
  面积只累计到确认时刻。RSI(14) Wilder、OBV、MACD(12,26,9) DIF 与参考口径一致。
- 最近 365 根 K 线、候选信号、当前确认信号及历史确认信号均供前端画图，是否告警不影响展示。
- 每条规则独立选择候选、确认或两者参与组合告警；候选解除后重新武装，确认按时间戳去重。
- 通知：网页（SSE + 告警记录）必选，饭碗 webhook 每条规则可选。
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
DIV_INTERVALS = ("15m", "1h", "4h", "1d")
KINDS = ("volume", "rsi", "obv", "macd", "macd_area")
KIND_CN = {
    "volume": "量价",
    "rsi": "RSI",
    "obv": "OBV",
    "macd": "MACD(DIF)",
    "macd_area": "MACD面积",
}
PIVOT_LEFT = 3  # 候选背离沿用旧逻辑
PIVOT_RIGHT = 3
CONFIRMED_LEFT = 5  # 确认背离与参考网站一致：左 5、右 2
CONFIRMED_RIGHT = 2
CONFIRMED_VALUE_WINDOW = 2
CONFIRMED_GAP_MIN = 5
CONFIRMED_GAP_MAX = 60
CHART_CANDLES = 365
KLINE_LIMIT = 450  # 覆盖 365 根展示 + 指标预热（EMA26 / DEA9 / RSI14 收敛）

DIV_RULES_KEY = "div_rules"
DIV_STATE_KEY = "div_rule_alert_state"
WEBHOOK_RETRY_INTERVAL = 120  # 电话/饭碗失败后每 2 分钟重试
WEBHOOK_MAX_RETRIES = 3  # 首次发送之外，最多再重试 3 次

div_status: dict = {"ok": None, "error": "", "last_poll": None}
# interval -> {candles, indicators, divergences, history, updated_at}（内存缓存，供 API 直接返回）
div_cache: dict = {}
_webhook_tasks: set[asyncio.Task] = set()


def get_rules() -> list[dict]:
    """只读取用户显式保存的规则；没有规则时绝不自动创建默认告警。"""
    raw = database.get_state(DIV_RULES_KEY)
    if not raw:
        return []
    try:
        rules = json.loads(raw)
    except ValueError:
        return []
    return rules if isinstance(rules, list) else []


# ---------------- 指标计算 ----------------

def rsi_series(closes: list[float], period: int = 14, flat_value: float = 50.0) -> list[float | None]:
    """Wilder RSI；候选沿用旧平盘值 50，确认信号传 0 与参考网站一致。"""
    out: list[float | None] = [None] * len(closes)
    if len(closes) <= period:
        return out
    gains = [max(closes[i] - closes[i - 1], 0.0) for i in range(1, len(closes))]
    losses = [max(closes[i - 1] - closes[i], 0.0) for i in range(1, len(closes))]
    avg_g = sum(gains[:period]) / period
    avg_l = sum(losses[:period]) / period

    def value() -> float:
        if avg_l == 0:
            return 100.0 if avg_g > 0 else flat_value
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
    """当前价格类背离：最近一个已确认摆动点 vs 其后即时极值。
    顶：价格更高且指标更低；底：价格更低且指标更高。
    volume_contraction=True（量价专用）：底背离同样是「量缩」（v2 < v1）。"""
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


def _hist_regions(hist: list[float | None]) -> list[dict]:
    """MACD 柱体按零轴划分波段区域：{sign, start, end, area}（area 为柱体绝对值求和）"""
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
    return regions


def _area_compare(candles: list[dict], a1: dict, a2: dict, direction: str) -> dict | None:
    """两波同向区域比较：后波价格更极端且面积更小才背离"""
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


def _area_divergence(candles: list[dict], hist: list[float | None], direction: str) -> dict | None:
    """当前 MACD 面积背离：最近两波同向区域比较"""
    want = 1 if direction == "top" else -1
    same = [r for r in _hist_regions(hist) if r["sign"] == want]
    if len(same) < 2:
        return None
    return _area_compare(candles, same[-2], same[-1], direction)


def detect_candidates(candles: list[dict], ind: dict) -> dict:
    """候选信号：完整保留旧实时逻辑，每 5 分钟计算并包含正在走的 K 线。"""
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


def _confirmed_is_pivot(candles: list[dict], i: int, direction: str) -> bool:
    """参考网站口径：低点不高于左 5 根且严格低于右 2 根；高点反之。"""
    value = candles[i]["low" if direction == "bottom" else "high"]
    for j in range(i - CONFIRMED_LEFT, i):
        other = candles[j]["low" if direction == "bottom" else "high"]
        if (direction == "bottom" and other < value) or (direction == "top" and other > value):
            return False
    for j in range(i + 1, i + CONFIRMED_RIGHT + 1):
        other = candles[j]["low" if direction == "bottom" else "high"]
        if (direction == "bottom" and other <= value) or (direction == "top" and other >= value):
            return False
    return True


def _confirmed_value_near(values: list, i: int, direction: str, end: int) -> float | None:
    """指标取价格拐点前后各 2 根里的最低值（底）或最高值（顶）。"""
    selected = None
    for j in range(max(0, i - CONFIRMED_VALUE_WINDOW), min(end, i + CONFIRMED_VALUE_WINDOW) + 1):
        value = values[j]
        if value is None:
            return None
        if selected is None or (direction == "bottom" and value < selected) or (direction == "top" and value > selected):
            selected = value
    return selected


def _confirmed_segment_volume(candles: list[dict], i: int, direction: str, prev_i: int | None) -> float | None:
    """量价比较两段走势的累计成交量，而不是拐点上的单根成交量。"""
    start = prev_i + 1 if prev_i is not None else max(0, i - CONFIRMED_GAP_MAX)
    opposite = "high" if direction == "bottom" else "low"
    extreme_i = None
    for j in range(start, i):
        if extreme_i is None:
            extreme_i = j
        elif direction == "bottom" and candles[j][opposite] >= candles[extreme_i][opposite]:
            extreme_i = j
        elif direction == "top" and candles[j][opposite] <= candles[extreme_i][opposite]:
            extreme_i = j
    if extreme_i is None:
        return None
    return sum(candles[j].get("volume", 0.0) for j in range(extreme_i, i + 1))


def _confirmed_hist_area(hist: list, i: int, direction: str, end: int) -> dict | None:
    """从拐点前后 2 根的最深同号柱定位区域，面积只累计到右侧第 2 根确认时。"""
    negative = direction == "bottom"

    def same_sign(value: float | None) -> bool:
        return value is not None and (value < 0 if negative else value > 0)

    deepest = None
    for j in range(max(0, i - CONFIRMED_VALUE_WINDOW), min(end, i + CONFIRMED_VALUE_WINDOW) + 1):
        value = hist[j]
        if value is None:
            return None
        if same_sign(value) and (
            deepest is None
            or (negative and value < hist[deepest])
            or (not negative and value > hist[deepest])
        ):
            deepest = j
    if deepest is None:
        return None
    cap = min(end, i + CONFIRMED_RIGHT)
    start = deepest
    while start > 0 and same_sign(hist[start - 1]):
        start -= 1
    area_end = deepest
    while area_end + 1 <= cap and same_sign(hist[area_end + 1]):
        area_end += 1
    return {
        "val": sum(abs(hist[j]) for j in range(start, area_end + 1)),
        "run": start,
        "area_end": area_end,
    }


def _confirmed_point(
    candles: list[dict], ind: dict, kind: str, i: int, direction: str, end: int, prev_i: int | None
) -> dict:
    price = candles[i]["low" if direction == "bottom" else "high"]
    point = {"i": i, "price": price}
    if kind == "volume":
        point["val"] = _confirmed_segment_volume(candles, i, direction, prev_i)
    elif kind == "macd_area":
        area = _confirmed_hist_area(ind["hist"], i, direction, end)
        point.update(area or {"val": None})
    else:
        key = "dif" if kind == "macd" else kind
        point["val"] = _confirmed_value_near(ind[key], i, direction, end)
    return point


def _confirmed_pair_hit(kind: str, direction: str, prev: dict, cur: dict) -> bool:
    if prev.get("val") is None or cur.get("val") is None:
        return False
    price_new = cur["price"] < prev["price"] if direction == "bottom" else cur["price"] > prev["price"]
    if not price_new:
        return False
    if kind in ("volume", "macd_area"):
        return cur["val"] < prev["val"]
    return cur["val"] > prev["val"] if direction == "bottom" else cur["val"] < prev["val"]


def _confirmed_signal(candles: list[dict], kind: str, direction: str, prev: dict, cur: dict, at: int) -> dict:
    base = {
        "direction": direction,
        "kind": kind,
        "confirmed_at": candles[at]["open_time"],
    }
    if kind == "macd_area":
        return {
            **base,
            "a1_start": candles[prev["run"]]["open_time"],
            "a1_end": candles[prev["area_end"]]["open_time"],
            "a2_start": candles[cur["run"]]["open_time"],
            "a2_end": candles[cur["area_end"]]["open_time"],
            "p1": prev["price"],
            "p2": cur["price"],
            "area1": prev["val"],
            "area2": cur["val"],
            "p1_time": candles[prev["i"]]["open_time"],
            "p2_time": candles[cur["i"]]["open_time"],
        }
    return {
        **base,
        "p1_time": candles[prev["i"]]["open_time"],
        "p1_price": prev["price"],
        "p2_time": candles[cur["i"]]["open_time"],
        "p2_price": cur["price"],
        "v1": prev["val"],
        "v2": cur["val"],
    }


def detect_confirmed(candles: list[dict], ind: dict, end: int | None = None) -> tuple[dict, list[dict]]:
    """参考网站口径的确认背离；默认排除最后一根正在走的 K 线。

    返回（当前收盘刚确认的信号, 全部历史确认信号）。是否进入告警由规则决定。
    """
    last = len(candles) - 2 if end is None else min(end, len(candles) - 1)
    current = {"top": {}, "bottom": {}}
    history: list[dict] = []
    if last < CONFIRMED_LEFT + CONFIRMED_RIGHT:
        return current, history
    confirmed_ind = {
        **ind,
        "rsi": rsi_series([c["close"] for c in candles], flat_value=0.0),
    }
    for direction in ("top", "bottom"):
        for kind in KINDS:
            prev = None
            for i in range(CONFIRMED_LEFT, last - CONFIRMED_RIGHT + 1):
                if not _confirmed_is_pivot(candles, i, direction):
                    continue
                cur = _confirmed_point(candles, confirmed_ind, kind, i, direction, last, prev["i"] if prev else None)
                if prev:
                    gap = i - prev["i"]
                    if CONFIRMED_GAP_MIN <= gap <= CONFIRMED_GAP_MAX and _confirmed_pair_hit(kind, direction, prev, cur):
                        at = i + CONFIRMED_RIGHT
                        signal = _confirmed_signal(candles, kind, direction, prev, cur, at)
                        history.append(signal)
                        if at == last:
                            detail = {k: v for k, v in signal.items() if k not in ("direction", "kind")}
                            current[direction][kind] = detail
                prev = cur
    history.sort(key=lambda s: (s["confirmed_at"], 0 if s["direction"] == "bottom" else 1, s["kind"]))
    return current, history


# ---------------- 告警 ----------------

def _fmt(v: float) -> str:
    return f"{v:,.2f}" if abs(v) >= 1 else f"{v:.6f}"


async def _send_div_webhook(client: httpx.AsyncClient, alert: dict) -> tuple[bool, str]:
    if not config.FWALERT_WEBHOOK:
        return False, "未配置 FWALERT_WEBHOOK"
    cn_tz = timezone(timedelta(hours=8))
    time_str = datetime.now(cn_tz).strftime("%Y-%m-%d %H:%M:%S")
    direction_cn = "顶背离" if alert["direction"] == "top" else "底背离"
    stage_cn = "候选" if alert.get("signal_stage") == "candidate" else "确认"
    stage_note = "实时候选，可能消失" if stage_cn == "候选" else "右侧 2 根已收盘"
    kinds_cn = "、".join(KIND_CN[k] for k in alert["kinds"])
    condition = (
        f"{len(alert['kinds'])} 种 ≥ 阈值 {alert['min_count']}"
        if alert["min_count"] > 1
        else "任一已选背离"
    )
    text = (
        f"【{stage_cn}背离告警】{alert['symbol']} {alert['interval']} {direction_cn}"
        f"「{alert['rule_name']}」（{condition}）："
        f"{kinds_cn}（{stage_note}；检测时间 {time_str}）"
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
        "signal_stage": alert.get("signal_stage", "confirmed"),
        "rule_name": alert["rule_name"],
        "kinds": ",".join(alert["kinds"]),
        "kinds_cn": kinds_cn,
        "count": str(len(alert["kinds"])),
        "min_count": str(alert["min_count"]),
        "time": time_str,
    }
    try:
        resp = await client.post(config.FWALERT_WEBHOOK, json=payload, timeout=10)
        if resp.status_code < 400:
            return True, ""
        return False, f"HTTP {resp.status_code}"
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:300]


async def _div_webhook_with_retry(client: httpx.AsyncClient, alert_id: int, alert: dict) -> None:
    """独立后台发送：首次失败后每 2 分钟重试，最多重试 3 次，不阻塞行情检测。"""
    try:
        for attempt in range(WEBHOOK_MAX_RETRIES + 1):
            ok, err = await _send_div_webhook(client, alert)
            if ok:
                database.set_div_alert_webhook(alert_id, True, "")
                if attempt:
                    log.info("背离告警 #%d 第 %d 次重试发送成功", alert_id, attempt)
                return
            if attempt >= WEBHOOK_MAX_RETRIES:
                database.set_div_alert_webhook(alert_id, False, f"{err}（已重试 {WEBHOOK_MAX_RETRIES} 次）")
                log.error("背离告警 #%d webhook 最终发送失败: %s", alert_id, err)
                return
            retry_no = attempt + 1
            database.set_div_alert_webhook(
                alert_id, False, f"{err}（2 分钟后进行第 {retry_no}/{WEBHOOK_MAX_RETRIES} 次重试）"
            )
            log.warning(
                "背离告警 #%d webhook 发送失败: %s；2 分钟后第 %d/%d 次重试",
                alert_id, err, retry_no, WEBHOOK_MAX_RETRIES
            )
            await asyncio.sleep(WEBHOOK_RETRY_INTERVAL)
    except asyncio.CancelledError:
        raise
    except Exception as e:  # noqa: BLE001
        log.error("背离告警 #%d webhook 重试任务异常: %s", alert_id, e)


def _schedule_div_webhook(client: httpx.AsyncClient, alert_id: int, alert: dict) -> None:
    task = asyncio.create_task(_div_webhook_with_retry(client, alert_id, alert))
    _webhook_tasks.add(task)
    task.add_done_callback(_webhook_tasks.discard)


async def _eval_alerts(
    client: httpx.AsyncClient, interval: str, rules: list[dict], candidates: dict, confirmed: dict
) -> None:
    """按用户选择分别评估候选/确认信号；候选解除后重武装，确认按时间戳去重。"""
    try:
        state = json.loads(database.get_state(DIV_STATE_KEY) or "{}")
    except ValueError:
        state = {}
    changed = False
    for rule in rules:
        if not rule.get("enabled", True) or interval not in rule["intervals"]:
            continue
        # 未设置数量阈值时，任意一种已选背离即触发；旧规则的数值阈值保持不变。
        min_count = rule.get("min_count") or 1
        selected = rule.get("signal_stage", "confirmed")
        stages = ("candidate", "confirmed") if selected == "both" else (selected,)
        for stage in stages:
            divs = candidates if stage == "candidate" else confirmed
            for direction in ("top", "bottom"):
                if rule["direction"] != "both" and rule["direction"] != direction:
                    continue
                matched = [k for k in KINDS if k in rule["kinds"] and k in divs[direction]]
                # 确认沿用旧键，避免升级后同一确认信号重复告警；候选使用独立状态。
                key = (
                    f"{rule['id']}|{interval}|{direction}"
                    if stage == "confirmed"
                    else f"{rule['id']}|{interval}|candidate|{direction}"
                )
                signature = (
                    "|".join(f"{k}:{divs[direction][k].get('confirmed_at', '')}" for k in matched)
                    if stage == "confirmed"
                    else "candidate"
                )
                active = len(matched) >= min_count and state.get(key) == signature
                if len(matched) >= min_count and not active:
                    details = {k: divs[direction][k] for k in matched}
                    alert_id = database.add_div_alert(
                        SYMBOL, interval, direction, matched, details, min_count, rule["name"], stage
                    )
                    stage_cn = "候选" if stage == "candidate" else "确认"
                    log.info("%s背离告警 %s %s %s 规则「%s」：%s", stage_cn, SYMBOL, interval, direction, rule["name"], matched)
                    alert = database.get_div_alert(alert_id)
                    secpoller.publish({"type": "div_alert", "alert": alert})
                    if rule.get("notify_webhook", True):
                        _schedule_div_webhook(client, alert_id, alert)
                    state[key] = signature
                    changed = True
                elif len(matched) < min_count and state.get(key) not in (None, ""):
                    state[key] = ""
                    changed = True
    if changed:
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
                rules = get_rules()
                for interval in DIV_INTERVALS:
                    candles = await _series(client, interval)
                    if len(candles) < 40:
                        continue
                    ind = compute_indicators(candles)
                    candidates = detect_candidates(candles, ind)
                    confirmed, history = detect_confirmed(candles, ind)
                    n = min(len(candles), CHART_CANDLES)
                    div_cache[interval] = {
                        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        "candles": candles[-n:],
                        "indicators": {k: v[-n:] for k, v in ind.items()},
                        "candidates": candidates,
                        "divergences": confirmed,
                        "history": history,
                    }
                    await _eval_alerts(client, interval, rules, candidates, confirmed)
                div_status.update(
                    ok=True,
                    error="",
                    last_poll=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                )
            except Exception as e:  # noqa: BLE001
                div_status.update(ok=False, error=str(e)[:300])
                log.error("背离轮询失败: %s", e)
            await asyncio.sleep(config.POLL_INTERVAL)
