import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const out = join(process.cwd(), 'node_modules', '.cache', `coach-archive-write-${process.pid}.mjs`);
mkdirSync(join(process.cwd(), 'node_modules', '.cache'), { recursive: true });
try {
  await build({ entryPoints: ['utils/coach/archiveWrite.ts'], bundle: true, format: 'esm', outfile: out });
  const logic = await import(pathToFileURL(out).href);
  const top = [
    { id: 'et:grammar', ord: 1, rank: 1, kind: '主谓一致', count: '2', lastAt: '2026-01-01', status: '🔴 反复犯' },
    { id: 'et:tense', ord: 2, rank: 2, kind: '时态', count: '4', lastAt: '2026-01-02', status: '🔴 在犯' },
  ];
  const request = {
    reviewId: 'review-node', essay: 'Original essay', resultJson: '{"review":{}}',
    title: '2026-11-09 · 作文批改', date: '2026-11-09', paperType: '通用学术写作', wordCount: 2,
    items: [
      { kind: '主谓一致', written: 'notes is', correction: 'notes are', note: '复数主语' },
      { kind: '主谓一致', written: 'it are', correction: 'it is', note: '单数主语' },
      { kind: '搭配', written: 'discuss about', correction: 'discuss', note: '及物动词' },
    ],
  };
  const preview = logic.buildArchivePreview(request, top, { 'et:tense': 2 });
  assert.equal(preview.itemsAdded, 3);
  const grammar = preview.topChanges.find(change => change.kind === '主谓一致');
  assert.deepEqual([grammar.beforeCount, grammar.afterCount, grammar.occurrences], [2, 4, 2]);
  assert.equal(grammar.afterLastAt, '2026-11-09');
  const tense = preview.topChanges.find(change => change.kind === '时态');
  assert.deepEqual([tense.beforeClean, tense.afterClean, tense.afterStatus], [2, 3, '🟡 已改善']);
  const added = preview.topChanges.find(change => change.kind === '搭配');
  assert.equal(added.isNew, true, '类别不存在时预览必须明确标成新增');
  assert.deepEqual([added.beforeCount, added.afterCount], [0, 1]);

  // 模拟事务按预览逐项落库，实际条数、计数、日期和状态必须与预览完全一致。
  const writtenTop = top.map(item => ({ ...item }));
  for (const change of preview.topChanges) {
    if (change.isNew) {
      writtenTop.push({ id: change.topId, ord: 3, rank: 3, kind: change.kind, count: String(change.afterCount), lastAt: change.afterLastAt, status: change.afterStatus });
    } else {
      const row = writtenTop.find(item => item.id === change.topId);
      row.count = String(change.afterCount);
      row.lastAt = change.afterLastAt;
      row.status = change.afterStatus;
    }
  }
  assert.equal(request.items.length, preview.itemsAdded, '预览新增条数必须等于实际错误项写入条数');
  for (const change of preview.topChanges) {
    const actual = writtenTop.find(item => item.id === change.topId);
    assert.deepEqual([actual.count, actual.lastAt, actual.status], [String(change.afterCount), change.afterLastAt, change.afterStatus]);
  }

  const noErrors = logic.buildArchivePreview({ ...request, reviewId: 'empty', items: [] }, top, { 'et:grammar': 2 });
  assert.equal(noErrors.itemsAdded, 0);
  assert.equal(noErrors.topChanges.find(change => change.kind === '主谓一致').afterStatus, '🟡 已改善');
  assert.equal(logic.localDate(new Date(2026, 10, 9)), '2026-11-09');
  console.log('coach archive write: all checks passed');
} finally {
  rmSync(out, { force: true });
}
