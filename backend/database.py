"""SQLite 存储层：监控项的增删改查与状态流转"""
import json
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any, Optional

from . import config

_lock = threading.Lock()
_conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
_conn.row_factory = sqlite3.Row
_conn.execute("PRAGMA journal_mode=WAL")

VALID_STATUS = ("active", "triggered", "deleted")


def init_db() -> None:
    with _lock, _conn:
        _conn.execute(
            """
            CREATE TABLE IF NOT EXISTS monitors (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol        TEXT    NOT NULL,
                type          TEXT    NOT NULL DEFAULT 'price'
                                      CHECK (type IN ('price','ema_cross')),
                direction     TEXT    NOT NULL CHECK (direction IN ('above','below')),
                target_price  REAL    NOT NULL,
                ema_period    INTEGER,
                interval      TEXT,
                note          TEXT    NOT NULL DEFAULT '',
                status        TEXT    NOT NULL DEFAULT 'active'
                                      CHECK (status IN ('active','triggered','deleted')),
                created_at    TEXT    NOT NULL,
                updated_at    TEXT    NOT NULL,
                triggered_at  TEXT,
                trigger_price REAL,
                webhook_ok    INTEGER,
                webhook_error TEXT
            )
            """
        )
        _conn.execute("CREATE INDEX IF NOT EXISTS idx_monitors_status ON monitors(status)")
        _conn.execute("CREATE INDEX IF NOT EXISTS idx_monitors_symbol ON monitors(symbol)")
        # 兼容旧库：补充告警类型相关列
        cols = {r["name"] for r in _conn.execute("PRAGMA table_info(monitors)")}
        if "type" not in cols:
            _conn.execute(
                "ALTER TABLE monitors ADD COLUMN type TEXT NOT NULL DEFAULT 'price'"
                " CHECK (type IN ('price','ema_cross'))"
            )
        if "ema_period" not in cols:
            _conn.execute("ALTER TABLE monitors ADD COLUMN ema_period INTEGER")
        if "interval" not in cols:
            _conn.execute("ALTER TABLE monitors ADD COLUMN interval TEXT")
        _conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tv_forwards (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                received_at  TEXT    NOT NULL,
                source_ip    TEXT    NOT NULL DEFAULT '',
                content_type TEXT    NOT NULL DEFAULT '',
                raw_body     TEXT    NOT NULL DEFAULT '',
                summary      TEXT    NOT NULL DEFAULT '',
                forward_ok   INTEGER,
                forward_error TEXT   NOT NULL DEFAULT ''
            )
            """
        )
        _conn.execute("CREATE INDEX IF NOT EXISTS idx_tv_forwards_time ON tv_forwards(received_at)")
        _conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sec_tasks (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                tickers      TEXT    NOT NULL,
                watch_date   TEXT    NOT NULL,
                window_start TEXT    NOT NULL,
                window_end   TEXT    NOT NULL,
                note         TEXT    NOT NULL DEFAULT '',
                status       TEXT    NOT NULL DEFAULT 'active'
                                     CHECK (status IN ('active','deleted')),
                created_at   TEXT    NOT NULL,
                updated_at   TEXT    NOT NULL
            )
            """
        )
        # 兼容旧库：sec_tasks 增加监听日期列与监听类型列（必须放在建表之后）
        cols_sec = {r["name"] for r in _conn.execute("PRAGMA table_info(sec_tasks)")}
        if "watch_date" not in cols_sec:
            _conn.execute("ALTER TABLE sec_tasks ADD COLUMN watch_date TEXT")
        if "forms" not in cols_sec:
            _conn.execute("ALTER TABLE sec_tasks ADD COLUMN forms TEXT")
        _conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sec_hits (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id     INTEGER NOT NULL,
                ticker      TEXT    NOT NULL,
                form        TEXT    NOT NULL,
                filing_date TEXT    NOT NULL,
                accession   TEXT    NOT NULL UNIQUE,
                primary_doc TEXT    NOT NULL DEFAULT '',
                url         TEXT    NOT NULL DEFAULT '',
                baseline    INTEGER NOT NULL DEFAULT 0,
                detected_at TEXT    NOT NULL
            )
            """
        )
        _conn.execute("CREATE INDEX IF NOT EXISTS idx_sec_hits_time ON sec_hits(detected_at)")
        # 兼容旧库：财报记录增加已阅时间（NULL = 未读，用于侧边栏角标计数）
        cols_hits = {r["name"] for r in _conn.execute("PRAGMA table_info(sec_hits)")}
        if "read_at" not in cols_hits:
            _conn.execute("ALTER TABLE sec_hits ADD COLUMN read_at TEXT")
        # 已检查过的申报去重表：8-K 非业绩公告只检查一次，避免每轮重复请求
        _conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sec_seen (
                accession TEXT    PRIMARY KEY,
                ticker    TEXT    NOT NULL,
                form      TEXT    NOT NULL,
                is_hit    INTEGER NOT NULL DEFAULT 0,
                earnings  INTEGER NOT NULL DEFAULT 0,
                seen_at   TEXT    NOT NULL
            )
            """
        )
        _conn.execute("CREATE INDEX IF NOT EXISTS idx_sec_seen_ticker ON sec_seen(ticker)")
        # 应用级键值状态（如：价格监控「已触发」的已读水位）
        _conn.execute(
            "CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return dict(row)


def list_monitors() -> list[dict[str, Any]]:
    with _lock:
        rows = _conn.execute(
            "SELECT * FROM monitors ORDER BY symbol, created_at DESC"
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_monitor(monitor_id: int) -> Optional[dict[str, Any]]:
    with _lock:
        row = _conn.execute("SELECT * FROM monitors WHERE id=?", (monitor_id,)).fetchone()
    return _row_to_dict(row) if row else None


def create_monitor(
    symbol: str,
    direction: str,
    target_price: float,
    note: str,
    type: str = "price",
    ema_period: int | None = None,
    interval: str | None = None,
) -> dict[str, Any]:
    now = _now()
    with _lock, _conn:
        cur = _conn.execute(
            """INSERT INTO monitors
               (symbol, type, direction, target_price, ema_period, interval, note, status, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?, 'active', ?, ?)""",
            (symbol.upper(), type, direction, target_price, ema_period, interval, note, now, now),
        )
        monitor_id = cur.lastrowid
    return get_monitor(monitor_id)  # type: ignore[return-value]


def update_monitor(
    monitor_id: int,
    symbol: str,
    direction: str,
    target_price: float,
    ema_period: int | None,
    interval: str | None,
    note: str,
) -> bool:
    """仅活跃监控可编辑；触发/删除状态请先重新激活"""
    with _lock, _conn:
        cur = _conn.execute(
            """UPDATE monitors
               SET symbol=?, direction=?, target_price=?, ema_period=?, interval=?, note=?, updated_at=?
               WHERE id=? AND status='active'""",
            (symbol.upper(), direction, target_price, ema_period, interval, note, _now(), monitor_id),
        )
        return cur.rowcount > 0


def soft_or_hard_delete(monitor_id: int) -> str:
    """active/triggered -> deleted；deleted -> 物理删除。返回 'deleted' | 'purged' | 'missing'"""
    with _lock, _conn:
        row = _conn.execute("SELECT status FROM monitors WHERE id=?", (monitor_id,)).fetchone()
        if row is None:
            return "missing"
        if row["status"] == "deleted":
            _conn.execute("DELETE FROM monitors WHERE id=?", (monitor_id,))
            return "purged"
        _conn.execute(
            "UPDATE monitors SET status='deleted', updated_at=? WHERE id=?",
            (_now(), monitor_id),
        )
        return "deleted"


def restore_monitor(monitor_id: int) -> bool:
    """triggered/deleted -> active（重新激活后触发记录清空）"""
    with _lock, _conn:
        cur = _conn.execute(
            """UPDATE monitors
               SET status='active', updated_at=?, triggered_at=NULL,
                   trigger_price=NULL, webhook_ok=NULL, webhook_error=NULL
               WHERE id=? AND status IN ('triggered','deleted')""",
            (_now(), monitor_id),
        )
        return cur.rowcount > 0


def active_monitors() -> list[dict[str, Any]]:
    with _lock:
        rows = _conn.execute("SELECT * FROM monitors WHERE status='active'").fetchall()
    return [_row_to_dict(r) for r in rows]


def mark_triggered(monitor_id: int, trigger_price: float) -> None:
    with _lock, _conn:
        _conn.execute(
            """UPDATE monitors
               SET status='triggered', triggered_at=?, trigger_price=?, updated_at=?
               WHERE id=? AND status='active'""",
            (_now(), trigger_price, _now(), monitor_id),
        )


def set_webhook_result(monitor_id: int, ok: bool, error: str = "") -> None:
    with _lock, _conn:
        _conn.execute(
            "UPDATE monitors SET webhook_ok=?, webhook_error=? WHERE id=?",
            (1 if ok else 0, error[:500], monitor_id),
        )


def monitored_symbols() -> list[str]:
    with _lock:
        rows = _conn.execute(
            "SELECT DISTINCT symbol FROM monitors WHERE status != 'deleted'"
        ).fetchall()
    return [r["symbol"] for r in rows]


# ---------------- TradingView 转发记录 ----------------

def add_tv_forward(source_ip: str, content_type: str, raw_body: str, summary: str) -> int:
    with _lock, _conn:
        cur = _conn.execute(
            """INSERT INTO tv_forwards (received_at, source_ip, content_type, raw_body, summary)
               VALUES (?,?,?,?,?)""",
            (_now(), source_ip, content_type, raw_body[:4000], summary[:500]),
        )
        return cur.lastrowid  # type: ignore[return-value]


def set_tv_forward_result(record_id: int, ok: bool, error: str = "") -> None:
    with _lock, _conn:
        _conn.execute(
            "UPDATE tv_forwards SET forward_ok=?, forward_error=? WHERE id=?",
            (1 if ok else 0, error[:500], record_id),
        )


def list_tv_forwards(limit: int = 200) -> list[dict[str, Any]]:
    with _lock:
        rows = _conn.execute(
            "SELECT * FROM tv_forwards ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def delete_tv_forward(record_id: int) -> bool:
    with _lock, _conn:
        cur = _conn.execute("DELETE FROM tv_forwards WHERE id=?", (record_id,))
        return cur.rowcount > 0


# ---------------- SEC 财报监听 ----------------

def _sec_task_row(row: sqlite3.Row) -> dict[str, Any]:
    d = dict(row)
    d["tickers"] = json.loads(d["tickers"])
    # 旧任务无监听类型列（或只勾了已下线的 10-Q/10-K）时按 8-K 兼容
    d["forms"] = json.loads(d["forms"]) if d.get("forms") else ["8-K"]
    return d


def create_sec_task(
    tickers: list[str],
    watch_date: str,
    window_start: str,
    window_end: str,
    note: str,
    forms: list[str],
) -> dict[str, Any]:
    now = _now()
    with _lock, _conn:
        cur = _conn.execute(
            """INSERT INTO sec_tasks (tickers, watch_date, window_start, window_end, note, forms, status, created_at, updated_at)
               VALUES (?,?,?,?,?,?, 'active', ?, ?)""",
            (json.dumps(tickers), watch_date, window_start, window_end, note,
             json.dumps(forms), now, now),
        )
        task_id = cur.lastrowid
    return get_sec_task(task_id)  # type: ignore[return-value]


def get_sec_task(task_id: int) -> Optional[dict[str, Any]]:
    with _lock:
        row = _conn.execute("SELECT * FROM sec_tasks WHERE id=?", (task_id,)).fetchone()
    return _sec_task_row(row) if row else None


def list_sec_tasks() -> list[dict[str, Any]]:
    with _lock:
        rows = _conn.execute(
            "SELECT * FROM sec_tasks WHERE status != 'deleted' ORDER BY created_at DESC"
        ).fetchall()
    return [_sec_task_row(r) for r in rows]


def active_sec_tasks() -> list[dict[str, Any]]:
    with _lock:
        rows = _conn.execute("SELECT * FROM sec_tasks WHERE status='active'").fetchall()
    return [_sec_task_row(r) for r in rows]


def delete_sec_task(task_id: int) -> bool:
    with _lock, _conn:
        cur = _conn.execute(
            "UPDATE sec_tasks SET status='deleted', updated_at=? WHERE id=? AND status='active'",
            (_now(), task_id),
        )
        return cur.rowcount > 0


def update_sec_task(
    task_id: int,
    tickers: list[str],
    watch_date: str,
    window_start: str,
    window_end: str,
    note: str,
    forms: list[str],
) -> bool:
    with _lock, _conn:
        cur = _conn.execute(
            """UPDATE sec_tasks
               SET tickers=?, watch_date=?, window_start=?, window_end=?, note=?, forms=?, updated_at=?
               WHERE id=? AND status='active'""",
            (json.dumps(tickers), watch_date, window_start, window_end, note,
             json.dumps(forms), _now(), task_id),
        )
        return cur.rowcount > 0


# ---------------- SEC 申报去重（sec_seen） ----------------

def seen_accessions(tickers: list[str]) -> set[str]:
    """已检查过的申报（sec_seen + 历史 sec_hits 并集）"""
    if not tickers:
        return set()
    marks = ",".join("?" for _ in tickers)
    with _lock:
        rows = _conn.execute(
            f"SELECT accession FROM sec_seen WHERE ticker IN ({marks})", tickers
        ).fetchall()
        rows2 = _conn.execute(
            f"SELECT accession FROM sec_hits WHERE ticker IN ({marks})", tickers
        ).fetchall()
    return {r["accession"] for r in rows} | {r["accession"] for r in rows2}


def add_seen(accession: str, ticker: str, form: str, is_hit: bool, earnings: bool = False) -> bool:
    with _lock, _conn:
        cur = _conn.execute(
            """INSERT OR IGNORE INTO sec_seen (accession, ticker, form, is_hit, earnings, seen_at)
               VALUES (?,?,?,?,?,?)""",
            (accession, ticker, form, 1 if is_hit else 0, 1 if earnings else 0, _now()),
        )
        return cur.rowcount > 0


def mark_seen_hit(accession: str) -> None:
    with _lock, _conn:
        _conn.execute("UPDATE sec_seen SET is_hit=1 WHERE accession=?", (accession,))


def ticker_has_seen(ticker: str) -> bool:
    """该标的是否已有任何已检查记录（用于首次回填判定）"""
    with _lock:
        row = _conn.execute(
            "SELECT 1 FROM sec_seen WHERE ticker=? LIMIT 1", (ticker,)
        ).fetchone()
        if row is None:
            row = _conn.execute(
                "SELECT 1 FROM sec_hits WHERE ticker=? LIMIT 1", (ticker,)
            ).fetchone()
    return row is not None


def last_hit_id(accession: str) -> int | None:
    with _lock:
        row = _conn.execute(
            "SELECT id FROM sec_hits WHERE accession=?", (accession,)
        ).fetchone()
    return row["id"] if row else None


# ---------------- 应用级状态（app_state） ----------------

def get_state(key: str) -> Optional[str]:
    with _lock:
        row = _conn.execute("SELECT value FROM app_state WHERE key=?", (key,)).fetchone()
    return row["value"] if row else None


def set_state(key: str, value: str) -> None:
    with _lock, _conn:
        _conn.execute(
            "INSERT INTO app_state (key, value) VALUES (?,?)"
            " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


PRICE_TRIGGERED_READ_AT = "price_triggered_read_at"


def unread_triggered_count() -> int:
    """价格监控中未读的已触发数量；从未标记已读时统计全部已触发（首次查看「已触发」页后清零）"""
    read_at = get_state(PRICE_TRIGGERED_READ_AT) or ""
    with _lock:
        row = _conn.execute(
            """SELECT COUNT(*) AS n FROM monitors
               WHERE type='price' AND status='triggered' AND triggered_at > ?""",
            (read_at,),
        ).fetchone()
    return row["n"]


def known_accessions(tickers: list[str]) -> set[str]:
    if not tickers:
        return set()
    marks = ",".join("?" for _ in tickers)
    with _lock:
        rows = _conn.execute(
            f"SELECT accession FROM sec_hits WHERE ticker IN ({marks})", tickers
        ).fetchall()
    return {r["accession"] for r in rows}


def add_sec_hit(
    task_id: int,
    ticker: str,
    form: str,
    filing_date: str,
    accession: str,
    primary_doc: str,
    url: str,
    baseline: bool,
) -> bool:
    """按 accession 去重插入；已存在返回 False"""
    with _lock, _conn:
        cur = _conn.execute(
            """INSERT OR IGNORE INTO sec_hits
               (task_id, ticker, form, filing_date, accession, primary_doc, url, baseline, detected_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (task_id, ticker, form, filing_date, accession, primary_doc, url,
             1 if baseline else 0, _now()),
        )
        return cur.rowcount > 0


def list_sec_hits(limit: int = 100) -> list[dict[str, Any]]:
    with _lock:
        rows = _conn.execute(
            "SELECT * FROM sec_hits ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_sec_hit(hit_id: int) -> Optional[dict[str, Any]]:
    with _lock:
        row = _conn.execute("SELECT * FROM sec_hits WHERE id=?", (hit_id,)).fetchone()
    return _row_to_dict(row) if row else None


def mark_sec_hit_read(hit_id: int) -> bool:
    """把单条财报记录标为已阅（重复标记不改时间）"""
    with _lock, _conn:
        cur = _conn.execute(
            "UPDATE sec_hits SET read_at=? WHERE id=? AND read_at IS NULL",
            (_now(), hit_id),
        )
        return cur.rowcount > 0


def mark_all_sec_hits_read() -> int:
    """把所有「新捕获」（非存量 baseline）记录标为已阅，返回本次标记条数"""
    with _lock, _conn:
        cur = _conn.execute(
            "UPDATE sec_hits SET read_at=? WHERE baseline=0 AND read_at IS NULL",
            (_now(),),
        )
        return cur.rowcount


def unread_sec_hits_count() -> int:
    """未读的新财报条数（不含任务创建前的存量记录）"""
    with _lock:
        row = _conn.execute(
            "SELECT COUNT(*) AS n FROM sec_hits WHERE baseline=0 AND read_at IS NULL"
        ).fetchone()
    return row["n"]


def ticker_has_hits(ticker: str) -> bool:
    with _lock:
        row = _conn.execute(
            "SELECT 1 FROM sec_hits WHERE ticker=? LIMIT 1", (ticker,)
        ).fetchone()
    return row is not None


def sec_task_hit_counts() -> dict[int, int]:
    """每个任务捕获到的非存量（新发）财报数"""
    with _lock:
        rows = _conn.execute(
            "SELECT task_id, COUNT(*) AS n FROM sec_hits WHERE baseline=0 GROUP BY task_id"
        ).fetchall()
    return {r["task_id"]: r["n"] for r in rows}


def sec_task_hit_tickers() -> dict[int, set[str]]:
    """每个任务已捕获到（非存量）财报的标的集合，用于判断多标的是否全部命中"""
    with _lock:
        rows = _conn.execute(
            "SELECT task_id, ticker FROM sec_hits WHERE baseline=0 GROUP BY task_id, ticker"
        ).fetchall()
    out: dict[int, set[str]] = {}
    for r in rows:
        out.setdefault(r["task_id"], set()).add(r["ticker"])
    return out
