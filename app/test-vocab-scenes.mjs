// 048 例句场景标注：提示词只含词、句子和标签说明；返回解析（列表外标签、格式错时那句不标）；句子规范化；一个词一次请求。
// 用法（在 app 目录）：node test-vocab-scenes.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundled = path.resolve('src-tauri/target/vocab-recall-tests', `scenes-${process.pid}.mjs`);
fs.mkdirSync(path.dirname(bundled), { recursive: true });
await build({
  stdin: {
    contents: "export * from './utils/vocab/scenes.ts';",
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

const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key),
};
const m = await import(pathToFileURL(bundled).href);
fs.rmSync(bundled, { force: true });

// ---------------------------------------------------------------- 10 个固定标签
assert.deepEqual(m.SCENES.map(s => s.id), ['definition', 'statement', 'evidence', 'explanation', 'cause-effect', 'comparison', 'concession', 'evaluation', 'recommendation', 'summary']);
assert.ok(m.SCENES.every(s => s.zh && s.hint));
assert.equal(m.sceneTitle('comparison'), 'comparison · 比较和对比');
assert.equal(m.isSceneId('summary'), true);
assert.equal(m.isSceneId('Summary'), false);
assert.equal(m.isSceneId('other'), false);

// ---------------------------------------------------------------- 规范化（和后端 scene_key 同一规则）
assert.equal(m.sceneKey('  The  Students’ work\n was “good”. '), 'the students\' work was "good".');
assert.equal(m.sceneKey('It’s fine.'), m.sceneKey("it's   FINE."));
assert.notEqual(m.sceneKey('It is fine.'), m.sceneKey('It is fine'));
assert.deepEqual(m.uniqueSentences(['A  cat sat.', 'a cat sat.', '  ', 'Another one.']), ['A cat sat.', 'Another one.']);

// ---------------------------------------------------------------- 提示词：只有词、句子、标签说明
const NOTE = '复习备注：别和 aggravate 搞混（私人）';
const sentences = ['Island economies must become more resilient.', 'Our team stayed resilient.'];
const prompt = m.buildScenePrompt('  resilient ', sentences);
assert.match(prompt, /Target expression: "resilient"/);
for (const s of sentences) assert.ok(prompt.includes(JSON.stringify(s)), `提示词含句子：${s}`);
for (const s of m.SCENES) assert.ok(prompt.includes(`- ${s.id}: ${s.hint}`), `提示词含标签说明：${s.id}`);
assert.match(prompt, /\{"scenes":\[\{"id":1,"scene":"<one allowed label>"\}\]\}/);
for (const secret of [NOTE, '备注', '笔记', 'note', '有韧性']) assert.equal(prompt.toLowerCase().includes(secret.toLowerCase()), false, `提示词不含「${secret}」`);
assert.equal(/[一-鿿]/.test(prompt), false, '提示词里没有中文（中文释义、备注都不会发出去）');

// ---------------------------------------------------------------- 解析
const three = ['S one.', 'S two.', 'S three.'];
const ok = m.parseSceneLabels(JSON.stringify({ scenes: [{ id: 1, scene: 'comparison' }, { id: 3, scene: 'summary' }, { id: 2, scene: 'evidence' }] }), three);
assert.deepEqual(ok, [{ sentence: 'S one.', scene: 'comparison' }, { sentence: 'S two.', scene: 'evidence' }, { sentence: 'S three.', scene: 'summary' }]);
// 代码块也认。
assert.equal(m.parseSceneLabels('```json\n{"scenes":[{"id":1,"scene":"definition"}]}\n```', three).length, 1);
// 列表外标签、大小写不对、编号不存在、编号重复、类型错：那一句就当没标。
const messy = m.parseSceneLabels(JSON.stringify({ scenes: [
  { id: 1, scene: 'Comparison' }, { id: 2, scene: 'nonsense' }, { id: 9, scene: 'summary' }, { id: '3', scene: 'summary' },
  { id: 3, scene: 'evaluation' }, { id: 3, scene: 'summary' }, null, 'x', { id: 1.5, scene: 'summary' }, { id: 0, scene: 'summary' },
] }), three);
assert.deepEqual(messy, [{ sentence: 'S three.', scene: 'evaluation' }], '只留下合格的，重复编号取第一个有效的');
// 一句都没标好也不报错，返回空。
assert.deepEqual(m.parseSceneLabels('{"scenes":[]}', three), []);
// 整体格式错：抛中文错误。
for (const bad of ['not json', '[]', '{"scenes":"x"}', '{}', 'null', 'Here is the result: {"scenes":[]}']) {
  assert.throws(() => m.parseSceneLabels(bad, three), /模型返回格式不正确/, bad);
}

// ---------------------------------------------------------------- 请求：一个词一次，只发句子，不发笔记
const bodies = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    bodies.push(JSON.parse(raw));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scenes: [{ id: 1, scene: 'comparison' }, { id: 2, scene: 'bogus' }] }) } }] }));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const KEY = 'dummy-e2e-key-048-must-not-leak';
storage.set('linguaclip_ai_config', JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: KEY, model: 'fake-048', temperature: 0.7 }));
try {
  // 没配模型：抛中文错误，不发请求。
  const saved = new Map(storage);
  storage.clear();
  await assert.rejects(() => m.requestSceneLabels('resilient', sentences), /尚未配置模型/);
  assert.equal(bodies.length, 0);
  for (const [k, v] of saved) storage.set(k, v);
  const labels = await m.requestSceneLabels('resilient', ['A  b.', 'a b.', 'C d.']);
  assert.equal(bodies.length, 1, '同一个词的所有句子只发一次请求');
  assert.deepEqual(labels, [{ sentence: 'A b.', scene: 'comparison' }], '重复句只发一次；列表外标签不标');
  const sent = JSON.stringify(bodies[0]);
  assert.ok(sent.includes('A b.') && sent.includes('C d.'));
  assert.equal(sent.includes('备注') || sent.includes('笔记'), false);
  assert.equal(await m.requestSceneLabels('resilient', ['  ']).then(x => x.length), 0, '没有句子就不请求');
  assert.equal(bodies.length, 1);
} finally {
  server.close();
}

console.log('test-vocab-scenes: ok');
