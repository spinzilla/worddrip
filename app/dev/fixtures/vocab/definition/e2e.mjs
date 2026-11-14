// 028 真实窗口验证：释义预览、确认、详情、窄屏和真实只读原料匹配。
// 用法（在 app 目录）：node dev/fixtures/vocab/definition/e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { start, stop } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { chooseFile } from '../../../e2e/dialog.mjs';
import { openDb, queryRows } from '../../../e2e/db.mjs';

const root = path.resolve('src-tauri/target/e2e');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.join(root, `028-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
const copied = path.join(runDir, 'source-copy');
fs.mkdirSync(out, { recursive: true });
fs.cpSync('D:/tmp/es-import/释义原料', copied, { recursive: true });
fs.copyFileSync('D:/tmp/es-import/学术升级库-20261109.md', path.join(runDir, 'real-upgrade.md'));
fs.copyFileSync('D:/tmp/es-import/词汇复习库-20261109.md', path.join(runDir, 'real-review.md'));

const issuePath = path.join(runDir, '20261020.md');
const eagpPath = path.join(runDir, 'EAGP-test.md');
fs.writeFileSync(issuePath, `## 词单分析
1. **alpha** n. — the first letter of the Greek alphabet（希腊字母首字母）；*Alpha begins the example sentence.* (AI)
2. **unknown** n. — not found in the review library（未匹配）
`, 'utf8');
fs.writeFileSync(eagpPath, `eagponly — a word supplied by the fallback list (n)
alpha — a fallback definition that must not replace the issue (n)
`, 'utf8');
const upgrade = `## 词汇升级
| 日常/口语 | 学术升级 | 例句 | 出处 | 备注 |
|---|---|---|---|---|
| dummy | **dummy** | dummy: This is a dummy example. | 测试 | 保留 |

## 写作自查对照
- dummy check
`;
const review = `# 词汇总词库
## 总词库
| 单词 | 期号 | 入库日期 | 状态 | 下次到期 | 备注 |
|---|---|---|---|---|---|
| alpha | 10.20 | 2026-11-01 | L2 | 2026-11-09 | alpha note |
| eagponly | EAGP | 2026-11-01 | L1 | 2026-11-09 | fallback note |
`;
const bundled = path.join(runDir, 'import-preview.mjs');
await build({ entryPoints: ['utils/vocab/import.ts'], bundle: true, format: 'esm', outfile: bundled });
const { buildImportPreview } = await import(pathToFileURL(bundled).href);
const initialPreview = buildImportPreview(
  { fileName: 'upgrade.md', content: upgrade },
  { fileName: 'review.md', content: review },
);
assert.deepEqual(initialPreview.errors, []);

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
const count = async (page, label) => page.evaluate(name =>
  Number(document.querySelector(`[data-definition-count="${name}"]`).lastElementChild.textContent.trim()), label);
const openReviews = async page => {
  await page.clickText('浏览', { selector: 'button[role=tab]', exact: true });
  await page.clickText('查词', { selector: 'button[role=tab]', exact: true });
  await page.waitFor('[data-testid=vocab-list]');
};
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const asSource = file => ({ fileName: path.basename(file), content: fs.readFileSync(file, 'utf8') });

let session;
let page;
let passed = false;
try {
  session = await start({ runDir, port: 9464 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.clickText('词库');
  const imported = await invoke(page, 'vocab_import', { request: initialPreview.input });
  assert.equal(imported.reviewWords.added, 2);
  let db = await openDb(session);
  const reviewBefore = queryRows(db, 'review_word');
  db.close();

  await page.reload();
  await page.clickText('词库');
  await page.clickText('导入', { selector: 'button[role=tab]', exact: true });
  await page.click('[data-testid=definition-choose-issues]');
  await chooseFile(session, issuePath);
  await page.waitFor('[data-testid=definition-preview-result]');
  assert.equal(await count(page, '匹配'), 1);
  assert.equal(await count(page, '未匹配'), 1);
  await page.click('[data-testid=definition-choose-eagp]');
  await chooseFile(session, eagpPath);
  await page.waitUntil('EAGP 预览完成', () => document.querySelector('[data-definition-count="匹配"]')?.lastElementChild.textContent.trim() === '3');
  assert.equal(await count(page, '跳过'), 1);
  assert.equal(await count(page, '将写入释义'), 2);
  assert.equal(await count(page, '将写入例句'), 1);
  await page.screenshot(path.join(out, '01-definition-preview.png'));

  const request = { issues: [asSource(issuePath)], eagp: asSource(eagpPath) };
  await page.click('[data-testid=definition-confirm]');
  await page.waitFor('[data-testid=definition-import-result]');
  db = await openDb(session);
  const reviewAfter = queryRows(db, 'review_word');
  assert.deepEqual(reviewAfter, reviewBefore);
  assert.equal(queryRows(db, 'review_definition').length, 2);
  assert.equal(queryRows(db, 'review_definition_example').length, 1);
  db.close();
  const repeated = await invoke(page, 'vocab_definition_import', { request });
  assert.equal(repeated.added, 0);
  assert.equal(repeated.examplesAdded, 0);
  db = await openDb(session);
  assert.equal(queryRows(db, 'review_definition').length, 2);
  assert.equal(queryRows(db, 'review_definition_example').length, 1);
  db.close();
  note('隔离导入', { matched: 3, added: 2, repeatedSkipped: repeated.skipped, reviewRowsUnchanged: true });

  await openReviews(page);
  await page.clickText('alpha', { selector: '[data-testid=vocab-list] > button', exact: false });
  await page.waitFor('[data-testid=review-definitions]');
  assert.equal(await page.text('[data-testid=definition-pos]'), 'n.');
  assert.match(await page.text('[data-testid=review-definitions]'), /the first letter of the Greek alphabet/);
  assert.match(await page.text('[data-testid=definition-example]'), /Alpha begins the example sentence/);
  assert.match(await page.text('[data-testid=definition-example]'), /AI 草稿/);
  await page.evaluate(() => document.querySelector('[data-testid=review-definitions]').scrollIntoView({ block: 'start' }));
  await page.screenshot(path.join(out, '02-alpha-definition-detail.png'), { full: false });
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  assert.equal(await noOverflow(page), true);
  await page.evaluate(() => document.querySelector('[data-testid=review-definitions]').scrollIntoView({ block: 'start' }));
  await page.screenshot(path.join(out, '03-alpha-definition-390.png'), { full: false });
  note('详情与窄屏', '词性、英英释义、中文、AI 例句均可见；390 CSS 像素无横向溢出');

  const realPreview = buildImportPreview(
    { fileName: 'real-upgrade.md', content: fs.readFileSync(path.join(runDir, 'real-upgrade.md'), 'utf8') },
    { fileName: 'real-review.md', content: fs.readFileSync(path.join(runDir, 'real-review.md'), 'utf8') },
  );
  assert.deepEqual(realPreview.errors, []);
  const realReviewOnly = {
    ...realPreview.input,
    entries: [{ id: 'up:real-seed', line: 1, raw: '| real seed | real seed |', plain: 'real seed', upgrade: 'real seed', source: '测试', note: '' }],
    examples: [],
    selfChecks: [],
  };
  const realMain = await invoke(page, 'vocab_import', { request: realReviewOnly });
  assert.equal(realMain.reviewWords.added, 486);
  const issueFiles = fs.readdirSync(path.join(copied, '词汇'))
    .filter(name => /^\d{8}\.md$/.test(name))
    .sort()
    .map(name => path.join(copied, '词汇', name));
  const realRequest = {
    issues: issueFiles.map(asSource),
    eagp: asSource(path.join(copied, 'EAGP-词表-文本.md')),
  };
  const realPreviewReport = await invoke(page, 'vocab_definition_preview', { request: realRequest });
  const realReport = await invoke(page, 'vocab_definition_import', { request: realRequest });
  assert.deepEqual(realReport, realPreviewReport);
  assert.ok(realReport.matched > 0);
  assert.equal(realReport.added + realReport.skipped, realReport.matched);
  assert.equal(realReport.unmatched, realReport.unmatchedItems.length);
  note('真实原料', {
    files: issueFiles.length,
    matched: realReport.matched,
    added: realReport.added,
    skipped: realReport.skipped,
    unmatched: realReport.unmatched,
    unmatchedSamples: realReport.unmatchedItems.slice(0, 5),
  });

  const unexpectedErrors = page.errors.filter(error => error !== 'plugin http not found');
  assert.deepEqual(unexpectedErrors, []);
  const evidence = {
    runDir,
    screenshots: fs.readdirSync(out).filter(name => name.endsWith('.png')).sort(),
    fixture: { matched: 3, added: 2, repeated, reviewRowsUnchanged: true },
    real: realReport,
    realIssueFiles: issueFiles.length,
    narrowViewport: { width: 390, horizontalOverflow: false },
    pageErrors: page.errors,
    unexpectedErrors,
    log,
  };
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
