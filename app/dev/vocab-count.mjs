import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const [upgradePath, reviewPath] = process.argv.slice(2);
if (!upgradePath || !reviewPath) {
  console.error('用法：node dev/vocab-count.mjs <学术升级库.md> <词汇复习库.md>');
  process.exit(1);
}

const out = join(tmpdir(), `vocab-count-${process.pid}.mjs`);
await build({ entryPoints: ['utils/vocab/parse.ts'], bundle: true, format: 'esm', outfile: out });
const { parseUpgradeLibrary, parseReviewLibrary } = await import(pathToFileURL(out).href);
const upgrade = parseUpgradeLibrary(readFileSync(upgradePath, 'utf8'));
const review = parseReviewLibrary(readFileSync(reviewPath, 'utf8'));
const normalize = text => text.trim().toLowerCase().replace(/\s+/g, ' ');
const uniqueWords = new Set(review.words.map(word => normalize(word.word)));
const duplicateWords = [...new Set(
  review.warnings
    .filter(warning => warning.kind === 'duplicate')
    .map(warning => normalize(review.words.find(word => word.line === warning.line)?.word ?? '')),
)];
const ids = [
  ...upgrade.entries.map(entry => entry.id),
  ...upgrade.selfChecks.map(check => check.id),
  ...review.words.map(word => word.id),
];
const allIdsUnique = new Set(ids).size === ids.length;

console.log(`升级库 ${upgrade.entries.length} 条`);
console.log(`自查 ${upgrade.selfChecks.length} 条`);
console.log(`复习库 ${review.words.length} 行`);
console.log(`不同单词（规范化后）${uniqueWords.size} 个`);
console.log(`L1–L4 合计 ${review.words.filter(word => word.level !== null).length} 行`);
console.log(`duplicate 警告 ${review.warnings.filter(warning => warning.kind === 'duplicate').length} 条，覆盖 ${duplicateWords.length} 组词：${duplicateWords.join('、')}`);
console.log(`所有 ID 互不重复：${allIdsUnique ? '是' : '否'}（共 ${ids.length} 个）`);
console.log(`升级库警告 ${upgrade.warnings.length} 条；复习库警告 ${review.warnings.length} 条`);
