"""SEC EDGAR 财报（10-Q/10-K）监听

- 每个监听任务带一个北京时间窗口（支持跨夜），仅窗口内轮询 SEC，窗口外休眠
- 轮询走 SEC 全市场最新申报 feed（browse-edgar getcurrent）：每轮仅 2 个请求
  （10-Q、10-K 各一个，含 /A 修订版），即可覆盖窗口内所有标的，与标的数量无关
- 所有 SEC 请求共享一个令牌桶限速器（默认 10 req/s，SEC 公平使用政策上限）
- ticker -> CIK 映射取自 SEC 官方 company_tickers.json，缓存到本地 24 小时
- 标的首次被监听时单独补一次该公司 submissions，把存量 10-Q/10-K 记为 baseline（落库但不通知）
- 按 accession number 去重；发现新文件只落库，由前端轮询拉到后第一时间弹窗，不发外部 webhook
"""
import asyncio
import json
import logging
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

import httpx

from . import config, database

log = logging.getLogger("secpoller")

CN_TZ = timezone(timedelta(hours=8))

# 内存态：供 /api/sec/hits 一并返回给前端展示
sec_status: dict = {
    "ok": None,
    "error": "",
    "last_poll": None,
    "in_window": False,
    "active_tasks": 0,
    "watching": [],
}

_TICKER_MAP_TTL = 86400  # CIK 映射缓存 24 小时
_ticker_map: dict[str, int] = {}

_FEED_URL = (
    "https://www.sec.gov/cgi-bin/browse-edgar"
    "?action=getcurrent&CIK=&type={form}&company=&dateb=&owner=include&start=0&count=100&output=atom"
)
_FEED_FORMS = ("10-Q", "10-K")  # feed 的 type=10-Q 会同时返回 10-Q/A 修订版
_ATOM_NS = {"a": "http://www.w3.org/2005/Atom"}
_CIK_RE = re.compile(r"\((\d{10})\)")
_FILED_RE = re.compile(r"Filed:</b>\s*(\d{4}-\d{2}-\d{2})")


class RateLimiter:
    """全局限速：保证任意请求起点间隔 >= 1/rps 秒，所有 SEC 请求共享"""

    def __init__(self, rps: float):
        self._interval = 1.0 / max(rps, 0.1)
        self._lock = asyncio.Lock()
        self._next = 0.0

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            if self._next > now:
                await asyncio.sleep(self._next - now)
            self._next = max(time.monotonic(), self._next) + self._interval


_limiter = RateLimiter(config.SEC_MAX_RPS)


def in_window(window_start: str, window_end: str) -> bool:
    """当前北京时间是否处于 [start, end] 窗口内；start > end 视为跨夜窗口"""
    now = datetime.now(CN_TZ).time()
    s = _parse_hhmm(window_start)
    e = _parse_hhmm(window_end)
    if s is None or e is None:
        return False
    if s <= e:
        return s <= now <= e
    return now >= s or now <= e


def task_window(task: dict) -> tuple[datetime, datetime] | None:
    """任务的北京时间绝对起止时间。

    watch_date 为监听日期（YYYY-MM-DD），跨夜窗口自动顺延到次日；
    旧数据 watch_date 为空时退化为「今天」的周期窗口（仅兼容，新任务必带日期）。
    """
    s = _parse_hhmm(task["window_start"])
    e = _parse_hhmm(task["window_end"])
    if s is None or e is None:
        return None
    watch_date = (task.get("watch_date") or "").strip()
    if watch_date:
        try:
            base = datetime.strptime(watch_date, "%Y-%m-%d")
        except ValueError:
            return None
        base = base.replace(tzinfo=CN_TZ)
    else:
        now = datetime.now(CN_TZ)
        base = now.replace(hour=0, minute=0, second=0, microsecond=0)
    start = base.replace(hour=s.hour, minute=s.minute, second=0, microsecond=0)
    end = base.replace(hour=e.hour, minute=e.minute, second=0, microsecond=0)
    if end <= start:
        end += timedelta(days=1)
    return start, end


def in_task_window(task: dict) -> bool:
    """当前是否处于任务的（日期 + 时间窗）监听时段内"""
    window = task_window(task)
    if window is None:
        return False
    start, end = window
    return start <= datetime.now(CN_TZ) <= end


def task_status(task: dict, has_hit: bool) -> str:
    """任务状态：已获取 > 未启动 / 监听中 / 监听失败（由时间窗和命中情况实时推导）"""
    if has_hit:
        return "acquired"
    window = task_window(task)
    if window is None:
        return "failed"
    start, end = window
    now = datetime.now(CN_TZ)
    if now < start:
        return "pending"
    if now <= end:
        return "listening"
    return "failed"


def _parse_hhmm(value: str):
    try:
        h, m = value.split(":")
        return datetime.strptime(f"{int(h):02d}:{int(m):02d}", "%H:%M").time()
    except (ValueError, AttributeError):
        return None


async def get_ticker_map(client: httpx.AsyncClient | None = None) -> dict[str, int]:
    """ticker（大写）-> CIK 整数。内存 -> 本地缓存（24h）-> SEC 官网。"""
    if _ticker_map:
        return _ticker_map
    cache_file = config.DATA_DIR / "sec_tickers.json"
    if cache_file.exists():
        try:
            payload = json.loads(cache_file.read_text(encoding="utf-8"))
            if time.time() - payload.get("fetched_at", 0) < _TICKER_MAP_TTL:
                _ticker_map.update(payload["map"])
                return _ticker_map
        except Exception as e:  # noqa: BLE001 - 缓存损坏则重新下载
            log.warning("读取 ticker 缓存失败: %s", e)
    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(headers=_headers(), follow_redirects=True)
    try:
        resp = await _sec_get(client, "https://www.sec.gov/files/company_tickers.json", timeout=30)
        resp.raise_for_status()
        data = resp.json()
        mapping = {v["ticker"].upper(): int(v["cik_str"]) for v in data.values()}
        _ticker_map.update(mapping)
        try:
            cache_file.write_text(
                json.dumps({"fetched_at": time.time(), "map": mapping}), encoding="utf-8"
            )
        except OSError as e:
            log.warning("写入 ticker 缓存失败: %s", e)
        return _ticker_map
    finally:
        if own_client:
            await client.aclose()


def _headers() -> dict[str, str]:
    return {"User-Agent": config.SEC_USER_AGENT, "Accept-Encoding": "gzip, deflate"}


async def _sec_get(client: httpx.AsyncClient, url: str, **kwargs) -> httpx.Response:
    """所有 SEC 请求统一入口：先过共享限速器"""
    await _limiter.acquire()
    return await client.get(url, **kwargs)


async def _fetch_feed(client: httpx.AsyncClient, form_type: str) -> list[dict]:
    """拉取全市场某类型的最新申报 feed，一次请求覆盖所有公司"""
    resp = await _sec_get(client, _FEED_URL.format(form=form_type), timeout=15)
    resp.raise_for_status()
    root = ET.fromstring(resp.text)
    out = []
    for entry in root.findall("a:entry", _ATOM_NS):
        title = entry.findtext("a:title", "", _ATOM_NS)
        m = _CIK_RE.search(title)
        if not m:
            continue
        accession = (entry.findtext("a:id", "", _ATOM_NS).rsplit("=", 1) or [""])[-1]
        if not accession:
            continue
        summary = entry.findtext("a:summary", "", _ATOM_NS)
        fm = _FILED_RE.search(summary)
        filing_date = fm.group(1) if fm else entry.findtext("a:updated", "", _ATOM_NS)[:10]
        link_el = entry.find("a:link", _ATOM_NS)
        out.append(
            {
                "cik": int(m.group(1)),
                "form": entry.find("a:category", _ATOM_NS).get("term", form_type),  # type: ignore[union-attr]
                "filing_date": filing_date,
                "accession": accession,
                "primary_doc": "",
                "url": link_el.get("href", "") if link_el is not None else "",
            }
        )
    return out


async def _fetch_filings(client: httpx.AsyncClient, cik: int) -> list[dict]:
    """拉取某公司近期申报（仅用于标的首次监听时的存量回填），返回 10-Q/10-K 类条目"""
    resp = await _sec_get(
        client, f"https://data.sec.gov/submissions/CIK{cik:010d}.json", timeout=15
    )
    resp.raise_for_status()
    recent = resp.json().get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    out = []
    for i, form in enumerate(forms):
        if not (form.startswith("10-Q") or form.startswith("10-K")):
            continue
        accession = recent["accessionNumber"][i]
        primary_doc = (recent.get("primaryDocument") or [""] * len(forms))[i]
        url = (
            f"https://www.sec.gov/Archives/edgar/data/{cik}/{accession.replace('-', '')}/{primary_doc}"
            if primary_doc
            else ""
        )
        out.append(
            {
                "cik": cik,
                "form": form,
                "filing_date": recent["filingDate"][i],
                "accession": accession,
                "primary_doc": primary_doc,
                "url": url,
            }
        )
    return out


def _record_hit(task: dict, ticker: str, f: dict, known: set[str]) -> None:
    """落库一条命中；filing_date 早于任务创建日（UTC）的记为 baseline 不通知"""
    if f["accession"] in known:
        return
    baseline = f["filing_date"] < task["created_at"][:10]
    inserted = database.add_sec_hit(
        task_id=task["id"],
        ticker=ticker,
        form=f["form"],
        filing_date=f["filing_date"],
        accession=f["accession"],
        primary_doc=f["primary_doc"],
        url=f["url"],
        baseline=baseline,
    )
    if inserted:
        known.add(f["accession"])
        if baseline:
            log.info("SEC 存量记录 %s %s (%s)", ticker, f["form"], f["filing_date"])
        else:
            log.info("SEC 新财报命中 %s %s (%s)", ticker, f["form"], f["filing_date"])


async def _poll_round(client: httpx.AsyncClient, tasks: list[dict]) -> list[str]:
    """对窗口内的任务执行一轮抓取，返回本轮错误信息列表"""
    tmap = await get_ticker_map(client)
    tickers = sorted({tk for t in tasks for tk in t["tickers"]})
    known = database.known_accessions(tickers)
    errors: list[str] = []

    # cik -> 关心它的 (task, ticker) 列表
    watch: dict[int, list[tuple[dict, str]]] = {}
    for task in tasks:
        for ticker in task["tickers"]:
            cik = tmap.get(ticker)
            if cik is None:
                errors.append(f"{ticker} 无法识别的代码")
                continue
            watch.setdefault(cik, []).append((task, ticker))

    # 首次监听的标的：单独补一次该公司 submissions，把存量财报记为 baseline
    for cik, pairs in watch.items():
        ticker = pairs[0][1]
        if database.ticker_has_hits(ticker):
            continue
        try:
            filings = await _fetch_filings(client, cik)
        except Exception as e:  # noqa: BLE001 - 单 ticker 失败不影响其他
            errors.append(f"{ticker}: {str(e)[:100]}")
            continue
        for task, tk in pairs:
            for f in filings:
                _record_hit(task, tk, f, known)

    # 全市场 feed：每类一个请求，覆盖所有标的
    for form_type in _FEED_FORMS:
        try:
            entries = await _fetch_feed(client, form_type)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{form_type} feed: {str(e)[:100]}")
            continue
        for f in entries:
            for task, ticker in watch.get(f["cik"], []):
                _record_hit(task, ticker, f, known)
    return errors


async def sec_poller_loop() -> None:
    """后台主循环：仅在有任务处于北京时间窗口内时轮询 EDGAR"""
    async with httpx.AsyncClient(headers=_headers(), follow_redirects=True) as client:
        while True:
            try:
                tasks = database.active_sec_tasks()
                due = [t for t in tasks if in_task_window(t)]
                sec_status.update(
                    active_tasks=len(tasks),
                    in_window=bool(due),
                    watching=sorted({tk for t in due for tk in t["tickers"]}),
                )
                if not due:
                    await asyncio.sleep(config.SEC_IDLE_INTERVAL)
                    continue
                errors = await _poll_round(client, due)
                sec_status.update(
                    ok=not errors,
                    error="; ".join(errors)[:300],
                    last_poll=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                )
                await asyncio.sleep(config.SEC_POLL_INTERVAL)
            except Exception as e:  # noqa: BLE001 - 轮询失败不让进程死
                sec_status.update(ok=False, error=str(e)[:300])
                log.error("SEC 轮询失败: %s", e)
                await asyncio.sleep(config.SEC_IDLE_INTERVAL)
