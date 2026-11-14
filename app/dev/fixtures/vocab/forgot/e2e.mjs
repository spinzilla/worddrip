// 036 真实窗口验证：答题与闪卡界面改版 +「忘记了」。隔离数据目录 + 本机假模型，不碰真实数据库。
// 1. 闪卡：正面 / 翻面各截 1920 宽、390 宽；宽屏卡片要占大半个屏高，背面有英文释义、中文、例句。
// 2. 到期复习一屏 3 题：exacerbate 答对、mitigate 点「忘记了」（键盘 Tab + 回车）、comprise 答错。
//    断言：作答时不泄题、「忘记了」提交前可撤销、提交后锁定并显示答案；
//    写回后 mitigate 和 comprise 的状态、到期日、review_log 完全一致（kind = recall，correct = 0），不多写 review_event。
//    结果页「忘记了」那题可以换语境复检；复检里再点一次「忘记了」只记一条答错的复检日志。
// 3. 新词首考 2 题：sustain 点「忘记了」→ 进 L1；allocate 答对 → 已掌握。
// 用法（在 app 目录）：node dev/fixtures/vocab/forgot/e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { start, stop } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { openDb, queryRows } from '../../../e2e/db.mjs';

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.resolve('src-tauri/target/e2e', `036-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const plusDays = days => {
  const date = new Date(`${localDate()}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDate(date);
};
const today = localDate();
const KEY = 'dummy-e2e-key-036';

const dueWords = ['exacerbate', 'mitigate', 'comprise'];
const seedWords = ['sustain', 'allocate'];
const reviewWords = [
  ...dueWords.map((word, index) => ({
    id: `${word}@10.20`, word, status: 'L3', level: 3, note: `${word} 的复习备注：常和 problem / effect 搭配。`,
    line: index + 2, raw: `| ${word} | 10.20 |`, issue: '10.20', addedAt: today, due: today,
  })),
  ...seedWords.map((word, index) => ({
    id: `${word}@8.25`, word, status: '🌱待考察', level: null, note: `${word} 的新词备注`,
    line: index + 10, raw: `| ${word} | 8.25 | ${today} | 🌱待考察 | — |`, issue: '8.25', addedAt: today, due: '',
  })),
];
const importRequest = {
  upgrade: { fileName: 'empty-upgrade.md', content: '# 学术升级库\n' },
  review: { fileName: 'forgot-036.md', content: '# 词汇总词库\n' },
  entries: [{ id: 'dummy@1.1', line: 2, raw: '| dummy |', plain: 'dummy', upgrade: 'dummy', source: '测试', note: '' }],
  examples: [], selfChecks: [], reviewWords, warnings: { upgrade: [], review: [] },
};
const issueFiles = [
  {
    fileName: '20261020.md',
    content: `## 词单分析
1. **exacerbate** v. — to make a problem or situation worse（使恶化）；*Without more investment, the policy could exacerbate the housing shortage.*
2. **mitigate** v. — to make something bad less severe or less harmful（减轻）；*Governments introduced new measures to mitigate the effects of rising prices.*
3. **comprise** v. — to consist of particular parts（由……组成）；*The course comprises six core modules and two electives.*
`,
  },
  {
    fileName: '20260825.md',
    content: `## 词单分析
1. **sustain** v. — to keep something going over time（维持）；*Few small farms can sustain such high costs for long.*
2. **allocate** v. — to give something to someone for a particular purpose（分配）；*The council will allocate funds to the new library project.*
`,
  },
];

// ---- 本机假 OpenAI 兼容服务：只在复检时给 mitigate 写新语境句 ----
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const invoke = async (page, command, args = {}) => {
  const outcome = await page.evaluate(async (cmd, payload) => {
    try { return { value: await window.__TAURI_INTERNALS__.invoke(cmd, payload) }; }
    catch (error) { return { error: typeof error === 'string' ? error : String(error) }; }
  }, command, args);
  if (outcome.error) throw new Error(`${command} 失败：${outcome.error}`);
  return outcome.value;
};
const shots = [];
const shot = async (page, name) => { shots.push(name); await page.screenshot(path.join(out, name), { full: false }); };
const desktop = (page, width) => page.setViewport(width, width >= 1900 ? 1080 : 900, { mobile: false, dpr: 1 });
const narrow = page => page.setViewport(390, 844, { mobile: true, dpr: 1 });
const noOverflow = (page, root) => page.evaluate(sel => document.documentElement.scrollWidth <= document.documentElement.clientWidth
  && [...document.querySelectorAll(`${sel} *`)].every(e => e.getBoundingClientRect().right <= document.documentElement.clientWidth + 1), root);
const KEYS = {
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  ' ': { code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
};
/** 真实按键（经浏览器输入管线）：Tab 会真的移动焦点，回车会真的提交表单。 */
async function press(page, key) {
  const k = KEYS[key];
  await page.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, text: k.text });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
  await sleep(150);
}
const active = page => page.evaluate(() => {
  const e = document.activeElement;
  const card = e?.closest('[data-testid=recall-question]');
  const cards = [...document.querySelectorAll('[data-testid=recall-question]')];
  return { id: e?.id ?? '', testid: e?.dataset?.testid ?? '', card: card ? cards.indexOf(card) : -1 };
});
/** 弹层里（不含输入框）出现的目标词。作答时必须为空。 */
const leakedWords = (page, list) => page.evaluate(words => {
  const text = document.querySelector('[data-testid=recall]')?.innerText ?? '';
  return words.filter(word => new RegExp(`\\b${word}`, 'i').test(text));
}, list);
const questionState = page => page.evaluate(() => [...document.querySelectorAll('[data-testid=recall-question]')].map(card => ({
  forgot: card.dataset.forgot,
  tone: card.dataset.tone,
  readOnly: card.querySelector('[data-testid=recall-input]').readOnly,
  forgotButton: card.querySelector('[data-testid=recall-forgot]')?.innerText.trim() ?? null,
})));
/** 宽屏版式：题面和作答区并排，释义字号够大，卡片用满版心。 */
const quizLayout = page => page.evaluate(() => {
  const card = document.querySelector('[data-testid=recall-question]');
  const prompt = card.querySelector('.vocab-q-prompt').getBoundingClientRect();
  const answer = card.querySelector('.vocab-q-answer').getBoundingClientRect();
  const meaning = card.querySelector('[data-testid=recall-meaning]');
  const sentence = card.querySelector('[data-testid=recall-context]');
  return {
    viewport: window.innerWidth,
    cardWidth: Math.round(card.getBoundingClientRect().width),
    sideBySide: answer.left >= prompt.right - 1 && Math.abs(answer.top - prompt.top) < 40,
    meaningPx: parseFloat(getComputedStyle(meaning).fontSize),
    sentencePx: parseFloat(getComputedStyle(sentence).fontSize),
    bodyPx: parseFloat(getComputedStyle(document.body).fontSize),
  };
});
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
const flash = page => page.evaluate(() => {
  const el = document.querySelector('[data-testid=flash]');
  const card = el?.querySelector('[data-testid=flash-card]');
  const rect = card?.getBoundingClientRect();
  return {
    side: card?.dataset.side ?? '',
    word: el?.querySelector('[data-testid=flash-word]')?.innerText ?? el?.querySelector('[data-testid=flash-back]')?.innerText.split('\n')[0] ?? '',
    back: el?.querySelector('[data-testid=flash-back]')?.innerText ?? '',
    cardWidth: rect ? Math.round(rect.width) : 0,
    cardHeightRatio: rect ? rect.height / window.innerHeight : 0,
    wordPx: parseFloat(getComputedStyle(el?.querySelector('[data-testid=flash-word]') ?? document.body).fontSize),
  };
});

let session;
let page;
let passed = false;
const evidence = { today, runDir };
try {
  note('本机今天', today);
  session = await start({ runDir, port: 9468 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await desktop(page, 1920);
  await page.clickText('词库', { timeout: 60000 });
  const report = await invoke(page, 'vocab_import', { request: importRequest });
  assert.equal(report.reviewWords.added, 5);
  const definitions = await invoke(page, 'vocab_definition_import', { request: { issues: issueFiles, eagp: null } });
  assert.equal(definitions.examplesAdded, 5);
  await page.reload();
  await page.clickText('词库');
  await page.waitUntil('到期区读取 3 条', `document.querySelector('[data-testid=due-count]')?.innerText.includes(' 3 个词')`);
  await page.evaluate((baseUrl, key) => {
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({ baseUrl, apiKey: key, model: 'fake-036', temperature: 0.7 }));
    window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);
    // 038 起配了模型会混入改写/造句题；本脚本专测填空流程，用开发钩子只出填空（改写/造句见 dev/fixtures/vocab/usage/e2e.mjs）。
    window.__ES_E2E_FILL_ONLY__ = true;
  }, `http://127.0.0.1:${modelPort}/v1`, KEY);

  // ================= 1. 闪卡：1920 / 390，正面和翻面 =================
  await page.click('[data-testid=due-start]');
  await page.waitFor('[data-testid=flash]');
  let f = await flash(page);
  note('闪卡正面 1920', { cardWidth: f.cardWidth, heightRatio: f.cardHeightRatio.toFixed(2), wordPx: f.wordPx });
  assert.equal(f.side, 'front');
  assert.equal(f.word, 'exacerbate');
  assert.ok(f.cardWidth >= 960, `1920 宽时闪卡至少 960px 宽（实际 ${f.cardWidth}）`);
  assert.ok(f.cardHeightRatio >= 0.6, `1920 宽时闪卡占屏高至少 60%（实际 ${f.cardHeightRatio.toFixed(2)}）`);
  assert.ok(f.wordPx >= 60, `宽屏正面词目字号够大（实际 ${f.wordPx}px）`);
  await shot(page, '01-flash-front-1920.png');
  await press(page, ' ');
  f = await flash(page);
  assert.equal(f.side, 'back');
  assert.equal(f.word, 'exacerbate', '背面第一行是词目');
  for (const text of ['英文释义', 'to make a problem or situation worse', '使恶化', 'Without more investment', '状态', 'L3', '到期日', '完整备注', '常和 problem']) {
    assert.ok(f.back.includes(text), `闪卡背面缺「${text}」`);
  }
  const backLayout = await page.evaluate(() => {
    const defs = document.querySelector('[data-testid=flash-definitions]').getBoundingClientRect();
    const aside = document.querySelector('.vocab-flash-aside').getBoundingClientRect();
    return { sideBySide: aside.left >= defs.right - 1, enPx: parseFloat(getComputedStyle(document.querySelector('.vocab-flash-def-en')).fontSize) };
  });
  assert.equal(backLayout.sideBySide, true, '1920 宽时背面释义和备注左右并排');
  assert.ok(backLayout.enPx >= 20, `背面英文释义字号够大（实际 ${backLayout.enPx}px）`);
  await shot(page, '02-flash-back-1920.png');
  await narrow(page);
  assert.equal(await noOverflow(page, '[data-testid=flash]'), true, '390 宽闪卡背面不横向溢出');
  await shot(page, '03-flash-back-390.png');
  await press(page, ' ');
  assert.equal((await flash(page)).side, 'front');
  assert.equal(await noOverflow(page, '[data-testid=flash]'), true, '390 宽闪卡正面不横向溢出');
  await shot(page, '04-flash-front-390.png');
  await press(page, 'Escape');
  await page.waitUntil('Esc 关闭闪卡', '!document.querySelector("[data-testid=flash]")');
  await desktop(page, 1920);
  let state = await readState(session);
  assert.equal(state.logs.length, 0, '闪卡只看不写库');

  // ================= 2. 到期复习：答对 / 忘记了 / 答错 =================
  await page.click('[data-testid=due-recall-start]');
  await page.waitFor('[data-testid=recall-screen]');
  assert.match(await page.text('[data-testid=recall-progress]'), /第 1 \/ 1 屏 · 本屏 3 题 · 共 3 题/);
  assert.equal(modelCalls.length, 0, '3 个词都有现成例句，首轮不请求模型');
  assert.deepEqual(await leakedWords(page, dueWords), [], '作答前不泄题');
  assert.equal((await active(page)).id, 'recall-input-0', '打开后焦点在第 1 题输入框');
  const wide = await quizLayout(page);
  note('1920 题卡版式', wide);
  assert.equal(wide.sideBySide, true, '1920 宽时题面和作答区左右并排');
  assert.ok(wide.cardWidth >= 1100, `1920 宽时题卡用满版心（实际 ${wide.cardWidth}px）`);
  assert.ok(wide.meaningPx >= wide.bodyPx * 1.5, `英文释义字号明显大于正文（${wide.meaningPx}px / 正文 ${wide.bodyPx}px）`);
  assert.ok(wide.sentencePx >= 20, `语境句字号够大（实际 ${wide.sentencePx}px）`);
  await shot(page, '05-quiz-1920.png');

  // 第 1 题答对；第 2 题用键盘：Tab 到「忘记了」，回车按下，焦点自动跳到第 3 题
  await page.type('#recall-input-0', 'exacerbate');
  await page.evaluate(() => document.querySelector('#recall-input-1').focus());
  await press(page, 'Tab');
  let focus = await active(page);
  assert.deepEqual([focus.testid, focus.card], ['recall-forgot', 1], 'Tab 从输入框到本题「忘记了」');
  await press(page, 'Enter');
  focus = await active(page);
  assert.equal(focus.id, 'recall-input-2', '点「忘记了」后焦点跳到下一题输入框');
  let q = await questionState(page);
  assert.deepEqual([q[1].forgot, q[1].tone, q[1].readOnly, q[1].forgotButton], ['true', 'forgot', true, '撤销']);
  assert.match(await page.text('[data-testid=recall-forgot-note]'), /按答错计，提交这一屏后显示答案/);
  assert.deepEqual(await leakedWords(page, dueWords), [], '点了「忘记了」、提交前不显示答案（也不泄同屏其他题）');

  // 提交前可以撤销：撤销后焦点回到本题、可以继续写；再点一次（鼠标）恢复「忘记了」
  await page.click('[data-testid=recall-question]:nth-child(2) [data-testid=recall-forgot]');
  await sleep(150);
  q = await questionState(page);
  assert.deepEqual([q[1].forgot, q[1].readOnly, q[1].forgotButton], ['false', false, '忘记了'], '提交前可以撤销');
  assert.equal((await active(page)).id, 'recall-input-1', '撤销后焦点回到本题');
  await page.click('[data-testid=recall-question]:nth-child(2) [data-testid=recall-forgot]');
  await sleep(150);
  assert.equal((await questionState(page))[1].forgot, 'true');
  await page.type('#recall-input-2', 'comprehend');
  assert.equal(await page.evaluate(() => !!document.querySelector('[data-testid=recall-forgot-pending]')), true);
  await shot(page, '06-quiz-forgot-before-submit-1920.png');

  await desktop(page, 1280);
  const mid = await quizLayout(page);
  note('1280 题卡版式', mid);
  assert.equal(mid.sideBySide, true, '1280 宽时仍左右并排');
  assert.equal(await noOverflow(page, '[data-testid=recall]'), true, '1280 宽不横向溢出');
  await shot(page, '07-quiz-1280.png');
  await narrow(page);
  const small = await quizLayout(page);
  assert.equal(small.sideBySide, false, '390 宽时上下排');
  assert.equal(await noOverflow(page, '[data-testid=recall]'), true, '390 宽不横向溢出（作答中）');
  await shot(page, '08-quiz-390.png');
  await page.evaluate(() => document.querySelector('[data-testid=recall-question]:nth-child(2)').scrollIntoView({ block: 'start' }));
  await shot(page, '09-quiz-390-forgot.png');
  await desktop(page, 1920);

  // 最后一题回车 = 提交这一屏
  await page.evaluate(() => document.querySelector('#recall-input-2').focus());
  await press(page, 'Enter');
  await page.waitUntil('逐题判分出来', `document.querySelectorAll('[data-testid=recall-result]').length === 3`);
  const kinds = await page.evaluate(() => [...document.querySelectorAll('[data-testid=recall-result]')].map(e => e.dataset.kind + '/' + e.dataset.correct));
  assert.deepEqual(kinds, ['correct/true', 'forgot/false', 'wrong/false'], '「忘记了」判为答错');
  const forgotCard = await page.evaluate(() => {
    const card = document.querySelectorAll('[data-testid=recall-question]')[1];
    return {
      verdict: card.querySelector('[data-testid=recall-verdict]').innerText,
      answer: card.querySelector('[data-testid=recall-correct-answer]').innerText,
      filled: card.querySelector('[data-testid=recall-filled]')?.innerText ?? '',
      forgotButtons: document.querySelectorAll('[data-testid=recall-forgot]').length,
    };
  });
  assert.deepEqual(forgotCard, { verdict: '忘记了（按答错计）', answer: 'mitigate', filled: 'mitigate', forgotButtons: 0 }, '提交后显示答案，「忘记了」锁定不能再改');
  state = await readState(session);
  assert.equal(state.logs.length, 0, '提交判分不写库');
  await page.evaluate(() => document.querySelectorAll('[data-testid=recall-question]')[1].scrollIntoView({ block: 'center' }));
  await shot(page, '10-after-forgot-graded-1920.png');
  await narrow(page);
  await page.evaluate(() => document.querySelectorAll('[data-testid=recall-question]')[1].scrollIntoView({ block: 'start' }));
  assert.equal(await noOverflow(page, '[data-testid=recall]'), true, '390 宽不横向溢出（判分后）');
  await shot(page, '11-after-forgot-graded-390.png');
  await desktop(page, 1920);

  await page.waitUntil('「保存并查看结果」可点', `(() => { const b = document.querySelector('[data-testid=recall-next]'); return !!b && !b.disabled; })()`);
  await page.click('[data-testid=recall-next]');
  await page.waitFor('[data-testid=recall-summary]');
  const rows = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid=recall-result-row]')].map(row => [row.dataset.word.split('@')[0], {
    written: row.querySelector('[data-testid=row-written]').innerText,
    verdict: row.querySelector('[data-testid=row-verdict]').innerText,
    form: row.querySelector('[data-testid=row-form]').innerText,
    change: row.querySelector('[data-testid=row-change]').innerText.split('\n')[0],
    recheck: !!row.querySelector('[data-testid=recall-recheck]'),
  }])));
  note('结果表', rows);
  assert.equal(rows.exacerbate.verdict, '答对');
  assert.equal(rows.mitigate.written, '（忘记了）');
  assert.equal(rows.mitigate.verdict, '忘记了（按答错计）');
  assert.equal(rows.mitigate.form, 'mitigate');
  assert.equal(rows.comprise.verdict, '答错');
  const l1 = new RegExp(`^L3 → L1，到期 ${plusDays(2).slice(5)}$`);
  assert.match(rows.mitigate.change, l1);
  assert.equal(rows.mitigate.change, rows.comprise.change, '「忘记了」和答错的状态变化一样');
  assert.deepEqual([rows.mitigate.recheck, rows.comprise.recheck, rows.exacerbate.recheck], [true, true, false], '「忘记了」和答错都能同日复检');
  assert.equal(await page.text('[data-testid=recall-correct-count]'), '1');
  assert.equal(await page.text('[data-testid=recall-wrong-count]'), '2');
  assert.match(await page.text('[data-testid=recall-forgot-count]'), /含忘记了 1/);
  await shot(page, '12-summary-1920.png');

  state = await readState(session);
  const afterReview = state.words;
  note('复习后状态', afterReview);
  assert.equal(afterReview.exacerbate, `L4/${plusDays(16)}`);
  assert.equal(afterReview.mitigate, `L1/${plusDays(2)}`);
  assert.equal(afterReview.mitigate, afterReview.comprise, '「忘记了」写回结果和答错一致');
  assert.equal(state.logs.length, 3);
  const pick = row => ({ kind: row.kind, correct: row.correct, before: `${row.before_status}/${row.before_due}`, after: `${row.after_status}/${row.after_due}`, date: row.review_date });
  const logOf = id => pick(state.logs.find(row => row.word_id === id));
  assert.deepEqual(logOf('mitigate@10.20'), { kind: 'recall', correct: 0, before: `L3/${today}`, after: `L1/${plusDays(2)}`, date: today }, '「忘记了」的日志 kind = recall、correct = 0');
  assert.deepEqual(logOf('mitigate@10.20'), logOf('comprise@10.20'), '「忘记了」和答错的 review_log 一致');
  assert.equal(logOf('exacerbate@10.20').correct, 1);
  assert.deepEqual(state.events, [], '「忘记了」不另写 review_event');
  evidence.review = { rows, afterReview, logs: state.logs.map(pick) };

  // 复检：「忘记了」那题换新语境，复检里再点「忘记了」
  await page.click('[data-testid=recall-result-row][data-word="mitigate@10.20"] [data-testid=recall-recheck]');
  await page.waitFor('[data-testid=recheck-card][data-phase=answer]');
  assert.deepEqual(modelCalls, [['mitigate@10.20']], '复检只为这个词请求一次模型');
  assert.equal(/Planting trees along the river can m_______ the damage/.test(await page.text('[data-testid=recheck-card]')), true);
  assert.equal(/\bmitigate\b/.test(await page.evaluate(() => document.querySelector('[data-testid=recheck-card] form').innerText)), false, '复检作答前题面不泄题');
  await page.click('[data-testid=recheck-forgot]');
  await page.waitFor('[data-testid=recheck-logged]');
  assert.match(await page.text('[data-testid=recheck-logged]'), /答错.*状态没有变化/);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=recheck-card] [data-testid=recall-correct-answer]')?.innerText), 'mitigate', '复检点了忘记了也显示答案');
  state = await readState(session);
  assert.deepEqual(state.words, afterReview, '复检不改状态');
  assert.equal(state.logs.length, 3, '复检不进 review_log');
  assert.equal(state.events.length, 1);
  assert.deepEqual([state.events[0].kind, state.events[0].correct], ['recheck', 0]);
  assert.match(state.events[0].detail, /\| 忘记了$/);
  await page.evaluate(() => document.querySelector('[data-testid=recheck-card]').scrollIntoView({ block: 'start' }));
  await shot(page, '13-recheck-forgot-1920.png');
  await narrow(page);
  await page.evaluate(() => document.querySelector('[data-testid=recall-result-table]').scrollIntoView({ block: 'start' }));
  assert.equal(await noOverflow(page, '[data-testid=recall]'), true, '390 宽不横向溢出（结果页）');
  await shot(page, '14-summary-390.png');
  await desktop(page, 1920);

  // Esc 退出（现有行为不变）
  await press(page, 'Escape');
  await page.waitUntil('Esc 退出复习', '!document.querySelector("[data-testid=recall]")');

  // ================= 3. 新词首考：忘记了 → L1 =================
  await page.waitUntil('首考区读到 2 个', `document.querySelector('[data-testid=seed-count]')?.innerText.includes('待首考 2 个')`);
  await page.click('[data-testid=first-test-start]');
  await page.waitFor('[data-testid=recall-screen]');
  assert.match(await page.text('[data-testid=recall-progress]'), /第 1 \/ 1 屏 · 本屏 2 题 · 共 2 题/);
  assert.deepEqual(await leakedWords(page, seedWords), [], '首考作答前不泄题');
  const firstWords = await page.evaluate(() => [...document.querySelectorAll('[data-testid=recall-question] [data-testid=recall-context]')].map(e => e.innerText));
  assert.match(firstWords[0], /Few small farms can s______ such high costs/);
  await page.click('[data-testid=recall-question]:nth-child(1) [data-testid=recall-forgot]');
  await sleep(150);
  assert.equal((await active(page)).id, 'recall-input-1');
  await page.type('#recall-input-1', 'allocate');
  await shot(page, '15-first-test-forgot-1920.png');
  await page.click('[data-testid=recall-submit]');
  await page.waitUntil('首考判分出来', `document.querySelectorAll('[data-testid=recall-result]').length === 2`);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-testid=recall-result]')].map(e => e.dataset.kind + '/' + e.dataset.correct)), ['forgot/false', 'correct/true']);
  await page.waitUntil('「保存并查看结果」可点', `(() => { const b = document.querySelector('[data-testid=recall-next]'); return !!b && !b.disabled; })()`);
  await page.click('[data-testid=recall-next]');
  await page.waitFor('[data-testid=recall-summary]');
  assert.match(await page.text('[data-testid=recall-summary]'), /本轮首考完成/);
  state = await readState(session);
  note('首考后状态', { sustain: state.words.sustain, allocate: state.words.allocate });
  assert.equal(state.words.sustain, `L1/${plusDays(2)}`, '首考点「忘记了」进 L1');
  assert.equal(state.words.allocate, '✅已掌握/', '对照：首考答对已掌握');
  const sustainLog = state.logs.find(row => row.word_id === 'sustain@8.25');
  assert.deepEqual([sustainLog.kind, sustainLog.correct, sustainLog.before_status, sustainLog.after_status], ['recall', 0, '🌱待考察', 'L1']);
  assert.equal(state.events.length, 1, '首考「忘记了」不另写 review_event');
  await shot(page, '16-first-test-summary-1920.png');
  evidence.firstTest = { sustain: state.words.sustain, allocate: state.words.allocate, sustainLog };
  await page.click('[data-testid=recall-finish]');

  const unexpectedErrors = page.errors.filter(error => error !== 'plugin http not found');
  assert.deepEqual(unexpectedErrors, [], '除隔离模式刻意不注册 http 插件外，不应有页面错误');
  Object.assign(evidence, { screenshots: shots, modelCalls, layout: { wide, mid, small }, unexpectedErrors, log });
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
