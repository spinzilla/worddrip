"""WordDrip 双端同步 HTTP 服务。"""

from __future__ import annotations

import hmac
import os
import sqlite3
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

import store


class Change(BaseModel):
    model_config = ConfigDict(extra="forbid")

    table: str
    id: str
    updated_at: int
    deleted: bool
    data: dict[str, Any] | None


class PushBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_id: str
    changes: list[Change]


class RateLimits:
    """单进程固定窗口计数器；本服务部署为单个 uvicorn worker。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._spaces: dict[tuple[str, int], int] = {}
        self._creates: dict[tuple[str, str], int] = {}

    def allow_space_request(self, space_id: str, now: float) -> bool:
        minute = int(now // 60)
        key = (space_id, minute)
        with self._lock:
            count = self._spaces.get(key, 0)
            if count >= 60:
                return False
            self._spaces[key] = count + 1
            self._spaces = {item: value for item, value in self._spaces.items() if item[1] >= minute - 1}
            return True

    def allow_create(self, ip: str, now: float) -> bool:
        day = datetime.fromtimestamp(now, timezone.utc).strftime("%Y%m%d")
        key = (ip, day)
        with self._lock:
            count = self._creates.get(key, 0)
            if count >= 5:
                return False
            self._creates[key] = count + 1
            self._creates = {item: value for item, value in self._creates.items() if item[1] == day}
            return True


rate_limits = RateLimits()


@asynccontextmanager
async def lifespan(application):
    store.initialize()
    yield


app = FastAPI(
    title="WordDrip Sync",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)


class RequestGuardMiddleware:
    """先校验应用口令，并在流式读取时限制请求体大小。"""

    def __init__(self, application):
        self.application = application

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.application(scope, receive, send)
            return

        headers = {key.decode("latin1").lower(): value.decode("latin1") for key, value in scope["headers"]}
        if scope.get("path") != "/health":
            configured = os.environ.get("SYNC_APP_KEY")
            if not configured:
                response = JSONResponse(status_code=503, content={"detail": "同步服务未配置"})
                await response(scope, receive, send)
                return
            supplied = headers.get("x-app-key")
            if supplied is None or not hmac.compare_digest(configured, supplied):
                response = JSONResponse(status_code=401, content={"detail": "应用口令无效"})
                await response(scope, receive, send)
                return

        content_length = headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > store.MAX_BODY_BYTES:
                    response = JSONResponse(status_code=413, content={"detail": "请求体不能超过 8MB"})
                    await response(scope, receive, send)
                    return
            except ValueError:
                response = JSONResponse(status_code=400, content={"detail": "请求体长度无效"})
                await response(scope, receive, send)
                return

        chunks = []
        total_bytes = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if message["type"] != "http.request":
                continue
            chunk = message.get("body", b"")
            total_bytes += len(chunk)
            if total_bytes > store.MAX_BODY_BYTES:
                response = JSONResponse(status_code=413, content={"detail": "请求体不能超过 8MB"})
                await response(scope, receive, send)
                return
            chunks.append(chunk)
            if not message.get("more_body", False):
                break

        body = b"".join(chunks)
        body_sent = False

        async def replay_receive():
            nonlocal body_sent
            if not body_sent:
                body_sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.application(scope, replay_receive, send)


app.add_middleware(RequestGuardMiddleware)


def _app_key(x_app_key: str | None) -> None:
    configured = os.environ.get("SYNC_APP_KEY")
    if not configured:
        raise HTTPException(status_code=503, detail="同步服务未配置")
    if x_app_key is None or not hmac.compare_digest(configured, x_app_key):
        raise HTTPException(status_code=401, detail="应用口令无效")


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-real-ip")
    if forwarded:
        return forwarded.strip()[:128]
    return request.client.host if request.client is not None else "unknown"


def _space_id(authorization: str | None) -> str:
    if authorization is None or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="空间凭证无效")
    credential = authorization[7:]
    space_id, separator, secret = credential.partition(".")
    if not separator or not space_id or not secret:
        raise HTTPException(status_code=401, detail="空间凭证无效")
    try:
        verified = store.verify_space(space_id, secret)
    except sqlite3.Error as error:
        raise HTTPException(status_code=401, detail="空间凭证无效") from error
    if not verified:
        raise HTTPException(status_code=401, detail="空间凭证无效")
    if not rate_limits.allow_space_request(space_id, time.time()):
        raise HTTPException(status_code=429, detail="同步请求过于频繁")
    return space_id


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/spaces")
def create_space(request: Request, x_app_key: str | None = Header(default=None)) -> dict[str, str]:
    _app_key(x_app_key)
    if not store.space_capacity_available():
        raise HTTPException(status_code=403, detail="同步名额已满")
    if not rate_limits.allow_create(_client_ip(request), time.time()):
        raise HTTPException(status_code=429, detail="此 IP 今日创建空间次数已达上限")
    created = store.create_space()
    if created is None:
        raise HTTPException(status_code=403, detail="同步名额已满")
    space_id, space_secret = created
    return {"space_id": space_id, "space_secret": space_secret}


@app.get("/space")
def get_space(authorization: str | None = Header(default=None)) -> dict[str, int]:
    space_id = _space_id(authorization)
    result = store.space_info(space_id)
    if result is None:
        raise HTTPException(status_code=401, detail="空间凭证无效")
    return result


@app.delete("/space")
def delete_space(authorization: str | None = Header(default=None)) -> dict[str, bool]:
    space_id = _space_id(authorization)
    store.delete_space(space_id)
    return {"ok": True}


@app.post("/push")
def push(body: PushBody, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    space_id = _space_id(authorization)
    try:
        return store.push(space_id, body.device_id, [change.model_dump() for change in body.changes])
    except store.PushError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from error


@app.get("/pull")
def pull(
    authorization: str | None = Header(default=None),
    since: int = Query(default=0, ge=0),
    limit: int = Query(default=1000, ge=1, le=1000),
) -> dict[str, Any]:
    space_id = _space_id(authorization)
    try:
        return store.pull(space_id, since, limit)
    except store.PushError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from error
