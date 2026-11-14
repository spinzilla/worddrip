from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient

import app as sync_app
import store


APP_KEY = "test-app-key"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SYNC_DB", str(tmp_path / "sync.db"))
    monkeypatch.setenv("SYNC_APP_KEY", APP_KEY)
    monkeypatch.setenv("SYNC_SPACE_QUOTA_MB", "50")
    monkeypatch.setenv("SYNC_MAX_SPACES", "100")
    sync_app.rate_limits = sync_app.RateLimits()
    store.initialize()
    with TestClient(sync_app.app, headers={"X-App-Key": APP_KEY}) as test_client:
        yield test_client


def create_space(client, ip="192.0.2.10"):
    response = client.post("/spaces", headers={"X-App-Key": APP_KEY, "X-Real-IP": ip})
    assert response.status_code == 200, response.text
    body = response.json()
    return body, {"Authorization": f"Bearer {body['space_id']}.{body['space_secret']}"}


def change(row_id="one", *, table="vocab_note", updated_at=1, deleted=False, data=None):
    return {
        "table": table,
        "id": row_id,
        "updated_at": updated_at,
        "deleted": deleted,
        "data": {"text": row_id} if data is None else data,
    }


def push(client, auth, changes, device_id="device-a"):
    return client.post("/push", headers=auth, json={"device_id": device_id, "changes": changes})


def test_health_and_app_key_missing_wrong_and_correct(client, monkeypatch):
    assert client.get("/health").json() == {"ok": True}
    monkeypatch.delenv("SYNC_APP_KEY")
    assert client.post("/spaces").status_code == 503
    monkeypatch.setenv("SYNC_APP_KEY", APP_KEY)
    assert client.post("/spaces", headers={"X-App-Key": "wrong"}).status_code == 401
    assert client.post("/spaces", headers={"X-App-Key": APP_KEY}).status_code == 200


def test_startup_initializes_database(tmp_path, monkeypatch):
    db_path = tmp_path / "new" / "sync.db"
    monkeypatch.setenv("SYNC_DB", str(db_path))
    monkeypatch.setenv("SYNC_APP_KEY", APP_KEY)
    with TestClient(sync_app.app):
        assert db_path.exists()
        with sqlite3.connect(db_path) as connection:
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"spaces", "rows", "meta"} <= tables


def test_missing_database_returns_401_then_spaces_recreates_it(tmp_path, monkeypatch):
    monkeypatch.setenv("SYNC_DB", str(tmp_path / "sync.db"))
    monkeypatch.setenv("SYNC_APP_KEY", APP_KEY)
    sync_app.rate_limits = sync_app.RateLimits()
    db_path = store.db_path()
    with TestClient(sync_app.app, headers={"X-App-Key": APP_KEY}) as client:
        _, auth = create_space(client)

    db_path.unlink()
    client = TestClient(sync_app.app, headers={"X-App-Key": APP_KEY})
    for method, path, kwargs in (
        ("get", "/space", {"headers": auth}),
        ("delete", "/space", {"headers": auth}),
        ("post", "/push", {"headers": auth, "json": {"device_id": "d", "changes": []}}),
        ("get", "/pull", {"headers": auth}),
    ):
        response = getattr(client, method)(path, **kwargs)
        assert response.status_code == 401, (method, path, response.text)
        assert response.json() == {"detail": "空间凭证无效"}

    response = client.post("/spaces", headers={"X-App-Key": APP_KEY, "X-Real-IP": "192.0.2.30"})
    assert response.status_code == 200, response.text
    assert db_path.exists()
    with sqlite3.connect(db_path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM spaces").fetchone()[0] == 1


def test_space_secret_is_returned_once_and_only_hash_is_stored(client):
    body, _ = create_space(client)
    with sqlite3.connect(store.db_path()) as connection:
        stored = connection.execute(
            "SELECT secret_hash FROM spaces WHERE space_id = ?", (body["space_id"],)
        ).fetchone()[0]
    assert stored != body["space_secret"]
    assert stored == store._secret_hash(body["space_secret"])
    assert body["space_secret"] not in stored


def test_bad_space_credential_is_401_and_indistinguishable(client):
    _, auth = create_space(client)
    good = client.get("/space", headers=auth)
    bad = client.get("/space", headers={"Authorization": auth["Authorization"] + "x"})
    missing = client.get("/space", headers={"Authorization": "Bearer unknown.wrong"})
    assert good.status_code == 200
    assert bad.status_code == missing.status_code == 401
    assert bad.json() == missing.json()


def test_spaces_isolate_same_row_id(client):
    _, auth_a = create_space(client)
    _, auth_b = create_space(client)
    assert push(client, auth_a, [change(data={"text": "A"})]).json()["accepted"] == 1
    assert push(client, auth_b, [change(data={"text": "B"})]).json()["accepted"] == 1
    assert client.get("/pull", headers=auth_a).json()["changes"][0]["data"] == {"text": "A"}
    assert client.get("/pull", headers=auth_b).json()["changes"][0]["data"] == {"text": "B"}


def test_delete_space_removes_all_rows(client):
    body, auth = create_space(client)
    push(client, auth, [change()])
    assert client.delete("/space", headers=auth).json() == {"ok": True}
    assert client.get("/space", headers=auth).status_code == 401
    with sqlite3.connect(store.db_path()) as connection:
        assert connection.execute("SELECT COUNT(*) FROM spaces").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM rows").fetchone()[0] == 0


def test_space_quota_rejects_entire_push(client, monkeypatch):
    monkeypatch.setenv("SYNC_SPACE_QUOTA_MB", "1")
    _, auth = create_space(client)
    changes = [change(str(index), data={"text": "x" * 230_000}) for index in range(5)]
    response = push(client, auth, changes)
    assert response.status_code == 507
    assert response.json()["detail"] == "同步空间已满"
    assert client.get("/pull", headers=auth).json()["changes"] == []


def test_space_rate_limit_is_60_requests_per_minute(client, monkeypatch):
    _, auth = create_space(client)
    monkeypatch.setattr(sync_app.time, "time", lambda: 1_800_000_000.0)
    responses = [client.get("/space", headers=auth) for _ in range(61)]
    assert [response.status_code for response in responses[:60]] == [200] * 60
    assert responses[60].status_code == 429


def test_ip_can_create_at_most_five_spaces_per_day(client):
    statuses = [
        client.post("/spaces", headers={"X-App-Key": APP_KEY, "X-Real-IP": "192.0.2.15"}).status_code
        for _ in range(6)
    ]
    assert statuses == [200, 200, 200, 200, 200, 429]


def test_space_count_limit_is_configurable(client, monkeypatch):
    monkeypatch.setenv("SYNC_MAX_SPACES", "1")
    create_space(client)
    response = client.post("/spaces", headers={"X-App-Key": APP_KEY, "X-Real-IP": "192.0.2.11"})
    assert response.status_code == 403
    assert response.json()["detail"] == "同步名额已满"


def test_full_space_quota_does_not_consume_daily_ip_create_limit(client, monkeypatch):
    monkeypatch.setenv("SYNC_MAX_SPACES", "1")
    _, owner_auth = create_space(client, ip="192.0.2.40")
    headers = {"X-App-Key": APP_KEY, "X-Real-IP": "192.0.2.41"}
    full_responses = [client.post("/spaces", headers=headers) for _ in range(5)]
    assert [response.status_code for response in full_responses] == [403] * 5

    assert client.delete("/space", headers=owner_auth).status_code == 200
    available = client.post("/spaces", headers=headers)
    assert available.status_code == 200, available.text


def test_push_pull_and_timestamp_device_id_merge(client):
    _, auth = create_space(client)
    first = push(client, auth, [change(updated_at=10, data={"value": 1})], "device-a").json()
    old = push(client, auth, [change(updated_at=9, data={"value": 0})], "device-z").json()
    tie_loser = push(client, auth, [change(updated_at=10, data={"value": 2})], "device-a").json()
    tie_winner = push(client, auth, [change(updated_at=10, data={"value": 3})], "device-z").json()
    newer = push(client, auth, [change(updated_at=11, data={"value": 4})], "device-a").json()
    assert first["accepted"] == 1
    assert old["ignored"] == tie_loser["ignored"] == 1
    assert tie_winner["accepted"] == newer["accepted"] == 1
    pulled = client.get("/pull", headers=auth).json()
    assert pulled["changes"][-1]["data"] == {"value": 4}
    assert pulled["changes"][-1]["device_id"] == "device-a"


@pytest.mark.parametrize("table", ["review_log", "review_event"])
def test_append_only_tables_are_not_overwritten(client, table):
    _, auth = create_space(client)
    assert push(client, auth, [change(table=table, data={"value": "first"})]).json()["accepted"] == 1
    result = push(client, auth, [change(table=table, updated_at=999, data={"value": "second"})]).json()
    assert result["ignored"] == 1
    assert client.get("/pull", headers=auth).json()["changes"][0]["data"] == {"value": "first"}


def test_tombstone_pulls_and_older_change_cannot_resurrect(client):
    _, auth = create_space(client)
    assert push(client, auth, [change(updated_at=20, deleted=True, data=None)]).json()["accepted"] == 1
    assert push(client, auth, [change(updated_at=19, deleted=False)]).json()["ignored"] == 1
    changes = client.get("/pull", headers=auth).json()["changes"]
    assert len(changes) == 1
    assert changes[0]["deleted"] is True


def test_unknown_table_is_rejected(client):
    _, auth = create_space(client)
    response = push(client, auth, [change(table="not_allowed")])
    assert response.status_code == 400


def test_oversized_push_and_data_are_413(client):
    _, auth = create_space(client)
    many = push(client, auth, [change(str(index)) for index in range(2001)])
    assert many.status_code == 413
    large_data = push(client, auth, [change(data={"text": "x" * (256 * 1024)})])
    assert large_data.status_code == 413
    too_large_body = client.post(
        "/push",
        headers={**auth, "Content-Type": "application/json"},
        content=b" " * (8 * 1024 * 1024 + 1),
    )
    assert too_large_body.status_code == 413


def test_push_failure_rolls_back_every_change(client):
    _, auth = create_space(client)
    with sqlite3.connect(store.db_path()) as connection:
        connection.execute(
            """CREATE TRIGGER fail_second BEFORE INSERT ON rows WHEN NEW.id = 'second'
               BEGIN SELECT RAISE(ABORT, 'test failure'); END"""
        )
    with TestClient(sync_app.app, raise_server_exceptions=False) as test_client:
        response = test_client.post(
            "/push",
            headers={"X-App-Key": APP_KEY, **auth},
            json={"device_id": "device-a", "changes": [change("first"), change("second")]},
        )
    assert response.status_code == 500
    assert client.get("/pull", headers=auth).json()["changes"] == []
    assert client.get("/space", headers=auth).json()["bytes"] == 0


def test_pull_pagination_cursor_and_more(client):
    _, auth = create_space(client)
    push(client, auth, [change(str(index)) for index in range(3)])
    first = client.get("/pull?since=0&limit=2", headers=auth).json()
    second = client.get(f"/pull?since={first['cursor']}&limit=2", headers=auth).json()
    assert [row["seq"] for row in first["changes"]] == [1, 2]
    assert first["cursor"] == 2 and first["more"] is True
    assert [row["seq"] for row in second["changes"]] == [3]
    assert second["cursor"] == 3 and second["more"] is False


def test_daily_backup_retains_only_seven_copies(client, tmp_path):
    backup_dir = tmp_path / "backups"
    backup_dir.mkdir()
    for day in range(1, 9):
        (backup_dir / f"sync-202601{day:02d}.db").write_bytes(b"old backup")
    store.backup_now()
    backups = sorted(backup_dir.glob("sync-????????.db"))
    assert len(backups) == 7
    assert all(path.stat().st_size > 0 for path in backups)


def test_pull_limit_is_validated(client):
    _, auth = create_space(client)
    assert client.get("/pull?limit=1001", headers=auth).status_code == 422
    assert client.get("/pull?since=-1", headers=auth).status_code == 422
