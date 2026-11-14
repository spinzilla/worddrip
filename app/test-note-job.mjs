/** 073 录入笔记识别任务：状态流转、剩余时间估算、逐页合并、取消、切后台重试、完成提示。纯逻辑，用假识别函数，不联网。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundled = path.resolve('src-tauri/target/vocab-inbox-tests', `note-job-${process.pid}.mjs`);
fs.mkdirSync(path.dirname(bundled), { recursive: true });
await build({
  entryPoints: ['utils/vocab/noteJob.ts'],
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
const j = await import(pathToFileURL(bundled).href);

let clock = 1_000_000;
const tick = ms => { clock += ms; };
const page = n => ({ id: `p${n}`, label: `第${n}页`, thumb: '', base64: `b${n}`, mimeType: 'image/jpeg' });
const word = (w, note = '', uncertain = false) => ({ word: w, note, uncertain });
const visibility = () => {
  let hidden = 0; let isHidden = false; const waiters = [];
  return {
    api: { hiddenCount: () => hidden, isHidden: () => isHidden, waitVisible: () => (isHidden ? new Promise(r => waiters.push(r)) : Promise.resolve()) },
    hide() { hidden++; isHidden = true; },
    show() { isHidden = false; waiters.splice(0).forEach(r => r()); },
  };
};
/** 可手动放行的假识别：每次调用挂起，测试里用 settle(页号, 结果) 放行。 */
const makeEnv = (overrides = {}) => {
  const calls = [];
  const vis = visibility();
  const job = j.createNoteJob({
    recognize: (image, hooks, signal) => new Promise((resolve, reject) => { calls.push({ image, hooks, signal, resolve, reject }); }),
    browseExisting: async () => new Set(['candid']),
    now: () => clock,
    getModel: () => 'fake-vision',
    modelReady: () => true,
    newId: (() => { let n = 0; return () => `id${++n}`; })(),
    visibility: vis.api,
    concurrency: 2,
    ...overrides,
  });
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  return { job, calls, vis, flush };
};
const stageOf = (job, n) => job.getState().states[`p${n}`]?.stage;

// ---- 纯函数：时间格式与估算
assert.equal(j.formatDuration(45_000), '45 秒');
assert.equal(j.formatDuration(80_000), '1 分 20 秒');
assert.equal(j.formatDuration(120_000), '2 分钟');
assert.equal(j.estimateRemainingMs([], 5, 3), null, '没有完成页 → 估算中');
assert.equal(j.estimateRemainingMs([10_000, 20_000], 0, 3), 0);
assert.equal(j.estimateRemainingMs([10_000, 20_000], 6, 3), 30_000, '平均 15 秒 × 2 轮');
assert.equal(j.estimateRemainingMs([10_000], 4, 3), 20_000, '4 页 / 3 并发 = 2 轮');
assert.equal(j.formatEstimate(118_000), '约 2 分钟');
assert.equal(j.formatEstimate(40_000), '约 40 秒');

// ---- 状态流转 + 逐页合并 + 完成提示
{
  const { job, calls, flush } = makeEnv();
  job.addPages([1, 2, 3].map(page));
  assert.equal(job.getState().started, false);
  let seen = 0;
  job.subscribe(() => { seen++; });
  const run = job.start();
  await flush();
  assert.equal(job.getState().running, true);
  assert.equal(job.getState().model, 'fake-vision');
  assert.equal(calls.length, 2, '并发 2：先发两页');
  assert.equal(stageOf(job, 1), 'preparing');
  assert.equal(stageOf(job, 3), 'pending', '第三页排队中');
  calls[0].hooks.onStage('uploading');
  assert.equal(stageOf(job, 1), 'uploading');
  calls[0].hooks.onStage('waiting');
  assert.equal(stageOf(job, 1), 'waiting');
  const since = job.getState().states.p1.stageSince;
  tick(7000);
  calls[1].hooks.onChars(120);
  assert.equal(stageOf(job, 2), 'streaming');
  assert.equal(job.getState().states.p2.chars, 120);
  assert.equal(job.getState().states.p2.streamed, true);
  assert.equal(since, 1_000_000, 'stageSince 是进入阶段的时刻');

  // 第 2 页先完成：候选里立刻有它的词（标第 2 页），第 3 页开跑
  tick(3000);
  calls[1].resolve([word('Candid', '坦率'), word('alpha')]);
  await flush();
  const mid = job.getState();
  assert.equal(stageOf(job, 2), 'done');
  assert.equal(mid.states.p2.words, 2);
  assert.deepEqual(mid.candidates.map(c => [c.word, c.pages, c.checked]), [['Candid', [2], false], ['alpha', [2], true]], '已存在的词默认不勾');
  assert.equal(mid.running, true);
  assert.equal(calls.length, 3, '腾出一个名额，第 3 页开跑');
  const prog = j.progressOf(mid, clock, 2);
  assert.equal(prog.settled, 1);
  assert.equal(prog.total, 3);
  assert.equal(prog.elapsedMs, 10_000);
  assert.equal(prog.remainingMs, 10_000 * 1, '1 页完成用时约 10 秒，剩 2 页 / 并发 2 = 1 轮');

  calls[0].resolve([word('beta'), word('candid', '例句')]);
  await flush();
  // 第 1 页后完成：并进已有条目，页码 [1,2]；最后按页码排序
  calls[2].resolve([word('gamma')]);
  await run;
  const end = job.getState();
  assert.equal(end.running, false);
  assert.ok(end.finishedAt);
  const byWord = Object.fromEntries(end.candidates.map(c => [c.word.toLowerCase(), c]));
  assert.deepEqual(byWord.candid.pages, [1, 2]);
  assert.equal(byWord.candid.note, '例句；坦率', '结束后按页码从小到大对齐规范合并（和原来 mergeNotePages 一致）');
  assert.equal(byWord.candid.word, 'candid', '拼写以最小页码那页为准');
  assert.deepEqual(end.candidates.map(c => c.pages[0]), [...end.candidates.map(c => c.pages[0])].sort((a, b) => a - b), '结束后按页码先后排列');
  assert.match(end.notice, /识别出 4 条候选/);
  assert.deepEqual(end.unseen, { words: 4, failed: 0 }, '用户不在录笔记页 → 记下完成提示');
  assert.ok(seen > 5);
  job.setViewing(true);
  assert.equal(job.getState().unseen, null, '看到录笔记页就清掉提示');
}

// ---- 正在看录笔记页时不记提示；失败页 + 单页重试
{
  const { job, calls, flush } = makeEnv();
  job.setViewing(true);
  job.addPages([1, 2].map(page));
  const run = job.start();
  await flush();
  calls[0].resolve([word('one')]);
  calls[1].reject(new Error('视觉模型返回 HTTP 500。请检查模型名称、接口地址和密钥。'));
  await run;
  const s = job.getState();
  assert.equal(stageOf(job, 2), 'failed');
  assert.equal(s.unseen, null);
  assert.match(s.notice, /1 页失败/);
  assert.equal(s.candidates.length, 1);
  const retry = job.retryPage('p2');
  await flush();
  assert.equal(job.getState().running, true);
  calls[2].resolve([word('two')]);
  await retry;
  assert.deepEqual(job.getState().candidates.map(c => c.word), ['one', 'two']);
  assert.equal(stageOf(job, 2), 'done');
}

// ---- 取消：后续页停止，已完成页的词保留，取消后迟到的结果不再写入
{
  const { job, calls, flush } = makeEnv();
  job.setViewing(true);
  job.addPages([1, 2, 3, 4].map(page));
  const run = job.start();
  await flush();
  calls[0].resolve([word('kept')]);
  await flush();
  assert.equal(calls.length, 3);
  job.cancel();
  await run;
  const s = job.getState();
  assert.equal(s.running, false);
  assert.deepEqual([1, 2, 3, 4].map(n => stageOf(job, n)), ['done', 'cancelled', 'cancelled', 'cancelled']);
  assert.equal(calls.length, 3, '取消后不再开新页');
  assert.match(s.notice, /已取消。已识别的 1 页保留，共 1 条候选/);
  calls[1].resolve([word('late')]);
  await flush();
  assert.deepEqual(job.getState().candidates.map(c => c.word), ['kept'], '取消后迟到的结果不写');
  assert.equal(job.getState().unseen, null, '主动取消不弹完成提示');
}

// ---- 切到后台：被打断的页自动重试一次，并写明提示；非连接类错误不重试
{
  const { job, calls, vis, flush } = makeEnv();
  job.setViewing(true);
  job.addPages([page(1)]);
  const run = job.start();
  await flush();
  vis.hide();
  calls[0].reject(new Error('连接视觉模型失败，请检查网络、接口地址和密钥后重试。'));
  await flush();
  assert.equal(stageOf(job, 1), 'preparing', '后台期间失败：先等回前台');
  assert.equal(calls.length, 1);
  vis.show();
  await flush();
  assert.equal(calls.length, 2, '回前台后自动重试一次');
  assert.equal(job.getState().states.p1.hint, '刚才切到后台，已自动重试');
  calls[1].reject(new Error('连接视觉模型失败，请检查网络、接口地址和密钥后重试。'));
  await run;
  assert.equal(stageOf(job, 1), 'failed', '只自动重试一次');
  assert.equal(calls.length, 2);
}
{
  const { job, calls, vis, flush } = makeEnv();
  job.addPages([page(1)]);
  const run = job.start();
  await flush();
  vis.hide(); vis.show();
  calls[0].reject(new Error('视觉模型返回 HTTP 401：bad key。请检查模型名称、接口地址和密钥。'));
  await run;
  assert.equal(calls.length, 1, 'HTTP 错误不是被打断，不重试');
  assert.equal(stageOf(job, 1), 'failed');
}

// ---- 没配模型 / 重新选择 / 页数锁定
{
  const { job, calls, flush } = makeEnv({ modelReady: () => false });
  job.addPages([page(1)]);
  await job.start();
  assert.match(job.getState().error, /请先在设置中配置/);
  assert.equal(calls.length, 0);
  assert.equal(job.getState().started, false);
}
{
  const { job, calls, flush } = makeEnv();
  job.addPages([page(1), page(2)]);
  job.removePage('p2');
  assert.equal(job.getState().pages.length, 1);
  const run = job.start();
  await flush();
  job.addPages([page(9)]);
  assert.equal(job.getState().pages.length, 1, '开始后页面列表锁定');
  job.reset();
  await run;
  assert.equal(job.getState().started, false);
  assert.equal(job.getState().pages.length, 0);
  calls[0].resolve([word('ghost')]);
  await flush();
  assert.equal(job.getState().candidates.length, 0, '重置后旧结果不写回');
}

console.log('录入笔记识别任务测试通过：状态流转、逐页合并、剩余时间估算、取消、单页重试、切后台自动重试、完成提示、重置。');
