// 081 每日新词：挑词、当天固定、以后再说 7 天、手势/键盘判断、计划整理。
// 用法（在 app 目录）：node test-vocab-daily.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundled = path.resolve('src-tauri/target/vocab-daily-tests', `daily-${process.pid}.mjs`);
fs.mkdirSync(path.dirname(bundled), { recursive: true });
await build({ entryPoints: ['utils/vocab/dailyWords.ts'], bundle: true, format: 'esm', outfile: bundled, logLevel: 'silent' });
// localStorage 替身（真实窗口里用的是浏览器的）
const store = new Map();
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
const m = await import(pathToFileURL(bundled).href);

// ---- 词表：按词频从常见到少见（和 wordpack_list 一样已排好序） ----
const e = (word, tags = ['cet4'], exchange = '') => ({ word, phonetic: '', pos: 'n.', zh: '中', en: 'en', frq: 1, bnc: 1, tags, exchange });
const pool = [
  e('run', ['cet4'], 'p:ran/d:run/i:running/3:runs'), e('able'), e('ability'), e('abroad', ['cet4', 'ky']), e('absent', ['cet6']),
  e('accept'), e('access'), e('account'), e('achieve'), e('act'), e('action'), e('active'),
];
const deps = {
  list: async (tags, { offset, limit }) => pool.filter(w => w.tags.some(t => tags.includes(t))).slice(offset, offset + limit),
};
const T0 = '2026-11-14';
const row = (word, state, decidedAt = T0, pack = '四级') => ({ wordKey: m.wordKey(word), word, state, pack, decidedAt, updatedAt: 'x' });
const keys = list => list.map(w => w.word);

// ---- 挑词：按词频顺序，只取所选词表 ----
let got = await m.pickCandidates(deps, { packs: ['cet4'], library: new Set(), picks: new Map(), today: T0 }, 3);
assert.deepEqual(keys(got), ['run', 'able', 'ability']);
got = await m.pickCandidates(deps, { packs: ['cet6'], library: new Set(), picks: new Map(), today: T0 }, 3);
assert.deepEqual(keys(got), ['absent'], '只出所选词表的词');
assert.deepEqual(await m.pickCandidates(deps, { packs: [], library: new Set(), picks: new Map(), today: T0 }, 3), [], '没选词表不出词');

// ---- 排除：词库已有（含变形）、已决定 ----
const library = new Set(['running', 'able']); // 库里有 running → 不再送 run
const picks = m.pickMap([row('ability', 'known'), row('abroad', 'taken')]);
got = await m.pickCandidates(deps, { packs: ['cet4'], library, picks, today: T0 }, 4);
assert.deepEqual(keys(got), ['accept', 'access', 'account', 'achieve']);
assert.equal(m.inLibrary(pool[0], new Set(['ran'])), true, '过去式也算');
assert.equal(m.inLibrary(pool[1], new Set(['abler'])), false);
// 翻页：每页 400，词表词数超过一页也要继续取
const big = Array.from({ length: 900 }, (_, i) => e(`w${String(i).padStart(4, '0')}`));
const bigDeps = { list: async (_t, { offset, limit }) => big.slice(offset, offset + limit) };
const decided = m.pickMap(big.slice(0, 850).map(w => row(w.word, 'known')));
got = await m.pickCandidates(bigDeps, { packs: ['cet4'], library: new Set(), picks: decided, today: T0 }, 10);
assert.equal(got.length, 10);
assert.equal(got[0].word, 'w0850', '跨页后仍按词频顺序');

// ---- 以后再说：7 天后才再出现 ----
const later = m.pickMap([row('able', 'later', '2026-11-10')]);
assert.equal(m.isBlocked(later.get('able'), '2026-11-16'), true, '第 6 天还不出现');
assert.equal(m.isBlocked(later.get('able'), '2026-11-17'), false, '满 7 天再出现');
assert.equal(m.isBlocked(m.pickMap([row('able', 'known', '2020-01-01')]).get('able'), '2026-11-17'), true, '认识永远不再出现');
assert.equal(m.isBlocked(undefined, T0), false);
assert.equal(m.addDays('2026-11-28', 7), '2026-12-05');
assert.equal(m.addDays('2026-12-28', 7), '2027-01-04');
got = await m.pickCandidates(deps, { packs: ['cet4'], library: new Set(), picks: later, today: '2026-11-16' }, 3);
assert.ok(!keys(got).includes('able'));
got = await m.pickCandidates(deps, { packs: ['cet4'], library: new Set(), picks: later, today: '2026-11-17' }, 3);
assert.ok(keys(got).includes('able'));

// ---- 当天固定：同一天不变，第二天换新，换词表重新挑，数量改大会补 ----
const plan = { packs: ['cet4'], perDay: 3 };
const ctx = { library: new Set(), picks: new Map(), today: T0 };
const day1 = await m.buildDaily(deps, plan, ctx, null);
assert.deepEqual(keys(day1.entries), ['run', 'able', 'ability']);
m.saveDailyState(day1);
// 收下的词进了词库、候选池也有了记录，同一天重新进来名单仍不变
const ctxLater = { library: new Set(['run', 'able']), picks: m.pickMap([row('ability', 'known')]), today: T0 };
const day1again = await m.buildDaily(deps, plan, ctxLater, m.loadDailyState());
assert.deepEqual(keys(day1again.entries), ['run', 'able', 'ability'], '同一天名单固定');
assert.deepEqual(keys(m.remainingOf(day1again, ctxLater.picks, T0)), ['run', 'able'], '已决定的不算剩余');
// 第二天：昨天的词都处理了，换新的
const ctxDay2 = { library: new Set(['run', 'able']), picks: m.pickMap([row('able', 'known'), row('run', 'taken'), row('ability', 'known')]), today: '2026-11-15' };
const day2 = await m.buildDaily(deps, plan, ctxDay2, m.loadDailyState());
assert.equal(day2.date, '2026-11-15');
assert.deepEqual(keys(day2.entries), ['abroad', 'accept', 'access']);
// 每天数量调大：补足
const bigger = await m.buildDaily(deps, { packs: ['cet4'], perDay: 5 }, ctx, day1);
assert.deepEqual(keys(bigger.entries), ['run', 'able', 'ability', 'abroad', 'accept']);
// 换词表：重新挑
const switched = await m.buildDaily(deps, { packs: ['cet6'], perDay: 3 }, ctx, day1);
assert.deepEqual(keys(switched.entries), ['absent']);
// 再来 5 个：追加，不动已有的
const more = await m.buildDaily(deps, plan, ctx, day1, 1);
assert.equal(more.entries.length, 8);
assert.deepEqual(keys(more.entries).slice(0, 3), ['run', 'able', 'ability']);
assert.equal(more.extra, 1);
assert.equal(new Set(keys(more.entries)).size, 8, '追加的词不和已有的重复');

// ---- 收下数、来源标签 ----
assert.equal(m.takenToday([row('a', 'taken'), row('b', 'known'), row('c', 'taken', '2026-11-13')], T0), 1);
assert.equal(m.packOf(e('x', ['cet6', 'cet4']), ['cet4', 'cet6']), '四级');
assert.equal(m.packOf(e('x', ['cet6', 'ngsl']), ['ngsl']), '核心 2800');
assert.equal(m.packOf(e('x', ['gre']), ['cet4']), 'GRE', '不在所选词表里也能给出自己的词表名');

// ---- 手势与键盘 ----
assert.equal(m.swipeDecision(-120, 10), 'known');
assert.equal(m.swipeDecision(120, -10), 'taken');
assert.equal(m.swipeDecision(5, -150), 'later');
assert.equal(m.swipeDecision(5, 150), null, '下滑不算');
assert.equal(m.swipeDecision(20, 10), null, '位移不够不算');
assert.equal(m.keyDecision('ArrowLeft'), 'known');
assert.equal(m.keyDecision('ArrowRight'), 'taken');
assert.equal(m.keyDecision('ArrowUp'), 'later');
assert.equal(m.keyDecision(' '), 'flip');
assert.equal(m.keyDecision('a'), null);

// ---- 释义分行 ----
assert.deepEqual(m.lines('n. 放弃\nvt. 遗弃\n\nx\ny', 3), ['n. 放弃', 'vt. 遗弃', 'x']);

// ---- 计划：存取、去重、默认 ----
assert.deepEqual(m.getPlan(), { packs: [], perDay: 10, cardOn: true });
m.savePlan({ packs: ['cet4', 'cet4', 'nope', 'ngsl'], perDay: 500, cardOn: false });
assert.deepEqual(m.getPlan(), { packs: ['cet4', 'ngsl'], perDay: 100, cardOn: false });
m.savePlan({ packs: ['gre'], perDay: 0, cardOn: true });
assert.equal(m.getPlan().perDay, 1);

// ---- 计划同步：数据库为准，本机只是缓存 ----
{
  store.clear();
  let dbRow = null; const writes = [];
  const backend = { planGet: async () => dbRow, planSet: async p => { writes.push(p); dbRow = { ...p }; } };
  // 库里没有、本机也没存过 → 什么都不写
  assert.deepEqual(await m.refreshPlanFrom(backend), { packs: [], perDay: 10, cardOn: true });
  assert.equal(writes.length, 0);
  // 保存：缓存立刻变，库里也有
  await m.savePlanTo(backend, { packs: ['cet4', 'cet4'], perDay: 5, cardOn: true });
  assert.deepEqual(m.getPlan(), { packs: ['cet4'], perDay: 5, cardOn: true });
  assert.deepEqual(dbRow, { packs: ['cet4'], perDay: 5, cardOn: true });
  // 别的设备同步来了新计划 → 缓存跟着变，并通知界面
  let notified = 0;
  globalThis.window = new EventTarget();
  const off = m.onPlanChanged(() => { notified += 1; });
  dbRow = { packs: ['gre', 'ngsl'], perDay: 20, cardOn: false };
  assert.deepEqual(await m.refreshPlanFrom(backend), { packs: ['gre', 'ngsl'], perDay: 20, cardOn: false });
  assert.deepEqual(m.getPlan(), { packs: ['gre', 'ngsl'], perDay: 20, cardOn: false });
  assert.equal(notified, 1);
  await m.refreshPlanFrom(backend); // 没变化就不再通知
  assert.equal(notified, 1);
  off(); delete globalThis.window;
  // 升级前只存在本机缓存的计划 → 补写进库
  store.clear(); dbRow = null; writes.length = 0;
  m.savePlan({ packs: ['ky'], perDay: 10, cardOn: true });
  await m.refreshPlanFrom(backend);
  assert.deepEqual(writes, [{ packs: ['ky'], perDay: 10, cardOn: true }]);
  // 读库时要等正在进行的写入完成，不会拿旧值盖掉新计划
  store.clear(); dbRow = { packs: ['cet4'], perDay: 10, cardOn: true };
  let release;
  const slow = { planGet: async () => dbRow, planSet: p => new Promise(res => { release = () => { dbRow = { ...p }; res(); }; }) };
  const saving = m.savePlanTo(slow, { packs: ['gre'], perDay: 10, cardOn: true });
  const refreshing = m.refreshPlanFrom(slow);
  await new Promise(r => setTimeout(r, 5));
  release(); await saving;
  assert.deepEqual((await refreshing).packs, ['gre']);
  assert.deepEqual(m.getPlan().packs, ['gre']);
}

// ---- 界面静态检查：卡片、设置、首考入口都接上了 ----
const read = f => fs.readFileSync(f, 'utf8');
assert.match(read('components/vocab/VocabPage.tsx'), /<DailyWordsCard \/>/);
assert.match(read('components/SettingsCards.tsx'), /<DailyWordsSettings/);
assert.match(read('components/vocab/FirstTestPanel.tsx'), /onFirstTestRequest/);
assert.match(read('components/vocab/DailyWordsCard.tsx'), /prefers-reduced-motion/);
console.log('PASS test-vocab-daily');
