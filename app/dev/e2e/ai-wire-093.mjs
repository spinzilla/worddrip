// 093 真实窗口：「AI 给例句」和英英释义「AI 帮我看看」接入小窗。假模型服务（dev/sse-fake-model.mjs，慢速吐字），在真实 Tauri 窗口里走：
//   A) 词条页「AI 给例句」→ 立刻切到别的页面再回来 → 候选还在；小窗里勾一条存 → 词条页例句列表出现（来源 AI生成），
//      词条页那条变「已存」，剩下的仍可勾；
//   B) 英英释义「AI 帮我看看」→ 释义区和小窗都有结果 → 词条页点「用这个替换」→ 释义变了，小窗那条变「已替换」；
//   C) 自己写一句 → 让 AI 看看 → 小窗结果块有「原句：」→ 存改后 → 输入框清空；
//   D) 小窗收起时点「AI 给例句」→ 小窗打开并定位到这条新任务；
//   E) 英文界面下判句结果块（文案英文）截图；
//   F) 390 宽手机抽屉里给例句候选（截图）。
// 在 app 目录：node dev/e2e/ai-wire-093.mjs
// 隔离词库、WebView 数据和截图写在 D:\tmp\es-e2e\093-ai-wire-*\out。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connect } from './cdp.mjs';
import { start, stop } from './launch.mjs';
import { startFakeModel, GRADE_FIXED, DEF_FIX_SUGGESTION } from '../sse-fake-model.mjs';

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.join('D:\\tmp\\es-e2e', `093-ai-wire-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
const port = 9493;
const WORD = 'resilient';
const WRONG = 'Our team was very resilient the setback.';
const MINE_DEF = 'able to bounce back quickly after problems';
const GEN_FIRST = `The ${WORD} for today's lecture was reviewed in class.`;
const S = '[data-testid=examples-section]';
const PANEL = '[data-testid=ai-panel]';
const GEN_TITLE = 'AI 给例句：resilient';
const OWN_TITLE = '让 AI 看：resilient';
const DEF_TITLE = 'AI 看释义：resilient';
fs.mkdirSync(out, { recursive: true });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const localDate = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

function seedWord(session) {
  const db = new DatabaseSync(path.join(session.appData, 'vocab.db'));
  try {
    const today = localDate();
    const issue = `${new Date().getMonth() + 1}.${new Date().getDate()}`;
    const id = 'rv:093-1';
    const raw = `| ${WORD} | adj. | able to recover after difficulty | L1 | ${today} | |`;
    db.prepare(`
      INSERT INTO review_word
        (id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note,
         imported_at, updated_at, deleted, source, verification_status)
      VALUES (?, 1, 1, ?, ?, ?, ?, ?, 'L1', 1, ?, '', ?, ?, 0, '093 隔离回归', '未查证')
    `).run(id, raw, WORD, WORD, issue, today, today, today, today);
    db.prepare(`
      INSERT INTO review_definition (word_id, source_file, source_line, pos, english, chinese)
      VALUES (?, '093-isolated-test.md', 1, 'adj.', 'able to recover after difficulty', '经受打击后能够恢复的')
    `).run(id);
  } finally { db.close(); }
}

const nav = (page, names) => page.clickText(names, { selector: 'header nav button', exact: false });
const exists = (page, selector) => page.evaluate(sel => !!document.querySelector(sel), selector);
const textOf = (page, selector) => page.evaluate(sel => document.querySelector(sel)?.innerText ?? '', selector);
const rect = (page, selector) => page.evaluate(sel => {
  const element = document.querySelector(sel);
  if (!element) return null;
  const r = element.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
}, selector);
const overflowing = page => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
const sentences = page => page.evaluate(sel => [...document.querySelectorAll(`${sel} [data-testid=example-item]`)].map(item => ({
  sentence: item.querySelector('[data-testid=example-sentence]').innerText,
  source: item.querySelector('[data-testid=example-source]').innerText,
  original: item.querySelector('[data-testid=example-original]')?.innerText ?? '',
})), S);
/** 小窗里找到标题含 text 的任务，没展开就点开。 */
const openTask = (page, text) => page.evaluate(t => {
  const row = [...document.querySelectorAll('[data-testid=ai-task]')].find(item => item.querySelector('[data-testid=ai-task-head]')?.innerText.includes(t));
  if (!row) throw new Error(`小窗里没有「${t}」`);
  if (row.dataset.open !== '1') row.querySelector('[data-testid=ai-task-head]').click();
}, text);
const taskStatus = (page, text) => page.evaluate(t => {
  const row = [...document.querySelectorAll('[data-testid=ai-task]')].find(item => item.querySelector('[data-testid=ai-task-head]')?.innerText.includes(t));
  return row?.dataset.status ?? null;
}, text);
/** 词条页（不在小窗里）的元素：点一下 / 读文字 / 数个数。 */
const clickEntry = (page, sel) => page.evaluate(s => {
  const el = [...document.querySelectorAll(s)].find(x => !x.closest('[data-testid=ai-panel]'));
  if (!el) throw new Error(`词条页找不到 ${s}`);
  el.click();
}, sel);
const entryText = (page, sel) => page.evaluate(s => [...document.querySelectorAll(s)].find(x => !x.closest('[data-testid=ai-panel]'))?.innerText ?? '', sel);
const entryCount = (page, sel) => page.evaluate(s => [...document.querySelectorAll(s)].filter(x => !x.closest('[data-testid=ai-panel]')).length, sel);
/** 小窗里的元素：点一下 / 读文字 / 数个数。 */
const clickPanel = (page, sel) => page.evaluate(s => {
  const el = document.querySelector(`[data-testid=ai-panel] ${s}`);
  if (!el) throw new Error(`小窗里找不到 ${s}`);
  el.click();
}, sel);
const panelText = (page, sel) => page.evaluate(s => document.querySelector(`[data-testid=ai-panel] ${s}`)?.innerText ?? '', sel);
const panelCount = (page, sel) => page.evaluate(s => document.querySelectorAll(`[data-testid=ai-panel] ${s}`).length, sel);
const openWordEntry = async page => {
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.innerText.trim() === '浏览');
    if (!button) throw new Error('找不到按钮「浏览」');
    button.click();
  });
  await page.waitFor('[data-testid=vocab-list]');
  await page.evaluate(w => {
    const row = [...document.querySelectorAll('[data-testid=vocab-list] > button')].find(item => item.innerText.trim().startsWith(w));
    if (!row) throw new Error(`列表里没有 ${w}`);
    row.click();
  }, WORD);
  await page.waitFor(S);
};

const noAnim = page => page.evaluate(() => { if (document.getElementById('e2e-no-anim')) return; const s = document.createElement('style'); s.id = 'e2e-no-anim'; s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}'; document.head.appendChild(s); });
const pass = text => console.log(`PASS ${text}`);

let fake;
let session;
let page;
let failed;
const report = { screenshots: [] };
const shot = async (name) => { await noAnim(page); await page.screenshot(path.join(out, name)); report.screenshots.push(name); };
const setModel = (name) => page.evaluate(model => {
  const cfg = JSON.parse(localStorage.getItem('linguaclip_ai_config'));
  localStorage.setItem('linguaclip_ai_config', JSON.stringify({ ...cfg, model }));
}, name);
/** 配好模型；请求走 WebView 自己的 fetch 到本机假模型（和 092 一样）。 */
async function prep(fakePort, model) {
  await page.evaluate((portNumber, modelName) => {
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({ apiKey: '093-local-test-key', model: modelName, baseUrl: `http://127.0.0.1:${portNumber}/v1` }));
    window.__ES_E2E_FILL_ONLY__ = true;
    window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);
  }, fakePort, model);
}

try {
  fake = await startFakeModel({ thinkDelayMs: 150, textDelayMs: 300 });
  // 先起一次把库建好，关掉后塞一个词条，再起。
  session = await start({ runDir, port });
  page = await connect({ port: session.port });
  await page.waitReady();
  page.close(); page = null;
  await stop(session.runDir);
  seedWord(session);
  session = await start({ runDir, port });
  page = await connect({ port: session.port });
  await page.waitReady();
  await prep(fake.port, 'fake-examples');
  await page.evaluate(() => { localStorage.removeItem('english-studio.ai-panel.collapsed'); localStorage.removeItem('english-studio.ai-tasks.v1'); });
  await page.setViewport(1440, 900, { mobile: false, dpr: 1 });
  await page.waitUntil('窗口宽 1440', 'window.innerWidth === 1440', { timeout: 10_000 });

  // ---------- A) AI 给例句：切走再回来候选还在；小窗里勾一条存 ----------
  await nav(page, ['词库', 'Vocabulary']);
  await openWordEntry(page);
  await clickEntry(page, '[data-testid=example-ai-open]');
  await page.waitFor(`${S} [data-testid=example-panel-generate]`);
  await clickEntry(page, '[data-testid=example-generate]');
  await page.waitFor(`${PANEL}[data-mode=dock]`);
  await page.waitUntil('小窗展开到「AI 给例句」', `(document.querySelector('[data-testid=ai-task][data-open="1"] [data-testid=ai-task-head]')?.innerText ?? '').includes('${GEN_TITLE}')`, { timeout: 10_000 });
  pass('词条页点「AI 给例句」：小窗展开到这条任务');
  // 立刻切走，再切回来
  await nav(page, ['设置', 'Settings']);
  await page.waitFor(PANEL);
  const statusAway = await taskStatus(page, GEN_TITLE);
  assert.ok(['running', 'queued', 'done'].includes(statusAway), `离开页面后任务应还在跑或已完成，实际 ${statusAway}`);
  await nav(page, ['词库', 'Vocabulary']);
  await openWordEntry(page);
  await page.waitUntil('离开再回来，候选列表还在', `document.querySelectorAll('[data-testid=examples-section] [data-testid=generated-item]').length === 3`, { timeout: 30_000 });
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid=examples-section] [data-testid=generated-check]').length), 3, '三句候选都有勾选框');
  pass(`AI 给例句：立刻切走再回来（离开时状态 ${statusAway}），候选和勾选框还在`);

  // 小窗里勾第一句，点「存勾选的 1 句」
  await openTask(page, GEN_TITLE);
  await page.waitUntil('小窗里有三句候选', `document.querySelectorAll('[data-testid=ai-panel] [data-testid=generated-item]').length === 3`, { timeout: 5_000 });
  await clickPanel(page, '[data-testid=generated-check]');
  await page.waitUntil('小窗里的保存按钮写着「存勾选的 1 句」', `(document.querySelector('[data-testid=ai-panel] [data-testid=generated-save]')?.innerText ?? '').includes('存勾选的 1 句')`, { timeout: 5_000 });
  await clickPanel(page, '[data-testid=generated-save]');
  await page.waitUntil('词条页例句列表出现 AI 给的这一句', `[...document.querySelectorAll('[data-testid=examples-section] [data-testid=example-item]')].some(i => i.querySelector('[data-testid=example-sentence]')?.innerText === ${JSON.stringify(GEN_FIRST)})`, { timeout: 10_000 });
  const list = await sentences(page);
  const genRow = list.find(item => item.sentence === GEN_FIRST);
  assert.equal(genRow.source, 'AI生成', '来源是 AI生成');
  await page.waitUntil('词条页那一句变「已存」，其余两句仍可勾', `document.querySelectorAll('[data-testid=examples-section] [data-testid=generated-saved]').length === 1 && document.querySelectorAll('[data-testid=examples-section] [data-testid=generated-check]').length === 2`, { timeout: 10_000 });
  assert.equal(await textOf(page, '[data-testid=examples-section] [data-testid=generated-saved]'), '已存', '已存标记');
  assert.equal(await panelCount(page, '[data-testid=generated-saved]'), 1, '小窗里那一句也变「已存」');
  const dbA = new DatabaseSync(path.join(session.appData, 'vocab.db'));
  try {
    const n = dbA.prepare('SELECT COUNT(*) AS n FROM vocab_example WHERE word = ? AND sentence = ? AND source = ?').get(WORD, GEN_FIRST, 'AI生成').n;
    assert.equal(n, 1, '库里只存了一条 AI生成');
  } finally { dbA.close(); }
  await page.evaluate(() => document.querySelector('[data-testid=examples-section] [data-testid=generated-result]')?.scrollIntoView({ block: 'center' }));
  await shot('01-entry-and-panel-generated-1440.png');
  pass('小窗存勾选：词条页列表出现 AI生成 的句子，那一句变「已存」，库里只一条');

  // ---------- B) 英英释义「AI 帮我看看」：两处都有结果；词条页点「用这个替换」 ----------
  // 先在释义区写一条自己的英英释义（没有就没有「AI 帮我看看」按钮）
  await clickEntry(page, '[data-testid=def-en-open]');
  await page.type('[data-testid=def-en-new-text]', MINE_DEF);
  await clickEntry(page, '[data-testid=def-en-add]');
  await page.waitUntil('自己写的英英释义出现', `[...document.querySelectorAll('[data-testid=def-en-mine]')].length >= 1`, { timeout: 10_000 });
  await setModel('fake-defcheck');
  await clickEntry(page, '[data-testid=def-en-ai]');
  await page.waitUntil('释义区有 AI 的建议', `!!document.querySelector('[data-testid=def-en-check] [data-testid=def-en-suggestion]')`, { timeout: 30_000 });
  await page.waitUntil('小窗里也有同一份结果', `!!document.querySelector('[data-testid=ai-panel] [data-testid=def-en-check] [data-testid=def-en-suggestion]')`, { timeout: 10_000 });
  assert.equal(await entryText(page, '[data-testid=def-en-suggestion]'), DEF_FIX_SUGGESTION, '释义区的建议');
  assert.equal(await panelText(page, '[data-testid=def-en-suggestion]'), DEF_FIX_SUGGESTION, '小窗里的建议');
  assert.equal(await textOf(page, '[data-testid=def-en-mine] [data-testid=def-en-text]'), MINE_DEF, '替换前释义没变');
  pass('帮看释义：释义区和小窗里都有判断和改写建议');

  await clickEntry(page, '[data-testid=def-en-apply]');
  await page.waitUntil('释义变成建议的那句', `document.querySelector('[data-testid=def-en-mine] [data-testid=def-en-text]')?.innerText === ${JSON.stringify(DEF_FIX_SUGGESTION)}`, { timeout: 10_000 });
  await page.waitUntil('小窗那条变「已替换」', `!!document.querySelector('[data-testid=ai-panel] [data-testid=def-en-replaced]')`, { timeout: 10_000 });
  assert.equal(await panelCount(page, '[data-testid=def-en-apply]'), 0, '替换后小窗里不再有「用这个替换」');
  pass('帮看释义：词条页点「用这个替换」→ 释义变了，小窗那条变「已替换」');
  await shot('02-entry-definition-check-1440.png');

  // ---------- C) 自己写一句 → 让 AI 看看 → 小窗有「原句：」→ 存改后 → 输入框清空 ----------
  await setModel('fake-grade');
  await clickEntry(page, '[data-testid=example-own-open]');
  await page.type(`${S} [data-testid=own-input]`, WRONG);
  await clickEntry(page, '[data-testid=own-check]');
  await openTask(page, OWN_TITLE);
  await page.waitUntil('判句结果块在小窗里', `!!document.querySelector('[data-testid=ai-panel] [data-testid=own-result]')`, { timeout: 30_000 });
  assert.equal(await panelText(page, '[data-testid=own-original]'), `原句：${WRONG}`, '小窗结果块上面有「原句：」');
  await clickPanel(page, '[data-testid=own-save-fixed]');
  await page.waitUntil('词条页那组变「已存」', `!!document.querySelector('[data-testid=examples-section] [data-testid=own-saved]')`, { timeout: 10_000 });
  await page.waitUntil('输入框清空', `document.querySelector('[data-testid=examples-section] [data-testid=own-input]')?.value === ''`, { timeout: 5_000 });
  const fixedRow = (await sentences(page)).find(item => item.sentence === GRADE_FIXED);
  assert.ok(fixedRow, '词条页例句列表出现改好的句子');
  assert.equal(fixedRow.source, 'AI改过');
  assert.equal(fixedRow.original, WRONG);
  pass('自己写一句：小窗有「原句：」，存改后后输入框清空，两处变「已存」');

  // ---------- D) 小窗收起时点「AI 给例句」→ 小窗打开并定位到这条新任务 ----------
  await clickPanel(page, '[data-testid=ai-collapse]');
  await page.waitFor('[data-testid=ai-toggle][data-mode=dock]');
  assert.equal(await exists(page, PANEL), false, '小窗已收起');
  const before = await page.evaluate(() => [...document.querySelectorAll('[data-testid=ai-task]')].map(item => item.dataset.taskId));
  await setModel('fake-examples'); // C 里切到了判句的假模型，这里要换回给例句的
  if (!(await exists(page, '[data-testid=examples-section] [data-testid=example-panel-generate]'))) await clickEntry(page, '[data-testid=example-ai-open]');
  await clickEntry(page, '[data-testid=example-generate]');
  await page.waitFor(`${PANEL}[data-mode=dock]`);
  await page.waitUntil('小窗展开到刚建的这条「AI 给例句」', `(document.querySelector('[data-testid=ai-task][data-open="1"] [data-testid=ai-task-head]')?.innerText ?? '').includes('${GEN_TITLE}')`, { timeout: 10_000 });
  const newId = await page.evaluate(() => document.querySelector('[data-testid=ai-task]')?.dataset.taskId ?? '');
  const openId = await page.evaluate(() => document.querySelector('[data-testid=ai-task][data-open="1"]')?.dataset.taskId ?? '');
  assert.ok(newId && !before.includes(newId), '这是一条新任务');
  assert.equal(openId, newId, '展开的正是这条新任务');
  await page.waitUntil('这条新任务跑完（后面切语言要重载，不能中断）', `document.querySelector('[data-testid=ai-task][data-open="1"]')?.dataset.status === 'done'`, { timeout: 30_000 });
  pass('小窗收起时点「AI 给例句」：小窗打开并定位到这条新任务');

  // ---------- E) 英文界面下的判句结果块 ----------
  await page.evaluate(() => { localStorage.setItem('linguaclip_lang', 'en'); });
  await page.reload();
  await page.waitReady();
  await prep(fake.port, 'fake-grade');
  await page.setViewport(1440, 900, { mobile: false, dpr: 1 });
  await page.waitUntil('英文界面：小窗有判句任务', `!!document.querySelector('[data-testid=ai-panel][data-mode=dock]')`, { timeout: 10_000 });
  await openTask(page, OWN_TITLE);
  await page.waitUntil('英文判句结果块', `(document.querySelector('[data-testid=ai-panel] [data-testid=own-verdict]')?.innerText ?? '') === 'Usage or grammar problem'`, { timeout: 10_000 });
  assert.match(await panelText(page, '[data-testid=own-original]'), /^Original: /, '英文界面下「原句」是英文');
  assert.equal(await panelText(page, '[data-testid=own-saved]'), 'Saved', '英文界面下「已存」是 Saved');
  await shot('03-en-own-result-1440.png');
  pass('英文界面：判句结果块的文案是英文');
  await page.evaluate(() => { localStorage.setItem('linguaclip_lang', 'zh'); });
  await page.reload();
  await page.waitReady();
  await prep(fake.port, 'fake-examples');

  // ---------- F) 390 宽手机抽屉里给例句候选 ----------
  await page.setViewport(390, 844, { mobile: true, dpr: 2 });
  await page.waitUntil('手机：抽屉或小圆按钮出现', `!!document.querySelector('[data-testid=ai-panel][data-mode=mobile], [data-testid=ai-toggle][data-mode=mobile]')`, { timeout: 10_000 });
  if (!(await exists(page, `${PANEL}[data-mode=mobile]`))) await page.click('[data-testid=ai-toggle]');
  await page.waitFor(`${PANEL}[data-mode=mobile]`);
  await openTask(page, GEN_TITLE);
  await page.waitUntil('抽屉里有三句候选', `document.querySelectorAll('[data-testid=ai-panel][data-mode=mobile] [data-testid=generated-item]').length === 3`, { timeout: 10_000 });
  const sheet = await rect(page, `${PANEL}[data-mode=mobile]`);
  const firstCheck = await rect(page, `${PANEL} [data-testid=generated-check]`);
  assert.ok(firstCheck && firstCheck.top >= sheet.top && firstCheck.bottom <= sheet.bottom, `候选勾选框在抽屉可见范围内：${JSON.stringify({ firstCheck, sheet })}`);
  assert.equal(await overflowing(page), false, '390 宽不横向溢出');
  await shot('04-mobile-generated-390.png');
  pass('手机 390 宽抽屉：给例句候选在可见范围内');

  assert.deepEqual(page.errors.filter(e => /ai\/|aiTasks|AiPanel|OwnCheck|ExampleGen|DefCheck|vocab/i.test(e)), [], '页面没有和小窗相关的未捕获错误');
  assert.ok(fake.requests.some(r => r.body?.model === 'fake-examples'), '请求确实发到了假模型');
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed: true, ...report }, null, 2));
  console.log(`093 真实窗口测试通过，截图在 ${out}`);
} catch (error) {
  failed = error;
  console.error('FAIL', error);
  if (page) await page.screenshot(path.join(out, '99-failure.png')).catch(() => {});
  process.exitCode = 1;
} finally {
  page?.close();
  if (session) await stop(session.runDir).catch(error => { console.error('停止隔离窗口失败：', error.message); process.exitCode = 1; });
  await fake?.close();
  if (failed) fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed: false, failure: failed.message, ...report }, null, 2));
}
