"""在真实本机 HTTP 端口跑一遍同步服务最小闭环。"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import uvicorn

os.environ.setdefault("SYNC_APP_KEY", "test-app-key")
os.environ.setdefault("SYNC_DB", r"D:\tmp\es-sync\sync.db")

import app as sync_app


async def main() -> None:
    ready = asyncio.Event()
    application_lifespan = sync_app.app.router.lifespan_context

    @asynccontextmanager
    async def mark_ready(application):
        async with application_lifespan(application):
            ready.set()
            yield

    sync_app.app.router.lifespan_context = mark_ready

    Path(os.environ["SYNC_DB"]).parent.mkdir(parents=True, exist_ok=True)
    server = uvicorn.Server(
        uvicorn.Config(sync_app.app, host="127.0.0.1", port=8710, log_level="warning")
    )
    server_task = asyncio.create_task(server.serve())
    try:
        await asyncio.wait_for(ready.wait(), timeout=15)
        async with httpx.AsyncClient(base_url="http://127.0.0.1:8710") as client:
            app_headers = {"X-App-Key": os.environ["SYNC_APP_KEY"]}
            credentials = None
            space_headers = None
            try:
                response = await client.get("/health")
                print("GET /health ->", response.status_code, response.text)

                response = await client.post("/spaces", headers=app_headers)
                print("POST /spaces ->", response.status_code, response.text)
                if response.status_code == 200:
                    credentials = response.json()
                    space_headers = {
                        **app_headers,
                        "Authorization": f"Bearer {credentials['space_id']}.{credentials['space_secret']}",
                    }
                response.raise_for_status()

                request = {
                    "device_id": "smoke-device",
                    "changes": [
                        {
                            "table": "vocab_note",
                            "id": "smoke-row",
                            "updated_at": 1794587637526,
                            "deleted": False,
                            "data": {"text": "本机联调测试"},
                        }
                    ],
                }
                response = await client.post("/push", headers=space_headers, json=request)
                print("POST /push", request, "->", response.status_code, response.text)
                response.raise_for_status()

                response = await client.get("/pull?since=0&limit=10", headers=space_headers)
                print("GET /pull ->", response.status_code, response.text)
                response.raise_for_status()
            finally:
                if credentials is not None and space_headers is not None:
                    response = await client.delete("/space", headers=space_headers)
                    print("清理本次空间 DELETE /space ->", response.status_code, response.text)
                    response.raise_for_status()
    finally:
        server.should_exit = True
        await server_task


if __name__ == "__main__":
    asyncio.run(main())
