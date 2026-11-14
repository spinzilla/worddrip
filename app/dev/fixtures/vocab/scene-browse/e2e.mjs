// 049 按场景找词真实窗口验证：隔离数据目录 + 本机假模型，不调用真实模型、不碰真实数据库。
// 夹具 A（5 句：3 句标了 comparison（1 句手动、1 句来自我的例句）、2 句没标）：
//   1. 按场景找 → comparison 看到 3 句和高亮的词；点一句打开词条详情；计数正确。
//   2. 点「补标剩下的」→ 确认 → 进度走完 → 2 句有标签（假模型只被请求 1 次，且不含手动那句）；重启后还在。
//   3. 手动标签补标后不变。1280 / 390 截图。
// 夹具 B（4 个词、4 句都没标）：补标到一半点停止 → 已标的保存、没标的保持没标，页面不报错。
// 用法（在 app 目录）：node dev/fixtures/vocab/scene-browse/e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { start, stop, restart, DEV_PORT, E2E_ROOT } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { portInUse } from '../../../e2e/proc.mjs';

if (await portInUse(DEV_PORT)) {
  console.error(`${DEV_PORT} 端口已被占用（可能有别的开发窗口在跑），先关掉再测。`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const today = localDate();
const KEY = 'dummy-e2e-key-049';
const PRIVATE_NOTE = 'PRIVATE-NOTE-049 这是我的笔记正文，不能发给模型';
const runA = path.join(E2E_ROOT, `049-${stamp}-a`);
const runB = path.join(E2E_ROOT, `049-${stamp}-b`);
const outA = path.join(runA, 'out');

// ---- 夹具数据 ----
const makeWords = list => list.map(([word], index) => ({ id: `${word}@10.20`, word, status: 'L3', level: 3, note: `复习备注-049 ${word}`, line: index + 2, raw: `| ${word} | 10.20 |`, issue: '10.20', addedAt: today, due: today }));
const importRequest = words => ({
  upgrade: { fileName: 'empty-upgrade.md', content: '# 学术升级库\n' },
  review: { fileName: 'scene-browse-049.md', content: '# 词汇总词库\n' },
  entries: [{ id: 'dummy@1.1', line: 2, raw: '| dummy |', plain: 'dummy', upgrade: 'dummy', source: '测试', note: '' }],
  examples: [], selfChecks: [], reviewWords: makeWords(words), warnings: { upgrade: [], review: [] },
});
const issueFor = words => [{ fileName: '20261020.md', content: `## 词单分析\n${words.map(([w, e, s], i) => `${i + 1}. **${w}** v. — ${e}（释义 ${i + 1}）；*${s}*`).join('\n')}\n` }];

const WORDS_A = [
  ['exacerbate', 'to make a problem or situation worse', 'Without more investment, the policy could exacerbate the housing shortage in big cities.'],
  ['mitigate', 'to make something bad less severe', 'Governments introduced new measures to mitigate the effects of rising food prices.'],
];
const MY_A = {
  exacerbate: ['Students often exacerbate the problem when they rush the final draft.', 'The new rules exacerbate inequality between regions.'],
  mitigate: ['Careful planning can mitigate the risk of delays.'],
};
const S1 = WORDS_A[0][2];
const S2 = WORDS_A[1][2];
const [M1, M2] = MY_A.exacerbate;
const M3 = MY_A.mitigate[0];

const WORDS_B = [
  ['exacerbate', 'to make a problem worse', 'Rising costs exacerbate the housing shortage.'],
  ['mitigate', 'to make less severe', 'New measures mitigate the effects of floods.'],
  ['alleviate', 'to make suffering less severe', 'Aid programmes alleviate poverty in rural areas.'],
  ['undermine', 'to weaken something gradually', 'Corruption undermines public trust in institutions.'],
];

// ---- 本机假 OpenAI 兼容服务：每个请求都标 evidence，故意慢 900ms（让「停止」有机会点到）----
const calls = [];
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
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scenes: items.map(item => ({ id: item.id, scene: 'evidence' })) }) } }] }));
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
const shot = (page, name) => page.screenshot(path.join(outA, name), { full: false });
const configureModel = page => page.evaluate(baseUrl => {
  localStorage.setItem('linguaclip_ai_config', JSON.stringify({ baseUrl, apiKey: 'dummy-e2e-key-049', model: 'fake-049', temperature: 0.7 }));
  window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);
}, `http://127.0.0.1:${modelPort}/v1`);
const SEC = '[data-testid=vocab-scenes]';
const fits = page => page.evaluate(sel => document.documentElement.scrollWidth <= document.documentElement.clientWidth
  && [...document.querySelectorAll(`${sel} *`)].every(e => e.getBoundingClientRect().right <= document.documentElement.clientWidth + 1), SEC);
const noAlert = page => page.evaluate(sel => document.querySelectorAll(`${sel} [role=alert]`).length === 0, SEC);
const coverage = page => page.evaluate(() => document.querySelector('[data-testid=scene-coverage]')?.textContent?.trim() ?? '');
const backfillText = page => page.evaluate(() => document.querySelector('[data-testid=scene-backfill]')?.textContent ?? '');
const rowsOf = page => page.evaluate(() => [...document.querySelectorAll('[data-testid=scene-row]')].map(el => ({
  text: el.textContent,
  marks: [...el.querySelectorAll('mark')].map(m => m.textContent),
  from: el.querySelector('.vocab-chip')?.textContent ?? '',
})));
const openScenes = async page => {
  await page.clickText('词库', { timeout: 60000 });
  await page.clickText('场景', { selector: 'button[role=tab]', exact: true });
  await page.waitFor(SEC);
  await page.waitUntil('场景面板读完', `document.querySelector('[data-testid=scene-coverage]') !== null`, { timeout: 30000 });
};
const seedSentences = async (page, rows) => {
  for (const [word, items] of rows) {
    await invoke(page, 'vocab_example_add', { request: { word, items: items.map(sentence => ({ sentence, source: '自己写' })) } });
  }
};

const open = new Set();
const evidence = { today, runA, runB, checks: {} };
let session;
let page;
let passed = false;
try {
  // ================= 夹具 A =================
  session = await start({ runDir: runA, port: 9484 });
  open.add(runA);
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.clickText('词库', { timeout: 60000 });
  assert.equal((await invoke(page, 'vocab_import', { request: importRequest(WORDS_A) })).reviewWords.added, 2);
  const defs = await invoke(page, 'vocab_definition_import', { request: { issues: issueFor(WORDS_A), eagp: null } });
  assert.equal(defs.examplesAdded, 2);
  await seedSentences(page, Object.entries(MY_A));
  await invoke(page, 'vocab_scene_set', { request: { source: 'AI', items: [{ sentence: S1, scene: 'comparison' }, { sentence: M1, scene: 'comparison' }] } });
  await invoke(page, 'vocab_scene_set', { request: { source: '手动', items: [{ sentence: M2, scene: 'comparison' }] } });
  assert.equal((await invoke(page, 'vocab_scenes')).length, 3);
  await configureModel(page);
  await page.reload();
  await configureModel(page);

  // ---- 1. 按场景找
  await openScenes(page);
  assert.equal(calls.length, 0, '打开页面不自动请求模型');
  assert.equal(await coverage(page), '已标 3 句 / 共 5 句');
  const countText = await page.evaluate(() => document.querySelector('[data-testid=scene-chip-comparison]').textContent);
  assert.match(countText, /3 句/, '比较和对比：3 句');
  await page.click('[data-testid=scene-chip-comparison]');
  await page.waitUntil('列出 3 句', `document.querySelectorAll('[data-testid=scene-row]').length === 3`, { timeout: 10000 });
  // 场景按钮的选中态有 150ms 颜色过渡：等动画结束再截图、再看颜色，免得截到半途（049 返工）。
  await page.waitUntil('场景按钮过渡结束', `document.querySelector('[data-testid=scene-chip-comparison]').getAnimations({ subtree: true }).length === 0`, { timeout: 5000 });
  const chipBg = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid=scene-chip-comparison]')).backgroundColor);
  const chipBgOther = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid=scene-chip-evidence]')).backgroundColor);
  assert.notEqual(chipBg, chipBgOther, '选中的场景按钮背景色和没选中的不同');
  const rows = await rowsOf(page);
  assert.ok(rows.some(r => r.from === '我的例句' && r.text.includes(M2)), '我的例句来源的句子也列出来（M2 是手动标的）');
  assert.ok(rows.some(r => r.from === '词库' && r.text.includes(S1)), '词库例句来源的句子也列出来');
  assert.ok(rows.every(r => r.marks.length >= 1 && r.marks.every(m => /exacerbate/i.test(m))), '句中的词高亮');
  note('comparison 列表', rows.map(r => `${r.from}|${r.marks.join(',')}`));
  await shot(page, '01-scenes-comparison-1280.png');
  assert.equal(await fits(page), true, '1280 不横向溢出');

  // 点一句：打开词条详情
  await page.click('[data-testid=scene-row]');
  await page.waitFor('[data-testid=vocab-detail]');
  // 同一个词有几行例句，只有点中的那一行是选中态（不能一起亮）。
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid=scene-row][aria-current=true]').length), 1, '只有点中的那一行选中');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=vocab-detail]')?.dataset.kind), 'word');
  // 1280 宽时「返回列表」按钮是隐藏的（列表和详情并排），不点它。
  evidence.checks.list = rows.map(r => ({ from: r.from, marks: r.marks }));

  // ---- 2. 补标剩下的
  assert.equal(await backfillText(page).then(t => t.includes('补标剩下的（2 句）')), true, '补标按钮显示 2 句');
  await page.clickText('补标剩下的', { selector: '[data-testid=scene-backfill] button', exact: false });
  await page.waitFor('[data-testid=scene-confirm]');
  const confirmText = await page.evaluate(() => document.querySelector('[data-testid=scene-confirm]').textContent);
  assert.match(confirmText, /共 1 个词/);
  assert.match(confirmText, /大约请求 1 次/);
  assert.match(confirmText, /2 句/);
  await page.clickText('开始补标', { selector: '[data-testid=scene-confirm] button' });
  await page.waitFor('[data-testid=scene-done]', { timeout: 30000 });
  await page.waitUntil('覆盖率 5/5', `document.querySelector('[data-testid=scene-coverage]')?.textContent.includes('已标 5 句')`, { timeout: 15000 });
  assert.equal(calls.length, 1, '一个词一次请求');
  assert.equal(calls[0].word, 'mitigate');
  assert.deepEqual([...calls[0].sentences].sort(), [S2, M3].sort(), '只发没标过的两句（手动的、已标的都不发）');
  assert.equal(calls[0].raw.includes(PRIVATE_NOTE), false);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=scene-done]').textContent.includes('补标完成：新标 2 句')), true);
  assert.equal(await backfillText(page).then(t => t.includes('补标剩下的')), false, '没有剩下的，补标按钮消失');
  assert.equal(await noAlert(page), true);
  const afterA = await invoke(page, 'vocab_scenes');
  const manualAfter = afterA.find(item => item.sentence === M2);
  assert.equal(manualAfter.source, '手动', '手动标签补标后不变');
  assert.equal(manualAfter.scene, 'comparison');
  assert.equal(afterA.filter(item => item.source === 'AI' && item.scene === 'evidence').length, 2, '新标的 2 句是 AI 的');
  evidence.checks.backfillA = { calls: calls.map(c => ({ word: c.word, sentences: c.sentences })), manual: manualAfter };
  await page.evaluate(() => document.querySelector('[data-testid=scene-coverage]').scrollIntoView({ block: 'start' }));
  await shot(page, '02-backfill-done-1280.png');

  // ---- 3. 重启后还在
  session = await restart(runA);
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await configureModel(page);
  await openScenes(page);
  await page.waitUntil('重启后覆盖率', `document.querySelector('[data-testid=scene-coverage]')?.textContent.includes('已标 5 句')`, { timeout: 15000 });
  assert.equal(calls.length, 1, '重启后没有新请求');
  assert.deepEqual(await invoke(page, 'vocab_scenes'), afterA, '重启后标签不变');

  // ---- 390 宽：列表和补标框不横向溢出
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  await page.click('[data-testid=scene-chip-evidence]');
  await page.waitUntil('390 列出 evidence', `document.querySelectorAll('[data-testid=scene-row]').length === 2`, { timeout: 10000 });
  await page.waitUntil('390 场景按钮过渡结束', `document.querySelector('[data-testid=scene-chip-evidence]').getAnimations({ subtree: true }).length === 0`, { timeout: 5000 });
  await page.evaluate(() => document.querySelector('[data-testid=vocab-scenes]').scrollIntoView({ block: 'start' }));
  assert.equal(await fits(page), true, '390 不横向溢出');
  await shot(page, '03-scenes-evidence-390.png');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await stop(runA);
  open.delete(runA);
  evidence.checks.a = { total: afterA.length, passed: true };

  // ================= 夹具 B：4 个词都没标，补标到一半停止 =================
  session = await start({ runDir: runB, port: 9485 });
  open.add(runB);
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.clickText('词库', { timeout: 60000 });
  assert.equal((await invoke(page, 'vocab_import', { request: importRequest(WORDS_B) })).reviewWords.added, 4);
  const defsB = await invoke(page, 'vocab_definition_import', { request: { issues: issueFor(WORDS_B), eagp: null } });
  assert.equal(defsB.examplesAdded, 4);
  await configureModel(page);
  await page.reload();
  await configureModel(page);
  const callsBefore = calls.length;
  await openScenes(page);
  assert.equal(await coverage(page), '已标 0 句 / 共 4 句');
  await page.clickText('补标剩下的', { selector: '[data-testid=scene-backfill] button', exact: false });
  await page.waitFor('[data-testid=scene-confirm]');
  assert.match(await page.evaluate(() => document.querySelector('[data-testid=scene-confirm]').textContent), /共 4 个词/);
  await page.clickText('开始补标', { selector: '[data-testid=scene-confirm] button' });
  await page.waitUntil('补标走到第 1 个词之后', `document.querySelector('[data-testid=scene-progress]')?.textContent.includes('已处理 1 /')`, { timeout: 30000 });
  await page.click('[data-testid=scene-progress] button');
  await page.waitFor('[data-testid=scene-done]', { timeout: 30000 });
  await page.waitUntil('停止后不再有请求', `document.querySelector('[data-testid=scene-done]')?.textContent.includes('已停止')`, { timeout: 5000 });
  await sleep(1500);
  const requested = calls.length - callsBefore;
  const savedB = await invoke(page, 'vocab_scenes');
  assert.ok(requested >= 1 && requested < 4, `停止后请求数应少于 4：实际 ${requested}`);
  assert.equal(savedB.length, requested, '已标的（请求过的那几个词，每词 1 句）都保存了');
  assert.equal(await coverage(page), `已标 ${requested} 句 / 共 4 句`);
  assert.equal(await noAlert(page), true, '停止后页面不报错');
  const doneText = await page.evaluate(() => document.querySelector('[data-testid=scene-done]').textContent);
  assert.ok(doneText.includes(`已标的 ${requested} 句已保存`), `完成提示：${doneText}`);
  assert.match(await backfillText(page), new RegExp(`补标剩下的（${4 - requested} 句）`), '没标的还在，补标按钮还在');
  evidence.checks.stopB = { requested, saved: savedB.length };
  await page.evaluate(() => document.querySelector('[data-testid=scene-coverage]').scrollIntoView({ block: 'start' }));
  await shot(page, '04-backfill-stopped-1280.png');
  assert.equal(await fits(page), true, '1280 停止后不溢出');
  await stop(runB);
  open.delete(runB);

  // ---- 请求内容检查（两个夹具的所有请求）
  for (const call of calls) {
    for (const secret of [PRIVATE_NOTE, '复习备注', '笔记', KEY]) assert.equal(call.raw.includes(secret), false, `请求里不含「${secret}」`);
    assert.equal(/[一-鿿]/.test(JSON.parse(call.raw).messages[0].content), false, '请求里没有中文');
  }
  evidence.checks.requests = calls.map(call => ({ word: call.word, sentences: call.sentences }));
  evidence.log = log;
  evidence.screenshots = fs.readdirSync(outA).filter(name => name.endsWith('.png')).sort();
  const text = JSON.stringify(evidence, null, 2);
  assert.equal(text.includes(KEY), false, '证据里不含假密钥');
  fs.writeFileSync(path.join(outA, 'evidence.json'), text, 'utf8');
  note('证据', path.join(outA, 'evidence.json'));
  passed = true;
} catch (error) {
  if (page) await page.screenshot(path.join(outA, 'failure.png'), { full: false }).catch(() => {});
  fs.mkdirSync(outA, { recursive: true });
  fs.writeFileSync(path.join(outA, 'evidence.json'), JSON.stringify({ ...evidence, log, calls: calls.map(call => ({ word: call.word, sentences: call.sentences })) }, null, 2), 'utf8');
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const dir of open) await stop(dir).catch(error => console.error('停止失败：', error.message));
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  note('隔离窗口', passed ? '全部通过后已关闭' : '失败后已关闭');
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
