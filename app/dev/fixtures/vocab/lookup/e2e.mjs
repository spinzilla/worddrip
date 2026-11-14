// 029 真实窗口验证：查词界面改版。
// 用法（在 app 目录）：node dev/fixtures/vocab/lookup/e2e.mjs
// 隔离窗口里导入真实原料的副本（D:/tmp/es-import，只读复制进运行目录），检查：
//   中文概念搜索「加剧」、英文搜索、词形变化、完整详情（长例句不截断）、按期回看、升级对照、
//   390 CSS 像素列表与详情无横向溢出、浏览不改复习表、精听入口正常。截图和 evidence.json 在运行目录 out 下。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { start, stop } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { openDb, queryRows } from '../../../e2e/db.mjs';

const root = path.resolve('src-tauri/target/e2e');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.join(root, `029-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
const copied = path.join(runDir, 'source-copy');
fs.mkdirSync(out, { recursive: true });
fs.cpSync('D:/tmp/es-import/释义原料', copied, { recursive: true });
fs.copyFileSync('D:/tmp/es-import/学术升级库-20261109.md', path.join(runDir, 'real-upgrade.md'));
fs.copyFileSync('D:/tmp/es-import/词汇复习库-20261109.md', path.join(runDir, 'real-review.md'));

const bundled = path.join(runDir, 'import-preview.mjs');
await build({ entryPoints: ['utils/vocab/import.ts'], bundle: true, format: 'esm', outfile: bundled });
const { buildImportPreview } = await import(pathToFileURL(bundled).href);
const preview = buildImportPreview(
  { fileName: 'real-upgrade.md', content: fs.readFileSync(path.join(runDir, 'real-upgrade.md'), 'utf8') },
  { fileName: 'real-review.md', content: fs.readFileSync(path.join(runDir, 'real-review.md'), 'utf8') },
);
assert.deepEqual(preview.errors, []);

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
const asSource = file => ({ fileName: path.basename(file), content: fs.readFileSync(file, 'utf8') });
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const rows = page => page.evaluate(() => [...document.querySelectorAll('[data-testid=vocab-list] > button')].map(el => ({ kind: el.dataset.kind, text: el.innerText })));
const search = async (page, text) => {
  await page.type('[data-testid=vocab-search]', text);
  await page.waitUntil(`搜索「${text}」出结果`, `document.querySelector('[data-testid=vocab-search]').value === ${JSON.stringify(text)} && !!document.querySelector('[data-testid=vocab-list] > button, [data-testid=vocab-no-result]')`);
};
const clickRow = (page, index) => page.click(`[data-testid=vocab-list] > button:nth-of-type(${index + 1})`);
const tab = (page, label) => page.clickText(label, { selector: 'button[role=tab]', exact: true });
const shot = (page, name, full = true) => page.screenshot(path.join(out, name), { full });

let session;
let page;
let passed = false;
const evidence = { runDir, checks: {} };
try {
  session = await start({ runDir, port: 9466 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.clickText('词库');

  // 1. 隔离导入：真实升级库 + 复习库 + 期笔记释义 + EAGP。
  const imported = await invoke(page, 'vocab_import', { request: preview.input });
  assert.equal(imported.reviewWords.added, 486);
  const issueFiles = fs.readdirSync(path.join(copied, '词汇')).filter(name => /^\d{8}\.md$/.test(name)).sort().map(name => path.join(copied, '词汇', name));
  const definitions = await invoke(page, 'vocab_definition_import', { request: { issues: issueFiles.map(asSource), eagp: asSource(path.join(copied, 'EAGP-词表-文本.md')) } });
  assert.ok(definitions.added > 300);
  note('隔离导入', { upgrades: imported.upgradeEntries.added, reviewWords: imported.reviewWords.added, definitionsAdded: definitions.added, examplesAdded: definitions.examplesAdded });
  let db = await openDb(session);
  const reviewBefore = queryRows(db, 'review_word');
  db.close();

  // 选一个有释义例句、且例句最长的词，用来检查完整详情和长例句。
  const browse = await invoke(page, 'vocab_browse');
  const withExample = browse.reviewWords
    .flatMap(w => (w.definitions ?? []).flatMap(d => d.examples.map(e => ({ word: w.word, sentence: e.sentence }))))
    .sort((a, b) => b.sentence.length - a.sentence.length);
  assert.ok(withExample.length > 0, '真实数据里应有带例句的释义');
  const longest = withExample[0];
  note('长例句样本', longest);

  await page.reload();
  await page.clickText('词库');
  await page.waitFor('[data-testid=vocab-search]');
  await shot(page, '00-landing.png', false);

  // 2. 中文概念搜索「加剧」：第一条是 exacerbate，同时带出 worsen 升级条目。
  await search(page, '加剧');
  let list = await rows(page);
  assert.equal(list[0].kind, 'word');
  assert.match(list[0].text, /^exacerbate/);
  const worsenIndex = list.findIndex(row => row.kind === 'upgrade' && /worsen/.test(row.text));
  assert.ok(worsenIndex > 0, '加剧 应带出 worsen 升级条目');
  await clickRow(page, 0);
  await page.waitFor('[data-testid=word-detail]');
  assert.equal(await page.text('[data-testid=detail-headword]'), 'exacerbate');
  assert.match(await page.text('[data-testid=usage-section]'), /worsen/);
  await shot(page, '01-search-chinese-jiaju.png', false);
  evidence.checks.chinese = { query: '加剧', top: list.slice(0, 3).map(r => r.text.split('\n')[0]) };

  // 3. 从「用法与辨析」跳到整组对照：worsen 的候选 + 用法 + 例句。
  await page.clickText('看整组对照', { selector: 'button', exact: false });
  await page.waitFor('[data-testid=upgrade-detail]');
  assert.equal(await page.text('[data-testid=detail-headword]'), 'worsen');
  const candidates = await page.evaluate(() => [...document.querySelectorAll('[data-testid=upgrade-candidate]')].map(el => el.innerText));
  assert.equal(candidates.length, 2);
  assert.match(candidates[0], /deteriorate[\s\S]*首选[\s\S]*不及物/);
  assert.match(candidates[1], /exacerbate[\s\S]*及物/);
  await shot(page, '02-upgrade-worsen-detail.png', false);
  evidence.checks.upgradeDetail = { headword: 'worsen', candidates: candidates.map(c => c.split('\n')[0]) };

  // 4. 英文搜索 + 词形变化。
  await search(page, 'exacerbated');
  list = await rows(page);
  assert.match(list[0].text, /^exacerbate/, '词形变化 exacerbated 应找到 exacerbate');
  assert.match(list[0].text, /词形变化/);
  await search(page, longest.word);
  list = await rows(page);
  assert.equal(list[0].text.split('\n')[0].trim(), longest.word, `英文搜索 ${longest.word} 完全相同的词排第一`);
  await clickRow(page, 0);
  await page.waitFor('[data-testid=word-detail]');
  await page.waitFor('[data-testid=definition-example]');
  // 长例句完整显示：文本一字不差，元素没有被截断（scrollHeight 不超过 clientHeight，且不是单行省略）。
  const exampleCheck = await page.evaluate(sentence => {
    const items = [...document.querySelectorAll('[data-testid=definition-example] p')];
    const hit = items.find(el => el.innerText.trim() === sentence.trim());
    if (!hit) return { found: false, texts: items.map(el => el.innerText) };
    const style = getComputedStyle(hit);
    return { found: true, clipped: hit.scrollHeight > hit.clientHeight + 1, ellipsis: style.textOverflow === 'ellipsis', lines: Math.round(hit.clientHeight / parseFloat(style.lineHeight)) };
  }, longest.sentence);
  assert.equal(exampleCheck.found, true, `详情里应有完整例句：${JSON.stringify(exampleCheck)}`);
  assert.equal(exampleCheck.clipped, false);
  assert.equal(exampleCheck.ellipsis, false);
  const sections = await page.evaluate(() => [...document.querySelectorAll('[data-testid=word-detail] .vocab-section-title')].map(el => el.innerText));
  assert.equal(sections[0], '意思', '详情第一节是意思，不是期号等技术字段');
  assert.ok(sections.includes('学习进度'));
  await page.setViewport(1280, 2200, { mobile: false, dpr: 1 });
  await shot(page, '03-word-full-detail.png', false);
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  evidence.checks.wordDetail = { word: longest.word, sections, example: exampleCheck };
  note('英文搜索与完整详情', { word: longest.word, sections, exampleLines: exampleCheck.lines });

  // 5. 按期回看：最新一期在最前并展开。
  await search(page, '');
  await tab(page, '按期回看');
  await page.waitFor('[data-testid=issue-group]');
  const issueHeads = await page.evaluate(() => [...document.querySelectorAll('[data-testid=issue-group] > summary')].map(el => el.innerText.split('\n')[0]));
  assert.match(issueHeads[0], /^10\.20/);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=issue-group]').open), true);
  assert.match(await page.text('[data-testid=vocab-count]'), /共 \d+ 期 486 条/);
  await page.click('[data-testid=issue-group] .vocab-row');
  await page.waitFor('[data-testid=word-detail]');
  await shot(page, '04-issues-view.png', false);
  evidence.checks.issues = { first: issueHeads.slice(0, 5), total: issueHeads.length };

  // 6. 升级对照视图：80 组 + 写作自查。
  await tab(page, '升级对照');
  list = await rows(page);
  assert.equal(list.filter(r => r.kind === 'upgrade').length, imported.upgradeEntries.added);
  assert.ok(list.some(r => r.kind === 'selfCheck'));
  await clickRow(page, 0);
  await page.waitFor('[data-testid=upgrade-detail]');
  await shot(page, '05-upgrades-view.png', false);
  evidence.checks.upgrades = { groups: list.filter(r => r.kind === 'upgrade').length, selfChecks: list.filter(r => r.kind === 'selfCheck').length };

  // 7. 状态筛选：复习中只剩 L1–L4。
  await tab(page, '查词');
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid=status-filter]');
    el.value = 'learning';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitUntil('筛选生效', `/匹配 \\d+ \\/ 共/.test(document.querySelector('[data-testid=vocab-count]').innerText)`);
  list = await rows(page);
  const learningWords = new Set(browse.reviewWords.filter(w => /^L[1-4]$/.test(w.status.trim())).map(w => w.word.trim().toLowerCase()));
  assert.equal(list.length, learningWords.size, '复习中筛选：L1–L4 的词（同词多期合并）');
  assert.ok(list.every(r => /L[1-4]/.test(r.text)));
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid=status-filter]');
    el.value = 'all';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // 8. 390 CSS 像素：列表、详情、返回。
  await page.setViewport(390, 844, { mobile: true, dpr: 2 });
  await search(page, '加剧');
  assert.equal(await noOverflow(page), true, '390 列表无横向溢出');
  await page.evaluate(() => document.querySelector('[data-testid=vocab-search]').scrollIntoView({ block: 'start' }));
  await shot(page, '06-390-list.png', false);
  await clickRow(page, 0);
  await page.waitFor('[data-testid=vocab-back]');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.vocab-list-col')).display), 'none', '窄屏点开详情后列表隐藏');
  assert.equal(await noOverflow(page), true, '390 详情无横向溢出');
  await shot(page, '07-390-detail.png', false);
  await search(page, longest.word);
  await page.click('[data-testid=vocab-back]').catch(() => {});
  await page.waitFor('[data-testid=vocab-list] > button');
  await clickRow(page, 0);
  await page.waitFor('[data-testid=definition-example]');
  assert.equal(await noOverflow(page), true, '390 长例句详情无横向溢出');
  await page.evaluate(() => document.querySelector('[data-testid=definition-example]').scrollIntoView({ block: 'center' }));
  await shot(page, '08-390-long-example.png', false);
  await page.click('[data-testid=vocab-back]');
  await page.waitFor('[data-testid=vocab-list] > button');
  assert.equal(await noOverflow(page), true);
  await search(page, '');
  await tab(page, '按期回看');
  assert.equal(await noOverflow(page), true, '390 按期回看无横向溢出');
  await tab(page, '升级对照');
  await clickRow(page, 0);
  await page.waitFor('[data-testid=upgrade-detail]');
  assert.equal(await noOverflow(page), true, '390 升级详情无横向溢出');
  await shot(page, '09-390-upgrade-detail.png', false);
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  evidence.checks.narrow = { width: 390, horizontalOverflow: false };
  note('窄屏', '390 CSS 像素：列表、详情、长例句、按期、升级详情均无横向溢出');

  // 9. 浏览不改复习表。
  db = await openDb(session);
  assert.deepEqual(queryRows(db, 'review_word'), reviewBefore);
  db.close();
  evidence.checks.reviewRowsUnchanged = true;

  // 10. 精听入口：切到视频页，添加视频的入口还在。
  await page.clickText(['视频', 'Videos']);
  await page.clickText(['添加视频', 'Add video']);
  await page.waitText(['选择本机视频', 'Choose a video on this Mac']);
  await shot(page, '10-listening-entry.png', false);
  note('精听入口', '视频页「添加视频」可打开，「选择本机视频」可见');
  evidence.checks.listening = true;

  const unexpectedErrors = page.errors.filter(error => error !== 'plugin http not found');
  assert.deepEqual(unexpectedErrors, []);
  evidence.screenshots = fs.readdirSync(out).filter(name => name.endsWith('.png')).sort();
  evidence.pageErrors = page.errors;
  evidence.log = log;
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
  note('证据', path.join(out, 'evidence.json'));
  passed = true;
} catch (error) {
  if (page) await page.screenshot(path.join(out, 'failure.png')).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  if (session) await stop(session.runDir);
  note('隔离窗口', passed ? '全部通过后已关闭' : '失败后已关闭');
}
