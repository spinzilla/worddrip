// 071 联调：起本机同步服务（server/sync，临时库在 D:\tmp\es-sync\），再跑 Rust 的 sync_live 测试
// （两个独立磁盘词库 A、B + 空间 C，走真实的整库导出导入和真实 HTTP）。
//   node dev/sync-live.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
const root = path.resolve(app, '..', 'server', 'sync');
const port = 8712;
const dbFile = 'D:\\tmp\\es-sync\\live-071.db';
fs.mkdirSync('D:\\tmp\\es-sync', { recursive: true });
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });
const APP_KEY = 'test-app-key';
const server = spawn(path.join(root, '.venv', 'Scripts', 'python.exe'), ['-m', 'uvicorn', 'app:app', '--port', String(port)], {
  cwd: root, env: { ...process.env, SYNC_APP_KEY: APP_KEY, SYNC_DB: dbFile }, stdio: 'ignore',
});
let code = 1;
try {
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(url + '/health')).ok) break; } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 200));
  }
  const env = { ...process.env, SYNC_LIVE_URL: url, SYNC_LIVE_KEY: APP_KEY };
  delete env.CFLAGS;
  const r = spawnSync('cargo', ['test', '--lib', 'sync_live', '--', '--ignored', '--nocapture'], { cwd: path.join(app, 'src-tauri'), env, stdio: 'inherit', shell: true });
  code = r.status ?? 1;
} finally {
  server.kill();
}
process.exit(code);
