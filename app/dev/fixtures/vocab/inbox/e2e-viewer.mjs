// 069 真实窗口：录入笔记「点页码看原图」。假视觉模型；宽屏并排、900 宽弹层、手机 390 触摸缩放。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { start, stop } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.resolve('src-tauri/target/e2e', `069-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 三张图宽度不同（1000/1100/1200），假模型按宽度认页；每页 8 条，共 24 条，让候选列表足够长。
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
  const pageNo = width === 1000 ? 1 : width === 1100 ? 2 : 3;
  const words = Array.from({ length: 8 }, (_, k) => ({ word: `p${pageNo}word${k + 1}`, note: `第${pageNo}页的词 ${k + 1}`, uncertain: k === 0 }));
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ words }) } }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const pickImages = page => page.evaluate(async () => {
  const files = [];
  for (const [w, h, name] of [[1000, 700, 'note-1.jpg'], [1100, 800, 'note-2.jpg'], [1200, 800, 'note-3.jpg']]) {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = ['#fde', '#def', '#efd'][files.length]; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#123'; ctx.font = '120px sans-serif'; ctx.fillText(`PAGE ${files.length + 1}`, 60, 200);
    ctx.strokeStyle = '#c00'; ctx.lineWidth = 6; ctx.strokeRect(w - 220, h - 220, 160, 160);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    files.push(new File([blob], name, { type: 'image/jpeg' }));
  }
  const input = document.querySelector('[data-testid=inbox-file]');
  const transfer = new DataTransfer();
  files.forEach(file => transfer.items.add(file));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
const recognizeAll = async page => {
  await pickImages(page);
  await page.waitUntil('3 张缩略图', 'document.querySelectorAll("[data-testid^=inbox-page-][data-state]").length === 3');
  await page.click('[data-testid=inbox-recognize]');
  await page.waitFor('[data-testid=inbox-candidates]');
  await page.waitUntil('进度 3/3', 'document.querySelector("[data-testid=inbox-progress]")?.textContent.includes("3 / 3")');
};
const title = page => page.evaluate(() => document.querySelector('[data-testid=note-viewer-title]')?.textContent ?? null);
const scale = page => page.evaluate(() => Number(document.querySelector('[data-testid=note-viewer-img]')?.dataset.scale ?? 0));
// 应用的滚动发生在某个内层容器里（不是 document）：从候选列表往上找第一个能滚动的祖先。
const SCROLLER = `(() => { let el = document.querySelector('[data-testid=inbox-candidates]'); while (el) { const o = getComputedStyle(el).overflowY; if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight) return el; el = el.parentElement; } return document.scrollingElement; })()`;
const scrollTop = page => page.evaluate(`Math.round(${SCROLLER}.scrollTop)`);
const scrollBy = (page, dy) => page.evaluate(`${SCROLLER}.scrollBy(0, ${dy})`);
const hook = page => page.evaluate(baseUrl => {
  localStorage.setItem('linguaclip_ai_config', JSON.stringify({ baseUrl, apiKey: 'dummy-e2e-key', model: 'fake-vision', temperature: 0.7 }));
  window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);
}, `http://127.0.0.1:${port}/v1`);
const touch = (page, type, points) => page.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, id) => ({ x: p[0], y: p[1], id })) });
const boxCenter = page => page.evaluate(() => { const r = document.querySelector('[data-testid=note-viewer-box]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
const tap = async (page, x, y) => { await touch(page, 'touchStart', [[x, y]]); await touch(page, 'touchEnd', []); await sleep(80); };

let session; let page; let passed = false;
const evidence = {};
try {
  session = await start({ runDir, port: 9463 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await hook(page);
  await page.clickText('词库');
  await page.clickText('录笔记');

  // ---- A. 电脑 1280：并排 ----
  await recognizeAll(page);
  assert.ok(await page.evaluate(() => !!document.querySelector('[data-testid=note-viewer-pane]')), '宽屏有左栏');
  assert.equal(await title(page), '第 1 / 3 页');
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid=inbox-page-chip-0-1]').length), 1, '页码胶囊可点');
  await page.screenshot(path.join(out, 'A1-desktop-side-by-side.png'), { full: false });
  // 点第 3 页的候选（p3word1 是第 17 条，下标 16）
  await page.evaluate(() => document.querySelector('[data-testid=inbox-candidate-16]').scrollIntoView({ block: 'center' }));
  await page.click('[data-testid=inbox-word-16]');
  assert.equal(await title(page), '第 3 / 3 页', '点候选，左栏跳到第 3 页');
  await page.click('[data-testid=inbox-page-chip-8-2]');
  assert.equal(await title(page), '第 2 / 3 页', '点页码胶囊跳页');
  // 滚动右栏时左栏仍在可视区域
  const top0 = await scrollTop(page);
  await scrollBy(page, 400);
  assert.ok(await scrollTop(page) > top0, '右栏确实滚动了');
  await sleep(300);
  const rect = await page.evaluate(() => { const r = document.querySelector('[data-testid=note-viewer-pane]').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
  assert.ok(rect.top >= -1 && rect.top < 200 && rect.bottom > 300, `左栏在可视区域：${JSON.stringify(rect)}`);
  evidence.paneRect = rect;
  await page.screenshot(path.join(out, 'A2-desktop-jump-page2-scrolled.png'), { full: false });
  // 滚轮放大
  const [cx, cy] = await boxCenter(page);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -300 });
  await sleep(200);
  assert.ok(await scale(page) > 1.2, '滚轮放大');
  await page.screenshot(path.join(out, 'A3-desktop-zoomed.png'), { full: false });

  // ---- B. 900 宽：无并排，点页码弹层 ----
  await page.setViewport(900, 800, { mobile: false, dpr: 1 });
  await sleep(1000);
  evidence.width900 = await page.evaluate(() => ({ w: innerWidth, mq: matchMedia('(min-width: 1024px)').matches }));
  assert.equal(await page.evaluate(() => !!document.querySelector('[data-testid=note-viewer-pane]')), false, `900 宽没有并排 ${JSON.stringify(evidence.width900)}`);
  assert.equal(await page.evaluate(() => !!document.querySelector('[data-testid=note-viewer]')), false);
  await page.evaluate(() => document.querySelector('[data-testid=inbox-page-chip-9-2]').scrollIntoView({ block: 'center' }));
  await page.click('[data-testid=inbox-page-chip-9-2]');
  await page.waitFor('[data-testid=note-viewer]');
  assert.equal(await title(page), '第 2 / 3 页');
  await page.screenshot(path.join(out, 'B1-900-overlay.png'), { full: false });
  await page.click('[data-testid=note-viewer-close]');
  assert.equal(await page.evaluate(() => !!document.querySelector('[data-testid=note-viewer]')), false);

  // ---- C. 手机 390x844 ----
  await page.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', platform: 'Linux armv8l' });
  await page.setViewport(390, 844, { mobile: true, dpr: 2 });
  await page.reload();
  await page.waitReady();
  await hook(page);
  await page.clickText('词库');
  await page.clickText('录笔记');
  await page.waitFor('[data-testid=inbox-camera]', { visible: false });
  await recognizeAll(page);
  await page.evaluate(() => document.querySelector('[data-testid=inbox-candidate-10]').scrollIntoView({ block: 'center' }));
  await sleep(300);
  await page.screenshot(path.join(out, 'C1-mobile-candidates-chips.png'), { full: false });
  const before = await scrollTop(page);
  assert.ok(before > 300, `已滚下去：${before}`);
  await page.evaluate(() => document.querySelector('[data-testid=inbox-page-chip-10-2]').click());
  await page.waitFor('[data-testid=note-viewer]');
  assert.equal(await title(page), '第 2 / 3 页');
  await sleep(300);
  await page.screenshot(path.join(out, 'C2-mobile-viewer-page2.png'), { full: false });
  // 双指放大
  const [mx, my] = await boxCenter(page);
  await touch(page, 'touchStart', [[mx - 40, my], [mx + 40, my]]);
  await touch(page, 'touchMove', [[mx - 80, my], [mx + 80, my]]);
  await touch(page, 'touchMove', [[mx - 120, my], [mx + 120, my]]);
  await touch(page, 'touchEnd', []);
  await sleep(200);
  const pinched = await scale(page);
  assert.ok(pinched > 2, `双指放大后比例 ${pinched}`);
  evidence.pinchScale = pinched;
  await page.screenshot(path.join(out, 'C3-mobile-pinch-zoomed.png'), { full: false });
  // 放大后单指拖动
  await touch(page, 'touchStart', [[mx, my]]);
  await touch(page, 'touchMove', [[mx - 60, my - 40]]);
  await touch(page, 'touchEnd', []);
  await sleep(200);
  const dragged = await page.evaluate(() => document.querySelector('[data-testid=note-viewer-img]').style.transform);
  assert.match(dragged, /translate\((?!0px, 0px)/, `拖动后位移 ${dragged}`);
  // 双击还原，再双击放大 2 倍
  await tap(page, mx, my); await tap(page, mx, my);
  await sleep(200);
  assert.equal(await scale(page), 1, '双击还原');
  await tap(page, mx, my); await tap(page, mx, my);
  await sleep(200);
  assert.equal(await scale(page), 2, '双击放大 2 倍');
  // 切页回到完整显示
  await page.click('[data-testid=note-viewer-next]');
  assert.equal(await title(page), '第 3 / 3 页');
  assert.equal(await scale(page), 1, '换页后还原');
  await page.screenshot(path.join(out, 'C4-mobile-next-page.png'), { full: false });
  await page.click('[data-testid=note-viewer-close]');
  await sleep(300);
  const after = await scrollTop(page);
  assert.ok(Math.abs(after - before) <= 2, `关闭后滚动位置不变：${before} -> ${after}`);
  evidence.scrollTop = { before, after };

  // ---- D. 确认入库 / 重新选择后入口消失 ----
  await page.click('[data-testid=inbox-confirm]');
  await page.waitFor('[data-testid=inbox-result]');
  const gone = () => page.evaluate(() => document.querySelectorAll('[data-testid^=inbox-page-chip-], [data-testid=note-viewer], [data-testid=inbox-pages]').length);
  assert.equal(await gone(), 0, '确认入库后查看器入口消失、页面清空');
  await recognizeAll(page);
  assert.ok(await page.evaluate(() => document.querySelectorAll('[data-testid^=inbox-page-chip-]').length) > 0);
  await page.click('[data-testid=inbox-reset]');
  assert.equal(await gone(), 0, '重新选择后同样清空');

  const unexpected = page.errors.filter(error => error !== 'plugin http not found');
  assert.deepEqual(unexpected, []);
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
