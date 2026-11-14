// 031 真实窗口验证：隔离数据目录 + 本机假模型。
// 一屏 4 题：exacerbate 答对、mitigate 答错、comprise 笔误申诉、sustain 题目出错。
// 然后对答错的 mitigate 做一次复检（假模型出新语境），重启窗口核对数据库：状态只被首轮改变。
// 用法（在 app 目录）：node dev/fixtures/vocab/grading/e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { start, stop, restart } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { openDb, queryRows } from '../../../e2e/db.mjs';

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.resolve('src-tauri/target/e2e', `031-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const plusDays = days => {
  const date = new Date(`${localDate()}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDate(date);
};
const today = localDate();
const KEY = 'dummy-e2e-key-031';

const words = ['exacerbate', 'mitigate', 'comprise', 'sustain'];
const reviewWords = words.map((word, index) => ({
  id: `${word}@10.20`, word, status: 'L3', level: 3, note: `${word} 的复习备注`,
  line: index + 2, raw: `| ${word} | 10.20 |`, issue: '10.20', addedAt: today, due: today,
}));
const importRequest = {
  upgrade: { fileName: 'empty-upgrade.md', content: '# 学术升级库\n' },
  review: { fileName: 'grading-031.md', content: '# 词汇总词库\n' },
  entries: [{ id: 'dummy@1.1', line: 2, raw: '| dummy |', plain: 'dummy', upgrade: 'dummy', source: '测试', note: '' }],
  examples: [], selfChecks: [], reviewWords, warnings: { upgrade: [], review: [] },
};
const issueFile = {
  fileName: '20261020.md',
  content: `## 词单分析
1. **exacerbate** v. — to make a problem or situation worse（使恶化）；*Without more investment, the policy could exacerbate the housing shortage.*
2. **mitigate** v. — to make something bad less severe（减轻）；*Governments introduced new measures to mitigate the effects of rising prices.*
3. **comprise** v. — to consist of particular parts（由……组成）；*The course comprises six core modules and two electives.*
4. **sustain** v. — to keep something going over time（维持）；*Few small farms can sustain such high costs for long.*
`,
};

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
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
  && [...document.querySelectorAll('[data-testid=recall] *')].every(e => e.getBoundingClientRect().right <= document.documentElement.clientWidth + 1));
const readState = async session => {
  const db = await openDb(session);
  const state = {
    words: Object.fromEntries(queryRows(db, 'review_word').map(row => [row.word, `${row.status}/${row.due}`])),
    logs: queryRows(db, 'review_log'),
    events: queryRows(db, 'review_event'),
  };
  db.close();
  return state;
};

let session;
let page;
let passed = false;
try {
  note('本机今天', today);
  session = await start({ runDir, port: 9466 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.clickText('词库', { timeout: 60000 });
  const report = await invoke(page, 'vocab_import', { request: importRequest });
  assert.equal(report.reviewWords.added, 4);
  const definitions = await invoke(page, 'vocab_definition_import', { request: { issues: [issueFile], eagp: null } });
  assert.equal(definitions.examplesAdded, 4);
  await page.reload();
  await page.clickText('词库');
  await page.waitUntil('到期区读取 4 条', `document.querySelector('[data-testid=due-count]')?.innerText.includes(' 4 个词')`);
  await page.evaluate(baseUrl => {
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({ baseUrl, apiKey: 'dummy-e2e-key-031', model: 'fake-grader', temperature: 0.7 }));
    window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);
    // 038 起配了模型会混入改写/造句题；本脚本专测填空流程，用开发钩子只出填空（改写/造句见 dev/fixtures/vocab/usage/e2e.mjs）。
    window.__ES_E2E_FILL_ONLY__ = true;
  }, `http://127.0.0.1:${modelPort}/v1`);

  // ---------------- 首轮：一屏 4 题 ----------------
  await page.click('[data-testid=due-recall-start]');
  await page.waitFor('[data-testid=recall-screen]');
  assert.equal(modelCalls.length, 0, '4 个词都有现成例句，首轮不请求模型');
  assert.match(await page.text('[data-testid=recall-progress]'), /第 1 \/ 1 屏 · 本屏 4 题/);
  await page.type('#recall-input-0', ' Exacerbate ');
  await page.type('#recall-input-1', 'reduce');
  await page.type('#recall-input-2', 'comprizes');
  // 第 4 题（sustain）标「这题出错了」
  await page.evaluate(() => document.querySelectorAll('[data-testid=recall-flag]')[3].click());
  await page.click('[data-testid=recall-submit]');
  await page.waitUntil('逐题判分出来', `document.querySelectorAll('[data-testid=recall-result]').length === 3`);
  const kinds = await page.evaluate(() => [...document.querySelectorAll('[data-testid=recall-result]')].map(e => e.dataset.kind + '/' + e.dataset.correct));
  assert.deepEqual(kinds, ['correct/true', 'wrong/false', 'typo/pending']);
  assert.match(await page.text('[data-testid=recall-typo-actions]'), /按笔误判对/);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=recall-next]').disabled), true, '笔误没决定前不能保存');
  let state = await readState(session);
  assert.equal(state.logs.length, 0, '提交判分不写库，保存前可以改判/标出错');
  await shot(page, '01-graded-before-save.png');
  await page.click('[data-testid=recall-typo-accept]');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=recall-next]').disabled), false);
  await page.click('[data-testid=recall-next]');

  // ---------------- 结果表 ----------------
  await page.waitFor('[data-testid=recall-summary]');
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid=recall-result-row]')].map(row => ({
    word: row.dataset.word,
    written: row.querySelector('[data-testid=row-written]').innerText,
    verdict: row.querySelector('[data-testid=row-verdict]').innerText,
    form: row.querySelector('[data-testid=row-form]').innerText,
    reason: row.querySelector('[data-testid=row-reason]').innerText,
    change: row.querySelector('[data-testid=row-change]').innerText,
  })));
  note('结果表', rows);
  assert.equal(rows.length, 4);
  const by = Object.fromEntries(rows.map(row => [row.word.split('@')[0], row]));
  assert.equal(by.exacerbate.verdict, '答对');
  assert.match(by.exacerbate.change, new RegExp(`L3 → L4，到期 ${plusDays(16).slice(5)}`));
  assert.equal(by.mitigate.verdict, '答错');
  assert.equal(by.mitigate.form, 'mitigate');
  assert.match(by.mitigate.change, new RegExp(`L3 → L1，到期 ${plusDays(2).slice(5)}`));
  assert.equal(by.comprise.verdict, '按笔误判对');
  assert.equal(by.comprise.written, 'comprizes');
  assert.match(by.comprise.change, /L3 → L4/);
  assert.match(by.sustain.verdict, /题目出错/);
  assert.match(by.sustain.change, /^不变：L3/);
  assert.equal(await page.text('[data-testid=recall-correct-count]'), '2');
  assert.equal(await page.text('[data-testid=recall-wrong-count]'), '1');
  assert.equal(await page.text('[data-testid=recall-flagged-count]'), '1');
  await shot(page, '02-result-table.png');

  state = await readState(session);
  const afterFirst = state.words;
  assert.deepEqual(afterFirst, {
    exacerbate: `L4/${plusDays(16)}`, mitigate: `L1/${plusDays(2)}`, comprise: `L4/${plusDays(16)}`, sustain: `L3/${today}`,
  });
  assert.equal(state.logs.length, 3, '题目出错那题不进 review_log');
  assert.deepEqual(state.events.map(row => row.kind).sort(), ['question_error', 'typo']);
  assert.match(state.events.find(row => row.kind === 'typo').detail, /笔误：用户写法 comprizes/);

  // ---------------- 复检：答错的 mitigate 换新语境 ----------------
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid=recall-recheck]').length), 1, '只有答错那题能复检');
  await page.click('[data-testid=recall-recheck]');
  await page.waitFor('[data-testid=recheck-card][data-phase=answer]');
  assert.deepEqual(modelCalls, [['mitigate@10.20']], '复检只为答错的词请求一次模型');
  assert.match(await page.text('[data-testid=recheck-card]'), /Planting trees along the river can m_______ the damage/);
  await page.type('[data-testid=recheck-input]', 'mitigate');
  await page.click('[data-testid=recheck-submit]');
  await page.waitFor('[data-testid=recheck-logged]');
  assert.match(await page.text('[data-testid=recheck-logged]'), /答对.*状态没有变化/);
  await scrollTo(page, '[data-testid=recheck-card]');
  await shot(page, '03-recheck.png');
  state = await readState(session);
  assert.deepEqual(state.words, afterFirst, '复检不改状态');
  assert.equal(state.logs.length, 3, '复检不进 review_log');
  assert.equal(state.events.filter(row => row.kind === 'recheck' && row.correct === 1).length, 1);

  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  await scrollTo(page, '[data-testid=recall-result-table]');
  assert.equal(await noOverflow(page), true, '390 CSS 像素不横向溢出（结果表）');
  await shot(page, '04-narrow-390-table.png');
  await scrollTo(page, '[data-testid=recheck-card]');
  assert.equal(await noOverflow(page), true, '390 CSS 像素不横向溢出（复检）');
  await shot(page, '05-narrow-390-recheck.png');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });

  const unexpectedErrors = page.errors.filter(error => error !== 'plugin http not found');
  assert.deepEqual(unexpectedErrors, [], '除隔离模式刻意不注册 http 插件外，不应有页面错误');
  await page.click('[data-testid=recall-finish]');

  // ---------------- 019/024：390 窄屏导航要横滑，当前标签自动滚进可视区 ----------------
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  await page.waitUntil('进入词库页', `!!document.querySelector('header nav [aria-current=page]')`);
  const navView = await page.evaluate(() => {
    const nav = document.querySelector('header nav');
    const activeTab = nav?.querySelector('[aria-current="page"]');
    if (!nav || !activeTab) return null;
    const box = nav.getBoundingClientRect();
    const tab = activeTab.getBoundingClientRect();
    return {
      label: activeTab.innerText.trim(),
      needsScroll: nav.scrollWidth > nav.clientWidth,
      visible: tab.left >= box.left - 1 && tab.right <= box.right + 1,
    };
  });
  assert.deepEqual(navView, { label: '词库', needsScroll: true, visible: true }, '390 下当前标签自动滚入可视区');
  await shot(page, '04b-narrow-nav.png');

  // ---------------- 重启后再核对 ----------------
  page = null;
  session = await restart(runDir, {});
  const afterRestart = await readState(session);
  assert.deepEqual(afterRestart.words, afterFirst, '重启后状态仍只由首轮结果决定');
  assert.equal(afterRestart.logs.length, 3);
  assert.equal(afterRestart.events.length, 3);
  note('重启后复习库', afterRestart.words);

  page = await connect({ port: session.port });
  await page.waitReady();
  await page.clickText('词库', { timeout: 60000 });
  // sustain 仍到期；标过出错的题面下一轮不再出（它只有这一句例句，退回释义题）。
  await page.waitUntil('到期区读取 1 条', `document.querySelector('[data-testid=due-count]')?.innerText.includes(' 1 个词')`);
  await page.evaluate(baseUrl => {
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({ baseUrl, apiKey: 'dummy-e2e-key-031', model: 'fake-grader', temperature: 0.7 }));
    window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);
    // 038 起配了模型会混入改写/造句题；本脚本专测填空流程，用开发钩子只出填空（改写/造句见 dev/fixtures/vocab/usage/e2e.mjs）。
    window.__ES_E2E_FILL_ONLY__ = true;
  }, `http://127.0.0.1:${modelPort}/v1`);
  await page.click('[data-testid=due-recall-start]');
  await page.waitFor('[data-testid=recall-screen]');
  const nextSurface = await page.evaluate(() => document.querySelector('[data-testid=recall-question]').innerText);
  assert.equal(/Few small farms/.test(nextSurface), false, '标过出错的例句不再出现');
  note('重启后 sustain 的新题面来源', await page.evaluate(() => document.querySelector('[data-testid=recall-question]').dataset.source));
  await shot(page, '06-flagged-surface-replaced.png');

  const evidence = {
    today, runDir, screenshots: fs.readdirSync(out).filter(name => name.endsWith('.png')).sort(),
    rows, afterFirst, modelCalls, events: afterRestart.events.map(row => ({ kind: row.kind, correct: row.correct, detail: row.detail })),
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
