/** 068 录入笔记：多页合并、页数上限、缩放、不支持看图判断、并发池。纯函数，不联网。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundled = path.resolve('src-tauri/target/vocab-inbox-tests', `note-import-${process.pid}.mjs`);
fs.mkdirSync(path.dirname(bundled), { recursive: true });
await build({
  entryPoints: ['utils/vocab/noteImport.ts'],
  bundle: true,
  format: 'esm',
  outfile: bundled,
  define: { 'import.meta.env.DEV': 'false' },
  plugins: [{
    name: 'node-tauri-http',
    setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/plugin-http$/ }, args => ({ path: args.path, namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const fetch = (...args) => globalThis.fetch(...args);' }));
    },
  }],
});
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const n = await import(pathToFileURL(bundled).href);

try {
  // 合并去重、备注合并、页码标注
  const merged = n.mergeNotePages([
    { page: 2, words: [{ word: 'Candid', note: '坦率的', uncertain: false }, { word: 'obsolete', note: '过时', uncertain: true }] },
    { page: 1, words: [{ word: 'candid ', note: '例：a candid answer', uncertain: false }, { word: 'alpha', note: '', uncertain: false }] },
    { page: 3, words: [{ word: '  CANDID', note: '坦率的', uncertain: false }, { word: 'obsolete', note: '', uncertain: false }] },
  ]);
  assert.deepEqual(merged.map(item => item.word), ['candid', 'alpha', 'obsolete'], '同词只留一条，按页码先后');
  const candid = merged[0];
  assert.deepEqual(candid.pages, [1, 2, 3]);
  assert.equal(candid.note, '例：a candid answer；坦率的', '备注去重后合并');
  assert.equal(merged[2].uncertain, true, '任一页拿不准就标拿不准');
  assert.deepEqual(merged[2].pages, [2, 3]);
  assert.equal(n.pagesLabel([1, 3]), '第 1、3 页');

  // 增量并入（单页重试）：已有条目的额外字段保留
  const base = [{ word: 'alpha', note: '', uncertain: false, pages: [1], id: 'x', checked: true }];
  const added = n.addPageToMerged(base, 2, [{ word: 'ALPHA', note: '备注', uncertain: false }, { word: 'beta', note: '', uncertain: false }], item => ({ ...item, id: 'y', checked: true }));
  assert.equal(added.length, 2);
  assert.equal(added[0].id, 'x');
  assert.deepEqual(added[0].pages, [1, 2]);
  assert.equal(added[0].note, '备注');
  assert.equal(base[0].note, '', '不改传入数组');

  // 页数上限 20
  assert.equal(n.NOTE_MAX_PAGES, 20);
  assert.equal(n.checkPageLimit(0, 20), '');
  assert.match(n.checkPageLimit(18, 3), /最多识别 20 页.*分批/);
  assert.match(n.checkPageLimit(0, 21), /分批/);

  // 缩放：长边 ≤ 2000，比例保持；不放大
  for (const [w, h] of [[4000, 3000], [3000, 4000], [2000, 1500], [800, 600], [12000, 1]]) {
    const out = n.fitLongEdge(w, h);
    assert.ok(Math.max(out.width, out.height) <= 2000, `${w}x${h} -> ${out.width}x${out.height}`);
    assert.ok(out.width >= 1 && out.height >= 1);
  }
  assert.deepEqual(n.fitLongEdge(4000, 3000), { width: 2000, height: 1500 });
  assert.deepEqual(n.fitLongEdge(800, 600), { width: 800, height: 600 });

  // 文件类型与大小
  const limit = 20 * 1024 * 1024;
  assert.equal(n.noteFileKind({ name: 'a.PDF', size: 1, type: '' }), 'pdf');
  assert.equal(n.noteFileKind({ name: 'a.heic', size: 1, type: '' }), 'heic');
  assert.equal(n.noteFileKind({ name: 'a.txt', size: 1, type: 'text/plain' }), null);
  assert.equal(n.validateNoteFile({ name: 'a.jpg', size: limit, type: 'image/jpeg' }, limit), '');
  assert.match(n.validateNoteFile({ name: 'a.jpg', size: limit + 1, type: 'image/jpeg' }, limit), /20 MB/);
  assert.match(n.validateNoteFile({ name: 'a.txt', size: 1, type: 'text/plain' }, limit), /不是/);
  assert.match(n.validateNoteFile({ name: 'a.png', size: 0, type: 'image/png' }, limit), /空文件/);

  // 模型不支持看图
  assert.equal(n.isVisionUnsupportedError('视觉模型返回 HTTP 400：unknown field image_url。请检查模型名称'), true);
  assert.equal(n.isVisionUnsupportedError('视觉模型返回 HTTP 415：unsupported media'), true);
  assert.equal(n.isVisionUnsupportedError('this model does not support Vision input'), true);
  assert.equal(n.isVisionUnsupportedError('视觉模型返回 HTTP 401：invalid key'), false);
  assert.equal(n.isVisionUnsupportedError('识别超时，请检查网络后重试。'), false);
  assert.match(n.VISION_UNSUPPORTED_TEXT, /当前模型可能不支持看图/);

  // 拿不准超过一半 / 某页零词 → 提醒
  const w = (word, uncertain) => ({ word, note: '', uncertain });
  const ok = [{ page: 1, words: [w('a', false), w('b', false)] }];
  assert.equal(n.shouldWarnUnclear(n.mergeNotePages(ok), ok), false);
  const half = [{ page: 1, words: [w('a', true), w('b', false)] }];
  assert.equal(n.shouldWarnUnclear(n.mergeNotePages(half), half), false, '正好一半不提醒');
  const most = [{ page: 1, words: [w('a', true), w('b', true), w('c', false)] }];
  assert.equal(n.shouldWarnUnclear(n.mergeNotePages(most), most), true);
  const empty = [{ page: 1, words: [w('a', false)] }, { page: 2, words: [] }];
  assert.equal(n.shouldWarnUnclear(n.mergeNotePages(empty), empty), true, '某页一个词都没认出');
  assert.equal(n.shouldWarnUnclear([], []), false);

  // 并发池：最多 2 个同时，取消后不再开新的
  let running = 0;
  let peak = 0;
  const done = [];
  await n.runPool([1, 2, 3, 4, 5, 6], 2, async item => {
    running += 1; peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, 15));
    running -= 1; done.push(item);
  });
  assert.equal(peak, 2);
  assert.equal(done.length, 6);
  const signal = { aborted: false };
  const started = [];
  await n.runPool([1, 2, 3, 4, 5, 6], 2, async item => {
    started.push(item);
    if (item === 2) signal.aborted = true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }, signal);
  assert.ok(started.length < 6, `取消后不再开新页，实际开了 ${started.length}`);
  console.log('录入笔记单元测试通过：合并去重/页码/备注、20 页上限、2000px 缩放、不支持看图判断、不清晰提醒、并发池与取消。');
} finally {
  fs.rmSync(bundled, { force: true });
}
