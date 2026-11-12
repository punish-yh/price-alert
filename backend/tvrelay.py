"""TradingView 信号解析、周期有效性与自定义组合告警

- 公开入口 POST /api/tv-webhook/{token}，URL 中的 token 即凭证。
- 只接收「波段过滤器 / 趋势过滤器」约定文本；无法解析的消息仅留历史，不进入有效信号。
- 有效期按消息中的 UTC 触发时间对齐到下一个自然周期边界，重启后仍可从 SQLite 恢复。
- 每条规则针对同一币种组合多个 过滤器×周期×方向 条件；满足时记录网页告警，可选饭碗。
- 同一组合窗口只告警一次，条件失效后重新武装；饭碗失败每 2 分钟重试，最多 3 次。
"""
import asyncio
import json
import logging
import re
import time
from datetime import datetime, timedelta, timezone

import httpx

from . import config, database, secpoller

log = logging.getLogger("tvrelay")

MAX_BODY_BYTES = 16 * 1024
INTERVALS = ("15m", "1h", "4h", "1d")
INTERVAL_SECONDS = {"15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}
FILTER_TYPES = {"wave": "波段过滤器", "trend": "趋势过滤器"}
DIRECTIONS = {"bullish": "所有看涨信号", "bearish": "所有看跌信号"}
TV_RULES_KEY = "tv_combo_rules"
TV_RULE_STATE_KEY = "tv_combo_rule_state"
WEBHOOK_RETRY_INTERVAL = 120
WEBHOOK_MAX_RETRIES = 3

# ip -> [epoch, ...]
_rate: dict[str, list[float]] = {}
_webhook_tasks: set[asyncio.Task] = set()


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def rate_allowed(ip: str) -> bool:
    now = time.time()
    bucket = [t for t in _rate.get(ip, []) if now - t < config.TV_RATE_WINDOW]
    if len(bucket) >= config.TV_RATE_LIMIT:
        _rate[ip] = bucket
        return False
    bucket.append(now)
    _rate[ip] = bucket
    return True


def _parse_trigger_time(raw: str) -> datetime:
    value = re.sub(r"\s*[（(]\s*UTC\s*[）)]\s*$", "", raw.strip(), flags=re.IGNORECASE)
    value = re.sub(r"\s+UTC\s*$", "", value, flags=re.IGNORECASE).strip()
    if not value or "{{" in value:
        raise ValueError("触发时间为空或 TradingView 占位符未替换")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00").replace("z", "+00:00"))
    except ValueError as exc:
        raise ValueError("触发时间格式无法识别，请使用 TradingView timenow") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def parse_signal(raw: str) -> tuple[dict | None, str]:
    """解析约定文本，返回（结构化信号，解析错误）。"""
    filter_match = re.search(r"【\s*(波段过滤器|趋势过滤器)\s*】", raw)
    if not filter_match:
        return None, "未识别到【波段过滤器】或【趋势过滤器】标题"
    filter_type = "wave" if filter_match.group(1) == "波段过滤器" else "trend"
    fields: dict[str, str] = {}
    for line in raw.splitlines():
        match = re.match(r"^\s*([^：:]+)[：:]\s*(.*?)\s*$", line)
        if match:
            fields[match.group(1).strip()] = match.group(2).strip()

    instrument = fields.get("币种", "")
    if ":" not in instrument:
        return None, "币种应为 exchange:ticker，例如 BINANCE:BTCUSDT.P"
    exchange, symbol = (part.strip().upper() for part in instrument.split(":", 1))
    if not exchange or not symbol or not re.fullmatch(r"[A-Z0-9][A-Z0-9._-]{0,31}", symbol):
        return None, "交易所或币种代码格式不正确"

    interval = fields.get("周期", "").strip().lower()
    if interval not in INTERVALS:
        return None, "周期仅支持 15m、1h、4h、1d"
    signal_group = fields.get("信号组", "").strip()
    direction = next((key for key, text in DIRECTIONS.items() if text == signal_group), "")
    if not direction:
        return None, "信号组仅支持所有看涨信号或所有看跌信号"
    try:
        trigger_time = _parse_trigger_time(fields.get("触发时间", ""))
    except ValueError as exc:
        return None, str(exc)

    seconds = INTERVAL_SECONDS[interval]
    valid_until = datetime.fromtimestamp(
        (int(trigger_time.timestamp()) // seconds) * seconds + seconds, tz=timezone.utc
    )
    return {
        "filter_type": filter_type,
        "exchange": exchange,
        "symbol": symbol,
        "interval": interval,
        "trigger_time": _iso(trigger_time),
        "direction": direction,
        "signal_group": signal_group,
        "valid_until": _iso(valid_until),
    }, ""


def signal_summary(signal: dict) -> str:
    return (
        f"{FILTER_TYPES[signal['filter_type']]}｜{signal['exchange']}:{signal['symbol']}｜"
        f"{signal['interval']}｜{signal['signal_group']}"
    )


def get_rules() -> list[dict]:
    """只读取用户显式创建的组合，不自动生成默认告警。"""
    raw = database.get_state(TV_RULES_KEY)
    if not raw:
        return []
    try:
        rules = json.loads(raw)
    except ValueError:
        return []
    return rules if isinstance(rules, list) else []


def reset_rule_state(rule_id: int) -> None:
    try:
        state = json.loads(database.get_state(TV_RULE_STATE_KEY) or "{}")
    except ValueError:
        state = {}
    if str(rule_id) in state:
        del state[str(rule_id)]
        database.set_state(TV_RULE_STATE_KEY, json.dumps(state))


def _signal_snapshot(signal: dict) -> dict:
    keys = (
        "id", "filter_type", "exchange", "symbol", "interval", "trigger_time",
        "direction", "signal_group", "valid_until",
    )
    return {key: signal[key] for key in keys}


def _match_rule(rule: dict, active: list[dict]) -> list[dict] | None:
    same_symbol = [s for s in active if s["symbol"] == rule["symbol"]]
    matched: list[dict] = []
    for condition in rule["conditions"]:
        signal = next((
            s for s in same_symbol
            if (condition["filter_type"] == "any" or s["filter_type"] == condition["filter_type"])
            and s["interval"] == condition["interval"]
            and s["direction"] == condition["direction"]
        ), None)
        if signal is None:
            return None
        matched.append(signal)
    return matched


def build_combo_payload(alert: dict) -> dict:
    conditions = " + ".join(
        f"{FILTER_TYPES.get(c['filter_type'], '任意过滤器')} {c['interval']} {DIRECTIONS[c['direction']]}"
        for c in alert["conditions"]
    )
    now_cn = datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S")
    exchange = alert["signals"][0].get("exchange", "") if alert["signals"] else ""
    instrument = f"{exchange}:{alert['symbol']}" if exchange else alert["symbol"]
    text = (
        f"【TV组合告警】{alert['rule_name']}\n"
        f"币种：{instrument}\n"
        f"组合条件：{conditions}\n"
        f"检测时间：{now_cn}（UTC+8）"
    )
    return {
        "message": text,
        "content": text,
        "text": text,
        "brief": f"TV组合 {alert['symbol']} {alert['rule_name']}",
        "source": "tradingview",
        "type": "tv_combo",
        "rule_name": alert["rule_name"],
        "symbol": alert["symbol"],
        "conditions": conditions,
        "signals": json.dumps(alert["signals"], ensure_ascii=False),
        "time": now_cn,
    }


async def _webhook_with_retry(alert_id: int, alert: dict) -> None:
    payload = build_combo_payload(alert)
    async with httpx.AsyncClient(follow_redirects=True) as client:
        for attempt in range(WEBHOOK_MAX_RETRIES + 1):
            error = ""
            if not config.FWALERT_WEBHOOK:
                error = "未配置 FWALERT_WEBHOOK"
            else:
                try:
                    response = await client.post(config.FWALERT_WEBHOOK, json=payload, timeout=10)
                    if response.status_code < 400:
                        database.set_tv_combo_alert_result(alert_id, True)
                        log.info("TV 组合告警 #%d 已送达饭碗", alert_id)
                        return
                    error = f"HTTP {response.status_code}"
                except Exception as exc:  # noqa: BLE001
                    error = str(exc)[:300]
            if attempt >= WEBHOOK_MAX_RETRIES:
                database.set_tv_combo_alert_result(
                    alert_id, False, f"{error}（已重试 {WEBHOOK_MAX_RETRIES} 次）"
                )
                log.error("TV 组合告警 #%d 饭碗最终发送失败：%s", alert_id, error)
                return
            database.set_tv_combo_alert_result(
                alert_id, False, f"{error}（2 分钟后进行第 {attempt + 1}/{WEBHOOK_MAX_RETRIES} 次重试）"
            )
            await asyncio.sleep(WEBHOOK_RETRY_INTERVAL)


def _schedule_webhook(alert_id: int, alert: dict) -> None:
    task = asyncio.create_task(_webhook_with_retry(alert_id, alert))
    _webhook_tasks.add(task)
    task.add_done_callback(_webhook_tasks.discard)


def evaluate_combos(now: datetime | None = None) -> list[int]:
    """评估当前有效信号，返回本次新增的组合告警 id。"""
    now = now or datetime.now(timezone.utc)
    active = database.list_active_tv_signals(_iso(now))
    try:
        state = json.loads(database.get_state(TV_RULE_STATE_KEY) or "{}")
    except ValueError:
        state = {}
    changed = False
    alert_ids: list[int] = []
    for rule in get_rules():
        key = str(rule["id"])
        if not rule.get("enabled", True):
            continue
        matched = _match_rule(rule, active)
        if matched is None:
            if state.get(key):
                state[key] = ""
                changed = True
            continue
        # 使用有效窗口而非记录 id：同一周期重复推送不会反复告警。
        signature = "|".join(
            f"{s['filter_type']}:{s['interval']}:{s['direction']}:{s['valid_until']}" for s in matched
        )
        if state.get(key) == signature:
            continue
        snapshots = [_signal_snapshot(s) for s in matched]
        alert_id = database.add_tv_combo_alert(
            rule["id"], rule["name"], rule["symbol"], rule["conditions"], snapshots
        )
        alert = database.get_tv_combo_alert(alert_id)
        if alert is None:
            continue
        alert_ids.append(alert_id)
        state[key] = signature
        changed = True
        log.info("TV 组合告警：%s 规则「%s」", rule["symbol"], rule["name"])
        secpoller.publish({"type": "tv_combo_alert", "alert": alert})
        if rule.get("notify_webhook", True):
            _schedule_webhook(alert_id, alert)
    if changed:
        database.set_state(TV_RULE_STATE_KEY, json.dumps(state))
    return alert_ids


def handle_alert(raw: str, content_type: str, source_ip: str) -> int:
    """解析并落库；仅结构化信号参与组合，不再逐条直接转发饭碗。"""
    signal, error = parse_signal(raw)
    summary = signal_summary(signal) if signal else (raw.strip()[:200] or "(空消息)")
    record_id = database.add_tv_forward(source_ip, content_type, raw, summary, signal, error)
    if signal:
        signal["id"] = record_id
        secpoller.publish({"type": "tv_signal", "signal": signal})
        evaluate_combos()
    else:
        log.warning("TV 消息 #%d 解析失败：%s", record_id, error)
    return record_id
