"""应用配置：全部支持环境变量覆盖，本地默认值写在 backend/.env"""
import os
import secrets
from pathlib import Path

from dotenv import load_dotenv

# 修复部分系统代理环境中 NO_PROXY 含 IPv6 条目（如 ::1）导致 httpx 解析崩溃的问题
_no_proxy = os.getenv("NO_PROXY") or os.getenv("no_proxy")
if _no_proxy and ":" in _no_proxy:
    _cleaned = ",".join(
        p for p in (x.strip() for x in _no_proxy.split(",")) if p and ":" not in p
    )
    os.environ["NO_PROXY"] = _cleaned
    os.environ["no_proxy"] = _cleaned

BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

load_dotenv(BASE_DIR / ".env")

# ---------- 账号 ----------
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
# 二选一：ADMIN_PASSWORD_HASH（bcrypt 哈希，推荐）或 ADMIN_PASSWORD（明文，启动时哈希到内存）
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")
ADMIN_PASSWORD_HASH = os.getenv("ADMIN_PASSWORD_HASH", "")

# ---------- 安全 ----------
def _load_secret() -> str:
    secret = os.getenv("SECRET_KEY", "")
    if secret:
        return secret
    # 未配置时生成随机密钥并持久化，避免每次重启会话全部失效
    key_file = DATA_DIR / "secret.key"
    if key_file.exists():
        return key_file.read_text(encoding="utf-8").strip()
    secret = secrets.token_urlsafe(48)
    key_file.write_text(secret, encoding="utf-8")
    return secret

SECRET_KEY = _load_secret()
TOKEN_TTL_HOURS = int(os.getenv("TOKEN_TTL_HOURS", "12"))
# 通过 HTTPS 对外暴露时务必设为 true（Cookie 仅走加密通道）
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() == "true"
COOKIE_NAME = "pa_token"

# 登录防爆破：连续失败 LOGIN_MAX_FAILS 次后锁定 LOGIN_LOCK_MINUTES 分钟
LOGIN_MAX_FAILS = int(os.getenv("LOGIN_MAX_FAILS", "5"))
LOGIN_LOCK_MINUTES = int(os.getenv("LOGIN_LOCK_MINUTES", "15"))

# ---------- Binance ----------
# 依次尝试的公开行情节点（部分地区 api.binance.com 不可达，自动回退）
BINANCE_BASE_URLS = [
    u.strip()
    for u in os.getenv(
        "BINANCE_BASE_URLS",
        "https://api.binance.com,https://api1.binance.com,https://data-api.binance.vision",
    ).split(",")
    if u.strip()
]
# K 线轮询间隔（秒）：每 5 分钟检查一次各交易对 5m K 线的 开/收/高/低 价
POLL_INTERVAL = float(os.getenv("POLL_INTERVAL", "300"))
KLINE_INTERVAL = os.getenv("KLINE_INTERVAL", "5m")
# USDT 永续合约节点（fapi），用于与现货加权合成标准价；不可达时自动退化为纯现货价
FUTURES_BASE_URLS = [
    u.strip()
    for u in os.getenv("FUTURES_BASE_URLS", "https://fapi.binance.com").split(",")
    if u.strip()
]

# ---------- 饭碗告警 ----------
# 饭碗告警 webhook 地址，必须在 backend/.env 中配置（未配置时告警发送会标记为失败）
FWALERT_WEBHOOK = os.getenv("FWALERT_WEBHOOK", "")

# ---------- TradingView 告警转发 ----------
# TV webhook 的鉴权令牌：公网入口，URL 即凭证。未配置时自动生成并持久化。
def _load_tv_token() -> str:
    token = os.getenv("TV_WEBHOOK_TOKEN", "")
    if token:
        return token
    token_file = DATA_DIR / "tv_token.key"
    if token_file.exists():
        return token_file.read_text(encoding="utf-8").strip()
    token = secrets.token_urlsafe(24)
    token_file.write_text(token, encoding="utf-8")
    return token

TV_WEBHOOK_TOKEN = _load_tv_token()
# TV 转发入口限流：单 IP 每窗口最多转发次数 / 窗口秒数（防止被刷导致饭碗告警配额耗尽）
TV_RATE_LIMIT = int(os.getenv("TV_RATE_LIMIT", "60"))
TV_RATE_WINDOW = int(os.getenv("TV_RATE_WINDOW", "3600"))

# ---------- SEC 财报监听 ----------
# 监听窗口内的轮询间隔（秒）。轮询走的是 SEC 全市场申报 feed，每轮固定 2 个请求，与标的数量无关
SEC_POLL_INTERVAL = float(os.getenv("SEC_POLL_INTERVAL", "15"))
# 所有任务都在窗口外时的休眠间隔（秒）
SEC_IDLE_INTERVAL = float(os.getenv("SEC_IDLE_INTERVAL", "120"))
# SEC 公平使用政策上限为 10 req/s，所有请求共享该限额
SEC_MAX_RPS = float(os.getenv("SEC_MAX_RPS", "10"))
# SEC 公平使用政策要求请求携带可联系到的 User-Agent（建议改成自己的邮箱）
SEC_USER_AGENT = os.getenv("SEC_USER_AGENT", "price-alert admin@example.com")

DB_PATH = DATA_DIR / "app.db"
