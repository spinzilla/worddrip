/** Notion 收件箱：真实请求模块 + 本机假 Notion 服务，全程不访问真实 Notion。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundled = path.resolve('src-tauri/target/vocab-notion-inbox-tests', `notion-${process.pid}.mjs`);
fs.mkdirSync(path.dirname(bundled), { recursive: true });
await build({
  entryPoints: ['utils/vocab/notion.ts'],
  bundle: true,
  format: 'esm',
  outfile: bundled,
  define: { 'import.meta.env.DEV': 'false' },
  plugins: [{
    name: 'node-tauri-http',
    setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/plugin-http$/ }, args => ({ path: args.path, namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const fetch = (...args) => globalThis.fetch(...args);' }));
    },
  }],
});

const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
};
const { getNotionConfig, markNotionPagesImported, pullNotionInbox, saveNotionConfig } = await import(pathToFileURL(bundled).href);
const token = 'dummy-notion-token-must-not-leak';
const page = (id, word, note, imported = false) => ({
  id,
  properties: {
    '词目': { type: 'title', title: [{ plain_text: word }] },
    '备注': { type: 'rich_text', rich_text: [{ plain_text: note }] },
    '已入库': { type: 'checkbox', checkbox: imported },
  },
});
const pages = new Map([
  ['page-resilient', page('page-resilient', 'resilient', '有韧性的')],
  ['page-candid', page('page-candid', 'candid', '坦率的')],
  ['page-existing', page('page-existing', 'already', '已经入库', true)],
  ['page-deleted', page('page-deleted', 'obsolete', '界面会删除')],
]);
const queryBodies = [];
const patchBodies = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(req.headers.authorization, `Bearer ${token}`);
  assert.equal(req.headers['notion-version'], '2022-06-28');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'POST' && req.url === '/v1/databases/main/query') {
    queryBodies.push(body);
    if (queryBodies.length === 1) {
      // 故意多返回一条已勾选行，验证模块除查询条件外还会本地过滤。
      return res.end(JSON.stringify({ results: [pages.get('page-resilient'), pages.get('page-existing')], has_more: true, next_cursor: 'cursor-2' }));
    }
    return res.end(JSON.stringify({ results: [pages.get('page-candid'), pages.get('page-deleted')], has_more: false, next_cursor: null }));
  }
  if (req.method === 'POST' && req.url === '/v1/databases/unauthorized/query') {
    res.statusCode = 401;
    return res.end(JSON.stringify({ message: `bad token ${token}` }));
  }
  if (req.method === 'POST' && req.url === '/v1/databases/limited/query') {
    res.statusCode = 429;
    return res.end(JSON.stringify({ message: `rate limited ${token}` }));
  }
  const patch = req.method === 'PATCH' && req.url?.match(/^\/v1\/pages\/([^/]+)$/);
  if (patch) {
    const id = decodeURIComponent(patch[1]);
    patchBodies.push({ id, body });
    pages.get(id).properties['已入库'].checkbox = body.properties['已入库'].checkbox;
    return res.end(JSON.stringify(pages.get(id)));
  }
  res.statusCode = 404;
  res.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;
const baseUrl = `http://127.0.0.1:${port}/v1`;
const configure = databaseId => saveNotionConfig({ token, databaseId });

const closedServer = http.createServer();
await new Promise(resolve => closedServer.listen(0, '127.0.0.1', resolve));
const closedAddress = closedServer.address();
const closedPort = typeof closedAddress === 'object' && closedAddress ? closedAddress.port : 0;
await new Promise(resolve => closedServer.close(resolve));

try {
  storage.clear();
  await assert.rejects(pullNotionInbox({ baseUrl }), /请先在设置中填写/);
  configure('main');
  assert.deepEqual(getNotionConfig(), { token, databaseId: 'main' });

  const pulled = await pullNotionInbox({ baseUrl });
  assert.deepEqual(pulled.map(item => item.word), ['resilient', 'candid', 'obsolete']);
  assert.equal(pulled.some(item => item.word === 'already'), false, '已入库行不进入候选');
  assert.equal(queryBodies.length, 2, '跟随 next_cursor 拉取第二页');
  assert.deepEqual(queryBodies[0], {
    filter: { property: '已入库', checkbox: { equals: false } },
    page_size: 100,
  });
  assert.equal(queryBodies[1].start_cursor, 'cursor-2');

  // 模拟界面删除 obsolete，只确认另外两条；只能 PATCH 这两条页面。
  const selected = pulled.filter(item => item.word !== 'obsolete');
  await markNotionPagesImported(selected.map(item => item.pageId), { baseUrl });
  assert.deepEqual(patchBodies.map(item => item.id), ['page-resilient', 'page-candid']);
  assert.equal(pages.get('page-resilient').properties['已入库'].checkbox, true);
  assert.equal(pages.get('page-candid').properties['已入库'].checkbox, true);
  assert.equal(pages.get('page-deleted').properties['已入库'].checkbox, false, '删除的候选不能勾选，下次还会出现');
  assert.equal(patchBodies.every(item => item.body.properties['已入库'].checkbox === true), true);

  configure('unauthorized');
  await assert.rejects(pullNotionInbox({ baseUrl }), error => {
    assert.match(error.message, /令牌无效/);
    assert.equal(error.message.includes(token), false);
    return true;
  });
  configure('limited');
  await assert.rejects(pullNotionInbox({ baseUrl }), error => {
    assert.match(error.message, /429/);
    assert.equal(error.message.includes(token), false);
    return true;
  });
  configure('main');
  await assert.rejects(pullNotionInbox({ baseUrl: `http://127.0.0.1:${closedPort}/v1` }), /连接 Notion 失败/);
  // Tauri http 插件超时抛的是 Error('Request cancelled')，不是 AbortError；不能显示成「连接失败」。
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('Request cancelled'); };
    await assert.rejects(pullNotionInbox({ baseUrl }), /连接 Notion 超时/);
    // 不靠报错措辞：插件换成任何陌生说法、甚至请求根本不返回，只要到了我们自己的计时点都算超时。
    globalThis.fetch = async () => new Promise(() => {});
    await assert.rejects(pullNotionInbox({ baseUrl, timeoutMs: 20 }), /连接 Notion 超时/, '底层不响应也要按超时处理');
    globalThis.fetch = async () => { throw new Error('socket hang up (0x8007274D)'); };
    await assert.rejects(pullNotionInbox({ baseUrl }), /连接 Notion 失败/, '陌生但非超时的报错不能说成超时');
    globalThis.fetch = async () => { throw new Error('connection refused'); };
    await assert.rejects(pullNotionInbox({ baseUrl }), /连接 Notion 失败/, '普通连接失败不能说成超时');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal([...storage.values()].join('\n').includes('https://api.notion.com'), false);

  console.log('Notion 收件箱自动测试通过：分页、已入库过滤、仅回写确认项、401、429、断网及令牌不泄漏。');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}