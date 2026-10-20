# 币安价格监控告警（price-alert）

单账号、可公网部署的交易监控告警网页。后端 FastAPI + SQLite，前端 React + TypeScript + Vite + Tailwind + shadcn/ui。

## 功能一览

1. **价格监控**：每 5 分钟拉取被监控交易对的 5 分钟 K 线，开 / 收 / 高 / 低 任一价格触及目标价（高于 / 低于）即通过饭碗告警 webhook 通知，只触发一次
2. **EMA 均线监控**：EMA21 / 55 / 100 / 200，周期 15m / 1h / 4h / 1d。每根对应周期 K 线**收盘**时检查：上穿、下穿、插针（影线触及）EMA 即告警
3. **SEC 财报监听**：指定监听日期 + 北京时间窗口监听 SEC EDGAR，标的（如 NVDA）发布 10-Q / 10-K（含修订版）时第一时间在页面弹窗并留存记录（含 SEC 原文链接），任务状态分色显示（未启动 / 监听中 / 已获取 / 监听失败）
4. **TradingView 告警转发**：公开 webhook 入口，接收 TradingView 告警后转发到饭碗告警，并逐条记录

**标准价说明**：价格类判定统一使用「现货与 USDT 永续合约按成交额（quoteVolume）加权的综合价」；某一边不存在或不可达时自动退化为只用另一边。

## 功能详情

### 登录与安全

- bcrypt 密码哈希、JWT HttpOnly + SameSite=Strict Cookie
- 登录失败递增延迟 + 单 IP 连续失败 5 次锁定 15 分钟（防爆破）
- 写操作 CSRF 自定义头校验、安全响应头、接口文档默认关闭

### 价格监控

- 监控三态：活跃 → 删除（软删除）；已触发 / 已删除 → 重新激活；已删除 → 再删除 = 彻底删除
- 触发判定：综合 K 线的 开/收/高/低 任一价满足方向条件即触发；同时检查「最近一根已收盘 K 线」和「正在走的 K 线」，窗口内瞬时插针也能捕获
- 触发即落库，绝不重复告警；webhook 失败重试 3 次并记录原因
- 同一交易对的监控自动分组展示，实时显示综合现价与目标价距离百分比

### EMA 均线监控

- EMA 基于综合价收盘价序列计算（拉取 500 根历史 K 线保证 EMA200 收敛）
- 只在对应周期出现新收盘 K 线时评估一次；服务重启后首轮只记录水位，不补发历史信号
- 触发后进入「已触发」，可重新激活等待下一次穿越

### SEC 财报监听

- 每个任务：一个或多个美股代码 + **监听日期** + 北京时间窗口（支持跨夜，如 20:00 – 次日 06:00）+ 监听类型（10-Q / 10-K / 8-K 业绩公告，可多选）；只在「日期 + 时间窗」内监听，窗口外完全休眠
- **8-K 业绩公告** = 含 Item 2.02 的 8-K（公司业绩发布稿，追涨最敏感的第一时间信号）；发现候选 8-K 后自动核对其索引页，非业绩公告不通知，且每只检查一次不会重复请求
- 任务状态实时推导并以颜色区分：未启动（灰）→ 监听中（蓝）→ 已获取（绿，显示捕获份数）/ 监听失败（红，窗口结束仍未捕获）
- 轮询走 SEC 全市场最新申报 feed：默认每 3 秒一轮、每轮每类型 1 个请求（按勾选类型，1~3 个）即覆盖窗口内所有标的，标的再多也不增加请求量；所有 SEC 请求共享 `SEC_MAX_RPS` 突发限速（默认 10 req/s，即 SEC 公平使用政策上限）
- 标的首次被监听时单独补一次该公司的 submissions 作为存量（不弹窗）；此后新发布的 10-Q / 10-K 立即弹窗并写入捕获记录
- 代码用 SEC 官方名录（company_tickers.json，缓存 24 小时）校验；`SEC_USER_AGENT` 建议改成自己的邮箱（SEC 要求）

### TradingView 转发

- 入口地址在网页「TradingView 转发」页可复制：`https://你的域名/api/tv-webhook/<token>`
- URL 中的 token 即凭证（自动生成并保存在 `backend/data/tv_token.key`，可用 `TV_WEBHOOK_TOKEN` 覆盖）
- 告警消息支持**纯文本**或 **JSON**；JSON 的每个键都会透传为饭碗告警模板变量
- 每条转发单独记录：时间、来源 IP、内容摘要、原始报文、送达结果；可在网页查看和删除
- 单 IP 限流（默认 60 次/小时），防止入口被刷耗尽饭碗告警配额

## 快速开始（本地开发）

需要 Node.js 20+ 和 Python 3.10+。

```bash
npm install
python -m venv .venv
# Windows: .venv/Scripts/python.exe -m pip install -r backend/requirements.txt
# Linux:   .venv/bin/pip install -r backend/requirements.txt
cp backend/.env.example backend/.env   # 编辑账号密码与 FWALERT_WEBHOOK
npm run dev                            # 前端 3000 + 后端 8787，/api 自动代理
```

## Ubuntu 服务器部署

以下以 Ubuntu 22.04+、部署目录 `/opt/price-alert` 为例。

### 1. 安装系统依赖

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip git
# Node.js 20（用于构建前端；若本地构建好 dist/ 再上传可跳过）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. 拉取代码并构建前端

```bash
sudo git clone https://github.com/你的用户名/price-alert.git /opt/price-alert
cd /opt/price-alert
npm install && npm run build     # 产物在 dist/，由后端直接托管
```

### 3. 配置 Python 环境

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
```

### 4. 配置 backend/.env

```bash
cp backend/.env.example backend/.env
.venv/bin/python -m backend.make_hash   # 交互式生成 ADMIN_PASSWORD_HASH，写入 backend/.env
nano backend/.env
```

必须检查/修改的项：

```ini
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=<上一步生成的哈希>
FWALERT_WEBHOOK=https://fwalert.com/你的-webhook-id   # 必填，否则告警发送失败
COOKIE_SECURE=true                                     # 配置 HTTPS 后务必打开
SEC_USER_AGENT=price-alert 你的邮箱                     # SEC 要求可联系的 UA
```

### 5. 启动

```bash
.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8787 --proxy-headers
```

打开 `http://服务器IP:8787` 能打开登录页即成功（生产环境务必按下节配置 HTTPS 后再对外开放）。

### 6. systemd 常驻

```ini
# /etc/systemd/system/price-alert.service
[Unit]
Description=Binance Price Alert
After=network.target

[Service]
WorkingDirectory=/opt/price-alert
ExecStart=/opt/price-alert/.venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8787 --proxy-headers
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now price-alert
sudo systemctl status price-alert     # 查看状态；日志用 journalctl -u price-alert -f
```

### 7. Nginx + HTTPS（公网必需，HTTP 明文暴露等于裸奔）

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;
    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    client_max_body_size 64k;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

证书用 `sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx` 免费签发即可。部署后访问 `https://你的域名`，在「TradingView 转发」页复制的 webhook 地址会自动带上域名，填进 TradingView 告警即可。

### 8. 无域名快速对外（仅自用，HTTP 明文）

没有域名时的简化方案：服务直接绑 80 端口对外。**代价是明文 HTTP**（登录密码在网络上传输不加密，且 TradingView webhook 需要 HTTPS、用不了），只适合临时自用，有域名后请切回方式 7。

```bash
# 服务改绑 0.0.0.0:80
sudo sed -i 's/--host 127.0.0.1 --port 8787/--host 0.0.0.0 --port 80/' /etc/systemd/system/price-alert.service
sudo systemctl daemon-reload && sudo systemctl restart price-alert
```

- 腾讯云控制台 → 安全组 → 入站规则添加 **TCP:80**（来源 0.0.0.0/0）
- `.env` 中 `COOKIE_SECURE` 保持 `false`
- 浏览器访问 `http://服务器IP`

### 日常更新

```bash
cd /opt/price-alert
git pull
npm install && npm run build           # 前端有变化时
.venv/bin/pip install -r backend/requirements.txt   # 依赖有变化时
sudo systemctl restart price-alert
```

> **git pull 不会覆盖你的配置**：`backend/.env`、`backend/data/`（数据库、JWT 密钥、TV webhook 令牌）都在 `.gitignore` 里，更新只动代码文件。唯一注意：不要在服务器上修改会被 git 跟踪的文件（如 README、源码），否则下次 pull 可能冲突。

### 常见问题（部署踩坑实录）

**npm 报一堆 `EBADENGINE` / build 失败**：系统 Node 太旧（Ubuntu 仓库自带 Node 12）。用第 1 步的 NodeSource 装 Node 20 后，删掉 `node_modules` 重装：`rm -rf node_modules && npm install && npm run build`。

**装 nodejs 报 `trying to overwrite '/usr/include/node/common.gypi'`**：老开发包冲突，先卸再装：

```bash
sudo apt remove -y libnode-dev libnode72 && sudo apt autoremove -y
sudo apt install -y nodejs
```

**`python3 -m venv` 报 ensurepip not available**：缺 venv 组件，`sudo apt install -y python3.10-venv python3-pip` 后删掉半截 `.venv` 重建。

**`npm install` 报 `EACCES: permission denied`**：目录属 root。把归属改回来即可，之后都不用 sudo 跑 npm：`sudo chown -R ubuntu:ubuntu /opt/price-alert`。

**服务起不来，日志 `address already in use`，绑 80 时尤其常见**：先看谁占的 `sudo ss -tlnp | grep :80`，通常是预装的 web 服务器。确认没用后停掉：

```bash
sudo systemctl stop caddy nginx apache2 2>/dev/null
sudo systemctl disable caddy nginx apache2 2>/dev/null
sudo systemctl restart price-alert
```

**安全组已放行但浏览器打不开**：① 先在本机（不是服务器）`curl -v http://服务器IP` 确认链路——能返回 200 就是服务器侧全通，问题在本地（见下条）；② 检查服务器防火墙 `sudo ufw status`，active 的话 `sudo ufw allow 80/tcp`；③ 核对安全组确实绑定在该实例上、规则方向是入站。

**curl 能通但浏览器「意外终止了连接」**：99% 是本地代理工具（Clash/v2ray 等）规则问题。给服务器 IP 加直连规则、显式输入 `http://` 前缀、或开无痕窗口（排除强制 HTTPS 类扩展）再试；用手机流量访问可快速定位是本地还是服务器问题。

## 配置项（backend/.env）

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD(_HASH)` | 唯一管理员账号 | admin / 必填 |
| `SECRET_KEY` | JWT 签名密钥 | 自动生成并持久化 |
| `COOKIE_SECURE` | HTTPS 下设 true | false |
| `TOKEN_TTL_HOURS` | 会话有效期（小时） | 12 |
| `LOGIN_MAX_FAILS` / `LOGIN_LOCK_MINUTES` | 防爆破阈值 / 锁定时长 | 5 / 15 |
| `POLL_INTERVAL` | K 线轮询间隔（秒） | 300 |
| `KLINE_INTERVAL` | K 线周期 | 5m |
| `BINANCE_BASE_URLS` | 现货行情节点，逗号分隔自动回退 | api / api1 / data-api |
| `FUTURES_BASE_URLS` | USDT 永续合约节点（加权综合价用） | fapi.binance.com |
| `FWALERT_WEBHOOK` | 饭碗告警 webhook 地址（必填，未配置时告警发送标记为失败） | 无 |
| `TV_WEBHOOK_TOKEN` | TradingView 入口令牌 | 自动生成并持久化 |
| `TV_RATE_LIMIT` / `TV_RATE_WINDOW` | TV 入口单 IP 限流：次数 / 窗口秒数 | 60 / 3600 |
| `SEC_POLL_INTERVAL` / `SEC_IDLE_INTERVAL` | SEC 财报监听：窗口内轮询 / 窗口外休眠间隔（秒） | 3 / 120 |
| `SEC_MAX_RPS` | SEC 请求共享的限速上限（SEC 公平使用政策为 10 req/s） | 10 |
| `SEC_USER_AGENT` | SEC 要求携带可联系的 UA，建议改成自己的邮箱 | price-alert admin@example.com |

## 饭碗告警模板占位符

饭碗告警会把 webhook JSON 请求体的键自动提取为模板变量，在规则的「通知简述 / 通知正文」中用 `{{键名}}` 引用。

**价格监控告警**发送的占位符：

| 占位符 | 内容 |
| --- | --- |
| `{{message}}` / `{{content}}` / `{{text}}` | 完整告警文案（三者相同，兼容不同模板习惯） |
| `{{brief}}` | 简短文案，如 `BTCUSDT 高于 100,000` |
| `{{symbol}}` | 交易对，如 `BTCUSDT` |
| `{{direction}}` | `above`（向上触及）/ `below`（向下触及） |
| `{{target}}` | 目标价 |
| `{{price}}` | 触发极值（above 取 K 线最高价，below 取最低价） |
| `{{open}}` / `{{high}}` / `{{low}}` / `{{close}}` | 触发 K 线的综合 开 / 高 / 低 / 收 |
| `{{spot_close}}` / `{{futures_close}}` | 触发 K 线的现货收盘价 / 合约收盘价（某边不存在时为空字符串） |
| `{{candle_time}}` | 触发 K 线时间（北京时间） |
| `{{interval}}` | K 线周期，默认 `5m` |
| `{{time}}` | 告警发送时间（北京时间） |

**EMA 均线告警**额外发送：`{{type}}`（`ema_cross`）、`{{kind}}`（上穿 / 下穿 / 插针）、`{{ema_period}}`、`{{ema}}`（EMA 值），`{{interval}}` 为监控配置的周期。

**TradingView 转发**发送的占位符：

| 占位符 | 内容 |
| --- | --- |
| `{{message}}` / `{{content}}` / `{{text}}` | `【TradingView】+ 告警摘要` |
| `{{brief}}` | 告警摘要（取 message/text/content/msg 键或 ticker+close） |
| `{{source}}` | 固定 `tradingview` |
| `{{time}}` | 转发时间（北京时间） |
| `{{raw}}` | TradingView 原始报文 |
| `{{ticker}}` `{{close}}` `{{exchange}}` `{{interval}}` 等 | 若 TV 告警消息是 JSON，其中所有标量键原样透传 |

推荐在 TradingView 告警消息里写 JSON 来使用 TV 自己的占位符，例如：

```json
{"ticker":"{{ticker}}","exchange":"{{exchange}}","interval":"{{interval}}","close":"{{close}}","time":"{{time}}","message":"我的策略信号：{{ticker}} 现价 {{close}}"}
```

TradingView 发送前会把 `{{...}}` 替换成实际值，本服务解析后原样透传给饭碗告警。

## 敏感信息说明（公开仓库前必读）

仓库中**不含**任何密钥。以下文件均被 `.gitignore` 排除，只存在于服务器/本地：

- `backend/.env`：账号密码哈希、饭碗告警 webhook 等全部配置
- `backend/data/`：SQLite 数据库、JWT 密钥（`secret.key`）、TV webhook 令牌（`tv_token.key`）
- `node_modules/`、`dist/`、`.venv/`：依赖与构建产物

请勿将上述文件提交到仓库。部署时在服务器上按上文步骤重新生成/填写。

## 项目结构

```
backend/            FastAPI 后端
  main.py           全部 HTTP 接口 + 静态托管
  poller.py         价格 / EMA 监控轮询与触发
  secpoller.py      SEC 财报监听轮询
  tvrelay.py        TradingView webhook 转发
  database.py       SQLite 存储层
  auth.py           登录 / JWT / CSRF
  config.py         环境变量配置
  make_hash.py      生成 ADMIN_PASSWORD_HASH
src/                React 前端
  pages/Dashboard.tsx
  components/       各功能页组件（价格 / EMA / SEC / TV）
scripts/dev.mjs     本地开发一键启动前后端
```

## 扩展新告警类型（长影线、底背离等）

1. `backend/database.py`：给 `monitors` 表加 `type` 取值（如 `long_shadow` / `divergence`）及对应参数列
2. `backend/poller.py`：轮询已按交易对拉取 K 线，调整 `limit` 即可拿到历史 K 线序列，新增判定函数，命中后复用现有 `_trigger()` 落库 + webhook 流程
3. 前端新建或扩展创建对话框，按类型渲染参数表单
