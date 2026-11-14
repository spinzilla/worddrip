// 047 首考前预习：逐词状态、看释义不可逆、写回参数只给看过的词加 previewed。
// 用法（在 app 目录）：node test-vocab-first-preview.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundled = path.resolve('src-tauri/target/vocab-recall-tests', `first-preview-${process.pid}.mjs`);
fs.mkdirSync(path.dirname(bundled), { recursive: true });
await build({
  stdin: {
    contents: [
      "export * from './utils/vocab/firstTestPreview.ts';",
      "export * from './utils/vocab/evaluate.ts';",
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  outfile: bundled,
  logLevel: 'silent',
});
const m = await import(pathToFileURL(bundled).href);
fs.rmSync(bundled, { force: true });

const initial = m.initialFirstTestPreview();
assert.equal(initial.index, 0);
assert.equal(initial.revealed, false);
assert.deepEqual([...initial.previewed], []);

const firstSeen = m.revealFirstTestDefinition(initial, 'a@8.25');
assert.deepEqual([...firstSeen.previewed], ['a@8.25']);
assert.equal(firstSeen.revealed, true);
assert.deepEqual([...initial.previewed], [], '不改旧状态');
assert.equal(m.revealFirstTestDefinition(firstSeen, 'a@8.25'), firstSeen, '重复看同一个词不重复记录');

const second = m.advanceFirstTestPreview(firstSeen);
assert.equal(second.index, 1);
assert.equal(second.revealed, false);
assert.deepEqual([...second.previewed], ['a@8.25'], '到下一个词也不能撤销已看释义');
const third = m.advanceFirstTestPreview(second);
assert.deepEqual([...third.previewed], ['a@8.25'], '直接下一个不算看过');
const thirdSeen = m.revealFirstTestDefinition(third, 'c@8.25');
assert.deepEqual([...thirdSeen.previewed], ['a@8.25', 'c@8.25']);
assert.deepEqual([...second.previewed], ['a@8.25'], '跳过预习时只保留实际看过的词');

const question = { wordId: 'a@8.25', kind: 'recall' };
assert.deepEqual(m.submitRequest(question, { correct: true }), {
  id: 'a@8.25', kind: 'recall', correct: true,
}, '没传 previewed 时请求和旧版完全相同');
assert.deepEqual(m.submitRequest(question, { correct: false }, false), {
  id: 'a@8.25', kind: 'recall', correct: false,
}, '没看释义不多传字段');
assert.deepEqual(m.submitRequest(question, { correct: true }, true), {
  id: 'a@8.25', kind: 'recall', correct: true, previewed: true,
});
assert.equal(m.submitRequest(question, { correct: null }, true), null, '判定没完成仍不能保存');

console.log('首考前预习测试通过：逐词前进、看过不可撤销、跳过保留已看词、提交参数兼容旧版。');
