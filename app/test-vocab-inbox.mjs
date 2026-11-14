/** 手写收件箱：真实识别模块 + 本机假 OpenAI 兼容视觉服务。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundled = path.resolve('src-tauri/target/vocab-inbox-tests', `inbox-${process.pid}.mjs`);
fs.mkdirSync(path.dirname(bundled), { recursive: true });
await build({
  entryPoints: ['utils/vocab/inbox.ts'],
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

const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
};
const {
  INBOX_IMAGE_LIMIT,
  inboxImageMime,
  normalizeInboxWord,
  parseInboxResponse,
  recognizeInboxImage,
  validateInboxImage,
} = await import(pathToFileURL(bundled).href);

const words = [
  { word: 'resilient', note: '有韧性的', uncertain: true },
  { word: 'candid', note: '坦率的', uncertain: false },
];
const requests = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push({ url: req.url, body });
  res.setHeader('Content-Type', 'application/json');
  const answer = content => res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  if (req.url === '/normal/chat/completions') return answer(JSON.stringify({ words }));
  if (req.url === '/fenced/chat/completions') return answer(`\`\`\`json\n${JSON.stringify({ words })}\n\`\`\``);
  if (req.url === '/bad/chat/completions') return answer('{"words":[{"word":"缺字段"}]}');
  if (req.url === '/http/chat/completions') {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: 'dummy-e2e-key-must-not-leak' }));
  }
  if (req.url === '/timeout/chat/completions') {
    return setTimeout(() => { if (!res.destroyed) answer(JSON.stringify({ words })); }, 250);
  }
  res.statusCode = 404;
  res.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;
const image = { base64: Buffer.from('fake png bytes').toString('base64'), mimeType: 'image/png' };
const configure = route => {
  storage.set('linguaclip_ai_config', JSON.stringify({
    baseUrl: `http://127.0.0.1:${port}/${route}`,
    apiKey: 'dummy-e2e-key-must-not-leak',
    model: 'fake-vision',
    temperature: 0.7,
  }));
};

try {
  assert.equal(inboxImageMime({ name: 'a.PNG', size: 1, type: '' }), 'image/png');
  assert.equal(inboxImageMime({ name: 'a.jpeg', size: 1, type: '' }), 'image/jpeg');
  assert.match(validateInboxImage({ name: 'a.txt', size: 1, type: 'text/plain' }), /PNG 或 JPG/);
  assert.match(validateInboxImage({ name: 'a.png', size: INBOX_IMAGE_LIMIT + 1, type: 'image/png' }), /20 MB/);
  assert.equal(validateInboxImage({ name: 'a.png', size: INBOX_IMAGE_LIMIT, type: 'image/png' }), '');
  assert.equal(normalizeInboxWord('  Two\n  WORDS '), 'two words');
  assert.deepEqual(parseInboxResponse(`\`\`\`\n${JSON.stringify({ words })}\n\`\`\``), words);
  for (const bad of ['不是 JSON', `前文${JSON.stringify({ words })}`, '{"words":[]}', '{"words":{}}']) {
    if (bad === '{"words":[]}') { assert.deepEqual(parseInboxResponse(bad), []); continue; }
    assert.throws(() => parseInboxResponse(bad), /模型返回格式不正确/);
  }

  storage.clear();
  await assert.rejects(recognizeInboxImage(image), /请先在设置中配置/);

  configure('normal');
  assert.deepEqual(await recognizeInboxImage(image), words);
  const sent = requests.at(-1);
  assert.equal(sent.body.model, 'fake-vision');
  assert.equal(sent.body.temperature, 0);
  assert.equal(sent.body.messages[0].content[1].image_url.url, `data:image/png;base64,${image.base64}`);

  configure('fenced');
  assert.deepEqual(await recognizeInboxImage(image), words);
  configure('bad');
  await assert.rejects(recognizeInboxImage(image), /模型返回格式不正确/);
  configure('http');
  await assert.rejects(recognizeInboxImage(image), error => {
    assert.match(error.message, /HTTP 401/);
    assert.equal(error.message.includes('dummy-e2e-key-must-not-leak'), false);
    return true;
  });
  configure('timeout');
  await assert.rejects(recognizeInboxImage(image, { timeoutMs: 30 }), /识别超时/);
  assert.equal(requests.length, 5, '只请求本机假模型，正常、代码块、坏格式、HTTP 错、超时各一次');
  await new Promise(resolve => server.close(resolve));
  configure('network');
  await assert.rejects(recognizeInboxImage(image), /连接视觉模型失败/);
  // Tauri http 插件超时抛的是 Error('Request cancelled')，不是 AbortError；不能显示成「连接失败」。
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('Request cancelled'); };
    await assert.rejects(recognizeInboxImage(image), /识别超时/);
    // 不靠报错措辞：插件换成任何陌生说法、甚至请求根本不返回，只要到了我们自己的计时点都算超时。
    globalThis.fetch = async () => new Promise(() => {});
    await assert.rejects(recognizeInboxImage(image, { timeoutMs: 20 }), /识别超时/, '底层不响应也要按超时处理');
    globalThis.fetch = async () => { throw new Error('socket hang up (0x8007274D)'); };
    await assert.rejects(recognizeInboxImage(image), /连接视觉模型失败/, '陌生但非超时的报错不能说成超时');
    globalThis.fetch = async () => { throw new Error('connection refused'); };
    await assert.rejects(recognizeInboxImage(image), /连接视觉模型失败/, '普通连接失败不能说成超时');
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log('手写收件箱假模型测试通过：正常 JSON、Markdown 代码块、格式错误、HTTP 错误、超时（含底层不响应/陌生报错）、断网、图片校验均通过。');
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
