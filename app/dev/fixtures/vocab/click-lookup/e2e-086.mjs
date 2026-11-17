// 086 真实窗口验证：闪卡、词条详情、看剧、到期复习作答中/判完后、手机 390 宽 130% 字号的查词卡。
// 用法（在 app 目录）：node dev/fixtures/vocab/click-lookup/e2e-086.mjs
// 只用隔离数据目录、本机假模型（词典来源全关），不碰真实学习数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { start, stop } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { chooseFile } from '../../../e2e/dialog.mjs';
import { openDb, queryRows } from '../../../e2e/db.mjs';
import { portInUse } from '../../../e2e/proc.mjs';

assert.equal(await portInUse(3000), false, '开跑前 3000 端口必须空闲');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.resolve('D:/tmp/es-e2e', `086-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });
const now = new Date();
const today = now.toLocaleDateString('en-CA');
const issue = `${now.getMonth() + 1}.${now.getDate()}`;
const KEY = 'dummy-e2e-key-086';
const VIDEO = path.join(process.cwd(), 'src-tauri', 'tests', 'fixtures', 'tone.mp4');
const SUBTITLE = path.join(process.cwd(), 'TEST_SUBTITLES.srt');
for (const file of [VIDEO, SUBTITLE]) assert.ok(fs.existsSync(file), `缺测试文件：${file}`);

// ---------- 夹具：8 个到期词 + 6 个词的释义/例句 ----------
const words = ['exacerbate', 'resilient', 'candid', 'nodata', 'mitigate', 'allocate', 'comprise', 'sustain'];
const reviewWords = words.map((word, index) => ({
  id: `${word}@${issue}`, word, status: 'L1', level: 1, note: `${word} 的复习备注`,
  line: index + 2, raw: `| ${word} | ${issue} |`, issue, addedAt: today, due: today,
}));
const importRequest = {
  upgrade: { fileName: 'empty-upgrade.md', content: '# 学术升级库\n' },
  review: { fileName: 'recall-086.md', content: '# 词汇总词库\n' },
  entries: [{ id: 'dummy@1.1', line: 2, raw: '| dummy |', plain: 'dummy', upgrade: 'dummy', source: '测试', note: '' }],
  examples: [], selfChecks: [], reviewWords, warnings: { upgrade: [], review: [] },
};
const issueFile = {
  fileName: '20261115.md',
  content: `## 词单分析
1. **exacerbate** v. — to make a problem or situation worse（使恶化）；*Without more investment, the policy could exacerbate the housing shortage.*
2. **resilient** adj. — able to recover quickly from difficulty（有韧性的）
3. **mitigate** v. — to make something bad less severe（减轻）；*Governments introduced new measures to mitigate the effects of rising prices.*
4. **allocate** v. — to give something officially for a particular purpose（分配）；*The council allocated extra funds to rural schools last year.*
5. **comprise** v. — to consist of particular parts（由……组成）；*The course comprises six core modules and two electives.*
6. **sustain** v. — to keep something going over time（维持）；*Few small farms can sustain such high costs for long.*
`,
};

// ---------- 本机假模型：查词 ----------
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  res.setHeader('Content-Type', 'application/json');
  const prompt = payload.messages?.[0]?.content ?? '';
  const word = prompt.match(/Define the word "([^"]*)"/)?.[1] ?? 'e2e';
  const data = { word, partOfSpeech: word.includes(' ') ? 'phr.' : 'n.', definition: `测试释义：${word}` };
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const modelPort = server.address().port;

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
const pressEscape = page => page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
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
      if (r.width <= 0 || r.height <= 0) continue;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    throw new Error(`在 ${sel} 里找不到词：${wanted}`);
  }, selector, word);
  await page.mouseClick(point.x, point.y);
  await page.waitFor('[data-definition-popup] [role=dialog]');
  await page.waitUntil('假模型返回查词结果', `document.querySelector('[data-definition-popup]')?.innerText.includes(${JSON.stringify(until)})`);
};
const saveForm = async (page, source) => {
  await page.waitFor('[data-testid=manual-add-form]');
  assert.equal(await value(page, 'manual-source'), source, `来源应为${source}`);
  await page.click('[data-testid=manual-save]');
  await page.waitUntil('保存完成', `!document.querySelector('[data-testid=manual-add]')`);
};
const reviewRows = async session => {
  const db = await openDb(session);
  try { return queryRows(db, 'review_word'); } finally { db.close(); }
};
const vocabButton = page => page.evaluate(() => {
  const add = document.querySelector('[data-testid=lookup-add-vocab]');
  const already = document.querySelector('[data-testid=lookup-in-vocab]');
  return { add: !!add, addDisabled: add ? add.disabled : null, already: !!already };
});

let session;
let page;
let passed = false;
const evidence = { runDir, issue, today, checks: {} };
try {
  session = await start({ runDir, port: 9473 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.clickText('词库', { timeout: 60000 });
  assert.equal((await invoke(page, 'vocab_import', { request: importRequest })).reviewWords.added, 8);
  assert.equal((await invoke(page, 'vocab_definition_import', { request: { issues: [issueFile], eagp: null } })).added, 6);
  await page.evaluate(baseUrl => {
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({ baseUrl, apiKey: 'dummy-e2e-key-086', model: 'fake-lookup-model', temperature: 0.7 }));
    localStorage.setItem('linguaclip_dict_sources', JSON.stringify({ online: false, local: false }));
  }, `http://127.0.0.1:${modelPort}/v1`);
  await page.reload();
  await page.clickText('词库');
  await page.evaluate(() => { window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window); window.__ES_E2E_FILL_ONLY__ = true; });

  // ---------------- 1. 词条详情：点例句里的 investment → 加入词库（来源「词库」） ----------------
  await page.type('[data-testid=vocab-search]', 'exacerbate');
  await page.waitUntil('列表里搜到 exacerbate', `[...document.querySelectorAll('[data-testid=vocab-list] > button')].some(b => b.innerText.includes('exacerbate'))`);
  await page.click('[data-testid=vocab-list] > button');
  await page.waitFor('[data-testid=word-detail]');
  await clickWord(page, '[data-testid=word-detail]', 'investment');
  assert.deepEqual(await vocabButton(page), { add: true, addDisabled: false, already: false });
  await shot(page, '01-detail-add-1280.png');
  await page.click('[data-testid=lookup-add-vocab]');
  await saveForm(page, '词库');
  let rows = await reviewRows(session);
  assert.equal(rows.find(row => row.word === 'investment')?.source, '词库', '词条详情加的词来源是「词库」');
  evidence.checks.detail = { word: 'investment', source: '词库' };

  // 再点同一个词：已在词库 → 点开词条
  await clickWord(page, '[data-testid=word-detail]', 'investment');
  await page.waitFor('[data-testid=lookup-in-vocab]');
  assert.deepEqual(await vocabButton(page), { add: false, addDisabled: null, already: true });
  await shot(page, '02-detail-in-vocab-1280.png');
  await page.click('[data-testid=lookup-in-vocab]');
  await page.waitFor('[data-testid=vocab-entry-dialog] [data-testid=word-detail]');
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-testid=vocab-entry-dialog] input')].some(input => input.value === '词库')), '打开的词条来源是「词库」');
  await pressEscape(page);
  await page.waitUntil('关闭已有词条', `!document.querySelector('[data-testid=vocab-entry-dialog]')`);
  evidence.checks.detailInVocab = true;

  // ---------------- 2. 闪卡：点释义里的一个词 → 加入词库 → 再点显示已在词库 ----------------
  await page.type('[data-testid=vocab-search]', '');
  await page.click('[data-testid=due-start]');
  await page.waitFor('[data-testid=flash]');
  await page.click('[data-testid=flash-card]'); // 翻到背面
  await page.waitFor('[data-testid=flash-back]');
  const flashText = await page.text('[data-testid=flash-back]');
  const candidate = ['rural', 'modules', 'measures', 'costs', 'recover', 'policy', 'housing', 'shortage'].find(word => flashText.toLowerCase().includes(word));
  assert.ok(candidate, `闪卡背面要能找到一个可加的英文词：${flashText.slice(0, 120)}`);
  await clickWord(page, '[data-testid=flash-back]', candidate);
  assert.deepEqual(await vocabButton(page), { add: true, addDisabled: false, already: false });
  await shot(page, '03-flash-add-1280.png');
  await page.click('[data-testid=lookup-add-vocab]');
  await saveForm(page, '词库');
  rows = await reviewRows(session);
  assert.equal(rows.find(row => row.word === candidate)?.source, '词库', '闪卡加的词来源是「词库」');
  evidence.checks.flash = { word: candidate, source: '词库' };
  await page.clickText('退出', { selector: '[data-testid=flash] button' });
  await page.waitUntil('退出闪卡', `!document.querySelector('[data-testid=flash]')`);

  await page.click('[data-testid=due-start]');
  await page.waitFor('[data-testid=flash]');
  await page.click('[data-testid=flash-card]');
  await page.waitFor('[data-testid=flash-back]');
  await clickWord(page, '[data-testid=flash-back]', candidate);
  await page.waitFor('[data-testid=lookup-in-vocab]');
  await shot(page, '04-flash-in-vocab-1280.png');
  await page.click('[data-testid=lookup-in-vocab]');
  await page.waitFor('[data-testid=vocab-entry-dialog]');
  await pressEscape(page);
  await page.waitUntil('关闭词条详情', `!document.querySelector('[data-testid=vocab-entry-dialog]')`);
  await page.evaluate(() => document.querySelector('[data-testid=flash] button[aria-label^="退出"]')?.click());
  await page.waitUntil('退出闪卡', `!document.querySelector('[data-testid=flash]')`);
  evidence.checks.flashInVocab = true;

  // ---------------- 3. 看剧：字幕点 world → 加入词库（来源「看剧」） ----------------
  await page.clickText('视频');
  await page.clickText(['添加视频', 'Add video']);
  await page.waitText(['选择本机视频', 'Choose a video on this Mac']);
  await page.clickText(['选择本机视频', 'Choose a video on this Mac']);
  await chooseFile(session, VIDEO);
  await page.waitText('tone.mp4');
  try {
    await page.clickText(['选字幕文件', 'Choose subtitles'], { timeout: 5000 });
    await chooseFile(session, SUBTITLE);
    await page.waitText('TEST_SUBTITLES.srt');
  } catch { console.log('提示：字幕那一步没走通（不影响本卡）'); }
  await page.clickText(['开始练习', 'Start practice']);
  await page.waitFor('[role=dialog][aria-label="这次怎么练"]');
  await page.clickText('看剧', { selector: '[role=dialog] button' });
  await page.clickText('开始看剧', { selector: '[role=dialog] button' });
  await page.waitFor('[data-lookup-line]');
  await clickWord(page, '[data-lookup-line]', 'world');
  assert.deepEqual(await vocabButton(page), { add: true, addDisabled: false, already: false });
  await shot(page, '05-watch-add-1280.png');
  await page.click('[data-testid=lookup-add-vocab]');
  await saveForm(page, '看剧');
  rows = await reviewRows(session);
  assert.equal(rows.find(row => row.word === 'world')?.source, '看剧', '看剧加的词来源是「看剧」');
  evidence.checks.watch = { word: 'world', source: '看剧' };
  await page.reload();
  await page.clickText('词库');
  await page.evaluate(() => { window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window); window.__ES_E2E_FILL_ONLY__ = true; });

  // ---------------- 4. 到期复习：作答中没有按钮；提交后（判完分）有按钮 ----------------
  await page.waitUntil('到期复习可点', `document.querySelector('[data-testid=due-recall-start]')?.disabled === false`);
  await page.click('[data-testid=due-recall-start]');
  await page.waitFor('[data-testid=recall-screen]');
  const questionText = await page.text('[data-testid=recall-question]');
  const answerWord = ['something', 'problem', 'situation', 'particular', 'purpose', 'recover'].find(word => questionText.toLowerCase().includes(word));
  assert.ok(answerWord, `复习题面里要能找到一个非目标词：${questionText.slice(0, 120)}`);
  await clickWord(page, '[data-testid=recall-question]', answerWord);
  assert.equal((await vocabButton(page)).add, false, '作答中查词卡没有「加入词库」');
  assert.doesNotMatch(await page.text('[data-definition-popup]'), /加入词库|已在词库/);
  await shot(page, '06-recall-answering-1280.png');
  await pressEscape(page);
  await page.waitUntil('查词卡关闭', `!document.querySelector('[data-definition-popup]')`);
  await page.click('[data-testid=recall-submit]');
  await page.waitFor('[data-testid=recall-next]');
  const checkText = await page.text('[data-testid=recall-question]');
  const checkWord = ['something', 'problem', 'situation', 'particular', 'purpose', 'answer', 'word'].find(word => checkText.toLowerCase().includes(word));
  assert.ok(checkWord, `判完后题面里要能找到一个可查的词：${checkText.slice(0, 120)}`);
  await clickWord(page, '[data-testid=recall-question]', checkWord);
  await page.waitUntil('判完后给「加入词库」', `document.querySelector('[data-testid=lookup-add-vocab]')?.disabled === false`);
  await shot(page, '07-recall-judged-1280.png');
  evidence.checks.recall = { answering: false, judged: true, word: checkWord };
  await pressEscape(page);
  await page.waitUntil('查词卡关闭', `!document.querySelector('[data-definition-popup]')`);
  await page.click('[data-testid=recall] button[aria-label="退出复习（Esc）"]').catch(() => page.evaluate(() => document.querySelector('[data-testid=recall]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))));
  await page.waitUntil('退出复习', `!document.querySelector('[data-testid=recall]')`);

  // ---------------- 5. 手机 390 宽、130% 字号：闪卡查词卡不挤、不溢出 ----------------
  await page.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36' });
  await page.reload();
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '130%'; window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window); window.__ES_E2E_FILL_ONLY__ = true; });
  await page.clickText('词库');
  await page.waitUntil('到期按钮可点', `document.querySelector('[data-testid=due-start]')?.disabled === false`);
  await page.click('[data-testid=due-start]');
  await page.waitFor('[data-testid=flash]');
  await page.click('[data-testid=flash-card]');
  await page.waitFor('[data-testid=flash-back]');
  const mobileText = await page.text('[data-testid=flash-back]');
  const mobileWord = ['shortage', 'housing', 'modules', 'measures', 'costs', 'recover', 'electives', 'prices'].find(word => mobileText.toLowerCase().includes(word)) ?? candidate;
  await clickWord(page, '[data-testid=flash-back]', mobileWord);
  await page.waitFor('[data-testid=lookup-add-vocab]');
  const box = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid=lookup-vocab]');
    const card = document.querySelector('[data-definition-popup] [role=dialog]');
    const b = bar.getBoundingClientRect(), c = card.getBoundingClientRect();
    return { barLeft: b.left, barRight: b.right, barWidth: b.width, cardLeft: c.left, cardRight: c.right, vw: innerWidth };
  });
  assert.ok(box.barLeft >= 0 && box.barRight <= box.vw + 1, `390 宽按钮不溢出：${JSON.stringify(box)}`);
  assert.ok(box.cardLeft >= 0 && box.cardRight <= box.vw + 1, '查词卡留在窗口内');
  assert.equal(await noOverflow(page), true, '390 宽 130% 字号不横向溢出');
  await shot(page, '08-mobile-flash-390.png');
  await page.click('[data-testid=lookup-add-vocab]');
  await saveForm(page, '词库');
  rows = await reviewRows(session);
  assert.equal(rows.find(row => row.word === mobileWord)?.source, '词库', '手机查词加的词来源是「词库」');
  evidence.checks.mobileFlash = { width: 390, font: '130%', word: mobileWord, source: '词库', box };

  const unexpectedErrors = page.errors.filter(error => error !== 'plugin http not found');
  assert.deepEqual(unexpectedErrors, []);
  evidence.screenshots = fs.readdirSync(out).filter(name => name.endsWith('.png')).sort();
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
