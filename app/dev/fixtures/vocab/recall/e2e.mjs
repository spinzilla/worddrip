// 030 真实窗口验证：隔离数据目录 + 本机假模型，跑两轮到期复习。
//   第 1 轮没配模型：看缺数据说明、仅释义题；Esc 退出，不写库。
//   第 2 轮接假模型：现成例句题 + 模型题，7 题分 4 + 3 两屏；第 1 屏 candit 触发 031 的「可能是笔误」，
//   点「就是拼错了，判错」后保存（判定与 030 一致），再核对 SQLite。
// 用法（在 app 目录）：node dev/fixtures/vocab/recall/e2e.mjs
// 不调用真实模型；假密钥只在本机假服务里出现，证据文件和截图里都核对过不含它。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { start, stop } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { openDb, queryRows } from '../../../e2e/db.mjs';

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.resolve('src-tauri/target/e2e', `030-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const plusDays = days => {
  const date = new Date(`${localDate()}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDate(date);
};
const today = localDate();
const KEY = 'dummy-e2e-key-030';

// 8 个到期词（同一天到期，按导入顺序）：5 个有现成例句，resilient 只有释义，candid、nodata 什么都没有。
const words = ['exacerbate', 'resilient', 'candid', 'nodata', 'mitigate', 'allocate', 'comprise', 'sustain'];
const reviewWords = words.map((word, index) => ({
  id: `${word}@10.20`, word, status: 'L1', level: 1, note: `${word} 的复习备注：2026-10-20 ✗，不应出现在题面`,
  line: index + 2, raw: `| ${word} | 10.20 |`, issue: '10.20', addedAt: today, due: today,
}));
const importRequest = {
  upgrade: { fileName: 'empty-upgrade.md', content: '# 学术升级库\n' },
  review: { fileName: 'recall-030.md', content: '# 词汇总词库\n' },
  entries: [{ id: 'dummy@1.1', line: 2, raw: '| dummy |', plain: 'dummy', upgrade: 'dummy', source: '测试', note: '' }],
  examples: [], selfChecks: [], reviewWords, warnings: { upgrade: [], review: [] },
};
const issueFile = {
  fileName: '20261020.md',
  content: `## 词单分析
1. **exacerbate** v. — to make a problem or situation worse（使恶化）；*Without more investment, the policy could exacerbate the housing shortage.*
2. **resilient** adj. — able to recover quickly from difficulty（有韧性的）
3. **mitigate** v. — to make something bad less severe（减轻）；*Governments introduced new measures to mitigate the effects of rising prices.*
4. **allocate** v. — to give something officially for a particular purpose（分配）；*The council allocated extra funds to rural schools last year.*
5. **comprise** v. — to consist of particular parts（由……组成）；*The course comprises six core modules and two electives.*
6. **sustain** v. — to keep something going over time（维持）；*Few small farms can sustain such high costs for long.*
`,
};

// ---- 本机假 OpenAI 兼容服务 ----
const modelCalls = [];
const DRAFTS = {
  'resilient@10.20': { meaning: 'able to recover quickly', sentence: 'Small island economies must become more [[resilient]] to cope with extreme weather.' },
  'candid@10.20': { meaning: 'honest and direct, even when the truth is unwelcome', sentence: 'In the interview, the minister gave a surprisingly [[candid]] account of the failures.' },
  // 故意泄题：标记外也写了目标词，界面必须拒用并说明。
  'nodata@10.20': { meaning: 'a missing value', sentence: 'The nodata field shows that a [[nodata]] value was recorded.' },
};
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(req.url, '/v1/chat/completions');
  assert.equal(req.headers.authorization, `Bearer ${KEY}`);
  const prompt = payload.messages[0].content;
  const items = JSON.parse(prompt.slice(prompt.indexOf('Items:') + 'Items:'.length));
  modelCalls.push({ ids: items.map(item => item.id), hasNote: prompt.includes('复习备注') });
  res.setHeader('Content-Type', 'application/json');
  const questions = items.map(item => ({ id: item.id, ...DRAFTS[item.id] }));
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
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
  && [...document.querySelectorAll('[data-testid=recall] *')].every(e => e.getBoundingClientRect().right <= document.documentElement.clientWidth + 1));
const scrollTo = (page, selector) => page.evaluate(sel => document.querySelector(sel)?.scrollIntoView({ block: 'start' }), selector);
/** 弹层里（不含输入框）出现的目标词。作答前必须为空。 */
const leakedWords = page => page.evaluate(list => {
  const dialog = document.querySelector('[data-testid=recall]');
  const text = dialog ? dialog.innerText : '';
  return list.filter(word => new RegExp(`\\b${word}`, 'i').test(text));
}, words);
const cards = page => page.evaluate(() => [...document.querySelectorAll('[data-testid=recall-question]')].map(card => ({
  source: card.dataset.source,
  label: card.querySelector('[data-testid=recall-source]')?.innerText ?? '',
  context: card.querySelector('[data-testid=recall-context]')?.innerText ?? '',
  meaning: card.querySelector('[data-testid=recall-meaning]')?.innerText ?? '',
  missing: card.querySelector('[data-testid=recall-missing-note]')?.innerText ?? '',
})));
const waitNextEnabled = page => page.waitUntil('「保存并下一屏」可点', `(() => { const b = document.querySelector('[data-testid=recall-next]'); return !!b && !b.disabled; })()`);
const beginRecall = async page => {
  await page.click('[data-testid=due-recall-start]');
  await page.waitFor('[data-testid=recall-screen]');
};

let session;
let page;
let passed = false;
try {
  note('本机今天', today);
  session = await start({ runDir, port: 9465 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.clickText('词库', { timeout: 60000 });
  const report = await invoke(page, 'vocab_import', { request: importRequest });
  assert.equal(report.reviewWords.added, 8);
  const definitions = await invoke(page, 'vocab_definition_import', { request: { issues: [issueFile], eagp: null } });
  assert.equal(definitions.added, 6);
  assert.equal(definitions.examplesAdded, 5);
  await page.reload();
  await page.clickText('词库');
  await page.waitUntil('到期区读取 8 条', `document.querySelector('[data-testid=due-count]')?.innerText.includes(' 8 个词')`);
  let db = await openDb(session);
  const before = queryRows(db, 'review_word');
  db.close();

  // ---------------- 第 1 轮：没配模型 ----------------
  await page.evaluate(() => localStorage.removeItem('linguaclip_ai_config'));
  await beginRecall(page);
  const offline = await cards(page);
  note('第 1 轮（没配模型）题卡', offline.map(card => `${card.source}/${card.label}`));
  assert.deepEqual(offline.map(card => card.source), ['example', 'definition', 'example'], '6 题分 3 + 3，第 1 屏 3 题');
  assert.match(await page.text('[data-testid=recall-progress]'), /第 1 \/ 2 屏 · 本屏 3 题 · 共 6 题/);
  assert.match(await page.text('[data-testid=recall-notices]'), /没配置模型：1 题/);
  assert.match(await page.text('[data-testid=recall-notices]'), /2 个到期词缺数据没出题/);
  assert.match(offline[1].missing, /没有现成例句，也没配置模型/);
  assert.deepEqual(await leakedWords(page), [], '题面不泄题（没配模型）');
  assert.equal(modelCalls.length, 0, '没配模型时不请求');
  await shot(page, '01-no-model-missing-data.png');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await page.waitUntil('Esc 退出复习', `!document.querySelector('[data-testid=recall]')`);
  db = await openDb(session);
  assert.deepEqual(queryRows(db, 'review_word'), before, '只看题、不作答不写库');
  assert.equal(queryRows(db, 'review_log').length, 0);
  db.close();

  // ---------------- 第 2 轮：本机假模型 ----------------
  await page.evaluate(baseUrl => {
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({ baseUrl, apiKey: 'dummy-e2e-key-030', model: 'fake-question-model', temperature: 0.7 }));
    // launch.mjs 为避免插件写系统目录而关闭 http 插件；只在开发隔离窗口改用浏览器 fetch。
    window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);
    // 038 起配了模型会混入改写/造句题；本脚本专测填空流程，用开发钩子只出填空（改写/造句见 dev/fixtures/vocab/usage/e2e.mjs）。
    window.__ES_E2E_FILL_ONLY__ = true;
  }, `http://127.0.0.1:${modelPort}/v1`);
  await beginRecall(page);
  assert.equal(modelCalls.length, 1, '整轮只请求一次模型');
  assert.deepEqual(modelCalls[0].ids, ['resilient@10.20', 'candid@10.20', 'nodata@10.20'], '有现成例句的词不请求模型');
  assert.equal(modelCalls[0].hasNote, false, '复习备注不发给模型');
  const screen1 = await cards(page);
  note('第 2 轮第 1 屏题卡', screen1.map(card => `${card.source}/${card.label}`));
  assert.deepEqual(screen1.map(card => card.source), ['example', 'model', 'model', 'example']);
  assert.match(await page.text('[data-testid=recall-progress]'), /第 1 \/ 2 屏 · 本屏 4 题 · 共 7 题/);
  assert.match(screen1[0].context, /^Without more investment, the policy could e_________ the housing shortage\.$/);
  assert.match(screen1[1].context, /become more r________ to cope/);
  assert.equal(screen1[2].meaning, 'honest and direct, even when the truth is unwelcome');
  assert.match(await page.text('[data-testid=recall-notices]'), /模型给 1 个词出的题没通过/);
  assert.deepEqual(await leakedWords(page), [], '题面不泄题（模型题）');
  assert.equal(await page.evaluate(() => document.body.innerText.includes('复习备注')), false, '复习备注不上题面');
  await shot(page, '02-example-question.png');
  await scrollTo(page, '[data-testid=recall-question]:nth-of-type(2)');
  await shot(page, '03-model-question.png');

  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  await scrollTo(page, '[data-testid=recall-progress]');
  assert.equal(await noOverflow(page), true, '390 CSS 像素不横向溢出');
  await shot(page, '04-narrow-390.png');
  await scrollTo(page, '[data-testid=recall-question]:nth-of-type(3)');
  await shot(page, '04b-narrow-390-model.png');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });

  // 第 1 屏：例句题答对、模型题答对、candit 触发笔误确认、空着。
  await page.type('#recall-input-0', 'Exacerbate');
  await page.type('#recall-input-1', 'resilient');
  await page.type('#recall-input-2', 'candit');
  assert.match(await page.text('[data-testid=recall-blank-note]'), /还有 1 题没写/);
  await page.click('[data-testid=recall-submit]');
  await page.waitUntil('第 1 屏判分完成', `document.querySelectorAll('[data-testid=recall-result]').length === 4`);
  const kinds1 = await page.evaluate(() => [...document.querySelectorAll('[data-testid=recall-result]')].map(e => e.dataset.kind + '/' + e.dataset.correct));
  assert.deepEqual(kinds1, ['correct/true', 'correct/true', 'typo/pending', 'wrong/false'], 'candit 是单字母笔误，等用户决定');
  assert.match(await page.text('[data-testid=recall-typo-actions]'), /就是拼错了，判错/);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=recall-next]').disabled), true, '笔误没决定前不能保存');
  db = await openDb(session);
  assert.equal(queryRows(db, 'review_log').length, 0, '提交只判分不写库');
  db.close();
  await scrollTo(page, '[data-testid=recall-question]:nth-of-type(3)');
  await shot(page, '05-screen1-typo-pending.png');
  // 选「就是拼错了，判错」，保持 030 里 candid 判错、写回 L1 的预期。
  await page.click('[data-testid=recall-typo-reject]');
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-testid=recall-result]')].map(e => e.dataset.correct)), ['true', 'true', 'false', 'false'], '点判错后最终判定为答错');
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-testid=recall-verdict]')].map(e => e.innerText)), ['答对', '答对', '答错（拼写不同）', '没作答，按答错计']);
  await waitNextEnabled(page);
  await scrollTo(page, '[data-testid=recall-question]:nth-of-type(3)');
  await shot(page, '05b-screen1-typo-rejected.png');
  await page.click('[data-testid=recall-next]');

  // 第 2 屏：句中是 allocated，写原形判错；comprises、sustain 判对。
  await page.waitUntil('进入第 2 屏', `document.querySelector('[data-testid=recall-progress]')?.innerText.includes('第 2 / 2 屏 · 本屏 3 题')`);
  assert.deepEqual(await leakedWords(page), [], '第 2 屏作答前不泄题');
  assert.deepEqual((await cards(page)).map(card => card.source), ['example', 'example', 'example']);
  await page.type('#recall-input-4', 'allocate');
  await page.type('#recall-input-5', 'comprises');
  await page.type('#recall-input-6', 'sustain');
  await page.click('[data-testid=recall-submit]');
  await page.waitUntil('第 2 屏判分完成', `document.querySelectorAll('[data-testid=recall-result]').length === 3`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-testid=recall-result]')].map(e => e.dataset.correct)), ['false', 'true', 'true']);
  assert.match(await page.text('[data-testid=recall-result]'), /词形不对：这句需要 allocated，不是 allocate/);
  await shot(page, '06-screen2-judged.png');
  await waitNextEnabled(page);
  await page.click('[data-testid=recall-next]');

  await page.waitFor('[data-testid=recall-summary]');
  assert.equal(await page.text('[data-testid=recall-correct-count]'), '4');
  assert.equal(await page.text('[data-testid=recall-wrong-count]'), '3');
  assert.equal(await page.text('[data-testid=recall-skipped-count]'), '1');
  assert.match(await page.text('[data-testid=recall-skipped-list]'), /nodata[\s\S]*模型出题失败（语境句别处出现了目标词或同族词）/);
  await shot(page, '07-summary.png');
  await page.click('[data-testid=recall-finish]');
  await page.waitUntil('只剩 nodata 到期', `document.querySelector('[data-testid=due-count]')?.innerText.includes(' 1 个词')`);

  db = await openDb(session);
  const rows = queryRows(db, 'review_word');
  const logs = queryRows(db, 'review_log');
  const events = queryRows(db, 'review_event');
  db.close();
  const actual = Object.fromEntries(rows.map(row => [row.word, `${row.status}/${row.due}`]));
  const up = `L2/${plusDays(4)}`;
  const down = `L1/${plusDays(2)}`;
  assert.deepEqual(actual, {
    exacerbate: up, resilient: up, candid: down, nodata: `L1/${today}`, mitigate: down, allocate: down, comprise: up, sustain: up,
  });
  assert.equal(logs.length, 7);
  assert.equal(logs.every(row => row.kind === 'recall'), true);
  assert.equal(events.length, 0, '拒绝笔误、没标题目出错，不写 review_event');
  note('写回复习库', actual);

  const unexpectedErrors = page.errors.filter(error => error !== 'plugin http not found');
  assert.deepEqual(unexpectedErrors, [], '除隔离模式刻意不注册 http 插件外，不应有页面错误');
  const evidence = {
    today, runDir,
    screenshots: fs.readdirSync(out).filter(name => name.endsWith('.png')).sort(),
    offlineCards: offline, onlineScreen1: screen1, modelCalls, reviewWords: actual, reviewLogs: logs.length, reviewEvents: events.length, kinds1,
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
