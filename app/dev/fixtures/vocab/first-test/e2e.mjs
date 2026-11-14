// 047 真实窗口验证：隔离数据目录 + 本机假模型。
// 词库有两期 🌱待考察（8.25 共 9 个、9.24 共 2 个），默认选最早的 8.25，每批 7 个。
// 先验证预习中途退出不写库；正式一轮预习 2 个词，作答 4 对 3 错，看过的 1 对 1 错。
// 再跳过预习考完剩余 4 词，核对旧规则、重启持久化和 1280 / 390 截图。
// 用法（在 app 目录）：node dev/fixtures/vocab/first-test/e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { start, stop, restart } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { openDb, queryRows } from '../../../e2e/db.mjs';

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.resolve('src-tauri/target/e2e', `047-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const plusDays = days => {
  const date = new Date(`${localDate()}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDate(date);
};
const today = localDate();
const KEY = 'dummy-e2e-key-047';

// 8.25 期 9 个新词；9.24 期 2 个。顺序就是 ord，第一批 7 个是前 7 行。
const issueWords = [
  ['exacerbate', '8.25', 'Without more investment, the policy could exacerbate the housing shortage.'],
  ['mitigate', '8.25', 'Governments introduced new measures to mitigate the effects of rising prices.'],
  ['comprise', '8.25', 'The course will comprise six core modules and two electives.'],
  ['sustain', '8.25', 'Few small farms can sustain such high costs for long.'],
  ['allocate', '8.25', 'The council will allocate funds to the new library project.'],
  ['evaluate', '8.25', 'Researchers must evaluate the evidence before publishing conclusions.'],
  ['resilient', '8.25', 'Island economies must become more resilient to cope with storms.'],
  ['derive', '8.25', 'Many English words derive from Latin roots.'],
  ['clarify', '8.25', 'The teacher will clarify the instructions before the test.'],
  ['advocate', '9.24', 'Many doctors advocate a balanced diet and regular exercise.'],
  ['constrain', '9.24', 'Limited funding may constrain the scope of the project.'],
];
const reviewWords = issueWords.map(([word, issue], index) => ({
  id: `${word}@${issue}`, word, status: '🌱待考察', level: null, note: `${word} 的新词备注`,
  line: index + 2, raw: `| ${word} | ${issue} | ${today} | 🌱待考察 | — |`, issue, addedAt: today, due: '',
}));
const importRequest = {
  upgrade: { fileName: 'empty-upgrade.md', content: '# 学术升级库\n' },
  review: { fileName: 'first-test-032.md', content: '# 词汇总词库\n' },
  entries: [{ id: 'dummy@1.1', line: 2, raw: '| dummy |', plain: 'dummy', upgrade: 'dummy', source: '测试', note: '' }],
  examples: [], selfChecks: [], reviewWords, warnings: { upgrade: [], review: [] },
};
const issueFiles = [
  {
    fileName: '20260825.md',
    content: `## 词单分析\n${issueWords.slice(0, 9).map(([word, , sentence], index) => `${index + 1}. **${word}** v. — meaning of ${word}（意思 ${index + 1}）；*${sentence}*`).join('\n')}\n`,
  },
  {
    fileName: '20260924.md',
    content: `## 词单分析\n${issueWords.slice(9).map(([word, , sentence], index) => `${index + 1}. **${word}** v. — meaning of ${word}（意思 ${index + 1}）；*${sentence}*`).join('\n')}\n`,
  },
];

// ---- 本机假 OpenAI 兼容服务：只用于复检时给 mitigate 写新语境句 ----
const modelCalls = [];
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(req.headers.authorization, `Bearer ${KEY}`);
  const prompt = payload.messages[0].content;
  const items = JSON.parse(prompt.slice(prompt.indexOf('Items:') + 'Items:'.length));
  modelCalls.push(items.map(item => item.id));
  res.setHeader('Content-Type', 'application/json');
  const questions = items.map(item => ({
    id: item.id,
    meaning: 'to make something less harmful',
    sentence: 'Planting trees along the river can [[mitigate]] the damage caused by seasonal floods.',
  }));
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questions }) } }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const modelPort = typeof address === 'object' && address ? address.port : 0;

const log = [];
const note = (key, value) => { const line = `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`; log.push(line); console.log(line); };
const invoke = async (page, command, args = {}) => {
  const outcome = await page.evaluate(async (cmd, payload) => {
    try { return { value: await window.__TAURI_INTERNALS__.invoke(cmd, payload) }; }
    catch (error) { return { error: typeof error === 'string' ? error : String(error) }; }
  }, command, args);
  if (outcome.error) throw new Error(`${command} 失败：${outcome.error}`);
  return outcome.value;
};
const shot = (page, name) => page.screenshot(path.join(out, name), { full: false });
const scrollTo = (page, selector) => page.evaluate(sel => document.querySelector(sel)?.scrollIntoView({ block: 'start' }), selector);
const waitNextEnabled = page => page.waitUntil('「保存并下一屏」可点', `(() => { const b = document.querySelector('[data-testid=recall-next]'); return !!b && !b.disabled; })()`);
const noOverflow = (page, selector = '[data-testid=recall]') => page.evaluate(root => document.documentElement.scrollWidth <= document.documentElement.clientWidth
  && [...document.querySelectorAll(`${root} *`)].every(e => e.getBoundingClientRect().right <= document.documentElement.clientWidth + 1), selector);
const readState = async session => {
  const db = await openDb(session);
  const state = {
    words: Object.fromEntries(queryRows(db, 'review_word').map(row => [row.word, `${row.status}/${row.due}`])),
    logs: queryRows(db, 'review_log'),
    events: queryRows(db, 'review_event'),
    notes: queryRows(db, 'vocab_note'),
    reviewNotes: Object.fromEntries(queryRows(db, 'review_word').map(row => [row.word, row.note])),
  };
  db.close();
  return state;
};
const selectOptions = page => page.evaluate(() => {
  const select = document.querySelector('[data-testid=first-test-issue]');
  return { value: select.value, options: [...select.options].map(option => option.textContent.trim()) };
});

let session;
let page;
let passed = false;
try {
  note('本机今天', today);
  session = await start({ runDir, port: 9467 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.clickText('词库', { timeout: 60000 });
  const report = await invoke(page, 'vocab_import', { request: importRequest });
  assert.equal(report.reviewWords.added, 11);
  const definitions = await invoke(page, 'vocab_definition_import', { request: { issues: issueFiles, eagp: null } });
  assert.equal(definitions.examplesAdded, 11);
  await invoke(page, 'vocab_note_add', { request: { word: 'exacerbate', body: '预习时要看到的用户笔记', source: '词库' } });
  await page.reload();
  await page.clickText('词库');
  await page.waitUntil('新词区读到 11 个', `document.querySelector('[data-testid=seed-count]')?.innerText.includes('待首考 11 个')`);
  await page.evaluate(baseUrl => {
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({ baseUrl, apiKey: 'dummy-e2e-key-047', model: 'fake-first-test', temperature: 0.7 }));
    window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);
    // 038 起配了模型会混入改写/造句题；本脚本专测填空流程，用开发钩子只出填空（改写/造句见 dev/fixtures/vocab/usage/e2e.mjs）。
    window.__ES_E2E_FILL_ONLY__ = true;
  }, `http://127.0.0.1:${modelPort}/v1`);

  // ---------------- 选期：默认最早的一期 8.25，每期显示剩余 🌱 ----------------
  const picker = await selectOptions(page);
  note('选期下拉框', picker);
  assert.equal(picker.value, '8.25', '默认选最早、还有新词的一期');
  assert.deepEqual(picker.options, ['8.25 期 · 新词 9', '9.24 期 · 新词 2', '全部按期号顺序 · 新词 11']);
  assert.match(await page.text('[data-testid=first-test-hint]'), /每次 7 个，按期内原顺序/);
  await shot(page, '01-issue-selection.png');

  // ---------------- 预习截图与中途退出：只读，review_log 不能增加 ----------------
  await page.click('[data-testid=first-test-start]');
  await page.waitFor('[data-testid=first-test-preview]');
  assert.equal(await page.text('[data-testid=first-preview-word]'), 'exacerbate');
  assert.equal(await page.text('[data-testid=first-preview-progress]'), '1 / 7');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=recall]') === null), true, '预习时不渲染题目');
  assert.match(await page.text('[data-testid=first-test-preview]'), /看过释义的词，这次答对也先进 L1，两天后再确认/);
  await shot(page, '01b-preview-1280-word.png');
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  assert.equal(await noOverflow(page, '[data-testid=first-test-preview]'), true, '390 未看释义不横向溢出');
  await shot(page, '01c-preview-390-word.png');
  await page.click('[data-testid=first-preview-reveal]');
  await page.waitFor('[data-testid=first-preview-definition]');
  assert.match(await page.text('[data-testid=first-preview-definition]'), /v\.\s*meaning of exacerbate.*意思 1/s);
  assert.match(await page.text('[data-testid=first-preview-examples]'), /Without more investment/);
  await page.waitUntil('用户笔记读取完成', `document.querySelector('[data-testid=first-preview-notes]')?.innerText.includes('预习时要看到的用户笔记')`);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=first-preview-reveal]') === null), true, '看释义后只保留下一个等操作');
  assert.equal(await noOverflow(page, '[data-testid=first-test-preview]'), true, '390 已看释义不横向溢出');
  await shot(page, '01d-preview-390-definition.png');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await shot(page, '01e-preview-1280-definition.png');
  await page.click('[data-testid=first-preview-next]');
  assert.equal(await page.text('[data-testid=first-preview-word]'), 'mitigate');
  const beforeExit = await readState(session);
  await page.click('[data-testid=first-preview-exit]');
  await page.waitUntil('退出预习', `!document.querySelector('[data-testid=first-test-preview]')`);
  const afterExit = await readState(session);
  assert.deepEqual(afterExit, beforeExit, '预习中途退出，词条、日志、事件和用户笔记都不变');
  assert.equal(afterExit.logs.length, 0);

  // ---------------- 正式预习：前两个看释义，其余直接下一个 ----------------
  await page.waitUntil('退出后重新读取完成', `(() => { const b = document.querySelector('[data-testid=first-test-start]'); return !!b && !b.disabled; })()`);
  await page.click('[data-testid=first-test-start]');
  await page.waitFor('[data-testid=first-test-preview]');
  for (let index = 0; index < 7; index += 1) {
    assert.equal(await page.text('[data-testid=first-preview-progress]'), `${index + 1} / 7`);
    if (index < 2) await page.click('[data-testid=first-preview-reveal]');
    if (index === 6) assert.equal(await page.text('[data-testid=first-preview-next]'), '开始答题');
    await page.click('[data-testid=first-preview-next]');
  }
  await page.waitFor('[data-testid=recall-screen]');
  assert.equal(modelCalls.length, 0, '7 个词都有现成例句，首轮不请求模型');
  assert.match(await page.text('[data-testid=recall-progress]'), /第 1 \/ 2 屏 · 本屏 4 题 · 共 7 题/);
  await page.type('#recall-input-0', 'exacerbate');
  await page.type('#recall-input-1', 'reduce');
  await page.type('#recall-input-2', 'comprise');
  await page.type('#recall-input-3', 'hold');
  await shot(page, '02-question.png');
  await page.click('[data-testid=recall-submit]');
  await page.waitUntil('第一屏判分出来', `document.querySelectorAll('[data-testid=recall-result]').length === 4`);
  const kinds = await page.evaluate(() => [...document.querySelectorAll('[data-testid=recall-result]')].map(e => e.dataset.kind + '/' + e.dataset.correct));
  assert.deepEqual(kinds, ['correct/true', 'wrong/false', 'correct/true', 'wrong/false']);
  await waitNextEnabled(page);
  await page.click('[data-testid=recall-next]');

  await page.waitUntil('进入第 2 屏', `document.querySelector('[data-testid=recall-progress]')?.innerText.includes('第 2 / 2 屏')`);
  assert.match(await page.text('[data-testid=recall-progress]'), /第 2 \/ 2 屏 · 本屏 3 题 · 共 7 题/);
  await page.type('#recall-input-4', 'allocate');
  await page.type('#recall-input-5', 'evaluate');
  await page.type('#recall-input-6', 'robust');
  await page.click('[data-testid=recall-submit]');
  await page.waitUntil('第二屏判分出来', `document.querySelectorAll('[data-testid=recall-result]').length === 3`);
  await waitNextEnabled(page);
  // 023：答对转「已掌握」时，保存那行必须写「已掌握」，不能是空到期日。
  // 这行只在写回期间短暂出现，用 MutationObserver 记下所有出现过的文字。
  await page.evaluate(() => {
    window.__savedDueSeen = [];
    const record = records => {
      for (const entry of records) for (const node of entry.addedNodes) {
        if (node.nodeType !== 1) continue;
        const due = node.matches?.('[data-testid=recall-new-due]') ? node : node.querySelector?.('[data-testid=recall-new-due]');
        if (due) window.__savedDueSeen.push(due.textContent.trim());
      }
    };
    new MutationObserver(record).observe(document.body, { childList: true, subtree: true });
  });
  await page.click('[data-testid=recall-next]');
  await page.waitFor('[data-testid=recall-summary]');
  const savedDueSeen = await page.evaluate(() => window.__savedDueSeen);
  assert.ok(savedDueSeen.includes('已掌握'), `已掌握的词保存行要显示「已掌握」，实际：${JSON.stringify(savedDueSeen)}`);
  await shot(page, '02b-mastered-saved.png');

  // ---------------- 结果表：4 对 3 错，剩余 2 个 🌱 ----------------
  await page.waitFor('[data-testid=recall-summary]');
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid=recall-result-row]')].map(row => ({
    word: row.dataset.word,
    written: row.querySelector('[data-testid=row-written]').innerText,
    verdict: row.querySelector('[data-testid=row-verdict]').innerText,
    change: row.querySelector('[data-testid=row-change]').innerText,
    previewed: row.querySelector('[data-testid=row-previewed]')?.innerText ?? '',
  })));
  note('结果表', rows);
  assert.equal(rows.length, 7);
  const by = Object.fromEntries(rows.map(row => [row.word.split('@')[0], row]));
  for (const word of ['exacerbate', 'comprise', 'allocate', 'evaluate']) {
    assert.equal(by[word].verdict, '答对', word);
    if (word === 'exacerbate') assert.match(by[word].change, new RegExp(`待考察 → L1，到期 ${plusDays(2).slice(5)}`), word);
    else assert.match(by[word].change, /待考察 → 已掌握/, word);
  }
  for (const word of ['mitigate', 'sustain', 'resilient']) {
    assert.equal(by[word].verdict, '答错', word);
    assert.match(by[word].change, new RegExp(`待考察 → L1，到期 ${plusDays(2).slice(5)}`), word);
  }
  assert.equal(by.exacerbate.previewed, '看过释义');
  assert.equal(by.mitigate.previewed, '看过释义');
  assert.equal(rows.filter(row => row.previewed === '看过释义').length, 2, '结果表只标记实际看过释义的 2 个词');
  assert.equal(await page.text('[data-testid=recall-correct-count]'), '4');
  assert.equal(await page.text('[data-testid=recall-wrong-count]'), '3');
  assert.equal(await page.text('[data-testid=recall-skipped-count]'), '0');
  assert.match(await page.text('[data-testid=recall-remaining]'), /还有 2 个新词没轮到（每次最多 7 个）/);
  assert.match(await page.text('[data-testid=recall-summary]'), /本轮首考完成/);
  // 042：结果页只显示文字状态，不出现 🌱 / ✅ / 🧊。
  assert.doesNotMatch(await page.text('[data-testid=recall]'), /[🌱✅🧊]/u, '结果页不能有彩色表情');
  await shot(page, '03-result-table.png');

  // ---------------- 保存后立刻核对数据库 ----------------
  const expected = {
    exacerbate: `L1/${plusDays(2)}`, comprise: '✅已掌握/', allocate: '✅已掌握/', evaluate: '✅已掌握/',
    mitigate: `L1/${plusDays(2)}`, sustain: `L1/${plusDays(2)}`, resilient: `L1/${plusDays(2)}`,
    derive: '🌱待考察/', clarify: '🌱待考察/', advocate: '🌱待考察/', constrain: '🌱待考察/',
  };
  let state = await readState(session);
  assert.deepEqual(state.words, expected, '看过释义的词对错都 L1；其他词仍按旧规则写回');
  assert.equal(state.logs.length, 7, '7 题都写 review_log');
  assert.deepEqual(state.events, [], '还没标题目出错/笔误/复检');
  assert.equal(state.reviewNotes.exacerbate, `exacerbate 的新词备注；${today} 首考前看过释义`);
  assert.equal(state.reviewNotes.mitigate, `mitigate 的新词备注；${today} 首考前看过释义`);
  assert.equal(state.reviewNotes.comprise, `comprise 的新词备注；${today} 首考过`);
  assert.equal(state.reviewNotes.sustain, 'sustain 的新词备注');

  // ---------------- 同日复检：答错的 mitigate 换新语境（假模型） ----------------
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid=recall-recheck]').length), 3, '3 个答错词都能复检');
  await page.evaluate(() => document.querySelectorAll('[data-testid=recall-recheck]')[0].click());
  await page.waitFor('[data-testid=recheck-card][data-phase=answer]');
  assert.deepEqual(modelCalls, [['mitigate@8.25']], '复检只为这个词请求一次模型');
  assert.match(await page.text('[data-testid=recheck-card]'), /Planting trees along the river can m_______ the damage/);
  await page.type('[data-testid=recheck-input]', 'mitigate');
  await page.click('[data-testid=recheck-submit]');
  await page.waitFor('[data-testid=recheck-logged]');
  assert.match(await page.text('[data-testid=recheck-logged]'), /答对.*状态没有变化/);
  state = await readState(session);
  assert.deepEqual(state.words, expected, '复检不改状态');
  assert.equal(state.logs.length, 7, '复检不进 review_log');
  assert.equal(state.events.filter(row => row.kind === 'recheck' && row.correct === 1).length, 1);

  // ---------------- 390 CSS 像素：结果表不横向溢出 ----------------
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  await scrollTo(page, '[data-testid=recall-result-table]');
  assert.equal(await noOverflow(page), true, '390 CSS 像素不横向溢出（结果表）');
  await shot(page, '04-narrow-390-table.png');
  await page.click('[data-testid=recall-finish]');
  await page.waitUntil('新词区刷新为 4 个', `document.querySelector('[data-testid=seed-count]')?.innerText.includes('待首考 4 个')`);
  const pickerAfter = await selectOptions(page);
  note('首考后选期下拉框', pickerAfter);
  assert.equal(pickerAfter.value, '8.25', '8.25 还剩 2 个，仍是默认期');
  assert.deepEqual(pickerAfter.options, ['8.25 期 · 新词 2', '9.24 期 · 新词 2', '全部按期号顺序 · 新词 4']);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, '390 CSS 像素不横向溢出（词库页）');
  await shot(page, '05-narrow-390-issue-selection.png');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });

  // ---------------- 跳过预习：剩余 4 个全部按旧规则写回 ----------------
  await page.evaluate(() => {
    const select = document.querySelector('[data-testid=first-test-issue]');
    select.value = '__all__';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitUntil('跳过预习前开始按钮可点', `(() => { const b = document.querySelector('[data-testid=first-test-start]'); return !!b && !b.disabled; })()`);
  await page.click('[data-testid=first-test-start]');
  await page.waitFor('[data-testid=first-test-preview]');
  assert.equal(await page.text('[data-testid=first-preview-progress]'), '1 / 4');
  await page.click('[data-testid=first-preview-skip]');
  await page.waitFor('[data-testid=recall-screen]');
  await page.type('#recall-input-0', 'derive');
  await page.type('#recall-input-1', 'wrong');
  await page.type('#recall-input-2', 'advocate');
  await page.type('#recall-input-3', 'wrong');
  await page.click('[data-testid=recall-submit]');
  await page.waitUntil('跳过预习的 4 题判分完成', `document.querySelectorAll('[data-testid=recall-result]').length === 4`);
  await waitNextEnabled(page);
  await page.click('[data-testid=recall-next]');
  await page.waitFor('[data-testid=recall-summary]');
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid=row-previewed]').length), 0, '跳过预习后没有看过释义标记');
  expected.derive = '✅已掌握/';
  expected.clarify = `L1/${plusDays(2)}`;
  expected.advocate = '✅已掌握/';
  expected.constrain = `L1/${plusDays(2)}`;
  state = await readState(session);
  assert.deepEqual(state.words, expected, '跳过预习后答对已掌握、答错 L1，完全按旧规则');
  assert.equal(state.logs.length, 11);
  assert.equal(state.reviewNotes.derive, `derive 的新词备注；${today} 首考过`);
  assert.equal(state.reviewNotes.clarify, 'clarify 的新词备注');
  await page.click('[data-testid=recall-finish]');
  await page.waitUntil('全部首考完成', `document.querySelector('[data-testid=seed-count]')?.innerText.includes('待首考 0 个')`);

  const unexpectedErrors = page.errors.filter(error => error !== 'plugin http not found');
  assert.deepEqual(unexpectedErrors, [], '除隔离模式刻意不注册 http 插件外，不应有页面错误');

  // ---------------- 重启后再核对 ----------------
  page = null;
  session = await restart(runDir, {});
  const afterRestart = await readState(session);
  assert.deepEqual(afterRestart.words, expected, '重启后 11 个词的状态和到期日不变');
  assert.equal(afterRestart.logs.length, 11);
  assert.equal(afterRestart.events.length, 1);
  assert.equal(afterRestart.reviewNotes.exacerbate, `exacerbate 的新词备注；${today} 首考前看过释义`);
  assert.equal(afterRestart.reviewNotes.mitigate, `mitigate 的新词备注；${today} 首考前看过释义`);
  note('重启后复习库', afterRestart.words);

  page = await connect({ port: session.port });
  await page.waitReady();
  await page.clickText('词库', { timeout: 60000 });
  await page.waitUntil('重启后新词区仍是 0 个', `document.querySelector('[data-testid=seed-count]')?.innerText.includes('待首考 0 个')`);
  await shot(page, '06-after-restart.png');

  const evidence = {
    today, runDir, screenshots: fs.readdirSync(out).filter(name => name.endsWith('.png')).sort(),
    rows, expected, modelCalls, picker, pickerAfter,
    events: afterRestart.events.map(row => ({ kind: row.kind, correct: row.correct, detail: row.detail })),
    narrowViewport: { width: 390, horizontalOverflow: false }, unexpectedErrors, log,
  };
  const evidenceText = JSON.stringify(evidence, null, 2);
  assert.equal(evidenceText.includes(KEY), false, '证据里不含假密钥');
  fs.writeFileSync(path.join(out, 'evidence.json'), evidenceText, 'utf8');
  note('证据', path.join(out, 'evidence.json'));
  passed = true;
} catch (error) {
  if (page) await page.screenshot(path.join(out, 'failure.png'), { full: false }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  if (session) await stop(session.runDir);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  note('隔离窗口', passed ? '全部通过后已关闭' : '失败后已关闭');
}
