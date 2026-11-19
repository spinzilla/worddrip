// 043 真实窗口验证：隔离数据目录 + 本机假模型，不调用真实模型、不碰真实数据库。
// 1. 词库详情「我的例句」：没配模型时 AI 按钮不可用并提示去设置；配了假模型后选第 2 个义项让 AI 给 3 句，勾选存 2 句；
//    自己写一句错句 → 看到改法和中文说明 → 存改后；例句里的英文能点词查词；1280 / 390 宽截图、不横向溢出。
// 2. 重启后例句都在。
// 3. 闪卡：正面没有例句，反面有「我的例句」小入口。
// 4. 到期复习：作答中、逐屏判分时都看不到例句入口和已有例句，也不读例句；结果页里判分通过的改写/造句答案能「存为我的例句」。
// 5. 导出复习库：同目录多一份「我的例句.md」。假模型收到的请求里没有笔记正文和复习备注。
// 用法（在 app 目录）：node dev/fixtures/vocab/examples/e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { start, stop, restart, DEV_PORT } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { openDb, queryRows } from '../../../e2e/db.mjs';
import { portInUse } from '../../../e2e/proc.mjs';

if (await portInUse(DEV_PORT)) {
  console.error(`${DEV_PORT} 端口已被占用（可能有别的开发窗口在跑），先关掉再测。`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.resolve('src-tauri/target/e2e', `043-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const plusDays = days => {
  const date = new Date(`${localDate()}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDate(date);
};
const today = localDate();
const KEY = 'dummy-e2e-key-043';
const PRIVATE_NOTE = 'PRIVATE-NOTE-043 这是我的笔记正文，不能发给模型';
const MARKER = 'Example marker 043';

// 4 个到期词（一屏 4 题：2 填空 + 1 改写 + 1 造句）+ resilient（不到期，两个义项）。
const DUE = [
  ['exacerbate', 'to make a problem or situation worse', 'Without more investment, the policy could exacerbate the housing shortage in big cities.'],
  ['mitigate', 'to make something bad less severe', 'Governments introduced new measures to mitigate the effects of rising food prices.'],
  ['comprise', 'to consist of particular parts', 'Next year the degree course will comprise six core modules and two optional ones.'],
  ['allocate', 'to give something officially for a purpose', 'The council will allocate extra funds to the new library project next year.'],
];
const SENSES = [
  ['able to recover quickly from difficulty', 'Small island economies must become more resilient to cope with storms.'],
  ['returning to its original shape after being bent', 'The running track is covered with a resilient rubber surface.'],
];
const reviewWords = [
  ...DUE.map(([word], index) => ({ id: `${word}@10.20`, word, status: 'L3', level: 3, note: `${word} 的复习备注`, line: index + 2, raw: `| ${word} | 10.20 |`, issue: '10.20', addedAt: today, due: today })),
  { id: 'resilient@11.1', word: 'resilient', status: 'L2', level: 2, note: 'resilient 的复习备注', line: 10, raw: '| resilient | 11.1 |', issue: '11.1', addedAt: today, due: plusDays(10) },
];
const importRequest = {
  upgrade: { fileName: 'empty-upgrade.md', content: '# 学术升级库\n' },
  review: { fileName: 'examples-043.md', content: '# 词汇总词库\n' },
  entries: [{ id: 'dummy@1.1', line: 2, raw: '| dummy |', plain: 'dummy', upgrade: 'dummy', source: '测试', note: '' }],
  examples: [], selfChecks: [], reviewWords, warnings: { upgrade: [], review: [] },
};
const issueFiles = [
  { fileName: '20261020.md', content: `## 词单分析\n${DUE.map(([w, e, s], i) => `${i + 1}. **${w}** v. — ${e}（释义 ${i + 1}）；*${s}*`).join('\n')}\n` },
  { fileName: '20261101.md', content: `## 词单分析\n${SENSES.map(([e, s], i) => `${i + 1}. **resilient** adj. — ${e}（义项 ${i + 1}）；*${s}*`).join('\n')}\n` },
];

// ---- 本机假 OpenAI 兼容服务 ----
const calls = [];
const GENERATED = [
  'Our campus running track stayed resilient after years of heavy use by the athletics club.',
  'The lab bought resilient plastic trays that bend in the hands but never crack.',
  'A resilient foam layer protects the expensive microscopes when students move them between rooms.',
];
const WRONG = 'Our team resilient after the failed experiment last week.';
const FIXED = 'Our team remained resilient after the failed experiment last week.';
const FIX_REASON = 'resilient 是形容词，前面缺系动词，要写 remained resilient。';
const usageDraft = task => (task.format === 'paraphrase'
  ? {
    id: task.id, format: 'paraphrase',
    instruction: `Rewrite the sentence using a formal verb meaning "${task.meaning}".`,
    original: 'Excessive energy consumption makes air pollution much worse in large industrial cities.',
    reference: `Excessive energy consumption can [[${task.target}]] air pollution in large industrial cities.`,
  }
  : {
    id: task.id, format: 'compose',
    instruction: `Write one sentence using ${task.target} to describe a group project in a university course. Use "the team" as the subject.`,
    original: '',
    reference: `The team had to [[${task.target}]] the plan carefully before the final presentation.`,
  });
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  const payload = JSON.parse(raw);
  assert.equal(req.headers.authorization, `Bearer ${KEY}`);
  const prompt = payload.messages[0].content;
  res.setHeader('Content-Type', 'application/json');
  const reply = content => res.end(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }));
  const record = (kind, extra = {}) => calls.push({ kind, raw, ...extra });
  if (prompt.includes('Expression:')) {
    const item = JSON.parse(prompt.slice(prompt.indexOf('Expression:') + 'Expression:'.length, prompt.indexOf('\n\nReturn only')));
    record('examples', { item });
    return reply({ examples: GENERATED.map((sentence, index) => ({ sentence, collocation: ['stay resilient', 'resilient plastic', 'resilient foam'][index], chinese: `第 ${index + 1} 句的中文` })) });
  }
  if (prompt.includes('Tasks:')) {
    const tasks = JSON.parse(prompt.slice(prompt.indexOf('Tasks:') + 'Tasks:'.length));
    record('usage', { tasks: tasks.map(t => `${t.target}/${t.format}`) });
    return reply({ tasks: tasks.map(usageDraft) });
  }
  if (prompt.includes('Items:')) {
    const items = JSON.parse(prompt.slice(prompt.indexOf('Items:') + 'Items:'.length));
    record('fill');
    return reply({ questions: items.map(item => ({ id: item.id, meaning: '', sentence: `Most experts agreed that the plan would [[${item.target}]] the situation in rural towns.` })) });
  }
  if (prompt.includes('Task type:')) {
    const target = JSON.parse(prompt.match(/^Target expression: (.*)$/m)[1]);
    const answer = JSON.parse(prompt.match(/^Student's answer: (.*)$/m)[1]);
    const meaning = JSON.parse(prompt.match(/^Meaning: (.*)$/m)[1]);
    const own = prompt.includes('Write one sentence of your own');
    record('grade', { target, answer, meaning, own });
    if (answer === WRONG) {
      return reply({ usedTarget: true, grammarOk: false, taskOk: true, verdict: 'wrong', reason: FIX_REASON, targetForm: 'resilient', grammarFix: FIXED, academicUpgrade: 'Our research team remained remarkably resilient after last week\'s failed experiment.' });
    }
    const used = new RegExp(`\\b${target}\\w*`, 'i').test(answer);
    return reply(used
      ? { usedTarget: true, grammarOk: true, taskOk: true, verdict: 'correct', reason: `${target} 用法正确，搭配自然。`, targetForm: target, grammarFix: answer, academicUpgrade: `UPGRADE: ${answer.replace(/\.$/, '')}, according to recent studies.` }
      : { usedTarget: false, grammarOk: true, taskOk: true, verdict: 'incomplete', reason: `没有用 ${target}。`, targetForm: target, grammarFix: `FIX: ${answer}`, academicUpgrade: `UPGRADE: rewritten with ${target}.` });
  }
  if (prompt.includes('Allowed labels')) {
    // 048：闪卡翻到背面会请求场景标注（只含词和句子）；这里给个合法回复，不计入本脚本关心的请求。
    const items = JSON.parse(prompt.slice(prompt.indexOf('Sentences:') + 'Sentences:'.length, prompt.indexOf('\n\nReturn only')));
    return reply({ scenes: items.map(item => ({ id: item.id, scene: 'statement' })) });
  }
  const word = prompt.match(/Define the word "([^"]*)"/)?.[1] ?? '';
  record('lookup', { word });
  return reply({ word, partOfSpeech: 'n.', definition: `测试释义：${word}` });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const modelPort = server.address().port;

const log = [];
const note = (key, value) => { const line = `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`; log.push(line); console.log(line); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const invoke = async (page, command, args = {}) => {
  const outcome = await page.evaluate(async (cmd, payload) => {
    try { return { value: await window.__TAURI_INTERNALS__.invoke(cmd, payload) }; }
    catch (error) { return { error: typeof error === 'string' ? error : String(error) }; }
  }, command, args);
  if (outcome.error) throw new Error(`${command} 失败：${outcome.error}`);
  return outcome.value;
};
const shot = (page, name, full = false) => page.screenshot(path.join(out, name), { full });
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const overlayFits = page => page.evaluate(sel => [...document.querySelectorAll(`${sel} *`)].every(e => e.getBoundingClientRect().right <= document.documentElement.clientWidth + 1), '[data-testid=recall]');
const configureModel = page => page.evaluate(baseUrl => {
  localStorage.setItem('linguaclip_ai_config', JSON.stringify({ baseUrl, apiKey: 'dummy-e2e-key-043', model: 'fake-043', temperature: 0.7 }));
  window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);
}, `http://127.0.0.1:${modelPort}/v1`);
/**
 * 记下前端发给后端的命令名（用来证明作答中没读例句）。__TAURI_INTERNALS__.invoke 不可改写，
 * 所以包一层 fetch：Tauri 2 在 Windows 上走 http://ipc.localhost/<命令名>。
 */
const traceInvoke = page => page.evaluate(() => {
  if (window.__esTrace) return;
  window.__esTrace = [];
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    const hit = url.match(/^(?:http:\/\/ipc\.localhost|ipc:\/\/localhost)\/([^?]+)/);
    if (hit) window.__esTrace.push(decodeURIComponent(hit[1]));
    return originalFetch.call(this, input, init);
  };
});
const trace = page => page.evaluate(() => window.__esTrace ?? []);
const openBrowse = async page => {
  await page.clickText('词库');
  await page.clickText('查词', { selector: 'button[role=tab]', exact: true });
  await page.waitFor('[data-testid=vocab-list]');
};
const openWord = async (page, word) => {
  await page.evaluate(wanted => {
    const row = [...document.querySelectorAll('[data-testid=vocab-list] > button')].find(element => element.innerText.trim().startsWith(wanted));
    if (!row) throw new Error(`列表里没有 ${wanted}`);
    row.click();
  }, word);
  await page.waitFor('[data-testid=examples-section]');
};
const S = '[data-testid=examples-section]';
const sentences = page => page.evaluate(sel => [...document.querySelectorAll(`${sel} [data-testid=example-item]`)].map(item => ({
  sentence: item.querySelector('[data-testid=example-sentence]').innerText,
  source: item.querySelector('[data-testid=example-source]').innerText,
  original: item.querySelector('[data-testid=example-original]')?.innerText ?? '',
  explanation: item.querySelector('[data-testid=example-explanation]')?.innerText ?? '',
})), S);
const clickNth = async (page, selector, index) => {
  await page.evaluate((sel, i) => {
    document.querySelectorAll('[data-e2e-nth]').forEach(e => e.removeAttribute('data-e2e-nth'));
    const element = document.querySelectorAll(sel)[i];
    if (!element) throw new Error(`找不到第 ${i + 1} 个 ${sel}`);
    element.setAttribute('data-e2e-nth', '1');
  }, selector, index);
  await page.click('[data-e2e-nth]');
};
const selectValue = async (page, selector, value) => {
  await page.evaluate((sel, v) => {
    const element = document.querySelector(sel);
    if (!(element instanceof HTMLSelectElement)) throw new Error(`找不到下拉框：${sel}`);
    element.value = v;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector, value);
  await sleep(150);
};
const wordPoint = (page, selector, wanted) => page.evaluate((sel, w) => {
  const root = document.querySelector(sel);
  if (!root) throw new Error(`找不到点击容器：${sel}`);
  root.scrollIntoView({ block: 'center', inline: 'center' });
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const at = node.data.indexOf(w);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + w.length);
    const r = range.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  throw new Error(`在 ${sel} 里找不到词：${w}`);
}, selector, wanted);
const escape = page => page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

const evidence = { today, runDir, checks: {} };
let session;
let page;
let passed = false;
try {
  session = await start({ runDir, port: 9483 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.clickText('词库', { timeout: 60000 });
  assert.equal((await invoke(page, 'vocab_import', { request: importRequest })).reviewWords.added, 5);
  const definitions = await invoke(page, 'vocab_definition_import', { request: { issues: issueFiles, eagp: null } });
  assert.equal(definitions.examplesAdded, 6);
  assert.deepEqual(await invoke(page, 'vocab_examples'), [], '新库没有例句');
  await invoke(page, 'vocab_note_add', { request: { word: 'resilient', body: PRIVATE_NOTE, source: '词库' } });
  for (const [word] of DUE) await invoke(page, 'vocab_example_add', { request: { word, items: [{ sentence: `${MARKER} for ${word}.`, source: '自己写' }] } });
  const baseline = await openDb(session);
  const definitionExamplesBefore = queryRows(baseline, 'review_definition_example').length;
  baseline.close();
  await page.evaluate(() => localStorage.removeItem('linguaclip_ai_config'));
  await page.reload();
  await openBrowse(page);

  // ---------------- 1a. 没配模型 ----------------
  await openWord(page, 'resilient');
  assert.match(await page.text(`${S} h4`), /^我的例句$/);
  await page.waitFor(`${S} [data-testid=examples-empty]`);
  await page.click(`${S} [data-testid=example-ai-open]`);
  await page.waitFor(`${S} [data-testid=example-no-model]`);
  assert.match(await page.text(`${S} [data-testid=example-no-model]`), /先在「设置」里填好接口地址、API Key 和模型名称/);
  assert.equal(await page.evaluate(sel => document.querySelector(`${sel} [data-testid=example-generate]`).disabled, S), true, '没配模型：AI 按钮不可用');
  const senseOptions = await page.evaluate(sel => [...document.querySelectorAll(`${sel} [data-testid=example-sense] option`)].map(o => o.textContent), S);
  note('义项下拉', senseOptions);
  assert.equal(senseOptions.length, 2, '两个义项要先选');
  await page.evaluate(sel => document.querySelector(sel).scrollIntoView({ block: 'start' }), S);
  await shot(page, '01-no-model-1280.png');
  assert.equal(calls.length, 0, '没配模型不发请求');
  evidence.checks.noModel = true;

  // ---------------- 1b. AI 给例句：选第 2 个义项，勾 2 句存 ----------------
  await configureModel(page);
  await page.click(`${S} [data-testid=example-ai-open]`); // 收起
  await page.click(`${S} [data-testid=example-ai-open]`); // 再打开，重新读模型配置
  await page.waitUntil('配了模型后 AI 按钮可用', `!document.querySelector('${S} [data-testid=example-generate]').disabled && !document.querySelector('${S} [data-testid=example-no-model]')`);
  await selectValue(page, `${S} [data-testid=example-sense]`, '1');
  await page.click(`${S} [data-testid=example-generate]`);
  await page.waitUntil('AI 给了 3 句', `document.querySelectorAll('${S} [data-testid=generated-item]').length === 3`);
  const genCall = calls.filter(call => call.kind === 'examples');
  assert.equal(genCall.length, 1);
  assert.deepEqual(genCall[0].item, { target: 'resilient', pos: 'adj.', meaning: SENSES[1][0], chinese: '义项 2' }, '只发词、词性、所选义项');
  assert.equal(await page.evaluate(sel => document.querySelector(`${sel} [data-testid=generated-save]`).disabled, S), true, '没勾选不能存');
  await clickNth(page, `${S} [data-testid=generated-check]`, 0);
  await clickNth(page, `${S} [data-testid=generated-check]`, 2);
  assert.match(await page.text(`${S} [data-testid=generated-save]`), /存勾选的 2 句/);
  await shot(page, '02-generated-picked-1280.png');
  await page.click(`${S} [data-testid=generated-save]`);
  await page.waitUntil('存了 2 句', `document.querySelectorAll('${S} [data-testid=example-item]').length === 2`);
  let list = await sentences(page);
  note('AI 例句存后', list);
  assert.deepEqual(list.map(item => item.sentence).sort(), [GENERATED[0], GENERATED[2]].sort());
  assert.ok(list.every(item => item.source === 'AI生成'));
  assert.match(await page.text(`${S} [data-testid=example-saved-tip]`), /已存 2 句/);
  assert.match(await page.text(`${S} h4`), /我的例句（2）/);
  evidence.checks.generate = list;

  // ---------------- 1c. 自己写一句错句 → 改法 + 中文说明 → 存改后 ----------------
  await page.click(`${S} [data-testid=example-own-open]`);
  await page.type(`${S} [data-testid=own-input]`, WRONG);
  await page.click(`${S} [data-testid=own-check]`);
  await page.waitFor(`${S} [data-testid=own-result]`);
  const ownGrade = calls.filter(call => call.kind === 'grade' && call.own).at(-1);
  assert.equal(ownGrade.answer, WRONG);
  assert.equal(ownGrade.target, 'resilient');
  assert.match(ownGrade.meaning, /returning to its original shape/, '改句按所选义项判');
  assert.match(ownGrade.raw, /Task type: compose/, '改句走的是 038 造句判分提示词');
  assert.equal(await page.text(`${S} [data-testid=own-verdict]`), '用法或语法有问题');
  assert.equal(await page.text(`${S} [data-testid=own-reason]`), FIX_REASON);
  assert.equal(await page.text(`${S} [data-testid=own-fixed]`), FIXED);
  assert.match(await page.text(`${S} [data-testid=own-better]`), /remarkably resilient/);
  await page.evaluate(sel => document.querySelector(`${sel} [data-testid=own-result]`).scrollIntoView({ block: 'center' }), S);
  await shot(page, '03-own-checked-1280.png');
  await page.click(`${S} [data-testid=own-save-fixed]`);
  await page.waitUntil('存了改后', `document.querySelectorAll('${S} [data-testid=example-item]').length === 3`);
  list = await sentences(page);
  note('存改后', list[0]);
  assert.deepEqual(list[0], { sentence: FIXED, source: 'AI改过', original: WRONG, explanation: FIX_REASON });
  // 092 起：结果来自 AI 任务中心，存完不再收起，而是变成「已存」（按钮不再显示）。
  assert.match(await page.text(`${S} [data-testid=own-saved]`), /已存/, '存完变成「已存」');
  assert.equal(await page.evaluate(sel => !!document.querySelector(`${sel} [data-testid=own-save-fixed]`), S), false, '存完按钮不再显示');
  await page.evaluate(sel => document.querySelector(sel).scrollIntoView({ block: 'start' }), S);
  await shot(page, '04-saved-three-1280.png');
  assert.equal(await noOverflow(page), true);

  // ---------------- 1d. 例句里的英文能点词查词 ----------------
  const point = await wordPoint(page, `${S} [data-testid=example-sentence]`, 'remained');
  await page.mouseClick(point.x, point.y);
  await page.waitFor('[data-definition-popup] [role=dialog]');
  await page.waitUntil('查词结果', `(document.querySelector('[data-definition-popup]')?.innerText ?? '').includes('remain')`, { timeout: 30000 });
  evidence.lookupPopup = (await page.text('[data-definition-popup]')).slice(0, 200);
  await shot(page, '05-lookup-in-example-1280.png');
  await escape(page);
  await page.waitUntil('查词卡关闭', `!document.querySelector('[data-definition-popup]')`);
  evidence.checks.lookup = true;

  // ---------------- 1e. 390 宽 ----------------
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  await page.evaluate(sel => document.querySelector(sel).scrollIntoView({ block: 'start' }), S);
  assert.equal(await noOverflow(page), true, '390 详情不横向溢出');
  await shot(page, '06-examples-390.png');
  // 093 起：1280 宽点「AI 给例句」会展开小窗；缩到 390 时小窗抽屉还开着，盖住词条页，先收起。
  if (await page.evaluate(() => !!document.querySelector('[data-testid=ai-panel][data-mode=mobile]'))) await page.click('[data-testid=ai-close]');
  // 093 起：「AI 给例句」的候选在任务里，回到词条页时面板默认就是打开的（点按钮会收起），所以没打开才点。
  if (!(await page.evaluate(sel => !!document.querySelector(sel), `${S} [data-testid=example-panel-generate]`))) await page.click(`${S} [data-testid=example-ai-open]`);
  await page.click(`${S} [data-testid=example-generate]`);
  await page.waitUntil('390 下 AI 给了 3 句', `document.querySelectorAll('${S} [data-testid=generated-item]').length === 3`);
  // 093 起：点「AI 给例句」会把小窗抽屉展开到这条，抽屉盖住词条页，这里收起（手机上也是用户要做的一步）。
  if (await page.evaluate(() => !!document.querySelector('[data-testid=ai-panel][data-mode=mobile]'))) await page.click('[data-testid=ai-close]');
  await page.evaluate(sel => document.querySelector(`${sel} [data-testid=example-panel-generate]`).scrollIntoView({ block: 'start' }), S);
  assert.equal(await noOverflow(page), true, '390 生成面板不横向溢出');
  await shot(page, '07-generate-390.png');
  await page.click(`${S} [data-testid=generated-discard]`);
  await page.click(`${S} [data-testid=example-own-open]`);
  await page.type(`${S} [data-testid=own-input]`, WRONG);
  await page.click(`${S} [data-testid=own-check]`);
  await page.waitFor(`${S} [data-testid=own-result]`);
  await page.evaluate(sel => document.querySelector(`${sel} [data-testid=own-result]`).scrollIntoView({ block: 'start' }), S);
  assert.equal(await noOverflow(page), true, '390 改句结果不横向溢出');
  await shot(page, '08-own-result-390.png');
  await page.click(`${S} [data-testid=own-discard]`);
  assert.equal((await sentences(page)).length, 3, '「都不存」没有存');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  evidence.checks.narrow = true;

  // ---------------- 2. 重启后都在 ----------------
  session = await restart(runDir);
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await configureModel(page);
  await openBrowse(page);
  await openWord(page, 'resilient');
  const afterRestart = await sentences(page);
  assert.deepEqual(afterRestart, list, '重启后例句都在、顺序不变');
  note('重启后', `${afterRestart.length} 句都在`);

  // ---------------- 3. 闪卡：正面没有、反面有小入口 ----------------
  await page.click('[data-testid=due-start]');
  await page.waitFor('[data-testid=flash]');
  assert.equal(await page.evaluate(() => !!document.querySelector('[data-testid=flash] [data-testid=flash-examples]')), false, '闪卡正面没有例句');
  assert.equal(await page.evaluate(m => document.querySelector('[data-testid=flash]').innerText.includes(m), MARKER), false);
  await page.click('[data-testid=flash-card]');
  await page.waitFor('[data-testid=flash-examples]');
  const flashWord = await page.text('.vocab-flash-back-word');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=flash-examples]').dataset.count), '1');
  assert.match(await page.text('[data-testid=flash-examples]'), new RegExp(`${MARKER} for ${flashWord}`));
  // 049 返工：翻到背面时 048 的场景标签还在请求中，那一句暂时没有标签；标签一到，这一行变高，「自己写一句」往下移。
  // 原来 page.click 用点击前算好的坐标，会点到例句卡片的空白处，面板不展开（失败截图见 049 验收记录）。
  // 所以先等每一句都有了场景标签（「场景」按钮或「＋场景」按钮）、布局不再变，再点。
  const sceneSettled = `(() => {
    const sentences = document.querySelectorAll('[data-testid=flash] .vocab-flash-example, [data-testid=flash] [data-testid=example-scene]').length;
    const tags = document.querySelectorAll('[data-testid=flash] [data-testid=scene-tag], [data-testid=flash] [data-testid=scene-add]').length;
    return sentences > 0 && tags === sentences;
  })()`;
  const ownOpenBefore = await page.evaluate(() => Math.round(document.querySelector('[data-testid=flash-examples] [data-testid=example-own-open]').getBoundingClientRect().top));
  await page.waitUntil('闪卡背面每句都有场景标签（或＋场景）', sceneSettled, { timeout: 15000 });
  const ownOpenAfter = await page.evaluate(() => Math.round(document.querySelector('[data-testid=flash-examples] [data-testid=example-own-open]').getBoundingClientRect().top));
  note('闪卡场景标签加载前后「自己写一句」位置', `${ownOpenBefore}px → ${ownOpenAfter}px`);
  await page.click('[data-testid=flash-examples] [data-testid=example-own-open]');
  await page.waitFor('[data-testid=flash-examples] [data-testid=own-input]');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=flash-card]')?.dataset.side), 'back', '点例句区不翻面');
  await page.evaluate(() => document.querySelector('[data-testid=flash-examples]').scrollIntoView({ block: 'center' }));
  await shot(page, '09-flash-back-examples-1280.png');
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  await page.evaluate(() => document.querySelector('[data-testid=flash-examples]').scrollIntoView({ block: 'center' }));
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('[data-testid=flash] *')].every(e => e.getBoundingClientRect().right <= document.documentElement.clientWidth + 1)), true, '390 闪卡不横向溢出');
  await shot(page, '10-flash-back-examples-390.png');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.click('[aria-label="退出闪卡（Esc）"]');
  await page.waitUntil('闪卡关闭', `!document.querySelector('[data-testid=flash]')`);
  evidence.checks.flash = flashWord;

  // ---------------- 4. 到期复习：作答中看不到例句 ----------------
  await traceInvoke(page);
  const traceStart = (await trace(page)).length;
  await page.click('[data-testid=due-recall-start]');
  await page.waitFor('[data-testid=recall-screen]');
  const cards = await page.evaluate(() => [...document.querySelectorAll('[data-testid=recall-question]')].map(card => ({ word: card.dataset.word.split('@')[0], format: card.dataset.format })));
  note('复习这一屏', cards.map(c => `${c.word}/${c.format}`));
  assert.deepEqual(cards.map(c => c.format).sort(), ['compose', 'fill', 'fill', 'paraphrase']);
  const recallClean = async label => {
    const state = await page.evaluate(m => {
      const root = document.querySelector('[data-testid=recall]');
      return {
        marker: root.innerText.includes(m),
        examples: root.querySelectorAll('[data-testid=examples], [data-testid=recall-examples], [data-testid=recall-save-example], [data-testid=example-item]').length,
        words: /我的例句/.test(root.innerText),
      };
    }, MARKER);
    assert.deepEqual(state, { marker: false, examples: 0, words: false }, `${label}：复习弹层里没有例句和例句入口`);
  };
  await recallClean('作答中');
  await shot(page, '11-recall-writing-1280.png');
  const answers = {};
  for (const [index, card] of cards.entries()) {
    answers[index] = card.format === 'fill' ? card.word
      : card.format === 'paraphrase' ? `Excessive energy consumption can ${card.word} air pollution in large industrial cities.`
        : `The team had to ${card.word} the plan carefully before the final presentation.`;
    await page.type(`#recall-input-${index}`, answers[index]);
  }
  await page.click('[data-testid=recall-submit]');
  await page.waitUntil('判完', `document.querySelectorAll('[data-testid=recall-result]').length === 4`);
  await recallClean('逐屏判分后');
  const midTrace = (await trace(page)).slice(traceStart);
  note('作答到判分的后端命令', midTrace);
  assert.ok(midTrace.length > 0, '命令记录有效（至少记到出题时读的数据）');
  assert.equal(midTrace.includes('vocab_examples'), false, `作答、判分时没读例句（${midTrace.join(',')}）`);
  await page.waitUntil('「保存」可点', `(() => { const b = document.querySelector('[data-testid=recall-next]'); return !!b && !b.disabled; })()`);
  await page.click('[data-testid=recall-next]');
  await page.waitFor('[data-testid=recall-summary]');
  await page.waitFor('[data-testid=recall-save-example]');
  assert.ok((await trace(page)).slice(traceStart).includes('vocab_examples'), '结果页才读例句');

  // 结果页：改写、造句两题（都判对）各有「存为我的例句」，填空没有
  const saveRows = await page.evaluate(() => [...document.querySelectorAll('[data-testid=recall-result-row]')]
    .filter(row => row.querySelector('[data-testid=recall-save-example]')).map(row => row.dataset.word.split('@')[0]));
  const usageWords = cards.filter(c => c.format !== 'fill').map(c => c.word);
  assert.deepEqual(saveRows.sort(), [...usageWords].sort(), '只有判分通过的改写/造句题能存');
  const composeIndex = cards.findIndex(c => c.format === 'compose');
  const composeWord = cards[composeIndex].word;
  await page.click(`[data-testid=recall-result-row][data-word="${composeWord}@10.20"] [data-testid=recall-save-example]`);
  await page.waitFor(`[data-testid=recall-result-row][data-word="${composeWord}@10.20"] [data-testid=recall-example-saved]`);
  await page.evaluate(() => document.querySelector('[data-testid=recall-result-table]').scrollIntoView({ block: 'start' }));
  await shot(page, '12-summary-saved-1280.png');
  // 小入口：点开这个词，能看到刚存的和之前的标记例句
  await page.click(`[data-testid=recall-example-entry][data-word="${composeWord}@10.20"] summary`);
  await page.waitUntil('结果页例句列表', `document.querySelectorAll('[data-testid=recall-example-entry][data-word="${composeWord}@10.20"] [data-testid=example-item]').length === 2`);
  const summaryExamples = await page.evaluate(word => [...document.querySelectorAll(`[data-testid=recall-example-entry][data-word="${word}@10.20"] [data-testid=example-item]`)].map(item => `${item.querySelector('[data-testid=example-source]').innerText}|${item.querySelector('[data-testid=example-sentence]').innerText}`), composeWord);
  note('结果页小入口', summaryExamples);
  assert.deepEqual(summaryExamples, [`自己写|${answers[composeIndex]}`, `自己写|${MARKER} for ${composeWord}.`]);
  await page.evaluate(() => document.querySelector('[data-testid=recall-examples]').scrollIntoView({ block: 'start' }));
  await shot(page, '13-summary-examples-entry-1280.png');
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  await page.evaluate(() => document.querySelector('[data-testid=recall-result-table]').scrollIntoView({ block: 'start' }));
  assert.equal(await overlayFits(page), true, '390 结果页不横向溢出');
  await shot(page, '14-summary-390.png');
  await page.evaluate(() => document.querySelector('[data-testid=recall-examples]').scrollIntoView({ block: 'start' }));
  await shot(page, '15-summary-examples-390.png');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.click('[data-testid=recall-finish]');
  await page.waitUntil('复习关闭', `!document.querySelector('[data-testid=recall]')`);
  evidence.checks.review = { cards, saveRows, composeWord, summaryExamples };

  // ---------------- 5. 导出 ----------------
  const markdownPath = path.join(out, '复习库.md');
  const exported = await invoke(page, 'vocab_export', { request: { kind: 'review', path: markdownPath } });
  assert.equal(exported.examplesPath, path.join(out, '我的例句.md'));
  assert.equal(exported.examples, 8, 'resilient 3 句 + 4 个标记句 + 结果页存的 1 句');
  const examplesMd = fs.readFileSync(exported.examplesPath, 'utf8');
  assert.match(examplesMd, /^# 我的例句\n\n共 5 个词、8 句。/);
  assert.match(examplesMd, new RegExp(`## resilient\\n\\n- ${FIXED.replace(/[.]/g, '\\.')}\\n  - 来源：AI改过 · [^\\n]+\\n  - 义项：adj\\. returning to its original shape after being bent（义项 2）\\n  - 原句：${WRONG.replace(/[.]/g, '\\.')}\\n  - 说明：${FIX_REASON}`));
  assert.ok(examplesMd.includes(`- ${GENERATED[0]}\n  - 来源：AI生成`));
  assert.ok(examplesMd.includes(`- ${answers[composeIndex]}\n  - 来源：自己写`));
  assert.ok(fs.existsSync(path.join(out, '我的笔记.md')), '笔记文件照旧导出');
  const reviewMd = fs.readFileSync(markdownPath, 'utf8');
  assert.equal(reviewMd.includes(MARKER) || reviewMd.includes(FIXED), false, '复习库 Markdown 里没有例句');
  note('导出', exported.examplesPath);

  // ---------------- 6. 数据库与请求内容 ----------------
  const db = await openDb(session);
  const rows = queryRows(db, 'vocab_example');
  const words = queryRows(db, 'review_word');
  const definitionExamplesAfter = queryRows(db, 'review_definition_example').length;
  db.close();
  assert.equal(rows.length, 8);
  assert.equal(definitionExamplesAfter, definitionExamplesBefore, '没写进原例句表');
  assert.equal(words.find(w => w.word === 'resilient').note, 'resilient 的复习备注', '原备注列没动');
  const resilientRows = rows.filter(row => row.word_key === 'resilient');
  assert.deepEqual(resilientRows.map(row => row.source).sort(), ['AI改过', 'AI生成', 'AI生成']);
  assert.ok(resilientRows.every(row => row.sense === 'adj. returning to its original shape after being bent（义项 2）'));
  assert.equal(rows.find(row => row.sentence === answers[composeIndex]).source, '自己写');
  for (const call of calls) {
    for (const secret of ['PRIVATE-NOTE-043', '的复习备注', MARKER]) assert.equal(call.raw.includes(secret), false, `${call.kind} 请求里不含「${secret}」`);
  }
  note('假模型请求', calls.map(call => call.kind));

  const unexpectedErrors = page.errors.filter(error => !/^(Dictionary lookup failed: )?plugin http not found$/.test(error));
  assert.deepEqual(unexpectedErrors, [], '除隔离模式刻意不注册 http 插件外，不应有页面错误');
  Object.assign(evidence, {
    exported, examplesMd, rows, calls: calls.map(call => ({ ...call, raw: undefined })),
    screenshots: fs.readdirSync(out).filter(name => name.endsWith('.png')).sort(), unexpectedErrors, log,
  });
  const evidenceText = JSON.stringify(evidence, null, 2);
  assert.equal(evidenceText.includes(KEY), false, '证据里不含假密钥');
  fs.writeFileSync(path.join(out, 'evidence.json'), evidenceText, 'utf8');
  note('证据', path.join(out, 'evidence.json'));
  passed = true;
} catch (error) {
  if (page) await page.screenshot(path.join(out, 'failure.png'), { full: false }).catch(() => {});
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify({ ...evidence, log, calls: calls.map(call => ({ ...call, raw: undefined })) }, null, 2), 'utf8');
  console.error(error);
  process.exitCode = 1;
} finally {
  if (session) await stop(session.runDir);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  note('隔离窗口', passed ? '全部通过后已关闭' : '失败后已关闭');
}
