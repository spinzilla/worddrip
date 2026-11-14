// 038 改写与造句题：出题选型（比例、上限、没配模型退回）、改写/造句题生成与校验、防泄题、判分解析和失败退路。
// 真实出题/判分代码 + 本机假 OpenAI 兼容服务，不调用真实模型。
// 用法（在 app 目录）：node test-vocab-usage.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundled = path.resolve('src-tauri/target/vocab-recall-tests', `usage-${process.pid}.mjs`);
fs.mkdirSync(path.dirname(bundled), { recursive: true });
await build({
  stdin: {
    contents: [
      "export * from './utils/vocab/recall.ts';",
      "export * from './utils/vocab/recallModel.ts';",
      "export * from './utils/vocab/grading.ts';",
      "export * from './utils/vocab/gradingModel.ts';",
      "export * from './utils/vocab/evaluate.ts';",
      "export { FIRST_TEST_LIMIT } from './utils/vocab/firstTest.ts';",
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
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const fetch = (...args) => globalThis.fetch(...args);' }));
    },
  }],
});

const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
};
const m = await import(pathToFileURL(bundled).href);
fs.rmSync(bundled, { force: true });

const KEY = 'dummy-key-038-must-not-leak';
const def = (english, examples = [], pos = 'v.') => [{ sourceFile: 'a.md', sourceLine: 1, pos, english, chinese: '', examples }];
const word = (id, text, definitions) => ({ id, word: text, definitions });

// 8 个到期词：都有现成例句（填空不必调模型），都能出改写/造句。
const BANK = [
  ['exacerbate', 'to make a problem or situation worse', 'Without more investment, the policy could exacerbate the housing shortage in big cities.'],
  ['mitigate', 'to make something bad less severe', 'Governments introduced new measures to mitigate the effects of rising food prices.'],
  ['comprise', 'to consist of particular parts', 'The degree course comprises six core modules and two optional modules.'],
  ['allocate', 'to give something officially for a purpose', 'The council will allocate extra funds to the new library project next year.'],
  ['undermine', 'to make something weaker gradually', 'Constant criticism can undermine the confidence of young researchers in a lab.'],
  ['sustain', 'to keep something going over time', 'Few small farms can sustain such high costs for more than a year.'],
  ['facilitate', 'to make an action or process easier', 'Online tools can facilitate communication between students and their supervisors.'],
  ['assess', 'to judge the quality or importance of something', 'Teachers assess the essays according to clear and public criteria every term.'],
];
const queue = BANK.map(([text, english, sentence]) => word(`${text}@10.20`, text, def(english, [{ seq: 1, sentence, ai: false }])));

/** 假改写/造句出题：按请求的题型给合格草稿。 */
const goodDraft = request => request.format === 'paraphrase'
  ? {
    id: request.id, format: 'paraphrase',
    instruction: `Rewrite the sentence using a formal verb meaning "${request.english}".`,
    original: 'Excessive energy consumption makes air pollution much worse in large industrial cities.',
    reference: `Excessive energy consumption can [[${request.word}]] air pollution in large industrial cities.`,
  }
  : {
    id: request.id, format: 'compose',
    instruction: `Write one sentence using ${request.word} to describe a group project in a university course. Use "the team" as the subject.`,
    original: '',
    reference: `The team needs to [[${request.word}]] the plan before the final presentation.`,
  };
const usageCalls = [];
const fakeUsage = async requests => { usageCalls.push(requests); return requests.map(goodDraft); };
const fillCalls = [];
const fakeFill = async requests => { fillCalls.push(requests); return []; };

// ---------------------------------------------------------------- 1. 选型：比例与上限
assert.deepEqual([0, 1, 2, 3, 4, 5, 7, 8].map(m.usageCount), [0, 0, 1, 1, 2, 2, 3, 4], '约一半是改写/造句，只有 1 题时不出');
assert.deepEqual(m.pickUsageSlots(8, 4), [[1, 'paraphrase'], [3, 'compose'], [5, 'paraphrase'], [7, 'compose']], '均匀分布、改写造句交替');
assert.deepEqual(m.pickUsageSlots(7, 3).map(([, f]) => f), ['paraphrase', 'compose', 'paraphrase']);
assert.equal(m.pickUsageSlots(2, 4).length, 2, '能出的词不够就少出');
assert.deepEqual(m.pickUsageSlots(0, 4), []);
assert.equal(m.usageEligible(word('p', 'It is X that …', def('cleft'))), false, '句型本来就是写整句，不再出改写/造句');
assert.equal(m.usageEligible(word('n', 'resilient', [])), false, '没有英文释义不出');
assert.equal(m.usageEligible(word('ph', 'in the light of', def('considering'))), true, '短语可以出');

const mixed = await m.prepareRecallRound(queue, { generate: fakeFill, generateUsage: fakeUsage, mix: true });
assert.equal(mixed.questions.length, 8, '复习每轮 ≤ 8 题，不因混题变多');
assert.equal(fillCalls.length, 0, '有现成例句的词不请求填空出题');
assert.equal(usageCalls.length, 1, '改写/造句一次批量请求');
assert.deepEqual(usageCalls[0].map(r => [r.word, r.format]), [
  ['mitigate', 'paraphrase'], ['allocate', 'compose'], ['sustain', 'paraphrase'], ['assess', 'compose'],
]);
assert.deepEqual(Object.keys(usageCalls[0][0]).sort(), ['chinese', 'english', 'format', 'id', 'pos', 'word'], '只发词、词性、释义，不发复习备注');
assert.deepEqual(mixed.questions.map(q => q.format), ['fill', 'paraphrase', 'fill', 'compose', 'fill', 'paraphrase', 'fill', 'compose']);
assert.deepEqual(mixed.questions.map(q => q.kind), ['recall', 'rewrite', 'recall', 'sentence', 'recall', 'rewrite', 'recall', 'sentence'], '改写记 rewrite、造句记 sentence');
const productive = q => ['fill', 'paraphrase', 'compose'].includes(q.format);
assert.ok(mixed.questions.filter(productive).length / mixed.questions.length >= 0.6, '产出题 ≥ 60%（三种都是产出题）');
const screens = m.splitScreens(mixed.questions);
for (const screen of screens) assert.ok(screen.length <= m.SCREEN_LIMIT, '每屏 ≤ 5 题');
assert.deepEqual(screens.map(s => s.map(q => q.format)), [
  ['fill', 'paraphrase', 'fill', 'compose'], ['fill', 'paraphrase', 'fill', 'compose'],
], '每屏都混着几种题');
assert.deepEqual(mixed.notices, [], '一切正常时没有提示');
for (const q of mixed.questions) {
  assert.deepEqual(m.questionLeaks(q), [], `${q.target} 题面不泄题`);
  if (q.task) {
    assert.equal(q.selfCheck, true, '改写/造句交给模型判');
    assert.equal(q.context, null);
    assert.equal(q.task.reference.includes('[['), false, '参考答案去掉了标记');
  }
}
const paraQ = mixed.questions[1];
assert.equal(paraQ.target, 'mitigate');
assert.equal(m.visibleText(paraQ).some(text => m.findLeaks(text, 'mitigate').length > 0), false, '改写题面不出现目标词');
assert.equal(paraQ.hint, 'm_______', '改写题给首字母提示，免得写成近义词');
const compQ = mixed.questions[3];
assert.equal(compQ.target, 'allocate');
assert.match(compQ.task.instruction, /allocate/, '造句题面必须给出目标词');
assert.equal(compQ.hint, '');
assert.deepEqual(m.crossLeaks(mixed.questions), [], '同一轮里没有题目露出别的题的答案');
assert.notEqual(m.surfaceOf(paraQ), m.surfaceOf(m.exampleQuestion(queue[1])), '改写题面和填空题面不同');

// 新词首考：每次 7 题，混题后仍然 7 题
const first = await m.prepareRecallRound(queue, { generate: fakeFill, generateUsage: fakeUsage, mix: true, limit: m.FIRST_TEST_LIMIT, noun: '新词' });
assert.equal(first.questions.length, 7, '首考每次 7 题');
assert.deepEqual(first.questions.map(q => q.format).filter(f => f !== 'fill'), ['paraphrase', 'compose', 'paraphrase'], '7 题里 3 道改写/造句');
assert.equal(first.remaining, 1);

// ---------------------------------------------------------------- 2. 没配模型 → 只出填空 + 说明
usageCalls.length = 0;
const offline = await m.prepareRecallRound(queue, { generate: null, generateUsage: null, mix: true });
assert.equal(offline.questions.length, 8);
assert.deepEqual([...new Set(offline.questions.map(q => q.format))], ['fill'], '没配模型时只有填空题');
assert.ok(offline.notices.includes(m.USAGE_NO_MODEL), '说明为什么没有改写/造句');
assert.match(m.USAGE_NO_MODEL, /没配置模型.*改写、造句/);
// 不要求混题（复检、老调用方）：不出、也不提示
const recheck = await m.prepareRecallRound([queue[1]], { generate: fakeFill, generateUsage: fakeUsage, mix: false, requireContext: true, limit: 1 });
assert.equal(recheck.questions[0].format, 'fill', '复检只出填空');
assert.equal(recheck.notices.includes(m.USAGE_NO_MODEL), false);
const legacy = await m.prepareRecallRound(queue, { generate: fakeFill });
assert.deepEqual([...new Set(legacy.questions.map(q => q.format))], ['fill'], '不传 mix 的调用方行为不变');
assert.equal(usageCalls.length, 0, '以上都不请求改写/造句');

// ---------------------------------------------------------------- 3. 改写/造句草稿校验
const mitigate = queue[1];
const allocate = queue[3];
const draftFor = (w, f, patch = {}) => m.usageFromDraft(w, f, { ...goodDraft({ id: w.id, word: w.word, format: f, english: 'x' }), ...patch });
assert.equal(typeof draftFor(mitigate, 'paraphrase'), 'object');
assert.equal(typeof draftFor(allocate, 'compose'), 'object');
const rejects = [
  [mitigate, 'paraphrase', { format: 'compose' }, /题型/],
  [mitigate, 'paraphrase', { original: 'Planting trees can mitigate the flood damage in river towns.' }, /原句或要求里出现了目标词/],
  [mitigate, 'paraphrase', { original: 'Planting trees can reduce the damage that mitigation projects miss.' }, /原句或要求里出现了目标词或同族词/],
  [mitigate, 'paraphrase', { instruction: 'Rewrite the sentence using "mitigate".' }, /原句或要求里出现了目标词/],
  [mitigate, 'paraphrase', { original: 'Trees help.' }, /太短/],
  [mitigate, 'paraphrase', { original: '' }, /没给原句/],
  [mitigate, 'paraphrase', { reference: 'Planting trees can reduce the damage.' }, /恰好一个/],
  [mitigate, 'paraphrase', { reference: 'Trees [[reduce]] the damage of floods in towns.' }, /恰好一个/],
  [mitigate, 'paraphrase', { reference: '[[mitigate]] and [[mitigates]] twice' }, /恰好一个/],
  [allocate, 'compose', { instruction: 'Write one sentence about a group project in a university course using the target.' }, /没写出目标词/],
  [allocate, 'compose', { instruction: 'Use allocate in a sentence.' }, /笼统/],
  [allocate, 'compose', { instruction: '' }, /为空/],
  [allocate, 'compose', { reference: '' }, /为空/],
];
for (const [w, f, patch, reason] of rejects) {
  const outcome = draftFor(w, f, patch);
  assert.equal(typeof outcome, 'string', JSON.stringify(patch));
  assert.match(outcome, reason, JSON.stringify(patch));
}
assert.equal(typeof draftFor(mitigate, 'paraphrase', { reference: 'Planting trees [[mitigates]] flood damage in river towns.' }), 'object', '参考答案里目标词变形可以');

// 模型给的草稿不合格 / 漏题 / 整体失败：退回填空题，并如实说明
const partly = await m.prepareRecallRound(queue, {
  generate: fakeFill, mix: true,
  generateUsage: async requests => [
    { ...goodDraft(requests[0]), original: `Planting trees can ${requests[0].word} flood damage in towns.` }, // 原句泄题 → 退回
    goodDraft(requests[1]),
    // 第 3、4 个漏掉
  ],
});
assert.deepEqual(partly.questions.map(q => q.format), ['fill', 'fill', 'fill', 'compose', 'fill', 'fill', 'fill', 'fill']);
assert.ok(partly.notices.some(t => /1 道改写\/造句题没通过/.test(t)));
assert.ok(partly.notices.some(t => /漏了 2 道改写\/造句题/.test(t)));
assert.equal(partly.questions.length, 8, '退回填空，不少题');
const failed = await m.prepareRecallRound(queue, { generate: fakeFill, mix: true, generateUsage: async () => { throw new Error('模型返回格式不正确：测试。'); } });
assert.deepEqual([...new Set(failed.questions.map(q => q.format))], ['fill']);
assert.ok(failed.notices.some(t => /^模型出改写\/造句题失败：模型返回格式不正确/.test(t)));
// 没现成例句的词：填空靠模型语境句；改写/造句失败时就用这道模型语境句（两个请求同时发，不用再等一轮）
const bare = [word('b1', 'resilient', def('able to recover quickly', [], 'adj.')), word('b2', 'candid', def('honest and direct', [], 'adj.'))];
const bareFill = async requests => requests.map(r => ({ id: r.id, meaning: '', sentence: `Most researchers agreed that the report was [[${r.word}]] about the problems it found.` }));
const bareRound = await m.prepareRecallRound(bare, { generate: bareFill, mix: true, generateUsage: async () => { throw new Error('断网'); } });
assert.deepEqual(bareRound.questions.map(q => `${q.format}/${q.source}`), ['fill/model', 'fill/model']);

// ---------------------------------------------------------------- 4. 同一轮互相泄题
const family = [
  word('e1', 'evaluate', def('to judge how good something is', [{ seq: 1, sentence: 'Teachers carefully evaluate every project against the published marking criteria.', ai: false }])),
  word('e2', 'evaluation', def('a judgement of how good something is', [{ seq: 1, sentence: 'The final evaluation of the scheme will be published by the department next spring.', ai: false }], 'n.')),
];
// evaluation 造句题面写出 evaluation，会露出 evaluate 填空的答案（同族词）
const leakyCompose = m.usageFromDraft(family[1], 'compose', goodDraft({ id: 'e2', word: 'evaluation', format: 'compose' }));
const fillE1 = m.exampleQuestion(family[0]);
assert.ok(m.crossLeaks([fillE1, leakyCompose]).some(leak => leak.hidden === 0 && leak.shown === 1), 'evaluation 造句会露出 evaluate 填空的答案');
assert.deepEqual(m.crossLeaks([leakyCompose]), [], '造句题自己写出目标词不算泄题');
// 一轮里：mitigate 造句要求顺带写了 evaluate → 露出第 1 题答案 → 这道造句退回填空，并说明
const crossQueue = [family[0], family[1], queue[0], queue[1]];
const crossRound = await m.prepareRecallRound(crossQueue, {
  generate: fakeFill, mix: true,
  generateUsage: async requests => requests.map(r => (r.id === queue[1].id
    ? { ...goodDraft(r), instruction: 'Write one sentence using mitigate to explain how teachers evaluate risks in a school science lab.' }
    : goodDraft(r))),
});
assert.deepEqual(crossRound.questions.map(q => q.format), ['fill', 'paraphrase', 'fill', 'fill'], 'mitigate 造句露出了 evaluate，退回填空');
assert.ok(crossRound.notices.some(t => /1 道改写\/造句题会让同一轮别的题露出答案/.test(t)));
assert.deepEqual(m.crossLeaks(crossRound.questions), []);

// ---------------------------------------------------------------- 5. 出题提示词与解析
const usagePrompt = m.buildUsagePrompt([m.usageRequest(mitigate, 'paraphrase'), m.usageRequest(allocate, 'compose')]);
assert.match(usagePrompt, /"format": "paraphrase"/);
assert.match(usagePrompt, /"format": "compose"/);
assert.match(usagePrompt, /must NOT contain the target or any word of its family/);
assert.match(usagePrompt, /CONCRETE academic or campus situation/);
assert.match(usagePrompt, /Tasks:/);
assert.equal(usagePrompt.includes('Items:'), false, '和填空出题的提示词分得开（老的假模型按 Items: 认填空出题）');
const parsedTasks = m.parseUsageTasks(JSON.stringify({ tasks: [goodDraft({ id: 'a', word: 'mitigate', format: 'paraphrase', english: 'x' })] }));
assert.equal(parsedTasks[0].format, 'paraphrase');
assert.equal(m.parseUsageTasks('```json\n{"tasks":[]}\n```').length, 0);
for (const bad of ['', 'Sure! {"tasks":[]}', '{"tasks":{}}', '{"tasks":[{"id":"a","format":"compose","instruction":"","reference":"x"}]}', '{"tasks":[{"id":"a","format":"compose","instruction":"x","reference":5}]}']) {
  assert.throws(() => m.parseUsageTasks(bad), /模型返回格式不正确/, bad);
}

// ---------------------------------------------------------------- 6. 判分：提示词、解析、收紧、失败退路
const gp = m.buildGradingPrompt(paraQ, 'Planting trees can mitigate flood damage.');
assert.match(gp, /Task type: paraphrase/);
assert.ok(gp.includes(JSON.stringify(paraQ.task.original)), '判分提示词带原句');
assert.ok(gp.includes(JSON.stringify(paraQ.task.instruction)));
assert.match(gp, /"taskOk"/);
assert.match(gp, /near-synonym/);
assert.match(gp, /grammarFix[\s\S]*Never empty[\s\S]*academicUpgrade[\s\S]*Never empty/);
assert.equal(gp.includes(paraQ.task.reference), false, '参考答案不发给判分模型，免得它照着参考答案判');
const gc = m.buildGradingPrompt(compQ, 'x');
assert.match(gc, /Task type: compose/);
assert.match(gc, /obeys every constraint/);
assert.equal(m.buildGradingPrompt(m.exampleQuestion(queue[0]), 'x').includes('Task type'), false, '句型题提示词不变');

const full = { usedTarget: true, grammarOk: true, taskOk: true, verdict: 'correct', reason: '用法正确。', targetForm: 'mitigate', grammarFix: 'Planting trees can mitigate flood damage.', academicUpgrade: 'Planting trees along riverbanks can mitigate the damage caused by seasonal floods.' };
assert.equal(m.parseGrade(JSON.stringify(full)).taskOk, true);
assert.equal('taskOk' in m.parseGrade(JSON.stringify({ ...full, taskOk: undefined })), false);
assert.throws(() => m.parseGrade(JSON.stringify({ ...full, taskOk: 'yes' })), /格式不正确/);
assert.throws(() => m.requireTaskFields(paraQ, m.parseGrade(JSON.stringify({ ...full, taskOk: undefined }))), /是否完成要求/);
assert.throws(() => m.requireTaskFields(paraQ, { ...full, grammarFix: '' }), /语法修正版/);
assert.throws(() => m.requireTaskFields(compQ, { ...full, academicUpgrade: '' }), /学术升级版/);
assert.equal(m.requireTaskFields(m.exampleQuestion(queue[0]), { ...full, taskOk: undefined, grammarFix: '' }).grammarFix, '', '非改写/造句题不要求');
// 收紧：没用目标词 → 未完成（模型说 correct 也不行）；近义词不算；改写没保留原意 → 错；变形可以
const fin = (q, written, raw) => m.finalizeGrade(q, written, { ...full, ...raw });
assert.equal(fin(paraQ, 'Planting trees can reduce flood damage.', { usedTarget: false, verdict: 'incomplete' }).verdict, 'incomplete');
assert.equal(fin(paraQ, 'Planting trees can reduce flood damage.', { usedTarget: true, verdict: 'correct' }).verdict, 'incomplete', '模型说用了但文字里没有 → 未完成');
assert.equal(fin(paraQ, 'Planting trees mitigates flood damage.', {}).verdict, 'correct', '目标词变形可以');
assert.equal(fin(paraQ, 'Planting trees can mitigate the damage.', { taskOk: false, verdict: 'correct' }).verdict, 'wrong', '改写没保留原意算错');
assert.equal(fin(compQ, 'The team allocated tasks.', { grammarOk: false, verdict: 'correct' }).verdict, 'wrong');
assert.match(fin(compQ, 'The team gave out the tasks.', { usedTarget: false, verdict: 'wrong', reason: '没用目标词。' }).reason, /没有用上目标表达 allocate/);

// 真实请求通道 + 假服务
let reply = null;
const requests = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push({ url: req.url, prompt: body.messages[0].content });
  res.setHeader('Content-Type', 'application/json');
  if (req.url.startsWith('/down')) { res.statusCode = 503; return res.end(JSON.stringify({ error: `down ${KEY}` })); }
  res.end(JSON.stringify({ choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;
const configure = route => storage.set('linguaclip_ai_config', JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/${route}`, apiKey: KEY, model: 'fake-038', temperature: 0.7 }));
try {
  configure('v1');
  assert.equal(m.usageMixEnabled(), true, '发布版（非开发模式）永远混题');
  reply = { tasks: [m.usageRequest(mitigate, 'paraphrase'), m.usageRequest(allocate, 'compose')].map(goodDraft) };
  const drafts = await m.requestUsageTasks([m.usageRequest(mitigate, 'paraphrase'), m.usageRequest(allocate, 'compose')]);
  assert.equal(drafts.length, 2);
  assert.match(requests.at(-1).prompt, /Tasks:/);
  assert.deepEqual(await m.requestUsageTasks([]), [], '空请求不发网络');

  // 判对：显示的修正版、升级版来自模型
  reply = full;
  const right = await m.evaluateAnswer(paraQ, 'Planting trees can mitigate flood damage.', { modelOn: true });
  assert.equal(right.correct, true);
  assert.equal(right.grade.origin, 'model');
  assert.equal(right.grade.model.grammarFix, full.grammarFix);
  assert.equal(right.grade.model.academicUpgrade, full.academicUpgrade);
  assert.deepEqual(m.submitRequest(paraQ, right), { id: paraQ.wordId, kind: 'rewrite', correct: true }, '改写题按 rewrite 写回');
  // 用近义词（没用目标词）→ 未完成 → 写回答错
  reply = { ...full, usedTarget: false, verdict: 'incomplete', reason: '用了 reduce，不是目标词。', grammarFix: 'Planting trees can reduce flood damage.', academicUpgrade: 'Planting trees can mitigate flood damage in river towns.' };
  const synonym = await m.evaluateAnswer(paraQ, 'Planting trees can reduce flood damage.', { modelOn: true });
  assert.equal(synonym.grade.kind, 'incomplete');
  assert.equal(synonym.correct, false);
  assert.deepEqual(m.submitRequest(compQ, synonym), { id: compQ.wordId, kind: 'sentence', correct: false }, '造句题按 sentence 写回');
  // 模型漏了 taskOk → 判分失败 → 自评，绝不算对
  reply = { ...full, taskOk: undefined };
  const missing = await m.evaluateAnswer(compQ, 'The team allocated the tasks fairly.', { modelOn: true });
  assert.equal(missing.correct, null, '缺字段不算对');
  assert.equal(missing.grade.kind, 'manual');
  assert.match(missing.grade.reason, /模型判分失败（模型返回格式不正确：改写\/造句题缺少「是否完成要求」/);
  assert.equal(m.submitRequest(compQ, missing), null, '自评前不能写回');
  // 回复不是 JSON / 服务挂了 → 自评，不带密钥
  reply = 'Looks good to me!';
  const prose = await m.evaluateAnswer(compQ, 'The team allocated the tasks fairly.', { modelOn: true });
  assert.equal(prose.correct, null);
  assert.equal(prose.grade.reason, '模型判分失败（模型返回格式不正确），改为对照答案自评。', '不把 JSON 结构说明甩给用户');
  configure('down');
  const down = await m.evaluateAnswer(compQ, 'The team allocated the tasks fairly.', { modelOn: true });
  assert.equal(down.correct, null);
  assert.match(down.grade.reason, /模型判分失败/);
  assert.equal(down.grade.reason.includes(KEY), false);
  // 空答案：直接答错，不请求模型；「忘记了」：答错
  const before = requests.length;
  assert.equal((await m.evaluateAnswer(compQ, '  ', { modelOn: true })).correct, false);
  assert.equal((await m.evaluateAnswer(compQ, 'x', { modelOn: true, forgot: true })).correct, false);
  assert.equal(requests.length, before);
  assert.equal(m.forgotEvaluation(paraQ).grade.expected, 'mitigate');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

console.log('038 改写/造句测试通过：选型比例与上限、没配模型只出填空并说明、草稿校验与防泄题、同轮互相泄题退回填空、出题/判分提示词、判分收紧、缺字段/非 JSON/服务失败退回自评。');
