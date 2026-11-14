// 031 判分与同日复检：真实判分代码 + 本机假 OpenAI 兼容服务，不调用真实模型。
// 用法（在 app 目录）：node test-vocab-grading.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundled = path.resolve('src-tauri/target/vocab-recall-tests', `grading-${process.pid}.mjs`);
fs.mkdirSync(path.dirname(bundled), { recursive: true });
await build({
  stdin: {
    contents: [
      "export * from './utils/vocab/recall.ts';",
      "export * from './utils/vocab/recallModel.ts';",
      "export * from './utils/vocab/grading.ts';",
      "export * from './utils/vocab/gradingModel.ts';",
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

const KEY = 'dummy-e2e-key-must-not-leak';
const def = (english, examples = []) => [{ sourceFile: 'a.md', sourceLine: 1, pos: 'v.', english, chinese: '', examples }];
const word = (id, text, definitions) => ({ id, word: text, definitions });

// ---------------------------------------------------------------- 程序判填空
const resilient = m.exampleQuestion(word('w1', 'resilient', def('able to recover quickly from difficulty', [
  { seq: 1, sentence: 'Island economies must become more resilient to cope with storms.', ai: false },
])));
assert.ok(resilient, '现成例句能出题');
assert.deepEqual(resilient.answers, ['resilient']);
const allocated = m.exampleQuestion(word('w2', 'allocate', def('to give something to a person for a purpose', [
  { seq: 1, sentence: 'The council allocated funds to the new library project.', ai: false },
])));
assert.deepEqual(allocated.answers, ['allocated']);

const spell = (question, written) => m.gradeSpelling(question, written);
// 大小写和首尾空格不算错
assert.equal(spell(resilient, 'resilient').kind, 'correct');
assert.equal(spell(resilient, '  Resilient  ').kind, 'correct');
assert.equal(spell(resilient, 'RESILIENT').kind, 'correct');
// 单字母笔误：少一个、多一个、错一个，都只是「可能是笔误」
for (const written of ['resilent', 'resiliient', 'resiliant']) {
  const grade = spell(resilient, written);
  assert.equal(grade.kind, 'typo', written);
  assert.match(grade.reason, /笔误/);
  assert.equal(grade.expected, 'resilient');
}
// 多字母拼错、空答案：判错
for (const written of ['resiliant1', 'resilence', 'robust', 'resilnt', '']) {
  assert.equal(spell(resilient, written).kind, 'wrong', JSON.stringify(written));
}
assert.match(spell(resilient, '').reason, /没作答/);
// 写了近义词（差得远）说「不是目标词」，别归因成拼写错误；真正的笔误仍提示笔误。
assert.match(spell(resilient, 'robust').reason, /不是目标词/);
assert.match(spell(resilient, 'resilent').reason, /笔误/);
// 词形不对（allocate 填进 allocated 的空）：判错，不是笔误
const formGrade = spell(allocated, 'allocate');
assert.equal(formGrade.kind, 'wrong');
assert.match(formGrade.reason, /词形不对/);
assert.equal(spell(allocated, 'allocated').kind, 'correct');
assert.equal(m.editDistance('kitten', 'sitting'), 3);
assert.equal(m.editDistance('', 'ab'), 2);

// evaluateAnswer：程序判不碰模型
const noModel = { modelOn: false, grader: () => { throw new Error('不该调用模型'); } };
assert.deepEqual((await m.evaluateAnswer(resilient, 'Resilient', noModel)).correct, true);
assert.deepEqual((await m.evaluateAnswer(resilient, 'resiliant1', noModel)).correct, false);
const typoEval = await m.evaluateAnswer(resilient, 'resilent', noModel);
assert.equal(typoEval.correct, null, '笔误等用户申诉');
assert.equal(typoEval.grade.kind, 'typo');

// ---------------------------------------------------------------- 模型判分（假服务）
const requests = [];
let reply = null;
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push({ url: req.url, body, auth: req.headers.authorization });
  res.setHeader('Content-Type', 'application/json');
  const answer = content => res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  const route = req.url.split('/')[1];
  if (route === 'http') { res.statusCode = 500; return res.end(JSON.stringify({ error: `boom ${KEY}` })); }
  if (route === 'prose') return answer(`Sure: ${JSON.stringify(reply)}`);
  if (route === 'fenced') return answer(`\`\`\`json\n${JSON.stringify(reply)}\n\`\`\``);
  if (route === 'badjson') return answer('{"usedTarget":true');
  if (route === 'badshape') return answer(JSON.stringify({ usedTarget: 'yes', grammarOk: true, verdict: 'correct', reason: 'x' }));
  if (route === 'badverdict') return answer(JSON.stringify({ usedTarget: true, grammarOk: true, verdict: 'great', reason: 'x' }));
  return answer(JSON.stringify(reply));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;
const configure = route => storage.set('linguaclip_ai_config', JSON.stringify({
  baseUrl: `http://127.0.0.1:${port}/${route}`, apiKey: KEY, model: 'fake-grader', temperature: 0.7,
}));

// 造句题（短语目标）
const phraseQ = { ...m.definitionQuestion(word('w3', 'in the light of', def('considering something')), 'x'), selfCheck: true };
const patternQ = { ...m.definitionQuestion(word('w4', 'It is X that …', def('a cleft sentence pattern')), 'x'), selfCheck: true };
const good = { usedTarget: true, grammarOk: true, verdict: 'correct', reason: '用法正确。', targetForm: 'in the light of', grammarFix: '', academicUpgrade: 'In light of the evidence, the policy was revised.' };

try {
  // 解析
  assert.deepEqual(m.parseGrade(JSON.stringify(good)), good);
  assert.equal(m.parseGrade(`\`\`\`json\n${JSON.stringify(good)}\n\`\`\``).verdict, 'correct');
  for (const bad of ['不是 JSON', '[]', `前文${JSON.stringify(good)}`, JSON.stringify({ ...good, usedTarget: 'yes' }),
    JSON.stringify({ ...good, verdict: 'great' }), JSON.stringify({ ...good, reason: '' }), JSON.stringify({ ...good, reason: 5 })]) {
    assert.throws(() => m.parseGrade(bad), /模型返回格式不正确/, bad.slice(0, 40));
  }
  // 提示词：带目标和用户句子，要求 JSON；不含密钥
  const prompt = m.buildGradingPrompt(phraseQ, 'In the light of new data, we changed the plan.');
  assert.ok(prompt.includes('in the light of') && prompt.includes('new data'));
  assert.match(prompt, /usedTarget/);
  assert.equal(prompt.includes(KEY), false);

  // 1) 用了目标且语法对 → 答对，附学术升级版
  configure('normal');
  reply = good;
  const ok = await m.evaluateAnswer(phraseQ, 'In the light of new data, we changed the plan.', { modelOn: true });
  assert.equal(ok.correct, true);
  assert.equal(ok.grade.origin, 'model');
  assert.equal(ok.grade.model.academicUpgrade, good.academicUpgrade);
  assert.equal(requests.at(-1).auth, `Bearer ${KEY}`);
  assert.equal(requests.at(-1).body.model, 'fake-grader');

  // 2) 改写没用目标表达：语法对也判「未完成」，哪怕模型自己写了 correct
  reply = { ...good, usedTarget: false, verdict: 'correct', reason: '句子通顺。' };
  const unused = await m.evaluateAnswer(phraseQ, 'Because of new data, we changed the plan.', { modelOn: true });
  assert.equal(unused.correct, false);
  assert.equal(unused.grade.kind, 'incomplete');
  assert.equal(unused.grade.model.usedTarget, false);
  assert.match(unused.grade.reason, /没有用上目标表达/);
  // 模型说用了，但用户文字里根本没有目标词 → 本地兜底也判未完成
  reply = good;
  const liar = await m.evaluateAnswer(phraseQ, 'Because of new data, we changed the plan.', { modelOn: true });
  assert.equal(liar.grade.kind, 'incomplete');
  // 句型模板（含 X/…）本地认不出用法，信模型
  reply = { ...good, targetForm: 'It is the data that mattered' };
  const pattern = await m.evaluateAnswer(patternQ, 'It is the data that mattered most.', { modelOn: true });
  assert.equal(pattern.correct, true);
  // 用了但语法错 → 答错，带语法修正
  reply = { ...good, grammarOk: false, verdict: 'wrong', reason: '时态错误。', grammarFix: 'In the light of new data, we changed the plan.' };
  const wrongG = await m.evaluateAnswer(phraseQ, 'In the light of new data, we change the plan yesterday.', { modelOn: true });
  assert.equal(wrongG.correct, false);
  assert.equal(wrongG.grade.kind, 'wrong');
  assert.equal(wrongG.grade.model.grammarFix, reply.grammarFix);
  // 模型自相矛盾：语法不对却写 correct → 收紧成答错
  reply = { ...good, grammarOk: false, verdict: 'correct' };
  assert.equal((await m.evaluateAnswer(phraseQ, 'In the light of data we is happy.', { modelOn: true })).correct, false);
  // 空答案不发请求
  const callsBefore = requests.length;
  const blank = await m.evaluateAnswer(phraseQ, '   ', { modelOn: true });
  assert.equal(blank.correct, false);
  assert.equal(requests.length, callsBefore, '没作答不调用模型');

  // 代码块包裹的 JSON 能解析
  configure('fenced');
  reply = good;
  assert.equal((await m.evaluateAnswer(phraseQ, 'In the light of new data, we changed the plan.', { modelOn: true })).correct, true);

  // 3) 模型 JSON 错误 → 不判分，退回用户自评，错误里不带密钥
  for (const route of ['badjson', 'badshape', 'badverdict', 'prose']) {
    configure(route);
    reply = good;
    const out = await m.evaluateAnswer(phraseQ, 'In the light of new data, we changed the plan.', { modelOn: true });
    assert.equal(out.correct, null, route);
    assert.equal(out.grade.kind, 'manual', route);
    assert.equal(out.grade.origin, 'self', route);
    assert.match(out.grade.reason, /模型判分失败/, route);
    assert.equal(out.grade.reason.includes(KEY), false, route);
  }
  configure('http');
  const httpOut = await m.evaluateAnswer(phraseQ, 'In the light of new data, we changed the plan.', { modelOn: true });
  assert.equal(httpOut.correct, null);
  assert.match(httpOut.grade.reason, /HTTP 500/);
  assert.equal(httpOut.grade.reason.includes(KEY), false, '不带响应正文和密钥');

  // 4) 没配模型 → 退回自评，且不发任何请求
  storage.clear();
  assert.equal(m.hasQuestionModel(), false);
  const before = requests.length;
  const self = await m.evaluateAnswer(phraseQ, 'In the light of new data, we changed the plan.', { modelOn: m.hasQuestionModel() });
  assert.equal(self.correct, null);
  assert.equal(self.grade.kind, 'manual');
  assert.match(self.grade.reason, /没配置模型/);
  assert.equal(requests.length, before);
  await assert.rejects(m.gradeWithModel(phraseQ, 'x'), /尚未配置模型/);

  // ---------------------------------------------------------------- 状态变化说明
  assert.equal(m.describeChange({ status: 'L3', due: '2026-11-09' }, { status: 'L1', due: '2026-11-11', changed: true }), 'L3 → L1，到期 11-11');
  assert.equal(m.describeChange({ status: 'L1', due: '2026-11-09' }, { status: 'L2', due: '2026-11-13', changed: true }), 'L1 → L2，到期 11-13');
  assert.equal(m.describeChange({ status: 'L4', due: '2026-11-09' }, { status: '✅已掌握', due: '', changed: true }), 'L4 → 已掌握');
  // 042：界面不显示表情，首考的「🌱待考察」也只显示文字。
  assert.equal(m.describeChange({ status: '🌱待考察', due: '' }, { status: '🧊冷库', due: '', changed: true }), '待考察 → 冷库');
  assert.match(m.describeChange({ status: 'L1', due: '2026-11-11' }, { status: 'L1', due: '2026-11-11', changed: false }), /^不变（今天已计入，不再升级）：L1，到期 11-11$/);

  // ---------------------------------------------------------------- 「这题出错了」不再出这道题面 + 复检要新语境
  const twoExamples = word('w5', 'resilient', def('able to recover quickly', [
    { seq: 1, sentence: 'Island economies must become more resilient to cope with storms.', ai: false },
    { seq: 2, sentence: 'A resilient community rebuilt its harbour within a year.', ai: false },
  ]));
  const first = m.exampleQuestion(twoExamples);
  const flagged = new Set([m.surfaceKey('w5', m.surfaceOf(first))]);
  const roundAfterFlag = await m.prepareRecallRound([twoExamples], { generate: null, exclude: flagged });
  assert.equal(roundAfterFlag.questions.length, 1);
  assert.notEqual(m.surfaceOf(roundAfterFlag.questions[0]), m.surfaceOf(first), '标过出错的题面换了别的例句');
  const bothFlagged = new Set([...flagged, m.surfaceKey('w5', m.surfaceOf(roundAfterFlag.questions[0]))]);
  const noneLeft = await m.prepareRecallRound([twoExamples], { generate: null, exclude: bothFlagged });
  assert.deepEqual(noneLeft.questions.map(q => q.source), ['definition'], '例句都标过，退回释义题');
  assert.equal(noneLeft.questions.some(q => bothFlagged.has(m.surfaceKey('w5', m.surfaceOf(q)))), false);
  const strictRecheck = await m.prepareRecallRound([twoExamples], { generate: null, exclude: bothFlagged, requireContext: true, limit: 1 });
  assert.equal(strictRecheck.questions.length, 0, '复检要新语境，没有就不出');
  assert.match(strictRecheck.skipped[0].reason, /没有别的语境/);
  const recheckQ = await m.prepareRecallRound([twoExamples], { generate: null, exclude: flagged, requireContext: true, limit: 1 });
  assert.equal(recheckQ.questions.length, 1, '还有别的例句就能换语境');

  console.log('判分假模型测试通过：大小写、单字母笔误、多字母拼错、词形错、改写没用目标判未完成、模型 JSON 错误/HTTP 错误退回自评、没配模型自评、题面出错跳过、复检要新语境。');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
