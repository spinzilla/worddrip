// 030 复习出题纯函数测试（替换 023 的遮备注测试）：node test-vocab-recall.mjs（在 app 目录下）。
// 覆盖：词形与防泄题、现成例句出题、模型草稿校验、没配模型/模型失败的兜底、每轮 8 题、每屏 ≤5 题、判定。
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const out = join(tmpdir(), `vocab-recall-${process.pid}.mjs`);
await build({ entryPoints: ['utils/vocab/recall.ts'], bundle: true, format: 'esm', outfile: out, logLevel: 'silent' });
const r = await import(pathToFileURL(out).href);
rmSync(out, { force: true });

const def = (english, examples = [], extra = {}) => ({
  sourceFile: '20261020.md', sourceLine: 1, pos: 'v.', english, chinese: '', examples, ...extra,
});
const ex = (sentence, ai = false, seq = 1) => ({ seq, sentence, ai });
const word = (id, text, definitions = [], note = `${text} 复习备注 2026-11-01 ✓`) => ({ id, word: text, definitions, note });

/** 断言题面任何可见文字都不含目标词（含变形和同族词）。 */
const assertClean = question => {
  assert.deepEqual(r.questionLeaks(question), [], `${question.target} 的题面泄题`);
  for (const text of r.visibleText(question)) {
    assert.equal(new RegExp(`\\b${question.target}\\b`, 'i').test(text), false, `${question.target} 原形出现在「${text}」`);
  }
};

// ---- 判定归一化（沿用 023） ----
assert.equal(r.normalizeRecallAnswer('  Hello   WORLD!  '), 'hello world');
assert.equal(r.recallAnswerMatches('Take part', '  take   PART. '), true);
assert.equal(r.recallAnswerMatches('resilient', 'resiliant'), false, '拼写错必须判错');
assert.equal(r.recallAnswerMatches("don't", 'dont'), false, '撇号不能忽略');
assert.equal(r.recallKind('apple'), 'recall');
assert.equal(r.recallKind('take part in something'), 'rewrite');
assert.equal(r.recallKind('take part in something today'), 'sentence');
assert.equal(r.recallKind('be X to'), 'sentence');
assert.equal(r.recallKind('experience'), 'recall', '小写 x 不是占位符');

// ---- 词形：常见屈折变形能认出，派生词和别的词不算 ----
for (const [form, target] of [['exacerbated', 'exacerbate'], ['exacerbating', 'exacerbate'], ['studies', 'study'],
  ['studied', 'study'], ['committed', 'commit'], ['Comprises', 'comprise'], ['taking  part in', 'take part in']]) {
  assert.equal(r.isTargetForm(form, target), true, `${form} 应是 ${target} 的变形`);
}
for (const [form, target] of [['exacerbation', 'exacerbate'], ['pineapple', 'apple'], ['took part in', 'take part in'], ['', 'apple']]) {
  assert.equal(r.isTargetForm(form, target), false, `${form} 不应算 ${target} 的变形`);
}
assert.deepEqual(r.findTargetForms('apple apples pineapple Apple-tree', 'apple').map(hit => hit.text), ['apple', 'apples', 'Apple']);

// ---- 防泄题：变形和同族派生词都要抓到，短词不乱抓 ----
assert.deepEqual(r.findLeaks('A careful evaluation helps us evaluate it.', 'evaluate').sort(), ['evaluate', 'evaluation']);
assert.deepEqual(r.findLeaks('This exacerbated the exacerbation.', 'exacerbate').sort(), ['exacerbated', 'exacerbation']);
assert.deepEqual(r.findLeaks('Please apply the rule.', 'apple'), [], '5 个字母以下不做词根匹配');
assert.equal(r.maskLeaks('to evaluate; an evaluation of', 'evaluate'), 'to ___; an ___ of');
assert.equal(r.maskLeaks('give up, gave up, giving   up', 'give up'), '___, gave up, ___', '不规则过去式不认（已知限制）');

// ---- 首字母提示：词数、字母数由提示本身给出 ----
assert.equal(r.letterHint('exacerbated'), 'e__________');
assert.equal(r.letterHint('take  part in'), 't___ p___ i_');
assert.equal(r.letterHint('well-known'), 'w___-k____');
assert.equal(r.hintLabel('exacerbated'), '11 个字母');
assert.equal(r.hintLabel('take part in'), '3 个词');

// ---- 用现成例句出题：挖空句中实际词形，人工例句优先，挖不唯一的句子不用 ----
const exacerbate = word('exacerbate@9.1', 'exacerbate', [def('to make a problem or situation worse', [
  ex('Exacerbate it, they said, and exacerbate it again.', false, 1),
  ex('The drought exacerbated food shortages across the region.', true, 2),
  ex('Without more investment, the policy could exacerbate the housing shortage.', false, 3),
], { chinese: '使恶化（exacerbate）' })]);
const fromExample = r.exampleQuestion(exacerbate);
assert.equal(fromExample.source, 'example');
assert.equal(fromExample.context.before, 'Without more investment, the policy could ');
assert.equal(fromExample.context.after, ' the housing shortage.');
assert.equal(fromExample.context.ai, false, '人工例句优先于 AI 例句');
assert.deepEqual(fromExample.answers, ['exacerbate']);
assert.equal(fromExample.hint, 'e_________');
assert.equal(fromExample.chinese, '使恶化（___）', '中文里夹的英文目标词也遮掉');
assertClean(fromExample);

const aiOnly = word('a@1', 'exacerbate', [def('to make worse', [ex('The drought exacerbated food shortages across the region.', true)])]);
const aiQuestion = r.exampleQuestion(aiOnly);
assert.equal(aiQuestion.context.ai, true);
assert.deepEqual(aiQuestion.answers, ['exacerbated'], '答案是句子需要的词形');
assert.equal(r.judgeRecall(aiQuestion, ' Exacerbated. '), true);
assert.equal(r.judgeRecall(aiQuestion, 'exacerbate'), false, '词形不对判错');
assert.equal(r.judgeRecall(aiQuestion, '   '), false, '空答案按答错');

const leakyDefinition = word('e@1', 'evaluate', [def('to evaluate or judge the value of something', [
  ex('Researchers must evaluate the evidence before any evaluation is published.'),
])]);
const leakyQuestion = r.exampleQuestion(leakyDefinition);
assert.equal(leakyQuestion.meaning, 'to ___ or judge the value of something', '释义里出现目标词也遮');
assert.equal(leakyQuestion.context.after, ' the evidence before any ___ is published.', '句中同族词遮掉');
assertClean(leakyQuestion);

assert.equal(r.exampleQuestion(word('x@1', 'resilient', [def('able to recover quickly', [ex('No target here.')])])), null);
assert.equal(r.exampleQuestion(word('x@1', 'resilient', [def('  ', [ex('A resilient system.')])])), null, '没有英文释义不出语境题');
// 030①：去掉目标词后不足 6 个词的现成例句不用（「A resilient system.」限定不了答案）。
assert.equal(r.exampleQuestion(word('x@1', 'resilient', [def('able to recover quickly', [ex('A resilient system.')])])), null, '太短的现成例句不出题');
const shortThenLong = r.exampleQuestion(word('x@2', 'resilient', [def('able to recover quickly', [
  ex('A resilient system.', false, 1),
  ex('Island economies must become more resilient to cope with storms.', false, 2),
])]));
assert.equal(shortThenLong.context.before, 'Island economies must become more ', '短例句跳过，继续找下一条');
assert.equal(r.MIN_EXAMPLE_CONTEXT_WORDS, 6);
assert.equal(r.definitionQuestion(word('x@1', 'resilient'), '原因'), null);
const bare = r.definitionQuestion(word('r@1', 'resilient', [def('able to recover quickly from difficulty')]), '没有例句');
assert.equal(bare.source, 'definition');
assert.equal(bare.context, null);
assert.equal(bare.fallbackReason, '没有例句');
assert.deepEqual(bare.answers, ['resilient']);
assertClean(bare);

// ---- 模型草稿：必须恰好一个 [[目标词]]，标记外不许有同族词 ----
const noDef = word('candid@2.1', 'candid');
const good = r.questionFromDraft(noDef, { id: 'candid@2.1', meaning: 'honest and direct, even when the truth is unwelcome', sentence: 'In the interview, the minister gave a surprisingly [[candid]] account of the failures.' });
assert.equal(typeof good, 'object');
assert.equal(good.source, 'model');
assert.equal(good.meaningOrigin, 'model');
assert.equal(good.context.ai, true);
assert.equal(good.context.before, 'In the interview, the minister gave a surprisingly ');
assertClean(good);
const withDef = r.questionFromDraft(leakyDefinition, { id: 'e@1', meaning: 'ignored', sentence: 'Teachers [[evaluated]] each essay against the published rubric.' });
assert.equal(withDef.meaningOrigin, 'library', '有词库释义时用词库释义，不用模型释义');
assert.deepEqual(withDef.answers, ['evaluated']);
const rejects = [
  [{ sentence: 'The minister was candid about it.' }, /恰好一个/],
  [{ sentence: 'A [[candid]] and [[candid]] reply was given to all.' }, /恰好一个/],
  [{ sentence: 'The minister gave a very [[honest]] account of the failures.' }, /不是目标词/],
  [{ sentence: 'Her candidness was clear: she gave a [[candid]] account of it.' }, /同族词/],
  [{ sentence: 'Very [[candid]].' }, /太短/],
  [{ meaning: 'being candid', sentence: 'The minister gave a surprisingly [[candid]] account of the failures.' }, /释义里出现/],
  [{ meaning: '', sentence: 'The minister gave a surprisingly [[candid]] account of the failures.' }, /没给英文释义/],
];
for (const [patch, reason] of rejects) {
  const outcome = r.questionFromDraft(noDef, { id: 'candid@2.1', meaning: 'honest and direct', ...patch });
  assert.equal(typeof outcome, 'string', `应拒绝：${patch.sentence}`);
  assert.match(outcome, reason);
}

// ---- 一轮：没配模型 ----
const pool = [
  exacerbate, // 例句
  word('r@1', 'resilient', [def('able to recover quickly from difficulty')]), // 只有释义
  word('n@1', 'nodata'), // 什么都没有 → 跳过
  word('s@1', 'be X to', [def('used to say what someone is likely to do')]), // 句型
  word('s@2', 'as … as'), // 句型无释义 → 跳过
  ...Array.from({ length: 9 }, (_, i) => word(`w${i}@1`, `word${'abcdefghi'[i]}x`, [def(`meaning number ${i}`, [ex(`This is word${'abcdefghi'[i]}x used in a longer sentence here.`)])])),
];
const poolCopy = JSON.stringify(pool);
const offline = await r.prepareRecallRound(pool, { generate: null });
assert.equal(offline.questions.length, r.RECALL_LIMIT, '每轮最多 8 题');
assert.equal(r.RECALL_LIMIT, 8);
assert.deepEqual(offline.questions.map(q => q.wordId), ['exacerbate@9.1', 'r@1', 's@1', 'w0@1', 'w1@1', 'w2@1', 'w3@1', 'w4@1'], '按传入顺序（最逾期优先）补满 8 题');
assert.deepEqual(offline.skipped.map(s => s.wordId), ['n@1', 's@2']);
assert.match(offline.skipped[0].reason, /没有英文释义，也没配置模型/);
assert.match(offline.skipped[1].reason, /句型没有英文释义/);
assert.equal(offline.remaining, pool.length - 10, '看过 10 个（8 题 + 2 跳过），其余留到下一轮');
assert.equal(offline.questions[1].source, 'definition');
assert.match(offline.questions[1].fallbackReason, /没配置模型/);
assert.equal(offline.questions[2].selfCheck, true);
assert.equal(r.judgeRecall(offline.questions[2], 'anything'), null, '句型题让用户自评');
assert.ok(offline.notices.some(text => /没配置模型：2 题/.test(text)));
assert.ok(offline.notices.some(text => /2 个到期词缺数据/.test(text)));
offline.questions.forEach(assertClean);
assert.equal(JSON.stringify(pool), poolCopy, '不修改传入队列');
assert.equal(Object.isFrozen(offline.questions), true);
assert.equal(JSON.stringify(offline).includes('复习备注'), false, '复习备注不上题面');
assert.deepEqual((await r.prepareRecallRound([], { generate: null })).questions, []);
assert.equal((await r.prepareRecallRound(pool, { generate: null, limit: 3 })).questions.length, 3);

// ---- 一轮：本机假生成器正常 ----
const calls = [];
const fakeGood = async requests => {
  calls.push(requests);
  return requests.map(item => ({ id: item.id, meaning: 'honest and direct in what you say', sentence: `Experts agree the plan is [[${item.word}]] in several important ways.` }));
};
const withModel = await r.prepareRecallRound(pool, { generate: fakeGood });
assert.equal(calls.length, 1, '整轮只请求一次模型');
assert.deepEqual(calls[0].map(item => item.id), ['r@1', 'n@1'], '有现成例句的、句型都不请求模型');
assert.equal(JSON.stringify(calls[0]).includes('复习备注'), false, '不把复习备注发给模型');
assert.deepEqual(Object.keys(calls[0][0]).sort(), ['chinese', 'english', 'id', 'pos', 'word']);
assert.equal(withModel.questions.find(q => q.wordId === 'r@1').source, 'model');
assert.equal(withModel.questions.find(q => q.wordId === 'n@1').meaningOrigin, 'model', '没释义的词用模型释义');
assert.deepEqual(withModel.skipped.map(s => s.wordId), ['s@2']);
assert.equal(withModel.notices.some(text => /没配置模型/.test(text)), false);
withModel.questions.forEach(assertClean);

// ---- 一轮：模型整体失败 / 个别题不合格 ----
const failed = await r.prepareRecallRound(pool, { generate: async () => { throw new Error('模型返回格式不正确：测试。'); } });
assert.equal(failed.questions.find(q => q.wordId === 'r@1').source, 'definition', '有释义的退回释义题');
assert.match(failed.questions.find(q => q.wordId === 'r@1').fallbackReason, /模型返回格式不正确/);
assert.ok(failed.skipped.some(s => s.wordId === 'n@1' && /又没有英文释义/.test(s.reason)));
assert.ok(failed.notices.some(text => /^模型出题失败：模型返回格式不正确/.test(text)));
const partial = await r.prepareRecallRound(pool, { generate: async () => [
  { id: 'r@1', meaning: 'x', sentence: 'The resilient community rebuilt [[resilient]] homes after the flood.' },
  { id: 'unknown', meaning: 'x', sentence: 'whatever' },
] });
assert.equal(partial.questions.find(q => q.wordId === 'r@1').source, 'definition', '标记外泄题的草稿不用');
assert.ok(partial.skipped.some(s => s.wordId === 'n@1' && /模型没给这个词出题/.test(s.reason)));
assert.ok(partial.notices.some(text => /1 个词没给题/.test(text)), '模型漏掉的词要如实说明');
assert.ok(partial.notices.some(text => /1 个词出的题没通过/.test(text)), '格式/防泄题问题只统计真正给了草稿的词');
partial.questions.forEach(assertClean);

// ---- 每屏最多 5 题，尽量平均，顺序不变 ----
const sizes = n => r.splitScreens(Array.from({ length: n }, (_, i) => i)).map(screen => screen.length);
assert.equal(r.SCREEN_LIMIT, 5);
assert.deepEqual(sizes(0), []);
assert.deepEqual(sizes(1), [1]);
assert.deepEqual(sizes(5), [5]);
assert.deepEqual(sizes(6), [3, 3]);
assert.deepEqual(sizes(7), [4, 3]);
assert.deepEqual(sizes(8), [4, 4]);
assert.deepEqual(sizes(11), [4, 4, 3]);
for (let n = 1; n <= 30; n += 1) {
  const screens = r.splitScreens(Array.from({ length: n }, (_, i) => i));
  assert.ok(screens.every(screen => screen.length >= 1 && screen.length <= 5));
  assert.deepEqual(screens.flat(), Array.from({ length: n }, (_, i) => i));
}
assert.throws(() => r.splitScreens([1], 0));

console.log('复习出题纯函数测试通过：词形、防泄题、现成例句、模型草稿校验、没配模型/模型失败兜底、每轮 8 题、每屏 ≤5 题、判定。');
