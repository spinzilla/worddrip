// 079 首次引导与词汇量测试真实窗口验证（隔离数据目录）：
//   A 电脑 1280：空库自动出现 → 选四级 → 测试（中间一题截图）→ 结果页 → 选 10 个 → 词库页今日新词卡；
//     今日新词里没有测试中点过「认识」的词；重启不再弹；设置里「重新测词汇量」只覆盖 test-estimate，用户手动的决定不动。
//   B 手机 390（100% / 130%）：引导各步截图并检查不横向溢出。
//   C 跳过后重启不再弹；库里已有词时不自动弹；今日新词卡上有「测一下词汇量」小入口。
// 用法（在 app 目录）：node dev/e2e/onboarding.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { connect } from './cdp.mjs';
import { openDb, queryRows } from './db.mjs';
import { restart, start, stop } from './launch.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36';
const UNEXPECTED = e => !e.includes('plugin http not found');

let session;
let page;

const invoke = async (command, args = {}) => {
  const result = await page.evaluate(async (cmd, payload) => {
    try { return { value: await window.__TAURI_INTERNALS__.invoke(cmd, payload) }; }
    catch (error) { return { error: typeof error === 'string' ? error : String(error) }; }
  }, command, args);
  if (result.error) throw new Error(`${command} 失败：${result.error}`);
  return result.value;
};
const shot = name => page.screenshot(path.join(session.out, name), { full: false }).then(() => console.log(`截图 ${path.join(session.out, name)}`));
const dbRows = async table => { const db = await openDb(session); try { return queryRows(db, table); } finally { db.close(); } };
const overflow = () => page.evaluate(() => {
  const box = document.querySelector('[data-testid=onboarding]');
  return { html: document.documentElement.scrollWidth, view: innerWidth, box: box ? box.scrollWidth - box.clientWidth : 0 };
});
const noOverflow = async what => { const o = await overflow(); assert.ok(o.html <= o.view && o.box <= 0, `${what} 横向溢出：${JSON.stringify(o)}`); };
const shown = () => page.evaluate(() => !!document.querySelector('[data-testid=onboarding]'));
const wordOnScreen = () => page.evaluate(() => { const e = document.querySelector('[data-testid=level-word]'); return e ? { word: e.textContent, fake: e.getAttribute('data-fake') === '1' } : null; });
const progress = async () => Number((await page.text('[data-testid=level-progress-text]')).match(/第 (\d+)/)[1]);
const rankOf = async word => (await invoke('wordpack_lookup', { word }))?.frq ?? null;

/** 答 count 题：真词排名 ≤ limit 点认识，其余和假词点不认识；allYes 时全点认识。返回答过的 { word, known }。 */
async function answer(count, { limit = 3000, allYes = false, useKeys = false } = {}) {
  const done = [];
  for (let i = 0; i < count; i += 1) {
    const before = await progress();
    const cur = await wordOnScreen();
    assert.ok(cur, '屏幕上应有一个测试词');
    const rank = cur.fake ? null : await rankOf(cur.word);
    const known = allYes ? true : !cur.fake && rank !== null && rank <= limit;
    if (useKeys) await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: known ? 'ArrowRight' : 'ArrowLeft', code: known ? 'ArrowRight' : 'ArrowLeft', windowsVirtualKeyCode: known ? 39 : 37 })
      .then(() => page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: known ? 'ArrowRight' : 'ArrowLeft', code: known ? 'ArrowRight' : 'ArrowLeft', windowsVirtualKeyCode: known ? 39 : 37 }));
    else await page.click(known ? '[data-testid=level-yes]' : '[data-testid=level-no]');
    done.push({ word: cur.word, known, fake: cur.fake });
    if (before + 1 > 50) break;
    // 等到换题或结果页
    await page.waitUntil('换到下一题', `(() => { if (document.querySelector('[data-testid=level-result]')) return true; const e = document.querySelector('[data-testid=level-word]'); return !!e && e.textContent !== ${JSON.stringify(cur.word)}; })()`, { timeout: 10000, interval: 60 });
  }
  return done;
}

async function boot({ mobile = false, runId, keepFlag = false } = {}) {
  session = await start({ port: 9391, runId: `079-${runId}-${stamp}` });
  page = await connect({ port: session.port, skipOnboarding: false });
  await page.waitReady('nav button');
  if (mobile) {
    await page.send('Network.setUserAgentOverride', { userAgent: MOBILE_UA });
    await page.setViewport(390, 844, { mobile: true, dpr: 2 });
  } else await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  if (mobile || !keepFlag) { await page.reload(); await page.waitReady('nav button'); }
}
async function finish() {
  const unexpected = (page?.errors ?? []).filter(UNEXPECTED);
  page?.close();
  if (session) await stop(session.runDir);
  session = undefined;
  if (unexpected.length) throw new Error(`页面异常：${unexpected.slice(0, 3).join(' | ')}`);
}
const openSettingsCards = async () => { await page.clickText('设置'); await page.clickText('卡片与复习'); await page.waitFor('[data-testid=daily-settings]'); };

let failure;
try {
  // ================= 关窗续引导：已选目标、未完成时模拟进程退出 =================
  await boot({ runId: 'resume' });
  await page.waitFor('[data-testid=onboarding]', { timeout: 20000 });
  await page.click('[data-testid=goal-cet]');
  await page.click('[data-testid=goal-next]');
  await page.waitFor('[data-testid=onboarding-test-intro]');
  assert.equal((await dbRows('review_word')).length, 0, '关窗前词库仍为空');
  page.close();
  session = await restart(session.runDir, { port: 9391 });
  page = await connect({ port: session.port, skipOnboarding: false });
  await page.waitReady('nav button');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.waitFor('[data-testid=onboarding]', { timeout: 20000 });
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=goal-cet]')?.getAttribute('aria-pressed')), 'true', '重启后引导继续，已选目标仍勾选');
  await shot('00-resume-goal-1280.png');
  console.log('PASS 已选目标后模拟关窗，重启继续弹引导且目标保留');
  await finish();

  // ================= A：电脑 1280 =================
  await boot({ runId: 'desktop' });
  await page.waitFor('[data-testid=onboarding]', { timeout: 20000 });
  assert.match(await page.text('[data-testid=onboarding-step]'), /第 1 \/ 3 步/);
  assert.equal((await dbRows('review_word')).length, 0, '起步是空词库');
  await shot('01-goal-1280.png');
  await page.click('[data-testid=goal-cet]');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=goal-cet]').getAttribute('aria-pressed')), 'true');
  await page.click('[data-testid=goal-next]');
  await page.waitFor('[data-testid=onboarding-test-intro]');
  await shot('02-test-intro-1280.png');
  await page.click('[data-testid=test-start]');
  await page.waitFor('[data-testid=level-word]');
  const first = await answer(5, { useKeys: true }); // 键盘 ← →
  assert.equal(first.length, 5);
  const middle = await answer(20);
  assert.equal(await progress(), 26, '答完 25 题，现在是第 26 题');
  await shot('03-test-middle-1280.png');
  const rest = await answer(25);
  const answered = [...first, ...middle, ...rest];
  await page.waitFor('[data-testid=level-result]', { timeout: 15000 });
  await page.waitUntil('结果已记录', `!!document.querySelector('[data-testid=level-saved] svg:not(.animate-spin)')`, { timeout: 60000 });
  const estimateText = await page.text('[data-testid=level-estimate]');
  const estimate = Number(estimateText.replace(/[^\d]/g, ''));
  console.log(`  估计：${estimateText}`);
  assert.ok(estimate >= 2000 && estimate <= 4500, `真实词汇量 3000 的估计应在 2000–4500：${estimate}`);
  assert.ok((await page.text('[data-testid=level-describe]')).length > 5);
  assert.equal(await page.evaluate(() => !!document.querySelector('[data-testid=level-warning]')), false, '没点假词，不应出现假词提示');
  await shot('04-result-1280.png');

  // 候选池：认识的真词来源 test；批量记的来源 test-estimate，名次都 < 估计 × 0.6；点了不认识的词不在里面
  let picks = await dbRows('wordpack_pick');
  const direct = picks.filter(r => r.pack === 'test' && r.state === 'known');
  const bulk = picks.filter(r => r.pack === 'test-estimate' && r.state === 'known');
  const knownAnswered = answered.filter(a => !a.fake && a.known).map(a => a.word.toLowerCase());
  assert.deepEqual(direct.map(r => r.word_key).sort(), [...new Set(knownAnswered)].sort(), '测试里点了认识的真词都记成 test');
  assert.ok(bulk.length > 300, `按估计值批量记了 ${bulk.length} 个`);
  const unknownAnswered = new Set(answered.filter(a => !a.fake && !a.known).map(a => a.word.toLowerCase()));
  assert.ok(![...picks].some(r => unknownAnswered.has(r.word_key)), '点了不认识的词不会被记成认识');
  assert.ok(!picks.some(r => answered.filter(a => a.fake).some(a => a.word.toLowerCase() === r.word_key)), '假词不会进候选池');
  for (const row of bulk.slice(0, 40)) {
    const entry = await invoke('wordpack_lookup', { word: row.word });
    assert.ok(entry.frq !== null && entry.frq < estimate * 0.6, `${row.word} 名次 ${entry.frq} 不够常见`);
  }
  console.log(`PASS 候选池：test ${direct.length} 个、test-estimate ${bulk.length} 个`);

  await page.click('[data-testid=test-next]');
  await page.waitFor('[data-testid=onboarding-perday]');
  assert.match(await page.text('[data-testid=onboarding-step]'), /第 3 \/ 3 步/);
  await shot('05-perday-1280.png');
  await page.click('[data-testid=perday-10]');
  await page.click('[data-testid=perday-finish]');
  await page.waitFor('[data-testid=daily-card]', { timeout: 20000 });
  await page.waitFor('[data-testid=daily-remaining]', { timeout: 30000 });
  assert.equal(await shown(), false, '完成后引导关闭');
  const plan = (await dbRows('daily_plan'))[0];
  assert.deepEqual([JSON.parse(plan.packs), plan.per_day, plan.card_on], [['cet4', 'cet6'], 10, 1]);
  const remaining = Number((await page.text('[data-testid=daily-remaining]')).match(/\d+/)[0]);
  assert.equal(remaining, 10, '今日新词卡已备好 10 个');
  const day = await page.evaluate(() => JSON.parse(localStorage.getItem('worddrip_daily_state')).entries.map(e => e.word.toLowerCase()));
  picks = await dbRows('wordpack_pick');
  const knownKeys = new Set(picks.filter(r => r.state === 'known').map(r => r.word_key));
  assert.equal(day.length, 10);
  assert.ok(day.every(w => !knownKeys.has(w)), `今日新词里不该有已记认识的词：${day.filter(w => knownKeys.has(w))}`);
  assert.ok(day.every(w => !knownAnswered.includes(w)));
  await shot('06-vocab-daily-1280.png');
  console.log('PASS 完成引导后词库页出现今日新词卡，里面没有测试里认识的词');

  // 用户手动决定一个词：认识 → 之后重测不能动它
  await page.click('[data-testid=daily-open]');
  await page.waitFor('[data-testid=daily-flashcard]');
  const manualWord = await page.evaluate(() => document.querySelector('[data-testid=daily-flashcard]').getAttribute('data-word'));
  await page.click('[data-testid=daily-known]');
  await sleep(800);
  picks = await dbRows('wordpack_pick');
  assert.equal(picks.find(r => r.word_key === manualWord.toLowerCase())?.pack, '四级');

  // 重启：不再自动弹
  await finishKeep();
  async function finishKeep() { page.close(); session = await restart(session.runDir, { port: 9391 }); page = await connect({ port: session.port, skipOnboarding: false }); await page.waitReady('nav button'); await page.setViewport(1280, 900, { mobile: false, dpr: 1 }); }
  await sleep(2500);
  assert.equal(await shown(), false, '做完引导后重启不再弹');
  console.log('PASS 重启后不再自动弹');

  // 设置里：看到结果、重测
  await openSettingsCards();
  assert.match(await page.text('[data-testid=level-last]'), /上次测试（\d{4}-\d{2}-\d{2}）：约 [\d,]+ 词/);
  await shot('07-settings-1280.png');
  const bulkBefore = bulk.length;
  await page.click('[data-testid=settings-retest]');
  await page.waitFor('[data-testid=onboarding-test-intro]');
  assert.equal(await shown(), true);
  await page.click('[data-testid=test-start]');
  await page.waitFor('[data-testid=level-word]');
  const retest = await answer(50, { limit: 1000 });
  await page.waitFor('[data-testid=level-result]', { timeout: 15000 });
  await page.waitUntil('结果已记录', `!!document.querySelector('[data-testid=level-saved] svg:not(.animate-spin)')`, { timeout: 60000 });
  const estimate2 = Number((await page.text('[data-testid=level-estimate]')).replace(/[^\d]/g, ''));
  assert.ok(estimate2 < estimate, `重测（真实 1000）估计应变小：${estimate2} < ${estimate}`);
  picks = await dbRows('wordpack_pick');
  const bulk2 = picks.filter(r => r.pack === 'test-estimate');
  assert.ok(bulk2.length < bulkBefore, `重测后自动记录变少：${bulkBefore} → ${bulk2.length}`);
  assert.equal(picks.find(r => r.word_key === manualWord.toLowerCase())?.pack, '四级', '用户手动点的「认识」没被动');
  assert.ok(picks.filter(r => r.pack === 'test').length >= direct.length, '之前测试里点过认识的词还在');
  await shot('08-retest-result-1280.png');
  await page.click('[data-testid=test-next]');
  assert.equal(await shown(), false, '设置里重测做完直接关闭');
  console.log(`PASS 重测只覆盖 test-estimate：${bulkBefore} → ${bulk2.length}，手动决定不动`);
  await finish();

  // ================= B：手机 390 =================
  await boot({ mobile: true, runId: 'mobile' });
  await page.waitFor('[data-testid=onboarding]', { timeout: 20000 });
  for (const scale of [100, 130]) {
    await page.evaluate(pct => { document.documentElement.style.fontSize = `${pct}%`; }, scale);
    await sleep(300);
    await noOverflow(`手机 ${scale}% 选目标`);
    await shot(`10-mobile-goal-${scale}.png`);
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = '100%'; });
  await page.click('[data-testid=goal-cet]');
  await page.click('[data-testid=goal-school]');
  await page.click('[data-testid=goal-next]');
  await page.waitFor('[data-testid=onboarding-test-intro]');
  await page.click('[data-testid=test-start]');
  await page.waitFor('[data-testid=level-word]');
  await answer(24);
  for (const scale of [100, 130]) {
    await page.evaluate(pct => { document.documentElement.style.fontSize = `${pct}%`; }, scale);
    await sleep(300);
    await noOverflow(`手机 ${scale}% 测试中`);
    await shot(`11-mobile-test-${scale}.png`);
  }
  await answer(26);
  await page.waitFor('[data-testid=level-result]', { timeout: 15000 });
  await page.waitUntil('结果已记录', `!!document.querySelector('[data-testid=level-saved] svg:not(.animate-spin)')`, { timeout: 60000 });
  for (const scale of [100, 130]) {
    await page.evaluate(pct => { document.documentElement.style.fontSize = `${pct}%`; }, scale);
    await sleep(300);
    await noOverflow(`手机 ${scale}% 结果页`);
    await shot(`12-mobile-result-${scale}.png`);
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = '100%'; });
  await page.click('[data-testid=test-next]');
  await page.waitFor('[data-testid=onboarding-perday]');
  for (const scale of [100, 130]) {
    await page.evaluate(pct => { document.documentElement.style.fontSize = `${pct}%`; }, scale);
    await sleep(300);
    await noOverflow(`手机 ${scale}% 每天几个`);
    await shot(`13-mobile-perday-${scale}.png`);
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = '100%'; });
  await page.click('[data-testid=perday-finish]');
  await page.waitFor('[data-testid=daily-remaining]', { timeout: 30000 });
  await shot('14-mobile-vocab-daily.png');
  console.log('PASS 手机 390（100% / 130%）引导各步不溢出');
  await finish();

  // ================= C：跳过 / 老用户 / 小入口 / 全点认识的提示 =================
  await boot({ runId: 'skip' });
  await page.waitFor('[data-testid=onboarding]', { timeout: 20000 });
  await page.click('[data-testid=goal-skip]');
  await page.waitFor('[data-testid=onboarding-test-intro]');
  await page.click('[data-testid=test-start]');
  await page.waitFor('[data-testid=level-word]');
  await answer(50, { allYes: true });
  await page.waitFor('[data-testid=level-result]', { timeout: 15000 });
  await page.waitUntil('结果已记录', `!!document.querySelector('[data-testid=level-saved] svg:not(.animate-spin)')`, { timeout: 60000 });
  await page.waitFor('[data-testid=level-warning]');
  assert.match(await page.text('[data-testid=level-warning]'), /结果不太可信/);
  const unreliableLabel = await page.text('[data-testid=level-estimate]');
  assert.equal(unreliableLabel, '结果不太可信', `全点认识且假词校正时不应只显示约 300 词：${unreliableLabel}`);
  assert.match(await page.evaluate(() => document.querySelector('[data-testid=test-retry]').className), /bg-ink/, '重测按钮应突出显示');
  const allYesPicks = await dbRows('wordpack_pick');
  assert.equal(allYesPicks.filter(row => row.pack === 'test-estimate').length, 0, '最低值不可信结果不批量写 test-estimate');
  await shot('20-all-yes-result-1280.png');
  await page.click('[data-testid=onboarding-close]'); // 先不做
  await sleep(500);
  assert.equal(await shown(), false);
  await page.reload();
  await page.waitReady('nav button');
  await sleep(2500);
  assert.equal(await shown(), false, '关掉后刷新不再弹');
  console.log('PASS 全点认识会提示假词、关掉后不再弹');

  // 库里有词：即使清掉「做过」标记也不自动弹
  await invoke('vocab_manual_add', { request: { word: 'hello', pos: '', chinese: '你好', english: '', example: '', source: '手动添加', issue: '11.14', date: '2026-11-14', note: '', allowDuplicate: false } });
  await page.evaluate(() => { localStorage.removeItem('worddrip_onboarding'); });
  await page.reload();
  await page.waitReady('nav button');
  await sleep(3000);
  assert.equal(await shown(), false, '词库里有词的老用户不自动弹');
  await page.clickText('词库');
  await page.waitFor('[data-testid=daily-card]');
  await page.waitFor('[data-testid=daily-level-test]');
  await shot('21-card-entry-1280.png');
  await page.click('[data-testid=daily-level-test]');
  await page.waitFor('[data-testid=onboarding-test-intro]');
  await shot('22-entry-test-1280.png');
  await page.click('[data-testid=onboarding-close]');
  console.log('PASS 老用户不自动弹，今日新词卡上的「测一下词汇量」能进入测试');
} catch (error) {
  failure = error;
  console.error(`FAIL ${error.stack || error.message}`);
  try { if (page) await shot('fail.png'); } catch { /* ignore */ }
} finally {
  try { await finish(); } catch (error) { if (!failure) { failure = error; console.error(`FAIL ${error.message}`); } }
}
process.exit(failure ? 1 : 0);
