// 043 我的例句：真实代码 + 本机假 OpenAI 兼容服务，不调用真实模型。
// 覆盖：生成例句和改句的提示词（只有词、词性、义项和用户的句子，不含笔记/复习备注）、返回解析（格式错时中文报错）、
// 改句和 038 造句判分口径一致（同一份提示词、同一套收紧规则）、复习结果页「存为我的例句」的条件、列表分组。
// 用法（在 app 目录）：node test-vocab-examples.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundled = path.resolve('src-tauri/target/vocab-recall-tests', `examples-${process.pid}.mjs`);
fs.mkdirSync(path.dirname(bundled), { recursive: true });
await build({
  stdin: {
    contents: [
      "export * from './utils/vocab/examples.ts';",
      "export { buildGradingPrompt, finalizeGrade } from './utils/vocab/grading.ts';",
      "export { hasQuestionModel } from './utils/vocab/recallModel.ts';",
      "export { buildLibrary } from './utils/vocab/library.ts';",
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
  removeItem: key => storage.delete(key),
};
const m = await import(pathToFileURL(bundled).href);
fs.rmSync(bundled, { force: true });

const KEY = 'dummy-e2e-key-043-must-not-leak';
const NOTE = '复习备注：别和 aggravate 搞混（私人）';
const MY_NOTE = '我的笔记正文 PRIVATE-NOTE-043';

// ---------------------------------------------------------------- 义项
const definitions = [
  { sourceFile: 'a.md', sourceLine: 1, pos: 'adj.', english: 'able to recover quickly from difficulty', chinese: '有韧性的', examples: [] },
  { sourceFile: 'b.md', sourceLine: 2, pos: 'adj.', english: 'able to recover quickly from difficulty', chinese: '有韧性的', examples: [] },
  { sourceFile: 'c.md', sourceLine: 3, pos: 'adj.', english: 'returning to the original shape after bending', chinese: '有弹性的', examples: [] },
];
const senses = m.sensesFrom(definitions, { pos: 'adj.', gloss: NOTE });
assert.equal(senses.length, 2, '重复的义项合并');
assert.equal(m.senseLabel(senses[0]), 'adj. able to recover quickly from difficulty（有韧性的）');
assert.deepEqual(m.sensesFrom([], { pos: 'v.' }), [{ pos: 'v.', english: '', chinese: '' }], '没释义只给词性');
assert.equal(m.senseLabel({ pos: '', english: '', chinese: '' }), '');

// 从词库数据走一遍：WordGroup.gloss 在没有释义时取自表格备注，界面只把 definitions 和词性交给 sensesFrom。
const library = m.buildLibrary({
  upgrades: [], selfChecks: [],
  reviewWords: [{ id: 'rv:1', ord: 1, line: 2, raw: '| resilient |', word: 'resilient', issue: '1', addedAt: '', status: 'L1', level: 1, due: '', note: '别和 aggravate 搞混', source: '', verificationStatus: '未查证', definitions: [] }],
});
const group = library.wordByKey.get([...library.wordByKey.keys()][0]);
assert.equal(group.gloss, '别和 aggravate 搞混', '前提：没释义时 gloss 就是备注');
const uiSenses = m.sensesFrom(group.definitions, { pos: group.pos[0] });
const fromLibraryPrompt = m.buildExamplePrompt(group.word, uiSenses[0]);
assert.equal(fromLibraryPrompt.includes('别和 aggravate'), false, '没释义时也不把备注当意思发出去');

// ---------------------------------------------------------------- 生成例句：提示词
const prompt = m.buildExamplePrompt('  resilient ', senses[1]);
assert.match(prompt, /"target": "resilient"/);
assert.match(prompt, /"pos": "adj\."/);
assert.match(prompt, /"meaning": "returning to the original shape after bending"/);
assert.match(prompt, /"chinese": "有弹性的"/);
assert.match(prompt, /academic or campus situation/);
assert.match(prompt, /common, well-attested collocations/);
assert.match(prompt, /\{"examples":\[\{"sentence":"\.\.\.","collocation":"\.\.\.","chinese":"\.\.\."\}\]\}/);
assert.equal(prompt.includes('有韧性的'), false, '只发所选的那个义项');
for (const secret of [NOTE, MY_NOTE, '备注', '笔记', 'note']) assert.equal(prompt.toLowerCase().includes(secret.toLowerCase()), false, `生成提示词不含「${secret}」`);

// ---------------------------------------------------------------- 生成例句：解析
const good = {
  examples: [
    { sentence: 'Island economies must become more resilient to cope with storms.', collocation: 'resilient to', chinese: '岛屿经济必须更有韧性。' },
    { sentence: '  Our  study group stayed\nresilient after the failed experiment. ', collocation: 'stay resilient', chinese: '' },
    { sentence: 'Strong communities recover quickly after floods.', collocation: '', chinese: '没用目标词' },
    { sentence: 'island economies must become more RESILIENT to cope with storms.', collocation: '', chinese: '重复' },
  ],
};
const parsed = m.parseGeneratedExamples(JSON.stringify(good), 'resilient');
assert.deepEqual(parsed.map(item => item.sentence), [
  'Island economies must become more resilient to cope with storms.',
  'Our study group stayed resilient after the failed experiment.',
], '没用上目标词的、重复的去掉；空白合一');
assert.equal(m.generatedExplanation(parsed[0]), '搭配：resilient to；译：岛屿经济必须更有韧性。');
assert.equal(m.generatedExplanation(parsed[1]), '搭配：stay resilient');
assert.equal(m.parseGeneratedExamples(`\`\`\`json\n${JSON.stringify(good)}\n\`\`\``, 'resilient').length, 2, '整块代码块也认');
// 词形变化也算用上了
assert.equal(m.parseGeneratedExamples(JSON.stringify({ examples: [{ sentence: 'The council allocated funds to the library.' }] }), 'allocate').length, 1);
// 句型模板不做本地检查
assert.equal(m.parseGeneratedExamples(JSON.stringify({ examples: [{ sentence: 'It was the data that changed our minds.' }] }), 'It is X that …').length, 1);
for (const bad of ['不是 JSON', '[]', `前文${JSON.stringify(good)}`, JSON.stringify({ examples: [] }), JSON.stringify({ examples: 'x' }),
  JSON.stringify({ examples: [{ sentence: '' }] }), JSON.stringify({ examples: [{ sentence: 5 }] }), JSON.stringify({ examples: [{ sentence: 'resilient', chinese: 3 }] }),
  JSON.stringify({ examples: [{ sentence: 'resilient '.repeat(80) }] })]) {
  assert.throws(() => m.parseGeneratedExamples(bad, 'resilient'), /^Error: 模型返回格式不正确：需要 \{"examples"/, bad.slice(0, 40));
}
assert.throws(() => m.parseGeneratedExamples(JSON.stringify({ examples: [{ sentence: 'Strong communities recover quickly.' }] }), 'resilient'), /模型给的例句都没用上「resilient」/);

// ---------------------------------------------------------------- 改句：和 038 造句题判分口径一致
const question = m.ownSentenceQuestion('resilient', senses[0]);
assert.equal(question.format, 'compose');
assert.equal(question.kind, 'sentence');
assert.equal(question.task.instruction, m.OWN_SENTENCE_INSTRUCTION);
const written = 'Our team resilient after the setback.';
const checkPrompt = m.buildCheckPrompt('resilient', senses[0], written);
assert.equal(checkPrompt, m.buildGradingPrompt(question, written), '改句提示词就是 038 造句判分提示词');
// 038 造句判分的关键规则都在
assert.match(checkPrompt, /Task type: compose/);
assert.match(checkPrompt, /A near-synonym, a paraphrase, or a word from the same family with a different part of speech is NOT the target/);
assert.match(checkPrompt, /"grammarFix": the student's answer with only grammar and target-usage errors corrected, keeping the student's own meaning and wording as far as possible/);
assert.match(checkPrompt, /"academicUpgrade"/);
assert.match(checkPrompt, /"taskOk"/);
assert.match(checkPrompt, /Meaning: "\(adj\.\) able to recover quickly from difficulty \[Chinese: 有韧性的\]"/);
assert.match(checkPrompt, /Student's answer: "Our team resilient after the setback\."/);
for (const secret of [NOTE, MY_NOTE, '备注', '笔记']) assert.equal(checkPrompt.includes(secret), false, `改句提示词不含「${secret}」`);

// sentenceCheckFrom
const fixedCheck = m.sentenceCheckFrom(written, { usedTarget: true, grammarOk: false, taskOk: true, verdict: 'wrong', reason: '缺系动词。', targetForm: 'resilient', grammarFix: 'Our team remained resilient after the setback.', academicUpgrade: 'Our team remained remarkably resilient after the setback.' });
assert.deepEqual(fixedCheck, { verdict: 'wrong', label: '用法或语法有问题', reason: '缺系动词。', fixed: 'Our team remained resilient after the setback.', changed: true, better: 'Our team remained remarkably resilient after the setback.' });
const okCheck = m.sentenceCheckFrom('The  economy is resilient.', { usedTarget: true, grammarOk: true, taskOk: true, verdict: 'correct', reason: '对。', targetForm: 'resilient', grammarFix: 'The economy is resilient.', academicUpgrade: 'the economy is RESILIENT.' });
assert.equal(okCheck.changed, false, '只差空白不算改过');
assert.equal(okCheck.better, '', '升级版和原句一样就不显示');
assert.equal(okCheck.label, '用法正确');

// 复习结果页「存为我的例句」的条件
const compose = { format: 'compose', task: { instruction: 'x', original: '', reference: 'y' } };
const paraphrase = { format: 'paraphrase', task: { instruction: 'x', original: 'o', reference: 'y' } };
const fill = { format: 'fill', task: null };
const ok = { written: '  The team  had to allocate the budget. ', correct: true, flagged: false, grade: { kind: 'correct' } };
assert.equal(m.reviewExampleSentence(compose, ok), 'The team had to allocate the budget.');
assert.equal(m.reviewExampleSentence(paraphrase, ok), 'The team had to allocate the budget.');
assert.equal(m.reviewExampleSentence(fill, ok), null, '填空不行');
assert.equal(m.reviewExampleSentence(compose, { ...ok, correct: false }), null, '答错不行');
assert.equal(m.reviewExampleSentence(compose, { ...ok, correct: null }), null, '没判完不行');
assert.equal(m.reviewExampleSentence(compose, { ...ok, flagged: true }), null, '标了出错不行');
assert.equal(m.reviewExampleSentence(compose, { ...ok, grade: { kind: 'forgot' } }), null, '忘记了不行');
assert.equal(m.reviewExampleSentence(compose, { ...ok, written: '  ' }), null);

// 列表
const ex = (id, wordKey, createdAt) => ({ id, wordKey, word: wordKey, sentence: `s${id}`, source: '自己写', explanation: null, sense: null, original: null, createdAt });
const list = [ex(1, 'a', '2026-11-10T01:00:00.000Z'), ex(2, 'b', '2026-11-10T02:00:00.000Z'), ex(3, 'a', '2026-11-10T03:00:00.000Z'), ex(4, 'a', '2026-11-10T03:00:00.000Z')];
const grouped = m.groupExamples(list);
assert.deepEqual(grouped.get('a').map(e => e.id), [4, 3, 1], '新的在前，同时刻 ID 大的在前');
assert.deepEqual(m.addExamplesTo(list, [ex(5, 'c', 't')]).map(e => e.id), [5, 1, 2, 3, 4]);
assert.deepEqual(m.removeExample(list, 2).map(e => e.id), [1, 3, 4]);
assert.equal(m.exampleKey('  In the Light’s  OF '), "in the light's of");

// ---------------------------------------------------------------- 模型请求（假服务）
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
  if (route === 'prose') return answer('Here are some sentences: 1. ...');
  return answer(typeof reply === 'string' ? reply : JSON.stringify(reply));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const configure = route => storage.set('linguaclip_ai_config', JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/${route}`, apiKey: KEY, model: 'fake-043', temperature: 0.7 }));

try {
  // 没配模型：中文报错，不发请求
  storage.delete('linguaclip_ai_config');
  assert.equal(m.hasQuestionModel(), false);
  await assert.rejects(m.requestExamples('resilient', senses[0]), /尚未配置模型：请先在「设置」/);
  await assert.rejects(m.checkOwnSentence('resilient', senses[0], written), /尚未配置模型/);
  assert.equal(requests.length, 0);
  await assert.rejects(m.checkOwnSentence('resilient', senses[0], '   '), /先写一句/);

  configure('ok');
  assert.equal(m.hasQuestionModel(), true);
  reply = good;
  const generated = await m.requestExamples('resilient', senses[0]);
  assert.equal(generated.length, 2);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].auth, `Bearer ${KEY}`);
  assert.equal(requests[0].body.messages.length, 1, '只发一条用户消息');
  assert.equal(requests[0].body.messages[0].content, m.buildExamplePrompt('resilient', senses[0]));

  // 改句：模型说用上了但句子里根本没有 resilient → 和造句题一样收紧成「没用上」
  reply = { usedTarget: true, grammarOk: true, taskOk: true, verdict: 'correct', reason: '很好。', targetForm: 'resilient', grammarFix: 'Our team bounced back.', academicUpgrade: 'Our team recovered swiftly.' };
  const strict = await m.checkOwnSentence('resilient', senses[0], 'Our team bounced back.');
  assert.equal(strict.verdict, 'incomplete');
  assert.equal(strict.label, '没用上这个词');
  assert.match(strict.reason, /没有用上目标表达 resilient/);
  assert.equal(requests.at(-1).body.messages[0].content, m.buildCheckPrompt('resilient', senses[0], 'Our team bounced back.'));
  // 改句：语法错 → 给改后句子
  reply = { usedTarget: true, grammarOk: false, taskOk: true, verdict: 'wrong', reason: '缺系动词。', targetForm: 'resilient', grammarFix: 'Our team remained resilient after the setback.', academicUpgrade: 'Our team remained remarkably resilient after the setback.' };
  const fixed = await m.checkOwnSentence('resilient', senses[0], ` ${written}\n`);
  assert.deepEqual(fixed, fixedCheck);
  // 改句：038 要求的字段缺了（grammarFix 空）→ 当判分失败，中文报错
  reply = { usedTarget: true, grammarOk: true, taskOk: true, verdict: 'correct', reason: '对。', targetForm: 'resilient', grammarFix: '', academicUpgrade: '' };
  await assert.rejects(m.checkOwnSentence('resilient', senses[0], 'It is resilient.'), /模型返回格式不正确：改写\/造句题缺少/);
  reply = '{"usedTarget":true';
  await assert.rejects(m.checkOwnSentence('resilient', senses[0], 'It is resilient.'), /^Error: 模型返回格式不正确/);

  // 生成：散文、HTTP 错误都是中文，不回显密钥
  configure('prose');
  await assert.rejects(m.requestExamples('resilient', senses[0]), /^Error: 模型返回格式不正确：需要 \{"examples"/);
  configure('http');
  const httpError = await m.requestExamples('resilient', senses[0]).then(() => null, error => error);
  assert.match(httpError.message, /连接模型失败|HTTP 500/);
  assert.equal(httpError.message.includes(KEY), false, '报错里没有密钥');

  // 所有请求都不含笔记、备注
  for (const request of requests) {
    const text = JSON.stringify(request.body);
    for (const secret of [NOTE, MY_NOTE, '备注', '笔记']) assert.equal(text.includes(secret), false, `请求不含「${secret}」`);
  }
  console.log(`test-vocab-examples: 全部通过（${requests.length} 次假模型请求）`);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
