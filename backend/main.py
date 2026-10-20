"""FastAPI 入口：认证接口 + 监控管理接口 + 生产模式静态托管前端"""
import asyncio
import hmac
import logging
import re
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import auth, config, database, poller, secpoller, tvrelay

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    database.init_db()
    # 启动时预热密码哈希，让首次登录不卡顿
    await asyncio.to_thread(auth._password_hash)
    task = asyncio.create_task(poller.poller_loop())
    sec_task = asyncio.create_task(secpoller.sec_poller_loop())
    yield
    task.cancel()
    sec_task.cancel()


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
    return {"items": database.list_monitors()}


@app.post("/api/monitors", status_code=status.HTTP_201_CREATED)
async def create_monitor(
    body: MonitorCreate,
    user: str = auth.CurrentUser,
    _: None = auth.CsrfGuard,
):
    symbol = body.symbol.upper().strip()
    if not SYMBOL_RE.match(symbol):
        raise HTTPException(400, "交易对格式不正确，例如 BTCUSDT")
    if body.type == "ema_cross":
        if body.ema_period not in poller.EMA_PERIODS:
            raise HTTPException(400, f"EMA 周期仅支持：{', '.join(map(str, poller.EMA_PERIODS))}")
        if body.interval not in poller.EMA_INTERVALS:
            raise HTTPException(400, f"K 线周期仅支持：{', '.join(poller.EMA_INTERVALS)}")
        m = database.create_monitor(
            symbol, "above", 0, body.note.strip(),
            type="ema_cross", ema_period=body.ema_period, interval=body.interval,
        )
        return m
    if body.target_price <= 0:
        raise HTTPException(400, "目标价必须大于 0")
    m = database.create_monitor(symbol, body.direction, body.target_price, body.note.strip())
    return m


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
    forms: list[str] = Field(min_length=1, max_length=3)
    watch_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    window_start: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    window_end: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    note: str = Field(default="", max_length=200)


@app.get("/api/sec/tasks")
async def sec_tasks(user: str = auth.CurrentUser):
    items = database.list_sec_tasks()
    hits = database.sec_task_hit_counts()
    for t in items:
        t["hit_count"] = hits.get(t["id"], 0)
        t["task_status"] = secpoller.task_status(t, t["hit_count"] > 0)
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
    return {"items": database.list_sec_hits(), "status": secpoller.sec_status}


# ---------------- 生产模式：托管前端构建产物 ----------------
DIST_DIR = config.PROJECT_DIR / "dist"
if DIST_DIR.exists():
    app.mount("/assets", StaticFiles(directory=DIST_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def spa(full_path: str):
        if full_path.startswith("api/"):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        file = DIST_DIR / full_path
        if full_path and file.is_file():
            return FileResponse(file)
        return FileResponse(DIST_DIR / "index.html")
