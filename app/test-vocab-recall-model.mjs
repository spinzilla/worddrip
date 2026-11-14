// 030 复习出题模型客户端：真实请求代码 + 本机假 OpenAI 兼容服务，不调用真实模型。
// 用法（在 app 目录）：node test-vocab-recall-model.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundled = path.resolve('src-tauri/target/vocab-recall-tests', `recall-model-${process.pid}.mjs`);
fs.mkdirSync(path.dirname(bundled), { recursive: true });
await build({
  stdin: {
    contents: "export * from './utils/vocab/recall.ts'; export * from './utils/vocab/recallModel.ts';",
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
const NOTE = '复习备注不能发给模型';
const queue = [
  { id: 'resilient@9.1', word: 'resilient', note: NOTE, definitions: [{ sourceFile: '20260901.md', sourceLine: 3, pos: 'adj.', english: 'able to recover quickly from difficulty', chinese: '有韧性的', examples: [] }] },
  { id: 'candid@9.2', word: 'candid', note: NOTE, definitions: [] },
];
const drafts = [
  { id: 'resilient@9.1', meaning: 'able to recover quickly', sentence: 'Small island economies must become more [[resilient]] to cope with extreme weather.' },
  { id: 'candid@9.2', meaning: 'honest and direct', sentence: 'In the interview, the minister gave a surprisingly [[candid]] account of the failures.' },
];

const requests = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push({ url: req.url, body, auth: req.headers.authorization });
  res.setHeader('Content-Type', 'application/json');
  const answer = content => res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  if (req.url === '/normal/chat/completions') return answer(JSON.stringify({ questions: drafts }));
  if (req.url === '/fenced/chat/completions') {
    // 代码块包着的 JSON，外加某些网关在响应体末尾粘的 data: [DONE]。
    const content = `\`\`\`json\n${JSON.stringify({ questions: drafts })}\n\`\`\``;
    return res.end(`${JSON.stringify({ choices: [{ message: { content } }] })}\ndata: [DONE]`);
  }
  if (req.url === '/bad/chat/completions') return answer('{"questions":[{"id":"resilient@9.1"}]}');
  if (req.url === '/prose/chat/completions') return answer(`Sure! Here you go: ${JSON.stringify({ questions: drafts })}`);
  if (req.url === '/nocontent/chat/completions') return res.end(JSON.stringify({ choices: [{ message: {} }] }));
  if (req.url === '/http/chat/completions') {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: `bad key ${KEY}` }));
  }
  if (req.url === '/notemp/chat/completions') {
    // 2026-11-10 用户碰到的情形：推理类模型只接受默认 temperature，带了就回 400。
    if ('temperature' in body) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { message: 'Unsupported value: temperature does not support 0.3 with this model.' } }));
    }
    return answer(JSON.stringify({ questions: drafts }));
  }
  if (req.url === '/badmodel/chat/completions') {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: { message: `The model foo does not exist (key ${KEY})` } }));
  }
  if (req.url === '/timeout/chat/completions') {
    return setTimeout(() => { if (!res.destroyed) answer(JSON.stringify({ questions: drafts })); }, 300);
  }
  res.statusCode = 404;
  res.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;
const configure = (route, model = 'fake-question-model') => storage.set('linguaclip_ai_config', JSON.stringify({
  baseUrl: `http://127.0.0.1:${port}/${route}`, apiKey: KEY, model, temperature: 0.7,
}));
const requestList = queue.map(m.modelRequest);
const noKey = error => { assert.equal(error.message.includes(KEY), false, '报错里不能带密钥'); return true; };

try {
  // ---- 解析：只认完整 JSON / 完整代码块 ----
  assert.deepEqual(m.parseModelQuestions(JSON.stringify({ questions: drafts })), drafts);
  assert.deepEqual(m.parseModelQuestions(`\`\`\`\n${JSON.stringify({ questions: drafts })}\n\`\`\``), drafts);
  assert.deepEqual(m.parseModelQuestions('{"questions":[]}'), []);
  for (const bad of ['不是 JSON', `前文${JSON.stringify({ questions: drafts })}`, '{"questions":{}}', '[]',
    '{"questions":[{"id":"a","meaning":"m"}]}', '{"questions":[{"id":"","meaning":"m","sentence":"s"}]}',
    JSON.stringify({ questions: Array.from({ length: 21 }, () => drafts[0]) })]) {
    assert.throws(() => m.parseModelQuestions(bad), /模型返回格式不正确/, bad.slice(0, 40));
  }

  // ---- 提示词：要求 [[ ]] 标记和防泄题；只发词、词性、释义，不发复习备注 ----
  const prompt = m.buildQuestionPrompt(requestList);
  assert.match(prompt, /\[\[/);
  assert.match(prompt, /never use the target or any word from its family/);
  assert.equal(prompt.includes(NOTE), false);
  assert.ok(prompt.includes('able to recover quickly from difficulty'));

  // ---- 没配模型 ----
  storage.clear();
  assert.equal(m.hasQuestionModel(), false);
  await assert.rejects(m.requestModelQuestions(requestList), /尚未配置模型/);
  configure('normal', '   ');
  assert.equal(m.hasQuestionModel(), false, '模型名为空也算没配');
  storage.set('linguaclip_ai_config', JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/normal`, apiKey: '', model: 'x' }));
  assert.equal(m.hasQuestionModel(), false, '没有密钥算没配');
  const offline = await m.prepareRecallRound(queue, { generate: m.hasQuestionModel() ? m.requestModelQuestions : null });
  assert.deepEqual(offline.questions.map(q => [q.wordId, q.source]), [['resilient@9.1', 'definition']]);
  assert.deepEqual(offline.skipped.map(s => s.wordId), ['candid@9.2']);
  assert.ok(offline.notices.some(text => text.includes('没配置模型')));
  assert.equal(requests.length, 0, '没配模型时不发任何请求');

  // ---- 本机假模型：正常 JSON ----
  configure('normal');
  assert.equal(m.hasQuestionModel(), true);
  assert.deepEqual(await m.requestModelQuestions(requestList), drafts);
  const sent = requests.at(-1);
  assert.equal(sent.auth, `Bearer ${KEY}`);
  assert.equal(sent.body.model, 'fake-question-model');
  assert.equal(sent.body.messages.length, 1);
  assert.equal(sent.body.messages[0].content.includes(NOTE), false);
  assert.deepEqual(await m.requestModelQuestions([]), [], '空请求不发网络');
  assert.equal(requests.length, 1);

  const online = await m.prepareRecallRound(queue, { generate: m.requestModelQuestions });
  assert.deepEqual(online.questions.map(q => [q.wordId, q.source, q.meaningOrigin]), [
    ['resilient@9.1', 'model', 'library'],
    ['candid@9.2', 'model', 'model'],
  ]);
  assert.deepEqual(online.skipped, []);
  for (const question of online.questions) assert.deepEqual(m.questionLeaks(question), []);
  assert.equal(requests.length, 2, '整轮只请求一次');

  // ---- 代码块 + 网关尾巴 data: [DONE] ----
  configure('fenced');
  assert.deepEqual(await m.requestModelQuestions(requestList), drafts);

  // ---- 格式错误：请求层报错，整轮退回释义题 ----
  for (const route of ['bad', 'prose', 'nocontent']) {
    configure(route);
    await assert.rejects(m.requestModelQuestions(requestList), /模型返回格式不正确/);
  }
  configure('bad');
  const malformedRound = await m.prepareRecallRound(queue, { generate: m.requestModelQuestions });
  assert.deepEqual(malformedRound.questions.map(q => [q.wordId, q.source]), [['resilient@9.1', 'definition']]);
  assert.match(malformedRound.questions[0].fallbackReason, /模型返回格式不正确/);
  assert.deepEqual(malformedRound.skipped.map(s => s.wordId), ['candid@9.2']);
  assert.ok(malformedRound.notices.some(text => text.startsWith('模型出题失败：模型返回格式不正确')));

  // ---- HTTP 错误、超时、断网：报错不带密钥和响应正文 ----
  configure('http');
  await assert.rejects(m.requestModelQuestions(requestList), error => noKey(error) && /HTTP 401：bad key \*\*\*/.test(error.message));
  // 400 因为 temperature：去掉 temperature 重试一次就成功
  configure('notemp');
  const before400 = requests.length;
  assert.deepEqual(await m.requestModelQuestions(requestList), drafts);
  assert.equal(requests.length - before400, 2, '先带 temperature 失败，再不带重试');
  assert.equal('temperature' in requests.at(-1).body, false);
  // 400 但不是 temperature 的问题：重试一次仍失败，报错带服务商原因、不带密钥
  configure('badmodel');
  await assert.rejects(m.requestModelQuestions(requestList), error => noKey(error) && /HTTP 400：The model foo does not exist/.test(error.message));
  configure('timeout');
  await assert.rejects(m.requestModelQuestions(requestList, { timeoutMs: 40 }), error => noKey(error) && /超时/.test(error.message));
  const callsBeforeClose = requests.length;
  assert.equal(callsBeforeClose, 13, '正常 2 + 代码块 1 + 格式错 4 + HTTP 1 + 去 temperature 重试 2 + 模型名错 2 + 超时 1');
  await new Promise(resolve => setTimeout(resolve, 350));
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  configure('normal');
  await assert.rejects(m.requestModelQuestions(requestList), error => noKey(error) && /连接模型失败/.test(error.message));

  console.log('复习出题假模型测试通过：没配模型、正常 JSON、代码块、格式错误退回释义题、HTTP 错误（附服务商原因、遮密钥）、400 去 temperature 重试、超时、断网，报错不带密钥。');
} finally {
  if (server.listening) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
