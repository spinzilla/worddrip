// 055 随手记隔离真实窗口：Ctrl+M 弹框，首页 / 词条的上下文，Esc 不存，去掉上下文，Ctrl+J 不被抢，重启后还在，1280 / 390 截图。
// 末尾还覆盖：看视频页（用 tone.mp4 + 夹具字幕）暂停 / 上下文 / 保存后恢复；听写页 Ctrl+M 不进字、Ctrl+J 仍是「从这个词播」。
// 用法（在 app 目录）：node dev/fixtures/quicknote/e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, stop, restart, DEV_PORT } from '../../e2e/launch.mjs';
import { connect } from '../../e2e/cdp.mjs';
import { portInUse } from '../../e2e/proc.mjs';

if (await portInUse(DEV_PORT)) {
  console.error(`${DEV_PORT} 端口已被占用，先关掉别的开发窗口再测。`);
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.resolve('D:/tmp/es-e2e', `055-quicknote-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const today = localDate();
const importRequest = {
  upgrade: { fileName: 'empty-upgrade.md', content: '# 学术升级库\n' },
  review: { fileName: 'quicknote-055.md', content: '# 词汇总词库\n' },
  entries: [{ id: 'dummy@1', line: 2, raw: '| dummy |', plain: 'dummy', upgrade: 'dummy', source: '测试', note: '' }], examples: [], selfChecks: [],
  reviewWords: [{ id: 'mitigate@1', ord: 1, line: 2, raw: '| mitigate |', word: 'mitigate', issue: '55', addedAt: today, status: 'L1', level: 1, due: today, note: '' }],
  warnings: { upgrade: [], review: [] },
};
// 看视频 / 听写用的夹具：tone.mp4 复制到隔离目录，配三句字幕。
const media = path.join(runDir, 'fixture-tone.mp4');
fs.copyFileSync(fileURLToPath(new URL('../../../src-tauri/tests/fixtures/tone.mp4', import.meta.url)), media);
const VIDEO_ID = 'quicknote-video-055';
const VIDEO_NAME = 'quicknote-tone.mp4';
const SUBS = [
  { from: 0, to: 0.9, text: 'Hello brave world' },
  { from: 0.9, to: 1.8, text: 'Second line here' },
  { from: 1.8, to: 2.7, text: 'Third line done' },
];
const srtTime = s => `00:00:${String(Math.floor(s)).padStart(2, '0')},${String(Math.round((s % 1) * 1000)).padStart(3, '0')}`;
const subtitleText = SUBS.map((s, i) => `${i + 1}\n${srtTime(s.from)} --> ${srtTime(s.to)}\n${s.text}\n`).join('\n');
const videoRecord = {
  id: VIDEO_ID, displayName: VIDEO_NAME, videoFileName: VIDEO_NAME, subtitleFileName: 'quicknote-tone.srt', subtitleText,
  currentSubtitleIndex: 0, currentSectionIndex: 0, totalSubtitles: SUBS.length, completionRate: 0,
  dateAdded: Date.now(), lastPracticed: Date.now(), totalPracticeTime: 0, learningMode: 'DICTATION', blurPlaybackMode: 'SENTENCE_BY_SENTENCE', videoPath: media,
};
const seedVideo = record => new Promise((resolve, reject) => {
  const req = indexedDB.open('linguaclip_db', 1);
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction('videos', 'readwrite');
    tx.objectStore('videos').put(record);
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => reject(tx.error);
  };
  req.onerror = () => reject(req.error);
});
const issueFiles = [{ fileName: '20261112.md', content: '## 词单分析\n1. **mitigate** v. — to make less harmful（减轻）；*Trees mitigate the damage.*\n' }];

const invoke = async (page, command, args = {}) => {
  const result = await page.evaluate(async (cmd, payload) => {
    try { return { value: await window.__TAURI_INTERNALS__.invoke(cmd, payload) }; }
    catch (error) { return { error: typeof error === 'string' ? error : String(error) }; }
  }, command, args);
  if (result.error) throw new Error(`${command} 失败：${result.error}`);
  return result.value;
};
const shot = (page, name) => page.screenshot(path.join(out, name), { full: false });
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const key = (page, k, code, vk, modifiers = 0, extra = {}) => page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...extra })
  .then(() => page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers }));
const ctrlM = page => key(page, 'm', 'KeyM', 77, 2);
const ctrlJ = page => key(page, 'j', 'KeyJ', 74, 2);
const esc = page => key(page, 'Escape', 'Escape', 27);
const enter = page => page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  .then(() => page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }));
const box = page => page.evaluate(() => !!document.querySelector('[data-testid=quicknote]'));
const notes = page => invoke(page, 'quicknote_list', { status: null });
const openBox = async page => { await ctrlM(page); await page.waitFor('[data-testid=quicknote-input]'); };
const typeAndSave = async (page, text) => {
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.testid), 'quicknote-input', '输入框应自动获得焦点');
  await page.send('Input.insertText', { text });
  await enter(page);
  await page.waitUntil('快捷框关闭', `!document.querySelector('[data-testid=quicknote]')`);
};
const openMitigate = async page => {
  await page.clickText('词库', { timeout: 60000 });
  await page.clickText('查词', { selector: 'button[role=tab]', exact: true });
  await page.waitFor('[data-testid=vocab-list]');
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-testid=vocab-list] > button')].find(e => e.innerText.trim().startsWith('mitigate'));
    if (!row) throw new Error('列表里没有 mitigate');
    row.click();
  });
  await page.waitFor('[data-testid=word-detail]');
};

let session;
let page;
let ok = false;
try {
  session = await start({ runDir, port: 9472 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.clickText('词库', { timeout: 60000 });
  await invoke(page, 'vocab_import', { request: importRequest });
  await invoke(page, 'vocab_definition_import', { request: { issues: issueFiles, eagp: null } });
  await page.reload();
  await page.waitReady();

  // 1. 首页：Ctrl+M → 上下文「无」→ 写一句回车
  assert.equal((await notes(page)).length, 0, '开跑前没有随手记');
  await openBox(page);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=quicknote-context]').dataset.kind), 'none');
  await shot(page, '01-home-1280.png');
  await typeAndSave(page, '首页随手一句');
  let list = await notes(page);
  assert.equal(list.length, 1);
  assert.equal(list[0].body, '首页随手一句');
  assert.equal(list[0].context.kind, 'none');
  assert.equal(list[0].status, '待整理');
  await page.waitFor('[data-testid=quicknote-toast]');
  assert.match(await page.text('[data-testid=quicknote-toast]'), /已记下/);

  // 2. Ctrl+J 不被随手记抢：不弹框
  await ctrlJ(page);
  await new Promise(r => setTimeout(r, 400));
  assert.equal(await box(page), false, 'Ctrl+J 不该打开随手记');

  // 3. Esc 不存；空白不存
  await openBox(page);
  await page.send('Input.insertText', { text: '不该存下的' });
  await esc(page);
  await page.waitUntil('Esc 关框', `!document.querySelector('[data-testid=quicknote]')`);
  await openBox(page);
  await page.send('Input.insertText', { text: '   ' });
  await enter(page);
  await new Promise(r => setTimeout(r, 400));
  await esc(page);
  await page.waitUntil('关框', `!document.querySelector('[data-testid=quicknote]')`);
  assert.equal((await notes(page)).length, 1, 'Esc 和空白都不该存');

  // 4. 词条详情：上下文是这个词条
  await openMitigate(page);
  await openBox(page);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=quicknote-context]').dataset.kind), 'entry');
  assert.match(await page.text('[data-testid=quicknote-context]'), /mitigate/);
  await shot(page, '02-entry-1280.png');
  await typeAndSave(page, '词条随手一句');
  list = await notes(page);
  const entryNote = list.find(n => n.body === '词条随手一句');
  assert.equal(entryNote.context.kind, 'entry');
  assert.equal(entryNote.context.word, 'mitigate');
  assert.equal(list[0].body, '词条随手一句', '按时间倒序');

  // 5. 去掉上下文后存 → 无
  await openBox(page);
  await page.click('[data-testid=quicknote-drop]');
  await page.waitUntil('上下文被去掉', `document.querySelector('[data-testid=quicknote-context]')?.dataset.kind === 'none'`);
  await typeAndSave(page, '去掉上下文的一句');
  assert.equal((await notes(page)).find(n => n.body === '去掉上下文的一句').context.kind, 'none');

  // 6. 390 宽
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  await openBox(page);
  assert.equal(await noOverflow(page), true, '390 宽框打开后横向溢出');
  const r = await page.evaluate(() => { const b = document.querySelector('[data-testid=quicknote]').getBoundingClientRect(); return { l: b.left, r: b.right, w: innerWidth }; });
  assert.ok(r.l >= 0 && r.r <= r.w, `390 宽框超出屏幕：${JSON.stringify(r)}`);
  await shot(page, '03-entry-390.png');
  await esc(page);
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });

  // 7. 重启后还在
  page.close();
  session = await restart(runDir, { port: 9472 });
  page = await connect({ port: session.port });
  await page.waitReady();
  list = await notes(page);
  assert.deepEqual(list.map(n => n.body), ['去掉上下文的一句', '词条随手一句', '首页随手一句']);

  // 8. 看视频页：Ctrl+M 暂停、上下文是当前字幕句 + 时间点、回车保存后继续播放
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.evaluate(seedVideo, videoRecord);
  await page.reload();
  await page.waitReady();
  await page.clickText('视频', { timeout: 60000 });
  await page.waitText(VIDEO_NAME);
  await page.click('button[aria-label="更多"]');
  await page.clickText('换个练法', { selector: '[role=menuitem], button' });
  await page.clickText('看剧', { selector: '[role=radio], button, label' });
  await page.clickText('开始看剧');
  await page.waitFor('video');
  await page.evaluate(() => { document.querySelector('video').loop = true; }); // 夹具视频只有几秒，循环着播才一直是「在播」
  await page.waitUntil('看视频页开始播放', `(() => { const v = document.querySelector('video'); return v && !v.paused && v.currentTime > 0.1; })()`, { timeout: 30000 });
  let watchLabel = '';
  for (let tries = 0; tries < 8; tries += 1) { // 偶尔按在两句之间的空隙里，没有字幕句就关掉重按
    await ctrlM(page);
    await page.waitFor('[data-testid=quicknote-input]');
    watchLabel = await page.text('[data-testid=quicknote-context]');
    if (watchLabel.startsWith('字幕：')) break;
    await esc(page);
    await page.waitUntil('关框', `!document.querySelector('[data-testid=quicknote]')`);
    await new Promise(r => setTimeout(r, 300));
  }
  assert.ok(watchLabel.startsWith('字幕：'), `看视频页上下文没有字幕句：${watchLabel}`);
  assert.equal(await page.evaluate(() => document.querySelector('video').paused), true, 'Ctrl+M 后视频应暂停');
  const pausedAt = await page.evaluate(() => document.querySelector('video').currentTime);
  const lineNow = SUBS.find(s => pausedAt >= s.from && pausedAt < s.to);
  assert.ok(lineNow, `暂停时间 ${pausedAt} 不在任何字幕句里`);
  assert.ok(watchLabel.includes(`字幕：${lineNow.text}`), `上下文应是当前字幕句「${lineNow.text}」：${watchLabel}`);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=quicknote-context]').dataset.kind), 'video');
  const mmss = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  assert.ok(watchLabel.endsWith(mmss(pausedAt)), `上下文里的时间点应是 ${mmss(pausedAt)}：${watchLabel}`);
  await shot(page, '04-watch-1280.png');
  await typeAndSave(page, '看视频随手一句');
  await page.waitUntil('保存后视频继续播放', `!document.querySelector('video').paused`, { timeout: 10000 });
  const watchNote = (await notes(page)).find(n => n.body === '看视频随手一句');
  assert.ok(watchNote, '库里没有看视频那条');
  assert.equal(watchNote.context.kind, 'video');
  assert.equal(watchNote.context.text, lineNow.text);
  assert.ok(Math.abs(watchNote.context.time - pausedAt) < 0.5, `时间点不对：${watchNote.context.time} vs ${pausedAt}`);
  assert.equal(watchNote.context.videoId, VIDEO_ID);
  // 本来就暂停着时：打开再保存，不应被自动播放
  await page.evaluate(() => document.querySelector('video').pause());
  await ctrlM(page);
  await page.waitFor('[data-testid=quicknote-input]');
  await esc(page);
  await page.waitUntil('关框', `!document.querySelector('[data-testid=quicknote]')`);
  await new Promise(r => setTimeout(r, 400));
  assert.equal(await page.evaluate(() => document.querySelector('video').paused), true, '原来是暂停的，关框后不该自己播');
  // 回首页
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 30, bubbles: true })));
  await page.mouseClick(300, 30);
  await page.clickText('回到你的视频列表', { selector: 'button, [role=button]', exact: false, timeout: 10000 }).catch(async () => { await page.click('button[aria-label="回到你的视频列表"]'); });
  await page.waitText(VIDEO_NAME);

  // 9. 听写页：Ctrl+M 开框且听写格没多字；Esc 后 Ctrl+J 仍是「从这个词播」
  await page.click('button[aria-label="更多"]');
  await page.clickText('换个练法', { selector: '[role=menuitem], button' });
  await page.clickText('按段从头练', { selector: '[role=radio], button, label' });
  await page.clickText('开始练习', { selector: 'button' });
  const cellSel = 'input[type=text][size="1"]:not([placeholder])';
  await page.waitFor(cellSel, { timeout: 40000 });
  await page.evaluate(() => { const v = document.querySelector('video'); window.__plays = 0; v.addEventListener('play', () => { window.__plays += 1; }); });
  await page.evaluate(sel => { const c = document.querySelector(sel); c.focus(); }, cellSel);
  await page.send('Input.insertText', { text: 'x' });
  assert.equal(await page.evaluate(sel => document.querySelector(sel).value, cellSel), 'x');
  await ctrlM(page);
  await page.waitFor('[data-testid=quicknote-input]');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=quicknote-context]').dataset.kind), 'dictation');
  await page.send('Input.insertText', { text: 'abc' });
  assert.equal(await page.evaluate(sel => document.querySelector(sel).value, cellSel), 'x', '听写格的内容在 Ctrl+M 前后应不变');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=quicknote-input]').value), 'abc');
  await shot(page, '05-dictation-1280.png');
  await esc(page);
  await page.waitUntil('关框', `!document.querySelector('[data-testid=quicknote]')`);
  assert.equal(await page.evaluate(sel => document.querySelector(sel).value, cellSel), 'x', 'Esc 后听写格内容仍不变');
  assert.equal((await notes(page)).filter(n => n.context.kind === 'dictation').length, 0, 'Esc 不该存下听写那条');
  // 清空格子后按 Ctrl+J：「从这个词播」照常生效（视频重新开始播放）
  await page.waitUntil('焦点回到听写格', `document.activeElement?.matches?.(${JSON.stringify(cellSel)})`);
  await page.evaluate(sel => { const c = document.querySelector(sel); c.select(); }, cellSel);
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  assert.equal(await page.evaluate(sel => document.querySelector(sel).value, cellSel), '', '格子应已清空');
  await page.evaluate(() => { document.querySelector('video').pause(); window.__plays = 0; });
  await ctrlJ(page);
  await page.waitUntil('Ctrl+J 触发「从这个词播」', `window.__plays > 0 || !document.querySelector('video').paused`, { timeout: 10000 });
  assert.equal(await box(page), false, 'Ctrl+J 不该打开随手记');

  console.log(JSON.stringify({ result: '通过', runDir, shots: fs.readdirSync(out).filter(n => n.endsWith('.png')), pageErrors: page.errors }, null, 2));
  ok = true;
} catch (error) {
  console.error(error.stack || error);
  if (page && !page.closed) await shot(page, '99-failure.png').catch(() => {});
} finally {
  page?.close();
  if (session) await stop(runDir).catch(error => console.error(`停止隔离窗口失败：${error.message}`));
}
process.exit(ok ? 0 : 1);
