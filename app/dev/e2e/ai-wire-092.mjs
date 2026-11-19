// 092 真实窗口：AI 任务接入小窗。假模型服务（dev/sse-fake-model.mjs），在真实 Tauri 窗口里走：
//   1) 随手记「问 AI」→ 小窗展开到这条 → 回复逐步出现 → 中途切到别的页面再回来 → 随手记卡片上答案完整；
//   2) 词条页「自己写一句」→「让 AI 看看」→ 立刻切到别的页面 → 回到词条：结果和四个按钮都在；
//      小窗里思考在增长；小窗里点「存改后」→ 词条页例句列表出现改好的句子，原句是自己写的，两处按钮变成「已存」；
//      查库：vocab_example 的 source 是「AI改过」，original 是原句；
//   3) 直接问：气泡只显示用户打的字，发给模型的仍带「（关于单词 resilient）」；
//   4) 390 宽手机抽屉：判句结果按钮在抽屉里可见可点；追问框半屏时完整可见、点得到（091 留下的毛病）。
// 在 app 目录：node dev/e2e/ai-wire-092.mjs
// 隔离词库、WebView 数据和截图写在 D:\tmp\es-e2e\092-ai-wire-*\out。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connect } from './cdp.mjs';
import { start, stop } from './launch.mjs';
import { startFakeModel, GRADE_FIXED } from '../sse-fake-model.mjs';

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.join('D:\\tmp\\es-e2e', `092-ai-wire-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
const port = 9492;
const WORD = 'resilient';
const WRONG = 'Our team was very resilient the setback.';
const NOTE = '这个 bounce back 是什么意思？';
const ANSWER = 'Hello, streaming world!';
const DIRECT_Q = '请换个说法解释';
const S = '[data-testid=examples-section]';
const PANEL = '[data-testid=ai-panel]';
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
    const id = 'rv:092-1';
    const raw = `| ${WORD} | adj. | able to recover after difficulty | L1 | ${today} | |`;
    db.prepare(`
      INSERT INTO review_word
        (id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note,
         imported_at, updated_at, deleted, source, verification_status)
      VALUES (?, 1, 1, ?, ?, ?, ?, ?, 'L1', 1, ?, '', ?, ?, 0, '092 隔离回归', '未查证')
    `).run(id, raw, WORD, WORD, issue, today, today, today, today);
    db.prepare(`
      INSERT INTO review_definition (word_id, source_file, source_line, pos, english, chinese)
      VALUES (?, '092-isolated-test.md', 1, 'adj.', 'able to recover after difficulty', '经受打击后能够恢复的')
    `).run(id);
  } finally { db.close(); }
}

function seedNote(session) {
  const db = new DatabaseSync(path.join(session.appData, 'vocab.db'));
  try {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO quick_note (body, created_at, updated_at, device_id) VALUES (?, ?, ?, 'local')").run(NOTE, now, now);
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
/** 点一个按钮（按 innerText 精确匹配，可限定在某个容器里）。 */
const clickButton = (page, text, scope = 'document') => page.evaluate((t, sc) => {
  const root = sc === 'document' ? document : document.querySelector(sc);
  const button = [...(root?.querySelectorAll('button') ?? [])].find(item => item.innerText.trim() === t);
  if (!button) throw new Error(`找不到按钮「${t}」`);
  button.click();
}, text, scope);
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
const thinkChars = page => page.evaluate(() => {
  const text = document.querySelector('[data-testid=ai-panel] [data-testid=ai-think-toggle]')?.innerText ?? '';
  const m = text.match(/思考（(\d+) 字）/);
  return m ? Number(m[1]) : -1;
});
const openWordEntry = async page => {
  await clickButton(page, '浏览');
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
/** 配好模型；判句的请求走 WebView 自己的 fetch 到本机假模型（和 091 一样）。 */
async function prep(fakePort, model) {
  await page.evaluate((portNumber, modelName) => {
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({ apiKey: '092-local-test-key', model: modelName, baseUrl: `http://127.0.0.1:${portNumber}/v1` }));
    window.__ES_E2E_FILL_ONLY__ = true;
    window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);
  }, fakePort, model);
}

try {
  fake = await startFakeModel({ thinkDelayMs: 150, textDelayMs: 300 });
  // 先起一次把库建好，关掉后塞一个词条和一条随手记，再起。
  session = await start({ runDir, port });
  page = await connect({ port: session.port });
  await page.waitReady();
  page.close(); page = null;
  await stop(session.runDir);
  seedWord(session);
  seedNote(session);
  session = await start({ runDir, port });
  page = await connect({ port: session.port });
  await page.waitReady();
  await prep(fake.port, 'fake-stream');
  await page.evaluate(() => { localStorage.removeItem('english-studio.ai-panel.collapsed'); localStorage.removeItem('english-studio.ai-tasks.v1'); });
  await page.setViewport(1440, 900, { mobile: false, dpr: 1 });
  await page.waitUntil('窗口宽 1440', 'window.innerWidth === 1440', { timeout: 10_000 });

  // ---------- 1) 随手记「问 AI」 ----------
  await nav(page, ['词库', 'Vocabulary']);
  await page.click('[data-testid="quicknotes-tab"]');
  await page.waitFor('[data-testid="quicknote-item"]');
  await page.evaluate(() => document.querySelector('[data-testid="quicknote-ask-ai"]').click());
  await page.waitFor(`${PANEL}[data-mode=dock]`);
  await page.waitUntil('小窗展开到这条「问 AI」', `!!document.querySelector('[data-testid=ai-task][data-open="1"]') && (document.querySelector('[data-testid=ai-task][data-open="1"] [data-testid=ai-task-head]')?.innerText ?? '').includes('问 AI：随手记')`, { timeout: 10_000 });
  pass('随手记点「问 AI」：小窗展开到这条任务');
  await page.waitUntil('回复开始出现（小窗里）', `(document.querySelector('[data-testid=ai-task-text]')?.innerText ?? '').length > 0`, { timeout: 10_000 });
  const partial = await textOf(page, '[data-testid=ai-task-text]');
  assert.ok(partial.length > 0 && partial.length < ANSWER.length, `回复应该逐步出现，实际：${partial}`);
  // 中途切到别的页面，再切回来
  await nav(page, ['设置', 'Settings']);
  await page.waitFor(PANEL);
  const statusAway = await taskStatus(page, '问 AI：随手记');
  assert.ok(['running', 'done'].includes(statusAway), `离开页面后任务应还在跑或已完成，实际 ${statusAway}`);
  await nav(page, ['词库', 'Vocabulary']);
  await page.click('[data-testid="quicknotes-tab"]');
  await page.waitUntil('随手记卡片上答案完整', `(document.querySelector('[data-testid="quicknote-ai-answer"]')?.innerText ?? '').includes('${ANSWER}')`, { timeout: 15_000 });
  pass(`随手记：中途切走再回来，卡片上答案完整（离开时状态 ${statusAway}）`);
  await shot('01-quicknote-answer-1440.png');

  // ---------- 2) 直接问：气泡只显示自己打的字；发给模型的带上「关于单词」 ----------
  await openWordEntry(page);
  await page.waitUntil('小窗直接问可用', `!document.querySelector('[data-testid=ai-ask-input]').disabled`, { timeout: 10_000 });
  await page.type('[data-testid=ai-ask-input]', DIRECT_Q);
  await page.click('[data-testid=ai-ask-send]');
  await page.waitUntil('直接问：气泡只写自己打的字', `[...document.querySelectorAll('[data-testid=ai-task-detail] p')].some(p => p.innerText.trim() === '${DIRECT_Q}')`, { timeout: 5_000 });
  const pickSent = () => fake.requests.map(r => r.body?.messages?.at(-1)?.content ?? '').find(c => String(c).includes(`（关于单词 ${WORD}）`));
  for (let i = 0; i < 50 && !pickSent(); i += 1) await sleep(100);
  const sentToModel = pickSent();
  assert.equal(sentToModel, `（关于单词 ${WORD}）${DIRECT_Q}`, '发给模型的仍带上「关于单词」');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('[data-testid=ai-task-detail] p')].some(p => p.innerText.includes('关于单词'))), false, '气泡里没有「关于单词」前缀');
  await page.waitUntil('直接问回复完成', `document.querySelector('[data-testid=ai-task][data-open="1"]')?.dataset.status === 'done'`, { timeout: 15_000 });
  pass('直接问：气泡只显示问题，发给模型的仍带「关于单词 resilient」');

  // ---------- 3) 词条页「让 AI 看看」：立刻切走，回来结果和按钮都在 ----------
  await setModel('fake-grade');
  await page.click(`${S} [data-testid=example-own-open]`);
  await page.type(`${S} [data-testid=own-input]`, WRONG);
  await page.click(`${S} [data-testid=own-check]`);
  await page.waitUntil('按钮变成「在小窗里看进度」', `(document.querySelector('${S} [data-testid=own-check]')?.innerText ?? '').includes('在小窗里看进度')`, { timeout: 5_000 });
  await openTask(page, '让 AI 看：resilient');
  await page.waitUntil('小窗里思考在增长（第一次）', `document.querySelector('[data-testid=ai-panel] [data-testid=ai-think-toggle]') !== null`, { timeout: 10_000 });
  const think1 = await thinkChars(page);
  await sleep(700);
  const think2 = await thinkChars(page);
  assert.ok(think2 > think1, `思考内容应在增长：${think1} → ${think2}`);
  pass(`小窗：思考内容在增长（${think1} → ${think2} 字）`);
  await nav(page, ['设置', 'Settings']);
  await page.waitFor(PANEL);
  await nav(page, ['词库', 'Vocabulary']);
  await openWordEntry(page);
  await page.waitUntil('回到词条：判句结果在', `!!document.querySelector('${S} [data-testid=own-result]')`, { timeout: 30_000 });
  for (const testid of ['own-save-original', 'own-save-fixed', 'own-save-better', 'own-discard']) {
    assert.ok(await exists(page, `${S} [data-testid=${testid}]`), `词条页应有按钮 ${testid}`);
  }
  assert.equal(await textOf(page, `${S} [data-testid=own-verdict]`), '用法或语法有问题');
  assert.equal(await textOf(page, `${S} [data-testid=own-fixed]`), GRADE_FIXED);
  assert.match(await textOf(page, `${S} [data-testid=own-better]`), /remarkably resilient/);
  pass('词条页：离开再回来，判句结果和四个按钮都在');

  // 小窗里看到同一个任务，两处都有按钮
  await openTask(page, '让 AI 看：resilient');
  assert.ok(await exists(page, `${PANEL} [data-testid=own-save-fixed]`), '小窗里同一任务也有「存改后」');
  await page.evaluate(sel => document.querySelector(sel).scrollIntoView({ block: 'center' }), S);
  await shot('02-entry-and-panel-1440.png');
  pass('小窗里同一任务：同样的判定和按钮');

  // 先在 390 宽抽屉里看结果按钮（还没存：四个按钮都在抽屉里、可见、点得到）
  await page.setViewport(390, 844, { mobile: true, dpr: 2 });
  await page.waitUntil('手机：抽屉或小圆按钮出现', `!!document.querySelector('[data-testid=ai-panel][data-mode=mobile], [data-testid=ai-toggle][data-mode=mobile]')`, { timeout: 10_000 });
  // 之前已经展开过（open 还开着）就直接是抽屉；否则点小圆按钮打开。
  if (!(await exists(page, `${PANEL}[data-mode=mobile]`))) await page.click('[data-testid=ai-toggle]');
  await page.waitFor(`${PANEL}[data-mode=mobile]`);
  await openTask(page, '让 AI 看：resilient');
  const sheet = await rect(page, `${PANEL}[data-mode=mobile]`);
  for (const testid of ['own-save-original', 'own-save-fixed', 'own-save-better', 'own-discard']) {
    const box = await rect(page, `${PANEL} [data-testid=${testid}]`);
    assert.ok(box, `抽屉里有按钮 ${testid}`);
    assert.ok(box.top >= sheet.top && box.bottom <= sheet.bottom, `按钮 ${testid} 在抽屉可见范围内：${JSON.stringify({ box, sheet })}`);
  }
  assert.equal(await overflowing(page), false, '390 宽不横向溢出');
  await shot('03-mobile-own-result-390.png');
  pass('手机 390 宽抽屉：判句结果的四个按钮都在抽屉可见范围内');

  // 回到电脑窗口，在侧栏里点「存改后」
  await page.setViewport(1440, 900, { mobile: false, dpr: 1 });
  await page.waitFor(`${PANEL}[data-mode=dock]`);
  await openTask(page, '让 AI 看：resilient');
  await page.click(`${PANEL} [data-testid=own-save-fixed]`);
  await page.waitUntil('词条页那组按钮变成「已存」', `!!document.querySelector('${S} [data-testid=own-saved]') && !document.querySelector('${S} [data-testid=own-save-fixed]')`, { timeout: 10_000 });
  const list = await sentences(page);
  const fixedRow = list.find(item => item.sentence === GRADE_FIXED);
  assert.ok(fixedRow, `词条页例句列表应出现改好的句子，实际 ${JSON.stringify(list)}`);
  assert.equal(fixedRow.source, 'AI改过');
  assert.equal(fixedRow.original, WRONG, '「原句：」是自己写的那句');
  assert.ok(await exists(page, `${PANEL} [data-testid=own-saved]`), '小窗里也变成「已存」');
  pass('小窗存改后：词条页列表出现改好的句子，原句是自己写的，两处变成「已存」');

  // 查库：来源是「AI改过」，原句存了
  const db = new DatabaseSync(path.join(session.appData, 'vocab.db'));
  try {
    const row = db.prepare('SELECT source, original, sentence FROM vocab_example WHERE word = ? AND sentence = ?').get(WORD, GRADE_FIXED);
    assert.ok(row, '库里有这一句');
    assert.equal(row.source, 'AI改过');
    assert.equal(row.original, WRONG);
    const dupes = db.prepare('SELECT COUNT(*) AS n FROM vocab_example WHERE word = ? AND sentence = ?').get(WORD, GRADE_FIXED).n;
    assert.equal(dupes, 1, '只存了一条');
  } finally { db.close(); }
  pass('查库：vocab_example 的 source 是「AI改过」，original 是原句');

  // 「存更地道的」也能存（同一任务、同一个按钮组，换一个分支）：只查它的按钮状态已经变成「已存」，不再重复存
  assert.equal(await exists(page, `${S} [data-testid=own-save-better]`), false, '已存后不再显示按钮');

  // ---------- 4) 手机半屏：091 留下的追问框毛病 ----------
  await page.setViewport(390, 844, { mobile: true, dpr: 2 });
  await page.waitUntil('手机：抽屉或小圆按钮出现（追问）', `!!document.querySelector('[data-testid=ai-panel][data-mode=mobile], [data-testid=ai-toggle][data-mode=mobile]')`, { timeout: 10_000 });
  if (!(await exists(page, `${PANEL}[data-mode=mobile]`))) await page.click('[data-testid=ai-toggle]');
  await page.waitFor(`${PANEL}[data-mode=mobile]`);

  // 091 毛病：半屏抽屉里追问框要完整可见、点得到，不被底部「直接问」区挡住
  await openTask(page, '问 AI：随手记');
  await page.waitUntil('随手记那条已完成', `document.querySelector('[data-testid=ai-task][data-open="1"]')?.dataset.status === 'done'`, { timeout: 10_000 });
  const follow = await rect(page, `${PANEL} [data-testid=ai-followup-input]`);
  const askArea = await rect(page, `${PANEL} [data-testid=ai-ask-input]`);
  const sheetNow = await rect(page, `${PANEL}[data-mode=mobile]`);
  assert.ok(follow, '追问框存在');
  assert.ok(follow.top >= sheetNow.top && follow.bottom <= sheetNow.bottom, `追问框要在半屏抽屉内：${JSON.stringify({ follow, sheetNow })}`);
  assert.ok(follow.bottom <= askArea.top, `追问框不能被底部「直接问」区挡住：${JSON.stringify({ follow, askArea })}`);
  const hit = await page.evaluate(() => {
    const el = document.querySelector('[data-testid=ai-followup-input]');
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!top && (top === el || el.contains(top));
  });
  assert.equal(hit, true, '追问框中间那一点点到的是输入框本身（没被盖住）');
  await shot('04-mobile-followup-390.png');
  pass('手机半屏：追问框完整可见，点得到，不被底部区挡住');

  assert.deepEqual(page.errors.filter(e => /ai\/|aiTasks|AiPanel|OwnCheck|QuickNote/i.test(e)), [], '页面没有和小窗相关的未捕获错误');
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed: true, ...report }, null, 2));
  console.log(`092 真实窗口测试通过，截图在 ${out}`);
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
