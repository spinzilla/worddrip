// 049 按场景找词：两种来源的例句去重和计数、按场景筛选、补标只挑没标的句子（手动不进请求）、
// 高亮、补标分批与停止（已标的保留、没标的不标、失败不中断）。
// 用法（在 app 目录）：node test-vocab-scene-browse.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundled = path.resolve('src-tauri/target/vocab-recall-tests', `scene-browse-${process.pid}.mjs`);
fs.mkdirSync(path.dirname(bundled), { recursive: true });
await build({
  stdin: {
    contents: "export * from './utils/vocab/sceneBrowse.ts';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  outfile: bundled,
  logLevel: 'silent',
  define: { 'import.meta.env.DEV': 'false' },
  plugins: [{
    name: 'node-tauri-http',
    setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/plugin-http$/ }, args => ({ path: args.path, namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const fetch = (...args) => globalThis.fetch(...args);' }));
    },
  }],
});
const m = await import(pathToFileURL(bundled).href);
fs.rmSync(bundled, { force: true });

// ---------------------------------------------------------------- 假数据
const def = (examples) => ({ sourceFile: 'a.md', sourceLine: 1, pos: 'v.', english: 'e', chinese: '中', examples: examples.map((sentence, i) => ({ seq: i + 1, sentence, ai: false })) });
const data = {
  upgrades: [],
  selfChecks: [],
  reviewWords: [
    { id: 'exacerbate@1', word: 'exacerbate', issue: '10.20', definitions: [def(['Prices  rise, and the crisis will  exacerbate it.', 'Policy could exacerbate the shortage.'])] },
    { id: 'mitigate@1', word: 'Mitigate', issue: '10.21', definitions: [def(['Measures mitigate the effects.'])] },
  ],
};
const examples = [
  { id: 1, wordKey: 'exacerbate', word: 'exacerbate', sentence: 'Policy could  exacerbate the shortage.', source: '自己写' },
  { id: 2, wordKey: 'exacerbate', word: 'exacerbate', sentence: 'Students often exacerbate the problem.', source: '自己写' },
];

// ---------------------------------------------------------------- 行：两种来源、同句去重
const rows = m.buildSceneRows(data, examples);
// 词库 3 句 + 我的例句 2 句；其中 "Policy could  exacerbate…" 和词库那句只差空白，去重后只留词库那条。
assert.equal(rows.length, 4, '去重后 4 句');
assert.deepEqual(rows.map(r => r.from), ['词库', '词库', '词库', '我的例句'], '来源标得出来，重复句保留词库来源');
assert.equal(rows[3].sentence, 'Students often exacerbate the problem.');
assert.ok(rows.some(r => r.sentence === 'Prices rise, and the crisis will exacerbate it.'), '句子空白被合并');
assert.equal(rows.find(r => r.word === 'Mitigate').wordKey, 'w:mitigate', '词键和词库分组一致（大小写不影响）');

// ---------------------------------------------------------------- 标签 map：2 句 comparison（1 句是手动）、1 句 summary（AI）
const scenes = new Map([
  ['prices rise, and the crisis will exacerbate it.', { key: 'prices rise, and the crisis will exacerbate it.', sentence: 'x', scene: 'comparison', source: 'AI', updatedAt: 't' }],
  ['policy could exacerbate the shortage.', { key: 'policy could exacerbate the shortage.', sentence: 'x', scene: 'comparison', source: '手动', updatedAt: 't' }],
  ['measures mitigate the effects.', { key: 'measures mitigate the effects.', sentence: 'x', scene: 'summary', source: 'AI', updatedAt: 't' }],
]);
const counts = m.countByScene(rows, scenes);
assert.equal(counts.comparison, 2, '比较和对比：2 句');
assert.equal(counts.summary, 1);
assert.equal(counts.definition, undefined, '没有的场景不计数');
assert.equal(m.labelledCount(rows, scenes), 3);

const compared = m.rowsForScene(rows, scenes, 'comparison');
assert.deepEqual(compared.map(r => r.sentence), [
  'Policy could exacerbate the shortage.',
  'Prices rise, and the crisis will exacerbate it.',
], '按场景筛选：两句，手动标的和 AI 标的都算');
assert.equal(m.rowsForScene(rows, scenes, 'concession').length, 0, '没有的场景是空列表');

// ---------------------------------------------------------------- 补标分组：只挑没标的句子，一词一组
const groups = m.backfillGroups(rows, scenes);
assert.equal(groups.length, 1, '只有 exacerbate 有没标的句子（Mitigate 那句已标）');
assert.equal(groups[0].word, 'exacerbate');
assert.deepEqual(groups[0].sentences, ['Students often exacerbate the problem.']);
assert.equal(groups[0].sentences.some(s => s.includes('shortage')), false, '手动标过的句子不进补标请求');

// ---------------------------------------------------------------- 高亮
assert.deepEqual(m.sentenceParts('Students often exacerbate the problem.', 'exacerbate'), [
  { text: 'Students often ', hit: false }, { text: 'exacerbate', hit: true }, { text: ' the problem.', hit: false },
]);
assert.deepEqual(m.sentenceParts('Students often exacerbated it.', 'exacerbate'), [
  { text: 'Students often ', hit: false }, { text: 'exacerbated', hit: true }, { text: ' it.', hit: false },
], '变形也高亮');
assert.deepEqual(m.sentenceParts('Nothing here.', 'exacerbate'), [{ text: 'Nothing here.', hit: false }]);

// ---------------------------------------------------------------- 补标循环：正常跑完
{
  const saved = [];
  const progress = [];
  const out = await m.runBackfill(
    [{ word: 'a', sentences: ['A one.'] }, { word: 'b', sentences: ['B one.', 'B two.'] }],
    {
      request: async (word, sentences) => sentences.map(sentence => ({ sentence, scene: 'summary' })),
      save: async labels => { saved.push(...labels.map(l => l.sentence)); },
      stopRequested: () => false,
      onProgress: p => progress.push(p.done),
    },
  );
  assert.equal(out.stopped, false);
  assert.equal(out.labelled, 3);
  assert.equal(out.failed, 0);
  assert.deepEqual(saved, ['A one.', 'B one.', 'B two.']);
  assert.deepEqual(progress, [1, 2]);
}

// ---------------------------------------------------------------- 补标：中途停止，已标的保留，没标的不请求
{
  const requested = [];
  let stop = false;
  const out = await m.runBackfill(
    [{ word: 'a', sentences: ['A one.'] }, { word: 'b', sentences: ['B one.'] }, { word: 'c', sentences: ['C one.'] }, { word: 'd', sentences: ['D one.'] }],
    {
      request: async (word, sentences) => {
        requested.push(word);
        stop = true; // 第一个词请求完成后按了停止
        return sentences.map(sentence => ({ sentence, scene: 'definition' }));
      },
      save: async () => {},
      stopRequested: () => stop,
      onProgress: () => {},
    },
  );
  assert.equal(out.stopped, true);
  assert.deepEqual(requested, ['a'], '停止后不再开新的请求');
  assert.equal(out.labelled, 1, '已标的算数（已经保存）');
  assert.equal(out.done, 1, '只处理了一个词');
}

// ---------------------------------------------------------------- 补标：某个词失败，记一笔，继续下一个
{
  const out = await m.runBackfill(
    [{ word: 'a', sentences: ['A one.'] }, { word: 'b', sentences: ['B one.'] }],
    {
      request: async (word, sentences) => {
        if (word === 'a') throw new Error('连接模型失败，请检查网络、接口地址和密钥后重试。');
        return sentences.map(sentence => ({ sentence, scene: 'definition' }));
      },
      save: async () => {},
      stopRequested: () => false,
      onProgress: () => {},
    },
  );
  assert.equal(out.failed, 1);
  assert.equal(out.labelled, 1, '失败的那个词不标，下一个照常');
  assert.equal(out.done, 2);
  assert.match(out.lastError, /连接模型失败/);
  assert.equal(out.stopped, false);
}

console.log('test-vocab-scene-browse: ok');
