"""FastAPI 入口：认证接口 + 监控管理接口 + 生产模式静态托管前端"""
import asyncio
import hmac
import json
import logging
import logging.handlers
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import auth, config, corrpoller, database, divpoller, poller, secpoller, tvrelay

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
# 日志同时落盘到 data/app.log（单文件 5MB，轮转 3 份），便于排查时直接取文件
_log_file = logging.handlers.RotatingFileHandler(
    config.DATA_DIR / "app.log", maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
)
_log_file.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
logging.getLogger().addHandler(_log_file)
# httpx 的 INFO 会把每个外发请求都写进日志（几秒一条），压过真正要排查的 SEC 记录，提升到 WARNING
logging.getLogger("httpx").setLevel(logging.WARNING)


@asynccontextmanager
async def lifespan(app: FastAPI):
    database.init_db()
    # 启动时预热密码哈希，让首次登录不卡顿
    await asyncio.to_thread(auth._password_hash)
    task = asyncio.create_task(poller.poller_loop())
    sec_task = asyncio.create_task(secpoller.sec_poller_loop())
    corr_task = asyncio.create_task(corrpoller.corr_poller_loop())
    div_task = asyncio.create_task(divpoller.div_poller_loop())
    yield
    task.cancel()
    sec_task.cancel()
    corr_task.cancel()
    div_task.cancel()


app = FastAPI(title="币安价格监控告警", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp: Response = await call_next(request)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "same-origin"
    resp.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# ---------------- 认证 ----------------
class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


@app.post("/api/login")
async def login(body: LoginBody, request: Request, response: Response):
    locked = auth.check_login_allowed(request)
    if locked is not None:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, f"尝试次数过多，请 {locked} 秒后再试")
    ok = await asyncio.to_thread(auth.verify_credentials, body.username, body.password)
    await auth.record_login_result(request, ok)
    if not ok:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "用户名或密码错误")
    auth.issue_token(response)
    return {"ok": True, "username": config.ADMIN_USERNAME}


@app.post("/api/logout")
async def logout(response: Response):
    auth.clear_token(response)
    return {"ok": True}


@app.get("/api/me")
async def me(user: str = auth.CurrentUser):
    return {"username": user}


# ---------------- 监控管理 ----------------
class MonitorCreate(BaseModel):
    symbol: str = Field(min_length=2, max_length=20)
    type: str = Field(default="price", pattern="^(price|ema_cross)$")
    direction: str = Field(default="above", pattern="^(above|below)$")
    target_price: float = Field(default=0, ge=0, le=1e12)
    ema_period: int | None = None
    interval: str | None = None
    note: str = Field(default="", max_length=200)


SYMBOL_RE = re.compile(r"^[A-Z0-9]{2,20}$")


@app.get("/api/monitors")
async def list_monitors(user: str = auth.CurrentUser):
    return {
        "items": database.list_monitors(),
        "unread_triggered": database.unread_triggered_count(),
    }


@app.post("/api/monitors/read-triggered")
async def mark_price_triggered_read(
    user: str = auth.CurrentUser,
    _: None = auth.CsrfGuard,
):
    """记录「已触发」已读水位：此后价格监控角标只统计新触发。

    微秒精度使水位严格排在该秒任意触发记录之后（触发记录为秒精度），避免秒级时间比较漏算。
    """
    database.set_state(
        database.PRICE_TRIGGERED_READ_AT,
        datetime.now(timezone.utc).isoformat(timespec="microseconds"),
    )
    return {"ok": True, "unread_triggered": database.unread_triggered_count()}


def _monitor_params(body: MonitorCreate) -> tuple[str, str, float, int | None, str | None]:
    """校验监控参数并返回规范化后的 (symbol, direction, target_price, ema_period, interval)"""
    symbol = body.symbol.upper().strip()
    if not SYMBOL_RE.match(symbol):
        raise HTTPException(400, "交易对格式不正确，例如 BTCUSDT")
    if body.type == "ema_cross":
        if body.ema_period not in poller.EMA_PERIODS:
            raise HTTPException(400, f"EMA 周期仅支持：{', '.join(map(str, poller.EMA_PERIODS))}")
        if body.interval not in poller.EMA_INTERVALS:
            raise HTTPException(400, f"K 线周期仅支持：{', '.join(poller.EMA_INTERVALS)}")
        return symbol, "above", 0, body.ema_period, body.interval
    if body.target_price <= 0:
        raise HTTPException(400, "目标价必须大于 0")
    return symbol, body.direction, body.target_price, None, None


@app.post("/api/monitors", status_code=status.HTTP_201_CREATED)
async def create_monitor(
    body: MonitorCreate,
    user: str = auth.CurrentUser,
    _: None = auth.CsrfGuard,
):
    symbol, direction, target_price, ema_period, interval = _monitor_params(body)
    if body.type == "ema_cross":
        return database.create_monitor(
            symbol, direction, target_price, body.note.strip(),
            type="ema_cross", ema_period=ema_period, interval=interval,
        )
    return database.create_monitor(symbol, direction, target_price, body.note.strip())


@app.post("/api/monitors/{monitor_id}/update")
async def update_monitor(
    monitor_id: int,
    body: MonitorCreate,
    user: str = auth.CurrentUser,
    _: None = auth.CsrfGuard,
):
    m = database.get_monitor(monitor_id)
    if m is None:
        raise HTTPException(404, "监控不存在")
    if m["status"] != "active":
        raise HTTPException(400, "仅活跃状态的监控可以编辑，请先重新激活")
    if body.type != m["type"]:
        raise HTTPException(400, "不能修改监控类型")
    symbol, direction, target_price, ema_period, interval = _monitor_params(body)
    database.update_monitor(
        monitor_id, symbol, direction, target_price, ema_period, interval, body.note.strip()
    )
    return database.get_monitor(monitor_id)


@app.post("/api/monitors/{monitor_id}/delete")
async def delete_monitor(
    monitor_id: int,
    user: str = auth.CurrentUser,
    _: None = auth.CsrfGuard,
):
    result = database.soft_or_hard_delete(monitor_id)
    if result == "missing":
        raise HTTPException(404, "监控不存在")
    return {"ok": True, "result": result}  # deleted=移入已删除, purged=彻底删除


@app.post("/api/monitors/{monitor_id}/restore")
async def restore_monitor(
    monitor_id: int,
    user: str = auth.CurrentUser,
    _: None = auth.CsrfGuard,
):
    if database.get_monitor(monitor_id) is None:
        raise HTTPException(404, "监控不存在")
    if not database.restore_monitor(monitor_id):
        raise HTTPException(400, "仅已触发/已删除的监控可以重新激活")
    return {"ok": True, "monitor": database.get_monitor(monitor_id)}


# ---------------- 行情 ----------------
@app.get("/api/prices")
async def prices(user: str = auth.CurrentUser):
    import time

    now = time.time()
    return {
        "prices": {sym: p for sym, (p, _) in poller.last_prices.items()},
        "updated_at": poller.poller_status["last_poll"],
        "poller_ok": poller.poller_status["ok"],
        "poller_error": poller.poller_status["error"],
        "server_time": now,
    }


@app.get("/api/symbols")
async def symbols(user: str = auth.CurrentUser):
    async with httpx.AsyncClient(follow_redirects=True) as client:
        return {"symbols": await poller.fetch_symbols(client)}


# ---------------- TradingView 告警转发 ----------------
@app.post("/api/tv-webhook/{token}")
async def tv_webhook(token: str, request: Request):
    """TradingView 告警公开入口：URL 中的 token 即凭证，不匹配一律 404 避免暴露存在性"""
    if not hmac.compare_digest(token.encode(), config.TV_WEBHOOK_TOKEN.encode()):
        raise HTTPException(404, "Not Found")
    ip = request.client.host if request.client else "unknown"
    if not tvrelay.rate_allowed(ip):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "请求过于频繁")
    body = await request.body()
    if len(body) > tvrelay.MAX_BODY_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "消息体过大")
    raw = body.decode("utf-8", errors="replace")
    record_id = tvrelay.handle_alert(raw, request.headers.get("content-type", ""), ip)
    return {"ok": True, "id": record_id}


@app.get("/api/tv/config")
async def tv_config(user: str = auth.CurrentUser):
    return {"webhook_path": f"/api/tv-webhook/{config.TV_WEBHOOK_TOKEN}"}


@app.get("/api/tv/forwards")
async def tv_forwards(user: str = auth.CurrentUser):
    return {"items": database.list_tv_forwards()}


@app.post("/api/tv/forwards/{record_id}/delete")
async def tv_forward_delete(
    record_id: int,
    user: str = auth.CurrentUser,
    _: None = auth.CsrfGuard,
):
    if not database.delete_tv_forward(record_id):
        raise HTTPException(404, "记录不存在")
    return {"ok": True}


# ---------------- SEC 财报监听 ----------------
TICKER_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")
WINDOW_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


class SecTaskCreate(BaseModel):
    tickers: list[str] = Field(min_length=1, max_length=20)
    forms: list[str] = Field(min_length=1, max_length=1)
    watch_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    window_start: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    window_end: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    note: str = Field(default="", max_length=200)


@app.get("/api/sec/tasks")
async def sec_tasks(user: str = auth.CurrentUser):
    items = database.list_sec_tasks()
    hits = database.sec_task_hit_counts()
    hit_tickers = database.sec_task_hit_tickers()
    for t in items:
        t["hit_count"] = hits.get(t["id"], 0)
        # 多标的任务须每只都捕获到财报才算「已获取」，仅命中一只不结束监听
        acquired = sorted(hit_tickers.get(t["id"], set()))
        t["hit_tickers"] = acquired
        t["task_status"] = secpoller.task_status(t, set(t["tickers"]) <= set(acquired))
    return {"items": items}


async def _validate_sec_body(body: SecTaskCreate) -> tuple[list[str], list[str]]:
    """校验 SEC 任务字段并返回规范化后的 (代码列表, 监听类型列表)"""
    try:
        datetime.strptime(body.watch_date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "监听日期格式不正确")
    forms = sorted({f.strip().upper() for f in body.forms if f.strip()})
    bad_forms = [f for f in forms if f not in secpoller.FORM_TYPES]
    if not forms or bad_forms:
        raise HTTPException(400, f"监听类型仅支持：{', '.join(secpoller.FORM_TYPES)}")
    tickers = sorted({t.upper().strip() for t in body.tickers if t.strip()})
    if not tickers:
        raise HTTPException(400, "至少填写一个标的代码")
    bad = [t for t in tickers if not TICKER_RE.match(t)]
    if bad:
        raise HTTPException(400, f"代码格式不正确：{', '.join(bad)}")
    # 用 SEC 官方映射校验代码是否存在；映射不可用时跳过校验，不阻断创建
    try:
        tmap = await secpoller.get_ticker_map()
        unknown = [t for t in tickers if t not in tmap]
        if unknown:
            raise HTTPException(400, f"SEC 未收录的代码：{', '.join(unknown)}")
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 - 映射拉取失败时放行
        logging.getLogger("main").warning("SEC ticker 映射校验跳过: %s", e)
    return tickers, forms


@app.post("/api/sec/tasks", status_code=status.HTTP_201_CREATED)
async def sec_task_create(
    body: SecTaskCreate,
    user: str = auth.CurrentUser,
    _: None = auth.CsrfGuard,
):
    tickers, forms = await _validate_sec_body(body)
    return database.create_sec_task(
        tickers, body.watch_date, body.window_start, body.window_end, body.note.strip(), forms
    )


@app.post("/api/sec/tasks/{task_id}/update")
async def sec_task_update(
    task_id: int,
    body: SecTaskCreate,
    user: str = auth.CurrentUser,
    _: None = auth.CsrfGuard,
):
    task = database.get_sec_task(task_id)
    if task is None or task["status"] != "active":
        raise HTTPException(404, "监听任务不存在")
    tickers, forms = await _validate_sec_body(body)
    database.update_sec_task(
        task_id, tickers, body.watch_date, body.window_start, body.window_end, body.note.strip(), forms
    )
    return database.get_sec_task(task_id)


@app.post("/api/sec/tasks/{task_id}/delete")
async def sec_task_delete(
    task_id: int,
    user: str = auth.CurrentUser,
    _: None = auth.CsrfGuard,
):
    if not database.delete_sec_task(task_id):
        raise HTTPException(404, "监听任务不存在")
    return {"ok": True}


@app.get("/api/sec/hits")
async def sec_hits(user: str = auth.CurrentUser):
    return {
        "items": database.list_sec_hits(),
        "status": secpoller.sec_status,
        "unread": database.unread_sec_hits_count(),
    }


@app.post("/api/sec/hits/{hit_id}/read")
async def sec_hit_read(
    hit_id: int,
    user: str = auth.CurrentUser,
    _: None = auth.CsrfGuard,
):
    """单条已阅：角标未读数随之减一（重复点击幂等）"""
    if database.get_sec_hit(hit_id) is None:
        raise HTTPException(404, "财报记录不存在")
    database.mark_sec_hit_read(hit_id)
    return {"ok": True, "unread": database.unread_sec_hits_count()}


@app.post("/api/sec/hits/read-all")
async def sec_hits_read_all(
    user: str = auth.CurrentUser,
    _: None = auth.CsrfGuard,
):
    marked = database.mark_all_sec_hits_read()
    return {"ok": True, "marked": marked, "unread": database.unread_sec_hits_count()}


@app.get("/api/sec/events")
async def sec_events(user: str = auth.CurrentUser):
    """SEC 新财报实时推送（SSE）：命中即刻发到网页，替代前端轮询的秒级延迟"""

    async def stream():
        queue = secpoller.subscribe()
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=20)
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            secpoller.unsubscribe(queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------- 相关度计算（vs BTC） ----------------

class CorrMonitorCreate(BaseModel):
    symbol: str = Field(min_length=2, max_length=20)
    price_source: str = Field(default="close")
    notify_webhook: bool = Field(default=True)
    thresholds: dict = Field(default_factory=dict)


def _corr_params(body: CorrMonitorCreate) -> tuple[str, str, bool, dict]:
    symbol = body.symbol.upper().strip()
    if not SYMBOL_RE.match(symbol):
        raise HTTPException(400, "交易对格式不正确，例如 ETHUSDT")
    if symbol == corrpoller.BENCHMARK:
        raise HTTPException(400, "基准就是 BTC，无需监控 BTCUSDT 自身")
    if body.price_source not in corrpoller.PRICE_SOURCES:
        raise HTTPException(400, f"价格源仅支持：{', '.join(corrpoller.PRICE_SOURCES)}")
    thresholds: dict = {}
    for interval, th in (body.thresholds or {}).items():
        if interval not in corrpoller.INTERVALS:
            raise HTTPException(400, "周期仅支持 1h / 4h / 1d")
        cleaned: dict = {}
        for kind, lo, hi, label in (("decorr", 0.0, 1.0, "脱钩阈值"), ("shift", 0.0, 2.0, "突变阈值")):
            v = (th or {}).get(kind)
            if v is None or v == "":
                cleaned[kind] = None  # 留空 = 关闭该类告警
                continue
            try:
                v = float(v)
            except (TypeError, ValueError):
                raise HTTPException(400, f"{label}必须是数字")
            if not (lo < v <= hi):
                raise HTTPException(400, f"{label}需在 ({lo}, {hi}] 区间内")
            cleaned[kind] = v
        thresholds[interval] = cleaned
    return symbol, body.price_source, body.notify_webhook, thresholds


@app.get("/api/corr/monitors")
async def corr_monitors(user: str = auth.CurrentUser):
    items = database.list_corr_monitors()
    for m in items:
        m["latest"] = database.corr_latest(m["id"])
        m["states"] = database.corr_states_for(m["id"])
    return {"items": items, "status": corrpoller.corr_status}


@app.post("/api/corr/monitors", status_code=status.HTTP_201_CREATED)
async def corr_monitor_create(
    body: CorrMonitorCreate,
    user: str = auth.CurrentUser,
    _: None = auth.CsrfGuard,
):
    symbol, price_source, notify_webhook, thresholds = _corr_params(body)
    m = database.create_corr_monitor(symbol, price_source, notify_webhook, thresholds)
    # 新建时立即回填，不再让用户等待下一轮后台轮询；失败仍可随后台水位自动重试
    try:
        await asyncio.wait_for(corrpoller.backfill_monitor_now(m), timeout=45)
    except Exception as e:  # noqa: BLE001 - 监控已创建，回填失败不能变成创建失败
        logging.getLogger("corrpoller").warning("%s 创建后即时回填未完成: %s", symbol, e)
    m["latest"] = database.corr_latest(m["id"])
    m["states"] = database.corr_states_for(m["id"])
    return m


@app.post("/api/corr/monitors/{monitor_id}/update")
async def corr_monitor_update(
    monitor_id: int,
    body: CorrMonitorCreate,
    user: str = auth.CurrentUser,
    _: None = auth.CsrfGuard,
):
    m = database.get_corr_monitor(monitor_id)
    if m is None or m["status"] != "active":
        raise HTTPException(404, "相关度监控不存在")
    symbol, price_source, notify_webhook, thresholds = _corr_params(body)
    if symbol != m["symbol"]:
        raise HTTPException(400, "不能修改交易对，请删除后新建")
    database.update_corr_monitor(monitor_id, price_source, notify_webhook, thresholds)
    return database.get_corr_monitor(monitor_id)


@app.post("/api/corr/monitors/{monitor_id}/delete")
async def corr_monitor_delete(
    monitor_id: int,
    user: str = auth.CurrentUser,
    _: None = auth.CsrfGuard,
):
    if not database.delete_corr_monitor(monitor_id):
        raise HTTPException(404, "相关度监控不存在")
    return {"ok": True}


@app.get("/api/corr/monitors/{monitor_id}/history")
async def corr_monitor_history(monitor_id: int, interval: str = "1h", user: str = auth.CurrentUser):
    if interval not in corrpoller.INTERVALS:
        raise HTTPException(400, "周期仅支持 1h / 4h / 1d")
    return {
        "interval": interval,
        "window": corrpoller.INTERVALS[interval],
        "items": database.corr_history_list(monitor_id, interval),
    }


@app.get("/api/corr/alerts")
async def corr_alerts(user: str = auth.CurrentUser):
    return {"items": database.list_corr_alerts(), "unread": database.unread_corr_alerts_count()}


@app.post("/api/corr/alerts/{alert_id}/read")
async def corr_alert_read(
    alert_id: int,
    user: str = auth.CurrentUser,
    _: None = auth.CsrfGuard,
):
    if database.get_corr_alert(alert_id) is None:
        raise HTTPException(404, "告警记录不存在")
    database.mark_corr_alert_read(alert_id)
    return {"ok": True, "unread": database.unread_corr_alerts_count()}


@app.post("/api/corr/alerts/read-all")
async def corr_alerts_read_all(
    user: str = auth.CurrentUser,
    _: None = auth.CsrfGuard,
):
    marked = database.mark_all_corr_alerts_read()
    return {"ok": True, "marked": marked, "unread": database.unread_corr_alerts_count()}


# ---------------- BTC 背离监控 ----------------

class DivRuleUpdate(BaseModel):
    id: int = Field(default=0, ge=0)
    name: str = Field(max_length=50)
    kinds: list[str]
    min_count: int = Field(ge=2, le=5)
    intervals: list[str]
    direction: str = "both"
    notify_webhook: bool = True
    enabled: bool = True


def _reset_div_rule_state(rule_id: int) -> None:
    """规则内容变化后清除其告警状态，避免沿用旧组合的触发状态。"""
    try:
        state = json.loads(database.get_state(divpoller.DIV_STATE_KEY) or "{}")
    except ValueError:
        state = {}
    prefix = f"{rule_id}|"
    changed = {k: v for k, v in state.items() if not k.startswith(prefix)}
    if changed != state:
        database.set_state(divpoller.DIV_STATE_KEY, json.dumps(changed))


@app.get("/api/div/overview")
async def div_overview(user: str = auth.CurrentUser):
    return {
        "intervals": divpoller.div_cache,
        "rules": divpoller.get_rules(),
        "status": divpoller.div_status,
    }


@app.post("/api/div/rules")
async def div_rule_save(
    body: DivRuleUpdate,
    user: str = auth.CurrentUser,
    _: None = auth.CsrfGuard,
):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "规则名称不能为空")
    kinds = list(dict.fromkeys(body.kinds))
    if not kinds or any(k not in divpoller.KINDS for k in kinds):
        raise HTTPException(400, "请至少选择一种有效的背离类型")
    intervals = list(dict.fromkeys(body.intervals))
    if not intervals or any(i not in divpoller.DIV_INTERVALS for i in intervals):
        raise HTTPException(400, "请至少选择一个有效周期（1h / 4h / 1d）")
    if body.direction not in ("both", "top", "bottom"):
        raise HTTPException(400, "方向仅支持双向、仅顶或仅底")
    if body.min_count > len(kinds):
        raise HTTPException(400, "告警数量阈值不能大于已选背离种类数")

    rules = divpoller.get_rules()
    rule = {
        "id": body.id,
        "name": name,
        "kinds": kinds,
        "min_count": body.min_count,
        "intervals": intervals,
        "direction": body.direction,
        "notify_webhook": body.notify_webhook,
        "enabled": body.enabled,
    }
    for i, old in enumerate(rules):
        if old["id"] == body.id and body.id > 0:
            rules[i] = rule
            break
    else:
        rule["id"] = max((r["id"] for r in rules), default=0) + 1
        rules.append(rule)
    database.set_state(divpoller.DIV_RULES_KEY, json.dumps(rules, ensure_ascii=False))
    _reset_div_rule_state(rule["id"])
    return {"ok": True, "rules": divpoller.get_rules()}


@app.post("/api/div/rules/{rule_id}/delete")
async def div_rule_delete(
    rule_id: int,
    user: str = auth.CurrentUser,
    _: None = auth.CsrfGuard,
):
    rules = divpoller.get_rules()
    remaining = [r for r in rules if r["id"] != rule_id]
    if len(remaining) == len(rules):
        raise HTTPException(404, "告警规则不存在")
    database.set_state(divpoller.DIV_RULES_KEY, json.dumps(remaining, ensure_ascii=False))
    _reset_div_rule_state(rule_id)
    return {"ok": True, "rules": remaining}


@app.get("/api/div/alerts")
async def div_alerts(user: str = auth.CurrentUser):
    return {"items": database.list_div_alerts(), "unread": database.unread_div_alerts_count()}


@app.post("/api/div/alerts/{alert_id}/read")
async def div_alert_read(
    alert_id: int,
    user: str = auth.CurrentUser,
    _: None = auth.CsrfGuard,
):
    if database.get_div_alert(alert_id) is None:
        raise HTTPException(404, "告警记录不存在")
    database.mark_div_alert_read(alert_id)
    return {"ok": True, "unread": database.unread_div_alerts_count()}


@app.post("/api/div/alerts/read-all")
async def div_alerts_read_all(
    user: str = auth.CurrentUser,
    _: None = auth.CsrfGuard,
):
    marked = database.mark_all_div_alerts_read()
    return {"ok": True, "marked": marked, "unread": database.unread_div_alerts_count()}


# ---------------- 生产模式：托管前端构建产物 ----------------
DIST_DIR = config.PROJECT_DIR / "dist"
if DIST_DIR.exists():
    app.mount("/assets", StaticFiles(directory=DIST_DIR / "assets"), name="assets")

    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"])
    async def spa(full_path: str, request: Request):
        if full_path.startswith("api/"):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        file = DIST_DIR / full_path
        if request.method == "HEAD":
            # 探测/校验类请求（如部署平台、监控探针）只发 HEAD，无需响应体
            return Response(media_type="text/html")
        if full_path and file.is_file():
            return FileResponse(file)
        return FileResponse(DIST_DIR / "index.html")
