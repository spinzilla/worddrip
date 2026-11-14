// 071 真实应用联调：两个隔离数据目录 A、B 各启动真实 Tauri 窗口，窗口里调前端 utils/sync 的 syncNow，
// 后端是本机起的 server/sync（临时库在 D:\tmp\es-sync\）。词库用 node:sqlite 直接核对 / 种数据（触发器在库里，照样记账）。
// 整库搬家走真实命令 vocab_library_export / vocab_library_import（不走文件对话框）。
//   node dev/e2e/sync.mjs
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
const PORT = 8713;
const SERVER = `http://127.0.0.1:${PORT}`;
const PROXY_PORT = 8714;
const URL = `http://127.0.0.1:${PROXY_PORT}`; // 窗口里的浏览器 fetch 要 CORS，服务本身没有，所以中间放一个加 CORS 头的转发
const APP_KEY = 'test-app-key';
const dbFile = 'D:\\tmp\\es-sync\\e2e-071.db';
fs.mkdirSync('D:\\tmp\\es-sync', { recursive: true });
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });
const server = spawn(path.join(root, '.venv', 'Scripts', 'python.exe'), ['-m', 'uvicorn', 'app:app', '--port', String(PORT)], {
  cwd: root, env: { ...process.env, SYNC_APP_KEY: APP_KEY, SYNC_DB: dbFile }, stdio: 'ignore',
});
const proxy = http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
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

const ok = (name, detail = '') => console.log(`PASS ${name} ${detail}`);
const TABLES = ['review_word', 'review_log', 'review_event', 'vocab_note', 'vocab_example', 'quick_note', 'review_definition', 'upgrade_entry'];
const counts = (dir) => {
  const db = new DatabaseSync(path.join(dir, 'vocab.db'), { readOnly: true });
  const r = Object.fromEntries(TABLES.map(t => [t, Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n)]));
  db.close();
  return r;
};
const one = (dir, sql) => {
  const db = new DatabaseSync(path.join(dir, 'vocab.db'), { readOnly: true });
  const r = db.prepare(sql).get();
  db.close();
  return r;
};
const edit = (dir, fn) => {
  const db = new DatabaseSync(path.join(dir, 'vocab.db'));
  db.exec('PRAGMA foreign_keys = ON');
  fn(db);
  db.close();
};

// 在窗口里跑一段「用 syncNow 等前端接口」的脚本
const inApp = async (page, body) => page.evaluate(`(async () => { window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window); const S = await import('/utils/sync/index.ts'); ${body} })()`);
let a; let b; let page; let target;
const session = async (dirs, which, fn) => {
  const s = await start({ runDir: dirs[which]?.runDir, port: 9360 });
  dirs[which] = s;
  page = await connect({ port: s.port });
  await page.waitReady('button');
  try { return await fn(page, s); } finally { page.close(); page = null; await stop(s.runDir); }
};
const dirs = {};
let failure;
try {
  // 1. A 先开一次，建空间 + 让应用建出词库文件
  const created = await session(dirs, 'a', (p) => inApp(p, `const sp = await S.createSpace({ baseUrl: '${URL}', appKey: '${APP_KEY}' }); await window.__TAURI_INTERNALS__.invoke('sync_reset'); return sp;`));
  target = { baseUrl: URL, appKey: APP_KEY, spaceId: created.spaceId, spaceSecret: created.spaceSecret };
  ok('A 创建同步空间', `空间编号长度 ${created.spaceId.length}`);

  // 2. 种数据（A 已停）
  edit(dirs.a.appData, (db) => {
    for (let i = 1; i <= 3; i++) db.prepare(`INSERT INTO review_word (id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note, imported_at, updated_at, deleted, source, verification_status)
      VALUES (?, ?, 1, 'raw', ?, ?, '1', '2026-01-01', 'L1', 1, '2026-01-02', '原备注', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 0, '测试', '未查证')`).run(`w${i}`, i, `word${i}`, `word${i}`);
    db.exec(`INSERT INTO review_log (word_id, review_date, kind, correct, before_status, after_status, before_due, after_due, created_at) VALUES ('w1', '2026-01-02', 'recall', 1, 'L1', 'L2', '', '', '2026-01-02T01:00:00Z');
      INSERT INTO vocab_note (word_key, word, body, source, created_at, updated_at) VALUES ('word1', 'word1', '老笔记一', '词库', '2026-01-02T03:00:00Z', '2026-01-02T03:00:00Z');
      INSERT INTO vocab_note (word_key, word, body, source, created_at, updated_at) VALUES ('word2', 'word2', '老笔记二', '词库', '2026-01-02T04:00:00Z', '2026-01-02T04:00:00Z');
      INSERT INTO quick_note (body, created_at, updated_at, device_id) VALUES ('老随手记', '2026-01-02T06:00:00Z', '2026-01-02T06:00:00Z', 'old');
      INSERT INTO review_definition (word_id, source_file, source_line, pos, english, chinese) VALUES ('w1', 'a.md', 1, 'n.', 'e', 'c');`);
  });
  const seeded = counts(dirs.a.appData);
  ok('A 种数据', JSON.stringify(seeded));

  // 3. A 首次同步 + 整库导出（真实命令）
  const exported = await session(dirs, 'a', async (p) => {
    const r = await inApp(p, `const r = await S.syncNow(${JSON.stringify(target)}); const bytes = await window.__TAURI_INTERNALS__.invoke('vocab_library_export'); return { r, bytes: Array.from(bytes) };`);
    return r;
  });
  if (exported.r.error) throw new Error('A 首次同步出错：' + exported.r.error);
  ok('A 首次同步', `推 ${exported.r.pushed} 拉 ${exported.r.pulled} 跳过 ${exported.r.skipped}`);

  // 4. B：整库导入（真实命令）→ 同步一次；行数不能变
  const rb = await session(dirs, 'b', (p) => inApp(p, `await window.__TAURI_INTERNALS__.invoke('vocab_library_import', { request: { data: ${JSON.stringify(exported.bytes)} } }); return await S.syncNow(${JSON.stringify(target)});`));
  if (rb.error) throw new Error('B 同步出错：' + rb.error);
  ok('B 导入整库后首次同步', `推 ${rb.pushed} 拉 ${rb.pulled} 跳过 ${rb.skipped}`);
  const cb = counts(dirs.b.appData);
  if (JSON.stringify(cb) !== JSON.stringify(seeded)) throw new Error(`B 行数变了：${JSON.stringify(cb)} vs ${JSON.stringify(seeded)}`);
  ok('B 行数和改前一样（没有重复）', JSON.stringify(cb));

  // 5. A 加词、复习、笔记、随手记，并删一条笔记 → A 同步 → B 同步
  edit(dirs.a.appData, (db) => {
    db.exec(`INSERT INTO review_word (id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note, imported_at, updated_at, deleted, source, verification_status)
        VALUES ('w-new', 9, 1, 'raw', 'brandnew', 'brandnew', '1', '2026-02-01', 'L1', 1, '2026-02-02', '', '2026-02-01', '2026-02-01', 0, '测试', '未查证');
      INSERT INTO review_log (word_id, review_date, kind, correct, before_status, after_status, before_due, after_due, created_at) VALUES ('w-new', '2026-02-02', 'recall', 1, 'L1', 'L2', '', '', '2026-02-02T01:00:00Z');
      INSERT INTO vocab_note (word_key, word, body, source, created_at, updated_at) VALUES ('brandnew', 'brandnew', 'A 的新笔记', '复习', '2026-02-02T03:00:00Z', '2026-02-02T03:00:00Z');
      INSERT INTO quick_note (body, created_at, updated_at, device_id) VALUES ('A 的新随手记', '2026-02-02T06:00:00Z', '2026-02-02T06:00:00Z', 'a');
      DELETE FROM vocab_note WHERE body = '老笔记二';`);
  });
  const ra = await session(dirs, 'a', (p) => inApp(p, `return await S.syncNow(${JSON.stringify(target)});`));
  if (ra.error) throw new Error('A 同步出错：' + ra.error);
  ok('A 同步', `推 ${ra.pushed} 拉 ${ra.pulled} 跳过 ${ra.skipped}`);
  const rb2 = await session(dirs, 'b', (p) => inApp(p, `return await S.syncNow(${JSON.stringify(target)});`));
  if (rb2.error) throw new Error('B 同步出错：' + rb2.error);
  const ca = counts(dirs.a.appData);
  const cb2 = counts(dirs.b.appData);
  if (JSON.stringify(ca) !== JSON.stringify(cb2)) throw new Error(`两边行数不一致：A ${JSON.stringify(ca)} B ${JSON.stringify(cb2)}`);
  for (const [sql, label] of [
    ["SELECT COUNT(*) AS n FROM review_word WHERE word = 'brandnew'", '新词'],
    ["SELECT COUNT(*) AS n FROM vocab_note WHERE body = 'A 的新笔记'", '新笔记'],
    ["SELECT COUNT(*) AS n FROM quick_note WHERE body = 'A 的新随手记'", '新随手记'],
    ["SELECT COUNT(*) AS n FROM review_log WHERE word_id = 'w-new'", '新复习记录'],
  ]) if (Number(one(dirs.b.appData, sql).n) !== 1) throw new Error(`B 缺少 ${label}`);
  if (Number(one(dirs.b.appData, "SELECT COUNT(*) AS n FROM vocab_note WHERE body = '老笔记二'").n) !== 0) throw new Error('B 没有删掉被 A 删的笔记');
  ok('B 同步后和 A 一致，含新词/复习/笔记/随手记，删除已传到', `推 ${rb2.pushed} 拉 ${rb2.pulled} 跳过 ${rb2.skipped}；B 行数 ${JSON.stringify(cb2)}`);

  // 6. 服务停掉：窗口里的同步报中文网络错误，本机数据不坏；恢复后再同步
  edit(dirs.a.appData, (db) => db.exec(`INSERT INTO quick_note (body, created_at, updated_at, device_id) VALUES ('断线时写的', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z', 'a')`));
  const dead = await session(dirs, 'a', (p) => inApp(p, `return await S.syncNow({ ...${JSON.stringify(target)}, baseUrl: 'http://127.0.0.1:1' });`));
  if (!/连不上同步服务器/.test(dead.error || '')) throw new Error('断线时没有中文网络错误：' + JSON.stringify(dead));
  const integrity = one(dirs.a.appData, 'PRAGMA integrity_check').integrity_check;
  if (integrity !== 'ok') throw new Error('断线后库损坏：' + integrity);
  ok('服务连不上 → 中文网络错误，本机库完好', dead.error);
  const back = await session(dirs, 'a', (p) => inApp(p, `return await S.syncNow(${JSON.stringify(target)});`));
  if (back.error || back.pushed < 1) throw new Error('恢复后没补推：' + JSON.stringify(back));
  const rb3 = await session(dirs, 'b', (p) => inApp(p, `return await S.syncNow(${JSON.stringify(target)});`));
  if (Number(one(dirs.b.appData, "SELECT COUNT(*) AS n FROM quick_note WHERE body = '断线时写的'").n) !== 1) throw new Error('B 没拿到断线期间写的随手记：' + JSON.stringify(rb3));
  ok('恢复后补上，B 已有断线时写的随手记');
} catch (e) {
  failure = e;
} finally {
  server.kill();
  proxy.close();
  for (const s of Object.values(dirs)) await stop(s.runDir).catch(() => {});
}
if (failure) { console.error('FAIL', failure.message); process.exit(1); }
console.log('071 真实应用联调通过');
