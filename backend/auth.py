"""登录认证与防爆破

安全设计：
- 密码使用 bcrypt 校验，数据库/代码中不存明文
- JWT（HS256）放入 HttpOnly + SameSite=Strict Cookie，JS 无法读取，跨站表单无法携带
- 所有写操作额外要求 X-Requested-With 自定义头（CSRF 二次防线）
- 单 IP 连续失败 N 次锁定一段时间，且每次失败有递增延迟，抵御爆破/字典攻击
"""
import asyncio
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, Response, status
from fastapi.security.utils import get_authorization_scheme_param

from . import config

# ---------- 密码 ----------
_cached_hash: Optional[bytes] = None


def _password_hash() -> bytes:
    global _cached_hash
    if _cached_hash is None:
        if config.ADMIN_PASSWORD_HASH:
            _cached_hash = config.ADMIN_PASSWORD_HASH.encode()
        elif config.ADMIN_PASSWORD:
            _cached_hash = bcrypt.hashpw(config.ADMIN_PASSWORD.encode(), bcrypt.gensalt(rounds=12))
        else:
            raise RuntimeError(
                "未配置管理员密码：请在 backend/.env 中设置 ADMIN_PASSWORD 或 ADMIN_PASSWORD_HASH"
            )
    return _cached_hash


def verify_credentials(username: str, password: str) -> bool:
    if not secrets_compare(username, config.ADMIN_USERNAME):
        # 用户名错误也走一次 bcrypt，避免时间侧信道探测用户名是否存在
        bcrypt.hashpw(b"dummy", bcrypt.gensalt(rounds=4))
        return False
    try:
        return bcrypt.checkpw(password.encode(), _password_hash())
    except ValueError:
        return False


def secrets_compare(a: str, b: str) -> bool:
    import hmac

    return hmac.compare_digest(a.encode(), b.encode())


# ---------- 登录限流 / 锁定 ----------
_failures: dict[str, dict] = {}  # ip -> {"count": int, "locked_until": float, "last": float}


def _client_ip(request: Request) -> str:
    # 部署在反向代理后时，uvicorn 需以 --proxy-headers 启动才会得到真实 IP
    return request.client.host if request.client else "unknown"


def check_login_allowed(request: Request) -> Optional[int]:
    """返回剩余锁定秒数；None 表示允许尝试"""
    ip = _client_ip(request)
    rec = _failures.get(ip)
    if rec and rec.get("locked_until", 0) > time.time():
        return int(rec["locked_until"] - time.time()) + 1
    return None


async def record_login_result(request: Request, success: bool) -> None:
    ip = _client_ip(request)
    if success:
        _failures.pop(ip, None)
        return
    rec = _failures.setdefault(ip, {"count": 0, "locked_until": 0.0, "last": 0.0})
    rec["count"] += 1
    rec["last"] = time.time()
    # 递增延迟：第 n 次失败多等一会儿，拖慢在线爆破
    await asyncio.sleep(min(0.5 * rec["count"], 5.0))
    if rec["count"] >= config.LOGIN_MAX_FAILS:
        rec["locked_until"] = time.time() + config.LOGIN_LOCK_MINUTES * 60
        rec["count"] = 0


# ---------- JWT ----------
def issue_token(response: Response) -> None:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": config.ADMIN_USERNAME,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(hours=config.TOKEN_TTL_HOURS)).timestamp()),
    }
    token = jwt.encode(payload, config.SECRET_KEY, algorithm="HS256")
    response.set_cookie(
        config.COOKIE_NAME,
        token,
        max_age=config.TOKEN_TTL_HOURS * 3600,
        httponly=True,
        secure=config.COOKIE_SECURE,
        samesite="strict",
        path="/",
    )


def clear_token(response: Response) -> None:
    response.delete_cookie(config.COOKIE_NAME, path="/")


def get_current_user(request: Request) -> str:
    token = request.cookies.get(config.COOKIE_NAME, "")
    if not token:
        # 兼容 Bearer 头（便于脚本调用）
        auth = request.headers.get("Authorization", "")
        scheme, _, param = auth.partition(" ")
        if get_authorization_scheme_param(scheme) == "bearer":
            token = param
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "未登录")
    try:
        payload = jwt.decode(token, config.SECRET_KEY, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "登录已过期，请重新登录")
    return payload["sub"]


def csrf_guard(request: Request) -> None:
    """写操作要求自定义头，浏览器跨站表单无法伪造"""
    if request.headers.get("X-Requested-With") != "XMLHttpRequest":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "缺少防跨站请求头")


CurrentUser = Depends(get_current_user)
CsrfGuard = Depends(csrf_guard)
