import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// 090 AI 任务中心与流式：SSE 解析、退回普通请求、任务中心（订阅/取消/重试/追问/锁/保留 20 条）。
const outStream = join(tmpdir(), `ai-stream-${process.pid}.mjs`);
const outCenter = join(tmpdir(), `ai-center-${process.pid}.mjs`);
await build({ entryPoints: ['utils/aiTasks/stream.ts'], bundle: true, format: 'esm', outfile: outStream });
await build({ entryPoints: ['utils/aiTasks/center.ts'], bundle: true, format: 'esm', outfile: outCenter });
const S = await import(pathToFileURL(outStream).href);
const C = await import(pathToFileURL(outCenter).href);

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (fn, what) => {
  for (let i = 0; i < 200; i += 1) { if (fn()) return; await tick(5); }
  throw new Error(`等不到：${what}`);
};

// ---------- SSE 解析 ----------
{
  const splitter = new S.ThinkSplitter();
  const lines = new S.SseLineReader();
  const collect = (chunks) => {
    let text = ''; let thinking = ''; let done = false;
    for (const chunk of chunks) {
      for (const payload of lines.push(chunk)) {
        const parsed = S.parseSseData(payload, splitter);
        if (parsed === 'done') { done = true; continue; }
        if (parsed?.text) text += parsed.text;
        if (parsed?.thinking) thinking += parsed.thinking;
      }
    }
    for (const payload of lines.end()) { const parsed = S.parseSseData(payload, splitter); if (parsed && parsed !== 'done') { text += parsed.text ?? ''; thinking += parsed.thinking ?? ''; } }
    const tail = splitter.flush(); text += tail.text ?? ''; thinking += tail.thinking ?? '';
    return { text, thinking, done };
  };
  const ev = delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;

  // 正文增量 + reasoning_content 增量 + [DONE]
  let r = collect([ev({ reasoning_content: '想' }), ev({ content: 'Hi' }), ev({ content: ' there' }), 'data: [DONE]\n\n']);
  assert.deepEqual(r, { text: 'Hi there', thinking: '想', done: true });

  // 跨块断开的一行（一条 data 被拆成三块，还夹着 \r\n）
  const whole = ev({ content: 'ABCDEF' }).replace(/\n/g, '\r\n');
  const cut1 = whole.slice(0, 9); const cut2 = whole.slice(9, 30); const cut3 = whole.slice(30);
  r = collect([cut1, cut2, cut3, 'data: [DONE]\r\n\r\n']);
  assert.equal(r.text, 'ABCDEF', '跨块断开的行能拼回来');
  assert.equal(r.done, true);

  // <think> 段：正文里的思考归思考；标签本身被拆在两块里也要认
  r = collect([ev({ content: '<th' }), ev({ content: 'ink>内心' }), ev({ content: '戏</thi' }), ev({ content: 'nk>答案' })]);
  assert.deepEqual({ text: r.text, thinking: r.thinking }, { text: '答案', thinking: '内心戏' });

  // 不是标签的 < 不丢；注释行/空行/坏 JSON 忽略
  r = collect([': keep-alive\n\n', 'data: {坏的\n\n', ev({ content: '1 < 2' })]);
  assert.equal(r.text, '1 < 2');

  // 最后一行没有换行也处理
  r = collect([`data: ${JSON.stringify({ choices: [{ delta: { content: 'tail' } }] })}`]);
  assert.equal(r.text, 'tail');

  // 流里的 error 事件 → 抛错，且不带多余内容
  assert.throws(() => S.parseSseData(JSON.stringify({ error: { message: 'quota exceeded' } }), new S.ThinkSplitter()), /quota exceeded/);
}

// ---------- streamCompletion：流式与退回 ----------
const enc = new TextEncoder();
const sseResponse = (chunks, headers = { 'content-type': 'text/event-stream' }) => new Response(new ReadableStream({
  async start(controller) { for (const c of chunks) { controller.enqueue(enc.encode(c)); await tick(5); } controller.close(); },
}), { status: 200, headers });
const ev = delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;

{
  const bodies = [];
  const fetchFn = async (_url, init) => { bodies.push(JSON.parse(init.body)); return sseResponse([ev({ reasoning_content: 'T' }), ev({ content: 'A' }), ev({ content: 'B' }), 'data: [DONE]\n\n']); };
  const got = { text: [], think: [] };
  const res = await S.streamCompletion({ fetchFn, url: 'http://x/v1/chat/completions', apiKey: 'sk-secret-key-12345678', body: { model: 'm', temperature: 0.3, messages: [] }, onText: d => got.text.push(d), onThink: d => got.think.push(d) });
  assert.deepEqual(got, { text: ['A', 'B'], think: ['T'] });
  assert.deepEqual({ text: res.text, thinking: res.thinking, streamed: res.streamed }, { text: 'AB', thinking: 'T', streamed: true });
  assert.equal(bodies[0].stream, true, '请求带 stream:true');
}
{
  // 服务端不回 event-stream：整段 JSON 当一次增量
  const fetchFn = async () => new Response(JSON.stringify({ choices: [{ message: { content: '<think>想</think>完整回答', reasoning_content: '先' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const texts = []; const thinks = [];
  const res = await S.streamCompletion({ fetchFn, url: 'u', apiKey: 'k', body: { model: 'm' }, onText: d => texts.push(d), onThink: d => thinks.push(d) });
  assert.deepEqual(texts, ['完整回答']);
  assert.equal(res.streamed, false);
  assert.equal(res.thinking, '先想');
}
{
  // 400 说不支持 stream：自动去掉 stream 重发普通请求
  const calls = [];
  const fetchFn = async (_u, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    if (body.stream) return new Response(JSON.stringify({ error: { message: 'stream is not supported' } }), { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok-plain' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const res = await S.streamCompletion({ fetchFn, url: 'u', apiKey: 'k', body: { model: 'm' } });
  assert.equal(res.text, 'ok-plain');
  assert.equal(res.streamed, false);
  assert.ok(calls.some(b => b.stream === true) && calls.some(b => !('stream' in b)), '先带 stream 再不带');
}
{
  // 400 重试去掉 temperature 仍保留；报错不含 API key
  const calls = [];
  const key = 'sk-abcdef1234567890abcdef';
  const fetchFn = async (_u, init) => { const body = JSON.parse(init.body); calls.push(body); return 'temperature' in body ? new Response('bad temperature', { status: 400 }) : sseResponse([ev({ content: 'fine' }), 'data: [DONE]\n\n']); };
  const res = await S.streamCompletion({ fetchFn, url: 'u', apiKey: key, body: { model: 'm', temperature: 0.3 } });
  assert.equal(res.text, 'fine');
  assert.equal(calls.length, 2, '400 去掉 temperature 重试一次');
  const failing = async () => new Response(`invalid key ${key}`, { status: 401 });
  await assert.rejects(() => S.streamCompletion({ fetchFn: failing, url: 'u', apiKey: key, body: { model: 'm' } }), error => {
    assert.ok(!error.message.includes(key), '报错不带 API key');
    assert.match(error.message, /HTTP 401/);
    return true;
  });
  // SSE 流里的 error 事件回显了 key：抛出的错误也不能带 key（对象形式、字符串形式各一次）
  for (const errPayload of [{ error: { message: `bad key ${key} rejected` } }, { error: `bad key ${key} rejected` }]) {
    const echo = async () => sseResponse([`data: ${JSON.stringify(errPayload)}\n\n`]);
    await assert.rejects(() => S.streamCompletion({ fetchFn: echo, url: 'u', apiKey: key, body: { model: 'm' } }), error => {
      assert.ok(!error.message.includes(key), 'SSE 错误事件也不带 API key');
      assert.match(error.message, /模型返回错误/);
      return true;
    });
  }
}
{
  // 空闲超时 & 取消
  const hang = async (_u, init) => new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('Request cancelled'))); });
  await assert.rejects(() => S.streamCompletion({ fetchFn: hang, url: 'u', apiKey: 'k', body: {}, idleTimeoutMs: 30 }), /超时/);
  const controller = new AbortController();
  const pending = S.streamCompletion({ fetchFn: hang, url: 'u', apiKey: 'k', body: {}, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(() => pending, error => error instanceof S.RequestCancelledError);
}

// ---------- 任务中心 ----------
const memoryStorage = () => { const map = new Map(); return { map, getItem: k => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } }; };
let idCounter = 0;
const makeCenter = (run, extra = {}) => C.createAiTaskCenter({ run, storage: extra.storage ?? null, now: () => Date.now(), newId: () => `t${++idCounter}`, ...extra });
/** 可控的假请求：测试里手动「吐字」「结束」。 */
const controllable = () => {
  const calls = [];
  const run = args => new Promise((resolve, reject) => {
    const call = { args, text: '', resolve: (text, thinking = '') => resolve({ text, thinking, streamed: true }), reject };
    args.signal.addEventListener('abort', () => reject(new Error('aborted')));
    call.emit = piece => { call.text += piece; args.onText(piece); };
    call.think = piece => args.onThink(piece);
    calls.push(call);
  });
  return { run, calls };
};

{
  // 两个订阅者都收到增量；完成后消息里有问有答
  const { run, calls } = controllable();
  const center = makeCenter(run);
  const created = center.create({ title: '让 AI 看：agenda 的例句', source: { kind: 'example', word: 'agenda' }, prompt: '看看这句' });
  assert.ok(created.ok);
  const id = created.task.id;
  const seenAll = []; const seenOne = [];
  center.subscribe(() => seenAll.push(center.getTask(id).text));
  center.subscribeTask(id, () => seenOne.push(center.getTask(id).thinking));
  await tick();
  assert.equal(center.getTask(id).status, 'running');
  calls[0].think('想'); calls[0].emit('He'); calls[0].emit('llo');
  assert.ok(seenAll.includes('He') && seenAll.includes('Hello'), '全部任务订阅者收到增量');
  assert.ok(seenOne.includes('想'), '单任务订阅者收到思考增量');
  assert.equal(center.getTask(id).text, 'Hello');
  assert.deepEqual(center.findBySource({ kind: 'example', word: 'agenda' }).map(t => t.id), [id], '按来源找回任务');
  calls[0].resolve('Hello', '想');
  await waitFor(() => center.getTask(id).status === 'done', '任务完成');
  const done = center.getTask(id);
  assert.deepEqual(done.messages.map(m => m.role), ['user', 'assistant']);
  assert.equal(done.messages[1].thinking, '想');
  assert.ok(done.startedAt && done.endedAt && done.firstChunkAt);

  // 追问：带上之前的问答
  const follow = center.followUp(id, '再解释一下');
  assert.ok(follow.ok);
  await tick();
  assert.deepEqual(calls[1].args.messages.map(m => `${m.role}:${m.content}`), ['user:看看这句', 'assistant:Hello', 'user:再解释一下']);
  calls[1].resolve('第二轮');
  await waitFor(() => center.getTask(id).status === 'done', '追问完成');
  assert.equal(center.getTask(id).messages.length, 4);
  assert.equal(center.getTask(id).text, '第二轮');
}
{
  // 取消：状态「已取消」，之后迟到的增量不再收
  const { run, calls } = controllable();
  const center = makeCenter(run);
  const { task } = center.create({ title: 'a', source: { kind: 'x' }, prompt: 'q' });
  await tick();
  calls[0].emit('abc');
  assert.equal(center.cancel(task.id), true);
  assert.equal(center.getTask(task.id).status, 'cancelled');
  calls[0].emit('LATE'); calls[0].think('LATE');
  await tick(10);
  assert.equal(center.getTask(task.id).text, 'abc', '取消后不再收增量');
  assert.equal(center.getTask(task.id).thinking, '');
  assert.equal(center.getTask(task.id).status, 'cancelled', '迟到的失败不会把「已取消」改掉');
  // 重试：重新请求，同一条用户消息
  assert.equal(center.retry(task.id), true);
  await tick();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args.messages, [{ role: 'user', content: 'q' }]);
  assert.equal(center.getTask(task.id).text, '');
  calls[1].emit('new'); calls[1].resolve('new');
  await waitFor(() => center.getTask(task.id).status === 'done', '重试完成');
  assert.equal(center.getTask(task.id).text, 'new');
  // 失败后重试
  const failed = center.create({ title: 'f', source: { kind: 'x' }, prompt: 'q2' }).task;
  await tick();
  calls[2].reject(new Error('连接模型失败'));
  await waitFor(() => center.getTask(failed.id).status === 'failed', '失败');
  assert.equal(center.getTask(failed.id).error, '连接模型失败');
  assert.equal(center.retry(failed.id), true);
}
{
  // 结构化结果；排队（最多同时 3 个）
  const { run, calls } = controllable();
  const center = makeCenter(run, { maxConcurrent: 1 });
  const first = center.create({ title: '1', source: { kind: 'x' }, prompt: '1', parseResult: text => ({ n: Number(text) }) }).task;
  const second = center.create({ title: '2', source: { kind: 'x' }, prompt: '2' }).task;
  await tick();
  assert.equal(center.getTask(second.id).status, 'queued', '超过并发数先排队');
  calls[0].resolve('42');
  await waitFor(() => center.getTask(first.id).status === 'done', '第一个完成');
  assert.deepEqual(center.getTask(first.id).result, { n: 42 });
  await waitFor(() => center.getTask(second.id).status === 'running', '排队的接着跑');
}
{
  // 作答锁
  const { run, calls } = controllable();
  const center = makeCenter(run);
  const running = center.create({ title: '后台', source: { kind: 'quicknote', noteId: 'n1' }, prompt: 'q', mode: 'task' }).task;
  await tick();
  center.lockPanel('正在做题');
  assert.equal(center.isLocked(), true);
  assert.equal(center.getLock(), '正在做题');
  const denied = center.create({ title: '直接问', source: { kind: 'direct' }, prompt: 'hi', mode: 'direct' });
  assert.equal(denied.ok, false, '锁定时新建「直接问」被拒');
  assert.equal(center.getTasks().length, 1);
  assert.equal(center.create({ title: '另一个后台', source: { kind: 'quicknote', noteId: 'n2' }, prompt: 'q', mode: 'task' }).ok, true, '非直接问不受锁影响');
  calls[0].emit('still going'); calls[0].resolve('still going');
  await waitFor(() => center.getTask(running.id).status === 'done', '已在跑的任务照跑');
  assert.equal(center.getTask(running.id).text, 'still going');
  center.unlockPanel();
  assert.equal(center.isLocked(), false);
  assert.equal(center.create({ title: '直接问', source: { kind: 'direct' }, prompt: 'hi', mode: 'direct' }).ok, true);
}
{
  // 保留 20 条、不存 key、重启后「进行中」变「中断了」
  const storage = memoryStorage();
  const SECRET = 'sk-test-secret-should-never-be-stored';
  const run = async args => { args.onText('r'); return { text: `answer:${args.messages.at(-1).content}`, thinking: '', streamed: true }; };
  const center = makeCenter(run, { storage });
  const ids = [];
  for (let i = 1; i <= 21; i += 1) {
    const { task } = center.create({ title: `任务${i}`, source: { kind: 'x' }, prompt: `问题${i}` });
    ids.push(task.id);
    await waitFor(() => center.getTask(task.id)?.status === 'done', `任务 ${i} 完成`);
  }
  assert.equal(center.getTasks().length, 20, '最多保留 20 条');
  assert.equal(center.getTask(ids[0]), undefined, '第 21 条进来，最旧的被删');
  assert.ok(center.getTask(ids[20]));
  const stored = storage.map.get(C.AI_TASKS_STORAGE_KEY);
  assert.ok(stored && JSON.parse(stored).tasks.length === 20);
  assert.ok(!stored.includes(SECRET) && !/apiKey|api_key|Authorization/i.test(stored), '存的内容里没有 API key');

  // 模拟重启：一个任务停在进行中
  const { run: hang } = controllable();
  const center2 = makeCenter(hang, { storage });
  const live = center2.create({ title: '没跑完', source: { kind: 'x' }, prompt: 'zz' }).task;
  await tick();
  assert.equal(center2.getTask(live.id).status, 'running');
  const center3 = makeCenter(run, { storage }); // 同一份存储 = 重启
  const revived = center3.getTask(live.id);
  assert.ok(revived, '重启后读回');
  assert.equal(revived.status, 'failed');
  assert.equal(revived.interrupted, true);
  assert.match(revived.error, /中断了，可重试/);
  assert.equal(center3.retry(live.id), true, '中断的任务可以重试');
  await waitFor(() => center3.getTask(live.id).status === 'done', '重试完成');
  assert.equal(center3.getTask(live.id).text, 'answer:zz');
}

{
  // 093：结构化结果的解析函数按 resultKind 找回（不靠内存闭包）：重启后点「重试」，结果照样解析出来
  const storage = memoryStorage();
  const parsers = { 'demo-kind': (text, args) => ({ n: Number(text), tag: args.tag }) };
  const first = controllable();
  const center1 = makeCenter(first.run, { storage, resultParsers: parsers });
  const made = center1.create({ title: 'demo', source: { kind: 'demo' }, prompt: 'p', resultKind: 'demo-kind', resultArgs: { tag: 'T' } });
  assert.ok(made.ok);
  await tick();
  first.calls[0].reject(new Error('boom')); // 第一次失败（比如断网）
  await waitFor(() => center1.getTask(made.task.id).status === 'failed', '第一次失败');
  assert.match(storage.map.get(C.AI_TASKS_STORAGE_KEY), /"resultKind":"demo-kind"/, '结果类型名存盘');
  assert.match(storage.map.get(C.AI_TASKS_STORAGE_KEY), /"tag":"T"/, '解析参数存盘');

  const second = controllable();
  const center2 = makeCenter(second.run, { storage, resultParsers: parsers }); // 重启：同一份存储，新的中心，没有内存里的解析函数
  assert.equal(center2.retry(made.task.id), true, '失败的结构化任务可以重试');
  await tick();
  second.calls[0].resolve('42');
  await waitFor(() => center2.getTask(made.task.id).status === 'done', '重试完成');
  assert.deepEqual(center2.getTask(made.task.id).result, { n: 42, tag: 'T' }, '重启后重试也能解析出结果');
}

console.log('test-ai-tasks 全部通过');
