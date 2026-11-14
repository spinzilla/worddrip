// 026 + 068 真实窗口：本机假视觉模型；页面直接塞文件（图片 / PDF），不走系统文件对话框。
// 覆盖：3 张图 → 进度 3/3 → 合并候选（来自第几页、拿不准）→ 确认入库；3 页 PDF；第 2 页失败后重试；
// HTTP 400 带 image → 不支持看图提示；中途取消；不清晰提醒；手机 390 / 130% 字号。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { start, stop } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { openDb, queryRows } from '../../../e2e/db.mjs';

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.resolve('src-tauri/target/e2e', `068-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });

// 每页（1~3）固定的模型回答；合并后：alpha(已存在) resiliant(拿不准,p1) obsolete(p2) candid(p2+p3) zeta(p3)
const WORDS = {
  1: [{ word: 'alpha', note: '词库已有', uncertain: false }, { word: 'resiliant', note: '拼写存疑', uncertain: true }],
  2: [{ word: 'obsolete', note: '这条会删除', uncertain: false }, { word: 'candid', note: '坦率的', uncertain: false }],
  3: [{ word: 'Candid', note: '例：a candid answer', uncertain: false }, { word: 'zeta', note: '', uncertain: false }],
};
// 页面传来的图片，缩放后的尺寸 → 第几页。三张图：3000x2000(应被缩成 2000x1333)、1100x800、1200x800；PDF 三页：400x600、500x600、600x600（渲染成长边 2000）。
const SIZES = [[2000, 1333], [1100, 800], [1200, 800], [1333, 2000], [1667, 2000], [2000, 2000]];
let mode = 'normal';
let page2Failures = 0;
const received = [];

const jpegSize = buffer => {
  let i = 2;
  while (i < buffer.length) {
    if (buffer[i] !== 0xff) { i += 1; continue; }
    const marker = buffer[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buffer.readUInt16BE(i + 5), w: buffer.readUInt16BE(i + 7) };
    }
    i += 2 + buffer.readUInt16BE(i + 2);
  }
  throw new Error('不是 JPEG');
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(req.url, '/v1/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer dummy-e2e-key');
  assert.equal(payload.model, 'fake-vision');
  const url = payload.messages[0].content[1].image_url.url;
  assert.match(url, /^data:image\/jpeg;base64,/, '预处理后统一发 JPEG');
  assert.match(payload.messages[0].content[0].text, /中文释义、例句、划线和箭头/);
  const size = jpegSize(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
  assert.ok(Math.max(size.w, size.h) <= 2000, `长边不能超过 2000：${size.w}x${size.h}`);
  const found = SIZES.findIndex(([w, h]) => Math.abs(w - size.w) <= 3 && Math.abs(h - size.h) <= 3);
  assert.ok(found >= 0, `认不出是哪一页：${size.w}x${size.h}`);
  const pageNo = (found % 3) + 1;
  received.push({ mode, pageNo, w: size.w, h: size.h });
  res.setHeader('Content-Type', 'application/json');
  const answer = words => res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ words }) } }] }));
  if (mode === 'fail2' && pageNo === 2 && page2Failures < 1) {
    page2Failures += 1;
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: 'boom dummy-e2e-key-must-not-leak' }));
  }
  if (mode === 'vision400') {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: { message: 'image input is not supported by this model' } }));
  }
  if (mode === 'cancel' && pageNo !== 1) await delay(4000);
  if (mode === 'unclear' && pageNo === 2) return answer([]);
  return answer(WORDS[pageNo]);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;

// 3 页 PDF（Helvetica 写英文词），手写最小 PDF，不依赖任何库。
const makePdf = () => {
  const pagesSpec = [[400, 600, 'alpha resiliant'], [500, 600, 'obsolete candid'], [600, 600, 'candid zeta']];
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pagesSpec.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count 3 >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pagesSpec.forEach(([w, h, text], i) => {
    const content = `BT /F1 36 Tf 40 ${h - 80} Td (${text}) Tj ET`;
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objs[5 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let body = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i += 1) { offsets[i] = body.length; body += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = body.length;
  body += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
};

const invoke = async (page, command, args = {}) => {
  const outcome = await page.evaluate(async (cmd, payload) => {
    try { return { value: await window.__TAURI_INTERNALS__.invoke(cmd, payload) }; }
    catch (error) { return { error: typeof error === 'string' ? error : String(error) }; }
  }, command, args);
  if (outcome.error) throw new Error(`${command} 失败：${outcome.error}`);
  return outcome.value;
};
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const localDate = () => {
  const date = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const sleep = delay;

// 在页面里画出指定尺寸的 JPEG / PNG 文件并塞进文件框。
const pickImages = (page, specs, inputTestId = 'inbox-file') => page.evaluate(async (list, testId) => {
  const files = [];
  for (const { w, h, name, type } of list) {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#123'; ctx.font = '60px sans-serif'; ctx.fillText(name, 40, 120);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, type, 0.9));
    files.push(new File([blob], name, { type }));
  }
  const input = document.querySelector(`[data-testid=${testId}]`);
  const transfer = new DataTransfer();
  files.forEach(file => transfer.items.add(file));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, specs, inputTestId);
const IMAGES = [
  { w: 3000, h: 2000, name: 'note-1.jpg', type: 'image/jpeg' },
  { w: 1100, h: 800, name: 'note-2.png', type: 'image/png' },
  { w: 1200, h: 800, name: 'note-3.jpg', type: 'image/jpeg' },
];
const pickPdf = (page, buffer) => page.evaluate(async b64 => {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const input = document.querySelector('[data-testid=inbox-file]');
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], '讲义.pdf', { type: 'application/pdf' }));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, buffer.toString('base64'));
const pageCount = page => page.evaluate(() => document.querySelectorAll('[data-testid^=inbox-page-][data-state]').length);
const statusText = (page, i) => page.text(`[data-testid=inbox-page-status-${i}]`);
const resetIfNeeded = async page => {
  if (await page.evaluate(() => !!document.querySelector('[data-testid=inbox-reset]'))) await page.click('[data-testid=inbox-reset]');
  await page.waitUntil('页面列表清空', '!document.querySelector("[data-testid=inbox-pages]")');
};
const candidateWords = page => page.evaluate(() => [...document.querySelectorAll('[data-testid^=inbox-word-]')].map(input => input.value));

let session;
let page;
let passed = false;
const evidence = {};
try {
  session = await start({ runDir, port: 9462 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await invoke(page, 'vocab_inbox_confirm', { request: { date: '2026-11-08', words: [{ word: 'alpha', note: '原有词' }] } });
  const hook = () => page.evaluate(baseUrl => {
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({ baseUrl, apiKey: 'dummy-e2e-key', model: 'fake-vision', temperature: 0.7 }));
    // launch.mjs 为避免插件写系统 Known Folder 而关闭 http 插件；只在这个开发隔离窗口改用浏览器 fetch。
    window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);
  }, `http://127.0.0.1:${port}/v1`);
  await hook();
  await page.clickText('词库');
  await page.clickText('录笔记');

  // ---- 提醒文字 ----
  assert.match(await page.text('[data-testid=inbox-clarity-tip]'), /请用清晰、光线均匀、正对拍摄的图片或 PDF.*扫描/);
  await page.screenshot(path.join(out, '00-desktop-empty.png'));

  // ---- A. 3 张图（含一张 3000x2000 要被缩小）----
  await pickImages(page, IMAGES);
  await page.waitUntil('3 张缩略图', 'document.querySelectorAll("[data-testid^=inbox-page-][data-state]").length === 3');
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid^=inbox-page-][data-state] img').length), 3);
  // 删页：删掉第 3 张再补回（顺序不变）
  await page.click('[data-testid=inbox-page-delete-2]');
  assert.equal(await pageCount(page), 2);
  await pickImages(page, [IMAGES[2]]);
  await page.waitUntil('补回 3 张', 'document.querySelectorAll("[data-testid^=inbox-page-][data-state]").length === 3');
  await page.screenshot(path.join(out, '01-three-images-pending.png'));
  await page.click('[data-testid=inbox-recognize]');
  await page.waitFor('[data-testid=inbox-candidates]');
  await page.waitUntil('进度 3/3', 'document.querySelector("[data-testid=inbox-progress]")?.textContent.includes("3 / 3")');
  assert.deepEqual(await candidateWords(page), ['alpha', 'resiliant', 'obsolete', 'candid', 'zeta']);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=inbox-check-0]').checked), false);
  assert.match(await page.text('[data-testid=inbox-existing-0]'), /已存在/);
  assert.match(await page.text('[data-testid=inbox-uncertain-1]'), /拿不准/);
  assert.match(await page.text('[data-testid=inbox-pages-3]'), /来自\s*第 2 页\s*第 3 页/);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=inbox-note-3]').value), '坦率的；例：a candid answer', '备注合并');
  assert.equal(received.filter(r => r.mode === 'normal').length, 3);
  assert.ok(received.some(r => r.w === 2000 && r.h === 1333), '3000x2000 的图缩成 2000x1333');
  await page.screenshot(path.join(out, '02-three-images-candidates.png'));
  evidence.imageFlow = { received: received.slice() };

  let db = await openDb(session);
  const before = queryRows(db, 'review_word');
  db.close();
  assert.equal(before.length, 1);
  await page.type('[data-testid=inbox-word-1]', 'resilient');
  await page.type('[data-testid=inbox-note-1]', '有韧性（已核对）');
  await page.click('[data-testid=inbox-delete-2]');
  assert.match(await page.text('[data-testid=inbox-selected-count]'), /已勾选 3 \/ 4 条/);
  db = await openDb(session);
  assert.deepEqual(queryRows(db, 'review_word'), before, '识别、编辑和删除候选都不能写数据库');
  db.close();
  await page.click('[data-testid=inbox-confirm]');
  await page.waitFor('[data-testid=inbox-result]');
  assert.match(await page.text('[data-testid=inbox-result]'), /已确认入库 3 条/);
  db = await openDb(session);
  const after = queryRows(db, 'review_word');
  db.close();
  assert.deepEqual(after.map(row => row.word).sort(), ['alpha', 'candid', 'resilient', 'zeta']);
  for (const word of after.filter(row => row.word !== 'alpha')) {
    assert.equal(word.status, '🌱待考察');
    assert.equal(word.source, `手写 ${localDate()}`);
    assert.equal(word.verification_status, '未查证');
  }
  assert.equal(after.find(row => row.word === 'resilient').note, '有韧性（已核对）');
  assert.equal(after.some(row => row.word === 'obsolete' || row.word === 'resiliant'), false);
  // 浏览里能查到新词
  await page.clickText('浏览');
  await page.waitUntil('浏览里出现 zeta', 'document.body.innerText.includes("zeta")');
  await page.screenshot(path.join(out, '03-browse-after-confirm.png'));
  evidence.savedWords = after.map(row => row.word).sort();
  await page.clickText('录笔记');

  // ---- B. 3 页 PDF ----
  await pickPdf(page, makePdf());
  await page.waitUntil('PDF 3 页缩略图', 'document.querySelectorAll("[data-testid^=inbox-page-][data-state] img").length === 3', { timeout: 60000 });
  assert.match(await page.text('[data-testid=inbox-page-0]'), /讲义\.pdf 第 1 页/);
  await page.screenshot(path.join(out, '04-pdf-thumbnails.png'));
  mode = 'normal';
  await page.click('[data-testid=inbox-recognize]');
  await page.waitFor('[data-testid=inbox-candidates]');
  await page.waitUntil('PDF 进度 3/3', 'document.querySelector("[data-testid=inbox-progress]")?.textContent.includes("3 / 3")');
  assert.deepEqual(await candidateWords(page), ['alpha', 'resiliant', 'obsolete', 'candid', 'zeta']);
  const pdfReceived = received.filter(r => r.h === 2000 && r.w >= 1333);
  assert.equal(pdfReceived.length, 3, 'PDF 每页渲染成长边 2000 的图各发一次');
  await page.screenshot(path.join(out, '05-pdf-candidates.png'));
  await resetIfNeeded(page);

  // ---- C. 第 2 页失败，其余正常，单页重试 ----
  mode = 'fail2';
  await pickImages(page, IMAGES);
  await page.waitUntil('3 张', 'document.querySelectorAll("[data-testid^=inbox-page-][data-state]").length === 3');
  await page.click('[data-testid=inbox-recognize]');
  await page.waitUntil('第 2 页失败', 'document.querySelector("[data-testid=inbox-page-status-1]")?.textContent.includes("失败")');
  await page.waitUntil('识别结束', '!!document.querySelector("[data-testid=inbox-reset]")');
  assert.match(await statusText(page, 0), /完成 · 认出 2 个/);
  assert.match(await statusText(page, 2), /完成 · 认出 2 个/);
  const failText = await statusText(page, 1);
  assert.doesNotMatch(failText, /dummy-e2e-key/, '界面不带密钥');
  assert.match(failText, /HTTP 500/, '沿用现有做法：只带清洗过的状态码和简短原因，密钥已被遮掉');
  assert.deepEqual(await candidateWords(page), ['alpha', 'resiliant', 'Candid', 'zeta']);
  await page.screenshot(path.join(out, '06-page2-failed.png'));
  await page.click('[data-testid=inbox-page-retry-1]');
  await page.waitUntil('第 2 页重试成功', 'document.querySelector("[data-testid=inbox-page-status-1]")?.textContent.includes("完成")');
  assert.deepEqual((await candidateWords(page)).map(w => w.toLowerCase()).sort(), ['alpha', 'candid', 'obsolete', 'resiliant', 'zeta']);
  await page.screenshot(path.join(out, '07-page2-retried.png'));
  await resetIfNeeded(page);

  // ---- D. 400 带 image → 不支持看图 ----
  mode = 'vision400';
  await pickImages(page, [IMAGES[1]]);
  await page.waitUntil('1 张', 'document.querySelectorAll("[data-testid^=inbox-page-][data-state]").length === 1');
  await page.click('[data-testid=inbox-recognize]');
  await page.waitFor('[data-testid=inbox-vision-hint]');
  assert.match(await page.text('[data-testid=inbox-vision-hint]'), /当前模型可能不支持看图.*设置 → AI/);
  assert.doesNotMatch(await page.text('body'), /dummy-e2e-key/);
  await page.screenshot(path.join(out, '08-vision-unsupported.png'));
  await page.waitUntil('识别结束', '!!document.querySelector("[data-testid=inbox-reset]")');
  await resetIfNeeded(page);

  // ---- E. 中途取消：第 1 页已识别保留，其余停下 ----
  mode = 'cancel';
  await pickImages(page, IMAGES);
  await page.waitUntil('3 张', 'document.querySelectorAll("[data-testid^=inbox-page-][data-state]").length === 3');
  await page.click('[data-testid=inbox-recognize]');
  await page.waitUntil('第 1 页识别完', 'document.querySelector("[data-testid=inbox-page-status-0]")?.textContent.includes("完成")');
  await page.screenshot(path.join(out, '09-cancel-progress.png'));
  const t0 = Date.now();
  await page.click('[data-testid=inbox-cancel]');
  await page.waitFor('[data-testid=inbox-candidates]');
  assert.ok(Date.now() - t0 < 3000, '取消要立刻生效，不等 4 秒的慢请求');
  assert.match(await page.text('[data-testid=inbox-notice]'), /已取消/);
  assert.deepEqual(await candidateWords(page), ['alpha', 'resiliant']);
  assert.match(await statusText(page, 1), /已取消/);
  await page.screenshot(path.join(out, '10-cancelled.png'));
  await resetIfNeeded(page);

  // ---- F. 某页一个词都没认出 → 提醒扫描后重录 ----
  mode = 'unclear';
  await pickImages(page, IMAGES);
  await page.waitUntil('3 张', 'document.querySelectorAll("[data-testid^=inbox-page-][data-state]").length === 3');
  await page.click('[data-testid=inbox-recognize]');
  await page.waitFor('[data-testid=inbox-unclear-warning]');
  assert.match(await page.text('[data-testid=inbox-unclear-warning]'), /这几页可能不够清晰，建议扫描后重录/);
  await page.screenshot(path.join(out, '11-unclear-warning.png'));
  await resetIfNeeded(page);
  mode = 'normal';

  // ---- G. 手机 UA 390x844，另一次 130% 字号 ----
  await page.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', platform: 'Linux armv8l' });
  await page.setViewport(390, 844, { mobile: true, dpr: 2 });
  await page.reload();
  await page.waitReady();
  await hook();
  await page.clickText('词库');
  await page.clickText('录笔记');
  await page.waitFor('[data-testid=inbox-camera]', { visible: false });
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=inbox-camera]').getAttribute('capture')), 'environment');
  assert.equal(await noOverflow(page), true);
  const tabs = await page.evaluate(() => {
    const list = [...document.querySelectorAll('[role=tab]')].filter(el => ['浏览', '场景', '录笔记', '随手记'].includes(el.textContent.trim())).map(el => el.getBoundingClientRect());
    return { count: list.length, oneRow: new Set(list.map(r => Math.round(r.top))).size === 1 };
  });
  assert.equal(tabs.count, 4);
  assert.equal(tabs.oneRow, true, '分段切换条一行');
  await page.screenshot(path.join(out, '12-mobile-390.png'));
  await pickImages(page, IMAGES, 'inbox-camera');
  await page.waitUntil('拍照加入 3 张', 'document.querySelectorAll("[data-testid^=inbox-page-][data-state]").length === 3');
  const buttonHeights = await page.evaluate(() => [...document.querySelectorAll('[data-testid=inbox-recognize], [data-testid=inbox-page-delete-0]')].map(el => Math.round(el.getBoundingClientRect().height)));
  assert.ok(buttonHeights.every(height => height >= 44), `按钮高度 ≥44：${buttonHeights}`);
  await page.screenshot(path.join(out, '13-mobile-390-pages.png'));
  await page.evaluate(() => { document.documentElement.style.fontSize = '130%'; });
  await sleep(400);
  assert.equal(await noOverflow(page), true, '130% 字号不溢出');
  await page.screenshot(path.join(out, '14-mobile-390-130.png'));
  await page.click('[data-testid=inbox-recognize]');
  await page.waitFor('[data-testid=inbox-candidates]');
  assert.equal(await noOverflow(page), true);
  await page.screenshot(path.join(out, '15-mobile-390-candidates.png'));

  const unexpectedErrors = page.errors.filter(error => error !== 'plugin http not found');
  assert.deepEqual(unexpectedErrors, []);
  evidence.screenshots = fs.readdirSync(out).filter(name => name.endsWith('.png')).sort();
  evidence.fakeModelRequests = received.length;
  evidence.unexpectedErrors = unexpectedErrors;
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
