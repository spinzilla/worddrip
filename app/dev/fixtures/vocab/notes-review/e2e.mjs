// 041 真实窗口验证：复习、首考、闪卡里的「记一笔 / 笔记（n）」。隔离数据目录 + 本机假模型，不调用真实模型。
// 夹具：8 个到期词 + 2 个新词，每个词预先放一条「含目标词」的旧笔记。
// 1. 复习作答中点「记一笔」：页面看不到旧笔记正文、笔记数量和藏着的目标词；保存一条（来源「复习」），不影响作答状态；
//    中途退出（不保存这一屏）后，新笔记在词库详情里能看到。
// 2. 闪卡：正面没有笔记；反面能看到这个词的笔记、能加一条（来源「闪卡」），点笔记区不翻面。
// 3. 复习再开一轮、提交判分后：按钮变「笔记（n）」，展开看到旧笔记和新笔记（新的在上），还能再加。
// 4. 首考：作答中同样看不到旧笔记；判分后能看到。
// 5. 假模型收到的出题/判分请求里没有任何笔记正文。1280 / 390 截图。
// 另外：作答中笔记框里按 Esc 只收起面板、不退出整轮；一条笔记都没有的词，闪卡反面只占一个「+ 记笔记」小按钮。
// 用法（在 app 目录）：node dev/fixtures/vocab/notes-review/e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { start, stop, DEV_PORT } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { openDb, queryRows } from '../../../e2e/db.mjs';
import { portInUse } from '../../../e2e/proc.mjs';

if (await portInUse(DEV_PORT)) {
  console.error(`${DEV_PORT} 端口已被占用（可能有别的开发窗口在跑），先关掉再测。`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.resolve('src-tauri/target/e2e', `041-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const today = localDate();
const KEY = 'dummy-e2e-key-041';

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
const reviewWords = [
  ...DUE.map(([word], index) => ({ id: `${word}@10.20`, word, status: 'L3', level: 3, note: `${word} 的复习备注`, line: index + 2, raw: `| ${word} | 10.20 |`, issue: '10.20', addedAt: today, due: today })),
  ...SEED.map(([word], index) => ({ id: `${word}@11.01`, word, status: '🌱待考察', level: null, note: `${word} 的新词备注`, line: index + 20, raw: `| ${word} | 11.01 |`, issue: '11.01', addedAt: today, due: '' })),
];
const importRequest = {
  upgrade: { fileName: 'empty-upgrade.md', content: '# 学术升级库\n' },
  review: { fileName: 'notes-review-041.md', content: '# 词汇总词库\n' },
  entries: [{ id: 'dummy@1.1', line: 2, raw: '| dummy |', plain: 'dummy', upgrade: 'dummy', source: '测试', note: '' }],
  examples: [], selfChecks: [], reviewWords, warnings: { upgrade: [], review: [] },
};
const issueFiles = [
  { fileName: '20261020.md', content: `## 词单分析\n${DUE.map(([w, e, s], i) => `${i + 1}. **${w}** v. — ${e}（释义 ${i + 1}）；*${s}*`).join('\n')}\n` },
  { fileName: '20261101.md', content: `## 词单分析\n${SEED.map(([w, e, s], i) => `${i + 1}. **${w}** v. — ${e}（释义 ${i + 1}）；*${s}*`).join('\n')}\n` },
];

// 笔记正文都带独特标记，最后在模型请求里逐个找。旧笔记故意写进目标词。
const OLD = word => `旧笔记OLDNOTE：${word} 和近义词容易混，${word} 后面常接 the effects。`;
const NEW_REVIEW = '复习时记REVIEWNOTE：这个词作答时想到了，和 alleviate 对比。';
const NEW_GRADED = '判分后记GRADEDNOTE：再补一条搭配。';
const NEW_FIRST = '首考时记FIRSTNOTE：注意词性。';
const NEW_FLASH = '闪卡记FLASHNOTE：翻面时想到的例句。';
const MARKERS = ['OLDNOTE', 'REVIEWNOTE', 'GRADEDNOTE', 'FIRSTNOTE', 'FLASHNOTE', '旧笔记', '复习时记', '判分后记', '首考时记', '闪卡记'];

// ---- 本机假 OpenAI 兼容服务（和 038 的 usage 测试同一套回复） ----
const calls = [];
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
  const prompt = payload.messages[0].content;
  res.setHeader('Content-Type', 'application/json');
  const reply = content => res.end(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }));
  if (prompt.includes('Tasks:')) {
    const tasks = JSON.parse(prompt.slice(prompt.indexOf('Tasks:') + 'Tasks:'.length));
    calls.push({ kind: 'usage', raw });
    return reply({ tasks: tasks.map(usageDraft) });
  }
  if (prompt.includes('Items:')) {
    const items = JSON.parse(prompt.slice(prompt.indexOf('Items:') + 'Items:'.length));
    calls.push({ kind: 'fill', raw });
    return reply({ questions: items.map(item => ({ id: item.id, meaning: '', sentence: `Most experts agreed that the plan would [[${item.target}]] the situation in rural towns.` })) });
  }
  if (prompt.includes('Task type:')) {
    const target = JSON.parse(prompt.match(/^Target expression: (.*)$/m)[1]);
    const answer = JSON.parse(prompt.match(/^Student's answer: (.*)$/m)[1]);
    calls.push({ kind: 'grade', raw });
    const used = new RegExp(`\\b${target}\\w*`, 'i').test(answer);
    return reply(used
      ? { usedTarget: true, grammarOk: true, taskOk: true, verdict: 'correct', reason: `${target} 用法正确。`, targetForm: target, grammarFix: answer, academicUpgrade: `UPGRADE: ${answer}` }
      : { usedTarget: false, grammarOk: true, taskOk: true, verdict: 'incomplete', reason: `没有用 ${target}。`, targetForm: target, grammarFix: `FIX: ${answer}`, academicUpgrade: `UPGRADE: with ${target}.` });
  }
  if (prompt.includes('Allowed labels')) {
    // 048：闪卡翻到背面会请求场景标注；给合法回复，不计入本脚本关心的请求。
    const items = JSON.parse(prompt.slice(prompt.indexOf('Sentences:') + 'Sentences:'.length, prompt.indexOf('\n\nReturn only')));
    return reply({ scenes: items.map(item => ({ id: item.id, scene: 'statement' })) });
  }
  calls.push({ kind: 'other', raw });
  return reply({ word: '', partOfSpeech: 'n.', definition: '测试释义' });
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const shot = (page, name) => page.screenshot(path.join(out, name), { full: false });
const wide = page => page.setViewport(1280, 900, { mobile: false, dpr: 1 });
const narrow = page => page.setViewport(390, 844, { mobile: true, dpr: 1 });
const noOverflow = (page, root = '[data-testid=recall]') => page.evaluate(sel => document.documentElement.scrollWidth <= document.documentElement.clientWidth
  && [...document.querySelectorAll(`${sel} *`)].every(e => e.getBoundingClientRect().right <= document.documentElement.clientWidth + 1), root);
const configureModel = page => page.evaluate(baseUrl => {
  localStorage.setItem('linguaclip_ai_config', JSON.stringify({ baseUrl, apiKey: 'dummy-e2e-key-041', model: 'fake-041', temperature: 0.7 }));
  window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);
}, `http://127.0.0.1:${modelPort}/v1`);
const cards = page => page.evaluate(() => [...document.querySelectorAll('[data-testid=recall-question]')].map(card => ({
  id: card.dataset.word, word: card.dataset.word.split('@')[0], format: card.dataset.format,
  index: Number(card.querySelector('[data-testid=recall-input]').id.replace('recall-input-', '')),
})));
const card = id => `[data-testid=recall-question][data-word="${id}"]`;
const escape = async page => {
  // 焦点在笔记面板里时 Esc 只收起面板；这里要退出整轮，先让焦点离开。
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await page.waitUntil('弹层关闭', `!document.querySelector('[data-testid=recall]')`);
};
const clickUntil = async (page, selector, appear) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.evaluate(sel => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), selector);
    await page.click(selector);
    for (let i = 0; i < 15; i += 1) {
      if (await page.evaluate(sel => !!document.querySelector(sel), appear)) return;
      await sleep(200);
    }
  }
  throw new Error(`点了 ${selector} 也没出现 ${appear}`);
};
const mentions = (text, word) => new RegExp(`\\b${word.slice(0, Math.max(5, word.length - 2))}`, 'i').test(text);
const notesInDb = async session => {
  const db = await openDb(session);
  const rows = queryRows(db, 'vocab_note');
  const logs = queryRows(db, 'review_log');
  db.close();
  return { rows, logs };
};

/**
 * 作答中检查：整个复习弹层（含隐藏元素的 HTML）里没有旧笔记正文、没有「笔记（n）」；
 * 每道「答案藏着」的题（造句题题面本来就给目标词，除外）的目标词不出现在可见文字里；
 * 打开的笔记面板 HTML 里也没有这道题的目标词。
 */
const assertBlind = async (page, screenCards, openId) => {
  const view = await page.evaluate(id => {
    const root = document.querySelector('[data-testid=recall]');
    const panel = document.querySelector(`[data-testid=recall-question][data-word="${id}"] [data-testid=recall-notes]`);
    return {
      text: root.innerText,
      html: root.innerHTML,
      panelHtml: panel?.outerHTML ?? '',
      panelText: panel?.innerText ?? '',
      panelHidden: panel?.hidden ?? true,
      noteItems: root.querySelectorAll('[data-testid=note-item]').length,
      toggles: [...root.querySelectorAll('[data-testid=recall-note-toggle]')].map(b => b.innerText.trim()),
    };
  }, openId);
  assert.equal(view.panelHidden, false, '笔记面板已展开');
  assert.equal(view.noteItems, 0, '作答中不渲染任何旧笔记');
  for (const marker of MARKERS) assert.equal(view.html.includes(marker), false, `作答中弹层 HTML 里不该有笔记正文（${marker}）`);
  assert.doesNotMatch(view.text, /笔记（\d+）|\d+\s*条笔记/, '作答中不显示笔记数量');
  for (const label of view.toggles) assert.equal(label, '记一笔', '作答中按钮只写「记一笔」');
  const hidden = screenCards.filter(c => c.format !== 'compose');
  for (const c of hidden) assert.equal(mentions(view.text, c.word), false, `作答中页面不出现藏着的目标词 ${c.word}`);
  const open = screenCards.find(c => c.id === openId);
  assert.equal(mentions(view.panelHtml, open.word), false, '笔记面板（含属性）不出现目标词');
  assert.match(view.panelText, new RegExp(`第 ${open.index + 1} 题`), '面板标题用「第 N 题」');
  return view;
};

const evidence = { today, runDir, checks: {} };
let session;
let page;
let passed = false;
try {
  session = await start({ runDir, port: 9481 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await wide(page);
  await page.clickText('词库', { timeout: 60000 });
  assert.equal((await invoke(page, 'vocab_import', { request: importRequest })).reviewWords.added, 10);
  assert.equal((await invoke(page, 'vocab_definition_import', { request: { issues: issueFiles, eagp: null } })).examplesAdded, 10);
  for (const [word] of ALL) await invoke(page, 'vocab_note_add', { request: { word, body: OLD(word), source: '词库' } });
  assert.equal((await invoke(page, 'vocab_notes')).length, 10);
  await page.reload();
  await page.clickText('词库');
  await page.waitUntil('到期区读到 8 个', `document.querySelector('[data-testid=due-count]')?.innerText.includes(' 8 个词')`);
  await configureModel(page);

  // ---------------- 1. 复习作答中：记一笔（只能新写） ----------------
  await clickUntil(page, '[data-testid=due-recall-start]', '[data-testid=recall-screen]');
  await page.waitFor('[data-testid=recall-screen]');
  let screen = await cards(page);
  note('复习第 1 屏', screen.map(c => `${c.word}/${c.format}`));
  const target = screen.find(c => c.format === 'fill') ?? screen[0];
  const sel = card(target.id);
  // 先在这题写一半答案，看记笔记会不会动它。
  await page.type(`#recall-input-${target.index}`, 'half');
  // Tab 顺序：答案框 → 忘记了 → 这题出错了 → 记一笔 → 笔记输入框 → 保存（DOM 顺序即 Tab 顺序，没有 tabindex）。
  const order = await page.evaluate(s => [...document.querySelector(s).querySelectorAll('input, textarea, button, [tabindex]')]
    .filter(e => !e.closest('[hidden]') || e.matches('[data-testid=note-input], [data-testid=note-add]'))
    .map(e => e.dataset.testid ?? e.tagName), sel);
  note('Tab 顺序', order);
  const pos = id => order.indexOf(id);
  assert.ok(pos('recall-input') < pos('recall-forgot') && pos('recall-forgot') < pos('recall-flag') && pos('recall-flag') < pos('recall-note-toggle')
    && pos('recall-note-toggle') < pos('note-input') && pos('note-input') < pos('note-add'), `Tab 顺序不对：${order.join(' → ')}`);
  // 按钮不挡答案框和「忘记了」
  const rects = await page.evaluate(s => Object.fromEntries(['recall-input', 'recall-forgot', 'recall-note-toggle'].map(id => {
    const r = document.querySelector(`${s} [data-testid=${id}]`).getBoundingClientRect();
    return [id, { l: r.left, t: r.top, r: r.right, b: r.bottom }];
  })), sel);
  const overlap = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  assert.equal(overlap(rects['recall-note-toggle'], rects['recall-input']), false, '记一笔按钮不挡答案框');
  assert.equal(overlap(rects['recall-note-toggle'], rects['recall-forgot']), false, '记一笔按钮不挡「忘记了」');

  await page.click(`${sel} [data-testid=recall-note-toggle]`);
  await page.waitUntil('笔记面板展开', `!document.querySelector('${sel} [data-testid=recall-notes]').hidden`);
  // 组件用 setTimeout(0) 把焦点移进输入框；等它真的到位再断言，不要读到移动前的瞬间（2026-11-10 两次误报）。
  await page.waitUntil('展开后焦点进笔记输入框', `document.activeElement?.dataset.testid === 'note-input'`);
  const blind1 = await assertBlind(page, screen, target.id);
  evidence.checks.reviewBlind = { panelText: blind1.panelText, toggles: blind1.toggles };
  note('复习作答中', `面板：${blind1.panelText.split('\n')[0]}；按钮：${blind1.toggles.join('/')}`);
  await page.evaluate(s => document.querySelector(s)?.scrollIntoView({ block: 'start' }), sel);
  await shot(page, '01-review-writing-note-1280.png');
  await page.type(`${sel} [data-testid=note-input]`, NEW_REVIEW);
  await page.click(`${sel} [data-testid=note-add]`);
  await page.waitFor(`${sel} [data-testid=note-saved-tip]`);
  await assertBlind(page, screen, target.id);
  const after = await page.evaluate(s => ({
    written: document.querySelector(`${s} [data-testid=recall-input]`).value,
    forgot: document.querySelector(s).dataset.forgot,
    flagged: document.querySelector(s).dataset.flagged,
    tone: document.querySelector(s).dataset.tone,
    phase: document.querySelector('[data-testid=recall-submit]') ? 'write' : 'other',
  }), sel);
  assert.deepEqual(after, { written: 'half', forgot: 'false', flagged: 'false', tone: 'writing', phase: 'write' }, '保存笔记不影响这题的作答状态');
  let db = await notesInDb(session);
  const reviewRow = db.rows.find(row => row.body === NEW_REVIEW);
  assert.ok(reviewRow, '笔记已入库');
  assert.equal(reviewRow.source, '复习');
  assert.equal(reviewRow.word_key, target.word);
  assert.equal(db.logs.length, 0, '记笔记不写复习记录');
  await shot(page, '02-review-writing-saved-1280.png');
  // 笔记框里写了草稿再按 Esc：只收起这个面板、焦点回到「记一笔」，复习不退出；再展开草稿还在。
  const DRAFT = '还没保存的草稿draft';
  await page.type(`${sel} [data-testid=note-input]`, DRAFT);
  await page.evaluate(s => document.querySelector(`${s} [data-testid=note-input]`).focus(), sel);
  await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await page.waitUntil('Esc 收起笔记面板', `document.querySelector('${sel} [data-testid=recall-notes]').hidden`);
  const escState = await page.evaluate(s => ({
    open: !!document.querySelector('[data-testid=recall]'),
    focus: document.activeElement?.dataset.testid ?? '',
    written: document.querySelector(`${s} [data-testid=recall-input]`).value,
  }), sel);
  assert.deepEqual(escState, { open: true, focus: 'recall-note-toggle', written: 'half' }, '笔记框里按 Esc 只收起面板，不退出整轮');
  await page.click(`${sel} [data-testid=recall-note-toggle]`);
  await page.waitUntil('再次展开', `!document.querySelector('${sel} [data-testid=recall-notes]').hidden`);
  assert.equal(await page.evaluate(s => document.querySelector(`${s} [data-testid=note-input]`).value, sel), DRAFT, '收起再展开，草稿还在');
  db = await notesInDb(session);
  assert.equal(db.rows.some(row => row.body === DRAFT), false, '草稿没点保存，不入库');
  assert.equal(db.logs.length, 0, 'Esc 收起面板不写复习记录');
  evidence.checks.escInNotes = escState;
  note('笔记框里按 Esc', `收起面板，焦点回到 ${escState.focus}，复习仍开着，草稿还在`);
  await narrow(page);
  await page.evaluate(s => document.querySelector(s)?.scrollIntoView({ block: 'start' }), `${sel} [data-testid=recall-answer], ${sel} .vocab-q-answer`);
  assert.equal(await noOverflow(page), true, '390 作答中笔记面板不横向溢出');
  await shot(page, '03-review-writing-note-390.png');
  await wide(page);
  // 中途退出：这一屏不保存，但笔记已存
  await escape(page);
  db = await notesInDb(session);
  assert.equal(db.logs.length, 0, '中途退出的一屏没写复习记录');
  assert.ok(db.rows.some(row => row.body === NEW_REVIEW), '中途退出后笔记还在');

  // 词库详情里能看到（来源「复习」）
  await page.clickText('查词', { selector: 'button[role=tab]', exact: true });
  await page.waitFor('[data-testid=vocab-list]');
  await page.evaluate(wanted => {
    const row = [...document.querySelectorAll('[data-testid=vocab-list] > button')].find(element => element.innerText.trim().startsWith(wanted));
    if (!row) throw new Error(`列表里没有 ${wanted}`);
    row.click();
  }, target.word);
  await page.waitFor('[data-testid=notes-section]');
  const detail = await page.evaluate(() => [...document.querySelectorAll('[data-testid=notes-section] [data-testid=note-item]')].map(item => ({
    body: item.querySelector('[data-testid=note-body]').innerText, source: item.querySelector('[data-testid=note-source]').innerText,
  })));
  assert.deepEqual(detail.map(item => item.source), ['复习', '词库'], '新的在上，来源「复习」');
  assert.equal(detail[0].body, NEW_REVIEW);
  note('词库详情', detail.map(item => `${item.source}：${item.body.slice(0, 12)}`));
  await shot(page, '04-detail-review-note-1280.png');

  // ---------------- 2. 闪卡：反面显示笔记、能加一条 ----------------
  await clickUntil(page, '[data-testid=due-start]', '[data-testid=flash-card]');
  assert.equal(await page.evaluate(() => !!document.querySelector('[data-testid=flash-notes]')), false, '正面不显示笔记');
  await page.click('[data-testid=flash-card]');
  await page.waitFor('[data-testid=flash-back]');
  const flashWord = await page.evaluate(() => document.querySelector('[data-testid=flash-back]').innerText.split('\n')[0].trim());
  await page.waitUntil('笔记读到', `document.querySelectorAll('[data-testid=flash-notes] [data-testid=note-item]').length > 0`);
  const expectFlash = (await invoke(page, 'vocab_notes')).filter(n => n.wordKey === flashWord).length;
  const flashBodies = async () => page.evaluate(() => [...document.querySelectorAll('[data-testid=flash-notes] [data-testid=note-body]')].map(e => e.innerText));
  assert.equal((await flashBodies()).length, expectFlash, '反面显示这个词的全部笔记');
  assert.ok((await flashBodies()).includes(OLD(flashWord)));
  await shot(page, '05-flash-back-notes-1280.png');
  await page.click('[data-testid=flash-notes] [data-testid=note-open]');
  await page.type('[data-testid=flash-notes] [data-testid=note-input]', NEW_FLASH);
  await page.click('[data-testid=flash-notes] [data-testid=note-add]');
  await page.waitUntil('闪卡笔记出现', `document.querySelectorAll('[data-testid=flash-notes] [data-testid=note-item]').length === ${expectFlash + 1}`);
  assert.equal((await flashBodies())[0], NEW_FLASH, '新的在上');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=flash-card]').dataset.side), 'back', '在笔记区操作不翻面');
  // 焦点在笔记输入框里按空格不翻面（闪卡快捷键让给输入框）
  await page.evaluate(() => document.querySelector('[data-testid=flash-notes] [data-testid=note-input]').focus());
  await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=flash-card]').dataset.side), 'back', '笔记框里按空格不翻面');
  const flashLayout = await page.evaluate(() => {
    const cardEl = document.querySelector('[data-testid=flash-card]').getBoundingClientRect();
    const back = document.querySelector('[data-testid=flash-back]').getBoundingClientRect();
    return { top: Math.round(back.top - cardEl.top), bottom: Math.round(cardEl.bottom - back.bottom), cardHeight: Math.round(cardEl.height) };
  });
  note('闪卡反面上下留白', flashLayout);
  assert.ok(Math.abs(flashLayout.top - flashLayout.bottom) <= 4, '反面内容垂直居中，下面不再大片空白');
  await shot(page, '06-flash-back-added-1280.png');
  await narrow(page);
  assert.equal(await noOverflow(page, '[data-testid=flash]'), true, '390 闪卡反面不横向溢出');
  await page.evaluate(() => document.querySelector('[data-testid=flash-notes]').scrollIntoView({ block: 'center' }));
  await shot(page, '07-flash-back-notes-390.png');
  await wide(page);
  // 点背面空白处仍能翻回正面
  const blank = await page.evaluate(() => { const r = document.querySelector('[data-testid=flash-back-word], [data-testid=flash-back]').getBoundingClientRect(); return { x: r.left + 5, y: r.top + 5 }; });
  await page.mouseClick(blank.x, blank.y);
  await page.waitUntil('翻回正面', `document.querySelector('[data-testid=flash-card]')?.dataset.side === 'front'`);
  assert.equal(await page.evaluate(() => !!document.querySelector('[data-testid=flash-notes]')), false, '翻回正面后不显示笔记');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await page.waitUntil('退出闪卡', `!document.querySelector('[data-testid=flash]')`);
  db = await notesInDb(session);
  assert.equal(db.rows.find(row => row.body === NEW_FLASH)?.source, '闪卡');
  evidence.checks.flash = { word: flashWord, before: expectFlash, layout: flashLayout };

  // ---------------- 2b. 一条笔记都没有的词：闪卡反面只占一个「+ 记笔记」小按钮 ----------------
  // 临时删掉某个到期词的旧笔记（不是闪卡、复习刚用过的词），看完再原样加回去，不影响后面的检查。
  const emptyWord = DUE.map(([w]) => w).find(w => w !== flashWord && w !== target.word);
  const removed = (await invoke(page, 'vocab_notes')).filter(n => n.wordKey === emptyWord);
  for (const n of removed) await invoke(page, 'vocab_note_delete', { request: { id: n.id } });
  await clickUntil(page, '[data-testid=due-start]', '[data-testid=flash-card]');
  const frontWord = () => page.evaluate(() => document.querySelector('[data-testid=flash-word]')?.innerText.trim() ?? '');
  for (let i = 0; i < DUE.length && (await frontWord()) !== emptyWord; i += 1) {
    await page.click('[data-testid=flash] button[aria-label="下一张（→）"]');
    await sleep(200);
  }
  assert.equal(await frontWord(), emptyWord, `闪卡里翻到 ${emptyWord}`);
  await page.click('[data-testid=flash-card]');
  await page.waitFor('[data-testid=flash-back]');
  await sleep(400); // 等笔记读完（这个词读完也是 0 条）
  const emptyView = await page.evaluate(() => {
    const box = document.querySelector('[data-testid=flash-notes]');
    const cardEl = document.querySelector('[data-testid=flash-card]').getBoundingClientRect();
    const back = document.querySelector('[data-testid=flash-back]').getBoundingClientRect();
    const btnRect = box.querySelector('[data-testid=note-open]')?.getBoundingClientRect();
    return {
      count: box.dataset.count, items: box.querySelectorAll('[data-testid=note-item]').length,
      text: box.innerText.trim(), hasOpen: !!btnRect, boxHeight: Math.round(box.getBoundingClientRect().height),
      top: Math.round(back.top - cardEl.top), bottom: Math.round(cardEl.bottom - back.bottom),
    };
  });
  note('闪卡反面（无笔记）', emptyView);
  assert.equal(emptyView.count, '0');
  assert.equal(emptyView.items, 0, '没有笔记时不列笔记');
  assert.equal(emptyView.hasOpen, true, '只有「+ 记笔记」小按钮');
  assert.equal(emptyView.text, '记笔记', '不显示「我的笔记（0）」或空提示');
  assert.ok(emptyView.boxHeight <= 40, `没有笔记时不占大块位置（高 ${emptyView.boxHeight}px）`);
  assert.ok(Math.abs(emptyView.top - emptyView.bottom) <= 4, '无笔记时反面内容也垂直居中');
  await shot(page, '14-flash-back-empty-1280.png');
  await narrow(page);
  assert.equal(await noOverflow(page, '[data-testid=flash]'), true, '390 无笔记闪卡反面不横向溢出');
  await page.evaluate(() => document.querySelector('[data-testid=flash-notes]').scrollIntoView({ block: 'center' }));
  await shot(page, '15-flash-back-empty-390.png');
  await wide(page);
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await page.waitUntil('退出闪卡', `!document.querySelector('[data-testid=flash]')`);
  for (const n of removed) await invoke(page, 'vocab_note_add', { request: { word: emptyWord, body: n.body, source: n.source } });
  assert.equal((await invoke(page, 'vocab_notes')).filter(n => n.wordKey === emptyWord).length, removed.length, '旧笔记已加回');
  evidence.checks.flashEmpty = { word: emptyWord, ...emptyView };

  // ---------------- 3. 复习判分后：笔记（n）展开看全部、还能加 ----------------
  await clickUntil(page, '[data-testid=due-recall-start]', '[data-testid=recall-screen]');
  screen = await cards(page);
  note('复习第二次 第 1 屏', screen.map(c => `${c.word}/${c.format}`));
  await assertBlind(page, screen, await (async () => {
    const first = screen.find(c => c.format !== 'compose' && c.word !== target.word);
    await page.click(`${card(first.id)} [data-testid=recall-note-toggle]`);
    return first.id;
  })());
  for (const c of screen) {
    const text = c.format === 'fill' ? c.word
      : c.format === 'paraphrase' ? `Excessive energy consumption can ${c.word} air pollution in large industrial cities.`
        : `The team had to ${c.word} the plan carefully before the final presentation.`;
    await page.type(`#recall-input-${c.index}`, text);
  }
  await page.click('[data-testid=recall-submit]');
  await page.waitUntil('判分完成', `document.querySelectorAll('[data-testid=recall-result]').length === ${screen.length}`);
  const gradedId = screen.find(c => c.word === target.word)?.id ?? screen[0].id;
  const gradedWord = gradedId.split('@')[0];
  const expectGraded = (await invoke(page, 'vocab_notes')).filter(n => n.wordKey === gradedWord).length;
  const toggleText = await page.text(`${card(gradedId)} [data-testid=recall-note-toggle]`);
  assert.equal(toggleText.trim(), `笔记（${expectGraded}）`, '判分后按钮显示条数');
  await page.click(`${card(gradedId)} [data-testid=recall-note-toggle]`);
  await page.waitUntil('判分后笔记展开', `document.querySelectorAll('${card(gradedId)} [data-testid=note-item]').length === ${expectGraded}`);
  const gradedBodies = await page.evaluate(s => [...document.querySelectorAll(`${s} [data-testid=note-body]`)].map(e => e.innerText), card(gradedId));
  assert.equal(gradedBodies[gradedBodies.length - 1], OLD(gradedWord), '旧笔记在最下面');
  if (gradedWord === target.word) assert.ok(gradedBodies.includes(NEW_REVIEW), '作答中记的那条也在');
  await page.type(`${card(gradedId)} [data-testid=note-input]`, NEW_GRADED);
  await page.click(`${card(gradedId)} [data-testid=note-add]`);
  await page.waitUntil('判分后新加一条', `document.querySelectorAll('${card(gradedId)} [data-testid=note-item]').length === ${expectGraded + 1}`);
  assert.equal(await page.text(`${card(gradedId)} [data-testid=recall-note-toggle]`).then(t => t.trim()), `笔记（${expectGraded + 1}）`);
  assert.equal((await page.evaluate(s => document.querySelector(`${s} [data-testid=note-body]`).innerText, card(gradedId))), NEW_GRADED, '新的在上');
  await page.evaluate(s => document.querySelector(`${s} [data-testid=recall-note-toggle]`).scrollIntoView({ block: 'start' }), card(gradedId));
  await shot(page, '08-review-graded-notes-1280.png');
  await narrow(page);
  await page.evaluate(s => document.querySelector(`${s} [data-testid=recall-note-toggle]`).scrollIntoView({ block: 'start' }), card(gradedId));
  assert.equal(await noOverflow(page), true, '390 判分后笔记不横向溢出');
  await shot(page, '09-review-graded-notes-390.png');
  await wide(page);
  evidence.checks.graded = { word: gradedWord, bodies: gradedBodies };
  note('复习判分后', `${gradedWord}：${gradedBodies.length} 条，加 1 条后 ${expectGraded + 1}`);
  await escape(page);

  // ---------------- 4. 首考：作答中只能新写，出结果后能看 ----------------
  await page.waitUntil('新词区读到 2 个', `document.querySelector('[data-testid=seed-count]')?.innerText.includes('待首考 2 个')`);
  await page.click('[data-testid=first-test-start]');
  await page.waitFor('[data-testid=first-test-preview]');
  await page.click('[data-testid=first-preview-skip]');
  await page.waitFor('[data-testid=recall-screen]');
  const firstCards = await cards(page);
  note('首考', firstCards.map(c => `${c.word}/${c.format}`));
  const firstTarget = firstCards.find(c => c.format !== 'compose');
  await page.click(`${card(firstTarget.id)} [data-testid=recall-note-toggle]`);
  await page.waitUntil('首考笔记面板展开', `!document.querySelector('${card(firstTarget.id)} [data-testid=recall-notes]').hidden`);
  await assertBlind(page, firstCards, firstTarget.id);
  await page.type(`${card(firstTarget.id)} [data-testid=note-input]`, NEW_FIRST);
  await page.click(`${card(firstTarget.id)} [data-testid=note-add]`);
  await page.waitFor(`${card(firstTarget.id)} [data-testid=note-saved-tip]`);
  await assertBlind(page, firstCards, firstTarget.id);
  await page.evaluate(s => document.querySelector(s).scrollIntoView({ block: 'start' }), card(firstTarget.id));
  await shot(page, '10-first-writing-note-1280.png');
  await narrow(page);
  await page.evaluate(s => document.querySelector(`${s} [data-testid=recall-notes]`).scrollIntoView({ block: 'center' }), card(firstTarget.id));
  assert.equal(await noOverflow(page), true, '390 首考作答中不横向溢出');
  await shot(page, '11-first-writing-note-390.png');
  await wide(page);
  for (const c of firstCards) {
    const text = c.format === 'fill' ? c.word : `Excessive energy consumption can ${c.word} air pollution in large industrial cities.`;
    await page.type(`#recall-input-${c.index}`, text);
  }
  await page.click('[data-testid=recall-submit]');
  await page.waitUntil('首考判完', `document.querySelectorAll('[data-testid=recall-result]').length === ${firstCards.length}`);
  // 面板在作答时就开着：判分后直接变成全部笔记
  await page.waitUntil('首考判分后列出笔记', `document.querySelectorAll('${card(firstTarget.id)} [data-testid=note-item]').length === 2`);
  const firstBodies = await page.evaluate(s => [...document.querySelectorAll(`${s} [data-testid=note-body]`)].map(e => e.innerText), card(firstTarget.id));
  assert.deepEqual(firstBodies, [NEW_FIRST, OLD(firstTarget.word)], '首考出结果后看到新笔记和旧笔记（新的在上）');
  assert.equal((await page.text(`${card(firstTarget.id)} [data-testid=recall-note-toggle]`)).trim(), '笔记（2）');
  await page.evaluate(s => document.querySelector(`${s} [data-testid=recall-note-toggle]`).scrollIntoView({ block: 'start' }), card(firstTarget.id));
  await shot(page, '12-first-graded-notes-1280.png');
  await narrow(page);
  assert.equal(await noOverflow(page), true, '390 首考判分后不横向溢出');
  await shot(page, '13-first-graded-notes-390.png');
  await wide(page);
  await escape(page);

  // ---------------- 5. 数据库与模型请求 ----------------
  db = await notesInDb(session);
  const sources = Object.fromEntries(db.rows.map(row => [row.body, `${row.word_key}/${row.source}`]));
  note('笔记表', Object.values(sources));
  assert.equal(sources[NEW_REVIEW], `${target.word}/复习`);
  assert.equal(sources[NEW_GRADED], `${gradedWord}/复习`);
  assert.equal(sources[NEW_FIRST], `${firstTarget.word}/首考`);
  assert.equal(sources[NEW_FLASH], `${flashWord}/闪卡`);
  assert.equal(db.logs.length, 0, '每次都中途退出，没保存任何一屏');
  const kinds = calls.reduce((acc, call) => ({ ...acc, [call.kind]: (acc[call.kind] ?? 0) + 1 }), {});
  note('假模型请求', kinds);
  assert.ok((kinds.usage ?? 0) >= 2 && (kinds.grade ?? 0) >= 2, '出题和判分都请求过假模型');
  for (const call of calls) for (const marker of MARKERS) assert.equal(call.raw.includes(marker), false, `${call.kind} 请求里出现了笔记正文（${marker}）`);
  evidence.checks.modelCalls = kinds;

  const unexpectedErrors = page.errors.filter(error => !/^(Dictionary lookup failed: )?plugin http not found$/.test(error));
  assert.deepEqual(unexpectedErrors, [], '不应有页面错误');
  Object.assign(evidence, { screenshots: fs.readdirSync(out).filter(name => name.endsWith('.png')).sort(), noteRows: db.rows, log });
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
  note('证据', path.join(out, 'evidence.json'));
  passed = true;
} catch (error) {
  if (page) await page.screenshot(path.join(out, 'failure.png')).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  if (session) await stop(session.runDir);
  server.close();
  note('隔离窗口', passed ? '全部通过后已关闭' : '失败后已关闭');
}
