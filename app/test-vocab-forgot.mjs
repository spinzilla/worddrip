// 036「忘记了」：判定和写回请求必须和答错完全一样；不请求模型，不看写了什么。
// 用法（在 app 目录）：node test-vocab-forgot.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundled = path.resolve('src-tauri/target/vocab-recall-tests', `forgot-${process.pid}.mjs`);
fs.mkdirSync(path.dirname(bundled), { recursive: true });
await build({
  stdin: {
    contents: [
      "export * from './utils/vocab/recall.ts';",
      "export * from './utils/vocab/evaluate.ts';",
    ].join('\n'),
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
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const fetch = () => { throw new Error("测试里不应发请求"); };' }));
    },
  }],
});
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) };
const m = await import(pathToFileURL(bundled).href);
fs.rmSync(bundled, { force: true });

const def = (english, examples = []) => [{ sourceFile: 'a.md', sourceLine: 1, pos: 'v.', english, chinese: '', examples }];
const word = (id, text, definitions) => ({ id, word: text, definitions });

// ---- 回忆填空题（程序判） ----
const allocated = m.exampleQuestion(word('allocate@10.20', 'allocate', def('to give something to a person for a purpose', [
  { seq: 1, sentence: 'The council allocated funds to the new library project.', ai: false },
])));
assert.ok(allocated, '现成例句能出题');
assert.equal(allocated.kind, 'recall');
assert.equal(allocated.selfCheck, false);

const neverCalled = async () => { throw new Error('点了「忘记了」不应请求模型判分'); };

// 1. 「忘记了」= 答错：correct 是 false（不是 null 待定，也不是跳过）
const forgot = await m.evaluateAnswer(allocated, '', { modelOn: true, forgot: true, grader: neverCalled });
assert.equal(forgot.correct, false, '忘记了按答错计');
assert.equal(forgot.grade.kind, 'forgot');
assert.equal(forgot.grade.expected, 'allocated', '给出语境句需要的词形，供提交后显示答案');
assert.match(forgot.grade.reason, /忘记了/);
assert.equal(m.VERDICT_LABEL.forgot, '忘记了（按答错计）');

// 2. 就算输入框里已经写了正确答案，点了「忘记了」也按答错计：不能借它反悔又拿分
const forgotButTyped = await m.evaluateAnswer(allocated, 'allocated', { modelOn: false, forgot: true });
assert.equal(forgotButTyped.correct, false, '点了忘记了，写了什么都不看');
assert.equal(forgotButTyped.grade.kind, 'forgot');
// 对照：不点「忘记了」时同样的答案判对，说明是 forgot 这个开关起的作用
assert.equal((await m.evaluateAnswer(allocated, 'allocated', { modelOn: false })).correct, true);

// 3. 写回请求和答错一字不差：同一个 id、同一个 kind（recall）、correct = false
const wrong = await m.evaluateAnswer(allocated, 'distribute', { modelOn: false });
assert.equal(wrong.correct, false);
const forgotRequest = m.submitRequest(allocated, forgot);
const wrongRequest = m.submitRequest(allocated, wrong);
assert.deepEqual(forgotRequest, { id: 'allocate@10.20', kind: 'recall', correct: false });
assert.deepEqual(forgotRequest, wrongRequest, '忘记了的写回请求必须和答错相同');
// 答对、待定的对照
assert.deepEqual(m.submitRequest(allocated, { correct: true }), { id: 'allocate@10.20', kind: 'recall', correct: true });
assert.equal(m.submitRequest(allocated, { correct: null }), null, '笔误/自评没定之前不能写回');

// 4. 造句/改写题（本来要模型判或自评）：点「忘记了」不请求模型、不进自评，直接答错；kind 保持原题型
const sentenceQuestion = {
  ...allocated,
  wordId: 'take part in something today@10.20',
  target: 'take part in something today',
  answers: ['take part in something today'],
  kind: 'sentence',
  selfCheck: true,
};
const forgotSentence = await m.evaluateAnswer(sentenceQuestion, 'I will take part', { modelOn: true, forgot: true, grader: neverCalled });
assert.equal(forgotSentence.correct, false);
assert.equal(forgotSentence.grade.kind, 'forgot');
assert.equal(forgotSentence.grade.expected, 'take part in something today', '句型题显示目标表达');
assert.deepEqual(m.submitRequest(sentenceQuestion, forgotSentence), { id: sentenceQuestion.wordId, kind: 'sentence', correct: false });
const manual = await m.evaluateAnswer(sentenceQuestion, 'I will take part', { modelOn: false });
assert.equal(manual.correct, null, '对照：不点忘记了、没配模型时是待自评');

// 5. forgotEvaluation 单独调用结果一致（复检里用它）
assert.deepEqual(m.forgotEvaluation(allocated), forgot);

console.log('test-vocab-forgot：全部通过');
