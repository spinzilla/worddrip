/** 073 AI 设置：随机度默认 1 + 旧默认 0.7 一次性迁移；DeepSeek 入口；查词 AI 解释遇到 400 去掉 temperature 重试。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const dir = path.resolve('src-tauri/target/vocab-inbox-tests');
fs.mkdirSync(dir, { recursive: true });
const stub = {
  name: 'node-tauri-http',
  setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/plugin-http$/ }, args => ({ path: args.path, namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const fetch = (...args) => globalThis.fetch(...args);' }));
  },
};
const bundle = async (entry, name) => {
  const outfile = path.join(dir, `${name}-${process.pid}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile, define: { 'import.meta.env.DEV': 'false' }, plugins: [stub], logLevel: 'error' });
  return import(pathToFileURL(outfile).href);
};
const storage = new Map();
globalThis.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) };
const cfg = await bundle('utils/aiConfig.ts', 'ai-config');
const KEY = 'linguaclip_ai_config';
const MARK = 'linguaclip_ai_temp_v1';

// 默认值
assert.equal(cfg.getAIConfig().temperature, 1, '新用户默认随机度是 1');
assert.ok(storage.has(MARK), '没存过设置也记下迁移标记');
// 旧默认 0.7 且没有标记 → 迁成 1，只迁一次
storage.clear();
storage.set(KEY, JSON.stringify({ model: 'm', apiKey: 'k', baseUrl: 'https://x', temperature: 0.7 }));
assert.equal(cfg.getAIConfig().temperature, 1);
assert.equal(JSON.parse(storage.get(KEY)).temperature, 1, '写回本机');
assert.equal(JSON.parse(storage.get(KEY)).model, 'm', '其他字段不动');
storage.set(KEY, JSON.stringify({ ...JSON.parse(storage.get(KEY)), temperature: 0.7 }));
assert.equal(cfg.getAIConfig().temperature, 0.7, '用户之后自己设回 0.7：有标记，不再动');
// 用户自己设过的其他值不动
storage.clear();
storage.set(KEY, JSON.stringify({ temperature: 0.3 }));
assert.equal(cfg.getAIConfig().temperature, 0.3);
assert.equal(JSON.parse(storage.get(KEY)).temperature, 0.3);
storage.clear();
storage.set(KEY, JSON.stringify({ temperature: 1.5 }));
assert.equal(cfg.getAIConfig().temperature, 1.5);
// 存了设置但没写 temperature → 取默认 1
storage.clear();
storage.set(KEY, JSON.stringify({ model: 'm' }));
assert.equal(cfg.getAIConfig().temperature, 1);

// DeepSeek 入口
const ds = await bundle('utils/deepseek.ts', 'deepseek');
assert.equal(ds.DEEPSEEK_DOCS_URL, 'https://api-docs.deepseek.com/zh-cn/');
assert.equal(ds.DEEPSEEK_KEYS_URL, 'https://platform.deepseek.com/api_keys');
assert.equal(ds.DEEPSEEK_BASE_URL, 'https://api.deepseek.com');
const opened = [];
await ds.openDeepSeekLink(ds.DEEPSEEK_DOCS_URL, async url => { opened.push(url); });
await ds.openDeepSeekLink(ds.DEEPSEEK_KEYS_URL, async url => { opened.push(url); });
assert.deepEqual(opened, ['https://api-docs.deepseek.com/zh-cn/', 'https://platform.deepseek.com/api_keys']);
await assert.rejects(ds.openDeepSeekLink('https://evil.example', async () => {}), /DeepSeek/);
const before = { baseUrl: 'https://old/v1', apiKey: 'sk-keep', model: 'keep-model', temperature: 1 };
assert.deepEqual(ds.applyDeepSeekBaseUrl(before), { ...before, baseUrl: 'https://api.deepseek.com' }, 'Key 和模型没被改动');

// 查词 AI 解释：带 temperature 就回 400 → 第二次去掉后成功
const requests = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push({ hasTemperature: 'temperature' in body });
  res.setHeader('Content-Type', 'application/json');
  if ('temperature' in body) { res.statusCode = 400; return res.end('{"error":{"message":"only temperature 1 supported"}}'); }
  res.end(JSON.stringify({ choices: [{ message: { content: '{"word":"candid","definition":"坦率的","partOfSpeech":"adj."}' } }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const port = server.address().port;
  storage.clear();
  storage.set(KEY, JSON.stringify({ model: 'fake', apiKey: 'dummy-key', baseUrl: `http://127.0.0.1:${port}`, temperature: 0.3 }));
  storage.set(MARK, '1');
  const ai = await bundle('utils/ai.ts', 'ai-lookup');
  const def = await ai.getWordDefinition('candid', 'He was candid.');
  assert.equal(def.definition, '坦率的');
  assert.deepEqual(requests.map(r => r.hasTemperature), [true, false], '第一次带 temperature 收到 400，第二次去掉后成功');
  console.log('AI 设置测试通过：默认随机度 1、0.7 迁移只迁一次、其他值不动、DeepSeek 链接/填地址、查词 400 去掉 temperature 重试。');
} finally {
  await new Promise(resolve => server.close(resolve));
}
