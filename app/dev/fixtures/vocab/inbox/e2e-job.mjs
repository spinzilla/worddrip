// 073 真实窗口：录笔记识别放到页面外面（切页不中断）+ 每页详细进度 + 总进度 + 完成提示 + 取消。
// 假视觉模型每页故意延迟约 5 秒：第 1、4 页支持流式（边写边回），第 2 页带 stream 就 400（要自动退回一次性请求），第 3 页忽略 stream 直接回 JSON。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { start, stop } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.resolve('src-tauri/target/e2e', `073-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });

const WORDS = {
  1: [{ word: 'alpha', note: '一', uncertain: false }, { word: 'candid', note: '坦率', uncertain: false }],
  2: [{ word: 'beta', note: '二', uncertain: false }],
  3: [{ word: 'gamma', note: '三', uncertain: false }, { word: 'Candid', note: '直言', uncertain: false }],
  4: [{ word: 'delta', note: '四', uncertain: false }],
};
const WIDTHS = [1000, 1100, 1200, 1300];
let mode = 'slow';
const requests = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const jpegWidth = buffer => {
  let i = 2;
  while (i < buffer.length) {
    if (buffer[i] !== 0xff) { i += 1; continue; }
    const marker = buffer[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return buffer.readUInt16BE(i + 7);
    i += 2 + buffer.readUInt16BE(i + 2);
  }
  throw new Error('不是 JPEG');
};

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const url = payload.messages[0].content[1].image_url.url;
  const width = jpegWidth(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
  const pageNo = WIDTHS.findIndex(w => Math.abs(w - width) <= 3) + 1;
  assert.ok(pageNo > 0, `认不出是哪一页：${width}`);
  requests.push({ mode, pageNo, stream: payload.stream === true });
  const text = JSON.stringify({ words: WORDS[pageNo] });
  const json = () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: text } }] })); };
  if (mode === 'fast1') {
    if (pageNo !== 1) await sleep(9000);
    return json();
  }
  // slow：每页约 5 秒
  if (pageNo === 2 && payload.stream) { res.statusCode = 400; return res.end('{"error":{"message":"stream not supported"}}'); }
  if (payload.stream && (pageNo === 1 || pageNo === 4)) {
    res.setHeader('Content-Type', 'text/event-stream');
    const n = 7;
    const step = Math.ceil(text.length / n);
    for (let i = 0; i < n; i += 1) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i * step, (i + 1) * step) } }] })}\n\n`);
      await sleep(700);
    }
    return res.end('data: [DONE]\n\n');
  }
  await sleep(5000);
  return json();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;

const pickImages = (page, widths) => page.evaluate(async list => {
  const files = [];
  for (const w of list) {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = 800;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, 800);
    ctx.fillStyle = '#123'; ctx.font = '60px sans-serif'; ctx.fillText(`note-${w}`, 40, 120);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    files.push(new File([blob], `note-${w}.jpg`, { type: 'image/jpeg' }));
  }
  const input = document.querySelector('[data-testid=inbox-file]');
  const transfer = new DataTransfer();
  files.forEach(file => transfer.items.add(file));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, widths);
const pageStatus = (page, i) => page.text(`[data-testid=inbox-page-status-${i}]`);
const progress = page => page.text('[data-testid=inbox-progress]');
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const candidateWords = page => page.evaluate(() => [...document.querySelectorAll('[data-testid^=inbox-word-]')].map(input => input.value));
const navTo = (page, label) => page.clickText(label, { selector: 'header nav button', exact: false });
const openInbox = async page => {
  await navTo(page, '词库');
  await page.clickText('录笔记', { selector: '[role=tab]', exact: false });
  await page.waitFor('[data-testid=inbox-file]', { visible: false });
};
const resetIfNeeded = async page => {
  if (await page.evaluate(() => !!document.querySelector('[data-testid=inbox-reset]'))) await page.click('[data-testid=inbox-reset]');
  await page.waitUntil('页面列表清空', '!document.querySelector("[data-testid=inbox-pages]")');
};

let session; let page; let passed = false;
const evidence = {};
try {
  session = await start({ runDir, port: 9473 });
  page = await connect({ port: session.port });
  await page.waitReady();
  const hook = () => page.evaluate(baseUrl => {
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({ baseUrl, apiKey: 'dummy-e2e-key', model: 'fake-vision', temperature: 1 }));
    window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);
  }, `http://127.0.0.1:${port}/v1`);

  const scenario = async (label, vw, vh, mobile) => {
    const shot = name => page.screenshot(path.join(out, `${label}-${name}.png`));
    await page.setViewport(vw, vh, { mobile, dpr: mobile ? 2 : 1 });
    await hook();
    await openInbox(page);
    mode = 'slow';
    requests.length = 0;
    await pickImages(page, WIDTHS);
    await page.waitUntil('4 张缩略图', 'document.querySelectorAll("[data-testid^=inbox-page-][data-state]").length === 4');
    await page.click('[data-testid=inbox-recognize]');
    await page.waitUntil('进入识别', 'document.querySelector("[data-testid=inbox-progress]")?.textContent.includes("已完成 0 / 4")');
    await sleep(2200);
    await shot('1-running-2s');
    const stages = [];
    for (let i = 0; i < 4; i += 1) stages.push(await pageStatus(page, i));
    evidence[`${label}-stages-2s`] = stages;
    assert.ok(stages.some(text => /模型正在写…已收到 \d+ 字/.test(text)), `流式页应显示已收到字数：${stages}`);
    assert.ok(stages.some(text => /等待模型回复（已等 \d+ 秒）/.test(text)), `非流式页应显示已等秒数：${stages}`);
    assert.match(await progress(page), /已完成 \d+ \/ 4 页 · 已用 .+ · (预计时间：估算中|预计还要)/);
    assert.match(await page.text('[data-testid=inbox-model]'), /正在使用模型：fake-vision/);
    assert.match(await page.text('[data-testid=inbox-job-tips]'), /换一个更快的看图模型/);
    assert.equal(await page.evaluate(() => document.querySelector('[data-testid=inbox-confirm]')?.disabled ?? 'none'), 'none', '还没有候选前没有确认按钮');
    const w1 = await page.text('[data-testid=inbox-page-status-1]');
    await sleep(1200);
    assert.notEqual(await page.text('[data-testid=inbox-page-status-1]'), w1, '「已等 N 秒」每秒在走');
    assert.equal(await noOverflow(page), true);

    // 切到设置停 3 秒再切回：进度继续、没有重新开始
    const before = requests.length;
    await navTo(page, '设置');
    await page.waitFor('[data-testid=nav-note-job]', { visible: false });
    const navBadge = await page.text('[data-testid=nav-note-job]');
    assert.match(navBadge, /\d\/4/, '导航「词库」旁有转圈和页数');
    await shot('2-on-settings');
    await sleep(3000);
    await navTo(page, '词库');
    await page.clickText('浏览', { selector: '[role=tab]', exact: false });
    await page.waitFor('[data-testid=inbox-tab-job]', { visible: false });
    assert.match(await page.text('[data-testid=inbox-tab-job]'), /\d\/4/, '「录笔记」段有转圈和页数');
    await shot('3-vocab-browse-tab-badge');
    await page.clickText('录笔记', { selector: '[role=tab]', exact: false });
    await page.waitFor('[data-testid=inbox-progress]');
    assert.equal(requests.length >= before && requests.filter(r => r.pageNo === 1).length === 1, true, '没有重新开始');
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid^=inbox-page-][data-state]').length), 4, '页面列表还在');
    await shot('4-back-on-inbox');

    // 去「句子」复习页，再回来
    await navTo(page, mobile ? '设置' : '句子');
    await sleep(1200);
    await shot('5-on-review-page');
    // 留在别的页面等全部结束：应出现「识别完成，去确认」
    await page.waitFor('[data-testid=note-job-toast]', { timeout: 60000, visible: false });
    assert.match(await page.text('[data-testid=note-job-toast]'), /笔记识别完成：认出 \d+ 个词，去确认/);
    await shot('6-toast-elsewhere');
    await page.click('[data-testid=note-job-toast-go]');
    await page.waitFor('[data-testid=inbox-candidates]');
    assert.deepEqual(await candidateWords(page), ['alpha', 'candid', 'beta', 'gamma', 'delta'], '合并后的候选，按页码排');
    assert.equal(await page.evaluate(() => !document.querySelector('[data-testid=note-job-toast]')), true, '回到录笔记后提示消失');
    assert.match(await progress(page), /识别完成：成功 4 \/ 4 页/);
    const finalStages = [];
    for (let i = 0; i < 4; i += 1) finalStages.push(await pageStatus(page, i));
    assert.ok(finalStages.every(text => /完成 · 认出 \d+ 个/.test(text)), `${finalStages}`);
    assert.equal(await page.evaluate(() => document.querySelector('[data-testid=inbox-confirm]').disabled), false, '全部结束后可确认入库');
    await shot('7-finished');
    const byPage = Object.fromEntries([1, 2, 3, 4].map(n => [n, requests.filter(r => r.pageNo === n).map(r => r.stream)]));
    evidence[`${label}-requests`] = byPage;
    assert.deepEqual(byPage[1], [true], '第 1 页走流式');
    assert.deepEqual(byPage[2].at(-1), false, '第 2 页不支持流式：自动退回一次性请求');
    assert.deepEqual(byPage[3], [true], '第 3 页忽略 stream：直接接住普通 JSON，不重复请求');
    assert.equal(await noOverflow(page), true);
    await resetIfNeeded(page);

    // ---- 第一页先完成：已有候选、确认入库不可点；再取消，已完成页保留
    mode = 'fast1';
    requests.length = 0;
    await pickImages(page, WIDTHS);
    await page.waitUntil('4 张', 'document.querySelectorAll("[data-testid^=inbox-page-][data-state]").length === 4');
    await page.click('[data-testid=inbox-recognize]');
    await page.waitFor('[data-testid=inbox-candidates]', { timeout: 20000 });
    assert.deepEqual(await candidateWords(page), ['alpha', 'candid'], '第 1 页完成就先显示它的词');
    assert.equal(await page.evaluate(() => document.querySelector('[data-testid=inbox-confirm]').disabled), true, '其他页还在等：确认入库不可点');
    assert.match(await progress(page), /已完成 1 \/ 4 页/);
    await shot('8-first-page-candidates');
    await page.click('[data-testid=inbox-cancel]');
    await page.waitUntil('取消完成', 'document.querySelector("[data-testid=inbox-notice]")?.textContent.includes("已取消")');
    assert.deepEqual(await candidateWords(page), ['alpha', 'candid']);
    assert.equal(await page.evaluate(() => document.querySelector('[data-testid=inbox-page-status-1]').textContent.includes('已取消')), true);
    await sleep(500);
    await shot('9-cancelled');
    await resetIfNeeded(page);
  };

  await scenario('desktop', 1280, 900, false);
  await page.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', platform: 'Linux armv8l' });
  await page.reload();
  await page.waitReady();
  await scenario('mobile', 390, 844, true);

  const unexpectedErrors = page.errors.filter(error => error !== 'plugin http not found');
  assert.deepEqual(unexpectedErrors, []);
  evidence.screenshots = fs.readdirSync(out).filter(name => name.endsWith('.png')).sort();
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
  console.log(`真实窗口验证通过，证据：${path.join(out, 'evidence.json')}`);
  passed = true;
} catch (error) {
  if (page) await page.screenshot(path.join(out, 'failure.png')).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  if (session) await stop(session.runDir);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  console.log(`隔离窗口${passed ? '已通过并关闭' : '失败后已关闭'}`);
}
