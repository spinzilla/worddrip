import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const cache = join(process.cwd(), 'node_modules', '.cache');
const archiveOut = join(cache, `coach-archive-${process.pid}.mjs`);
const parserOut = join(cache, `coach-parser-${process.pid}.mjs`);
mkdirSync(dirname(archiveOut), { recursive: true });
try {
  await build({ entryPoints: ['utils/coach/archive.ts'], bundle: true, format: 'esm', outfile: archiveOut });
  await build({ entryPoints: ['utils/vocab/errors.ts'], bundle: true, format: 'esm', outfile: parserOut });
  const coach = await import(pathToFileURL(archiveOut).href);
  const { parseErrorArchive } = await import(pathToFileURL(parserOut).href);
  const md = readFileSync(new URL('dev/fixtures/vocab/errors.md', import.meta.url), 'utf8');
  const parsed = parseErrorArchive(md);
  const data = coach.buildCoachArchive(parsed);

  assert.deepEqual(data.batches.map(batch => batch.title), [
    '2026-01-04 · 综合测试 · 第 3 次',
    '2026-01-03 · 专项练习 · 第 2 次',
    '2026-01-02 · 雅思 T2 · 第 1 篇',
  ], '批次必须按档案顺序倒序展示');
  assert.deepEqual(data.batches.map(batch => batch.items.length), [1, 0, 1]);
  assert.equal(data.top.length, 1);
  assert.equal(data.todos.length, 2);
  assert.equal(coach.isCoachEmpty(data), false);

  // 四列表头：没有题号，说明来自第四列。
  const standard = data.batches[2].items[0];
  assert.equal(coach.coachItemTitle(standard), '主谓一致');
  assert.deepEqual([standard.written, standard.correction, standard.note], ['notes is', 'notes are', '复数主语']);

  // 五列表头：保留题号，说明列留空，不能把改法错当说明。
  const withQuestion = data.batches[0].items[0];
  assert.equal(coach.coachItemTitle(withQuestion), 'Q1 · 拼写');
  assert.deepEqual([withQuestion.written, withQuestion.correction, withQuestion.note], ['ever day', 'every day', '']);

  // 没有错误项的批次仍保留，不能整批丢掉。
  assert.equal(data.batches[1].title.includes('专项练习'), true);
  assert.deepEqual(data.batches[1].items, []);

  const empty = coach.buildCoachArchive(parseErrorArchive('# 空档案'));
  assert.deepEqual(empty, coach.emptyCoachArchive());
  assert.equal(coach.isCoachEmpty(empty), true);

  const before = JSON.stringify(parsed);
  coach.buildCoachArchive(parsed);
  assert.equal(JSON.stringify(parsed), before, '整理页面数据不能修改解析结果');
  console.log('coach archive: all checks passed');
} finally {
  rmSync(archiveOut, { force: true });
  rmSync(parserOut, { force: true });
}
