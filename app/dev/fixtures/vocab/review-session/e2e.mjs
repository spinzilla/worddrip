// 014 真实窗口验收脚本：隔离启动 Windows Tauri 开发窗口，导入按今天生成的词表，
// 核对到期数量和顺序，实际操作闪卡（点击 + 真实按键），比较复习前后数据库，截图。
// 用法（在 app 目录）：node dev/fixtures/vocab/review-session/e2e.mjs
// 证据：D:\tmp\es-e2e\014-<时间>\out\（可用 ES_E2E_ROOT 换根目录），退出码 0 = 通过。
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { start, stop } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { chooseFile } from '../../../e2e/dialog.mjs';
import { openDb, listTables, queryRows } from '../../../e2e/db.mjs';
import { makeFixtures } from './make.mjs';

const root = process.env.ES_E2E_ROOT || 'D:\\tmp\\es-e2e';
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.join(root, `014-${stamp}`);
const out = path.join(runDir, 'out');
const fixDir = `${runDir}-fixtures`; // 放在运行目录外，start() 拿到的是全新目录
fs.mkdirSync(fixDir, { recursive: true });
const { none, due, one, expected } = makeFixtures();
const fix = name => path.join(fixDir, name);
fs.writeFileSync(fix('review-none.md'), none, 'utf8');
fs.writeFileSync(fix('review-due.md'), due, 'utf8');
fs.writeFileSync(fix('review-one.md'), one, 'utf8');
fs.copyFileSync(new URL('../import/upgrade.md', import.meta.url), fix('upgrade.md'));
// 听写用的真实媒体：仓库里的 3 秒测试视频 tone.mp4，配一份落在 3 秒内的 3 句字幕（放在临时目录，不进仓库）。
const VIDEO = fileURLToPath(new URL('../../../../src-tauri/tests/fixtures/tone.mp4', import.meta.url));
fs.writeFileSync(fix('tone-lines.srt'),
  '1\n00:00:00,000 --> 00:00:00,900\nfirst line here\n\n'
  + '2\n00:00:01,000 --> 00:00:01,900\nsecond line here\n\n'
  + '3\n00:00:02,000 --> 00:00:02,900\nthird line here\n', 'utf8');

const log = [];
const note = (k, v) => { const line = `${k}: ${v}`; log.push(line); console.log(line); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = (page, name) => page.screenshot(path.join(out, name));
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const snapshot = db => Object.fromEntries(listTables(db).map(t => [t, queryRows(db, t)]));
const KEYS = {
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ' ': { code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
};
/** 真实按键（经浏览器输入管线，不是在页面里伪造事件）。mods：{ ctrl, shift }。 */
async function press(page, key, mods = {}) {
  const k = KEYS[key];
  const modifiers = (mods.ctrl ? 2 : 0) | (mods.shift ? 8 : 0);
  const text = modifiers & 2 ? undefined : k.text;
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, text, modifiers });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, modifiers });
  await sleep(120);
}
/** 在含有 dialogText 的对话框里，点文字完全等于 btnText 之一的按钮（真实鼠标）。 */
async function clickInDialog(page, dialogText, btnText) {
  const box = await page.waitUntil(`对话框「${dialogText.join('/')}」里的「${btnText.join('/')}」`, `(() => {
    const dlg = [...document.querySelectorAll('[role=dialog]')].find(d => ${JSON.stringify(dialogText)}.some(t => d.innerText.includes(t)));
    if (!dlg) return false;
    const b = [...dlg.querySelectorAll('button')].find(b => !b.disabled && ${JSON.stringify(btnText)}.includes(b.innerText.trim()));
    if (!b) return false;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : false;
  })()`);
  await page.mouseClick(box.x, box.y);
}
/** 听写页当前句号：「第 n / m 句」或英文界面「Line n / m」。 */
const lineNo = page => page.evaluate(() => {
  const m = document.body.innerText.match(/第 (\d+) \/ (\d+) 句|Line (\d+) \/ (\d+)/);
  return m ? `${m[1] ?? m[3]}/${m[2] ?? m[4]}` : '';
});
const videoState = page => page.evaluate(() => {
  const v = document.querySelector('video');
  return v ? { paused: v.paused, t: Math.round(v.currentTime * 100) / 100 } : null;
});
/** 点第 n 个（从 0 起）文字匹配的按钮，用真实鼠标。 */
async function clickNth(page, pattern, n) {
  const box = await page.evaluate((src, i) => {
    const re = new RegExp(src);
    const list = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null && re.test(b.innerText.trim()));
    const b = list[i];
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, pattern.source, n);
  assert.ok(box, `找不到第 ${n + 1} 个「${pattern}」按钮`);
  await page.mouseClick(box.x, box.y);
}
const flash = page => page.evaluate(() => {
  const el = document.querySelector('[data-testid=flash]');
  if (!el) return null;
  return {
    progress: el.querySelector('[data-testid=flash-progress]')?.innerText ?? '',
    side: el.querySelector('[data-testid=flash-card]')?.dataset.side ?? '',
    word: el.querySelector('[data-testid=flash-word]')?.innerText ?? el.querySelector('[data-testid=flash-back]')?.innerText.split('\n')[0] ?? '',
    back: el.querySelector('[data-testid=flash-back]')?.innerText ?? '',
    prevDisabled: [...el.querySelectorAll('button')].find(b => b.innerText.includes('上一张'))?.disabled ?? null,
    hasNext: [...el.querySelectorAll('button')].some(b => b.innerText.includes('下一张')),
    hasEnd: [...el.querySelectorAll('button')].some(b => b.innerText.trim() === '结束'),
  };
});
const dueCount = page => page.text('[data-testid=due-count]');

async function importPair(page, reviewFile, first) {
  await page.clickText('导入', { exact: true, selector: 'button[role=tab]' });
  if (first) {
    await page.clickText('选择文件');
    await chooseFile(s, fix('upgrade.md'));
    await page.waitText('重新选择');
    await page.clickText('选择文件');
  } else {
    await clickNth(page, /^(选择文件|重新选择|读取中…)$/, 1); // 只换复习库
  }
  await chooseFile(s, fix(reviewFile));
  await page.waitText('校验通过');
  await page.clickText('确认导入当前预览');
  await page.waitText('导入成功');
  await page.clickText('浏览', { exact: true, selector: 'button[role=tab]' });
  await page.waitFor('[data-testid=due-panel]');
  await sleep(600);
}

let s;
let page;
let ok = false;
try {
  note('今天（本机自然日）', expected.today);
  s = await start({ runDir, port: 9451 });
  page = await connect({ port: s.port });
  await page.waitReady();
  await page.setViewport(1280, 800, { mobile: false, dpr: 1 });
  await page.clickText('词库', { timeout: 60000 });
  await page.waitText('词库还是空的');

  // ---- 第一份：活跃词都没到期 → 0，开始按钮禁用，空态 ----
  await page.clickText('去导入');
  await importPair(page, 'review-none.md', true);
  assert.match(await dueCount(page), / 0 个词到期或逾期$/);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=due-start]').disabled), true);
  assert.match(await page.text('[data-testid=due-empty]'), /今天没有到期的词/);
  note('全部未到期', `${await dueCount(page)}；开始复习禁用，有空态说明`);
  await shot(page, '01-due-empty.png');

  // ---- 第二份：混合情况 → 逐条核对 ----
  await importPair(page, 'review-due.md', false);
  const expectCount = expected.dueWords.length;
  await page.waitUntil('到期数量刷新', `document.querySelector('[data-testid=due-count]').innerText.includes(' ${expectCount} 个词')`);
  const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid=due-list] li')].map(li => li.innerText.split('\n')));
  assert.deepEqual(rows.map(r => r[0]), expected.dueWords, '到期词和顺序');
  rows.forEach((r, i) => assert.ok(r[1].startsWith(`${expected.dueIssues[i]} 期`), `第 ${i + 1} 行期号应为 ${expected.dueIssues[i]}：${r[1]}`));
  assert.match(rows[0][1], /逾期 400 天/);
  assert.match(rows[3][1], /今天到期/);
  note('到期列表', `${await dueCount(page)}；${rows.map(r => r[0]).join('、')}`);
  await shot(page, '02-due-list.png');

  // 复习前数据库快照（所有表逐行）。
  let db = await openDb(s);
  const before = snapshot(db);
  db.close();
  note('复习前表', Object.entries(before).map(([t, r]) => `${t}=${r.length}`).join(' '));

  // 模拟「页面上别的快捷键」：在 document 冒泡阶段计数，闪卡认出的键不该传到这里。
  await page.evaluate(() => {
    window.__downstream = [];
    document.addEventListener('keydown', e => window.__downstream.push(e.key));
  });

  // ---- 开始：正面 → 点击翻面 → 背面完整字段 ----
  await page.click('[data-testid=due-start]');
  await page.waitFor('[data-testid=flash]');
  let f = await flash(page);
  assert.equal(f.progress, `第 1 / ${expectCount} 张`);
  assert.equal(f.side, 'front');
  assert.equal(f.word, 'overdue');
  assert.equal(f.prevDisabled, true, '第一张上一张禁用');
  await shot(page, '03-flash-front.png');
  await page.click('[data-testid=flash-card]');
  f = await flash(page);
  assert.equal(f.side, 'back');
  for (const t of ['状态', 'L4', '到期日', '逾期 400 天', '完整备注', '一年多以前到期']) assert.ok(f.back.includes(t), `背面缺 ${t}`);
  note('点击翻面', '背面显示状态、到期日、完整备注');
  await shot(page, '04-flash-back.png');

  // ---- 真实按键：→ 切卡回正面、空格翻面、← 回上一张 ----
  await press(page, 'ArrowRight');
  f = await flash(page);
  assert.deepEqual([f.progress, f.side, f.word], [`第 2 / ${expectCount} 张`, 'front', 'longnote']);
  await press(page, ' ');
  f = await flash(page);
  assert.equal(f.side, 'back');
  assert.ok(f.back.includes('末尾标记END'), '长备注末尾可见');
  await shot(page, '05-flash-long-note.png');
  await press(page, 'ArrowLeft');
  f = await flash(page);
  assert.deepEqual([f.progress, f.side, f.word], [`第 1 / ${expectCount} 张`, 'front', 'overdue']);
  await press(page, 'ArrowLeft'); // 首张再往前：不动
  assert.equal((await flash(page)).progress, `第 1 / ${expectCount} 张`);
  note('键盘', '→ 切卡并回正面、空格翻面、← 返回、首张 ← 不动');

  // 焦点放在「下一张」按钮上按空格：只翻面，不会同时触发按钮。
  await page.evaluate(() => [...document.querySelectorAll('[data-testid=flash] button')].find(b => b.innerText.includes('下一张')).focus());
  await press(page, ' ');
  f = await flash(page);
  assert.deepEqual([f.progress, f.side], [`第 1 / ${expectCount} 张`, 'back'], '焦点在按钮上空格只翻面');
  note('按钮焦点+空格', '只翻面，没有误触下一张');

  // ---- 按钮走到最后一张：没有「下一张」，有「结束」 ----
  for (let i = 1; i < expectCount; i++) await page.clickText('下一张', { exact: false, selector: '[data-testid=flash] button' });
  f = await flash(page);
  assert.deepEqual([f.progress, f.word, f.hasNext, f.hasEnd, f.side], [`第 ${expectCount} / ${expectCount} 张`, 'shatter', false, true, 'front']);
  await press(page, 'ArrowRight'); // 尾张再往后：不动
  assert.equal((await flash(page)).progress, `第 ${expectCount} / ${expectCount} 张`);
  note('尾张', '只有「结束」，→ 不越界');
  await shot(page, '06-flash-last.png');

  // 下游（模拟听写等快捷键）没收到任何闪卡键。
  let downstream = await page.evaluate(() => window.__downstream);
  assert.deepEqual(downstream, [], `闪卡键串到了页面其他监听：${JSON.stringify(downstream)}`);
  note('快捷键隔离', '闪卡活动时 ← → 空格 均未传到 document 监听');

  // ---- 窄屏 390 ----
  await page.setViewport(390, 844);
  await press(page, ' ');
  assert.equal(await overflow(page), 0, '窄屏闪卡横向溢出');
  await shot(page, '07-narrow-flash-back.png');
  await page.clickText('上一张', { exact: false, selector: '[data-testid=flash] button' });
  await page.clickText('上一张', { exact: false, selector: '[data-testid=flash] button' });
  await page.clickText('上一张', { exact: false, selector: '[data-testid=flash] button' });
  await page.clickText('上一张', { exact: false, selector: '[data-testid=flash] button' });
  assert.equal((await flash(page)).word, 'longnote');
  await press(page, ' ');
  assert.equal(await overflow(page), 0, '窄屏长备注横向溢出');
  const cardFits = await page.evaluate(() => { const c = document.querySelector('[data-testid=flash-card]'); return c.scrollWidth <= c.clientWidth + 1; });
  assert.equal(cardFits, true, '长备注在卡片内换行');
  await shot(page, '08-narrow-long-note.png');
  note('390 窄屏', '闪卡正反面、长备注均无横向溢出');

  // ---- Esc 退出；之后按键无效、键能正常传给页面 ----
  await press(page, 'Escape');
  await page.waitUntil('闪卡关闭', '!document.querySelector("[data-testid=flash]")');
  const focused = await page.waitUntil('退出后焦点回到开始复习', `document.activeElement?.dataset?.testid === 'due-start' && 'due-start'`, { timeout: 3000 }).catch(() => page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120) ?? ''));
  assert.equal(focused, 'due-start', '退出后焦点回到开始复习');
  await page.evaluate(() => { window.__downstream = []; });
  await press(page, 'ArrowRight');
  await press(page, 'Escape');
  assert.equal(await page.evaluate(() => !!document.querySelector('[data-testid=flash]')), false);
  downstream = await page.evaluate(() => window.__downstream);
  assert.deepEqual(downstream, ['ArrowRight', 'Escape'], '退出后键盘不再被闪卡拦截');
  note('Esc 退出', '焦点回到开始复习；退出后按键原样传给页面，闪卡不再响应');
  assert.equal(await overflow(page), 0, '窄屏到期列表横向溢出');
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, '09-narrow-due-list.png');
  await page.setViewport(1280, 800, { mobile: false, dpr: 1 });

  // ---- 再次进入：从第 1 张正面开始，按一次 → 只前进一张（只有一份监听） ----
  await page.click('[data-testid=due-start]');
  await page.waitFor('[data-testid=flash]');
  f = await flash(page);
  assert.deepEqual([f.progress, f.side], [`第 1 / ${expectCount} 张`, 'front']);
  await press(page, 'ArrowRight');
  assert.equal((await flash(page)).progress, `第 2 / ${expectCount} 张`, '一次按键只前进一张');
  note('再次进入', '从第 1 张正面开始；一次 → 只前进一张');
  // 用「结束」走完：到最后一张点结束。
  for (let i = 2; i < expectCount; i++) await press(page, 'ArrowRight');
  await page.clickText('结束', { selector: '[data-testid=flash] button' });
  await page.waitUntil('闪卡关闭', '!document.querySelector("[data-testid=flash]")');
  note('结束按钮', '最后一张点「结束」关闭闪卡');

  // ---- 打开闪卡、翻面切卡后 Esc 退出，切到视频页加载真实媒体进听写，实际按听写快捷键 ----
  await page.click('[data-testid=due-start]');
  await page.waitFor('[data-testid=flash]');
  await press(page, ' ');
  await press(page, 'ArrowRight');
  await press(page, 'Escape');
  await page.waitUntil('闪卡关闭', '!document.querySelector("[data-testid=flash]")');
  await page.clickText(['视频', 'Videos']);
  await page.waitUntil('离开词库', '!document.querySelector("[data-testid=due-panel]")');
  await page.clickText(['添加视频', 'Add video']);
  await page.clickText(['选择本机视频', 'Choose a video on this Mac']);
  await chooseFile(s, VIDEO);
  await page.waitText('tone.mp4');
  await page.clickText(['选字幕文件', 'Choose subtitles']);
  await chooseFile(s, fix('tone-lines.srt'));
  await page.waitText('tone-lines.srt');
  await page.clickText(['开始练习', 'Start practising']);
  const PANEL = ['这次怎么练', 'How to practise this time'];
  await page.waitText(PANEL);
  await clickInDialog(page, PANEL, ['按段从头练', 'Section by section']);
  await clickInDialog(page, PANEL, ['开始练习', 'Start']);
  await page.waitUntil('进入听写页', `/第 1 \\/ 3 句|Line 1 \\/ 3/.test(document.body.innerText) && !!document.querySelector('video')`, { timeout: 30000 });
  assert.equal(await page.evaluate(() => !!document.querySelector('[data-testid=flash]')), false, '听写页不该有闪卡');
  // 听写开头会自动放第 1 句（0.9 秒）；等它放完停下，再开始按键。
  await page.waitUntil('第 1 句放完停下', `(() => { const v = document.querySelector('video'); return v && v.paused && v.readyState >= 2; })()`, { timeout: 20000 });
  await shot(page, '10-dictation-practice.png');
  const keyLog = [];
  // 空格 = 播放：视频从暂停变为播放。
  let v0 = await videoState(page);
  await press(page, ' ');
  await page.waitUntil('空格后开始播放', `(() => { const v = document.querySelector('video'); return v && (!v.paused || v.currentTime > ${v0.t} + 0.05); })()`, { timeout: 5000 });
  keyLog.push(`空格：暂停@${v0.t}s → 播放`);
  await page.waitUntil('这句放完停下', `document.querySelector('video').paused`, { timeout: 10000 });
  // Ctrl+↓ = 下一句、Ctrl+↑ = 上一句：句号跟着变。
  await press(page, 'ArrowDown', { ctrl: true });
  await page.waitUntil('Ctrl+↓ 到第 2 句', `/第 2 \\/ 3 句|Line 2 \\/ 3/.test(document.body.innerText)`, { timeout: 5000 });
  keyLog.push(`Ctrl+↓：句号 → ${await lineNo(page)}`);
  await shot(page, '11-dictation-next-line.png');
  await page.waitUntil('第 2 句停下', `document.querySelector('video').paused`, { timeout: 10000 });
  await press(page, 'ArrowUp', { ctrl: true });
  await page.waitUntil('Ctrl+↑ 回到第 1 句', `/第 1 \\/ 3 句|Line 1 \\/ 3/.test(document.body.innerText)`, { timeout: 5000 });
  keyLog.push(`Ctrl+↑：句号 → ${await lineNo(page)}`);
  await page.waitUntil('第 1 句停下', `document.querySelector('video').paused`, { timeout: 10000 });
  // Shift+空格 = 重播这句：从第 1 句开头（0–0.9 秒内）重新播放。
  v0 = await videoState(page);
  await press(page, ' ', { shift: true });
  const replay = await page.waitUntil('Shift+空格重播', `(() => { const v = document.querySelector('video'); return v && !v.paused && v.currentTime < 0.95 && { t: v.currentTime }; })()`, { timeout: 5000, interval: 50 });
  keyLog.push(`Shift+空格：暂停@${v0.t}s → 从 ${Math.round(replay.t * 100) / 100}s 重播第 1 句`);
  assert.equal(await lineNo(page), '1/3', '重播不换句');
  note('听写快捷键（真实媒体 tone.mp4）', keyLog.join('；'));
  // 回到视频列表 → 词库。
  await page.waitUntil('重播放完', `document.querySelector('video').paused`, { timeout: 10000 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: 30 });
  await page.click('button[aria-label="回到你的视频列表"], button[aria-label="Back to your videos"]');
  await page.clickText('词库');
  await page.waitFor('[data-testid=due-panel]');
  await page.waitUntil('回到词库后到期数', `document.querySelector('[data-testid=due-count]').innerText.includes(' ${expectCount} 个词')`);
  note('切回词库', `到期数仍为 ${expectCount}`);

  // ---- 复习前后数据库逐行一致 ----
  db = await openDb(s);
  const after = snapshot(db);
  db.close();
  assert.deepEqual(after, before, '复习前后数据库有变化');
  note('数据库只读', `复习前后 ${Object.keys(after).join('、')} 逐行一致（含 status、level、due、updated_at、import_run）`);

  // ---- 单卡：只有 1 个到期词 ----
  // 导入只新增不覆盖，6 个到期词删不掉，所以另开一个全新的隔离窗口（新数据目录）只导入单卡词表。
  const unexpectedErrors = errs => errs.filter(e => !/plugin http not found/.test(String(e)));
  assert.deepEqual(unexpectedErrors(page.errors), [], '主流程页面有预期之外的报错');
  note('主流程页面错误', JSON.stringify(page.errors));
  // WebView2 子进程偶尔要 20 秒以上才退干净（launch.mjs 的等待上限），这里多等两轮再开新窗口。
  for (let i = 0; ; i++) {
    try { await stop(s.runDir); break; } catch (e) {
      if (i >= 2) throw e;
      note('停止主流程窗口', `第 ${i + 1} 次未退干净，10 秒后重试：${e.message}`);
      await sleep(10000);
    }
  }
  s = await start({ runDir: `${runDir}-single`, port: 9451 });
  page = await connect({ port: s.port });
  await page.waitReady();
  await page.setViewport(1280, 800, { mobile: false, dpr: 1 });
  await page.clickText('词库', { timeout: 60000 });
  await page.waitText('词库还是空的');
  await page.clickText('去导入');
  await importPair(page, 'review-one.md', true);
  await page.waitUntil('到期数量刷新为 1', `document.querySelector('[data-testid=due-count]').innerText.includes(' 1 个词')`);
  const oneRows = await page.evaluate(() => [...document.querySelectorAll('[data-testid=due-list] li')].map(li => li.innerText.split('\n')[0]));
  assert.deepEqual(oneRows, expected.oneWords, '单卡到期列表');
  db = await openDb(s);
  const beforeOne = snapshot(db);
  db.close();
  await page.click('[data-testid=due-start]');
  await page.waitFor('[data-testid=flash]');
  f = await flash(page);
  assert.deepEqual([f.progress, f.side, f.word, f.prevDisabled, f.hasNext, f.hasEnd], ['第 1 / 1 张', 'front', 'solo', true, false, true], '单卡正面');
  const bar = await page.evaluate(() => document.querySelector('[data-testid=flash]').innerText);
  assert.ok(!/NaN|undefined/.test(bar), `单卡出现 NaN/undefined：${bar}`);
  await shot(page, '12-single-front.png');
  await press(page, 'ArrowRight');
  await press(page, 'ArrowLeft');
  assert.deepEqual([(await flash(page)).progress, (await flash(page)).side], ['第 1 / 1 张', 'front'], '单卡 ← → 不越界');
  await press(page, ' ');
  f = await flash(page);
  assert.equal(f.side, 'back');
  for (const t of ['L2', '单卡：唯一到期的词']) assert.ok(f.back.includes(t), `单卡背面缺 ${t}`);
  await shot(page, '13-single-back.png');
  await page.setViewport(390, 844);
  assert.equal(await overflow(page), 0, '窄屏单卡横向溢出');
  await shot(page, '14-narrow-single-back.png');
  await page.setViewport(1280, 800, { mobile: false, dpr: 1 });
  await page.clickText('结束', { selector: '[data-testid=flash] button' });
  await page.waitUntil('单卡闪卡关闭', '!document.querySelector("[data-testid=flash]")');
  db = await openDb(s);
  const afterOne = snapshot(db);
  db.close();
  assert.deepEqual(afterOne, beforeOne, '单卡复习前后数据库有变化');
  note('单卡', '「第 1 / 1 张」；上一张禁用、没有下一张、只有「结束」；← → 不动；空格翻面；390 宽无溢出；点「结束」关闭；前后数据库逐行一致');
  note('页面错误', JSON.stringify(page.errors));
  // 隔离测试里故意不注册 http 插件（见 docs/e2e.md），这条报错是预期的；其他报错都算失败。
  const unexpected = page.errors.filter(e => !/plugin http not found/.test(String(e)));
  assert.deepEqual(unexpected, [], '页面有预期之外的报错');
  ok = true;
} catch (e) {
  note('失败', e.stack || e);
  fs.mkdirSync(out, { recursive: true });
  if (page) await page.screenshot(path.join(out, '99-failure.png')).catch(() => {});
  if (page) note('失败时页面文字', (await page.text('body').catch(() => '')).slice(0, 400).split('\n').join(' | '));
} finally {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'e2e-014-log.txt'), log.join('\n'), 'utf8');
  if (s?.runDir) await stop(s.runDir).catch(e => note('停止失败', e.stack || e));
  note('证据目录', out);
}
process.exit(ok ? 0 : 1);
