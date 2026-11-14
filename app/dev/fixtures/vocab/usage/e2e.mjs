// 038 真实窗口验证：隔离数据目录 + 本机假模型，不调用真实模型。
// 1. 没配模型：一轮 8 题只有填空，并说明为什么没有改写/造句。
// 2. 配了假模型：一轮 8 题 = 4 填空 + 2 改写 + 2 造句（两屏各 4 题）。作答前点词查词不泄题、造句目标词不能点；
//    改写一对一错（近义词）、造句一错（没用目标词）一对（第一次判分失败 → 不算对、要自评或重判 → 重判成功）。
//    断言界面显示的判定 / 语法修正版 / 学术升级版、写回结果（状态、review_log 的 kind）。
// 3. 新词首考（2 个新词）：改写题点「忘记了」，按答错写回。
// 4. 390 宽度不横向溢出；截图在输出目录。
// 用法（在 app 目录）：node dev/fixtures/vocab/usage/e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { start, stop } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { openDb, queryRows } from '../../../e2e/db.mjs';

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.resolve('src-tauri/target/e2e', `038-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const plusDays = days => {
  const date = new Date(`${localDate()}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDate(date);
};
const today = localDate();
const KEY = 'dummy-e2e-key-038';

// 8 个到期词（L3、今天到期）+ 2 个新词。例句都用原形，填空答案就是原形。
const DUE = [
  ['exacerbate', 'to make a problem or situation worse', 'Without more investment, the policy could exacerbate the housing shortage in big cities.'],
  ['mitigate', 'to make something bad less severe', 'Governments introduced new measures to mitigate the effects of rising food prices.'],
  ['comprise', 'to consist of particular parts', 'Next year the degree course will comprise six core modules and two optional ones.'],
  ['allocate', 'to give something officially for a purpose', 'The council will allocate extra funds to the new library project next year.'],
  ['undermine', 'to make something weaker gradually', 'Constant criticism can undermine the confidence of young researchers in a lab.'],
  ['sustain', 'to keep something going over time', 'Few small farms can sustain such high costs for more than a year.'],
  ['facilitate', 'to make an action or process easier', 'Online tools can facilitate communication between students and their supervisors.'],
  ['assess', 'to judge the quality or importance of something', 'Teachers must assess the essays according to clear and public criteria every term.'],
];
const SEED = [
  ['derive', 'to get something from a source', 'Many English words derive from Latin and Greek roots, as the dictionary shows.'],
  ['clarify', 'to make something clearer or easier to understand', 'The teacher will clarify the instructions for the group task before the test.'],
];
const ALL = [...DUE, ...SEED];
const TARGETS = ALL.map(([word]) => word);
const reviewWords = [
  ...DUE.map(([word], index) => ({ id: `${word}@10.20`, word, status: 'L3', level: 3, note: `${word} 的复习备注`, line: index + 2, raw: `| ${word} | 10.20 |`, issue: '10.20', addedAt: today, due: today })),
  ...SEED.map(([word], index) => ({ id: `${word}@11.01`, word, status: '🌱待考察', level: null, note: `${word} 的新词备注`, line: index + 20, raw: `| ${word} | 11.01 |`, issue: '11.01', addedAt: today, due: '' })),
];
const importRequest = {
  upgrade: { fileName: 'empty-upgrade.md', content: '# 学术升级库\n' },
  review: { fileName: 'usage-038.md', content: '# 词汇总词库\n' },
  entries: [{ id: 'dummy@1.1', line: 2, raw: '| dummy |', plain: 'dummy', upgrade: 'dummy', source: '测试', note: '' }],
  examples: [], selfChecks: [], reviewWords, warnings: { upgrade: [], review: [] },
};
const issueFiles = [
  { fileName: '20261020.md', content: `## 词单分析\n${DUE.map(([w, e, s], i) => `${i + 1}. **${w}** v. — ${e}（释义 ${i + 1}）；*${s}*`).join('\n')}\n` },
  { fileName: '20261101.md', content: `## 词单分析\n${SEED.map(([w, e, s], i) => `${i + 1}. **${w}** v. — ${e}（释义 ${i + 1}）；*${s}*`).join('\n')}\n` },
];

const mentions = (text, word) => new RegExp(`\\b${word.slice(0, Math.max(5, word.length - 2))}`, 'i').test(text);

// ---- 本机假 OpenAI 兼容服务 ----
const calls = [];
let composeGrades = 0;
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
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(req.headers.authorization, `Bearer ${KEY}`);
  const prompt = payload.messages[0].content;
  res.setHeader('Content-Type', 'application/json');
  const reply = content => res.end(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }));
  if (prompt.includes('Tasks:')) {
    const tasks = JSON.parse(prompt.slice(prompt.indexOf('Tasks:') + 'Tasks:'.length));
    calls.push({ kind: 'usage', tasks: tasks.map(t => `${t.target}/${t.format}`), hasNote: prompt.includes('复习备注') || prompt.includes('新词备注') });
    return reply({ tasks: tasks.map(usageDraft) });
  }
  if (prompt.includes('Items:')) {
    const items = JSON.parse(prompt.slice(prompt.indexOf('Items:') + 'Items:'.length));
    calls.push({ kind: 'fill', ids: items.map(item => item.id) });
    return reply({ questions: items.map(item => ({ id: item.id, meaning: '', sentence: `Most experts agreed that the plan would [[${item.target}]] the situation in rural towns.` })) });
  }
  if (prompt.includes('Task type:')) {
    const target = JSON.parse(prompt.match(/^Target expression: (.*)$/m)[1]);
    const answer = JSON.parse(prompt.match(/^Student's answer: (.*)$/m)[1]);
    const format = prompt.includes('Task type: paraphrase') ? 'paraphrase' : 'compose';
    calls.push({ kind: 'grade', target, format, answer });
    if (format === 'compose') {
      composeGrades += 1;
      // 第二道造句题第一次判分：回一段不是 JSON 的话 → 判分失败，必须退回自评/重判。
      if (composeGrades === 2) return reply('Great sentence, well done!');
    }
    const used = new RegExp(`\\b${target}\\w*`, 'i').test(answer);
    return reply(used
      ? { usedTarget: true, grammarOk: true, taskOk: true, verdict: 'correct', reason: `${target} 用法正确，搭配自然。`, targetForm: target, grammarFix: answer, academicUpgrade: `UPGRADE: ${answer.replace(/\.$/, '')}, according to recent studies.` }
      : { usedTarget: false, grammarOk: true, taskOk: true, verdict: 'incomplete', reason: `没有用 ${target}，用了意思相近的别的词。`, targetForm: target, grammarFix: `FIX: ${answer}`, academicUpgrade: `UPGRADE: rewritten with ${target}.` });
  }
  const word = prompt.match(/Define the word "([^"]*)"/)?.[1] ?? '';
  calls.push({ kind: 'lookup', word, prompt });
  // 故意在查词结果里放所有目标词：卡片必须把作答中的答案遮住。
  return reply({ word, partOfSpeech: 'n.', definition: `测试释义：${word}。${TARGETS.join(' / ')}` });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const modelPort = server.address().port;

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
const scrollTo = (page, selector, index = 0) => page.evaluate((sel, i) => document.querySelectorAll(sel)[i]?.scrollIntoView({ block: 'start' }), selector, index);
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
  && [...document.querySelectorAll('[data-testid=recall] *')].every(e => e.getBoundingClientRect().right <= document.documentElement.clientWidth + 1));
const readState = async session => {
  const db = await openDb(session);
  const state = {
    words: Object.fromEntries(queryRows(db, 'review_word').map(row => [row.word, `${row.status}/${row.due}`])),
    logs: queryRows(db, 'review_log'),
  };
  db.close();
  return state;
};
const cards = page => page.evaluate(() => [...document.querySelectorAll('[data-testid=recall-question]')].map(card => ({
  word: card.dataset.word.split('@')[0],
  format: card.dataset.format,
  text: card.innerText,
})));
const results = page => page.evaluate(() => [...document.querySelectorAll('[data-testid=recall-question]')].map(card => {
  const pick = id => card.querySelector(`[data-testid=${id}]`)?.innerText ?? '';
  const result = card.querySelector('[data-testid=recall-result]');
  return {
    word: card.dataset.word.split('@')[0], format: card.dataset.format,
    kind: result?.dataset.kind ?? (card.querySelector('[data-testid=recall-self-check]') ? 'manual' : ''),
    correct: result?.dataset.correct ?? 'pending',
    verdict: pick('recall-verdict'), reason: pick('recall-reason'), fix: pick('recall-grammar-fix'), upgrade: pick('recall-upgrade'), reference: pick('recall-reference'),
  };
}));
/** 作答前：每道「答案藏着」的题，它的目标词不能出现在本屏任何地方（造句题自己的目标词除外）。 */
const screenLeaks = page => page.evaluate(() => {
  const screen = document.querySelector('[data-testid=recall-screen]').innerText;
  return [...document.querySelectorAll('[data-testid=recall-question]')]
    .filter(card => card.dataset.format !== 'compose')
    .map(card => card.dataset.word.split('@')[0])
    .filter(word => new RegExp(`\\b${word.slice(0, Math.max(5, word.length - 2))}`, 'i').test(screen));
});
const popupText = page => page.evaluate(() => document.querySelector('[data-definition-popup] [role=dialog]')?.innerText ?? '');
const closePopup = async page => {
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await page.waitUntil('查词卡关闭', `!document.querySelector('[data-definition-popup]')`);
};
const wordPoint = (page, selector, wanted) => page.evaluate((sel, w) => {
  const root = document.querySelector(sel);
  if (!root) throw new Error(`找不到点击容器：${sel}`);
  root.scrollIntoView({ block: 'center', inline: 'center' });
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const at = node.data.toLowerCase().indexOf(w.toLowerCase());
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + w.length);
    const r = range.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  throw new Error(`在 ${sel} 里找不到词：${w}`);
}, selector, wanted);
const waitNextEnabled = page => page.waitUntil('「保存」可点', `(() => { const b = document.querySelector('[data-testid=recall-next]'); return !!b && !b.disabled; })()`);
const configureModel = page => page.evaluate(baseUrl => {
  localStorage.setItem('linguaclip_ai_config', JSON.stringify({ baseUrl, apiKey: 'dummy-e2e-key-038', model: 'fake-038', temperature: 0.7 }));
  window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);
}, `http://127.0.0.1:${modelPort}/v1`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** 关掉复习弹层后词库页会重新读数据、布局会动；按坐标点可能落空。点了没出弹层就等一下再点（弹层出来后不会再点）。 */
const clickUntil = async (page, selector, appear) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.click(selector);
    for (let i = 0; i < 15; i += 1) {
      if (await page.evaluate(sel => !!document.querySelector(sel), appear)) return;
      await sleep(200);
    }
  }
  throw new Error(`点了 ${selector} 也没出现 ${appear}`);
};

const evidence = { today, runDir };
let session;
let page;
let passed = false;
try {
  note('本机今天', today);
  session = await start({ runDir, port: 9474 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.clickText('词库', { timeout: 60000 });
  const report = await invoke(page, 'vocab_import', { request: importRequest });
  assert.equal(report.reviewWords.added, 10);
  const definitions = await invoke(page, 'vocab_definition_import', { request: { issues: issueFiles, eagp: null } });
  assert.equal(definitions.examplesAdded, 10);
  await page.reload();
  await page.clickText('词库');
  await page.waitUntil('到期区读取 8 条', `document.querySelector('[data-testid=due-count]')?.innerText.includes(' 8 个词')`);
  const initial = await readState(session);

  // ---------------- 1. 没配模型：只有填空 + 说明 ----------------
  await page.evaluate(() => localStorage.removeItem('linguaclip_ai_config'));
  await page.click('[data-testid=due-recall-start]');
  await page.waitFor('[data-testid=recall-screen]');
  const offlineFormats = await page.evaluate(() => [...document.querySelectorAll('[data-testid=recall-question]')].map(card => card.dataset.format));
  assert.deepEqual(offlineFormats, ['fill', 'fill', 'fill', 'fill'], '没配模型：第 1 屏只有填空');
  assert.match(await page.text('[data-testid=recall-progress]'), /第 1 \/ 2 屏 · 本屏 4 题 · 共 8 题/);
  const offlineNotice = await page.text('[data-testid=recall-notices]');
  assert.match(offlineNotice, /没配置模型：这一轮只出看释义填空题。改写、造句题要由模型出题和判分/);
  assert.equal(calls.length, 0, '没配模型不发请求');
  await shot(page, '01-no-model-fill-only.png');
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  assert.equal(await noOverflow(page), true, '390 不横向溢出（没配模型）');
  await shot(page, '01b-no-model-390.png');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await page.waitUntil('退出', `!document.querySelector('[data-testid=recall]')`);
  assert.deepEqual((await readState(session)).words, initial.words, '只看题不写库');
  evidence.offline = { formats: offlineFormats, notice: offlineNotice };

  // ---------------- 2. 配了假模型：三种题混在一轮 ----------------
  await configureModel(page);
  await page.click('[data-testid=due-recall-start]');
  await page.waitFor('[data-testid=recall-screen]');
  const usageCalls = calls.filter(call => call.kind === 'usage');
  assert.equal(usageCalls.length, 1, '改写/造句一次批量出题');
  assert.equal(usageCalls[0].tasks.length, 4);
  assert.equal(usageCalls[0].hasNote, false, '复习备注不发给模型');
  assert.equal(calls.filter(call => call.kind === 'fill').length, 0, '有现成例句的填空题不请求模型');
  assert.match(await page.text('[data-testid=recall-progress]'), /第 1 \/ 2 屏 · 本屏 4 题 · 共 8 题/);
  const screen1 = await cards(page);
  note('第 1 屏', screen1.map(card => `${card.word}/${card.format}`));
  assert.deepEqual(screen1.map(card => card.format), ['fill', 'paraphrase', 'fill', 'compose'], '一屏里混着填空、改写、造句');
  assert.match(await page.text('.vocab-quiz-guide'), /改写、造句题/);
  assert.deepEqual(await screenLeaks(page), [], '作答前本屏不出现任何藏着的答案');
  const para1 = screen1[1];
  const comp1 = screen1[3];
  assert.match(para1.text, /改写要求/);
  assert.match(para1.text, /原句/);
  assert.match(para1.text, /Excessive energy consumption makes air pollution much worse/);
  assert.equal(mentions(para1.text, para1.word), false, '改写题面不出现目标词');
  assert.match(para1.text, new RegExp(`目标词：${para1.word[0]}_+`), '改写题有首字母提示');
  assert.match(comp1.text, new RegExp(`造句要求\\s*${comp1.word}`), '造句题写出目标词');
  assert.match(comp1.text, /Use "the team" as the subject/);
  await shot(page, '02-mixed-screen1-writing.png');

  // 034 点词查词：作答前点改写原句里的 pollution，请求和卡片都不能露出本屏藏着的答案。
  const lookupsBefore = calls.filter(call => call.kind === 'lookup').length;
  const sel = `[data-word="${para1.word}@10.20"] [data-testid=recall-task-original]`;
  const p = await wordPoint(page, sel, 'pollution');
  await page.mouseClick(p.x, p.y);
  await page.waitFor('[data-definition-popup] [role=dialog]');
  await page.waitUntil('查词结果', `document.querySelector('[data-definition-popup]')?.innerText.includes('测试释义')`);
  const lookup = calls.filter(call => call.kind === 'lookup').slice(lookupsBefore);
  assert.equal(lookup.length, 1);
  assert.equal(lookup[0].word, 'pollution');
  const hiddenOnScreen = screen1.filter(card => card.format !== 'compose').map(card => card.word);
  for (const w of hiddenOnScreen) {
    assert.equal(mentions(lookup[0].prompt, w), false, `查词请求不含 ${w}`);
    assert.equal(mentions(await popupText(page), w), false, `查词卡遮住 ${w}`);
  }
  await shot(page, '03-lookup-in-paraphrase.png');
  await closePopup(page);
  // 造句题的目标词作答时不能点（点了不弹卡）
  const tp = await wordPoint(page, `[data-word="${comp1.word}@10.20"] [data-testid=recall-task-instruction]`, comp1.word);
  await page.mouseClick(tp.x, tp.y);
  await sleep(800);
  assert.equal(await page.evaluate(() => !!document.querySelector('[data-definition-popup]')), false, '作答时造句目标词不能点');
  evidence.lookup = { word: 'pollution', hiddenOnScreen, prompt: lookup[0].prompt.slice(0, 400) };

  // 第 1 屏作答：填空都对；改写用上目标词（对）；造句没用目标词（错）
  const fillAnswer = word => word; // 例句里都是原形
  const answers1 = {
    0: fillAnswer(screen1[0].word),
    1: `Excessive energy consumption can ${para1.word} air pollution in large industrial cities.`,
    2: fillAnswer(screen1[2].word),
    3: 'The team divided the budget between the design work and the survey.',
  };
  for (const [index, text] of Object.entries(answers1)) await page.type(`#recall-input-${index}`, text);
  await page.click('[data-testid=recall-submit]');
  await page.waitUntil('第 1 屏判完', `document.querySelectorAll('[data-testid=recall-result]').length === 4`);
  const graded1 = await results(page);
  note('第 1 屏判分', graded1.map(r => `${r.word}/${r.format}/${r.kind}/${r.correct}`));
  assert.deepEqual(graded1.map(r => `${r.kind}/${r.correct}`), ['correct/true', 'correct/true', 'correct/true', 'incomplete/false']);
  assert.equal(graded1[1].fix, answers1[1], '改写判对：显示语法修正版');
  assert.match(graded1[1].upgrade, /^UPGRADE: Excessive energy consumption/, '显示学术升级版');
  assert.match(graded1[1].reference, new RegExp(`can ${para1.word} air pollution`), '判完显示参考答案');
  assert.match(graded1[3].verdict, /未完成（没用上目标表达）/);
  assert.match(graded1[3].reason, new RegExp(`没有用 ${comp1.word}`));
  assert.equal(graded1[3].fix, `FIX: ${answers1[3]}`);
  assert.equal(graded1[3].upgrade, `UPGRADE: rewritten with ${comp1.word}.`);
  assert.equal((await readState(session)).logs.length, 0, '判分不写库，点保存才写');
  await shot(page, '04-screen1-graded.png');
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  await scrollTo(page, '[data-testid=recall-question]', 1);
  assert.equal(await noOverflow(page), true, '390 不横向溢出（改写判分）');
  await shot(page, '05-390-paraphrase-graded.png');
  await scrollTo(page, '[data-testid=recall-question]', 3);
  assert.equal(await noOverflow(page), true, '390 不横向溢出（造句判分）');
  await shot(page, '06-390-compose-graded.png');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await waitNextEnabled(page);
  await page.click('[data-testid=recall-next]');

  // 第 2 屏：改写用近义词（错）；造句用上目标词，但第一次判分失败 → 不能保存、要自评或重判
  await page.waitUntil('进入第 2 屏', `document.querySelector('[data-testid=recall-progress]')?.innerText.includes('第 2 / 2 屏 · 本屏 4 题')`);
  const screen2 = await cards(page);
  note('第 2 屏', screen2.map(card => `${card.word}/${card.format}`));
  assert.deepEqual(screen2.map(card => card.format), ['fill', 'paraphrase', 'fill', 'compose']);
  assert.deepEqual(await screenLeaks(page), [], '第 2 屏作答前也不泄题');
  const para2 = screen2[1];
  const comp2 = screen2[3];
  await shot(page, '07-screen2-writing.png');
  // 输入框编号是全轮题号：第 2 屏是 4–7。
  const answers2 = {
    4: fillAnswer(screen2[0].word),
    5: 'Excessive energy consumption can worsen air pollution in large industrial cities.',
    6: fillAnswer(screen2[2].word),
    7: `The team had to ${comp2.word} the plan carefully before the final presentation.`,
  };
  for (const [index, text] of Object.entries(answers2)) await page.type(`#recall-input-${index}`, text);
  await page.click('[data-testid=recall-submit]');
  await page.waitUntil('第 2 屏判完', `document.querySelectorAll('[data-testid=recall-result]').length === 3 && !!document.querySelector('[data-testid=recall-self-check]')`);
  let graded2 = await results(page);
  note('第 2 屏判分（判分失败一次）', graded2.map(r => `${r.word}/${r.format}/${r.kind}/${r.correct}`));
  assert.deepEqual(graded2.map(r => `${r.kind}/${r.correct}`), ['correct/true', 'incomplete/false', 'correct/true', 'manual/pending'], '判分失败不算对');
  assert.match(graded2[1].reason, /没有用 /);
  const failText = await page.text(`[data-word="${comp2.word}@10.20"] [data-testid=recall-self-check]`);
  assert.match(failText, /模型判分失败（模型返回格式不正确/);
  assert.match(failText, /参考答案/);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=recall-next]').disabled), true, '判分失败、没自评之前不能保存');
  await scrollTo(page, '[data-testid=recall-question]', 3);
  await shot(page, '08-grading-failed-self-check.png');
  await page.click(`[data-word="${comp2.word}@10.20"] [data-testid=recall-regrade]`);
  await page.waitUntil('重判完成', `document.querySelectorAll('[data-testid=recall-result]').length === 4`);
  graded2 = await results(page);
  assert.deepEqual(graded2.map(r => `${r.kind}/${r.correct}`), ['correct/true', 'incomplete/false', 'correct/true', 'correct/true'], '重新判分成功');
  assert.equal(graded2[3].fix, answers2[7]);
  assert.match(graded2[3].upgrade, /^UPGRADE: The team had to/);
  await scrollTo(page, '[data-testid=recall-question]', 3);
  await shot(page, '09-regraded.png');
  await waitNextEnabled(page);
  await page.click('[data-testid=recall-next]');

  // ---------------- 结果表与写回 ----------------
  await page.waitFor('[data-testid=recall-summary]');
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid=recall-result-row]')].map(row => ({
    word: row.dataset.word.split('@')[0],
    written: row.querySelector('[data-testid=row-written]').innerText,
    verdict: row.querySelector('[data-testid=row-verdict]').innerText,
    change: row.querySelector('[data-testid=row-change]').innerText,
  })));
  note('结果表', rows);
  const byWord = Object.fromEntries(rows.map(row => [row.word, row]));
  assert.equal(rows.length, 8);
  assert.equal(await page.text('[data-testid=recall-correct-count]'), '6');
  assert.equal(await page.text('[data-testid=recall-wrong-count]'), '2');
  assert.match(byWord[comp1.word].verdict, /未完成/);
  assert.match(byWord[comp1.word].change, new RegExp(`L3 → L1，到期 ${plusDays(2).slice(5)}`));
  assert.match(byWord[para2.word].verdict, /未完成/);
  assert.match(byWord[para2.word].change, /L3 → L1/);
  assert.equal(byWord[para1.word].verdict, '答对');
  assert.match(byWord[para1.word].change, new RegExp(`L3 → L4，到期 ${plusDays(16).slice(5)}`));
  assert.equal(byWord[comp2.word].verdict, '答对');
  assert.equal(byWord[comp2.word].written, answers2[7]);
  await shot(page, '10-summary.png');
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  await scrollTo(page, '[data-testid=recall-result-table]');
  assert.equal(await noOverflow(page), true, '390 不横向溢出（结果表）');
  await shot(page, '11-390-summary.png');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });

  const afterReview = await readState(session);
  const logKinds = Object.fromEntries(afterReview.logs.map(row => [row.word_id.split('@')[0], `${row.kind}/${row.correct}`]));
  note('review_log', logKinds);
  assert.equal(afterReview.logs.length, 8);
  assert.equal(logKinds[para1.word], 'rewrite/1');
  assert.equal(logKinds[para2.word], 'rewrite/0');
  assert.equal(logKinds[comp1.word], 'sentence/0');
  assert.equal(logKinds[comp2.word], 'sentence/1');
  for (const card of [...screen1, ...screen2].filter(c => c.format === 'fill')) assert.equal(logKinds[card.word], 'recall/1');
  assert.equal(afterReview.words[para1.word], `L4/${plusDays(16)}`);
  assert.equal(afterReview.words[comp2.word], `L4/${plusDays(16)}`);
  assert.equal(afterReview.words[comp1.word], `L1/${plusDays(2)}`);
  assert.equal(afterReview.words[para2.word], `L1/${plusDays(2)}`);
  const grades = calls.filter(call => call.kind === 'grade');
  assert.equal(grades.length, 5, '4 道改写/造句判分 + 1 次重判');
  assert.equal(grades.filter(call => call.target === comp2.word).length, 2);
  await page.click('[data-testid=recall-finish]');

  // ---------------- 3. 新词首考：改写题点「忘记了」 ----------------
  await page.waitUntil('新词区读到 2 个', `document.querySelector('[data-testid=seed-count]')?.innerText.includes('待首考 2 个')`);
  await configureModel(page);
  await clickUntil(page, '[data-testid=first-test-start]', '[data-testid=recall]');
  await page.waitFor('[data-testid=recall-screen]');
  const firstCards = await cards(page);
  note('首考', firstCards.map(card => `${card.word}/${card.format}`));
  assert.deepEqual(firstCards.map(card => card.format), ['fill', 'paraphrase'], '首考也混入改写（2 题 → 1 道）');
  assert.deepEqual(await screenLeaks(page), []);
  const seedPara = firstCards[1];
  await page.type('#recall-input-0', seedPara.word === 'clarify' ? 'derive' : 'clarify');
  await page.click(`[data-word="${seedPara.word}@11.01"] [data-testid=recall-forgot]`);
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid=recall-forgot-note]').length), 1);
  assert.equal(mentions(await page.text('[data-testid=recall-screen]'), seedPara.word), false, '点了「忘记了」提交前也不露答案');
  await shot(page, '12-first-test-forgot.png');
  await page.click('[data-testid=recall-submit]');
  await page.waitUntil('首考判完', `document.querySelectorAll('[data-testid=recall-result]').length === 2`);
  const firstGraded = await results(page);
  assert.deepEqual(firstGraded.map(r => `${r.kind}/${r.correct}`), ['correct/true', 'forgot/false']);
  assert.match(firstGraded[1].reference, new RegExp(seedPara.word), '忘记了：提交后显示参考答案');
  assert.equal(calls.filter(call => call.kind === 'grade').length, 5, '「忘记了」不请求判分');
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  await scrollTo(page, '[data-testid=recall-question]', 1);
  assert.equal(await noOverflow(page), true, '390 不横向溢出（首考改写）');
  await shot(page, '13-390-first-test-forgot.png');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await waitNextEnabled(page);
  await page.click('[data-testid=recall-next]');
  await page.waitFor('[data-testid=recall-summary]');
  const afterFirst = await readState(session);
  const firstLogs = afterFirst.logs.filter(row => row.word_id.endsWith('@11.01')).map(row => `${row.word_id.split('@')[0]}/${row.kind}/${row.correct}`).sort();
  note('首考 review_log', firstLogs);
  assert.ok(firstLogs.includes(`${seedPara.word}/rewrite/0`), '忘记了按答错写回（rewrite）');
  assert.equal(afterFirst.words[seedPara.word], `L1/${plusDays(2)}`, '首考答错进 L1');
  assert.match(afterFirst.words[firstCards[0].word], /已掌握/, '首考答对记为已掌握');

  // 隔离窗口刻意不注册 http 插件：查词时在线词典那一步会报这句（随后改走假模型），不是本卡的问题。
  const unexpectedErrors = page.errors.filter(error => !/^(Dictionary lookup failed: )?plugin http not found$/.test(error));
  assert.deepEqual(unexpectedErrors, [], '除隔离模式刻意不注册 http 插件外，不应有页面错误');
  Object.assign(evidence, {
    screen1: screen1.map(c => `${c.word}/${c.format}`), screen2: screen2.map(c => `${c.word}/${c.format}`),
    graded1, graded2, rows, logKinds, words: afterFirst.words, firstLogs,
    calls: calls.map(call => ({ ...call, prompt: undefined })),
    screenshots: fs.readdirSync(out).filter(name => name.endsWith('.png')).sort(), unexpectedErrors, log,
  });
  const evidenceText = JSON.stringify(evidence, null, 2);
  assert.equal(evidenceText.includes(KEY), false, '证据里不含假密钥');
  fs.writeFileSync(path.join(out, 'evidence.json'), evidenceText, 'utf8');
  note('证据', path.join(out, 'evidence.json'));
  passed = true;
} catch (error) {
  if (page) await page.screenshot(path.join(out, 'failure.png'), { full: false }).catch(() => {});
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify({ ...evidence, log, calls: calls.map(call => ({ ...call, prompt: undefined })) }, null, 2), 'utf8');
  console.error(error);
  process.exitCode = 1;
} finally {
  if (session) await stop(session.runDir);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  note('隔离窗口', passed ? '全部通过后已关闭' : '失败后已关闭');
}
