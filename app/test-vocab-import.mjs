import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const out = join(tmpdir(), `vocab-import-${process.pid}.mjs`);
await build({ entryPoints: ['utils/vocab/import.ts'], bundle: true, format: 'esm', outfile: out });
const { buildImportPreview, createImportGate } = await import(pathToFileURL(out).href);
const fixture = name => readFileSync(new URL(`dev/fixtures/vocab/import/${name}`, import.meta.url), 'utf8');
const source = (fileName, content) => ({ fileName, content });
const validUpgrade = () => source('upgrade.md', fixture('upgrade.md'));
const validReview = () => source('review.md', fixture('review.md'));

// 合法 fixture：重复词只警告，预览记录数、例句展开和来源快照完整。
const preview = buildImportPreview(validUpgrade(), validReview());
assert.deepEqual(preview.errors, []);
assert.deepEqual(preview.counts, {
  upgradeEntries: 3,
  upgradeExamples: 5,
  selfChecks: 1,
  reviewWords: 5,
});
assert.equal(preview.reviewCounts, null, '主库对比由只读后端预览补齐');
assert.equal(preview.input.examples[0].entryId, 'up:be made up of#1');
assert.equal(preview.input.examples[0].seq, 1);
assert.equal(preview.input.examples[2].seq, 3);
assert.equal(preview.input.reviewWords.filter(word => word.word === 'shatter').length, 2);
assert.equal(preview.warnings.review.some(warning => warning.kind === 'duplicate'), true);
assert.equal(preview.input.upgrade.content, fixture('upgrade.md'));

// 空输入、章节/表头缺失、主表为空都在确认前阻断。
const empty = buildImportPreview(source('empty.md', ''), source('empty.md', ''));
assert.equal(empty.errors.length >= 6, true);
assert.equal(empty.input.entries.length, 0);
assert.equal(empty.input.reviewWords.length, 0);
const missingSection = validReview();
missingSection.content = missingSection.content.replace('## 总词库', '## 别的章节');
assert.equal(buildImportPreview(validUpgrade(), missingSection).errors.some(error => error.includes('总词库')), true);
const missingHeader = validUpgrade();
missingHeader.content = missingHeader.content.replace('| 日常/口语', '| 别的表头');
assert.equal(buildImportPreview(missingHeader, validReview()).errors.some(error => error.includes('表头')), true);
const emptyMain = validReview();
emptyMain.content = emptyMain.content.split('\n').slice(0, 4).join('\n');
assert.equal(buildImportPreview(validUpgrade(), emptyMain).errors.some(error => error.includes('主表没有有效记录')), true);

// 坏列和未知状态阻断；无法拆分的例句保留原文且只警告。
const badColumns = validReview();
badColumns.content += '| bad | only | columns |\n';
const badColumnsPreview = buildImportPreview(validUpgrade(), badColumns);
assert.equal(badColumnsPreview.errors.some(error => error.includes('第 10 行') && error.includes('6 列')), true);
const badStatus = validReview();
badStatus.content = badStatus.content.replace('🌱待考察', 'L9');
const badStatusPreview = buildImportPreview(validUpgrade(), badStatus);
assert.equal(badStatusPreview.errors.some(error => error.includes('未知状态')), true);
const brokenExample = validUpgrade();
brokenExample.content = brokenExample.content.replace('precise: Precise measurements are essential in experimental work.', 'Precise measurements are essential in experimental work.');
const brokenPreview = buildImportPreview(brokenExample, validReview());
assert.deepEqual(brokenPreview.errors, []);
assert.equal(brokenPreview.warnings.upgrade.some(warning => warning.kind === 'example'), true);
assert.equal(brokenPreview.input.examples.some(example => example.sentence === 'Precise measurements are essential in experimental work.' && example.cand === ''), true);

// 内容快照不随后续源对象改写变化；重新选择立即使旧 token 失效。
const mutableUpgrade = validUpgrade();
const snapshot = buildImportPreview(mutableUpgrade, validReview());
mutableUpgrade.content = '';
mutableUpgrade.fileName = 'changed.md';
assert.equal(snapshot.input.upgrade.content, fixture('upgrade.md'));
assert.equal(snapshot.input.upgrade.fileName, 'upgrade.md');
const gate = createImportGate();
assert.equal(gate.isCurrent(0), true, '页面首次统计可以上屏');
const oldSelection = gate.nextSelection();
assert.equal(gate.isCurrent(0), false, '新选择后首次统计不得覆盖新状态');
const currentSelection = gate.nextSelection();
assert.equal(gate.isCurrent(oldSelection), false);
assert.equal(gate.isCurrent(currentSelection), true);

// 同步 beginImport 防住同一事件的重复点击；旧导入完成后不能清掉新导入的锁。
assert.equal(gate.beginImport(currentSelection), true);
assert.equal(gate.beginImport(currentSelection), false);
const newerSelection = gate.nextSelection();
assert.equal(gate.beginImport(newerSelection), false);
gate.finishImport(oldSelection);
assert.equal(gate.beginImport(newerSelection), false);
gate.finishImport(currentSelection);
assert.equal(gate.beginImport(newerSelection), true);
gate.finishImport(newerSelection);
gate.invalidate();
assert.equal(gate.isCurrent(newerSelection), false);
assert.equal(gate.beginImport(newerSelection), false);

console.log('vocab import: all checks passed');
