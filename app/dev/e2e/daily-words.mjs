// 081 每日新词真实窗口验证（隔离数据目录，空词库起步）：
// 选四级 → 词库页出现今日新词卡 → 滑卡正反面 → 收下 3 个、认识 2 个 → 词库多 3 个待首考 → 点提示进首考 → 撤销；
// 键盘 ← → ↑ 空格；电脑 1280、手机 390（100% 和 130%）截图并检查不横向溢出。
// 用法（在 app 目录）：node dev/e2e/daily-words.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { connect } from './cdp.mjs';
import { openDb, queryRows } from './db.mjs';
import { start, stop } from './launch.mjs';

let session;
let page;
let failure;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const invoke = async (command, args = {}) => {
  const result = await page.evaluate(async (cmd, payload) => {
    try { return { value: await window.__TAURI_INTERNALS__.invoke(cmd, payload) }; }
    catch (error) { return { error: typeof error === 'string' ? error : String(error) }; }
  }, command, args);
  if (result.error) throw new Error(`${command} 失败：${result.error}`);
  return result.value;
};
const shot = name => page.screenshot(path.join(session.out, name), { full: false }).then(() => console.log(`截图 ${path.join(session.out, name)}`));
const key = (k, code, vk) => page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, ...(k === ' ' ? { text: ' ' } : {}) })
  .then(() => page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }));
const KEYS = { left: () => key('ArrowLeft', 'ArrowLeft', 37), right: () => key('ArrowRight', 'ArrowRight', 39), up: () => key('ArrowUp', 'ArrowUp', 38), space: () => key(' ', 'Space', 32) };
const word = () => page.evaluate(() => document.querySelector('[data-testid=daily-flashcard]')?.getAttribute('data-word') ?? null);
const remaining = async () => Number((await page.text('[data-testid=daily-remaining]')).match(/\d+/)[0]);
const settle = async (before) => { await page.waitUntil('换到下一个词', `(() => { const e = document.querySelector('[data-testid=daily-flashcard]'); return !e || e.getAttribute('data-word') !== ${JSON.stringify(before)}; })()`, { timeout: 8000 }); await sleep(450); };
const overflow = () => page.evaluate(() => {
  const main = document.querySelector('main');
  return { html: document.documentElement.scrollWidth, view: innerWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
});
async function drag(dx, dy) {
  const box = await page.evaluate(() => { const r = document.querySelector('[data-testid=daily-flashcard]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 20 }; }); // 从卡片上沿抓起，避开中间的发音按钮
  const mouse = (type, x, y) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  await mouse('mousePressed', box.x, box.y);
  for (let i = 1; i <= 6; i++) await mouse('mouseMoved', box.x + dx * i / 6, box.y + dy * i / 6);
  await mouse('mouseReleased', box.x + dx, box.y + dy);
}
const dbRows = async table => { const db = await openDb(session); try { return queryRows(db, table); } finally { db.close(); } };
const openVocab = async mobile => { if (mobile) await page.click('nav button:first-child'); else await page.clickText('词库'); await page.waitFor('[data-testid=daily-card]'); };

try {
  session = await start({ port: 9381, runId: `081-daily-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}` });
  page = await connect({ port: session.port });
  await page.waitReady('nav button');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.evaluate(() => { localStorage.removeItem('worddrip_daily_plan'); localStorage.removeItem('worddrip_daily_state'); });
  await page.reload();
  await page.waitReady('nav button');

  // 1. 没选词表：提示 → 去设置选四级
  await openVocab(false);
  assert.match(await page.text('[data-testid=daily-card]'), /选个目标，每天送你几个新词/);
  await shot('01-no-plan-1280.png');
  await page.click('[data-testid=daily-choose]');
  await page.waitFor('[data-testid=daily-settings]');
  await page.click('[data-testid=daily-pack-cet4]');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('worddrip_daily_plan')).packs.join()), 'cet4');
  // 学习计划写进了数据库（会同步），本机 localStorage 只是缓存
  await sleep(500);
  const planRows = await dbRows('daily_plan');
  assert.equal(planRows.length, 1);
  assert.deepEqual([planRows[0].id, JSON.parse(planRows[0].packs), planRows[0].per_day, planRows[0].card_on], ['default', ['cet4'], 10, 1]);
  console.log('PASS 学习计划写进了 daily_plan（数据库）');
  await shot('02-settings-1280.png');
  await openVocab(false);
  await page.waitFor('[data-testid=daily-remaining]');
  assert.equal(await remaining(), 10, '默认每天 10 个');

  // 2. 当天固定：重新加载后名单不变
  const listOf = () => page.evaluate(() => JSON.parse(localStorage.getItem('worddrip_daily_state')).entries.map(e => e.word));
  const day = await listOf();
  assert.equal(day.length, 10);
  // 清掉本机缓存的计划再重启：计划应从数据库读回来（本机只是缓存）
  await page.evaluate(() => { localStorage.removeItem('worddrip_daily_plan'); });
  await page.reload();
  await page.waitReady('nav button');
  await openVocab(false);
  await page.waitFor('[data-testid=daily-remaining]');
  assert.deepEqual(await listOf(), day, '重启后今天的词不变');
  assert.equal(new Set(day).size, 10);

  // 3. 滑卡正反面
  await page.click('[data-testid=daily-open]');
  await page.waitFor('[data-testid=daily-flashcard]');
  assert.equal(await word(), day[0], '按词频顺序，第一个是最常见的');
  assert.ok((await page.text('[data-testid=daily-phonetic]').catch(() => '')) !== undefined);
  assert.equal(await page.text('[data-testid=daily-pack]'), '四级');
  await shot('03-front-1280.png');
  // 翻面有 062 的淡入淡出：旧面副本出现过、动画结束后副本被清掉，新面淡入时 opacity 动画跑过
  await page.evaluate(() => {
    window.__flipSeen = { ghost: false, anim: false };
    const card = document.querySelector('[data-testid=daily-flashcard]');
    new MutationObserver(() => { if (card.querySelector('[data-ghost]')) window.__flipSeen.ghost = true; }).observe(card, { childList: true, subtree: true });
    const poll = setInterval(() => { if (card.querySelector('[data-ghost]')?.getAnimations().length) window.__flipSeen.anim = true; }, 10);
    setTimeout(() => clearInterval(poll), 1500);
  });
  await page.click('[data-testid=daily-flashcard]');
  await page.waitFor('[data-testid=daily-back]');
  await sleep(600);
  const flipSeen = await page.evaluate(() => ({ ...window.__flipSeen, left: document.querySelectorAll('[data-ghost]').length }));
  assert.deepEqual(flipSeen, { ghost: true, anim: true, left: 0 }, `翻面淡入淡出：${JSON.stringify(flipSeen)}`);
  console.log('PASS 翻面有淡入淡出（旧面副本淡出后清掉）');
  assert.ok((await page.text('[data-testid=daily-zh]')).length > 0, '背面有中文释义');
  assert.ok((await page.evaluate(() => document.querySelectorAll('[data-testid=daily-en]').length)) <= 2, '英文释义最多 2 条');
  await shot('04-back-1280.png');
  await KEYS.space(); // 空格翻回正面
  await page.waitFor('[data-testid=daily-word]');

  // 4. 键盘 → 收下两个
  let w = await word(); await KEYS.right(); await settle(w);
  w = await word(); await KEYS.right(); await settle(w);
  assert.equal(await remaining(), 8);
  // 滑动：右滑收下第 3 个、左滑认识第 4 个
  w = await word(); await drag(160, 0); await settle(w);
  w = await word(); await drag(-160, 0); await settle(w);
  // ← 认识第 5 个
  w = await word(); await KEYS.left(); await settle(w);
  assert.equal(await remaining(), 5);
  let picks = await invoke('wordpack_pick_list');
  assert.equal(picks.filter(p => p.state === 'taken').length, 3);
  assert.equal(picks.filter(p => p.state === 'known').length, 2);
  // ↑ 以后再说第 6 个，然后撤销
  const sixth = await word(); await KEYS.up(); await settle(sixth);
  assert.equal(await remaining(), 4);
  assert.equal((await invoke('wordpack_pick_list')).filter(p => p.state === 'later').length, 1);
  await page.click('[data-testid=daily-undo]');
  await page.waitUntil('撤销后第 6 个回来', `document.querySelector('[data-testid=daily-flashcard]')?.getAttribute('data-word') === ${JSON.stringify(sixth)}`, { timeout: 8000 });
  assert.equal(await remaining(), 5);
  assert.equal((await invoke('wordpack_pick_list')).filter(p => p.state === 'later').length, 0, '撤销后候选池里没有这个词');
  console.log('PASS 键盘 ← → ↑ 空格、左右滑、撤销');

  // 5. 词库里多了 3 个待首考的词，来源、释义、英英释义都在
  const words = await dbRows('review_word');
  assert.equal(words.length, 3);
  assert.ok(words.every(r => r.status === '🌱待考察' && r.source === '词表·四级'), JSON.stringify(words.map(r => [r.status, r.source])));
  const defs = await dbRows('review_definition');
  assert.equal(defs.length, 3);
  assert.ok(defs.every(r => r.chinese && r.chinese.length > 0), '中文释义已写入');
  assert.ok(defs.some(r => /\/.+\//.test(r.pos)), '音标写在词性后面');
  const en = await dbRows('vocab_definition_en');
  assert.ok(en.length >= 3 && en.every(r => r.source === 'dict:ecdict'), '英英释义来源 dict:ecdict');
  console.log(`PASS 词库多了 ${words.length} 个待首考的词：${words.map(r => r.word).join('、')}`);

  // 6. 处理完剩下的 5 个 → 提示收了 3 个 → 去做首考
  for (let i = 0; i < 5; i++) { w = await word(); await KEYS.left(); await settle(w); }
  await page.waitFor('[data-testid=daily-done]');
  assert.match(await page.text('[data-testid=daily-taken-count]'), /今天收了 3 个/);
  await shot('05-done-1280.png');
  await page.click('[data-testid=daily-go-first-test]');
  await page.waitFor('[data-testid=first-test-preview]', { timeout: 30000 });
  await shot('06-first-test-1280.png');
  await page.click('[data-testid=first-preview-exit]');
  console.log('PASS 点「去做首考」直接进了首考');

  // 再来 5 个
  await page.click('[data-testid=daily-open]');
  await page.waitFor('[data-testid=daily-more]');
  await page.click('[data-testid=daily-more]');
  await page.waitFor('[data-testid=daily-flashcard]');
  assert.equal(await remaining(), 5);

  // 7. 手机 390：100% 与 130%
  await page.send('Network.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36' });
  await page.setViewport(390, 844, { mobile: true, dpr: 2 });
  await page.reload();
  await page.waitReady('nav button');
  await openVocab(true);
  for (const scale of [100, 130]) {
    await page.evaluate(pct => { document.documentElement.style.fontSize = `${pct}%`; }, scale);
    await sleep(300);
    if (!(await page.evaluate(() => !!document.querySelector('[data-testid=daily-flashcard]')))) await page.click('[data-testid=daily-open]');
    await page.waitFor('[data-testid=daily-flashcard]');
    if ((await page.evaluate(() => document.querySelector('[data-testid=daily-flashcard]').getAttribute('data-flipped'))) === '1') await page.click('[data-testid=daily-flashcard]');
    await shot(`07-mobile-front-${scale}.png`);
    let o = await overflow();
    assert.ok(o.html <= o.view && o.main <= 0, `手机 ${scale}% 正面横向溢出：${JSON.stringify(o)}`);
    await page.click('[data-testid=daily-flashcard]');
    await page.evaluate(() => document.querySelector('[data-testid=daily-card]').scrollIntoView({ block: 'end' }));
    await sleep(35);
    await shot(`07-mobile-flip-${scale}-035ms.png`);
    await sleep(60);
    await shot(`07-mobile-flip-${scale}-095ms.png`);
    await page.waitFor('[data-testid=daily-back]');
    await sleep(500);
    o = await overflow();
    assert.ok(o.html <= o.view && o.main <= 0, `手机 ${scale}% 背面横向溢出：${JSON.stringify(o)}`);
    // 把卡片底部滚到屏幕底：最下面一行（撤销 / 提示）要完全在浮动「+」上方，不被压住
    await page.evaluate(() => document.querySelector('[data-testid=daily-card]').scrollIntoView({ block: 'end' }));
    await sleep(300);
    const gap = await page.evaluate(() => {
      const fab = document.querySelector('[data-testid=vocab-fab-toggle]').getBoundingClientRect();
      const undo = document.querySelector('[data-testid=daily-undo]').getBoundingClientRect();
      const later = document.querySelector('[data-testid=daily-later]').getBoundingClientRect();
      return { fabTop: fab.top, undoBottom: undo.bottom, laterBottom: later.bottom };
    });
    assert.ok(gap.undoBottom <= gap.fabTop && gap.laterBottom <= gap.fabTop, `手机 ${scale}% 浮动「+」压住了卡片：${JSON.stringify(gap)}`);
    await shot(`08-mobile-back-${scale}.png`);
  }
  // 手机上点按钮收下 + 撤销
  const before = (await dbRows('review_word')).length;
  await page.click('[data-testid=daily-take]');
  await page.waitUntil('库里多一个', `window.__TAURI_INTERNALS__.invoke('vocab_browse').then(data => data.reviewWords.length === ${before + 1})`, { timeout: 2000 });
  await sleep(600);
  assert.equal((await dbRows('review_word')).length, before + 1);
  await page.click('[data-testid=daily-undo]');
  await sleep(600);
  assert.equal((await dbRows('review_word')).length, before, '撤销把刚收下的词从库里去掉');
  const unexpected = page.errors.filter(e => !e.includes('plugin http not found'));
  if (unexpected.length) throw new Error(`页面异常：${unexpected.slice(0, 3).join(' | ')}`);
  console.log('PASS 手机 390（100% / 130%）正反面不溢出；按钮收下与撤销');
} catch (error) {
  failure = error;
  console.error(`FAIL ${error.stack || error.message}`);
  try { if (page) await shot('fail.png'); } catch { /* ignore */ }
} finally {
  page?.close();
  if (session) await stop(session.runDir);
}
process.exit(failure ? 1 : 0);
