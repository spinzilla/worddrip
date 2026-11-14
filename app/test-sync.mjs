/**
 * 071 前端同步代码检查：同步码编码/解码（纯函数）+ 对着真实的本机同步服务（server/sync）走联网流程。
 * 本机词库那一半在 Rust（cargo test vocab 已覆盖），这里用内存里的「假核心」代替 sync_* 命令，只验证联网这一半。
 * 运行：node test-sync.mjs        （会自己用 server/sync/.venv 起服务，端口 8711，库放 D:\tmp\es-sync\）
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = join(tmpdir(), `sync-${process.pid}.mjs`);
await build({
  entryPoints: ['utils/sync/index.ts'], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
  plugins: [{ name: 'stub', setup(b) {
    b.onResolve({ filter: /^@tauri-apps\// }, a => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const invoke = () => { throw new Error("no tauri"); }; export const fetch = globalThis.fetch;', loader: 'js' }));
  } }],
});
const S = await import(pathToFileURL(out).href);
let n = 0;
const ok = (name) => console.log(`PASS ${++n} ${name}`);

// ── 同步码 ──
const ID = 'abcdefghijklmnop'.replace(/[^a-z2-7]/g, 'a');
const secret = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 5) & 255)).toString('base64url');
const code = S.encodeSyncCode(ID, secret);
assert.match(code, /^([A-Z2-7]{4}-){17}[A-Z2-7]$/);
const back = S.decodeSyncCode(code);
assert.deepEqual(back, { spaceId: ID, spaceSecret: secret });
assert.deepEqual(S.decodeSyncCode(`  ${code.toLowerCase().replace(/-/g, ' - ')}\n`), back);
ok('同步码往返、容忍大小写和空格');
const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const plain = code.replace(/-/g, '');
for (let i = 0; i < plain.length; i++) {
  const swapped = plain.slice(0, i) + alpha[(alpha.indexOf(plain[i]) + 1) % 32] + plain.slice(i + 1);
  assert.throws(() => S.decodeSyncCode(swapped), /同步码有误/);
}
assert.throws(() => S.decodeSyncCode(code.slice(0, -2)), /同步码有误/);
assert.throws(() => S.decodeSyncCode('hello'), /同步码有误/);
ok(`抄错任意一位都报「同步码有误」（试了 ${plain.length} 个位置）`);

// ── 起本机服务 ──
const root = resolve('..', 'server', 'sync');
const port = 8711;
const dbFile = 'D:\\tmp\\es-sync\\test-sync-071.db';
fs.mkdirSync('D:\\tmp\\es-sync', { recursive: true });
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });
const APP_KEY = 'test-app-key';
const py = join(root, '.venv', 'Scripts', 'python.exe');
const server = spawn(py, ['-m', 'uvicorn', 'app:app', '--port', String(port)], { cwd: root, env: { ...process.env, SYNC_APP_KEY: APP_KEY, SYNC_DB: dbFile }, stdio: 'ignore' });
const url = `http://127.0.0.1:${port}`;
try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(url + '/health')).ok) break; } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 200));
  }

  // 假核心：每台设备一份，实现 sync_* 命令的最小版本（不合并，只演示联网流程）
  const device = (name) => {
    const st = { dirty: new Map(), rows: new Map(), cursor: 0, name };
    const invoke = async (cmd, args) => {
      const r = args?.request;
      if (cmd === 'sync_begin') return { device_id: name, cursor: st.cursor };
      if (cmd === 'sync_collect') return [...st.dirty.values()].slice(0, r.limit);
      if (cmd === 'sync_ack') { let k = 0; for (const i of r.items) { const d = st.dirty.get(i.table + i.id); if (d && d.updated_at === i.updated_at) { st.dirty.delete(i.table + i.id); k++; } } return k; }
      if (cmd === 'sync_apply') { for (const c of r.changes) st.rows.set(c.table + c.id, c); st.cursor = r.cursor; return { applied: r.changes.length, skipped: 0 }; }
      if (cmd === 'sync_finish') return undefined;
      throw new Error('unknown ' + cmd);
    };
    return { st, invoke };
  };

  const space = await S.createSpace({ baseUrl: url, appKey: APP_KEY });
  assert.equal(space.spaceId.length, 16);
  const target = { baseUrl: url, appKey: APP_KEY, spaceId: space.spaceId, spaceSecret: space.spaceSecret };
  assert.deepEqual(S.decodeSyncCode(S.encodeSyncCode(space.spaceId, space.spaceSecret)), { spaceId: space.spaceId, spaceSecret: space.spaceSecret });
  ok('createSpace 得到空间，同步码往返和服务器给的一致');

  const A = device('A');
  const B = device('B');
  for (let i = 0; i < 1200; i++) A.st.dirty.set('review_word' + 'w' + i, { table: 'review_word', id: 'w' + i, updated_at: 1000 + i, deleted: false, data: { word: 'w' + i } });
  const r1 = await S.syncNow(target, { invoke: A.invoke });
  assert.equal(r1.error, undefined);
  assert.equal(r1.pushed, 1200); // 3 批：500 + 500 + 200
  assert.equal(A.st.dirty.size, 0);
  const r2 = await S.syncNow(target, { invoke: B.invoke });
  assert.equal(r2.error, undefined);
  assert.equal(r2.pulled, 1200);
  assert.equal(B.st.rows.size, 1200);
  assert.ok(B.st.cursor >= 1200);
  ok('A 推 1200 条（分 3 批）→ B 拉 1200 条（分页），cursor 前进');
  assert.equal((await S.spaceInfo(target)).rows, 1200);
  ok('spaceInfo 返回行数 1200');

  // 同一时间只允许一次
  const slowInvoke = async (cmd, args) => { await new Promise(r => setTimeout(r, 300)); return B.invoke(cmd, args); };
  const [p, q] = await Promise.all([S.syncNow(target, { invoke: slowInvoke }), S.syncNow(target, { invoke: B.invoke })]);
  assert.ok([p, q].some(x => /还没结束/.test(x.error ?? '')));
  ok('同时发起两次，后一次被拒绝');

  // 空间隔离
  const other = await S.createSpace({ baseUrl: url, appKey: APP_KEY });
  const otherTarget = { ...target, spaceId: other.spaceId, spaceSecret: other.spaceSecret };
  const C = device('C');
  C.st.dirty.set('review_wordonly-c', { table: 'review_word', id: 'only-c', updated_at: 5, deleted: false, data: {} });
  assert.equal((await S.syncNow(otherTarget, { invoke: C.invoke })).error, undefined);
  await S.syncNow(target, { invoke: B.invoke });
  assert.ok(![...B.st.rows.values()].some(c => c.id === 'only-c'));
  assert.equal((await S.spaceInfo(target)).rows, 1200);
  assert.equal((await S.spaceInfo(otherTarget)).rows, 1);
  ok('另一个空间 C 的数据，A/B 拉不到');

  // 错误翻译
  const wrong = await S.syncNow({ ...target, spaceSecret: 'x'.repeat(43) }, { invoke: device('W').invoke });
  assert.match(wrong.error, /同步码不对/);
  assert.ok(!wrong.error.includes('xxxx'));
  const badKey = await S.syncNow({ ...target, appKey: 'nope' }, { invoke: device('W').invoke });
  assert.match(badKey.error, /同步码不对/);
  ok('密钥或口令不对 → 401 的中文说明，不带密钥');

  // 删除空间
  await S.deleteSpace(otherTarget);
  const gone = await S.syncNow(otherTarget, { invoke: device('W').invoke });
  assert.match(gone.error, /已被删除/);
  ok('删除空间后再同步 → 401 说明');
} finally {
  server.kill();
}

// 服务停了：网络错误是中文的，不抛、不带地址
const deadCalls = [];
const dead = await S.syncNow(
  { baseUrl: url, appKey: APP_KEY, spaceId: 'a'.repeat(16), spaceSecret: 'b'.repeat(43) },
  { invoke: async (c) => { deadCalls.push(c); return c === 'sync_begin' ? { device_id: 'D', cursor: 0 } : c === 'sync_collect' ? [] : undefined; } },
);
assert.deepEqual(deadCalls, [], '连不上服务器时不碰本机同步状态（不会把整库标成待推送）');
assert.match(dead.error, /连不上同步服务器/);
assert.ok(!dead.error.includes('127.0.0.1'));
ok('服务停掉 → 中文网络错误');
console.log('ALL OK');
fs.rmSync(out, { force: true });
