# 币安价格监控告警（price-alert）

单账号、可公网部署的交易监控告警网页。后端 FastAPI + SQLite，前端 React + TypeScript + Vite + Tailwind + shadcn/ui。

## 功能一览

1. **价格监控**：每 5 分钟拉取被监控交易对的 5 分钟 K 线，开 / 收 / 高 / 低 任一价格触及目标价（高于 / 低于）即通过饭碗告警 webhook 通知，只触发一次；左侧交易对导航可快速定位到已设监控的交易对
2. **EMA 均线监控**：EMA21 / 55 / 100 / 200，周期 15m / 1h / 4h / 1d。每根对应周期 K 线**收盘**时检查：上穿、下穿、插针（影线触及）EMA 即告警
3. **相关度计算**：指定交易对与 BTC 的对数收益率滚动 Pearson 相关系数，1h / 4h / 1d 三维度（固定窗口 24 / 30 / 14 根），K 线收盘更新；支持脱钩告警（|r| ≤ 阈值）与突变告警（|Δr| ≥ 阈值），每交易对 × 每周期独立阈值；每周期保留最近 100 个历史相关性点并绘制折线图；通知可选「网页+饭碗」或「仅网页」
4. **BTC 背离监控**：BTCUSDT 的 K 线（15m / 1h / 4h / 1d）与五种顶底背离检测——量价、RSI、OBV、MACD(DIF)、MACD 面积；候选背离保留旧实时逻辑（每 5 分钟、含正在走的 K 线），确认背离与参考网站算法一致（仅已收盘 K 线、右侧 2 根确认）；每条规则可选仅候选、仅确认或两者，默认任一已选背离即告警，主动设置数量阈值后才按组合告警；通知可选「网页+饭碗」或「仅网页」
5. **BTC 乖离率**：BTCUSDT 的 15m / 1h / 4h K 线与 MA20、BIAS20、成交量倍数及 RSI14 图表；结合负／正乖离方向、异常放量与 RSI 标记强信号和放量偏离，展示最近 600 根 K 线及历史识别记录；可选价格告警在已收盘 K 线满足乖离率识别且最低价 ≤ 自设触发价时触发，通知可选「网页+饭碗」或「仅网页」
6. **SEC 财报监听**：指定监听日期 + 北京时间窗口监听 SEC EDGAR，标的（如 NVDA）发布 8-K 业绩公告（含 Item 2.02，含修订版）时第一时间在页面弹窗并留存记录（含 SEC 原文链接）；多标的任务须**每只都捕获到**才算「已获取」，中途显示捕获进度（x/y 只），任务状态分色显示（未启动 / 监听中 / 已获取 / 监听失败）；捕获记录可逐条「已阅」，侧边栏角标只统计未读
7. **TV 告警转发**：公开 webhook 入口解析波段／趋势过滤器信号，按 15m / 1h / 4h / 1d 自然周期维护有效期；同一币种的多个周期与方向同时有效时触发自定义组合告警，提供接收历史、当前有效信号、组合配置与触发记录

**标准价说明**：价格类判定统一使用「合约优先」价格——该交易对有 USDT 永续合约就看合约价，没有合约才用现货价。交易对候选列表为现货 + 合约合并去重（合约含 `TRADIFI_PERPETUAL` 股票类永续，如 NVDAUSDT、NBISUSDT、AAPLUSDT），同名交易对只会出现一个。

## 功能详情

### 登录与安全

- bcrypt 密码哈希、JWT HttpOnly + SameSite=Strict Cookie
- 登录失败递增延迟 + 单 IP 连续失败 5 次锁定 15 分钟（防爆破）
- 写操作 CSRF 自定义头校验、安全响应头、接口文档默认关闭

### 价格监控

- 监控三态：活跃 → 删除（软删除）；已触发 / 已删除 → 重新激活；已删除 → 再删除 = 彻底删除
- 触发判定：K 线的 开/收/高/低 任一价满足方向条件即触发；同时检查「最近一根已收盘 K 线」和「正在走的 K 线」，窗口内瞬时插针也能捕获
- 触发即落库，绝不重复告警；webhook 失败重试 3 次并记录原因
- 同一交易对的监控自动分组展示，实时显示现价（合约优先）与目标价距离百分比
- 左侧「交易对导航」按交易对列出现有监控（含条数与行情状态点），点击平滑滚动到对应分组；滚动页面时导航自动高亮当前分组
- 交易对候选含 Binance 股票类永续合约（NVDAUSDT / NBISUSDT 等），与加密永续一样按 fapi K 线轮询

### EMA 均线监控

- EMA 基于合约优先的收盘价序列计算（拉取 500 根历史 K 线保证 EMA200 收敛）
- 只在对应周期出现新收盘 K 线时评估一次；服务重启后首轮只记录水位，不补发历史信号
- 触发后进入「已触发」，可重新激活等待下一次穿越

### 相关度计算（vs BTC）

- **算法**：对数收益率序列 `r_t = ln(P_t / P_{t-1})` 上的滚动 **Pearson 相关系数**（r ∈ [−1, 1]）。价格水平非平稳，直接对价格算相关性会得到伪相关，因此先转对数收益率；基准固定为 BTCUSDT，标的与基准同一价格口径（合约优先）
- **固定滚动窗口（不可调）**：**1h = 24 根**（约 1 天）、**4h = 30 根**（约 5 天）、**1d = 14 根**（约 2 周）；三个周期独立计算，互不影响
- **价格源（防插针，可选）**：`close` 收盘价（默认）、`oc2` (开盘价+收盘价)/2、`typical` 典型价 (高+低+收)/3。用均价而非单纯收盘价可削弱单根插针对相关性的扰动
- **只在 K 线收盘时更新**：正在走的 K 线不参与计算；两序列按 K 线开盘时间 inner join 对齐，任一方缺失的时段自动剔除（新上市/数据空洞安全）
- **历史折线图**：每周期保留**最近 100 个**相关性点；新建监控时立即计算并回填三周期历史（只写历史不补发告警），无需等待下一轮后台轮询，失败时后台自动重试；卡片内可切换 1h / 4h / 1d 查看折线，图上叠加 0 轴与脱钩阈值参考线
- **告警（每交易对 × 每周期独立阈值，留空 = 关闭）**：
  - **脱钩告警**：`|r| ≤ 阈值`（如 0.30）→ 联动性消失、走独立行情；进入脱钩状态时告警一次，`|r|` 回到阈值上方后自动恢复并重新武装
  - **突变告警**：`|r − 上一根 r| ≥ 阈值`（如 0.40）→ 相关性结构突变；同周期 **4 根 K 线冷却**，避免连续突变刷屏
- **通知方式可选**：「网页弹窗 + 饭碗告警」或「仅网页弹窗」；网页通知走 SSE 实时推送（含轮询兜底），告警记录支持逐条已阅 / 全部已阅，侧边栏角标统计未读
- 长横盘（任一方收益率为零方差）时该点无法定义相关系数，自动跳过不告警

### BTC 背离监控

- 标的固定 **BTCUSDT**（合约优先），周期 15m / 1h / 4h / 1d；候选与确认信号都每 5 分钟扫描一次，但使用不同的 K 线和算法口径
- **候选背离＝旧实时逻辑**：包含正在走的 K 线；摆动点左右各 3 根，比较「前一个已确认摆动点 + 其后当前即时极值」；量价比较拐点单根成交量，RSI / OBV / DIF 直接取拐点单根值，MACD 面积比较最近两段同向柱体区域。候选可能随行情形成或消失，是否触发告警由每条规则自行选择
- **确认背离＝参考网站口径**：排除正在走的 K 线；价格低点不高于左侧 5 根且严格低于右侧 2 根（高点反之），右侧第 2 根收盘时才确认；两个拐点必须间隔 **5～60 根**，避免过近毛刺和过远行情被误判为同一段结构
- **确认信号的五种口径**：
  - **RSI / OBV / MACD(DIF)**：指标取价格拐点前后各 2 根内的最低值（底）或最高值（顶）；顶 = 价格 HH + 指标 LH，底 = 价格 LL + 指标 HL。参数保持 Wilder RSI(14)、标准 OBV、MACD(12,26,9)
  - **量价**：比较两段走势各自的**累计成交量**，不是单根成交量；顶 = 价格更高且后一段量更少，底 = 价格更低且后一段量更少
  - **MACD 面积**：在拐点前后 2 根内定位最深的同号柱及其连续同号柱区域，只累计到拐点右侧第 2 根确认时；顶 = 价格更高且正柱面积更小，底 = 价格更低且负柱绝对面积更小。图中柱体使用 DIF−DEA，参考站显示为其 2 倍，只影响显示幅度，不影响面积背离比较结果
- 图表展示**最近 365 根 K 线**（另取 85 根用于指标预热），附成交量 + RSI + OBV + MACD 副图；滚轮及手机按钮可缩放 20～365 根，按住鼠标或触控点左右拖动可平移当前可见窗口。**实线＝当前确认，点线＝候选，浅色虚线＝历史确认**；当前候选／确认标签字号加大，顶背离红色、底背离绿色，所有信号无论是否触发告警都展示
- **任一背离或自定义组合告警**：可创建多条规则，每条自由指定背离种类子集、生效周期、方向、信号类型及通知方式。默认不设置数量阈值，同一方向下任意一种已选背离出现即触发；主动勾选「组合告警」并选择 N（2 / 3 / 4 / 5）后，当前同类信号种类数 ≥ N 才触发。信号类型可选「仅候选」「仅确认」「候选 + 确认」，候选与确认分别评估；已有数值阈值规则保持原行为
- **不自动生成告警规则**：系统只执行用户显式创建并保存的规则；从未配置、规则为空或配置无效时，仅检测背离并画图，不发送任何背离告警
- 候选条件持续满足时只告警一次，不再满足任一背离或数量阈值时自动重新武装；确认条件按「规则 × 周期 × 方向 × 确认时间戳」去重，连续不同的新信号不会被旧状态挡住；编辑规则后重置该规则状态，删除全部规则则暂停告警但继续检测和画图
- 告警记录包含规则名、候选／确认、币种、周期、方向、具体触发的背离种类与数值明细，支持已阅与未读角标；通知可选「网页弹窗 + 饭碗」或「仅网页弹窗」
- **饭碗／电话失败重试**：首次发送失败后每隔 2 分钟重试一次，最多重试 3 次（即最多发送 4 次）；重试在后台独立执行，不阻塞每 5 分钟的行情检测，每次结果和错误原因均写入告警记录。重试任务保存在进程内，服务重启不会补发中断的重试

### BTC 乖离率

- 标的固定 **BTCUSDT**（合约优先），提供 15m / 1h / 4h 三个独立周期，每 5 分钟刷新；展示**最近 600 根 K 线**及 MA20、BIAS20、成交量倍数、RSI14 副图。另取 100 根作为指标与历史量能预热
- **BIAS20**：`(收盘价 − 20 根收盘均线) / 20 根收盘均线 × 100%`。成交量倍数为「当前根成交量 ÷ 此前 20 根均量」，当前根不参与自己的基准；RSI 使用 Wilder RSI(14)
- **基础识别条件**：成交量倍数 ≥ 5；负乖离要求 BIAS20 < 0 且 RSI14 ≤ 50，正乖离要求 BIAS20 > 0 且 RSI14 ≥ 50。满足基础条件即标记「放量偏离」
- **强信号**：在基础条件上，15m / 1h / 4h 的 |BIAS20| 分别 ≥ 1.5% / 2.5% / 4%，且负向 RSI14 ≤ 30 或正向 RSI14 ≥ 70，标记「强负／正乖离」
- 当前正在走的 K 线可以显示，但**只对已收盘 K 线打标**；绿色表示负乖离，红色表示正乖离。识别记录显示时间、BIAS、量比和 RSI，点击记录可定位到对应 K 线并显示附近 40 根
- 图表支持滚轮及按钮缩放 40～600 根，按住鼠标或触控点左右拖动可平移当前可见窗口；启用价格告警后，主图会用红色虚线标出当前触发价
- **可选价格告警**：用户自行填写触发价格并显式开启，系统不自动配置。只有已收盘 K 线同时满足「存在放量偏离或强乖离信号」和「K 线最低价 ≤ 触发价格」才告警；15m / 1h / 4h 分别按 K 线时间戳去重
- 保存配置时以当前最新已收盘 K 线为水位，只判断之后的新收盘 K 线，**不回放 600 根历史信号**；每轮每周期最多判断最新一根，服务离线期间也不会批量补发
- 通知可选「网页弹窗 + 饭碗」或「仅网页弹窗」，默认仅网页；告警记录包含周期、信号强度、方向、最低价、触发价、BIAS、量比及 RSI，支持逐条已阅 / 全部已阅与未读角标
- 饭碗／电话首次发送失败后每 2 分钟重试，最多重试 3 次；重试不阻塞行情检测，服务重启不补发中断的重试

### 手机端展示

- 手机（小于 768px）使用顶部横向滚动功能导航，不再用桌面侧栏挤压内容；桌面端仍保留原 240px 左侧导航
- 卡片、标题栏、表单和长文本按小屏换行，减小手机端内边距；桌面端布局不变
- BTC 背离图提供手机专用「放大 / 缩小」按钮，信号密集时隐藏历史连线的文字标签，放大至 60 根以内后显示，避免文字重叠
- BTC 乖离率图同样提供「放大 / 缩小」按钮，告警配置和记录在小屏自动改为单列，避免文字与控件重叠

### SEC 财报监听

- 每个任务：一个或多个美股代码 + **监听日期** + 北京时间窗口（支持跨夜，如 20:00 – 次日 06:00）；只在「日期 + 时间窗」内监听，窗口外完全休眠
- **8-K 业绩公告** = 含 Item 2.02 的 8-K（公司业绩发布稿，追涨最敏感的第一时间信号）；发现候选 8-K 后自动核对其索引页，非业绩公告不通知，且每只检查一次不会重复请求；核对请求失败（网络抖动 / SEC 限流）不会标记为已检查，下一轮自动重试，不会因此漏报
- 任务状态实时推导并以颜色区分：未启动（灰）→ 监听中（蓝，部分命中时显示进度「已捕获 x/y 只」）→ 已获取（绿，**所有标的**都捕获到后才标记，显示总份数）/ 监听失败（红，窗口结束仍未全部捕获）
- 轮询走 SEC 全市场最新申报 feed：默认每 3 秒一轮、每轮 1 个请求即覆盖窗口内所有标的，标的再多也不增加请求量；所有 SEC 请求共享 `SEC_MAX_RPS` 突发限速（默认 10 req/s，即 SEC 公平使用政策上限）
- 标的首次被监听时单独补一次该公司的 submissions 作为存量（不弹窗）；此后新发布的 8-K 业绩公告立即弹窗并写入捕获记录
- 捕获记录可点「已阅」：该条变为灰色已读，左侧「SEC 财报监听」角标未读数 -1；未读记录保持琥珀色高亮，角标持续显示，也可一键「全部已阅」
- 代码用 SEC 官方名录（company_tickers.json，缓存 24 小时）校验；`SEC_USER_AGENT` 建议改成自己的邮箱（SEC 要求）
- 运行日志同时落盘到 `backend/data/app.log`（单文件 5MB、轮转 3 份）：进入 / 离开监听窗口、候选 8-K、业绩核对结果、轮询错误均有记录，排查漏报时直接取该文件

### TV 告警转发

- 入口地址在网页「TV 告警转发」页可复制：`https://你的域名/api/tv-webhook/<token>`；升级不改变原地址。URL 中的 token 即凭证（自动生成并保存在 `backend/data/tv_token.key`，可用 `TV_WEBHOOK_TOKEN` 覆盖）
- 接收两种约定纯文本，标题分别为 `【波段过滤器】` 与 `【趋势过滤器】`。正文必须包含：`币种：{{exchange}}:{{ticker}}`、`周期：{{interval}}`、`触发时间：{{timenow}}（UTC）`、`信号组：所有看涨信号` 或 `所有看跌信号`；网页提供完整模板
- 解析并保存过滤器、交易所、币种、周期、UTC 触发时间、信号方向与有效期。周期仅支持 **15m / 1h / 4h / 1d**；格式不符、占位符未替换或字段无效时仅记录原文和失败原因，不进入有效信号，也不再逐条直接转发饭碗
- **自然周期有效期**：从消息中的 UTC 触发时间开始，到下一个自然周期边界结束。例如 08:30 的 15m 信号有效至 08:45，08:40 的 4h 信号有效至 12:00；1d 按 UTC 日界计算。同一「币种 × 过滤器 × 周期 × 方向」重复到达时更新为最新记录
- 页面按「当前有效」「组合告警」「接收历史」排列三组选项卡，默认展示当前有效信号，标签不显示数量统计。有效信号到期自动移出；历史保留原始报文、解析结果和来源 IP，旧版记录升级后仍然保留
- **自定义组合**：每条规则针对同一币种，可添加多个条件，每项独立选择波段／趋势／任意过滤器、周期和看涨／看跌方向；全部条件同时处于有效窗口才触发。保存规则时不回放历史信号，系统不会自动创建规则
- 同一组合窗口只告警一次，重复消息不会反复通知；任一条件失效后重新武装，下一有效窗口再次满足时可再次告警。组合触发记录保存当时实际命中的信号及有效期
- 通知可选「网页弹窗 + 饭碗」或「仅网页弹窗」。饭碗首次失败后每 2 分钟重试，最多重试 3 次；重试不阻塞信号接收，服务重启不补发中断的重试
- 单 IP 限流（默认 60 次/小时），防止公开入口被刷

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

证书用 `sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx` 免费签发即可。部署后访问 `https://你的域名`，在「TV 告警转发」页复制的 webhook 地址会自动带上域名，填进 TradingView 告警即可。

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
| `FUTURES_BASE_URLS` | USDT 永续合约节点（合约优先价用） | fapi.binance.com |
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
| `{{open}}` / `{{high}}` / `{{low}}` / `{{close}}` | 触发 K 线的 开 / 高 / 低 / 收（合约优先，无合约用现货） |
| `{{spot_close}}` / `{{futures_close}}` | 触发 K 线的现货收盘价 / 合约收盘价（某边不存在时为空字符串） |
| `{{candle_time}}` | 触发 K 线时间（北京时间） |
| `{{interval}}` | K 线周期，默认 `5m` |
| `{{time}}` | 告警发送时间（北京时间） |

**EMA 均线告警**额外发送：`{{type}}`（`ema_cross`）、`{{kind}}`（上穿 / 下穿 / 插针）、`{{ema_period}}`、`{{ema}}`（EMA 值），`{{interval}}` 为监控配置的周期。

**相关度告警**发送的占位符：

| 占位符 | 内容 |
| --- | --- |
| `{{message}}` / `{{content}}` / `{{text}}` | 完整告警文案 |
| `{{brief}}` | 简短文案，如 `ETHUSDT 1h 与 BTC 脱钩` |
| `{{symbol}}` / `{{benchmark}}` | 标的交易对 / 基准（固定 BTCUSDT） |
| `{{type}}` | 固定 `correlation` |
| `{{kind}}` | `decorr`（脱钩）/ `shift`（突变） |
| `{{interval}}` / `{{window}}` | K 线周期 / 固定窗口根数（24 / 30 / 14） |
| `{{r}}` / `{{prev_r}}` | 当前相关性 / 上一根相关性（脱钩告警时 prev_r 可能为空） |
| `{{threshold}}` | 触发的阈值 |
| `{{price_source}}` | 价格源：`close` / `oc2` / `typical` |
| `{{candle_time}}` / `{{time}}` | 触发 K 线时间 / 告警发送时间（北京时间） |

**BTC 背离告警**发送的占位符：

| 占位符 | 内容 |
| --- | --- |
| `{{message}}` / `{{content}}` / `{{text}}` | 完整告警文案 |
| `{{brief}}` | 简短文案，如 `BTCUSDT 1h 顶背离×3` |
| `{{symbol}}` / `{{interval}}` | 固定 BTCUSDT / K 线周期 |
| `{{type}}` | 固定 `divergence` |
| `{{direction}}` | `top`（顶背离）/ `bottom`（底背离） |
| `{{signal_stage}}` | `candidate`（候选）/ `confirmed`（确认） |
| `{{rule_name}}` | 本次命中的自定义组合规则名称 |
| `{{kinds}}` / `{{kinds_cn}}` | 触发的背离种类（英文逗号分隔 / 中文顿号分隔） |
| `{{count}}` / `{{min_count}}` | 本次触发种类数 / 实际告警阈值；未选组合数量时 `min_count` 为 `1`，表示任一已选背离 |
| `{{time}}` | 检测时间（北京时间） |

**BTC 乖离率价格告警**发送的占位符：

| 占位符 | 内容 |
| --- | --- |
| `{{message}}` / `{{content}}` / `{{text}}` | 完整告警文案 |
| `{{brief}}` | 简短文案，如 `BTCUSDT 15m 强负乖离触及触发价` |
| `{{symbol}}` / `{{interval}}` | 固定 BTCUSDT / 15m、1h 或 4h |
| `{{type}}` | 固定 `bias` |
| `{{direction}}` / `{{strength}}` | `negative` / `positive`；`extreme` / `watch` |
| `{{bias}}` / `{{volume_ratio}}` / `{{rsi}}` | 触发 K 线的 BIAS20、量比与 RSI14 |
| `{{low}}` / `{{trigger_price}}` | K 线最低价 / 用户配置的触发价格 |
| `{{candle_time}}` / `{{time}}` | 触发 K 线时间 / 检测时间（均为北京时间） |

**TV 组合告警**发送的占位符：

| 占位符 | 内容 |
| --- | --- |
| `{{message}}` / `{{content}}` / `{{text}}` | 完整组合告警文案，含币种、全部条件与检测时间 |
| `{{brief}}` | 简短文案，如 `TV组合 BTCUSDT.P 4h + 15m 看跌共振` |
| `{{source}}` / `{{type}}` | 固定 `tradingview` / `tv_combo` |
| `{{rule_name}}` / `{{symbol}}` | 组合名称 / 触发币种 |
| `{{conditions}}` | 本次组合条件的中文描述 |
| `{{signals}}` | 实际命中的结构化信号 JSON，含 UTC 触发时间和有效期 |
| `{{time}}` | 组合检测时间（北京时间） |

饭碗只在组合触发时发送；原始 TV 消息不再逐条转发。

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
  corrpoller.py     相关度计算（vs BTC）轮询与告警
  divpoller.py      BTC 背离检测（量价/RSI/OBV/MACD/面积）与组合告警
  biaspoller.py     BTC 乖离率图表、最低价触发告警与通知重试
  secpoller.py      SEC 财报监听轮询
  tvrelay.py        TV 信号解析、周期有效性、组合告警与通知重试
  database.py       SQLite 存储层
  auth.py           登录 / JWT / CSRF
  config.py         环境变量配置
  make_hash.py      生成 ADMIN_PASSWORD_HASH
src/                React 前端
  pages/Dashboard.tsx
  components/       各功能页组件（价格 / EMA / SEC / TV）
scripts/dev.mjs     本地开发一键启动前后端
```

## 部署命令
cd /opt/price-alert && git pull && npm install && npm run build && sudo systemctl restart price-alert


## 扩展新告警类型（长影线、底背离等）

1. `backend/database.py`：给 `monitors` 表加 `type` 取值（如 `long_shadow` / `divergence`）及对应参数列
2. `backend/poller.py`：轮询已按交易对拉取 K 线，调整 `limit` 即可拿到历史 K 线序列，新增判定函数，命中后复用现有 `_trigger()` 落库 + webhook 流程
3. 前端新建或扩展创建对话框，按类型渲染参数表单
