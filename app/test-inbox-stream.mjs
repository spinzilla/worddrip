/** 073 识别流式：SSE 分块拼回完整 JSON；接口不支持流式（400 / 忽略 stream / 流里没内容）时退回一次性请求，不能因此识别失败。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundled = path.resolve('src-tauri/target/vocab-inbox-tests', `inbox-stream-${process.pid}.mjs`);
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
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) };
const { createSseParser, readSseContent, recognizeInboxImage } = await import(pathToFileURL(bundled).href);

const words = [{ word: 'resilient', note: '有韧性的', uncertain: true }, { word: 'candid', note: '坦率的', uncertain: false }];
const full = JSON.stringify({ words });
const sse = piece => `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`;

// ---- 解析器：故意把一行劈在两块中间、夹推理字段和 [DONE]
{
  const parser = createSseParser();
  let out = '';
  const raw = sse('{"words":[{"wo') + `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '想一想' } }] })}\n\n` + sse('rd":"a","note":"b","uncertain":false}]}') + 'data: [DONE]\n\n';
  for (let i = 0; i < raw.length; i += 7) out += parser.feed(raw.slice(i, i + 7));
  out += parser.end();
  assert.equal(out, '{"words":[{"word":"a","note":"b","uncertain":false}]}');
  assert.equal(parser.done, true);
  const crlf = createSseParser();
  assert.equal(crlf.feed('data: {"choices":[{"delta":{"content":"x"}}]}\r\n\r\ndata: {bad json}\r\n'), 'x', '坏行跳过不报错');
}
// readSseContent：从 ReadableStream 拼回，并回调字数
{
  const enc = new TextEncoder();
  const bytes = enc.encode(sse(full.slice(0, 15)) + sse(full.slice(15)) + 'data: [DONE]\n\n');
  const body = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 11) c.enqueue(bytes.slice(i, i + 11)); c.close(); } });
  const counts = [];
  assert.equal(await readSseContent(body, n => counts.push(n)), full);
  assert.deepEqual(counts, [15, full.length]);
}

// ---- 假服务：/stream 支持流式；/nostream 带 stream 就 400；/ignore 忽略 stream 回普通 JSON；/empty 流里没内容；/auth 401
const requests = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push({ url: req.url, stream: body.stream === true });
  const json = content => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content } }] })); };
  if (req.url.startsWith('/stream/') && body.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    const parts = [full.slice(0, 20), full.slice(20, 50), full.slice(50)];
    for (const part of parts) { res.write(sse(part)); await new Promise(r => setTimeout(r, 10)); }
    return res.end('data: [DONE]\n\n');
  }
  if (req.url.startsWith('/nostream/') && body.stream) { res.statusCode = 400; return res.end('{"error":{"message":"stream not supported"}}'); }
  if (req.url.startsWith('/empty/') && body.stream) { res.setHeader('Content-Type', 'text/event-stream'); return res.end('data: [DONE]\n\n'); }
  if (req.url.startsWith('/auth/')) { res.statusCode = 401; return res.end('{"error":"bad key"}'); }
  return json(full);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const image = { base64: Buffer.from('fake').toString('base64'), mimeType: 'image/jpeg' };
const configure = route => storage.set('linguaclip_ai_config', JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/${route}`, apiKey: 'dummy-key', model: 'fake-vision', temperature: 1 }));
const run = async route => {
  requests.length = 0;
  configure(route);
  const stages = []; const chars = [];
  const result = await recognizeInboxImage(image, { hooks: { onStage: s => stages.push(s), onChars: n => chars.push(n) } });
  return { result, stages, chars, reqs: [...requests] };
};

try {
  let r = await run('stream/');
  assert.deepEqual(r.result, words, '流式拼回的完整 JSON 仍按原来的方式解析');
  assert.deepEqual(r.reqs.map(x => x.stream), [true]);
  assert.ok(r.stages.includes('uploading') && r.stages.includes('streaming'), '阶段：上传 → 流式');
  assert.equal(r.chars.at(-1), full.length, '最后一次回调的字数 = 全文长度');
  assert.ok(r.chars.length >= 3, '边收边回调字数');

  r = await run('nostream/');
  assert.deepEqual(r.result, words, '接口不支持流式：退回一次性请求，照样识别成功');
  assert.equal(r.reqs.at(-1).stream, false);
  assert.ok(!r.stages.includes('streaming'));

  r = await run('ignore/');
  assert.deepEqual(r.result, words, '接口忽略 stream 直接回普通 JSON：直接接住，不重复请求');
  assert.equal(r.reqs.length, 1);

  r = await run('empty/');
  assert.deepEqual(r.result, words, '流里什么都没有：退回一次性请求');
  assert.equal(r.reqs.at(-1).stream, false);

  requests.length = 0; configure('auth/');
  await assert.rejects(recognizeInboxImage(image), /HTTP 401/);
  assert.equal(requests.length, 1, '密钥错这类退回也一样失败，不重复发请求');

  configure('stream/');
  const noStream = await recognizeInboxImage(image, { stream: false });
  assert.deepEqual(noStream, words);
  assert.equal(requests.at(-1).stream, false, 'stream:false 直接走一次性请求');
  console.log('识别流式测试通过：SSE 跨块拼接、推理字段忽略、流式回调字数、不支持/忽略/空流自动退回、密钥错不重发。');
} finally {
  await new Promise(resolve => server.close(resolve));
}
