// 035 真实窗口验证：暖色主题截图（039 换成陶土橙主色后沿用，判分屏加了答对/忘记了/答错三种状态）。精听首页、词库（含查词卡）、复习题（含判分结果）、闪卡、教练、设置各一张 1280 宽，
// 外加 390 宽的词库详情和复习题。每屏自动查一遍「面积大的纯白块」和「主要文字对比度」，结果写进 evidence.json。
// 用法（在 app 目录）：node dev/fixtures/theme/e2e.mjs
// 只用隔离数据库和本机假模型，不访问真实词典、真实模型或真实学习数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { start, stop } from '../../e2e/launch.mjs';
import { connect } from '../../e2e/cdp.mjs';
import { portInUse } from '../../e2e/proc.mjs';

assert.equal(await portInUse(3000), false, '开跑前 3000 端口必须空闲');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.resolve('src-tauri/target/e2e', `035-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });
const today = new Date().toLocaleDateString('en-CA');
const KEY = 'dummy-e2e-key-035';
const words = ['exacerbate', 'resilient', 'candid', 'nodata', 'mitigate', 'allocate', 'comprise', 'sustain'];
const reviewWords = words.map((word, index) => ({
  id: `${word}@10.20`, word, status: 'L1', level: 1, note: `${word} 的复习备注`,
  line: index + 2, raw: `| ${word} | 10.20 |`, issue: '10.20', addedAt: today, due: today,
}));
const importRequest = {
  upgrade: { fileName: 'empty-upgrade.md', content: '# 学术升级库\n' },
  review: { fileName: 'theme-035.md', content: '# 词汇总词库\n' },
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
  if (prompt.includes('Items:')) {
    const items = JSON.parse(prompt.slice(prompt.indexOf('Items:') + 'Items:'.length));
    const questions = items.map(item => ({ id: item.id, ...DRAFTS[item.id] }));
    return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questions }) } }] }));
  }
  const word = prompt.match(/Define the word "([^"]*)"/)?.[1] ?? '';
  const data = { word, partOfSpeech: 'n.', definition: `测试释义：${word}。` };
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
const esc = page => page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

/** 每屏的颜色体检：面积 ≥ 4% 视口的纯白(#fff)背景块；可见文字里对比度最低的几处（按各自最近的不透明背景算）。 */
const audit = page => page.evaluate(() => {
  const parse = s => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
  const lum = c => [c.r, c.g, c.b].map(v => v / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const bgOf = el => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a >= 0.95) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const view = innerWidth * innerHeight;
  const whites = [];
  const low = [];
  for (const el of document.querySelectorAll('body *')) {
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight) continue;
    const bg = parse(st.backgroundColor);
    const area = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    if (bg && bg.a >= 0.95 && bg.r === 255 && bg.g === 255 && bg.b === 255 && area >= view * 0.04) whites.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} ${Math.round(area / view * 100)}%`);
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.data.trim());
    if (!own || Number(st.opacity) < 0.9 || el.closest('[disabled],:disabled')) continue;
    const fg = parse(st.color);
    if (!fg) continue;
    const cr = ratio(fg, bgOf(el));
    const large = parseFloat(st.fontSize) >= 24 || (parseFloat(st.fontSize) >= 18.66 && Number(st.fontWeight) >= 700);
    if (cr < (large ? 3 : 4.5)) low.push(`${cr.toFixed(2)} ${st.color} on ${JSON.stringify(bgOf(el))} 「${el.textContent.trim().slice(0, 24)}」`);
  }
  return { whites, lowContrast: [...new Set(low)].slice(0, 12), lowCount: low.length };
});

let session;
let page;
let passed = false;
const evidence = { runDir, shots: {} };
const shot = async (name) => {
  await new Promise(resolve => setTimeout(resolve, 250));
  await page.screenshot(path.join(out, name), { full: false });
  evidence.shots[name] = await audit(page);
  console.log(name, JSON.stringify(evidence.shots[name]));
};
try {
  session = await start({ runDir, port: 9471 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });

  // 1. 精听首页（隔离数据里没有视频，看空状态和导航）。
  await shot('01-home-1280.png');

  await page.clickText('词库', { timeout: 60000 });
  assert.equal((await invoke(page, 'vocab_import', { request: importRequest })).reviewWords.added, 8);
  assert.equal((await invoke(page, 'vocab_definition_import', { request: { issues: [issueFile], eagp: null } })).added, 6);
  assert.equal((await invoke(page, 'vocab_errors_import', { request: errorRequest })).items, 2);
  await page.evaluate(baseUrl => {
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({ baseUrl, apiKey: 'dummy-e2e-key-035', model: 'fake-theme-model', temperature: 1 }));
    localStorage.setItem('linguaclip_dict_sources', JSON.stringify({ online: false, local: false }));
  }, `http://127.0.0.1:${modelPort}/v1`);
  await page.reload();
  await page.clickText('词库');
  await page.evaluate(() => { window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);
    // 038 起配了模型会混入改写/造句题；本脚本专测填空流程，用开发钩子只出填空（改写/造句见 dev/fixtures/vocab/usage/e2e.mjs）。
    window.__ES_E2E_FILL_ONLY__ = true; });

  // 2. 词库浏览 + 查词卡。
  await page.waitFor('[data-testid=due-panel]');
  await shot('02-vocab-due-1280.png');
  await page.type('[data-testid=vocab-search]', 'exacerbate');
  await page.waitFor('[data-testid=vocab-list] > button');
  await page.click('[data-testid=vocab-list] > button');
  await page.waitFor('[data-testid=review-definitions] .vocab-sense p');
  const point = await page.evaluate(() => {
    const root = document.querySelector('[data-testid=review-definitions] .vocab-sense p');
    root.scrollIntoView({ block: 'center' });
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const at = node.data.indexOf('problem');
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at); range.setEnd(node, at + 7);
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    throw new Error('找不到 problem');
  });
  await page.mouseClick(point.x, point.y);
  await page.waitFor('[data-definition-popup] [role=dialog]');
  await page.waitUntil('假模型返回查词结果', `document.querySelector('[data-definition-popup]')?.innerText.includes('测试释义')`);
  await shot('03-vocab-lookup-1280.png');
  await esc(page);
  await page.waitUntil('查词卡关闭', `!document.querySelector('[data-definition-popup]')`);

  // 3. 390 宽词库详情。
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  await page.evaluate(() => scrollTo(0, 0));
  await shot('04-vocab-detail-390.png');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });

  // 4. 闪卡：正面、翻面。
  await page.click('[data-testid=vocab-back]', { timeout: 1500 }).catch(() => {});
  await page.evaluate(() => document.querySelector('[data-testid=due-start]')?.scrollIntoView({ block: 'center' }));
  await page.click('[data-testid=due-start]');
  await page.waitFor('[data-testid=flash-card]');
  await shot('05-flash-front-1280.png');
  await page.click('[data-testid=flash-card]');
  await page.waitFor('[data-testid=flash-back]');
  await shot('06-flash-back-1280.png');
  await esc(page);
  await page.waitUntil('退出闪卡', `!document.querySelector('[data-testid=flash]')`);

  // 5. 复习题：作答屏（390 一张），交卷后看对错颜色。
  await page.click('[data-testid=due-recall-start]');
  await page.waitFor('[data-testid=recall-question]');
  await shot('07-recall-1280.png');
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  await shot('08-recall-390.png');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  // 039：判分屏同时有「答对」「忘记了」「答错」三种状态，好对比成功色、错误色和主色。
  // 答对：选一道用原形就能填对的词（exacerbate / resilient / candid）；忘记了、答错各挑剩下的一道。
  const plan = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid=recall-question]')];
    const ids = cards.map(card => card.dataset.word ?? '');
    const right = ids.findIndex(id => /^(exacerbate|resilient|candid)@/.test(id));
    const rest = ids.map((_, i) => i).filter(i => i !== right);
    return { right, word: right >= 0 ? ids[right].split('@')[0] : '', forgot: rest[0], wrong: rest[1] };
  });
  assert.ok(plan.right >= 0 && plan.forgot !== undefined && plan.wrong !== undefined, `第一屏题目不够排出三种状态：${JSON.stringify(plan)}`);
  evidence.gradedPlan = plan;
  await page.type(`#recall-input-${plan.right}`, plan.word);
  await page.click(`[data-testid=recall-question]:nth-child(${plan.forgot + 1}) [data-testid=recall-forgot]`);
  await page.type(`#recall-input-${plan.wrong}`, 'comprehend');
  await page.click('[data-testid=recall-submit]');
  await page.waitFor('[data-testid=recall-result]');
  const kinds = await page.evaluate(() => [...document.querySelectorAll('[data-testid=recall-question]')].map(card => card.querySelector('[data-testid=recall-result]')?.dataset.kind ?? ''));
  evidence.gradedKinds = kinds;
  assert.equal(kinds[plan.right], 'correct', '答对的那题判为 correct');
  assert.equal(kinds[plan.forgot], 'forgot', '忘记了的那题判为 forgot');
  assert.equal(kinds[plan.wrong], 'wrong', '答错的那题判为 wrong');
  await page.evaluate(() => document.querySelector('[data-testid=recall-question]')?.scrollIntoView({ block: 'start' }));
  await shot('09-recall-graded-1280.png');
  await page.evaluate(i => document.querySelectorAll('[data-testid=recall-question]')[Math.max(...i)]?.scrollIntoView({ block: 'end' }), [plan.right, plan.forgot, plan.wrong]);
  await shot('09b-recall-graded-more-1280.png');
  await esc(page);
  await page.waitUntil('退出复习', `!document.querySelector('[data-testid=recall]')`);

  // 6. 教练、设置。
  await page.clickText('教练');
  await page.waitFor('[data-testid=coach-item]');
  await shot('10-coach-1280.png');
  // 「设置」用上游 i18n，跟系统语言走：中文系统显示「设置」，英文系统显示 Settings。
  await page.clickText(['设置', 'Settings']);
  await new Promise(resolve => setTimeout(resolve, 800));
  await shot('11-settings-1280.png');

  evidence.pageErrors = page.errors;
  const whites = Object.entries(evidence.shots).filter(([, a]) => a.whites.length);
  assert.deepEqual(whites, [], '不应再有大面积纯白背景块');
  passed = true;
} catch (error) {
  if (page) await page.screenshot(path.join(out, 'failure.png'), { full: false }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  evidence.screenshots = fs.readdirSync(out).filter(name => name.endsWith('.png')).sort();
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
  console.log(`证据：${path.join(out, 'evidence.json')}`);
  if (session) await stop(session.runDir);
  await new Promise(resolve => server.close(resolve));
  console.log(`隔离窗口：${passed ? '全部通过后已关闭' : '失败后已关闭'}`);
}
