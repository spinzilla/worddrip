import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// 临时打包文件放在仓库内，避免测试改动系统临时目录。
const out = join(process.cwd(), 'node_modules', '.cache', `vocab-errors-${process.pid}.mjs`);
mkdirSync(dirname(out), { recursive: true });
await build({ entryPoints: ['utils/vocab/errors.ts'], bundle: true, format: 'esm', outfile: out });
const { parseErrorArchive } = await import(pathToFileURL(out).href);
const fixture = name => readFileSync(new URL(`dev/fixtures/vocab/${name}`, import.meta.url), 'utf8');

const sampleMd = fixture('errors.md');
const sample = parseErrorArchive(sampleMd);
assert.deepEqual([sample.top.length, sample.batches.length, sample.items.length, sample.todos.length, sample.essays.length], [1, 3, 2, 2, 1]);
assert.deepEqual(sample.warnings.map(warning => [warning.line, warning.kind]), [[7, 'columns']]);
assert.ok(!sample.batches.some(batch => batch.title.includes('YYYY-MM-DD')), 'HTML 注释里的模板不能算批次');
assert.ok(!sample.items.some(item => item.kind === '模板'), 'HTML 注释里的模板不能算错误项');

assert.equal(sample.top[0].id, 'et:1');
assert.equal(sample.top[0].line, 6);
assert.equal(sample.top[0].raw, sampleMd.split('\n')[5]);
assert.equal(sample.batches[0].id, 'eb:2026-01-02');
assert.equal(sample.batches[0].line, 16);
assert.equal(sample.batches[0].metadata['词数'], '250');
assert.ok(sample.batches[0].raw.startsWith('### 2026-01-02'));
assert.ok(sample.batches[0].raw.includes('| 主谓一致 | notes is | notes are | 复数主语 |'));
assert.ok(!sample.batches[0].raw.includes('2026-01-03'), '批次原文不能吞掉下一批');
const commentLines = sampleMd.split('\n');
const firstBatchLine = commentLines.findIndex(line => line.startsWith('### 2026-01-02'));
commentLines.splice(firstBatchLine + 1, 0, '<!-- hidden note -->');
const withBatchComment = parseErrorArchive(commentLines.join('\n'));
assert.equal(withBatchComment.batches[0].raw.split('\n')[1], '<!-- hidden note -->', '批次内注释必须逐字保留');
assert.equal(sample.items[0].batchId, sample.batches[0].id);
assert.equal(sample.items[0].question, '');
assert.equal(sample.items[0].note, '复数主语');
assert.equal(sample.items[0].line, 21);
assert.equal(sample.items[0].raw, sampleMd.split('\n')[20]);
assert.equal(sample.items.filter(item => item.batchId === sample.batches[1].id).length, 0, '没有错误表也是合法批次');
assert.equal(sample.items[1].question, 'Q1');
assert.equal(sample.items[1].kind, '拼写');
assert.equal(sample.items[1].written, 'ever day');
assert.equal(sample.items[1].correction, 'every day');
assert.equal(sample.items[1].note, '');
assert.equal(sample.todos[0].done, false);
assert.equal(sample.todos[1].done, true);
assert.equal(sample.todos[1].line, 35);
assert.equal(sample.essays[0].wordCount, '250');
assert.deepEqual(sample.items.map(item => item.ord), [1, 2]);
assert.deepEqual(parseErrorArchive(sampleMd), sample, '同一原文重复解析必须得到相同稳定 ID 和顺序');

const realPath = process.env.ES_ERRORS_MD;
if (realPath) {
  const beforeBytes = readFileSync(realPath);
  const beforeHash = createHash('sha256').update(beforeBytes).digest('hex');
  const realMd = beforeBytes.toString('utf8');
  const real = parseErrorArchive(realMd);
  const counts = { top: 15, batches: 8, items: 61, todos: 7, essays: 3 };
  for (const [key, expected] of Object.entries(counts)) {
    assert.equal(real[key].length, expected, `真实文件 ${key} 条数`);
  }
  assert.deepEqual(real.warnings, [], '真实文件不应产生解析警告');
  const realLines = realMd.split(/\r\n|\n|\r/);
  for (const record of [...real.top, ...real.items, ...real.todos, ...real.essays]) {
    assert.equal(record.raw, realLines[record.line - 1], `第 ${record.line} 行原文必须逐字保留`);
  }
  for (const batch of real.batches) {
    const rawLines = batch.raw.split('\n');
    const expected = realLines.slice(batch.line - 1, batch.line - 1 + rawLines.length).join('\n').trimEnd();
    assert.equal(batch.raw, expected, `第 ${batch.line} 行开始的批次原文必须逐字保留`);
  }
  assert.equal(real.items.filter(item => item.batchId === real.batches[2].id).length, 0);
  assert.equal(real.items.filter(item => item.batchId === real.batches[3].id).length, 0);
  const afterHash = createHash('sha256').update(readFileSync(realPath)).digest('hex');
  assert.equal(afterHash, beforeHash, '测试不能修改外部真实文件');
  console.log(`top=${real.top.length} batches=${real.batches.length} items=${real.items.length} todos=${real.todos.length} essays=${real.essays.length}`);
}

rmSync(out, { force: true });
console.log('vocab errors parse: all checks passed');