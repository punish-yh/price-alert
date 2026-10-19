"""TradingView 告警转发到饭碗告警

- 公开入口 POST /api/tv-webhook/{token}，URL 中的 token 即凭证（TradingView 无法携带 Cookie）
- 支持两种消息体：
  1. JSON（推荐）：TradingView 告警消息里写 JSON，可用 {{ticker}} {{close}} 等 TV 占位符，
     解析后的每个键都会作为饭碗告警模板变量透传
  2. 纯文本：整条文本作为 message 转发
- 每条转发单独落库（tv_forwards），含来源 IP、原始内容、转发结果
- 单 IP 限流，防止入口被刷导致饭碗告警配额耗尽
"""
import asyncio
import json
import logging
import re
import time
from datetime import datetime, timezone, timedelta

import httpx

from . import config, database

log = logging.getLogger("tvrelay")

# ip -> [epoch, ...]
_rate: dict[str, list[float]] = {}

MAX_BODY_BYTES = 16 * 1024
_KEY_RE = re.compile(r"[^a-zA-Z0-9_]")


def rate_allowed(ip: str) -> bool:
    now = time.time()
    bucket = [t for t in _rate.get(ip, []) if now - t < config.TV_RATE_WINDOW]
    if len(bucket) >= config.TV_RATE_LIMIT:
        _rate[ip] = bucket
        return False
    bucket.append(now)
    _rate[ip] = bucket
    return True


def parse_body(raw: str) -> tuple[dict[str, str], str]:
    """返回 (透传字段, 摘要文本)。JSON 消息提取全部标量键；纯文本原样作为 message。"""
    raw = raw.strip()
    if raw.startswith("{"):
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                fields: dict[str, str] = {}
                for k, v in data.items():
                    key = _KEY_RE.sub("", str(k))[:32]
                    if not key or len(fields) >= 50:
                        continue
                    if isinstance(v, (str, int, float, bool)):
                        fields[key] = str(v)[:500]
                # 摘要：优先常见文本键，其次 ticker+close，最后整条 JSON
                for k in ("message", "text", "content", "msg"):
                    if fields.get(k):
                        return fields, fields[k]
                if fields.get("ticker"):
                    price_part = f" close={fields['close']}" if fields.get("close") else ""
                    return fields, f"TV告警 {fields['ticker']}{price_part}"
                return fields, raw[:200]
        except (json.JSONDecodeError, ValueError):
            pass
    return {}, raw[:200] if raw else "(空消息)"


def build_payload(fields: dict[str, str], summary: str, raw: str) -> dict:
    cn_tz = timezone(timedelta(hours=8))
    time_str = datetime.now(cn_tz).strftime("%Y-%m-%d %H:%M:%S")
    text = f"【TradingView】{summary}"
    payload = {
        "message": text,
        "content": text,
        "brief": summary[:100],
        "text": text,
        "source": "tradingview",
        "time": time_str,
        "raw": raw[:1000],
    }
    # JSON 字段透传（不覆盖内置键）
    for k, v in fields.items():
        payload.setdefault(k, v)
    return payload


async def forward_to_fwalert(record_id: int, payload: dict) -> None:
    """后台转发，失败重试 3 次，结果写回记录"""
    if not config.FWALERT_WEBHOOK:
        database.set_tv_forward_result(record_id, False, "未配置 FWALERT_WEBHOOK")
        log.error("TV 转发记录 #%d 发送失败: 未配置 FWALERT_WEBHOOK", record_id)
        return
    err = ""
    async with httpx.AsyncClient(follow_redirects=True) as client:
        for attempt in range(3):
            try:
                resp = await client.post(config.FWALERT_WEBHOOK, json=payload, timeout=10)
                if resp.status_code < 400:
                    database.set_tv_forward_result(record_id, True)
                    log.info("TV 转发记录 #%d 已送达饭碗告警", record_id)
                    return
                err = f"HTTP {resp.status_code}"
            except Exception as e:  # noqa: BLE001
                err = str(e)[:300]
            await asyncio.sleep(2 * (attempt + 1))
    database.set_tv_forward_result(record_id, False, err)
    log.error("TV 转发记录 #%d 发送失败: %s", record_id, err)


def handle_alert(raw: str, content_type: str, source_ip: str) -> int:
    """解析 + 落库 + 派发后台转发，返回记录 id（立即返回，不阻塞 TradingView）"""
    fields, summary = parse_body(raw)
    record_id = database.add_tv_forward(source_ip, content_type, raw, summary)
    payload = build_payload(fields, summary, raw)
    asyncio.get_running_loop().create_task(forward_to_fwalert(record_id, payload))
    return record_id
