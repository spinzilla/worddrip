// 083 更新前同步真实窗口：加入同步后点「现在更新」先推送；同步地址连不上时弹「仍要安装吗」。
// 前置：node app/dev/release.mjs build --allow-dirty 打出更高版本（例如 0.11.99）到 D:\tmp\es-release\<版本>（测试完 bump 回去，不要 upload）。
//   node dev/e2e/update-083.mjs 0.11.99
// 同步服务器：本机起 server/sync（临时库在 D:\tmp\es-sync\），中间放一个加 CORS 头并记录请求的转发。
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './cdp.mjs';
import { start, stop } from './launch.mjs';
import { serveRelease } from '../update-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..', 'server', 'sync');
const PORT = 8723, PROXY_PORT = 8724;
const SERVER = `http://127.0.0.1:${PORT}`;
const URL = `http://127.0.0.1:${PROXY_PORT}`;
// 应用内置的口令优先于开发口令，所以本机测试服务器要用同一个（从 app/.env.local 读，只给本机服务器，不打印）
let APP_KEY = 'test-app-key';
try { const m = fs.readFileSync(path.join(here, '..', '..', '.env.local'), 'utf8').match(/^VITE_SYNC_APP_KEY=(.+)$/m); if (m) APP_KEY = m[1].trim().replace(/^["']|["']$/g, ''); } catch { /* 没有就用开发口令 */ }
const dbFile = 'D:\\tmp\\es-sync\\e2e-083.db';
fs.mkdirSync('D:\\tmp\\es-sync', { recursive: true });
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });
const server = spawn(path.join(root, '.venv', 'Scripts', 'python.exe'), ['-m', 'uvicorn', 'app:app', '--port', String(PORT)], {
  cwd: root, env: { ...process.env, SYNC_APP_KEY: APP_KEY, SYNC_DB: dbFile }, stdio: 'ignore',
});
const requests = [];
const proxy = http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  requests.push(`${req.method} ${req.url}`);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = { ...req.headers }; delete headers.host; delete headers.origin; delete headers.referer; delete headers['content-length'];
  const r = await fetch(SERVER + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
  res.writeHead(r.status, { ...cors, 'Content-Type': r.headers.get('content-type') || 'application/json' });
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PROXY_PORT, '127.0.0.1');
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(SERVER + '/health')).ok) break; } catch { /* 还没起来 */ }
  await new Promise(r => setTimeout(r, 200));
}

const version = process.argv[2] || '0.11.99';
const srv = await serveRelease({ version });
const runDir = path.join('D:/tmp/es-e2e', `update-083-${Date.now()}`);
fs.mkdirSync(runDir, { recursive: true });
const extra = path.join(runDir, 'tauri-update-test.json');
fs.writeFileSync(extra, JSON.stringify({ plugins: { updater: { endpoints: [`${srv.base}/latest.json`], dangerousInsecureTransportProtocol: true } } }));
process.env.ES_E2E_EXTRA_CONFIG = extra;
const ok = m => console.log('PASS', m);
let s; let failed;
try {
  s = await start({ runDir });
  const page = await connect({ port: s.port });
  await page.waitReady('button');
  const out = f => path.join(s.out, f);
  // 空间用应用自己的 createSpace 建（请求头格式以前端为准），再存成同步配置
  const sp = await page.evaluate(`(async () => {
    localStorage.setItem('es_sync_dev_app_key', '${APP_KEY}');
    window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window); const S = await import('/utils/sync/index.ts');
    return S.createSpace({ baseUrl: '${URL}', appKey: '${APP_KEY}' });
  })()`);
  await page.evaluate(`(() => {
    localStorage.setItem('es_sync_config', JSON.stringify({ spaceId: ${JSON.stringify(sp.spaceId)}, spaceSecret: ${JSON.stringify(sp.spaceSecret)}, baseUrl: '${URL}', auto: false }));
    localStorage.setItem('worddrip.update.dryRun', '1');
  })()`);
  // 重载后窗口里的 fetch 替身要重新装上（开发模式下同步走它，不走 Tauri 的 http 插件）
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);' });
  await page.reload();
  await page.waitReady('button');
  await page.clickText(['设置', 'Settings']);
  await page.clickText(['检查更新', 'Check for updates']);
  await page.waitUntil('出现更新提示条', `!!document.querySelector('[data-testid=update-banner]')`);
  const bannerText = (await page.text('[data-testid=update-banner]')).replace(/\s+/g, ' ');
  if (bannerText.includes('建议先在')) throw new Error('已加入同步却还显示「建议先开同步」：' + bannerText);
  ok('已加入同步：提示条不再提示「建议先开同步」');
  requests.length = 0;
  await page.clickText(['现在更新', 'Update now']);
  await page.waitUntil('下载完成', `!!document.querySelector('[data-testid=update-ready]') || !!document.querySelector('[data-testid=update-error]') || /仍要安装|Install anyway/.test(document.body.innerText)`, { timeout: 120000 });
  await page.screenshot(out('sync-before-install.png'));
  if (!(await page.text('[data-testid=update-banner]')).match(/已下载并校验通过|Downloaded and verified/)) { const st = await page.evaluate(`(async () => { const M = await import('/utils/sync/manager.ts'); return JSON.stringify(M.getSyncState()); })()`); throw new Error('同步正常时没走到下载完成；同步状态=' + st + ' 请求=' + JSON.stringify(requests)); }
  if (!requests.some(r => r.includes('/pull') || r.includes('/push'))) throw new Error('点安装前没有看到同步请求（/pull、/push）：' + JSON.stringify(requests));
  ok(`点安装先同步：同步服务器收到 ${requests.length} 个请求：${requests.slice(0, 6).join(' | ')}`);

  // 同步地址连不上 → 「仍要安装吗」
  await page.evaluate(`(() => { const c = JSON.parse(localStorage.getItem('es_sync_config')); c.baseUrl = 'http://127.0.0.1:1'; localStorage.setItem('es_sync_config', JSON.stringify(c)); })()`);
  await page.reload();
  await page.waitReady('button');
  await page.clickText(['设置', 'Settings']);
  await page.clickText(['检查更新', 'Check for updates']);
  await page.waitUntil('出现更新提示条', `!!document.querySelector('[data-testid=update-banner]')`);
  await page.clickText(['现在更新', 'Update now']);
  await page.waitText(['仍要安装', 'Install anyway'], { timeout: 90000 });
  await page.screenshot(out('sync-failed-confirm.png'));
  const body = await page.evaluate(`document.body.innerText`);
  if (!body.includes('同步没成功')) throw new Error('没看到「同步没成功…仍要安装吗」提示');
  ok('同步连不上：出现「同步没成功…仍要安装吗」确认框');
  await page.clickText(['先不装', 'Not now', 'Cancel']);
  await page.waitUntil('确认框关闭', `!/同步没成功/.test(document.body.innerText)`);
  const t = await page.text('[data-testid=update-banner]');
  if (/已下载|Downloaded|正在下载|Downloading/.test(t)) throw new Error('点了「先不装」仍然开始下载：' + t);
  ok('点「先不装」：不下载、提示条仍在');
} catch (e) {
  failed = e;
  console.log('FAIL', e && e.stack || e);
} finally {
  try { srv.close(); } catch { /* ignore */ }
  proxy.close();
  server.kill();
  if (s) await stop(s.runDir).catch(() => {});
}
process.exit(failed ? 1 : 0);
