// 084 待做题本机缓存测试：node test-vocab-recall-cache.mjs（在 app 目录下）。
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({
  entryPoints: ['utils/vocab/recallCache.ts'], bundle: true, format: 'esm', write: false, logLevel: 'silent',
});
const cache = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}
const storage = () => new MemoryStorage();
const def = (english, sentence = 'Researchers often observe resilient systems during long periods of testing.') => ({
  pos: 'adj.', english, chinese: '', examples: [{ seq: 1, sentence, ai: false }],
});
const word = (id = 'resilient@1.1', english = 'able to recover quickly', sentence) => ({
  id, word: 'resilient', definitions: [def(english, sentence)],
});
const exampleOptions = { generate: null };
const modelOptions = generate => ({ generate });
const draftGenerator = calls => async requests => {
  calls.count += 1;
  return requests.map(request => ({
    id: request.id,
    meaning: 'able to recover quickly',
    sentence: 'Researchers considered the system [[resilient]] after many difficult tests.',
  }));
};

// 命中时直接用缓存，不再调用模型。
{
  const local = storage();
  const calls = { count: 0 };
  const item = word('model@1', 'able to recover quickly', 'The phrase has no target and is not a usable example.');
  const options = modelOptions(draftGenerator(calls));
  const first = await cache.prepareCachedRecallRound([item], options, local, 1000);
  assert.equal(first.questions.length, 1);
  assert.equal(calls.count, 1);
  const second = await cache.prepareCachedRecallRound([item], options, local, 2000);
  assert.equal(second.questions[0].context.before, first.questions[0].context.before);
  assert.equal(calls.count, 1, '缓存命中不得再次调用模型');
}

// 词条释义和例句有变化，指纹不匹配，旧题不能沿用。
{
  const local = storage();
  const original = word();
  const first = await cache.prepareCachedRecallRound([original], exampleOptions, local, 1000);
  const meaningChanged = word(original.id, 'able to recover quickly after difficulty');
  const second = await cache.prepareCachedRecallRound([meaningChanged], exampleOptions, local, 2000);
  assert.notEqual(second.questions[0].meaning, first.questions[0].meaning, '释义更新后使用重新生成的题');
  const exampleChanged = word(original.id, meaningChanged.definitions[0].english,
    'A resilient approach helps communities recover from severe disruption and rebuild together.');
  const third = await cache.prepareCachedRecallRound([exampleChanged], exampleOptions, local, 3000);
  assert.notEqual(third.questions[0].context.before, second.questions[0].context.before, '例句更新后使用重新生成的题');
}

// 保存超过 7 天的题视为过期并重新出题。
{
  const local = storage();
  const calls = { count: 0 };
  const item = word('old@1', 'able to recover quickly', 'No usable example here at all.');
  const options = modelOptions(draftGenerator(calls));
  await cache.prepareCachedRecallRound([item], options, local, 10);
  const refreshed = await cache.prepareCachedRecallRound([item], options, local, 10 + cache.RECALL_CACHE_TTL_MS + 1);
  assert.equal(refreshed.questions.length, 1);
  assert.equal(calls.count, 2, '过期题应重新出题');
}

// 判完分、标出错的题都可通过同一删除入口消耗；半轮退出只留未完成的题。
{
  const local = storage();
  const items = [word('one@1'), word('two@1'), word('three@1')];
  await cache.prepareCachedRecallRound(items, exampleOptions, local, 100);
  cache.consumePendingRecallQuestion(items[0].id, local); // 判完分
  cache.consumePendingRecallQuestion(items[1].id, local); // 点「这题出错了」
  const resumed = await cache.prepareCachedRecallRound([items[2]], exampleOptions, local, 200);
  assert.deepEqual(resumed.questions.map(question => question.wordId), ['three@1'], '只应留下还没做的题');
  assert.deepEqual(resumed.questions[0].answers, ['resilient']);
}

// 出题请求开始后退出：即使页面不再显示结果，完成的题仍写进缓存。
{
  const local = storage();
  const calls = { count: 0 };
  let finish;
  const item = word('late@1', 'able to recover quickly', 'No usable example here at all.');
  const pending = cache.prepareCachedRecallRound([item], {
    generate: async requests => {
      calls.count += 1;
      return new Promise(resolve => { finish = () => resolve(requests.map(request => ({
        id: request.id,
        meaning: 'able to recover quickly',
        sentence: 'Researchers considered the system [[resilient]] after many difficult tests.',
      }))); });
    },
  }, local, 100);
  while (!finish) await Promise.resolve();
  // 模拟退出：UI token 作废，但不取消仍进行中的准备过程。
  finish();
  await pending;
  const again = await cache.prepareCachedRecallRound([item], modelOptions(draftGenerator(calls)), local, 200);
  assert.equal(again.questions.length, 1);
  assert.equal(calls.count, 1, '退出后返回的题应已缓存，重进不再调模型');
}

// 缓存不挤掉更早到期的词：缓存 charlie，limit=2 仍按队列顺序得到 [alpha, bravo]，charlie 的缓存保留。
{
  const local = storage();
  const calls = { count: 0 };
  const options = modelOptions(draftGenerator(calls));
  const alpha = word('alpha@1', 'able to recover quickly', 'No usable example for alpha here.');
  const bravo = word('bravo@1', 'able to recover quickly', 'No usable example for bravo here.');
  const charlie = word('charlie@1', 'able to recover quickly', 'No usable example for charlie here.');
  await cache.prepareCachedRecallRound([charlie], options, local, 100);
  assert.equal(calls.count, 1);
  const round = await cache.prepareCachedRecallRound([alpha, bravo, charlie], { ...options, limit: 2 }, local, 200);
  assert.deepEqual(round.questions.map(question => question.wordId), ['alpha@1', 'bravo@1'], '按队列顺序取前 limit 个词');
  assert.equal(round.remaining, 1, '还剩 charlie 一个没轮到');
  assert.equal(calls.count, 2, '只为 alpha、bravo 请求模型，charlie 命中缓存');
  const kept = JSON.parse(local.getItem(cache.RECALL_CACHE_KEY));
  assert.ok(kept['charlie@1'], 'charlie 的缓存还在');
}

// 没有模型时存的题，换成有模型出题 → 作废并重新请求。
{
  const local = storage();
  const calls = { count: 0 };
  const item = word('mode@1', 'able to recover quickly', 'The phrase has no target and is not a usable example.');
  await cache.prepareCachedRecallRound([item], exampleOptions, local, 100);
  const withModel = await cache.prepareCachedRecallRound([item], modelOptions(draftGenerator(calls)), local, 200);
  assert.equal(calls.count, 1, '出题方式变了，旧题作废并重新请求');
  assert.equal(withModel.questions.length, 1);
}

// 出题方式变了（混入改写/造句的开关）也作废。
{
  const local = storage();
  const calls = { count: 0 };
  const item = word('mix@1', 'able to recover quickly', 'No usable example here at all.');
  const plain = { ...modelOptions(draftGenerator(calls)), mix: false };
  await cache.prepareCachedRecallRound([item], plain, local, 100);
  await cache.prepareCachedRecallRound([item], { ...plain, mix: true, generateUsage: async () => [] }, local, 200);
  assert.equal(calls.count, 2, '混入改写/造句后旧题作废');
}

// 只改中文释义 → 作废。
{
  const local = storage();
  const original = word('chinese@1');
  await cache.prepareCachedRecallRound([original], exampleOptions, local, 100);
  const edited = { ...original, definitions: [{ ...original.definitions[0], chinese: '新的中文释义' }] };
  const cached = JSON.parse(local.getItem(cache.RECALL_CACHE_KEY))['chinese@1'];
  assert.notEqual(cache.recallWordFingerprint(edited), cached.fingerprint, '中文释义进入指纹');
  const again = await cache.prepareCachedRecallRound([edited], exampleOptions, local, 200);
  assert.equal(again.questions.length, 1);
  assert.equal(JSON.parse(local.getItem(cache.RECALL_CACHE_KEY))['chinese@1'].fingerprint, cache.recallWordFingerprint(edited), '按新指纹重存');
}

// 读一次缓存后，不在本轮队列里的过期条目也被删掉；未过期的保留。
{
  const local = storage();
  const stale = word('stale@1', 'able to recover quickly', 'No usable example for stale here.');
  const fresh = word('fresh@1', 'able to recover quickly', 'No usable example for fresh here.');
  const other = word('other@1', 'able to recover quickly', 'No usable example for other here.');
  await cache.prepareCachedRecallRound([stale], exampleOptions, local, 0);
  await cache.prepareCachedRecallRound([fresh], exampleOptions, local, cache.RECALL_CACHE_TTL_MS);
  await cache.prepareCachedRecallRound([other], exampleOptions, local, cache.RECALL_CACHE_TTL_MS + 10);
  const kept = Object.keys(JSON.parse(local.getItem(cache.RECALL_CACHE_KEY))).sort();
  assert.deepEqual(kept, ['fresh@1', 'other@1'], '超过 7 天的 stale 被清掉，不在队列里也清');
}

// 没有缓存的旧式条目（没有出题方式字段）视为无效。
{
  const local = storage();
  const item = word('legacy@1', 'able to recover quickly', 'No usable example for legacy here.');
  const fingerprint = cache.recallWordFingerprint(item);
  local.setItem(cache.RECALL_CACHE_KEY, JSON.stringify({ 'legacy@1': { fingerprint, savedAt: 100, question: { wordId: 'legacy@1', target: 'resilient', answers: ['resilient'] } } }));
  const calls = { count: 0 };
  await cache.prepareCachedRecallRound([item], modelOptions(draftGenerator(calls)), local, 200);
  assert.equal(calls.count, 1, '没有出题方式的旧条目不再使用');
}

console.log('待做题缓存测试通过：模型命中、内容指纹（含中文释义）、出题方式、7 天过期并清理、队列顺序、消耗/半轮退出、迟到结果持久化。');
