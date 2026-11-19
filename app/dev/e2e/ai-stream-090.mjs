// 090 真实窗口：AI 任务中心 + 流式。起本机假模型（慢慢吐思考和正文），在真实 Tauri 窗口里建任务，
// 断言第一块正文在全部结束之前就到了，思考和正文分开；再测追问、不支持流式时退回、取消。
//   在 app 目录：node dev/e2e/ai-stream-090.mjs
// 默认测试窗口不注册 http 插件（见 docs/e2e.md），所以默认用 WebView 自带的 fetch 代替，
// 测的是「任务中心 + 流式解析 + 真实窗口」，不含 plugin-http。
// 想测 plugin-http 本身：先自己确认可以让它把 .cookies 写进系统目录（仓库外），再
//   $env:ES_E2E_REAL_HTTP='1'; node dev/e2e/ai-stream-090.mjs
// 结果、截图写在 D:\tmp\es-e2e\090-ai-stream-*。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './cdp.mjs';
import { start, stop } from './launch.mjs';
import { startFakeModel, TEXT_PIECES, THINK_PIECES } from '../sse-fake-model.mjs';

const realHttp = process.env.ES_E2E_REAL_HTTP === '1';
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.join('D:\\tmp\\es-e2e', `090-ai-stream-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
const port = 9490;
fs.mkdirSync(out, { recursive: true });

let fake;
let session;
let page;
let failed;
const report = { mode: realHttp ? 'plugin-http（真实插件）' : 'WebView fetch（隔离窗口无 http 插件）' };
try {
  fake = await startFakeModel({ thinkDelayMs: 150, textDelayMs: 300 });
  session = await start({ runDir, port });
  page = await connect({ port: session.port });
  await page.waitReady();

  await page.evaluate((fakePort, usePlugin) => {
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({
      apiKey: '090-local-test-key', model: 'fake-stream', baseUrl: `http://127.0.0.1:${fakePort}/v1`,
    }));
    if (!usePlugin) window.__ES_E2E_HTTP_FETCH__ = (url, init) => fetch(url, init);
  }, fake.port, realHttp);

  // 页面里放一个小工具：建任务、记录每次增量的到达时间。
  await page.evaluate(() => {
    window.__ai090 = async () => {
      const mod = await import('/utils/aiTasks/index.ts');
      return mod;
    };
  });

  // 1) 流式：建任务，边收边记录时间。
  const timing = await page.evaluate(async () => {
    const { aiTasks } = await window.__ai090();
    const t0 = performance.now();
    const created = aiTasks.create({ title: '090 流式测试', source: { kind: 'e2e', word: 'agenda' }, prompt: '说句话' });
    if (!created.ok) throw new Error(created.reason);
    const id = created.task.id;
    const events = [];
    let lastText = ''; let lastThink = '';
    const unsub = aiTasks.subscribeTask(id, () => {
      const task = aiTasks.getTask(id);
      const at = Math.round(performance.now() - t0);
      if (task.thinking !== lastThink) { events.push({ at, kind: 'think', len: task.thinking.length }); lastThink = task.thinking; }
      if (task.text !== lastText) { events.push({ at, kind: 'text', len: task.text.length }); lastText = task.text; }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等任务完成超时')), 30000);
      const check = () => { const s = aiTasks.getTask(id).status; if (s === 'done' || s === 'failed') { clearTimeout(timer); resolve(); } };
      aiTasks.subscribeTask(id, check); check();
    });
    unsub();
    const task = aiTasks.getTask(id);
    return { id, events, total: Math.round(performance.now() - t0), status: task.status, error: task.error, text: task.text, thinking: task.thinking, streamed: task.streamed, firstChunkMs: task.firstChunkAt - task.startedAt, durationMs: task.endedAt - task.startedAt };
  });
  report.stream = timing;
  assert.equal(timing.status, 'done', `任务完成，错误：${timing.error}`);
  assert.equal(timing.text, TEXT_PIECES.join(''), '正文完整');
  assert.equal(timing.thinking, THINK_PIECES.join(''), '思考单独拿到，且没混进正文');
  assert.ok(!timing.text.includes('先想一想'), '思考没有混进正文');
  const firstText = timing.events.find(e => e.kind === 'text');
  assert.ok(firstText, '收到过正文增量');
  console.log(`第一块正文 ${firstText.at} ms 到达，全部结束 ${timing.total} ms；首块距开始 ${timing.firstChunkMs} ms`);
  assert.ok(firstText.at < timing.total - 500, `第一块正文（${firstText.at} ms）要明显早于全部结束（${timing.total} ms）`);
  assert.ok(timing.events.filter(e => e.kind === 'text').length >= 3, '正文是分多次到的');
  assert.equal(timing.streamed, true, '确实是流式收到的');
  await page.screenshot(path.join(out, '01-stream-done.png'));

  // 2) 追问：假模型收到的请求里带着之前的问答。
  const before = fake.requests.length;
  await page.evaluate(async id => {
    const { aiTasks } = await window.__ai090();
    const r = aiTasks.followUp(id, '再说一遍');
    if (!r.ok) throw new Error(r.reason);
    await new Promise(resolve => { const check = () => { if (aiTasks.getTask(id).status === 'done') resolve(); }; aiTasks.subscribeTask(id, check); check(); });
  }, timing.id);
  const follow = fake.requests.slice(before).at(-1);
  assert.deepEqual(follow.body.messages.map(m => m.role), ['user', 'assistant', 'user'], '追问带上历史');
  assert.equal(follow.body.stream, true);
  assert.equal(follow.hasAuth, true);

  // 3) 切页面不中断：任务在跑时切到「词库」页再回来，任务照样完成。
  const slow = await page.evaluate(async () => {
    const { aiTasks } = await window.__ai090();
    const created = aiTasks.create({ title: '090 切页面', source: { kind: 'e2e' }, prompt: '慢一点' });
    return created.task.id;
  });
  await page.clickText(['词库', 'Vocabulary'], { selector: 'header nav button', exact: false });
  await page.waitFor('header nav');
  const switched = await page.evaluate(async id => {
    const { aiTasks } = await window.__ai090();
    await new Promise(resolve => { const check = () => { if (aiTasks.getTask(id).status === 'done') resolve(); }; aiTasks.subscribeTask(id, check); check(); });
    return aiTasks.getTask(id).text;
  }, slow);
  assert.equal(switched, TEXT_PIECES.join(''), '切页面后任务照常完成');

  // 4) 不支持流式：退回普通请求，整段一次交出。
  const plain = await page.evaluate(async fakePort => {
    const cfg = JSON.parse(localStorage.getItem('linguaclip_ai_config'));
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({ ...cfg, model: 'fake-reject-stream' }));
    const { aiTasks } = await window.__ai090();
    const created = aiTasks.create({ title: '090 退回', source: { kind: 'e2e' }, prompt: 'hi' });
    const id = created.task.id;
    await new Promise(resolve => { const check = () => { const s = aiTasks.getTask(id).status; if (s === 'done' || s === 'failed') resolve(); }; aiTasks.subscribeTask(id, check); check(); });
    const task = aiTasks.getTask(id);
    return { status: task.status, error: task.error, streamed: task.streamed, text: task.text };
  }, fake.port);
  assert.equal(plain.status, 'done', `退回普通请求成功，错误：${plain.error}`);
  assert.equal(plain.streamed, false);
  assert.equal(plain.text, TEXT_PIECES.join(''));

  // 5) 取消：状态变已取消，之后文本不再增长。
  const cancelled = await page.evaluate(async () => {
    const cfg = JSON.parse(localStorage.getItem('linguaclip_ai_config'));
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({ ...cfg, model: 'fake-stream' }));
    const { aiTasks } = await window.__ai090();
    const created = aiTasks.create({ title: '090 取消', source: { kind: 'e2e' }, prompt: 'x' });
    const id = created.task.id;
    await new Promise(resolve => { const check = () => { if (aiTasks.getTask(id).text) resolve(); }; aiTasks.subscribeTask(id, check); check(); });
    aiTasks.cancel(id);
    const frozen = aiTasks.getTask(id).text;
    await new Promise(resolve => setTimeout(resolve, 1500));
    const task = aiTasks.getTask(id);
    return { status: task.status, frozen, after: task.text };
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.after, cancelled.frozen, '取消后文本不再增长');

  assert.deepEqual(page.errors.filter(e => /aiTasks|ai-task|stream/i.test(e)), [], '页面没有和任务中心相关的未捕获错误');
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed: true, ...report }, null, 2));
  console.log(`090 真实窗口测试通过（${report.mode}），结果在 ${out}`);
} catch (error) {
  failed = error;
  console.error('FAIL', error);
  if (page) await page.screenshot(path.join(out, '99-failure.png')).catch(() => {});
  process.exitCode = 1;
} finally {
  page?.close();
  if (session) await stop(session.runDir).catch(error => { console.error('停止隔离窗口失败：', error.message); process.exitCode = 1; });
  await fake?.close();
  if (failed) fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed: false, failure: failed.message, ...report }, null, 2));
}
