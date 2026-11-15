"""SQLite 存储、空间管理、合并及每日备份。"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import threading
import time
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


TABLES = frozenset(
    {
        "review_word",
        "upgrade_entry",
        "upgrade_example",
        "self_check",
        "review_definition",
        "review_definition_example",
        "review_log",
        "review_event",
        "vocab_note",
        "vocab_example",
        "vocab_definition_en",
        "example_scene",
        "wordpack_pick",
        "daily_plan",
        "quick_note",
        "error_top",
        "error_batch",
        "error_item",
        "error_todo",
        "error_essay",
        "coach_essay",
        "coach_top_progress",
    }
)
APPEND_ONLY_TABLES = frozenset({"review_log", "review_event"})
MAX_PUSH_CHANGES = 2000
MAX_BODY_BYTES = 8 * 1024 * 1024
MAX_DATA_BYTES = 256 * 1024

_backup_lock = threading.Lock()


def db_path() -> Path:
    return Path(os.environ.get("SYNC_DB", "/opt/worddrip-sync/data/sync.db"))


def _connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    return connection


@contextmanager
def _connection() -> Iterator[sqlite3.Connection]:
    connection = _connect()
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize() -> None:
    with _connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS spaces (
                space_id TEXT PRIMARY KEY,
                secret_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                bytes INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS rows (
                space_id TEXT NOT NULL REFERENCES spaces(space_id) ON DELETE CASCADE,
                tbl TEXT NOT NULL,
                id TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                device_id TEXT NOT NULL,
                deleted INTEGER NOT NULL,
                data TEXT,
                seq INTEGER NOT NULL,
                PRIMARY KEY (space_id, tbl, id)
            );
            CREATE INDEX IF NOT EXISTS rows_space_seq ON rows(space_id, seq);
            CREATE TABLE IF NOT EXISTS meta (
                space_id TEXT PRIMARY KEY REFERENCES spaces(space_id) ON DELETE CASCADE,
                cursor INTEGER NOT NULL DEFAULT 0
            );
            """
        )


def _backup_before_write() -> None:
    initialize()
    source_path = db_path()
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    backup_dir = source_path.parent / "backups"
    backup_path = backup_dir / f"sync-{today}.db"
    with _backup_lock:
        if backup_path.exists():
            return
        backup_dir.mkdir(parents=True, exist_ok=True)
        source = sqlite3.connect(source_path, timeout=30)
        target = sqlite3.connect(backup_path)
        try:
            source.backup(target)
        finally:
            target.close()
            source.close()
        backups = sorted(backup_dir.glob("sync-????????.db"), reverse=True)
        for old_backup in backups[7:]:
            old_backup.unlink()


def _secret_hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _new_space_id(connection: sqlite3.Connection) -> str:
    while True:
        candidate = secrets.token_bytes(10)
        space_id = base64.b32encode(candidate).decode("ascii").rstrip("=").lower()
        if connection.execute("SELECT 1 FROM spaces WHERE space_id = ?", (space_id,)).fetchone() is None:
            return space_id


def max_spaces() -> int:
    return int(os.environ.get("SYNC_MAX_SPACES", "100"))


def space_capacity_available() -> bool:
    initialize()
    with _connection() as connection:
        count = connection.execute("SELECT COUNT(*) FROM spaces").fetchone()[0]
    return count < max_spaces()


def create_space() -> tuple[str, str] | None:
    _backup_before_write()
    secret = secrets.token_urlsafe(32)
    now = int(time.time() * 1000)
    with _connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        count = connection.execute("SELECT COUNT(*) FROM spaces").fetchone()[0]
        if count >= max_spaces():
            return None
        space_id = _new_space_id(connection)
        connection.execute(
            "INSERT INTO spaces(space_id, secret_hash, created_at, bytes) VALUES (?, ?, ?, 0)",
            (space_id, _secret_hash(secret), now),
        )
        connection.execute("INSERT INTO meta(space_id, cursor) VALUES (?, 0)", (space_id,))
    return space_id, secret


def verify_space(space_id: str, secret: str) -> bool:
    import hmac

    with _connection() as connection:
        row = connection.execute(
            "SELECT secret_hash FROM spaces WHERE space_id = ?", (space_id,)
        ).fetchone()
    actual = _secret_hash(secret)
    expected = row["secret_hash"] if row is not None else "0" * 64
    return hmac.compare_digest(expected, actual)


def delete_space(space_id: str) -> None:
    _backup_before_write()
    with _connection() as connection:
        connection.execute("DELETE FROM spaces WHERE space_id = ?", (space_id,))


def space_info(space_id: str) -> dict[str, int] | None:
    with _connection() as connection:
        row = connection.execute(
            "SELECT created_at, bytes FROM spaces WHERE space_id = ?", (space_id,)
        ).fetchone()
        if row is None:
            return None
        rows = connection.execute(
            "SELECT COUNT(*) FROM rows WHERE space_id = ?", (space_id,)
        ).fetchone()[0]
    quota_bytes = int(os.environ.get("SYNC_SPACE_QUOTA_MB", "50")) * 1024 * 1024
    return {
        "rows": rows,
        "bytes": row["bytes"],
        "quota_bytes": quota_bytes,
        "created_at": row["created_at"],
    }


def _row_bytes(
    tbl: str,
    row_id: str,
    updated_at: int,
    device_id: str,
    deleted: bool,
    data_json: str | None,
) -> int:
    payload = {
        "table": tbl,
        "id": row_id,
        "updated_at": updated_at,
        "device_id": device_id,
        "deleted": deleted,
        "data": json.loads(data_json) if data_json is not None else None,
    }
    return len(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8"))


class PushError(Exception):
    """带 HTTP 状态码的整批 push 错误。"""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def push(space_id: str, device_id: str, changes: list[dict[str, Any]]) -> dict[str, Any]:
    if len(changes) > MAX_PUSH_CHANGES:
        raise PushError(413, "一次最多同步 2000 条")
    _backup_before_write()
    accepted = 0
    ignored = 0
    quota_bytes = int(os.environ.get("SYNC_SPACE_QUOTA_MB", "50")) * 1024 * 1024
    with _connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        space = connection.execute(
            "SELECT bytes FROM spaces WHERE space_id = ?", (space_id,)
        ).fetchone()
        if space is None:
            raise PushError(401, "空间凭证无效")
        current_bytes = space["bytes"]
        cursor = connection.execute(
            "SELECT cursor FROM meta WHERE space_id = ?", (space_id,)
        ).fetchone()["cursor"]
        for change in changes:
            tbl = change["table"]
            if tbl not in TABLES:
                raise PushError(400, "不支持同步此数据表")
            data = change.get("data")
            data_json = json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False)
            if len(data_json.encode("utf-8")) > MAX_DATA_BYTES:
                raise PushError(413, "单条数据不能超过 256KB")
            row_id = change["id"]
            updated_at = change["updated_at"]
            deleted = change["deleted"]
            existing = connection.execute(
                "SELECT updated_at, device_id, deleted, data FROM rows WHERE space_id = ? AND tbl = ? AND id = ?",
                (space_id, tbl, row_id),
            ).fetchone()
            if existing is not None and tbl in APPEND_ONLY_TABLES:
                ignored += 1
                continue
            if existing is not None and (
                updated_at < existing["updated_at"]
                or (updated_at == existing["updated_at"] and device_id <= existing["device_id"])
            ):
                ignored += 1
                continue

            new_bytes = _row_bytes(tbl, row_id, updated_at, device_id, deleted, data_json)
            old_bytes = (
                _row_bytes(
                    tbl,
                    row_id,
                    existing["updated_at"],
                    existing["device_id"],
                    bool(existing["deleted"]),
                    existing["data"],
                )
                if existing is not None
                else 0
            )
            if current_bytes - old_bytes + new_bytes > quota_bytes:
                raise PushError(507, "同步空间已满")

            cursor += 1
            connection.execute(
                """INSERT INTO rows(space_id, tbl, id, updated_at, device_id, deleted, data, seq)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(space_id, tbl, id) DO UPDATE SET
                     updated_at=excluded.updated_at, device_id=excluded.device_id,
                     deleted=excluded.deleted, data=excluded.data, seq=excluded.seq""",
                (space_id, tbl, row_id, updated_at, device_id, int(deleted), data_json, cursor),
            )
            current_bytes = current_bytes - old_bytes + new_bytes
            accepted += 1

        connection.execute("UPDATE spaces SET bytes = ? WHERE space_id = ?", (current_bytes, space_id))
        connection.execute("UPDATE meta SET cursor = ? WHERE space_id = ?", (cursor, space_id))
    return {"ok": True, "accepted": accepted, "ignored": ignored, "cursor": cursor}


def pull(space_id: str, since: int, limit: int) -> dict[str, Any]:
    with _connection() as connection:
        rows = connection.execute(
            """SELECT seq, tbl, id, updated_at, deleted, device_id, data
               FROM rows WHERE space_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?""",
            (space_id, since, limit + 1),
        ).fetchall()
        cursor_row = connection.execute(
            "SELECT cursor FROM meta WHERE space_id = ?", (space_id,)
        ).fetchone()
    if cursor_row is None:
        raise PushError(401, "空间凭证无效")
    more = len(rows) > limit
    page = rows[:limit]
    changes = [
        {
            "seq": row["seq"],
            "table": row["tbl"],
            "id": row["id"],
            "updated_at": row["updated_at"],
            "deleted": bool(row["deleted"]),
            "device_id": row["device_id"],
            "data": json.loads(row["data"]) if row["data"] is not None else None,
        }
        for row in page
    ]
    return {"changes": changes, "cursor": changes[-1]["seq"] if changes else since, "more": more}


def backup_now() -> None:
    """供测试验证每日轮换；日常调用由写操作触发。"""
    _backup_before_write()
