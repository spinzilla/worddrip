// 024 真实窗口验证：隔离导入、复习写回、主库保护预览和结果。
// 用法（在 app 目录）：node dev/fixtures/vocab/import-protection/e2e.mjs
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { start, stop } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { chooseFile } from '../../../e2e/dialog.mjs';
import { openDb, queryRows, countRows } from '../../../e2e/db.mjs';

const root = path.resolve('src-tauri/target/e2e');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.join(root, `024-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });

const upgrade = `## 词汇升级
| 日常/口语 | 学术升级 | 例句 | 出处 | 备注 |
|---|---|---|---|---|
| dummy | **dummy** | dummy: This is a dummy example. | 测试 | 保留 |

## 写作自查对照
- dummy check
`;
const review = (rows) => `# 词汇总词库
## 总词库
| 单词 | 期号 | 入库日期 | 状态 | 下次到期 | 备注 |
|---|---|---|---|---|---|
${rows.join('\n')}
`;
const initialReview = review([
  '| alpha | 1 | 2026-11-01 | L1 | 2026-11-09 | alpha reviewed |',
  '| beta | 1 | 2026-11-01 | 🌱待考察 | — | beta untouched |',
]);
const changedReview = review([
  '| alpha | 1 | 2026-11-01 | 🌱待考察 | — | stale file |',
  '| beta | 1 | 2026-11-01 | L3 | 2026-11-20 | unreviewed update |',
  '| gamma | 1 | 2026-11-01 | L1 | 2026-11-09 | new row |',
]);
const initialUpgradePath = path.join(runDir, 'initial-upgrade.md');
const initialReviewPath = path.join(runDir, 'initial-review.md');
const changedUpgradePath = path.join(runDir, 'changed-upgrade.md');
const changedReviewPath = path.join(runDir, 'changed-review.md');
fs.writeFileSync(initialUpgradePath, upgrade, 'utf8');
fs.writeFileSync(initialReviewPath, initialReview, 'utf8');
fs.writeFileSync(changedUpgradePath, upgrade, 'utf8');
fs.writeFileSync(changedReviewPath, changedReview, 'utf8');

const bundled = path.join(runDir, 'import-preview.mjs');
await build({ entryPoints: ['utils/vocab/import.ts'], bundle: true, format: 'esm', outfile: bundled });
const { buildImportPreview } = await import(pathToFileURL(bundled).href);
const initial = buildImportPreview(
  { fileName: 'initial-upgrade.md', content: upgrade },
  { fileName: 'initial-review.md', content: initialReview },
);
const changed = buildImportPreview(
  { fileName: 'changed-upgrade.md', content: upgrade },
  { fileName: 'changed-review.md', content: changedReview },
);
assert.deepEqual(initial.errors, []);
assert.deepEqual(changed.errors, []);

const log = [];
const note = (key, value) => { const line = `${key}: ${value}`; log.push(line); console.log(line); };
const invoke = async (page, command, args = {}) => {
  const outcome = await page.evaluate(async (cmd, payload) => {
    try { return { value: await window.__TAURI_INTERNALS__.invoke(cmd, payload) }; }
    catch (error) { return { error: typeof error === 'string' ? error : String(error) }; }
  }, command, args);
  if (outcome.error) throw new Error(`${command} 失败：${outcome.error}`);
  return outcome.value;
};
const previewCounts = page => page.evaluate(() => Object.fromEntries(
  [...document.querySelectorAll('[data-testid=review-preview-counts] [data-count]')]
    .map(element => [element.dataset.count, element.querySelector('.text-xl').innerText]),
));

let s;
let page;
let passed = false;
try {
  s = await start({ runDir });
  page = await connect({ port: s.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.clickText('词库', { timeout: 60000 });

  const first = await invoke(page, 'vocab_import', { request: initial.input });
  assert.equal(first.reviewWords.added, 2);
  const reviewedId = initial.input.reviewWords[0].id;
  const submitted = await invoke(page, 'vocab_review_submit', {
    request: { id: reviewedId, kind: 'recall', correct: true },
  });
  assert.equal(submitted.changed, true);
  note('初始导入并复习', `${reviewedId} -> ${submitted.status}`);

  await page.reload();
  await page.clickText('词库');
  await page.clickText('导入', { selector: 'button[role=tab]' });
  await page.waitText('开始在软件里复习后，这里是主库');
  await page.clickText('选择文件');
  await chooseFile(s, changedUpgradePath);
  await page.waitText('重新选择');
  await page.clickText('选择文件');
  await chooseFile(s, changedReviewPath);
  await page.waitUntil('主库对比出现', `document.querySelector('[data-testid=review-preview-counts] [data-count=新增] .text-xl')?.innerText === '1'`);
  const expected = { 新增: '1', 更新: '1', 跳过: '1', 冲突: '0' };
  assert.deepEqual(await previewCounts(page), expected);
  await page.screenshot(path.join(out, '01-preview.png'));
  await page.setViewport(390, 844);
  await page.evaluate(() => document.querySelector('[data-testid=review-preview-counts]').scrollIntoView({ block: 'center' }));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.screenshot(path.join(out, '02-preview-390.png'));
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  note('预览四计数', JSON.stringify(expected));

  await page.clickText('确认导入当前预览');
  await page.waitFor('[data-testid=review-import-result]');
  const resultText = await page.text('[data-testid=review-import-result]');
  assert.equal(resultText.includes('新增 1，更新 1，跳过 1，冲突 0'), true);
  assert.ok((await page.text('body')).includes('已复习的词以软件为准'), '导入成功说明要写清复习状态以软件为准');
  await page.screenshot(path.join(out, '03-result.png'));

  const db = await openDb(s);
  const rows = queryRows(db, 'review_word').sort((a, b) => Number(a.ord) - Number(b.ord));
  const logs = countRows(db, 'review_log');
  const runs = countRows(db, 'import_run');
  db.close();
  const alpha = rows.find(row => row.id === reviewedId);
  const beta = rows.find(row => row.word === 'beta');
  const gamma = rows.find(row => row.word === 'gamma');
  assert.equal(rows.length, 3);
  assert.equal(alpha.status, submitted.status);
  assert.equal(alpha.level, submitted.level);
  assert.equal(alpha.due, submitted.due);
  assert.equal(alpha.note, 'alpha reviewed');
  assert.equal(beta.status, 'L3');
  assert.equal(beta.level, 3);
  assert.equal(beta.due, '2026-11-20');
  assert.equal(beta.note, 'unreviewed update');
  assert.equal(gamma.note, 'new row');
  assert.equal(logs, 1);
  assert.equal(runs, 4, '预览不写日志，两次正式导入各写两条');
  note('数据库复核', '已复习 alpha 保留软件状态；未复习 beta 更新；gamma 新增');

  const unexpectedErrors = page.errors.filter(error => error !== 'plugin http not found');
  assert.deepEqual(unexpectedErrors, []);
  const evidence = {
    runDir, reviewedId, submitted, previewCounts: expected, resultText,
    reviewWords: rows, reviewLogs: logs, importRuns: runs,
    screenshots: fs.readdirSync(out).filter(name => name.endsWith('.png')).sort(),
    pageErrors: page.errors, unexpectedErrors, log,
  };
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
  note('证据', path.join(out, 'evidence.json'));
  passed = true;
} catch (error) {
  if (page) await page.screenshot(path.join(out, 'failure.png')).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  if (s) await stop(s.runDir);
  note('隔离窗口', passed ? '全部通过后已关闭' : '失败后已关闭');
}
