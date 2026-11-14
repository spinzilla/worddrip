// 072 同步界面真实联调：窗口 A（电脑 1280×900）、B（手机 UA 390×844）、C（第三个，测名额满），
// 后端是本机起的 server/sync（SYNC_MAX_SPACES=1，临时库在 D:\tmp\es-sync\）。
//   node dev/e2e/sync-ui.mjs
// 窗口里 http 插件关着，所以用开发版的 window.__ES_E2E_HTTP_FETCH__（浏览器 fetch）+ 一个带 CORS 头的转发。
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { connect } from './cdp.mjs';
import { start, stop } from './launch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..', 'server', 'sync');
const PORT = 8723; const PROXY_PORT = 8724;
const SERVER = `http://127.0.0.1:${PORT}`;
const URL = `http://127.0.0.1:${PROXY_PORT}`;
const APP_KEY = 'test-app-key-072';
const dbFile = 'D:\\tmp\\es-sync\\e2e-072.db';
const OUT = 'D:\\tmp\\es-sync\\out-072';
fs.mkdirSync(OUT, { recursive: true });
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let serverProc;
const startServer = async () => {
  serverProc = spawn(path.join(root, '.venv', 'Scripts', 'python.exe'), ['-m', 'uvicorn', 'app:app', '--port', String(PORT)], {
    cwd: root, env: { ...process.env, SYNC_APP_KEY: APP_KEY, SYNC_DB: dbFile, SYNC_MAX_SPACES: '1' }, stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(SERVER + '/health')).ok) return; } catch { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error('同步服务没起来');
};
const proxy = http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = { ...req.headers }; delete headers.host; delete headers.origin; delete headers.referer; delete headers['content-length'];
    const r = await fetch(SERVER + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
    res.writeHead(r.status, { ...cors, 'Content-Type': r.headers.get('content-type') || 'application/json' });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch { req.socket.destroy(); }
}).listen(PROXY_PORT, '127.0.0.1');

const ok = (name, detail = '') => console.log(`PASS ${name} ${detail}`);
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const db = (dir, fn, ro = true) => { const d = new DatabaseSync(path.join(dir, 'vocab.db'), ro ? { readOnly: true } : {}); try { return fn(d); } finally { d.close(); } };
const words = (dir) => db(dir, d => d.prepare('SELECT id, due, status FROM review_word ORDER BY id').all());
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36';
const logs = [];

// 打开一个窗口：可选手机 UA；设好开发口令和浏览器 fetch，进设置的「同步与搬家」。
const open = async (dirs, which, { mobile = false, settings = true } = {}) => {
  const s = await start({ runDir: dirs[which]?.runDir, port: 9360 });
  dirs[which] = s;
  const page = await connect({ port: s.port });
  await page.waitReady('button');
  if (mobile) await page.send('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA });
  await page.setViewport(mobile ? 390 : 1280, mobile ? 844 : 900, { mobile, dpr: 1 });
  await page.evaluate(`localStorage.setItem('es_sync_dev_app_key', ${JSON.stringify(APP_KEY)})`);
  await page.reload();
  await page.waitReady('button');
  await page.evaluate('window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window)');
  if (settings) await gotoSync(page);
  return page;
};
const gotoSync = async (page) => {
  await page.clickText('设置'); await sleep(300);
  await page.clickText('同步与搬家'); await page.waitFor('[data-testid="sync-settings"]');
  // 服务器地址指向本机转发（高级里的输入框）
  await page.evaluate(`document.querySelector('[data-testid="sync-advanced"]').open = true`);
  const cur = await page.evaluate(`document.querySelector('[data-testid="sync-url"]').value`);
  if (cur !== URL) {
    await page.click('[data-testid="sync-url"]');
    await page.type('[data-testid="sync-url"]', URL);
    await page.evaluate(`document.activeElement.blur()`);
  }
};
const close = async (dirs, which, page) => { page.close(); await stop(dirs[which].runDir); };
const shot = async (page, name) => page.screenshot(path.join(OUT, name));
const textOf = (page, id) => page.evaluate(`document.querySelector('[data-testid="${id}"]')?.innerText ?? ''`);
const noOverflow = async (page, what) => must(!(await page.evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth')), `${what} 横向溢出`);
const callApp = (page, body) => page.evaluate(`(async () => { const { vocabApi } = await import('/utils/vocab/api.ts'); ${body} })()`);

// 点「立即同步」并等这一次真的结束（上次同步时间变了），返回结果文字
const syncClick = async (page) => {
  const old = await textOf(page, 'sync-last-at');
  await page.click('[data-testid="sync-now"]');
  await page.waitUntil('这次同步结束', `(() => { const t = document.querySelector('[data-testid="sync-last-at"]')?.innerText ?? ''; return t !== ${JSON.stringify(old)} && !document.querySelector('[data-testid="sync-now"]')?.disabled; })()`, { timeout: 40000 });
  return textOf(page, 'sync-last-result');
};
const dirs = {};
let failure; let code = '';
try {
  await startServer();
  // ---- 种数据：先让 A 起一次建出词库文件，再往库里放 3 个词
  let a = await open(dirs, 'a', { settings: false });
  await a.evaluate("window.__TAURI_INTERNALS__.invoke('sync_reset')"); // 让词库文件建出来
  await close(dirs, 'a', a);
  const d = dirs.a.appData;
  db(d, x => {
    for (let i = 1; i <= 3; i++) x.prepare(`INSERT INTO review_word (id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note, imported_at, updated_at, deleted, source, verification_status)
      VALUES (?, ?, 1, 'raw', ?, ?, '1', '2026-01-01', 'L1', 1, '2026-01-02', '备注', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 0, '测试', '未查证')`).run(`w${i}`, i, `word${i}`, `word${i}`);
  }, false);
  ok('A 种了 3 个词');

  // ---- 1. A 开启同步
  a = await open(dirs, 'a');
  must(await a.evaluate(`!!document.querySelector('[data-testid="sync-off"]')`), '没开启时应显示两个按钮');
  await shot(a, '01-A-off-desktop.png');
  await a.click('[data-testid="sync-enable"]');
  await a.waitFor('[data-testid="sync-on"]', { timeout: 30000 });
  await a.waitUntil('第一次同步完成', `/上传 \\d+ 条/.test(document.querySelector('[data-testid="sync-last-result"]')?.innerText ?? '')`, { timeout: 30000 });
  const masked = await textOf(a, 'sync-code');
  must(/^[•-]+$/.test(masked.replace(/\s/g, '')), `同步码默认应打码，实际：${masked.slice(0, 6)}…`);
  await shot(a, '02-A-on-masked-desktop.png');
  await a.click('[data-testid="sync-code-toggle"]');
  code = (await textOf(a, 'sync-code')).trim();
  must(/^[A-Z2-7-]{20,}$/.test(code), '显示后应是同步码');
  await shot(a, '03-A-on-revealed-desktop.png');
  ok('A 开启同步，打码/显示各一张', `上次结果 ${await textOf(a, 'sync-last-result')}`);
  must((await textOf(a, 'sync-last-result')).includes('上传'), '应显示推拉条数');
  await shot(a, '04-A-status-desktop.png');
  await close(dirs, 'a', a);

  // ---- 2. 第三个窗口：名额满
  let c = await open(dirs, 'c');
  await c.click('[data-testid="sync-enable"]');
  await c.waitFor('[data-testid="sync-action-error"]', { timeout: 20000 });
  const full = await textOf(c, 'sync-action-error');
  must(full.includes('名额已满'), `应提示名额已满，实际：${full}`);
  await shot(c, '05-C-full-desktop.png');
  ok('名额满提示', full);
  await close(dirs, 'c', c);

  // ---- 3. B（手机）加入：先抄错再对
  let b = await open(dirs, 'b', { mobile: true });
  await b.click('[data-testid="sync-join-open"]');
  await b.waitFor('[data-testid="sync-code-input"]');
  const bad = code.slice(0, 10) + (code[10] === 'A' ? 'B' : 'A') + code.slice(11);
  await b.type('[data-testid="sync-code-input"]', bad);
  await b.click('[data-testid="sync-join"]');
  await b.waitFor('[data-testid="sync-action-error"]');
  must((await textOf(b, 'sync-action-error')).includes('同步码有误'), '抄错应提示同步码有误');
  await shot(b, '06-B-bad-code-mobile.png');
  await noOverflow(b, '手机加入页');
  ok('抄错一位提示「同步码有误」');
  await b.evaluate(`(() => { const el = document.querySelector('[data-testid="sync-code-input"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(code)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await b.click('[data-testid="sync-join"]');
  await b.waitFor('[data-testid="sync-on"]', { timeout: 30000 });
  await b.waitUntil('B 第一次同步完成', `/下载 \\d+ 条/.test(document.querySelector('[data-testid="sync-last-result"]')?.innerText ?? '')`, { timeout: 30000 });
  await shot(b, '07-B-joined-mobile.png');
  await noOverflow(b, '手机已开启页');
  must(words(dirs.b.appData).length === 3, 'B 应拉到 3 个词');
  ok('B 加入成功并拉到 3 个词', await textOf(b, 'sync-last-result'));
  // 字号 130%
  await b.evaluate(`document.documentElement.style.fontSize = '130%'`); await sleep(400);
  await noOverflow(b, '手机 130% 字号');
  await shot(b, '08-B-font130-mobile.png');
  await b.evaluate(`document.documentElement.style.fontSize = ''`);
  await close(dirs, 'b', b);

  // ---- 4. A 加一个词 → A 立即同步；B 立即同步后出现
  db(dirs.a.appData, x => x.prepare(`INSERT INTO review_word (id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note, imported_at, updated_at, deleted, source, verification_status)
    VALUES ('w4', 4, 1, 'raw', 'word4', 'word4', '1', '2026-01-01', 'L1', 1, '2026-01-02', '备注', '2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z', 0, '测试', '未查证')`).run(), false);
  a = await open(dirs, 'a');
  await syncClick(a);
  await close(dirs, 'a', a);
  b = await open(dirs, 'b', { mobile: true });
  await syncClick(b);
  must(words(dirs.b.appData).some(w => w.id === 'w4'), 'B 应出现 w4');
  await b.clickText('词库'); await sleep(800);
  await shot(b, '09-B-vocab-after-pull-mobile.png');
  ok('A 加词 → B 同步后出现', 'w4 在 B 的库里');

  // ---- 5. B 做一次复习保存 → 不点按钮自动同步 → A 立即同步后到期日变了
  const before = words(dirs.a.appData).find(w => w.id === 'w1').due;
  await callApp(b, `await vocabApi.submitReview({ id: 'w1', kind: 'recall', correct: true });`);
  const afterB = words(dirs.b.appData).find(w => w.id === 'w1').due;
  must(afterB !== before, 'B 复习后 w1 到期日应变');
  await sleep(9000); // 防抖 4 秒 + 同步
  await close(dirs, 'b', b);
  a = await open(dirs, 'a');
  await syncClick(a);
  must(words(dirs.a.appData).find(w => w.id === 'w1').due === afterB, 'A 的 w1 到期日应和 B 一致');
  ok('B 复习保存 → 自动同步 → A 到期日一致', `${before} → ${afterB}`);

  // ---- 6. 停服务：立即同步显示中文失败原因、不弹窗；连续 3 次后词库页出现提示
  serverProc.kill();
  await sleep(500);
  for (let i = 0; i < 3; i++) {
    await a.click('[data-testid="sync-now"]');
    await a.waitFor('[data-testid="sync-error"]', { timeout: 40000 });
    await sleep(600);
  }
  const err = await textOf(a, 'sync-error');
  must(/连不上|超时/.test(err), `失败原因应是中文网络错误，实际：${err}`);
  await shot(a, '10-A-fail-desktop.png');
  await a.clickText('词库'); await sleep(800);
  await a.waitFor('[data-testid="sync-fail-notice"]');
  await shot(a, '11-A-fail-notice-vocab.png');
  ok('停服务后失败原因 + 词库页提示', err);
  await a.clickText('同步失败，点这里查看', { selector: 'button' });
  await a.waitFor('[data-testid="sync-settings"]');
  ok('点提示跳到设置的同步页');
  await shot(a, '12-A-settings-desktop-1280.png');
  await noOverflow(a, '电脑设置页');

  // ---- 7. 服务恢复后「删除服务器上的同步数据」
  await startServer();
  await a.click('[data-testid="sync-danger"] summary');
  await a.click('[data-testid="sync-delete"]');
  await a.waitFor('[data-testid="sync-delete-confirm"]');
  await a.click('[data-testid="sync-delete-yes"]');
  await a.waitFor('[data-testid="sync-off"]', { timeout: 30000 });
  const rows = (() => { const x = new DatabaseSync(dbFile, { readOnly: true }); try { const t = x.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name); return Object.fromEntries(t.map(n => [n, Number(x.prepare(`SELECT COUNT(*) n FROM "${n}"`).get().n)])); } finally { x.close(); } })();
  ok('服务端各表行数', JSON.stringify(rows));
  must((rows.spaces ?? rows.space ?? 0) === 0 && (rows.changes ?? 0) === 0, '删除后服务端空间和改动行应为 0');
  await close(dirs, 'a', a);
  b = await open(dirs, 'b', { mobile: true });
  await b.click('[data-testid="sync-now"]');
  await b.waitFor('[data-testid="sync-off"]', { timeout: 30000 });
  must((await textOf(b, 'sync-notice')).includes('已被删除'), 'B 应看到空间被删除的说明');
  await shot(b, '13-B-back-to-off-mobile.png');
  ok('A、B 都回到「没开启」');
  await close(dirs, 'b', b);
} catch (e) {
  failure = e;
  console.log('FAIL', e?.stack || e);
} finally {
  for (const k of Object.keys(dirs)) { try { await stop(dirs[k].runDir); } catch { /* 已停 */ } }
  serverProc?.kill();
  proxy.close();
}
// 同步码不该出现在任何日志里：搜 Tauri 日志
if (!failure && code) {
  for (const k of Object.keys(dirs)) {
    const logDir = path.join(dirs[k].runDir, 'logs');
    if (!fs.existsSync(logDir)) continue;
    for (const f of fs.readdirSync(logDir)) {
      const text = fs.readFileSync(path.join(logDir, f), 'utf8');
      const secret = code.replace(/-/g, '');
      if (text.includes(code) || text.includes(secret) || text.includes(APP_KEY)) { failure = new Error(`日志 ${f} 里出现了同步码或应用口令`); console.log('FAIL', failure.message); }
    }
  }
  if (!failure) ok('日志里没有同步码和应用口令原文');
}
console.log(failure ? '同步界面联调失败' : `同步界面联调通过，截图在 ${OUT}`);
process.exit(failure ? 1 : 0);
