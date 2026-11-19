// 095 写作练习：真实逻辑 + 本机假模型，不访问真实模型。用法（app 目录）：node test-writing.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startFakeModel } from './dev/sse-fake-model.mjs';

const bundled = path.resolve('src-tauri/target/writing-tests', `writing-${process.pid}.mjs`);
fs.mkdirSync(path.dirname(bundled), { recursive: true });
await build({
  stdin: {
    contents: [
      "export * as C from './utils/aiTasks/center.ts';",
      "export * as S from './utils/aiTasks/stream.ts';",
      "export * as M from './utils/writing/model.ts';",
      "export * as R from './utils/writing/records.ts';",
      "export * as P from './utils/writing/wordPicker.ts';",
      "export * as T from './utils/writing/tasks.ts';",
      "export { RESULT_PARSERS } from './utils/aiTasks/index.ts';",
    ].join('\n'),
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, format: 'esm', outfile: bundled, logLevel: 'silent',
  define: { 'import.meta.env.DEV': 'false' },
  plugins: [{
    name: 'node-tauri-http',
    setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/plugin-http$/ }, args => ({ path: args.path, namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const fetch = (...args) => globalThis.fetch(...args);' }));
    },
  }],
});
const memoryStorage = () => {
  const map = new Map();
  return { map, getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
};
const bootStorage = memoryStorage();
globalThis.localStorage = bootStorage;
const m = await import(pathToFileURL(bundled).href);
const fake = await startFakeModel({ thinkDelayMs: 0, textDelayMs: 0 });
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (fn, what) => {
  for (let i = 0; i < 300; i += 1) { if (fn()) return; await tick(5); }
  throw new Error(`等不到：${what}`);
};
let model = 'fake-writing';
const run = args => m.S.streamCompletion({
  fetchFn: globalThis.fetch,
  url: `http://127.0.0.1:${fake.port}/v1/chat/completions`,
  apiKey: 'dummy-writing-key',
  body: { model, messages: args.messages.map(({ role, content }) => ({ role, content })) },
  signal: args.signal, onText: args.onText, onThink: args.onThink,
});
let taskSeq = 0;
let recordSeq = 0;
let now = 1000;
const makeCenter = (storage, runFn = run) => m.C.createAiTaskCenter({
  run: runFn, storage, now: () => ++now, newId: () => `ai-${++taskSeq}`, resultParsers: m.RESULT_PARSERS,
});
const options = (center, storage, extra = {}) => ({
  center, storage, configured: () => true, now: () => ++now, newId: () => `record-${++recordSeq}`, ...extra,
});
const word = { id: 'w1', word: 'resilient', pos: 'adj.', definition: 'able to recover quickly from difficulty' };
const browseWord = (id, text, status, definitions, addedAt = '2026-11-01', due = '2026-11-20') => ({ id, word: text, status, definitions, addedAt, due });
const definition = english => ({ sourceFile: 'test.md', sourceLine: 1, pos: 'adj.', english, chinese: '', examples: [] });

try {
  for (const scene of m.M.WRITING_SCENES) {
    const taskPrompt = m.M.buildWritingTaskPrompt(scene, [word]);
    assert.match(taskPrompt, /仿照该类考试或场景的出题风格/);
    assert.match(taskPrompt, /不要照抄、复述或轻微改写任何真题原文/);
    assert.match(taskPrompt, /可用可不用/);
    const reviewPrompt = m.M.buildWritingReviewPrompt(scene, { prompt: 'Original question', chinese: '中文说明', requirements: '2–4 句' }, 'I think this is useful. It helps students.', [word]);
    assert.match(reviewPrompt, /不打分，不给分数、等级或排名/);
    assert.match(reviewPrompt, /没用就标“没用”，不扣分/);
  }

  const picked = m.P.pickWritingWords([
    browseWord('old', 'old', 'L1', [definition('not new')], '2026-10-01'),
    browseWord('master', 'mastered', '✅已掌握', [definition('already known')], '2026-11-05'),
    browseWord('empty', 'empty', 'L1', [definition('')], '2026-11-06'),
    browseWord('late', 'late', 'L2', [definition('after the expected time')], '2026-11-04', '2026-12-01'),
    browseWord('soon', 'soon', 'L2', [definition('before long')], '2026-11-04', '2026-11-18'),
    browseWord('new', 'new', 'L1', [definition('recently made')], '2026-11-07'),
  ]);
  assert.deepEqual(picked.map(item => item.word), ['new', 'soon', 'late']);
  assert.ok(!picked.some(item => ['mastered', 'empty'].includes(item.word)));
  assert.equal(m.P.pickWritingWords([browseWord('one', 'only', 'L1', [definition('single')])]).length, 1);
  assert.deepEqual(m.P.pickWritingWords([]), []);

  const storage = memoryStorage();
  const center = makeCenter(storage);
  const madeItems = [];
  for (const [index, scene] of m.M.WRITING_SCENES.entries()) {
    const before = center.getTasks().length;
    const made = m.T.startWritingTask(scene.id, index === 1 ? [] : [word], options(center, storage));
    assert.equal(made.ok, true, `${scene.nameZh}可以出题，包括 0 个建议用词`);
    assert.equal(center.getTasks().length, before + 1);
    await waitFor(() => center.getTask(made.task.id)?.status === 'done', `${scene.nameZh}出题完成`);
    const item = m.R.getWritingRecord(made.task.source.ref, { storage });
    assert.ok(item?.task?.prompt.includes('universities'));
    assert.match(item.task.chinese, /请表明/);
    assert.ok(item.task.requirements.includes('2–4 句'));
    assert.equal(item.task.error, undefined);
    assert.equal(m.T.findWritingTask(item.id, center.getTasks())?.id, made.task.id);
    madeItems.push(item);
  }
  assert.ok(fake.requests.some(req => req.body.messages.some(msg => msg.content.includes('没有合适的建议用词'))), '空词库仍发正常出题请求');

  model = 'fake-writing-bad';
  const bad = m.T.startWritingTask('ielts', [], options(center, storage));
  assert.equal(bad.ok, true);
  await waitFor(() => center.getTask(bad.task.id)?.status === 'done', '坏 JSON 出题完成');
  assert.match(center.getTask(bad.task.id).result.error, /写作出题结果解析失败.*JSON/);
  assert.match(m.R.getWritingRecord(bad.task.source.ref, { storage }).task.error, /写作出题结果解析失败/);
  assert.match(m.M.parseWritingReviewRecord({ recordId: 'x', words: [word] }, 'bad').error, /写作批改结果解析失败/);
  model = 'fake-writing';

  let count = center.getTasks().length;
  let denied = m.T.startWritingTask('ielts', [], options(center, storage, { configured: () => false }));
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /尚未配置模型/);
  assert.equal(center.getTasks().length, count);
  denied = m.T.startWritingReview(madeItems[0], 'This is English. It answers the task.', options(center, storage, { configured: () => false }));
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /尚未配置模型/);
  assert.equal(center.getTasks().length, count);
  denied = m.T.startWritingReview(madeItems[0], '   ', options(center, storage));
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /先写下/);
  assert.equal(center.getTasks().length, count);
  denied = m.T.startWritingReview(madeItems[0], '这是中文作答。', options(center, storage));
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /明显不是英文/);
  assert.equal(center.getTasks().length, count);

  const answer = 'I think community service is very good. Students is resilient when they help others.';
  const reviewed = m.T.startWritingReview(madeItems[0], answer, options(center, storage));
  assert.equal(reviewed.ok, true);
  await waitFor(() => center.getTask(reviewed.task.id)?.status === 'done', '批改完成');
  await waitFor(() => m.R.getWritingRecord(madeItems[0].id, { storage })?.review?.task != null, '批改抄进记录');
  const review = center.getTask(reviewed.task.id).result;
  assert.equal(review.task.verdict, 'partly');
  assert.equal(review.issues.length, 3, '模型给 4 条也只保留最重要 3 条');
  assert.deepEqual(review.words, [{ word: 'resilient', used: true, correct: true, comment: 'resilient 在这里用得正确。' }]);
  assert.match(review.better, /universities should/);
  const saved = m.R.getWritingRecord(madeItems[0].id, { storage });
  assert.equal(saved.answer, answer);
  assert.deepEqual(saved.review, review);
  assert.equal(saved.reviewTaskId, reviewed.task.id);
  assert.equal(m.T.findWritingReview(saved.id, center.getTasks())?.id, reviewed.task.id);

  // 再次批改：旧任务仍在中心，也不能把新的 reviewTaskId 和空结果覆盖回去。
  const reviewedAgain = m.T.startWritingReview(saved, `${answer} It also builds confidence.`, options(center, storage));
  assert.equal(reviewedAgain.ok, true);
  assert.equal(m.R.getWritingRecord(saved.id, { storage }).reviewTaskId, reviewedAgain.task.id);
  assert.equal(m.R.getWritingRecord(saved.id, { storage }).review, null);
  await waitFor(() => center.getTask(reviewedAgain.task.id)?.status === 'done', '第二次批改完成');
  await waitFor(() => m.R.getWritingRecord(saved.id, { storage })?.review?.task != null, '第二次批改抄进记录');
  assert.equal(m.R.getWritingRecord(saved.id, { storage }).reviewTaskId, reviewedAgain.task.id);

  const restartStorage = memoryStorage();
  const failedCenter = makeCenter(restartStorage, async () => { throw new Error('测试断网'); });
  const restartBase = m.R.createWritingRecord('academic', [word], 'old-task', options(failedCenter, restartStorage));
  m.R.saveWritingTaskResult(restartBase.id, { prompt: 'Describe a trend in two sentences.', chinese: '请描述一组数据的变化趋势。', requirements: '2–4 句，描述趋势' }, { storage: restartStorage, now: () => ++now });
  const restartItem = m.R.getWritingRecord(restartBase.id, { storage: restartStorage });
  const failedReview = m.T.startWritingReview(restartItem, 'The number rose sharply. It then remained stable.', options(failedCenter, restartStorage));
  assert.equal(failedReview.ok, true);
  await waitFor(() => failedCenter.getTask(failedReview.task.id)?.status === 'failed', '第一次批改失败');
  const center2 = makeCenter(restartStorage);
  m.T.watchWritingTasks(center2, options(center2, restartStorage));
  assert.equal(center2.retry(failedReview.task.id), true);
  await waitFor(() => center2.getTask(failedReview.task.id)?.status === 'done', '重启后批改重试完成');
  await waitFor(() => m.R.getWritingRecord(restartBase.id, { storage: restartStorage })?.review?.task != null, '重启重试后抄进记录');
  assert.equal(center2.getTask(failedReview.task.id).result.task.verdict, 'partly');
  assert.equal(m.R.getWritingRecord(restartBase.id, { storage: restartStorage }).review.task.verdict, 'partly');

  const capStorage = memoryStorage();
  for (let i = 1; i <= 105; i += 1) {
    m.R.createWritingRecord('cet', [], `task-${i}`, { storage: capStorage, now: () => i, newId: () => `item-${i}` });
  }
  const capped = m.R.listWritingRecords({ storage: capStorage });
  assert.equal(capped.length, 100);
  assert.equal(capped[0].id, 'item-105');
  assert.ok(!capped.some(item => item.id === 'item-1'));
  assert.equal(m.R.getWritingRecord('item-105', { storage: capStorage }).id, 'item-105');
  assert.equal(m.R.saveWritingDraft('item-105', 'My draft.', { storage: capStorage, now: () => 200 }).answer, 'My draft.');
  assert.equal(m.R.getWritingRecord('item-105', { storage: capStorage }).answer, 'My draft.');
  assert.equal(m.R.deleteWritingRecord('item-105', { storage: capStorage }), true);
  assert.equal(m.R.getWritingRecord('item-105', { storage: capStorage }), undefined);
  assert.equal(m.R.deleteWritingRecord('not-there', { storage: capStorage }), false);

  console.log('test-writing 全部通过（三种场景、建议用词、解析、任务重试、记录）');
} finally {
  await fake.close();
  fs.rmSync(bundled, { force: true });
}