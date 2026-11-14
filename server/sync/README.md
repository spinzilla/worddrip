# WordDrip 同步服务

这是单独运行的 FastAPI + SQLite 服务，不依赖或改动现有 vocab-notes。协议见 `docs/tasks/070-同步服务-服务器端.md`。本地只需 Python 3.12+：

```powershell
cd server/sync
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt -r requirements-dev.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
.\.venv\Scripts\python.exe -m pytest -q
$env:SYNC_APP_KEY = 'test-app-key'
$env:SYNC_DB = 'D:\tmp\es-sync\sync.db'
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8710
```

除 `/health` 外，每个请求都须带 `X-App-Key`。空间请求还须带 `Authorization: Bearer <space_id>.<space_secret>`。数据库启用 WAL；每个空间的容量按同步行完整 JSON 的 UTF-8 字节数计算。`SYNC_SPACE_QUOTA_MB` 默认 50，`SYNC_MAX_SPACES` 默认 100，`SYNC_DB` 默认 `/opt/worddrip-sync/data/sync.db`。

## 服务器部署（本项目不执行）

以下命令以 Ubuntu、已安装 Python 3.12 和 Nginx 为前提。部署前先确认 `vocab.uestceee.art` 的 HTTPS 配置位置：

```sh
sudo nginx -T
```

先把实际承载该域名的 Nginx 配置文件记下来。下面用 `<实际配置文件>` 代表该路径；备份到同目录，方便完整恢复。从本机终端上传无密钥源码文件和部署模板到服务器临时目录（`<SSH 用户>` 换成实际 SSH 用户）：

```sh
ssh <SSH 用户>@vocab.uestceee.art 'mkdir -p /tmp/worddrip-sync'
scp server/sync/app.py server/sync/store.py server/sync/requirements.txt server/sync/deploy/worddrip-sync.env.example server/sync/deploy/worddrip-sync.service server/sync/deploy/nginx-sync-location.conf <SSH 用户>@vocab.uestceee.art:/tmp/worddrip-sync/
```

不要复制 `.venv` 或本机数据库。

1. **创建专用用户与目录**（新增用户 `worddrip`；创建 `/opt/worddrip-sync/app`、`/opt/worddrip-sync/data`）：

   ```sh
   sudo useradd --system --home /opt/worddrip-sync --shell /usr/sbin/nologin worddrip
   sudo install -d -o root -g worddrip -m 0750 /opt/worddrip-sync/app
   sudo install -d -o worddrip -g worddrip -m 0750 /opt/worddrip-sync/data
   sudo chown -R root:worddrip /opt/worddrip-sync/app
   sudo chmod -R u=rwX,g=rX,o= /opt/worddrip-sync/app
   ```

   安装源码文件到 `/opt/worddrip-sync/app/`（root 所有，服务用户只读）：

   ```sh
   sudo install -o root -g worddrip -m 0640 /tmp/worddrip-sync/app.py /opt/worddrip-sync/app/app.py
   sudo install -o root -g worddrip -m 0640 /tmp/worddrip-sync/store.py /opt/worddrip-sync/app/store.py
   sudo install -o root -g worddrip -m 0640 /tmp/worddrip-sync/requirements.txt /opt/worddrip-sync/app/requirements.txt
   ```

2. **安装服务依赖**（在 `/opt/worddrip-sync/.venv` 创建虚拟环境）：

   ```sh
   sudo python3 -m venv /opt/worddrip-sync/.venv
   sudo /opt/worddrip-sync/.venv/bin/pip install -r /opt/worddrip-sync/app/requirements.txt
   ```

3. **配置环境文件**（新增 `/etc/worddrip-sync.env`，只允许服务用户读取）：

   ```sh
   sudo install -o root -g worddrip -m 0640 /tmp/worddrip-sync/worddrip-sync.env.example /etc/worddrip-sync.env
   python3 -c "import secrets;print(secrets.token_urlsafe(32))"
   sudoedit /etc/worddrip-sync.env
   ```

   把上一步生成的随机值填入 `SYNC_APP_KEY=`，并填入 `SYNC_DB=/opt/worddrip-sync/data/sync.db`、`SYNC_SPACE_QUOTA_MB=50`、`SYNC_MAX_SPACES=100`。不要把口令提交到 Git。

4. **安装并启动 systemd 服务**（新增 `/etc/systemd/system/worddrip-sync.service`）：

   ```sh
   sudo install -o root -g root -m 0644 /tmp/worddrip-sync/worddrip-sync.service /etc/systemd/system/worddrip-sync.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now worddrip-sync
   sudo systemctl status worddrip-sync --no-pager
   ```

5. **接入 Nginx**（先备份 `<实际配置文件>`；再把 `/tmp/worddrip-sync/nginx-sync-location.conf` 的 location 段放进对应的 HTTPS `server` 块）：

   ```sh
   sudo cp <实际配置文件> <实际配置文件>.before-worddrip-sync
   sudoedit <实际配置文件>
   sudo nginx -t
   sudo systemctl reload nginx
   ```

6. **验证**（健康检查不需要口令；其它请求需使用刚生成的口令）：

   ```sh
   curl -fsS https://vocab.uestceee.art/sync-api/health
   curl -i -H 'X-App-Key: <刚生成的口令>' -X POST https://vocab.uestceee.art/sync-api/spaces
   sudo journalctl -u worddrip-sync -n 50 --no-pager
   ```

   健康检查应返回 `{"ok":true}`，建空间应返回 `space_id` 和只在本次响应中出现的 `space_secret`。只在受信任设备保存空间密钥。

## 完整回退

按顺序执行；这会停止并移除同步服务及它的数据，但不碰 vocab-notes：

1. 停止并禁用服务（`worddrip-sync.service`）：

   ```sh
   sudo systemctl disable --now worddrip-sync
   ```

2. 恢复 Nginx 原文件（`<实际配置文件>`），校验并重载：

   ```sh
   sudo cp <实际配置文件>.before-worddrip-sync <实际配置文件>
   sudo nginx -t
   sudo systemctl reload nginx
   ```

3. 删除 systemd 单元和环境文件（`/etc/systemd/system/worddrip-sync.service`、`/etc/worddrip-sync.env`），然后刷新 systemd：

   ```sh
   sudo rm /etc/systemd/system/worddrip-sync.service /etc/worddrip-sync.env
   sudo systemctl daemon-reload
   ```

4. 删除服务程序、虚拟环境、数据库及备份（`/opt/worddrip-sync/`），最后删除专用用户：

   ```sh
   sudo rm -rf /opt/worddrip-sync
   sudo userdel worddrip
   ```

回退命令会永久删除同步空间和备份；执行前先确认确实要丢弃这些同步数据。本卡不连接或修改服务器。
