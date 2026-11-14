// 027 真实窗口：本机假 Notion，设置 → 拉取 → 删除 → 确认，全程隔离数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { start, stop } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { openDb, queryRows } from '../../../e2e/db.mjs';

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.resolve('src-tauri/target/e2e', `027-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });
const token = 'dummy-e2e-notion-token';
const notionPage = (id, word, note, imported = false) => ({
  id,
  properties: {
    '词目': { type: 'title', title: [{ plain_text: word }] },
    '备注': { type: 'rich_text', rich_text: [{ plain_text: note }] },
    '已入库': { type: 'checkbox', checkbox: imported },
  },
});
const pages = new Map([
  ['page-resilient', notionPage('page-resilient', 'resilient', '有韧性的')],
  ['page-candid', notionPage('page-candid', 'candid', '坦率的')],
  ['page-obsolete', notionPage('page-obsolete', 'obsolete', '这条会删除')],
  ['page-alpha', notionPage('page-alpha', 'alpha', '词库已有')],
  ['page-done', notionPage('page-done', 'already', 'Notion 已勾选', true)],
]);
const queryBodies = [];
const patches = [];
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, notion-version');
  res.setHeader('Access-Control-Allow-Methods', 'POST, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(req.headers.authorization, `Bearer ${token}`);
  assert.equal(req.headers['notion-version'], '2022-06-28');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'POST' && req.url === '/v1/databases/main/query') {
    queryBodies.push(body);
    if (queryBodies.length === 1) {
      return res.end(JSON.stringify({ results: [pages.get('page-resilient'), pages.get('page-done')], has_more: true, next_cursor: 'cursor-2' }));
    }
    return res.end(JSON.stringify({ results: [pages.get('page-candid'), pages.get('page-obsolete'), pages.get('page-alpha')], has_more: false, next_cursor: null }));
  }
  const patch = req.method === 'PATCH' && req.url?.match(/^\/v1\/pages\/([^/]+)$/);
  if (patch) {
    const id = decodeURIComponent(patch[1]);
    assert.equal(body.properties['已入库'].checkbox, true);
    pages.get(id).properties['已入库'].checkbox = true;
    patches.push(id);
    return res.end(JSON.stringify(pages.get(id)));
  }
  res.statusCode = 404;
  res.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;

const invoke = async (page, command, args = {}) => {
  const outcome = await page.evaluate(async (cmd, payload) => {
    try { return { value: await window.__TAURI_INTERNALS__.invoke(cmd, payload) }; }
    catch (error) { return { error: typeof error === 'string' ? error : String(error) }; }
  }, command, args);
  if (outcome.error) throw new Error(`${command} 失败：${outcome.error}`);
  return outcome.value;
};
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const localDate = () => {
  const date = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

let session;
let page;
let passed = false;
try {
  session = await start({ runDir, port: 9463 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await invoke(page, 'vocab_inbox_confirm', { request: { date: '2026-11-08', words: [{ word: 'alpha', note: '原有词' }] } });
  await page.evaluate(baseUrl => {
    // launch.mjs 为避免插件写系统 Known Folder 而关闭 http 插件；只在这个开发隔离窗口改用浏览器 fetch。
    window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);
    window.__ES_E2E_NOTION_BASE_URL__ = baseUrl;
  }, `http://127.0.0.1:${port}/v1`);

  await page.clickText(['设置', 'Settings']);
  await page.clickText('中文');
  await page.clickText('导入与转录');
  await page.waitFor('[data-testid=notion-token]');
  await page.type('[data-testid=notion-token]', token);
  await page.type('[data-testid=notion-database-id]', 'main');
  const settingsSafety = await page.evaluate(() => ({
    password: document.querySelector('[data-testid=notion-token]').type === 'password',
    saved: (() => { const c = JSON.parse(localStorage.getItem('linguaclip_notion_config')); return c.databaseId === 'main' && c.token.length > 0; })(),
  }));
  assert.deepEqual(settingsSafety, { password: true, saved: true });
  assert.equal((await page.text('body')).includes(token), false, '页面文本不能显示令牌');
  await page.evaluate(() => document.querySelector('[data-testid=notion-token]').scrollIntoView({ block: 'center' }));
  await page.screenshot(path.join(out, '01-settings.png'));

  await page.clickText('词库');
  await page.clickText('录笔记');
  await page.click('[data-testid=notion-pull]');
  await page.waitFor('[data-testid=inbox-candidates]');
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid^=inbox-candidate-]').length), 4);
  assert.equal(queryBodies.length, 2);
  assert.equal(queryBodies[1].start_cursor, 'cursor-2');
  assert.equal((await page.text('body')).includes('already'), false, '已入库行不拉取');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=inbox-check-3]').disabled), true);
  assert.match(await page.text('[data-testid=inbox-existing-3]'), /已存在/);

  let db = await openDb(session);
  const before = queryRows(db, 'review_word');
  db.close();
  assert.equal(before.length, 1);
  await page.click('[data-testid=inbox-delete-2]');
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid^=inbox-candidate-]').length), 3);
  assert.match(await page.text('[data-testid=inbox-selected-count]'), /已勾选 2 \/ 3 条/);
  db = await openDb(session);
  assert.deepEqual(queryRows(db, 'review_word'), before, '拉取和删除候选都不能写数据库');
  db.close();
  assert.deepEqual(patches, [], '确认前不能勾选 Notion');
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  assert.equal(await noOverflow(page), true);
  await page.screenshot(path.join(out, '02-candidates-390.png'));

  await page.click('[data-testid=inbox-confirm]');
  await page.waitFor('[data-testid=inbox-result]');
  await page.waitText('词库已更新，并只在 Notion 勾选了本次入库的 2 行。');
  assert.match(await page.text('[data-testid=inbox-result]'), /已确认入库 2 条/);
  assert.match(await page.text('[data-testid=inbox-result]'), new RegExp(`Notion ${localDate()}`));
  assert.equal(await noOverflow(page), true);
  await page.screenshot(path.join(out, '03-result-390.png'));

  db = await openDb(session);
  const after = queryRows(db, 'review_word');
  db.close();
  assert.deepEqual(after.map(row => row.word).sort(), ['alpha', 'candid', 'resilient']);
  for (const word of after.filter(row => row.word !== 'alpha')) {
    assert.equal(word.status, '🌱待考察');
    assert.equal(word.source, `Notion ${localDate()}`);
    assert.equal(word.verification_status, '未查证');
    assert.equal(word.issue, 'Notion');
    assert.equal(word.level, null);
  }
  assert.deepEqual(patches.sort(), ['page-candid', 'page-resilient']);
  assert.equal(pages.get('page-obsolete').properties['已入库'].checkbox, false, '删除项不能勾选');
  assert.equal(pages.get('page-alpha').properties['已入库'].checkbox, false, '词库已存在且未确认的项不能勾选');
  assert.equal(pages.get('page-done').properties['已入库'].checkbox, true);
  assert.equal((await page.text('body')).includes(token), false);

  const unexpectedErrors = page.errors.filter(error => error !== 'plugin http not found');
  assert.deepEqual(unexpectedErrors, []);
  const evidence = {
    screenshots: fs.readdirSync(out).filter(name => name.endsWith('.png')).sort(),
    settings: { localSaveVerified: true, passwordInput: true, tokenInPageText: false },
    paginationRequests: queryBodies.length,
    checkedRowsExcluded: ['already'],
    candidateCountBeforeDelete: 4,
    deleted: 'obsolete',
    existingUnchecked: 'alpha',
    databaseUnchangedBeforeConfirm: true,
    savedWords: after.filter(row => row.word !== 'alpha').map(row => ({ word: row.word, status: row.status, source: row.source, verificationStatus: row.verification_status })),
    notionCheckedOnly: patches,
    notionStillUnchecked: ['obsolete', 'alpha'],
    narrowViewport: { width: 390, horizontalOverflow: false },
    unexpectedErrors,
  };
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
  console.log(`真实窗口验证通过，证据：${path.join(out, 'evidence.json')}`);
  passed = true;
} catch (error) {
  if (page) await page.screenshot(path.join(out, 'failure.png')).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  if (session) await stop(session.runDir);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  console.log(`隔离窗口${passed ? '已通过并关闭' : '失败后已关闭'}`);
}