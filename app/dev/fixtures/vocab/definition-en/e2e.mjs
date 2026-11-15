// 078 英英释义真实窗口验证：隔离数据目录 + 词典测试替身 + 本机假模型，不打真实网站、不调真实模型。
// 1. 没有英英释义的词：打开后自动出现词典释义并标来源；只查一次。
// 2. 自己写一条：排第一，词典的收起成「词典释义（n 条）」；「改成我的」把词典那条变成可编辑的我写的。
// 3. AI 帮我看看：假模型给建议，「用这个替换」换掉，「不换」不变。
// 4. 闪卡背面显示同样的释义。
// 5. 一键补全：20 个词 + 假词典，进度走完，报告数字对；中途取消能停，已写入的保留。
// 6. 电脑 1280、手机 390 宽 100% 和 130% 截图，不横向溢出。
// 用法（在 app 目录）：node dev/fixtures/vocab/definition-en/e2e.mjs
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
const runDir = path.resolve('src-tauri/target/e2e', `078-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const today = localDate();
const KEY = 'dummy-e2e-key-078';

const FILLERS = Array.from({ length: 20 }, (_, i) => `filler${String(i).padStart(2, '0')}`);
const MISSING = new Set(FILLERS.filter((_, i) => i % 5 === 0)); // 4 个查不到
const WORDS = ['alpha', 'bravo', ...FILLERS];
const reviewWords = WORDS.map((word, index) => ({ id: `${word}@1.1`, word, status: 'L2', level: 2, note: `${word} 的备注`, line: index + 2, raw: `| ${word} | 1.1 |`, issue: '1.1', addedAt: today, due: index < 2 ? today : '2099-01-01' }));
const importRequest = {
  upgrade: { fileName: 'empty-upgrade.md', content: '# 学术升级库\n' },
  review: { fileName: 'definition-en-078.md', content: '# 词汇总词库\n' },
  entries: [{ id: 'dummy@1.1', line: 2, raw: '| dummy |', plain: 'dummy', upgrade: 'dummy', source: '测试', note: '' }],
  examples: [], selfChecks: [], reviewWords, warnings: { upgrade: [], review: [] },
};

// ---- 本机假 OpenAI 兼容服务（只回「AI 帮我看看」） ----
const calls = [];
const SUGGESTION = 'tending to recover quickly after trouble';
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
  const reply = content => res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  if (prompt.includes('learner\'s dictionary editor') || prompt.includes('dictionary editor')) {
    calls.push({ kind: 'check', raw });
    return reply({ good: false, comment: '写得太笼统，建议更像词典的写法。', suggestion: SUGGESTION });
  }
  if (prompt.includes('Allowed labels')) {
    const items = JSON.parse(prompt.slice(prompt.indexOf('Sentences:') + 'Sentences:'.length, prompt.indexOf('\n\nReturn only')));
    return reply({ scenes: items.map(item => ({ id: item.id, scene: 'statement' })) });
  }
  calls.push({ kind: 'other', raw });
  return reply({});
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
/** 词典测试替身：alpha/bravo 各给 2 个义项（一个带中文行、一个纯英文）；filler 里 4 个查不到；记录每次调用；每次慢 120ms 让取消来得及。 */
const installDict = (page, missing) => page.evaluate(missingWords => {
  window.__dictCalls = [];
  window.__ES_E2E_DICT__ = async word => {
    window.__dictCalls.push(word);
    await new Promise(resolve => setTimeout(resolve, 120));
    if (missingWords.includes(word)) return null;
    const senses = [['adj.', `first meaning of ${word}\n第一个意思`], ['n.', `second meaning of ${word}`]];
    return { entries: [{ word, phonetic: '', source: 'cambridgeEn', senses: senses.map(([pos, text]) => ({ pos, text: [text], examples: [] })) }], source: 'dict:cambridge', online: false };
  };
}, [...missing]);
const configureModel = page => page.evaluate(baseUrl => {
  localStorage.setItem('linguaclip_ai_config', JSON.stringify({ baseUrl, apiKey: 'dummy-e2e-key-078', model: 'fake-078', temperature: 0.7 }));
  window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);
}, `http://127.0.0.1:${modelPort}/v1`);
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
  await page.waitFor('[data-testid=review-definitions]');
};
const count = (page, selector) => page.evaluate(sel => document.querySelectorAll(sel).length, selector);
const dbRows = async session => { const db = await openDb(session); const rows = queryRows(db, 'vocab_definition_en'); db.close(); return rows; };

const evidence = { today, runDir, checks: {} };
let session;
let page;
let passed = false;
try {
  session = await start({ runDir, port: 9478 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.clickText('词库', { timeout: 60000 });
  assert.equal((await invoke(page, 'vocab_import', { request: importRequest })).reviewWords.added, WORDS.length);
  assert.deepEqual(await invoke(page, 'vocab_definitions_en'), [], '新库没有英英释义');
  const upgraded = await openDb(session);
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 14, '库版本是 14');
  upgraded.close();
  await page.evaluate(() => localStorage.removeItem('linguaclip_ai_config'));
  await page.reload();
  await installDict(page, MISSING);
  await openBrowse(page);

  // ---------------- 1. 自动查词典 ----------------
  await openWord(page, 'alpha');
  await page.waitFor('[data-testid=def-en-dict-list]');
  assert.equal(await count(page, '[data-testid=def-en-dict]'), 2, '词典取到 2 个义项');
  assert.match(await page.text('[data-testid=def-en-source]'), /来自 剑桥英英/);
  const dictText = await page.text('[data-testid=def-en-dict-list]');
  assert.ok(dictText.includes('first meaning of alpha') && !dictText.includes('第一个意思'), '只存英文行');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=def-en-empty]') === null), true, '有释义后不再显示「还没有英英释义」');
  await shot(page, '01-auto-dict-1280.png');
  let rows = await dbRows(session);
  assert.deepEqual(rows.map(row => [row.word_key, row.source, row.pos]), [['alpha', 'dict:cambridge', 'adj.'], ['alpha', 'dict:cambridge', 'n.']]);
  assert.equal(await page.evaluate(() => window.__dictCalls.filter(word => word === 'alpha').length), 1);
  const importedDefinition = await invoke(page, 'vocab_definition_import', { request: { issues: [{ fileName: 'e2e-definition.md', content: '## 词单分析\n1. **alpha** n. — an imported definition of alpha（导入释义）\n' }], eagp: null } });
  assert.equal(importedDefinition.added, 1, '测试通过正式导入命令准备一条导入释义');
  evidence.checks.auto = rows.length;

  // 换个词再回来：不再联网查 alpha。
  await openWord(page, 'bravo');
  await page.waitFor('[data-testid=def-en-dict-list]');
  await openWord(page, 'alpha');
  await sleep(400);
  assert.equal(await page.evaluate(() => window.__dictCalls.filter(word => word === 'alpha').length), 1, '再次打开不重复查');
  note('自动查词典', '通过');

  // ---------------- 2. 自己写一条，排第一，词典收起 ----------------
  await page.click('[data-testid=def-en-open]');
  await page.type('[data-testid=def-en-new-pos]', 'adj.');
  await page.type('[data-testid=def-en-new-text]', 'the first one in a series');
  await page.click('[data-testid=def-en-add]');
  await page.waitFor('[data-testid=def-en-mine]');
  assert.equal(await count(page, '[data-testid=def-en-mine]'), 1);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=def-en-dict-list]') === null), true, '词典释义收起了');
  assert.match(await page.text('[data-testid=def-en-dict-toggle]'), /词典释义（2 条）/);
  assert.match(await page.text('[data-testid=def-en-label]'), /我写的/);
  const order = await page.evaluate(() => {
    const mine = document.querySelector('[data-testid=def-en-mine]');
    const toggle = document.querySelector('[data-testid=def-en-dict-toggle]');
    return !!(mine.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  assert.equal(order, true, '我写的在词典的前面');
  await shot(page, '02-mine-first-1280.png');
  evidence.checks.mine = true;

  // ---------------- 3. 改成我的 ----------------
  await page.click('[data-testid=def-en-dict-toggle]');
  await page.waitFor('[data-testid=def-en-dict-list]');
  await page.click('[data-testid=def-en-adopt]');
  await page.waitUntil('出现第二条我写的', `document.querySelectorAll('[data-testid=def-en-mine]').length === 2`);
  assert.equal((await page.evaluate(() => [...document.querySelectorAll('[data-testid=def-en-text]')].map(e => e.innerText))).includes('first meaning of alpha'), true);
  assert.equal(await count(page, '[data-testid=def-en-dict]'), 2, '词典那条还在');
  // 改它：变成可编辑的一条。
  await page.evaluate(() => document.querySelectorAll('[data-testid=def-en-edit]')[1].click());
  await page.waitFor('[data-testid=def-en-edit-input]');
  await shot(page, '03-adopt-edit-1280.png');
  await page.click('[data-testid=def-en-save]');
  await page.waitUntil('保存后回到查看状态', `document.querySelector('[data-testid=def-en-edit-input]') === null`);
  rows = await dbRows(session);
  assert.equal(rows.filter(row => row.source === 'mine').length, 2);
  // 删除要确认：先点删除再点「不删了」不变，再点「确定删除」才删。
  await page.evaluate(() => document.querySelectorAll('[data-testid=def-en-delete]')[1].click());
  await page.waitFor('[data-testid=def-en-delete-confirm]');
  await page.clickText('不删了');
  assert.equal(await count(page, '[data-testid=def-en-mine]'), 2);
  await page.evaluate(() => document.querySelectorAll('[data-testid=def-en-delete]')[1].click());
  await page.waitFor('[data-testid=def-en-delete-yes]');
  await page.click('[data-testid=def-en-delete-yes]');
  await page.waitUntil('删掉一条', `document.querySelectorAll('[data-testid=def-en-mine]').length === 1`);
  evidence.checks.adopt = true;

  // ---------------- 4. AI 帮我看看（没配模型时没有按钮） ----------------
  assert.equal(await count(page, '[data-testid=def-en-ai]'), 0, '没配模型不显示 AI 按钮');
  await configureModel(page);
  await page.reload();
  await installDict(page, MISSING);
  await configureModel(page);
  await openBrowse(page);
  await openWord(page, 'alpha');
  await page.waitFor('[data-testid=def-en-ai]');
  await page.click('[data-testid=def-en-ai]');
  await page.waitFor('[data-testid=def-en-suggestion]');
  assert.equal(await page.text('[data-testid=def-en-suggestion]'), SUGGESTION);
  await shot(page, '04-ai-check-1280.png');
  await page.click('[data-testid=def-en-keep]');
  assert.equal(await page.text('[data-testid=def-en-text]'), 'the first one in a series', '不换：原文不变');
  await page.click('[data-testid=def-en-ai]');
  await page.waitFor('[data-testid=def-en-apply]');
  await page.click('[data-testid=def-en-apply]');
  await page.waitUntil('替换成建议', `document.querySelector('[data-testid=def-en-text]')?.innerText === ${JSON.stringify(SUGGESTION)}`);
  rows = await dbRows(session);
  assert.ok(rows.some(row => row.source === 'mine' && row.text === SUGGESTION));
  const checkCalls = calls.filter(call => call.kind === 'check');
  assert.equal(checkCalls.length, 2);
  for (const call of calls) assert.equal(call.raw.includes('的备注'), false, '请求里不含复习备注');
  evidence.checks.ai = true;

  // ---------------- 5. 闪卡背面 ----------------
  await page.clickText('词库');
  await page.waitFor('[data-testid=due-start]');
  await page.click('[data-testid=due-start]');
  await page.waitFor('[data-testid=flash]');
  await page.click('[data-testid=flash-card]');
  await page.waitFor('[data-testid=flash-back]');
  await page.waitFor('[data-testid=flash-def-en]');
  await page.waitUntil('闪卡翻面动画结束', `!document.querySelector('[data-ghost]')`);
  const flashWord = await page.text('.vocab-flash-back-word');
  note('闪卡词', flashWord);
  assert.ok(await page.evaluate(() => !document.querySelector('[data-testid=flash-definitions]').innerText.includes('还没有')), '闪卡背面没有「还没有英英释义」');
  if (flashWord === 'alpha') {
    assert.equal(await count(page, '[data-testid=flash-def-en-mine]'), 1, '闪卡：我写的释义存在');
    assert.equal(await count(page, '[data-testid=flash-def-en-imported]'), 1, '闪卡：导入释义存在');
    const order = await page.evaluate(() => {
      const nodes = ['flash-def-en-mine', 'flash-def-en-imported', 'flash-def-en-toggle'].map(id => document.querySelector(`[data-testid=${id}]`));
      return nodes.every(Boolean) && nodes.slice(0, -1).every((node, index) => !!(node.compareDocumentPosition(nodes[index + 1]) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    assert.equal(order, true, '闪卡释义顺序：我写的 → 导入的 → 默认收起的词典释义');
  }
  await shot(page, '05-flash-back-1280.png');
  await page.setViewport(390, 844, { mobile: true, dpr: 2 });
  for (const scale of [100, 130]) {
    await page.evaluate(pct => { document.documentElement.style.fontSize = `${pct}%`; }, scale);
    await page.waitUntil(`390px ${scale}% 闪卡不横向溢出`, `document.documentElement.scrollWidth <= document.documentElement.clientWidth`);
    await shot(page, `05-flash-back-390-${scale}.png`);
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = '100%'; });
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  evidence.checks.flash = flashWord;

  // ---------------- 6. 一键补全 ----------------
  await page.clickText('退出');
  await page.waitUntil('闪卡关掉', `document.querySelector('[data-testid=flash]') === null`);
  await openBrowse(page);
  await page.waitFor('[data-testid=def-fill-start]');
  const missingBefore = (await page.text('[data-testid=def-fill]')).match(/有 (\d+) 个词/)[1];
  note('补全前缺英英释义的词', missingBefore);
  await shot(page, '06-fill-idle-1280.png');
  await page.click('[data-testid=def-fill-start]');
  await page.waitFor('[data-testid=def-fill-progress]');
  await page.waitUntil('进度走了几个', `/正在补全 [3-9] \\/|正在补全 1\\d \\//.test(document.querySelector('[data-testid=def-fill-progress]')?.innerText ?? '')`);
  await shot(page, '07-fill-running-1280.png');
  await page.click('[data-testid=def-fill-cancel]');
  await page.waitFor('[data-testid=def-fill-report]');
  const cancelReport = await page.text('[data-testid=def-fill-report]');
  note('取消后报告', cancelReport);
  assert.match(cancelReport, /^已取消，补了 \d+ 个/);
  const kept = (await dbRows(session)).length;
  assert.ok(kept > 4, '取消后已写入的保留');
  const queriedAtCancel = await page.evaluate(() => window.__dictCalls.length);
  await sleep(600);
  assert.equal(await page.evaluate(() => window.__dictCalls.length), queriedAtCancel, '取消后不再继续查');
  await page.clickText('知道了');
  // 再跑一轮补完剩下的。
  await page.waitFor('[data-testid=def-fill-start]');
  const before = await page.evaluate(() => window.__dictCalls.length);
  await page.click('[data-testid=def-fill-start]');
  await page.waitFor('[data-testid=def-fill-report]', { timeout: 60000 });
  const finalReport = await page.text('[data-testid=def-fill-report]');
  note('补完报告', finalReport);
  assert.match(finalReport, /查不到 4 个/);
  const asked = await page.evaluate(start => window.__dictCalls.slice(start), before);
  assert.ok(!asked.includes('alpha') && !asked.includes('bravo'), '已有英英释义的词不再查');
  await shot(page, '08-fill-report-1280.png');
  rows = await dbRows(session);
  const filled = new Set(rows.map(row => row.word_key));
  assert.equal(filled.size, WORDS.length - MISSING.size, '除了 4 个查不到的，其余都补上了');
  for (const word of MISSING) assert.equal(filled.has(word), false, `${word} 查不到：没有写空记录`);
  assert.ok(rows.every(row => row.text.trim() && row.source.startsWith('dict:') || row.source === 'mine'));
  evidence.checks.fill = finalReport;

  // ---------------- 7. 手机宽 390：100% 和 130% ----------------
  await openBrowse(page);
  await openWord(page, 'alpha');
  await page.setViewport(390, 844, { mobile: true, dpr: 2 });
  await sleep(400);
  assert.equal(await noOverflow(page), true, '390 宽 100% 不横向溢出');
  await page.evaluate(() => document.querySelector('[data-testid=review-definitions]').scrollIntoView({ block: 'start' }));
  await shot(page, '09-mobile-390-100.png');
  await page.evaluate(() => { document.documentElement.style.fontSize = '130%'; });
  await sleep(400);
  assert.equal(await noOverflow(page), true, '390 宽 130% 不横向溢出');
  await page.evaluate(() => document.querySelector('[data-testid=review-definitions]').scrollIntoView({ block: 'start' }));
  await shot(page, '10-mobile-390-130.png');
  await page.click('[data-testid=def-en-open]').catch(() => {});
  await page.evaluate(() => document.documentElement.style.fontSize = '');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });

  // ---------------- 8. 重启后都在 ----------------
  const afterCount = (await dbRows(session)).length;
  session = await restart(runDir);
  page = await connect({ port: session.port });
  await page.waitReady();
  assert.equal((await invoke(page, 'vocab_definitions_en')).length, afterCount, '重启后条数一致');

  const unexpectedErrors = page.errors.filter(error => !/^(Dictionary lookup failed: )?plugin http not found$/.test(error));
  assert.deepEqual(unexpectedErrors, [], '不应有页面错误');
  Object.assign(evidence, { rows: undefined, screenshots: fs.readdirSync(out).filter(name => name.endsWith('.png')).sort(), unexpectedErrors, log });
  const evidenceText = JSON.stringify(evidence, null, 2);
  assert.equal(evidenceText.includes(KEY), false, '证据里不含假密钥');
  fs.writeFileSync(path.join(out, 'evidence.json'), evidenceText, 'utf8');
  note('证据', path.join(out, 'evidence.json'));
  passed = true;
} catch (error) {
  if (page) await page.screenshot(path.join(out, 'failure.png'), { full: false }).catch(() => {});
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify({ ...evidence, log }, null, 2), 'utf8');
  console.error(error);
  process.exitCode = 1;
} finally {
  if (session) await stop(session.runDir);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  note('隔离窗口', passed ? '全部通过后已关闭' : '失败后已关闭');
}
