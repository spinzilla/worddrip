// 096 真实窗口：教练页「写作练习」。假模型服务（dev/sse-fake-model.mjs 的 fake-writing，慢速吐字），在真实 Tauri 窗口里走：
//   A) 打开教练默认是「写作练习」；「作文批改」「错误档案」内容还在；记住上次选的标签；
//   B) 选「雅思」→ 出一题 → 出题中切到词库再回来 → 题目、中文说明、建议用词出现；小窗里也有这条任务；
//   C) 写 3 句含建议用词 → 批改 → 页面和小窗都有结果块，没有分数字样；
//   D) 结果块点「存成例句」→ 页面和小窗都变「已存」；词条页例句列表出现这句（来源「自己写」，说明里写「写作练习」）；
//   E) 「再写一版」：旧批改留在记录里；
//   F) 再出一题写半截草稿 → 重启应用 → 草稿还在；历史里两条，点开旧的看得到作答和批改；
//   G) 英文界面批改结果块截图；390 宽无横向溢出。
// 在 app 目录：node dev/e2e/writing-096.mjs
// 隔离词库、WebView 数据和截图写在 D:\tmp\es-e2e\096-writing-*\out。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connect } from './cdp.mjs';
import { start, stop } from './launch.mjs';
import { startFakeModel } from '../sse-fake-model.mjs';

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.join('D:\\tmp\\es-e2e', `096-writing-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
const port = 9496;
const WORD = 'resilient';
const ANSWER = 'I believe universities should encourage volunteering. Students need to be resilient when they face real problems. This also helps the local community.';
const MID_SENTENCE = 'Students need to be resilient when they face real problems.';
const DRAFT = 'Draft that must survive a restart.';
const PAGE = '[data-testid=writing-page]';
const PANEL = '[data-testid=ai-panel]';
fs.mkdirSync(out, { recursive: true });

const localDate = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

function seedWord(session) {
  const db = new DatabaseSync(path.join(session.appData, 'vocab.db'));
  try {
    const today = localDate();
    const issue = `${new Date().getMonth() + 1}.${new Date().getDate()}`;
    const raw = `| ${WORD} | adj. | able to recover after difficulty | L1 | ${today} | |`;
    db.prepare(`
      INSERT INTO review_word
        (id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note,
         imported_at, updated_at, deleted, source, verification_status)
      VALUES ('rv:096-1', 1, 1, ?, ?, ?, ?, ?, 'L1', 1, ?, '', ?, ?, 0, '096 隔离回归', '未查证')
    `).run(raw, WORD, WORD, issue, today, today, today, today);
    db.prepare(`
      INSERT INTO review_definition (word_id, source_file, source_line, pos, english, chinese)
      VALUES ('rv:096-1', '096-isolated-test.md', 1, 'adj.', 'able to recover after difficulty', '经受打击后能够恢复的')
    `).run();
  } finally { db.close(); }
}

const nav = (page, names) => page.clickText(names, { selector: 'header nav button', exact: false });
const exists = (page, selector) => page.evaluate(sel => !!document.querySelector(sel), selector);
const count = (page, selector) => page.evaluate(sel => document.querySelectorAll(sel).length, selector);
const textOf = (page, selector) => page.evaluate(sel => document.querySelector(sel)?.innerText ?? '', selector);
const valueOf = (page, selector) => page.evaluate(sel => document.querySelector(sel)?.value ?? '', selector);
const overflowing = page => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
const noAnim = page => page.evaluate(() => { if (document.getElementById('e2e-no-anim')) return; const s = document.createElement('style'); s.id = 'e2e-no-anim'; s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}'; document.head.appendChild(s); });
const pass = text => console.log(`PASS ${text}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const scrollTo = (page, selector) => page.evaluate(sel => document.querySelector(sel)?.scrollIntoView({ block: 'start' }), selector);

let fake;
let session;
let page;
let failed;
const report = { screenshots: [] };
const shot = async name => { await noAnim(page); await page.screenshot(path.join(out, name)); report.screenshots.push(name); };

async function prep() {
  await page.evaluate((portNumber) => {
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({ apiKey: '096-local-test-key', model: 'fake-writing', baseUrl: `http://127.0.0.1:${portNumber}/v1` }));
    window.__ES_E2E_FILL_ONLY__ = true;
    window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);
  }, fake.port);
}
async function launch() {
  session = await start({ runDir, port });
  page = await connect({ port: session.port });
  await page.waitReady();
  await prep();
  await page.setViewport(1440, 900, { mobile: false, dpr: 1 });
  await page.waitUntil('窗口宽 1440', 'window.innerWidth === 1440', { timeout: 10_000 });
}
async function relaunch() {
  page.close(); page = null;
  await stop(session.runDir);
  await launch();
}
const openCoach = async () => { await nav(page, ['教练', 'Coach']); await page.waitFor('[data-testid=coach-page]'); };
const tabSelected = (id) => page.evaluate(i => document.querySelector(`[data-testid=coach-tab-${i}]`)?.getAttribute('aria-selected'), id);
/** 页面里（不在小窗里）当前作答框的批改结果块。 */
const pageReview = `${PAGE} [data-testid=writing-review]`;
const panelReview = `${PANEL} [data-testid=writing-review]`;

try {
  fake = await startFakeModel({ thinkDelayMs: 150, textDelayMs: 300 });
  // 先起一次把库建好，关掉后塞一个词条，再起。
  session = await start({ runDir, port });
  page = await connect({ port: session.port });
  await page.waitReady();
  page.close(); page = null;
  await stop(session.runDir);
  seedWord(session);
  await launch();
  await page.evaluate(() => { localStorage.removeItem('english-studio.ai-panel.collapsed'); });

  // ---------- A) 三个小标签 ----------
  await openCoach();
  assert.equal(await tabSelected('writing'), 'true', '默认打开「写作练习」');
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-testid=coach-tabs] [role=tab]')].map(e => e.innerText.trim())), ['写作练习', '作文批改', '错误档案'], '三个小标签的顺序和名字');
  await page.waitFor('[data-testid=writing-page]');
  await shot('01-coach-tab-writing-empty-1440.png');
  await page.click('[data-testid=coach-tab-essay]');
  await page.waitFor('[data-testid=coach-panel-essay] textarea');
  assert.equal(await tabSelected('essay'), 'true');
  await shot('02-coach-tab-essay-1440.png');
  await page.click('[data-testid=coach-tab-errors]');
  await page.waitFor('[data-testid=coach-empty]');
  await shot('03-coach-tab-errors-1440.png');
  // 记住上次选的标签：切到别的页面再回来仍是「错误档案」
  await nav(page, ['设置', 'Settings']);
  await openCoach();
  assert.equal(await tabSelected('errors'), 'true', '记住上次选的标签');
  await page.click('[data-testid=coach-tab-writing]');
  await page.waitFor('[data-testid=writing-page]');
  pass('教练页：默认「写作练习」，三个小标签都有内容，记住上次选的标签');

  // ---------- B) 选雅思 → 出一题 → 出题中切走再回来 ----------
  await page.click('[data-testid=writing-scene-ielts]');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=writing-scene-ielts]').getAttribute('aria-checked')), 'true');
  await page.click('[data-testid=writing-new]');
  await page.waitFor(`${PANEL}[data-mode=dock]`);
  await page.waitFor(`${PAGE} [data-testid=writing-task-progress]`);
  await page.waitUntil('小窗展开到「写作出题」', `(document.querySelector('[data-testid=ai-task][data-open="1"] [data-testid=ai-task-head]')?.innerText ?? '').includes('写作出题')`, { timeout: 10_000 });
  await nav(page, ['词库', 'Vocabulary']);
  await page.waitFor('[data-testid=vocab-list], button');
  await openCoach();
  await page.waitFor(`${PAGE} [data-testid=writing-prompt]`, { timeout: 30_000 });
  assert.match(await textOf(page, `${PAGE} [data-testid=writing-prompt]`), /volunteer/, '英文题目');
  assert.match(await textOf(page, `${PAGE} [data-testid=writing-chinese]`), /志愿/, '中文说明');
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-testid=writing-word]')].map(e => e.dataset.word)), [WORD], '建议用词');
  await page.click('[data-testid=writing-word]');
  await page.waitUntil('点开建议用词看到英文释义', `(document.querySelector('[data-testid=writing-word-def]')?.innerText ?? '').includes('able to recover')`, { timeout: 5_000 });
  await page.waitUntil('小窗里的出题任务也有题目', `!!document.querySelector('${PANEL} [data-testid=writing-task-card-panel]')`, { timeout: 10_000 });
  pass('选雅思出一题：出题中切到词库再回来，题目、中文说明、建议用词都在，小窗里也有');

  // ---------- C) 作答 → 批改 ----------
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=writing-review-btn]').disabled), true, '没写时不能点批改');
  await page.type('[data-testid=writing-answer]', 'Hi');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=writing-review-btn]').disabled), true, '太短不能点批改');
  await page.type('[data-testid=writing-answer]', ANSWER);
  await page.waitUntil('词数显示', `(document.querySelector('[data-testid=writing-count]')?.innerText ?? '').includes('建议 2–4 句')`, { timeout: 5_000 });
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=writing-review-btn]').disabled), false, '写够了可以点批改');
  await page.click('[data-testid=writing-review-btn]');
  await page.waitUntil('小窗展开到「写作批改」', `(document.querySelector('[data-testid=ai-task][data-open="1"] [data-testid=ai-task-head]')?.innerText ?? '').includes('写作批改')`, { timeout: 10_000 });
  await page.waitFor(pageReview, { timeout: 40_000 });
  await page.waitFor(panelReview, { timeout: 10_000 });
  for (const [name, selector] of [['页面', pageReview], ['小窗', panelReview]]) {
    const text = await textOf(page, selector);
    assert.ok(text.includes('部分回答了题目'), `${name}：是否回答了题目`);
    assert.ok(text.includes('students are'), `${name}：问题的改法`);
    assert.ok(text.includes('更好的写法'), `${name}：更好的写法`);
    assert.ok(!/分数|得分|评分|总分|score|\d+\s*分|\d+\s*\/\s*\d+/i.test(text), `${name}：不能出现分数字样：${text}`);
  }
  assert.equal(await count(page, `${PAGE} [data-testid=writing-issue]`), 3, '最多 3 处问题');
  await scrollTo(page, PAGE + ' [data-testid=writing-current]');
  await shot('04-writing-review-and-panel-1440.png');
  pass('批改：页面和小窗都有结果块，没有分数字样');

  // ---------- D) 存成例句 ----------
  assert.equal(await count(page, `${PAGE} [data-testid=writing-save-item]`), 1, '只有一句含建议用词');
  assert.ok((await textOf(page, `${PAGE} [data-testid=writing-save-item]`)).includes(MID_SENTENCE), '要存的是含 resilient 的那句');
  await page.click(`${PAGE} [data-testid=writing-save]`);
  await page.waitUntil('页面变「已存」', `!!document.querySelector('${PAGE} [data-testid=writing-saved]')`, { timeout: 10_000 });
  await page.waitUntil('小窗也变「已存」', `!!document.querySelector('${PANEL} [data-testid=writing-saved]')`, { timeout: 10_000 });
  const dbA = new DatabaseSync(path.join(session.appData, 'vocab.db'));
  try {
    const rows = dbA.prepare('SELECT word, sentence, source, explanation FROM vocab_example WHERE word = ?').all(WORD);
    assert.equal(rows.length, 1, '库里存了一条例句');
    assert.equal(rows[0].sentence, MID_SENTENCE);
    assert.equal(rows[0].source, '自己写');
    assert.ok(String(rows[0].explanation).includes('写作练习'), `说明里写了「写作练习」：${rows[0].explanation}`);
  } finally { dbA.close(); }
  await nav(page, ['词库', 'Vocabulary']);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '浏览'); if (!b) throw new Error('找不到「浏览」'); b.click(); });
  await page.waitFor('[data-testid=vocab-list]');
  await page.evaluate(w => { const row = [...document.querySelectorAll('[data-testid=vocab-list] > button')].find(x => x.innerText.trim().startsWith(w)); if (!row) throw new Error(`列表里没有 ${w}`); row.click(); }, WORD);
  await page.waitFor('[data-testid=examples-section]');
  await page.waitUntil('词条页例句列表出现这句', `[...document.querySelectorAll('[data-testid=examples-section] [data-testid=example-sentence]')].some(e => e.innerText === ${JSON.stringify(MID_SENTENCE)})`, { timeout: 10_000 });
  const entryItem = await page.evaluate(sentence => {
    const item = [...document.querySelectorAll('[data-testid=examples-section] [data-testid=example-item]')].find(e => e.querySelector('[data-testid=example-sentence]')?.innerText === sentence);
    return item ? item.innerText : '';
  }, MID_SENTENCE);
  assert.ok(entryItem.includes('写作练习'), `词条页例句旁能看到「写作练习」：${entryItem}`);
  pass('存成例句：两处都变「已存」，词条页例句列表出现这句（来源自己写，说明写作练习）');

  // ---------- E) 再写一版：旧批改留在记录里 ----------
  await openCoach();
  await page.waitFor(pageReview);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=writing-answer]').readOnly), true, '批改后作答框只读');
  await page.click('[data-testid=writing-rewrite]');
  await page.waitUntil('作答框可改', `document.querySelector('[data-testid=writing-answer]').readOnly === false`, { timeout: 5_000 });
  await page.type('[data-testid=writing-answer]', `${ANSWER} It builds character as well.`);
  await page.click('[data-testid=writing-review-btn]');
  await page.waitUntil('第二次批改出结果', `!!document.querySelector('${PAGE} [data-testid=writing-review]') && !document.querySelector('${PAGE} [data-testid=writing-review-progress]')`, { timeout: 40_000 });
  await page.waitUntil('旧版本留在记录里', `document.querySelectorAll('${PAGE} [data-testid=writing-version]').length === 1`, { timeout: 10_000 });
  assert.ok((await page.evaluate(() => document.querySelector('[data-testid=writing-versions]').textContent)).includes('volunteering'), '旧版本里有旧作答');
  pass('再写一版：重新批改后旧作答和旧批改留在「之前的版本」里');

  // ---------- F) 出第二题，写半截草稿，重启 ----------
  await page.click('[data-testid=writing-scene-cet]');
  await page.click('[data-testid=writing-new]');
  await page.waitFor(`${PAGE} [data-testid=writing-prompt]`, { timeout: 30_000 });
  await page.waitUntil('当前是新题（四六级）', `document.querySelector('[data-testid=writing-current]')?.dataset.scene === 'cet'`, { timeout: 10_000 });
  await page.type('[data-testid=writing-answer]', DRAFT);
  await sleep(1000); // 草稿 0.4 秒后自动存
  await relaunch();
  await openCoach();
  await page.waitFor(`${PAGE} [data-testid=writing-answer]`, { timeout: 20_000 });
  assert.equal(await valueOf(page, '[data-testid=writing-answer]'), DRAFT, '重启后草稿还在');
  assert.equal(await count(page, `${PAGE} [data-testid=writing-history-item]`), 2, '历史里两条');
  const oldRow = await page.evaluate(() => [...document.querySelectorAll('[data-testid=writing-history-item]')].map(e => ({ id: e.dataset.recordId, text: e.innerText })));
  assert.ok(oldRow[1].text.includes('雅思') && oldRow[1].text.includes('已批改'), `历史里有雅思那条且已批改：${JSON.stringify(oldRow)}`);
  assert.ok(oldRow[0].text.includes('四六级') && oldRow[0].text.includes('未批改'), `历史里有四六级那条且未批改：${JSON.stringify(oldRow)}`);
  await page.evaluate(id => document.querySelector(`[data-testid=writing-history-item][data-record-id="${id}"] [data-testid=writing-history-open]`).click(), oldRow[1].id);
  await page.waitFor(pageReview, { timeout: 10_000 });
  assert.ok((await valueOf(page, '[data-testid=writing-answer]')).includes('volunteering'), '点开旧记录看得到作答');
  assert.ok((await textOf(page, pageReview)).includes('部分回答了题目'), '点开旧记录看得到批改');
  assert.equal(await count(page, `${PAGE} [data-testid=writing-version]`), 1, '旧记录里的旧版本也在');
  pass('重启后：草稿还在，历史里两条，点开旧的看得到题目、作答和批改');

  // ---------- 删除 ----------
  await page.evaluate(id => { const b = document.querySelector(`[data-testid=writing-history-item][data-record-id="${id}"] [data-testid=writing-history-delete]`); b.click(); }, oldRow[0].id);
  await page.evaluate(id => { const b = document.querySelector(`[data-testid=writing-history-item][data-record-id="${id}"] [data-testid=writing-history-delete]`); b.click(); }, oldRow[0].id);
  await page.waitUntil('删除后历史只剩一条', `document.querySelectorAll('[data-testid=writing-history-item]').length === 1`, { timeout: 5_000 });
  pass('历史：二次确认后可以删除');

  // ---------- G) 英文界面 + 390 宽 ----------
  await page.evaluate(() => { localStorage.setItem('linguaclip_lang', 'en'); });
  await page.reload();
  await page.waitReady();
  await prep();
  await page.setViewport(1440, 900, { mobile: false, dpr: 1 });
  await openCoach();
  await page.waitFor(pageReview, { timeout: 20_000 });
  assert.ok((await textOf(page, pageReview)).includes('Partly answers the question'), '英文界面：批改结果块是英文');
  assert.ok((await textOf(page, `${PAGE} [data-testid=writing-save-list], ${PAGE} [data-testid=writing-review-issues]`)).length > 0);
  await scrollTo(page, PAGE + ' [data-testid=writing-review-area]');
  await shot('05-en-writing-review-1440.png');
  await page.evaluate(() => { localStorage.setItem('linguaclip_lang', 'zh'); });
  await page.reload();
  await page.waitReady();
  await prep();
  await page.setViewport(390, 844, { mobile: true, dpr: 2 });
  await openCoach();
  await page.waitFor(pageReview, { timeout: 20_000 });
  assert.equal(await overflowing(page), false, '390 宽写作练习页不横向溢出');
  const box = await page.evaluate(() => { const r = document.querySelector('[data-testid=writing-answer]').getBoundingClientRect(); return { w: r.width, h: r.height }; });
  assert.ok(box.w > 250 && box.h >= 120, `手机上作答框够大：${JSON.stringify(box)}`);
  await shot('06-mobile-writing-390.png');
  await page.click('[data-testid=coach-tab-essay]');
  assert.equal(await overflowing(page), false, '390 宽作文批改页不横向溢出');
  await page.click('[data-testid=coach-tab-errors]');
  assert.equal(await overflowing(page), false, '390 宽错误档案页不横向溢出');
  await page.click('[data-testid=coach-tab-writing]');
  pass('英文界面结果块是英文；390 宽三个标签都不横向溢出');

  const bad = page.errors.filter(e => !e.includes('plugin http not found'));
  assert.deepEqual(bad, [], `页面不应有未捕获异常：${bad.join('\n')}`);
  assert.ok(fake.requests.some(r => r.body?.model === 'fake-writing'), '请求确实发到了假模型');
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed: true, ...report }, null, 2));
  console.log(`096 真实窗口测试通过，截图在 ${out}`);
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
