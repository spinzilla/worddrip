// 048 真实窗口验证：隔离数据目录 + 本机假模型，不调用真实模型、不碰真实数据库。
// 1. 翻到一张有 3 个例句的闪卡背面：请求中不显示标签也不弹错；之后 3 个标签；假模型这个词只被请求 1 次；
//    翻回正面再翻背面、换卡再回来，请求数不变。
// 2. 手动把其中一个改成别的标签；重启后标签还在、手动改的没变，假模型没有新请求。
// 3. 关掉模型配置后打开另一张卡：没有标签、没有报错，能翻面能切卡，「＋场景」能手动选并保存。
// 4. 假模型收到的请求里没有笔记正文和备注。
// 5. 1280 / 390 宽截图，不横向溢出。
// 用法（在 app 目录）：node dev/fixtures/vocab/scenes/e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { start, stop, restart, DEV_PORT } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { portInUse } from '../../../e2e/proc.mjs';

if (await portInUse(DEV_PORT)) {
  console.error(`${DEV_PORT} 端口已被占用（可能有别的开发窗口在跑），先关掉再测。`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.resolve('src-tauri/target/e2e', `048-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const today = localDate();
const KEY = 'dummy-e2e-key-048';
const PRIVATE_NOTE = 'PRIVATE-NOTE-048 这是我的笔记正文，不能发给模型';
const REVIEW_NOTE = '复习备注-048-不能发给模型';

const DUE = [
  ['exacerbate', 'to make a problem or situation worse', 'Without more investment, the policy could exacerbate the housing shortage in big cities.'],
  ['mitigate', 'to make something bad less severe', 'Governments introduced new measures to mitigate the effects of rising food prices.'],
];
const reviewWords = DUE.map(([word], index) => ({ id: `${word}@10.20`, word, status: 'L3', level: 3, note: `${REVIEW_NOTE} ${word}`, line: index + 2, raw: `| ${word} | 10.20 |`, issue: '10.20', addedAt: today, due: today }));
const importRequest = {
  upgrade: { fileName: 'empty-upgrade.md', content: '# 学术升级库\n' },
  review: { fileName: 'scenes-048.md', content: '# 词汇总词库\n' },
  entries: [{ id: 'dummy@1.1', line: 2, raw: '| dummy |', plain: 'dummy', upgrade: 'dummy', source: '测试', note: '' }],
  examples: [], selfChecks: [], reviewWords, warnings: { upgrade: [], review: [] },
};
const issueFiles = [{ fileName: '20261020.md', content: `## 词单分析\n${DUE.map(([w, e, s], i) => `${i + 1}. **${w}** v. — ${e}（释义 ${i + 1}）；*${s}*`).join('\n')}\n` }];
const ownSentences = word => [`The committee asked how to ${word} the damage before the deadline.`, `Students often ${word} the problem when they rush the final draft.`];

// ---- 本机假 OpenAI 兼容服务：给每句按顺序轮流标 comparison / evidence / summary，故意慢一点（看「请求中」的状态）----
const calls = [];
const CYCLE = ['comparison', 'evidence', 'summary'];
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
  assert.ok(prompt.includes('Allowed labels'), '本脚本只应收到场景标注请求');
  const word = JSON.parse(prompt.match(/^Target expression: (.*)$/m)[1]);
  const items = JSON.parse(prompt.slice(prompt.indexOf('Sentences:') + 'Sentences:'.length, prompt.indexOf('\n\nReturn only')));
  calls.push({ word, sentences: items.map(item => item.sentence), raw });
  await new Promise(resolve => setTimeout(resolve, 900));
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scenes: items.map((item, index) => ({ id: item.id, scene: CYCLE[index % CYCLE.length] })) }) } }] }));
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
const shot = (page, name) => page.screenshot(path.join(out, name), { full: false });
const configureModel = page => page.evaluate(baseUrl => {
  localStorage.setItem('linguaclip_ai_config', JSON.stringify({ baseUrl, apiKey: 'dummy-e2e-key-048', model: 'fake-048', temperature: 0.7 }));
  window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);
}, `http://127.0.0.1:${modelPort}/v1`);
const F = '[data-testid=flash]';
const count = (page, sel) => page.evaluate(s => document.querySelectorAll(s).length, sel);
const side = page => page.evaluate(() => document.querySelector('[data-testid=flash-card]')?.dataset.side);
const flashWord = page => page.evaluate(() => document.querySelector('.vocab-flash-word, .vocab-flash-back-word')?.textContent?.trim());
const flipTo = async (page, wanted) => {
  if ((await side(page)) !== wanted) await page.click('[aria-label="翻面（空格）"]');
  await page.waitUntil(`翻到${wanted}`, `document.querySelector('[data-testid=flash-card]')?.dataset.side === '${wanted}'`);
};
const tags = page => page.evaluate(sel => [...document.querySelectorAll(`${sel} [data-testid=scene-tag]`)].map(el => ({ scene: el.dataset.scene, source: el.dataset.source, text: el.textContent, title: el.title })), F);
const fits = page => page.evaluate(sel => document.documentElement.scrollWidth <= document.documentElement.clientWidth
  && [...document.querySelectorAll(`${sel} *`)].every(e => e.getBoundingClientRect().right <= document.documentElement.clientWidth + 1), F);
const noAlert = page => page.evaluate(sel => document.querySelectorAll(`${sel} [role=alert]`).length === 0, F);
const openFlash = async page => {
  await page.clickText('词库', { timeout: 60000 });
  await page.clickText('查词', { selector: 'button[role=tab]', exact: true });
  await page.waitFor('[data-testid=due-start]');
  await page.click('[data-testid=due-start]');
  await page.waitFor(F);
};
const callsFor = word => calls.filter(call => call.word === word);

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
  assert.equal((await invoke(page, 'vocab_import', { request: importRequest })).reviewWords.added, 2);
  const definitions = await invoke(page, 'vocab_definition_import', { request: { issues: issueFiles, eagp: null } });
  assert.equal(definitions.examplesAdded, 2);
  for (const [word] of DUE) {
    await invoke(page, 'vocab_note_add', { request: { word, body: PRIVATE_NOTE, source: '词库' } });
    await invoke(page, 'vocab_example_add', { request: { word, items: ownSentences(word).map(sentence => ({ sentence, source: '自己写' })) } });
  }
  assert.deepEqual(await invoke(page, 'vocab_scenes'), [], '新库没有场景标签');
  await configureModel(page);
  await page.reload();
  await configureModel(page);

  // ---------------- 1. 翻到背面：请求 1 次，3 个标签 ----------------
  await openFlash(page);
  const first = await flashWord(page);
  const second = DUE.map(d => d[0]).find(w => w !== first);
  assert.equal(await count(page, `${F} [data-testid=scene-tag], ${F} [data-testid=scene-add]`), 0, '正面没有任何场景标签');
  await flipTo(page, 'back');
  await sleep(250);
  assert.equal(await count(page, `${F} [data-testid=scene-tag], ${F} [data-testid=scene-add]`), 0, '请求中不显示标签，也不显示「＋场景」');
  assert.equal(await noAlert(page), true, '请求中不弹提示');
  await page.waitUntil('3 个标签出现', `document.querySelectorAll('[data-testid=flash] [data-testid=scene-tag]').length === 3`, { timeout: 15000 });
  assert.equal(callsFor(first).length, 1, '一个词一次请求');
  assert.equal(callsFor(first)[0].sentences.length, 3, '3 句一起发');
  const labelled = await tags(page);
  assert.deepEqual(labelled.map(t => t.scene).sort(), ['comparison', 'evidence', 'summary']);
  assert.ok(labelled.every(t => t.source === 'AI' && /·/.test(t.title)), '悬停有中文');
  note('第一次翻面', labelled);
  await page.evaluate(() => document.querySelector('[data-testid=flash-back]').scrollIntoView({ block: 'start' }));
  await shot(page, '01-flash-back-tags-1280.png');
  assert.equal(await fits(page), true, '1280 不溢出');

  // 来回翻、换卡再回来：请求数不变（每个词各自一次）。
  await flipTo(page, 'front');
  await flipTo(page, 'back');
  await sleep(400);
  assert.equal(callsFor(first).length, 1, '翻回正面再翻背面不再请求');
  await page.click('[aria-label="下一张（→）"]');
  await page.waitUntil('换到第二张', `document.querySelector('.vocab-flash-word, .vocab-flash-back-word')?.textContent.trim() === ${JSON.stringify(second)}`);
  await flipTo(page, 'back');
  await page.waitUntil('第二张 3 个标签', `document.querySelectorAll('[data-testid=flash] [data-testid=scene-tag]').length === 3`, { timeout: 15000 });
  assert.equal(callsFor(second).length, 1);
  await page.click('[aria-label="上一张（←）"]');
  await page.waitUntil('回到第一张', `document.querySelector('.vocab-flash-word, .vocab-flash-back-word')?.textContent.trim() === ${JSON.stringify(first)}`);
  await flipTo(page, 'back');
  await sleep(400);
  assert.equal(await count(page, `${F} [data-testid=scene-tag]`), 3);
  assert.equal(calls.length, 2, '两个词各一次，来回翻没有新请求');
  evidence.checks.oneRequestPerWord = calls.map(c => `${c.word}:${c.sentences.length}`);

  // ---------------- 2. 手动改一个，重启后还在 ----------------
  const before = await tags(page);
  const target = 0;
  const changeTo = before[target].scene === 'definition' ? 'recommendation' : 'definition';
  await page.evaluate(() => document.querySelectorAll('[data-testid=flash] [data-testid=scene-tag]')[0].click());
  await page.waitFor('[data-testid=scene-picker]');
  assert.equal(await count(page, '[data-testid=scene-picker] button'), 10, '弹出 10 个选项');
  assert.equal(await side(page), 'back', '点标签不翻面');
  await page.evaluate(() => document.querySelector('[data-testid=scene-picker]').scrollIntoView({ block: 'center' }));
  await shot(page, '02-picker-1280.png');
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  await page.evaluate(() => document.querySelector('[data-testid=scene-picker]').scrollIntoView({ block: 'center' }));
  assert.equal(await fits(page), true, '390 选项展开不溢出');
  await shot(page, '03-picker-390.png');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.click(`[data-testid=scene-option-${changeTo}]`);
  await page.waitUntil('手动标签', `document.querySelectorAll('[data-testid=flash] [data-testid=scene-tag][data-source="手动"]').length === 1`);
  assert.equal(await count(page, '[data-testid=scene-picker]'), 0, '选完收起');
  const after = await tags(page);
  assert.equal(after[target].scene, changeTo);
  assert.equal(after[target].source, '手动');
  assert.equal(await side(page), 'back', '选标签不翻面');
  const requestsBeforeRestart = calls.length;
  await page.click('[aria-label="退出闪卡（Esc）"]');
  await page.waitUntil('闪卡关闭', `!document.querySelector('[data-testid=flash]')`);

  session = await restart(runDir);
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await configureModel(page);
  await openFlash(page);
  assert.equal(await flashWord(page), first);
  await flipTo(page, 'back');
  await page.waitUntil('重启后标签还在', `document.querySelectorAll('[data-testid=flash] [data-testid=scene-tag]').length === 3`);
  await sleep(1200);
  assert.deepEqual(await tags(page), after, '重启后标签（含手动改的）不变');
  assert.equal(calls.length, requestsBeforeRestart, '重启后没有新请求');
  evidence.checks.persisted = after;

  // ---------------- 3. 关掉模型：没有标签、没报错，「＋场景」可手动选 ----------------
  // 为了让第二张卡「没标过」：先清掉它的标签（直接写库做不到删除，所以改用一个全新的词）。
  await invoke(page, 'vocab_example_add', { request: { word: second, items: [{ sentence: `Fresh sentence one about ${second}.`, source: '自己写' }, { sentence: `Fresh sentence two about ${second}.`, source: '自己写' }] } });
  await page.click('[aria-label="退出闪卡（Esc）"]');
  await page.evaluate(() => localStorage.removeItem('linguaclip_ai_config'));
  await page.reload();
  await openFlash(page);
  const requestsNoModel = calls.length;
  await page.click('[aria-label="下一张（→）"]');
  await page.waitUntil('换到第二张', `document.querySelector('.vocab-flash-word, .vocab-flash-back-word')?.textContent.trim() === ${JSON.stringify(second)}`);
  await flipTo(page, 'back');
  await sleep(800);
  const addCount = await count(page, `${F} [data-testid=scene-add]`);
  const tagCount = await count(page, `${F} [data-testid=scene-tag]`);
  assert.equal(tagCount, 3, '已经标过的 3 句还在（标签存在库里，不需要模型）');
  assert.equal(addCount, 2, '新加的 2 句没有标签，显示「＋场景」');
  assert.equal(await noAlert(page), true, '没配模型不报错');
  assert.equal(calls.length, requestsNoModel, '没配模型不发请求');
  await page.evaluate(() => document.querySelector('[data-testid=flash-back]').scrollIntoView({ block: 'start' }));
  await shot(page, '04-no-model-1280.png');
  await page.click(`${F} [data-testid=scene-add]`);
  await page.waitFor('[data-testid=scene-picker]');
  await page.click('[data-testid=scene-option-concession]');
  await page.waitUntil('手动保存', `document.querySelectorAll('[data-testid=flash] [data-testid=scene-add]').length === 1`);
  const saved = await invoke(page, 'vocab_scenes');
  const concession = saved.filter(s => s.scene === 'concession');
  assert.equal(concession.length, 1);
  assert.equal(concession[0].source, '手动');
  await flipTo(page, 'front');
  await page.click('[aria-label="上一张（←）"]');
  await page.waitUntil('回到第一张', `document.querySelector('.vocab-flash-word, .vocab-flash-back-word')?.textContent.trim() === ${JSON.stringify(first)}`);
  assert.equal(await noAlert(page), true);
  evidence.checks.noModel = { tagCount, addCount, saved: concession[0] };

  // ---------------- 4/5. 请求内容、窄屏 ----------------
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  await flipTo(page, 'back');
  await page.evaluate(() => document.querySelector('[data-testid=flash-back]').scrollIntoView({ block: 'start' }));
  assert.equal(await fits(page), true, '390 闪卡不横向溢出');
  await shot(page, '05-flash-back-390.png');
  await page.evaluate(() => document.querySelector('[data-testid=flash-examples]').scrollIntoView({ block: 'center' }));
  await shot(page, '06-flash-examples-390.png');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  for (const call of calls) {
    for (const secret of [PRIVATE_NOTE, 'PRIVATE-NOTE', REVIEW_NOTE, '复习备注', '笔记', KEY]) assert.equal(call.raw.includes(secret), false, `请求里不含「${secret}」`);
    assert.equal(/[一-鿿]/.test(JSON.parse(call.raw).messages[0].content), false, '请求里没有中文（释义、备注）');
  }
  evidence.checks.requests = calls.map(call => ({ word: call.word, sentences: call.sentences }));
  Object.assign(evidence, { screenshots: fs.readdirSync(out).filter(name => name.endsWith('.png')).sort(), log });
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
