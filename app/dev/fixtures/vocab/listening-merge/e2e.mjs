// 054 隔离真实窗口：SQLite 词库 + IndexedDB 听力卡只在页面合并，原声和两套复习分开验证。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, stop, DEV_PORT } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { portInUse } from '../../../e2e/proc.mjs';
import { listTables, openDb, queryRows } from '../../../e2e/db.mjs';

if (await portInUse(DEV_PORT)) {
  console.error(`${DEV_PORT} 端口已被占用，先关掉别的开发窗口再测。`);
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.resolve('D:/tmp/es-e2e', `054-listening-merge-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });
const media = path.join(runDir, 'fixture-tone.mp4');
fs.copyFileSync(fileURLToPath(new URL('../../../../src-tauri/tests/fixtures/tone.mp4', import.meta.url)), media);
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const today = localDate();
const tomorrow = localDate(new Date(Date.now() + 86400000));
const importRequest = {
  upgrade: { fileName: 'empty-upgrade.md', content: '# 学术升级库\n' },
  review: { fileName: 'listening-054.md', content: '# 词汇总词库\n' },
  entries: [{ id: 'dummy@1', line: 2, raw: '| dummy |', plain: 'dummy', upgrade: 'dummy', source: '测试', note: '' }], examples: [], selfChecks: [],
  reviewWords: [
    { id: 'shared@1', ord: 1, line: 2, raw: '| shared |', word: 'shared', issue: '54', addedAt: today, status: 'L1', level: 1, due: today, note: '' },
    { id: 'library@1', ord: 2, line: 3, raw: '| library-only |', word: 'library-only', issue: '54', addedAt: today, status: 'L1', level: 1, due: tomorrow, note: '' },
    { id: 'third@1', ord: 3, line: 4, raw: '| third |', word: 'third', issue: '54', addedAt: today, status: '🌱待考察', level: null, due: '', note: '' },
  ],
  warnings: { upgrade: [], review: [] },
};
const issueFiles = [{ fileName: '20261112.md', content: '## 词单分析\n1. **shared** v. — to use together（共享）；*We shared the original sentence.*\n' }];
const now = Date.now();
const card = (id, word, due, start) => ({
  id, deck: 'word', videoId: `video-${id}`, videoName: '隔离原声', videoPath: media,
  text: `We shared the original sentence with ${word}.`, start, end: Math.min(2.8, start + 0.8),
  word, definition: `<b>${word}</b>：听力里的释义`, example: '<i>Listening example</i>', ai: '', reasons: ['lookup'], saved: false,
  clip: { kind: 'video', file: `${id}.mp4`, from: 0 },
  fsrs: { due, stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, reps: 0, lapses: 0, state: 0 },
  createdAt: now,
});
const cards = [card('shared-due', '  ShArEd  ', now - 1000, 0), card('listening-later', 'listening-only', now + 86400000, 1), card('another-later', 'Another', now + 172800000, 1.8)];

const invoke = async (page, command, args = {}) => {
  const result = await page.evaluate(async (cmd, payload) => {
    try { return { value: await window.__TAURI_INTERNALS__.invoke(cmd, payload) }; }
    catch (error) { return { error: typeof error === 'string' ? error : String(error) }; }
  }, command, args);
  if (result.error) throw new Error(`${command} 失败：${result.error}`);
  return result.value;
};
const seedCards = (page, values) => page.evaluate(async rows => {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('linguaclip_review', 1);
    req.onupgradeneeded = () => { for (const name of ['cards', 'meta']) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['cards', 'meta'], 'readwrite');
    rows.forEach(row => tx.objectStore('cards').put(row));
    tx.objectStore('meta').put({ id: 'migrated' });
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  db.close();
}, values);
const readCards = page => page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => { const req = indexedDB.open('linguaclip_review', 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const rows = await new Promise((resolve, reject) => { const req = db.transaction('cards').objectStore('cards').getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  db.close(); return rows;
});
const rows = page => page.evaluate(() => [...document.querySelectorAll('[data-testid=vocab-list] > button')].map(row => ({ text: row.innerText, kind: row.dataset.kind, key: row.dataset.wordKey, listening: !!row.querySelector('[data-testid=listening-badge]') })));
const setFilter = (page, value) => page.evaluate(next => { const select = document.querySelector('[data-testid=listening-filter]'); select.value = next; select.dispatchEvent(new Event('change', { bubbles: true })); }, value);
const shot = (page, name) => page.screenshot(path.join(out, name), { full: true });
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const snapshot = db => Object.fromEntries(listTables(db).map(table => [table, queryRows(db, table)]));

let session;
let page;
let ok = false;
try {
  session = await start({ runDir, port: 9471 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.clickText('词库', { timeout: 60000 });
  assert.equal((await invoke(page, 'vocab_import', { request: importRequest })).reviewWords.added, 3);
  await invoke(page, 'vocab_definition_import', { request: { issues: issueFiles, eagp: null } });
  await seedCards(page, cards);
  await page.reload();
  await page.clickText('词库', { timeout: 60000 });
  await page.waitFor('[data-testid=vocab-list]');
  await page.waitUntil('合并后的五行出现', `document.querySelectorAll('[data-testid=vocab-list] > button').length === 5`);

  const nav = await page.evaluate(() => [...document.querySelectorAll('nav button')].map(button => button.innerText.trim()));
  assert.ok(!nav.some(text => text === '单词' || text.startsWith('单词 ')), `导航仍有独立单词：${nav}`);
  assert.ok(nav.some(text => text.startsWith('听力句子')), '句子入口已改名');
  assert.equal(await page.evaluate(() => { const button = [...document.querySelectorAll('nav button')].find(item => item.innerText.trim() === '词库'); return button?.querySelector('[data-testid=nav-due]')?.dataset.badge; }), '2', '词库徽标应为 1 + 1 = 2');
  const all = await rows(page);
  assert.equal(all.filter(row => row.key === 'w:shared').length, 1, 'shared 只有一行');
  assert.equal(all.find(row => row.key === 'w:shared').listening, true, 'shared 带听力标记');
  assert.equal(all.filter(row => row.listening).length, 3);
  assert.match(await page.text('[data-testid=listening-filter]'), /全部（5）[\s\S]*听力（3）[\s\S]*非听力（2）/);
  await setFilter(page, 'listening');
  await page.waitUntil('听力筛选三行', `document.querySelectorAll('[data-testid=vocab-list] > button').length === 3`);
  assert.equal((await rows(page)).every(row => row.listening), true);
  await setFilter(page, 'vocab');
  await page.waitUntil('非听力筛选两行', `document.querySelectorAll('[data-testid=vocab-list] > button').length === 2`);
  assert.deepEqual((await rows(page)).map(row => row.key).sort(), ['w:library-only', 'w:third']);
  await setFilter(page, 'all');
  await page.waitUntil('恢复全部五行', `document.querySelectorAll('[data-testid=vocab-list] > button').length === 5`);
  await shot(page, '01-merged-1280.png');

  // 两边都有的词：词库详情与听力原句同时存在。
  await page.click('[data-word-key="w:shared"]');
  await page.waitFor('[data-testid=word-detail]');
  await page.waitFor('[data-testid=listening-section]');
  assert.match(await page.text('[data-testid=vocab-detail]'), /共享[\s\S]*We shared the original sentence/);
  assert.match(await page.text('[data-testid=listening-section]'), /词库进度/);
  await page.click('[data-testid=vocab-back]').catch(() => {}); // 宽屏没有返回按钮时忽略
  await page.click('[data-word-key="w:listening-only"]');
  await page.waitFor('[data-testid=listening-word-detail]');
  assert.equal(await page.evaluate(() => !!document.querySelector('[data-testid=word-detail]')), false, '听力独有不渲染词库专属操作');
  assert.match(await page.text('[data-testid=listening-word-detail]'), /没有词库条目/);
  await page.click('[data-word-key="w:shared"]');
  await page.waitFor('[data-testid=listening-section]');
  await page.click('[data-card-id="shared-due"] [data-testid=listening-clip-play]');
  await page.waitUntil('原声 video 真的开始播放', `(() => { const v = document.querySelector('[data-card-id=shared-due] video'); return v && !v.paused && v.currentTime >= 0; })()`);
  await shot(page, '02-shared-detail-1280.png');

  let db = await openDb(session);
  const before = snapshot(db);
  db.close();
  const cardBefore = (await readCards(page)).find(row => row.id === 'shared-due');

  // 顶部听力复习入口直接沿用原 ReviewSession；作答正面无释义和播放按钮。
  await page.click('[data-testid=listening-review-entry]');
  await page.waitFor('[data-testid=word-detail]', { visible: false }).catch(() => {});
  await page.waitFor('[data-testid=review-session]');
  await page.waitText('看答案');
  const listeningAnswer = await page.evaluate(() => { const root = document.querySelector('[data-testid=review-session]'); return { voice: root.querySelectorAll('[data-testid=vocab-voice], [data-testid=listening-clip-play]').length, text: root.innerText }; });
  assert.equal(listeningAnswer.voice, 0, '听力作答中没有发音/原声按钮');
  assert.ok(!listeningAnswer.text.includes('听力里的释义'), '听力作答正面没有释义');
  await page.clickText('看答案', { exact: false });
  await page.clickText('良好', { exact: false });
  await page.waitText('这一轮复习完了');
  await page.clickText('完成');
  await page.waitUntil('听力复习弹层关闭', `!document.body.innerText.includes('这一轮复习完了')`);
  const cardAfter = (await readCards(page)).find(row => row.id === 'shared-due');
  assert.equal(cardAfter.fsrs.reps, cardBefore.fsrs.reps + 1, '听力卡按原 FSRS 规则更新');
  assert.ok(cardAfter.fsrs.due > cardBefore.fsrs.due, '听力卡下次到期已推进');
  db = await openDb(session);
  assert.deepEqual(snapshot(db), before, '听力复习没有改变词库 SQLite');
  db.close();

  // 回到浏览，顶部单词复习入口能产出题，作答中同样没有发音按钮。
  await page.clickText('浏览', { selector: 'button[role=tab]' });
  await page.click('[data-testid=due-recall-start]');
  await page.waitFor('[data-testid=recall-screen]');
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid=recall] [data-testid=vocab-voice], [data-testid=recall] [data-testid=listening-clip-play]').length), 0);
  await page.click('button[aria-label^="退出复习"]');
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  await page.reload();
  await page.clickText('词库', { timeout: 60000 });
  await page.waitFor('[data-testid=vocab-list]');
  assert.equal(await noOverflow(page), true, '390 宽页面横向溢出');
  await page.evaluate(() => document.querySelector('[data-testid=vocab-browse]').scrollIntoView({ block: 'start' }));
  await shot(page, '03-merged-390.png');
  await page.click('[data-word-key="w:listening-only"]');
  await page.waitFor('[data-testid=listening-word-detail]');
  assert.equal(await noOverflow(page), true, '390 宽听力详情横向溢出');
  await shot(page, '04-listening-detail-390.png');

  console.log(JSON.stringify({ result: '通过', runDir, screenshots: fs.readdirSync(out).filter(name => name.endsWith('.png')).sort(), cardBefore: cardBefore.fsrs, cardAfter: cardAfter.fsrs, pageErrors: page.errors }, null, 2));
  ok = true;
} catch (error) {
  console.error(error.stack || error);
  if (page) await shot(page, '99-failure.png').catch(() => {});
} finally {
  page?.close();
  if (session) await stop(runDir).catch(error => console.error(`停止隔离窗口失败：${error.message}`));
}
process.exit(ok ? 0 : 1);
