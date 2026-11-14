// 034 真实窗口验证：词库 / 复习 / 教练点英文词；作答时请求与卡片都防泄题；390px 查词卡。
// 用法（在 app 目录）：node dev/fixtures/vocab/click-lookup/e2e.mjs
// 只用隔离数据库和本机假模型，不访问真实词典、真实模型或真实学习数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { start, stop } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { portInUse } from '../../../e2e/proc.mjs';

assert.equal(await portInUse(3000), false, '开跑前 3000 端口必须空闲');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.resolve('src-tauri/target/e2e', `034-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });
const today = new Date().toLocaleDateString('en-CA');
const KEY = 'dummy-e2e-key-034';
const words = ['exacerbate', 'resilient', 'candid', 'nodata', 'mitigate', 'allocate', 'comprise', 'sustain'];
const reviewWords = words.map((word, index) => ({
  id: `${word}@10.20`, word, status: 'L1', level: 1, note: `${word} 的复习备注：2026-10-20 ✗`,
  line: index + 2, raw: `| ${word} | 10.20 |`, issue: '10.20', addedAt: today, due: today,
}));
const importRequest = {
  upgrade: { fileName: 'empty-upgrade.md', content: '# 学术升级库\n' },
  review: { fileName: 'recall-034.md', content: '# 词汇总词库\n' },
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
const DRAFTS = {
  'resilient@10.20': { meaning: 'able to recover quickly', sentence: 'Small island economies must become more [[resilient]] to cope with extreme weather.' },
  'candid@10.20': { meaning: 'honest and direct, even when the truth is unwelcome', sentence: 'In the interview, the minister gave a surprisingly [[candid]] account of the failures.' },
  'nodata@10.20': { meaning: 'a missing value', sentence: 'The nodata field shows that a [[nodata]] value was recorded.' },
};

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
    modelCalls.push({ kind: 'questions', prompt });
    const questions = items.map(item => ({ id: item.id, ...DRAFTS[item.id] }));
    return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questions }) } }] }));
  }
  const word = prompt.match(/Define the word "([^"]*)"/)?.[1] ?? '';
  modelCalls.push({ kind: 'lookup', word, prompt });
  // 故意在 AI 回答里放复习答案和变形，卡片必须再次遮住，不能只靠请求端防泄题。
  const data = { word, partOfSpeech: 'n.', definition: `测试释义：${word}。exacerbate / exacerbation 只用于验证复习遮罩。` };
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const modelPort = server.address().port;

const errorMd = fs.readFileSync('dev/fixtures/vocab/errors.md', 'utf8');
const parserOut = path.join(runDir, 'error-parser.mjs');
await build({ entryPoints: ['utils/vocab/errors.ts'], bundle: true, format: 'esm', outfile: parserOut, logLevel: 'silent' });
const { parseErrorArchive } = await import(pathToFileURL(parserOut).href);
const errorRequest = { ...parseErrorArchive(errorMd), source: { fileName: 'errors.md', content: errorMd } };

const invoke = async (page, command, args = {}) => {
  const outcome = await page.evaluate(async (cmd, payload) => {
    try { return { value: await window.__TAURI_INTERNALS__.invoke(cmd, payload) }; }
    catch (error) { return { error: typeof error === 'string' ? error : String(error) }; }
  }, command, args);
  if (outcome.error) throw new Error(`${command} 失败：${outcome.error}`);
  return outcome.value;
};
const shot = (page, name) => page.screenshot(path.join(out, name), { full: false });
const popupText = page => page.evaluate(() => document.querySelector('[data-definition-popup] [role=dialog]')?.innerText ?? '');
const closePopup = async page => {
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await page.waitUntil('查词卡关闭', `!document.querySelector('[data-definition-popup]')`);
};
/** 用 Range 找词的真实屏幕坐标，再走 CDP 鼠标事件，不直接调用 React handler。 */
const clickWord = async (page, selector, word) => {
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
  await page.waitUntil('假模型返回查词结果', `document.querySelector('[data-definition-popup]')?.innerText.includes('测试释义')`);
};

let session;
let page;
let passed = false;
const evidence = { runDir, checks: {}, modelCalls };
try {
  session = await start({ runDir, port: 9470 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.clickText('词库', { timeout: 60000 });
  assert.equal((await invoke(page, 'vocab_import', { request: importRequest })).reviewWords.added, 8);
  assert.equal((await invoke(page, 'vocab_definition_import', { request: { issues: [issueFile], eagp: null } })).added, 6);
  assert.equal((await invoke(page, 'vocab_errors_import', { request: errorRequest })).items, 2);
  await page.evaluate(baseUrl => {
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({ baseUrl, apiKey: 'dummy-e2e-key-034', model: 'fake-lookup-model', temperature: 0.7 }));
    localStorage.setItem('linguaclip_dict_sources', JSON.stringify({ online: false, local: false }));
  }, `http://127.0.0.1:${modelPort}/v1`);
  await page.reload();
  await page.clickText('词库');
  await page.evaluate(() => { window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);
    // 038 起配了模型会混入改写/造句题；本脚本专测填空流程，用开发钩子只出填空（改写/造句见 dev/fixtures/vocab/usage/e2e.mjs）。
    window.__ES_E2E_FILL_ONLY__ = true; });

  // 1. 词库英文释义：普通文本没有单词按钮，也能点出同一张查词卡。
  await page.type('[data-testid=vocab-search]', 'exacerbate');
  await page.waitFor('[data-testid=vocab-list] > button');
  await page.click('[data-testid=vocab-list] > button');
  await page.waitFor('[data-testid=review-definitions] .vocab-sense p');
  await clickWord(page, '[data-testid=review-definitions] .vocab-sense p', 'problem');
  assert.match(await popupText(page), /problem/);
  await shot(page, '01-vocab-definition.png');
  evidence.checks.vocab = true;
  await closePopup(page);

  // 2. 复习作答前：点 problem 可查，但请求语境、请求目标字段和卡片都不能出现 exacerbate / 变形。
  await page.click('[data-testid=due-recall-start]');
  await page.waitFor('[data-testid=recall-screen]');
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid=recall-question]').length), 4);
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  const beforeLookups = modelCalls.filter(call => call.kind === 'lookup').length;
  await clickWord(page, '[data-testid=recall-question] [data-testid=recall-meaning]', 'problem');
  const reviewCalls = modelCalls.filter(call => call.kind === 'lookup').slice(beforeLookups);
  assert.equal(reviewCalls.length, 1);
  assert.equal(reviewCalls[0].word, 'problem');
  assert.doesNotMatch(reviewCalls[0].prompt, /exacerbat/i, '发给 AI 的查词请求不能含答案或变形');
  const reviewPopup = await popupText(page);
  assert.match(reviewPopup, /problem/);
  assert.doesNotMatch(reviewPopup, /exacerbat/i, '查词卡不能显示 AI 故意返回的答案或变形');
  const layout = await page.evaluate(() => {
    const card = document.querySelector('[data-definition-popup] [role=dialog]').getBoundingClientRect();
    return { left: card.left, right: card.right, width: innerWidth, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  });
  assert.ok(layout.left >= 0 && layout.right <= layout.width + 1, '390px 查词卡完整留在窗口内');
  assert.equal(layout.overflow, false, '390px 页面无横向溢出');
  // 查词卡有 150ms 淡入；立刻截图会拍到半透明的卡，看起来像叠层出错。
  await new Promise(resolve => setTimeout(resolve, 400));
  await shot(page, '02-recall-390-scrubbed.png');
  evidence.checks.review = { requestScrubbed: true, popupScrubbed: true, width: 390, layout };
  await closePopup(page);
  assert.equal(await page.evaluate(() => !!document.querySelector('[data-testid=recall]')), true, 'Esc 只关查词卡，不退出复习');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await page.waitUntil('退出复习', `!document.querySelector('[data-testid=recall]')`);
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });

  // 3. 教练错误档案：我写的 / 改法里的英文也可查。
  await page.clickText('教练');
  await page.waitFor('[data-testid=coach-item]');
  // 教练页按最近一批在前（019 起就是这样），默认展开的是 2026-01-04 那批，第一条「我写的」是 ever day。
  const beforeCoach = modelCalls.filter(call => call.kind === 'lookup').length;
  await clickWord(page, '[data-testid=coach-item] dd', 'ever');
  const coachCalls = modelCalls.filter(call => call.kind === 'lookup').slice(beforeCoach);
  assert.equal(coachCalls.length, 1);
  assert.equal(coachCalls[0].word.toLowerCase(), 'ever');
  assert.match(await popupText(page), /ever/i);
  await shot(page, '03-coach-item.png');
  evidence.checks.coach = true;
  await closePopup(page);

  const unexpectedErrors = page.errors.filter(error => error !== 'plugin http not found');
  assert.deepEqual(unexpectedErrors, []);
  evidence.screenshots = fs.readdirSync(out).filter(name => name.endsWith('.png')).sort();
  evidence.pageErrors = page.errors;
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
  console.log(`证据：${path.join(out, 'evidence.json')}`);
  passed = true;
} catch (error) {
  if (page) await page.screenshot(path.join(out, 'failure.png'), { full: false }).catch(() => {});
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
  console.error(error);
  process.exitCode = 1;
} finally {
  if (session) await stop(session.runDir);
  await new Promise(resolve => server.close(resolve));
  console.log(`隔离窗口：${passed ? '全部通过后已关闭' : '失败后已关闭'}`);
}
