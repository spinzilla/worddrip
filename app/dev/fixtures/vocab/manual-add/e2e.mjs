// 042 真实窗口验证：词库页手动加词（只填词 / 查词典填写）、查重两条路、教练页查词卡「加入词库」→「已在词库」、
// 复习作答中查词卡没有「加入词库」、导出带上新词、重启后还在、界面没有彩色表情；1280 / 390 截图。
// 用法（在 app 目录）：node dev/fixtures/vocab/manual-add/e2e.mjs
// 只用隔离数据库和本机假模型（词典来源全关），不访问真实词典、真实模型或真实学习数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { start, stop, restart } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { openDb, queryRows } from '../../../e2e/db.mjs';
import { portInUse } from '../../../e2e/proc.mjs';

assert.equal(await portInUse(3000), false, '开跑前 3000 端口必须空闲');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.resolve('src-tauri/target/e2e', `042-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });
const now = new Date();
const today = now.toLocaleDateString('en-CA');
const issueOf = date => `${date.getMonth() + 1}.${date.getDate()}`;
const fileDateOf = date => `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
const ISSUE = issueOf(now);
const previousDate = new Date(now);
previousDate.setDate(previousDate.getDate() - 1);
const PREVIOUS_ISSUE = issueOf(previousDate);
const addedDate = new Date(previousDate);
addedDate.setDate(addedDate.getDate() - 1);
const ADDED_ISSUE = issueOf(addedDate);
const KEY = 'dummy-e2e-key-042';
const EMOJI = /[🌱✅🧊]/u;

// ---------- 夹具：8 个到期词（复习用）+ 期笔记释义 + 错误档案（教练页用） ----------
const words = ['exacerbate', 'resilient', 'candid', 'nodata', 'mitigate', 'allocate', 'comprise', 'sustain'];
const reviewWords = words.map((word, index) => ({
  id: `${word}@${PREVIOUS_ISSUE}`, word, status: 'L1', level: 1, note: `${word} 的复习备注`,
  line: index + 2, raw: `| ${word} | ${PREVIOUS_ISSUE} |`, issue: PREVIOUS_ISSUE, addedAt: today, due: today,
}));
const importRequest = {
  upgrade: { fileName: 'empty-upgrade.md', content: '# 学术升级库\n' },
  review: { fileName: 'recall-042.md', content: '# 词汇总词库\n' },
  entries: [{ id: 'dummy@1.1', line: 2, raw: '| dummy |', plain: 'dummy', upgrade: 'dummy', source: '测试', note: '' }],
  examples: [], selfChecks: [], reviewWords, warnings: { upgrade: [], review: [] },
};
const issueFile = {
  fileName: `${fileDateOf(previousDate)}.md`,
  content: `## 词单分析
1. **exacerbate** v. — to make a problem or situation worse（使恶化）；*Without more investment, the policy could exacerbate the housing shortage.*
2. **resilient** adj. — able to recover quickly from difficulty（有韧性的）
3. **mitigate** v. — to make something bad less severe（减轻）；*Governments introduced new measures to mitigate the effects of rising prices.*
4. **allocate** v. — to give something officially for a particular purpose（分配）；*The council allocated extra funds to rural schools last year.*
5. **comprise** v. — to consist of particular parts（由……组成）；*The course comprises six core modules and two electives.*
6. **sustain** v. — to keep something going over time（维持）；*Few small farms can sustain such high costs for long.*
`,
};
const DRAFTS = {
  [`resilient@${PREVIOUS_ISSUE}`]: { meaning: 'able to recover quickly', sentence: 'Small island economies must become more [[resilient]] to cope with extreme weather.' },
  [`candid@${PREVIOUS_ISSUE}`]: { meaning: 'honest and direct, even when the truth is unwelcome', sentence: 'In the interview, the minister gave a surprisingly [[candid]] account of the failures.' },
  [`nodata@${PREVIOUS_ISSUE}`]: { meaning: 'a missing value', sentence: 'The nodata field shows that a [[nodata]] value was recorded.' },
};

// ---------- 本机假模型：查词 + 出题 ----------
const modelCalls = [];
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
  res.setHeader('Content-Type', 'application/json');
  if (prompt.includes('Items:')) {
    const items = JSON.parse(prompt.slice(prompt.indexOf('Items:') + 'Items:'.length));
    modelCalls.push({ kind: 'questions' });
    const questions = items.map(item => ({ id: item.id, ...DRAFTS[item.id] }));
    return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questions }) } }] }));
  }
  const word = prompt.match(/Define the word "([^"]*)"/)?.[1] ?? '';
  modelCalls.push({ kind: 'lookup', word });
  const english = word === 'take into account' ? 'to consider something when judging a situation' : `测试释义：${word}`;
  const data = { word, partOfSpeech: word.includes(' ') ? 'phr.' : 'n.', definition: english };
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const modelPort = server.address().port;

const errorMd = fs.readFileSync('dev/fixtures/vocab/errors.md', 'utf8');
const parserOut = path.join(runDir, 'error-parser.mjs');
await build({ entryPoints: ['utils/vocab/errors.ts'], bundle: true, format: 'esm', outfile: parserOut, logLevel: 'silent' });
const { parseErrorArchive } = await import(pathToFileURL(parserOut).href);
const errorRequest = { ...parseErrorArchive(errorMd), source: { fileName: 'errors.md', content: errorMd } };

// ---------- 小工具 ----------
const invoke = async (page, command, args = {}) => {
  const outcome = await page.evaluate(async (cmd, payload) => {
    try { return { value: await window.__TAURI_INTERNALS__.invoke(cmd, payload) }; }
    catch (error) { return { error: typeof error === 'string' ? error : String(error) }; }
  }, command, args);
  if (outcome.error) throw new Error(`${command} 失败：${outcome.error}`);
  return outcome.value;
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const shot = async (page, name) => { await pause(350); return page.screenshot(path.join(out, name), { full: false }); };
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const value = (page, testId) => page.evaluate(id => document.querySelector(`[data-testid=${id}]`)?.value ?? null, testId);
const popupText = page => page.evaluate(() => document.querySelector('[data-definition-popup] [role=dialog]')?.innerText ?? '');
const pressEscape = page => page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
const seedCount = page => page.evaluate(() => document.querySelector('[data-testid=seed-count]')?.innerText ?? '');
const waitSeeds = (page, n) => page.waitUntil(`首考新词数变成 ${n}`, `document.querySelector('[data-testid=seed-count]')?.innerText === '待首考 ${n} 个'`);
const reviewRows = async session => {
  const db = await openDb(session);
  try { return queryRows(db, 'review_word'); } finally { db.close(); }
};
const definitionRows = async session => {
  const db = await openDb(session);
  try { return { defs: queryRows(db, 'review_definition'), examples: queryRows(db, 'review_definition_example') }; } finally { db.close(); }
};
/** 用 Range 找词的屏幕坐标，再走 CDP 鼠标事件（和 034 的点词脚本同一套）。 */
const clickWord = async (page, selector, word, until = '测试释义') => {
  const point = await page.evaluate((sel, wanted) => {
    const root = document.querySelector(sel);
    if (!root) throw new Error(`找不到点击容器：${sel}`);
    root.scrollIntoView({ block: 'center', inline: 'center' });
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const at = node.data.toLowerCase().indexOf(wanted.toLowerCase());
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + wanted.length);
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    throw new Error(`在 ${sel} 里找不到词：${wanted}`);
  }, selector, word);
  await page.mouseClick(point.x, point.y);
  await page.waitFor('[data-definition-popup] [role=dialog]');
  await page.waitUntil('假模型返回查词结果', `document.querySelector('[data-definition-popup]')?.innerText.includes(${JSON.stringify(until)})`);
};
const openForm = async page => {
  await page.click('[data-testid=vocab-add]');
  await page.waitFor('[data-testid=manual-add-form]');
};
const save = async page => {
  await page.click('[data-testid=manual-save]');
};
const waitSaved = async (page, word) => {
  await page.waitUntil(`保存 ${word}`, `!document.querySelector('[data-testid=manual-add]') && document.querySelector('[data-testid=manual-toast]')?.innerText.includes(${JSON.stringify(word)})`);
};

let session;
let page;
let passed = false;
const evidence = { runDir, issue: ISSUE, today, checks: {}, modelCalls };
try {
  session = await start({ runDir, port: 9472 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.clickText('词库', { timeout: 60000 });
  assert.equal((await invoke(page, 'vocab_import', { request: importRequest })).reviewWords.added, 8);
  assert.equal((await invoke(page, 'vocab_definition_import', { request: { issues: [issueFile], eagp: null } })).added, 6);
  assert.equal((await invoke(page, 'vocab_errors_import', { request: errorRequest })).items, 2);
  await page.evaluate(baseUrl => {
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({ baseUrl, apiKey: 'dummy-e2e-key-042', model: 'fake-lookup-model', temperature: 0.7 }));
    localStorage.setItem('linguaclip_dict_sources', JSON.stringify({ online: false, local: false }));
  }, `http://127.0.0.1:${modelPort}/v1`);
  await page.reload();
  await page.clickText('词库');
  await page.evaluate(() => { window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window); window.__ES_E2E_FILL_ONLY__ = true; });
  await waitSeeds(page, 0);

  // ---------------- 1. 只填词：candid 已在库，先用一个新词 lucid ----------------
  await openForm(page);
  assert.equal(await value(page, 'manual-source'), '手动添加');
  assert.equal(await value(page, 'manual-issue'), ISSUE, '期号默认今天，月.日不补零');
  await page.type('[data-testid=manual-word]', '  lucid ');
  await shot(page, '01-form-1280.png');
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  assert.equal(await noOverflow(page), true, '390 宽添加表单不横向溢出');
  const formBox = await page.evaluate(() => {
    const r = document.querySelector('[data-testid=manual-add] [role=dialog]').getBoundingClientRect();
    return { left: r.left, right: r.right, width: innerWidth };
  });
  assert.ok(formBox.left >= 0 && formBox.right <= formBox.width + 1, '390 宽表单完整留在窗口内');
  await shot(page, '02-form-390.png');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await save(page);
  await waitSaved(page, 'lucid');
  await waitSeeds(page, 1);
  let rows = await reviewRows(session);
  const lucid = rows.find(row => row.word === 'lucid');
  assert.ok(lucid, 'lucid 写进复习库');
  assert.deepEqual(
    [lucid.status, lucid.verification_status, lucid.source, lucid.issue, lucid.added_at, lucid.level, lucid.due, lucid.raw],
    ['🌱待考察', '未查证', '手动添加', ISSUE, today, null, '', `| lucid | ${ISSUE} | ${today} | 🌱待考察 | — |  |`],
  );
  // 列表立即刷新、能搜到，详情页能看到（含 040 笔记区）。
  await page.type('[data-testid=vocab-search]', 'lucid');
  await page.waitUntil('列表里搜到 lucid', `[...document.querySelectorAll('[data-testid=vocab-list] > button')].some(b => b.innerText.includes('lucid'))`);
  await page.click('[data-testid=vocab-list] > button');
  await page.waitFor('[data-testid=word-detail]');
  assert.match(await page.text('[data-testid=word-detail]'), /待考察/);
  assert.doesNotMatch(await page.text('[data-testid=word-detail]'), EMOJI);
  assert.ok(await page.evaluate(() => !!document.querySelector('[data-testid=word-detail] textarea')), '详情页笔记区可用');
  evidence.checks.wordOnly = { word: 'lucid', raw: lucid.raw };

  // ---------------- 2. 短语 + 查词典填写（词典全关 → 假 AI 查词） ----------------
  await openForm(page);
  await page.type('[data-testid=manual-word]', 'take into account');
  await page.type('[data-testid=manual-chinese]', '考虑到（我自己写的）');
  await page.click('[data-testid=manual-lookup]');
  await page.waitUntil('查词典填写完成', `!!document.querySelector('[data-testid=manual-lookup-note]')`);
  assert.equal(await value(page, 'manual-english'), 'to consider something when judging a situation');
  assert.equal(await value(page, 'manual-pos'), 'phr.');
  assert.equal(await value(page, 'manual-chinese'), '考虑到（我自己写的）', '查词典只填空格子，不覆盖手写内容');
  await page.type('[data-testid=manual-example]', 'We must take into account the cost of living.');
  await page.type('[data-testid=manual-note]', '短语，手动加');
  await shot(page, '03-form-lookup-filled-1280.png');
  await save(page);
  await waitSaved(page, 'take into account');
  await waitSeeds(page, 2);
  rows = await reviewRows(session);
  const phrase = rows.find(row => row.word === 'take into account');
  assert.equal(phrase.raw, `| take into account | ${ISSUE} | ${today} | 🌱待考察 | — | 短语，手动加 |`);
  const { defs, examples } = await definitionRows(session);
  const phraseDef = defs.find(row => row.word_id === phrase.id);
  assert.deepEqual([phraseDef.source_file, phraseDef.pos, phraseDef.english, phraseDef.chinese],
    ['手动添加', 'phr.', 'to consider something when judging a situation', '考虑到（我自己写的）']);
  assert.equal(examples.find(row => row.word_id === phrase.id).sentence, 'We must take into account the cost of living.');
  evidence.checks.phraseLookup = { raw: phrase.raw, definition: phraseDef };

  // ---------------- 3. 查重：打开已有词条 / 作为新义项添加 ----------------
  await openForm(page);
  await page.type('[data-testid=manual-word]', '  CANDID ');
  await save(page);
  await page.waitFor('[data-testid=manual-dup]');
  assert.match(await page.text('[data-testid=manual-dup]'), /词库里已经有「candid」了（1 条）/);
  assert.ok((await page.text('[data-testid=manual-dup]')).includes(`${PREVIOUS_ISSUE} 期 · L1`));
  assert.equal((await reviewRows(session)).filter(row => row.word.toLowerCase() === 'candid').length, 1, '查重提示时没有写入');
  await shot(page, '04-duplicate-1280.png');
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  assert.equal(await noOverflow(page), true);
  await shot(page, '05-duplicate-390.png');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.click('[data-testid=manual-dup-open]');
  await page.waitFor('[data-testid=vocab-entry-dialog] [data-testid=word-detail]');
  assert.match(await page.text('[data-testid=vocab-entry-dialog]'), /candid/);
  await shot(page, '06-open-existing-1280.png');
  await pressEscape(page);
  await page.waitUntil('关闭已有词条', `!document.querySelector('[data-testid=vocab-entry-dialog]')`);

  await openForm(page);
  await page.type('[data-testid=manual-word]', 'Candid');
  await page.type('[data-testid=manual-issue]', ADDED_ISSUE);
  await page.type('[data-testid=manual-chinese]', '（新义项）坦白的');
  await save(page);
  await page.waitFor('[data-testid=manual-dup]');
  await page.click('[data-testid=manual-dup-add]');
  await waitSaved(page, 'Candid');
  await waitSeeds(page, 3);
  const candids = (await reviewRows(session)).filter(row => row.word.toLowerCase() === 'candid');
  assert.equal(candids.length, 2, '选了新义项才再加一行');
  assert.equal(candids.find(row => row.issue === ADDED_ISSUE).status, '🌱待考察');
  evidence.checks.duplicate = { prompt: true, openExisting: true, addedAsNew: candids.map(row => `${row.word}@${row.issue}`) };

  // ---------------- 4. 教练页：查词卡「加入词库」→ 预填 → 保存 → 再点显示「已在词库」 ----------------
  await page.clickText('教练');
  await page.click('[data-testid=coach-tab-errors]'); // 096：教练页分了小标签，默认是写作练习
  await page.waitFor('[data-testid=coach-item]');
  await clickWord(page, '[data-testid=coach-item] dd', 'ever');
  await page.waitUntil('「加入词库」可点', `document.querySelector('[data-testid=lookup-add-vocab]')?.disabled === false`);
  await shot(page, '07-coach-card-add-1280.png');
  await page.click('[data-testid=lookup-add-vocab]');
  await page.waitFor('[data-testid=manual-add-form]');
  assert.equal(await page.evaluate(() => !!document.querySelector('[data-definition-popup]')), false, '打开表单时查词卡已关');
  const prefill = {
    word: await value(page, 'manual-word'), pos: await value(page, 'manual-pos'), chinese: await value(page, 'manual-chinese'),
    english: await value(page, 'manual-english'), example: await value(page, 'manual-example'), source: await value(page, 'manual-source'),
  };
  assert.equal(prefill.word.toLowerCase(), 'ever');
  assert.equal(prefill.pos, 'n.');
  assert.match(prefill.chinese, /测试释义/);
  assert.match(prefill.example, /ever/i, '所在句子预填成例句');
  assert.equal(prefill.source, '教练');
  await shot(page, '08-coach-prefilled-1280.png');
  await save(page);
  await page.waitUntil('教练页加词保存', `!document.querySelector('[data-testid=manual-add]')`);
  const ever = (await reviewRows(session)).find(row => row.word.toLowerCase() === 'ever');
  assert.equal(ever.source, '教练');
  assert.equal(ever.status, '🌱待考察');
  await clickWord(page, '[data-testid=coach-item] dd', 'ever');
  await page.waitFor('[data-testid=lookup-in-vocab]');
  assert.equal(await page.evaluate(() => !!document.querySelector('[data-testid=lookup-add-vocab]')), false, '已在词库就不再给「加入词库」');
  await shot(page, '09-coach-in-vocab-1280.png');
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  await pressEscape(page);
  await clickWord(page, '[data-testid=coach-item] dd', 'ever');
  await page.waitFor('[data-testid=lookup-in-vocab]');
  const cardBox = await page.evaluate(() => {
    const r = document.querySelector('[data-definition-popup] [role=dialog]').getBoundingClientRect();
    return { left: r.left, right: r.right, width: innerWidth };
  });
  assert.ok(cardBox.left >= 0 && cardBox.right <= cardBox.width + 1, '390 宽查词卡完整留在窗口内');
  assert.equal(await noOverflow(page), true);
  await shot(page, '10-coach-in-vocab-390.png');
  await page.click('[data-testid=lookup-in-vocab]');
  await page.waitFor('[data-testid=vocab-entry-dialog] [data-testid=word-detail]');
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-testid=vocab-entry-dialog] input')].some(input => input.value === '教练')), '已有词条详情里来源是「教练」');
  await shot(page, '11-coach-open-existing-390.png');
  await pressEscape(page);
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  evidence.checks.coach = { prefill, savedSource: ever.source, inVocabAfterSave: true };

  // ---------------- 5. 复习作答中：查词卡没有「加入词库」 ----------------
  await page.clickText('词库');
  await page.type('[data-testid=vocab-search]', '');
  await clickWord(page, '[data-testid=due-list]', 'candid');
  await page.evaluate(() => {
    const popup = document.querySelector('[data-definition-popup]');
    if (!popup) throw new Error('测试前没有打开词条详情');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.testid = 'e2e-background-pronunciation';
    button.textContent = '背景发音（测试）';
    window.__e2eBackgroundPronunciationPlays = 0;
    button.addEventListener('click', () => { window.__e2eBackgroundPronunciationPlays++; });
    popup.append(button);
  });
  // 从详情仍打开的状态启动，复现遮罩盖住详情、但详情原本仍留在 DOM 的情形。
  await page.evaluate(() => document.querySelector('[data-testid=due-recall-start]').click());
  await page.waitFor('[data-testid=recall-screen]');
  await page.waitUntil('遮罩让背景词条详情 inert', `!!document.querySelector('[data-definition-popup]')?.closest('[inert]')`);
  const backgroundFocus = await page.evaluate(() => {
    const button = document.querySelector('[data-testid=e2e-background-pronunciation]');
    button.focus();
    return document.activeElement === button;
  });
  assert.equal(backgroundFocus, false, '详情在 inert 背景中，不能用焦点选中发音按钮');
  for (let index = 0; index < 8; index++) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[data-definition-popup]')), false, '连续按 Tab 不进入背景详情');
  }
  await page.evaluate(() => document.querySelector('[data-testid=recall]')?.focus());
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert.equal(await page.evaluate(() => window.__e2eBackgroundPronunciationPlays), 0, '回车没有触发背景发音按钮');
  await shot(page, '12-recall-background-inert.png');
  await page.click('[data-testid=recall] button[aria-label="退出复习（Esc）"]');
  await page.waitUntil('退出复现用复习', '!document.querySelector("[data-testid=recall]")');
  const restored = await page.evaluate(() => {
    const button = document.querySelector('[data-testid=e2e-background-pronunciation]');
    if (!button || button.closest('[inert]')) return false;
    button.focus();
    const canFocus = document.activeElement === button;
    button.remove();
    document.querySelector('[data-definition-popup] [role=dialog] button')?.click();
    return canFocus;
  });
  assert.equal(restored, true, '复习遮罩关闭后背景恢复可操作');
  await page.waitUntil('关闭背景词条详情', '!document.querySelector("[data-definition-popup]")');
  await page.click('[data-testid=due-recall-start]');
  await page.waitFor('[data-testid=recall-screen]');
  await clickWord(page, '[data-testid=recall-question] [data-testid=recall-meaning]', 'problem');
  assert.equal(await page.evaluate(() => !!document.querySelector('[data-definition-popup] [data-testid=lookup-vocab]')), false, '作答中查词卡没有「加入词库」');
  assert.doesNotMatch(await popupText(page), /加入词库|已在词库/);
  await shot(page, '12-recall-answering-no-add-1280.png');
  await pressEscape(page);
  await page.waitUntil('查词卡关闭', `!document.querySelector('[data-definition-popup]')`);
  await pressEscape(page);
  await page.waitUntil('退出复习', `!document.querySelector('[data-testid=recall]')`);
  evidence.checks.recallAnswering = {
    addButton: false,
    backgroundDetailInert: true,
    backgroundFocusBlocked: !backgroundFocus,
    tabPressesOutsideBackground: 8,
    backgroundPronunciationPlays: 0,
    backgroundRestored: restored,
  };

  // ---------------- 6. 首考面板、选期下拉没有彩色表情 ----------------
  const panel = await page.evaluate(() => {
    const root = document.querySelector('[data-testid=first-test-panel]');
    root.scrollIntoView({ block: 'start' });
    const select = document.querySelector('[data-testid=first-test-issue]');
    return { text: root.innerText, options: [...select.options].map(option => option.textContent) };
  });
  assert.doesNotMatch(panel.text, EMOJI);
  assert.doesNotMatch(panel.options.join('\n'), EMOJI);
  assert.equal(await seedCount(page), '待首考 4 个');
  assert.ok(panel.options.includes(`${ISSUE} 期 · 新词 3`), JSON.stringify(panel.options));
  assert.ok(panel.options.includes(`${ADDED_ISSUE} 期 · 新词 1`), JSON.stringify(panel.options));
  assert.ok(panel.options.includes('全部按期号顺序 · 新词 4'), JSON.stringify(panel.options));
  await shot(page, '13-first-test-panel-1280.png');
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  await page.evaluate(() => document.querySelector('[data-testid=first-test-panel]').scrollIntoView({ block: 'start' }));
  assert.equal(await noOverflow(page), true);
  await shot(page, '14-first-test-panel-390.png');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  evidence.checks.firstTestPanel = panel;

  // ---------------- 7. 导出复习库：Markdown 里有这两行（还有 ever 和第二个 Candid） ----------------
  const exportPath = path.join(out, `总词库-${process.pid}.md`);
  const exported = await invoke(page, 'vocab_export', { request: { kind: 'review', path: exportPath } });
  assert.equal(exported.records, 12);
  const markdown = fs.readFileSync(exportPath, 'utf8');
  assert.ok(markdown.includes(`\n| lucid | ${ISSUE} | ${today} | 🌱待考察 | — |  |\n`), markdown);
  assert.ok(markdown.includes(`\n| take into account | ${ISSUE} | ${today} | 🌱待考察 | — | 短语，手动加 |\n`), markdown);
  assert.ok(markdown.includes(`\n| Candid | ${ADDED_ISSUE} | ${today} | 🌱待考察 | — |  |\n`), markdown);
  evidence.checks.export = { path: exportPath, records: exported.records };

  const unexpectedErrors = page.errors.filter(error => error !== 'plugin http not found');
  assert.deepEqual(unexpectedErrors, []);

  // ---------------- 8. 重启后还在 ----------------
  page = null;
  session = await restart(runDir, {});
  const afterRestart = (await reviewRows(session)).filter(row => row.id.startsWith('manual:')).map(row => `${row.word}@${row.issue}`).sort();
  assert.deepEqual(afterRestart, [`Candid@${ADDED_ISSUE}`, 'ever@' + ISSUE, `lucid@${ISSUE}`, `take into account@${ISSUE}`].sort());
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.clickText('词库', { timeout: 60000 });
  await waitSeeds(page, 4);
  await page.type('[data-testid=vocab-search]', 'take into');
  await page.waitUntil('重启后搜到短语', `[...document.querySelectorAll('[data-testid=vocab-list] > button')].some(b => b.innerText.includes('take into account'))`);
  await shot(page, '15-after-restart-1280.png');
  evidence.checks.restart = afterRestart;

  evidence.screenshots = fs.readdirSync(out).filter(name => name.endsWith('.png')).sort();
  evidence.pageErrors = page.errors;
  const text = JSON.stringify(evidence, null, 2);
  assert.equal(text.includes(KEY), false, '证据里不含假密钥');
  fs.writeFileSync(path.join(out, 'evidence.json'), text, 'utf8');
  console.log(`证据：${path.join(out, 'evidence.json')}`);
  passed = true;
} catch (error) {
  if (page) await page.screenshot(path.join(out, 'failure.png'), { full: false }).catch(() => {});
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
  console.error(error);
  process.exitCode = 1;
} finally {
  if (session) await stop(session.runDir);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  console.log(`隔离窗口：${passed ? '全部通过后已关闭' : '失败后已关闭'}`);
}
