import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const out = join(tmpdir(), `vocab-parse-${process.pid}.mjs`);
await build({ entryPoints: ['utils/vocab/parse.ts'], bundle: true, format: 'esm', outfile: out });
const { parseUpgradeLibrary, parseReviewLibrary } = await import(pathToFileURL(out).href);
const fixture = name => readFileSync(new URL(`dev/fixtures/vocab/${name}`, import.meta.url), 'utf8');

// 真实摘录：字段、原文、行号、多段例句和 AI 标记。
const upgradeMd = fixture('upgrade.md');
const upgrade = parseUpgradeLibrary(upgradeMd);
assert.equal(upgrade.entries.length, 3);
assert.equal(upgrade.selfChecks.length, 1);
assert.deepEqual(upgrade.warnings.map(warning => [warning.line, warning.kind]), [[7, 'columns']]);

const comprise = upgrade.entries[0];
assert.equal(comprise.id, 'up:be made up of#1');
assert.equal(comprise.line, 4);
assert.equal(comprise.raw, upgradeMd.split('\n')[3]);
assert.equal(comprise.plain, 'be made up of');
assert.equal(comprise.upgrade, 'comprise（不接 of）/ consist of / be composed of');
assert.equal(comprise.source, 'AWL SL7');
assert.equal(comprise.note, '9.18 期');
assert.equal(comprise.examples.length, 3);
assert.deepEqual(comprise.examples[0], {
  cand: 'comprise',
  sentence: 'The committee comprises five departments.',
  ai: true,
});
assert.equal(comprise.examples[1].cand, 'consist of');
assert.equal(comprise.examples[2].cand, 'be composed of');
assert.equal(comprise.examples.every(example => !example.sentence.includes('(AI)')), true);
assert.deepEqual(upgrade.entries[1].examples[0], {
  cand: 'precise',
  sentence: 'Precise measurements are essential in experimental work.',
  ai: false,
});
assert.equal(upgrade.entries[1].upgrade.includes('**'), false);
assert.deepEqual(upgrade.selfChecks[0], {
  id: 'sc:1',
  line: 10,
  raw: '- concise（简明）↔ verbose（啰嗦）：改稿时删 verbose expression',
  text: 'concise（简明）↔ verbose（啰嗦）：改稿时删 verbose expression',
});

// 真实摘录：重复词照收并报警，— 转为空字符串，L 级转成数字。
const reviewMd = fixture('review.md');
const review = parseReviewLibrary(reviewMd);
assert.equal(review.words.length, 5);
assert.deepEqual(review.warnings.map(warning => [warning.line, warning.kind]), [[8, 'duplicate'], [10, 'columns']]);
assert.deepEqual(review.words[0], {
  id: 'rv:hook@8.25#1',
  line: 5,
  raw: '| hook | 8.25 | 2026-10-14 | 🌱待考察 | — | 钩 → 钓住 → 吸引（9.22 复现新义） |',
  word: 'hook',
  issue: '8.25',
  addedAt: '2026-10-14',
  status: '🌱待考察',
  level: null,
  due: '',
  note: '钩 → 钓住 → 吸引（9.22 复现新义）',
});
assert.deepEqual(review.words.map(word => word.id), [
  'rv:hook@8.25#1',
  'rv:shrink@8.26#1',
  'rv:shatter@9.24#1',
  'rv:shatter@10.20#1',
  'rv:agenda@9.18#1',
]);
assert.equal(review.words[4].level, 4);
assert.equal(review.words[4].status, 'L4');
assert.equal(review.words[4].due, '2026-11-11');
assert.equal(review.words[4].raw, reviewMd.split('\n')[8]);

// 规范化、同键序号、CRLF、逐字 raw、切不开的例句和多列坏行。
const syntheticUpgradeMd = [
  '## 词汇升级',
  '| 日常/口语 | 学术升级 | 例句 | 出处 | 备注 |',
  '|---|---|---|---|---|',
  '  |  Foo   BAR  | **Baz** | broken example (AI) | Src |  |  ',
  '| foo bar | **Qux** | still broken | | |',
  '| extra | columns | are | not | silently | accepted |',
  '## 写作自查对照',
  '- one',
  '- two',
].join('\r\n');
const syntheticUpgrade = parseUpgradeLibrary(syntheticUpgradeMd);
assert.deepEqual(syntheticUpgrade.entries.map(entry => entry.id), ['up:foo bar#1', 'up:foo bar#2']);
assert.equal(syntheticUpgrade.entries[0].raw, '  |  Foo   BAR  | **Baz** | broken example (AI) | Src |  |  ');
assert.deepEqual(syntheticUpgrade.entries[0].examples, [{ cand: '', sentence: 'broken example', ai: true }]);
assert.deepEqual(syntheticUpgrade.entries[1].examples, [{ cand: '', sentence: 'still broken', ai: false }]);
assert.deepEqual(syntheticUpgrade.selfChecks.map(check => check.id), ['sc:1', 'sc:2']);
assert.deepEqual(syntheticUpgrade.warnings.map(warning => [warning.line, warning.kind]), [
  [4, 'example'],
  [5, 'example'],
  [6, 'columns'],
]);

const reviewRows = rows => [
  '## 总词库',
  '| 单词 | 期号 | 入库日期 | 状态 | 下次到期 | 备注 |',
  '|---|---|---|---|---|---|',
  ...rows,
].join('\n');
const syntheticReview = parseReviewLibrary(reviewRows([
  '|  Foo   BAR  | X | 2026-01-01 | L5 | 2026-02-15 | first |',
  '| foo bar | X | 2026-01-02 | L1 | 2026-01-03 | second |',
  '| too | many | columns | here | yes | no | extra |',
]));
assert.equal(syntheticReview.words.length, 2);
assert.deepEqual(syntheticReview.words.map(word => word.id), ['rv:foo bar@X#1', 'rv:foo bar@X#2']);
assert.equal(syntheticReview.words[0].status, 'L5');
assert.equal(syntheticReview.words[0].level, 5);
assert.equal(syntheticReview.words[1].level, 1);
assert.deepEqual(syntheticReview.warnings.map(warning => [warning.line, warning.kind]), [
  [5, 'duplicate'],
  [6, 'columns'],
]);

for (const [status, level] of [['🌱待考察', null], ['✅已掌握', null], ['🧊冷库', null], ['L1', 1], ['L2', 2], ['L3', 3], ['L4', 4], ['L5', 5], ['L6', 6], ['L7', 7]]) {
  const result = parseReviewLibrary(reviewRows([`| word | X | date | ${status} | — | note |`]));
  assert.equal(result.words[0].level, level);
  assert.equal(result.warnings.length, 0, `${status} 是已知状态`);
}

assert.equal(new Set([
  ...upgrade.entries.map(entry => entry.id),
  ...upgrade.selfChecks.map(check => check.id),
  ...review.words.map(word => word.id),
]).size, 9);

console.log('vocab parse: all checks passed');
