// 014 到期筛选测试：node test-vocab-due.mjs（在 app 目录下）。
// 「今天」一律作为参数传入，不依赖运行机器的日期，也不改系统时钟。
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const out = join(tmpdir(), `vocab-due-${process.pid}.mjs`);
await build({ entryPoints: ['utils/vocab/due.ts'], bundle: true, format: 'esm', outfile: out, logLevel: 'silent' });
const d = await import(pathToFileURL(out).href);
rmSync(out, { force: true });

let ord = 0;
const word = (id, status, due, extra = {}) => {
  const level = /^L([1-4])$/.exec(status);
  ord += 1;
  return {
    id, ord, line: ord + 4, raw: '', word: id.split('@')[0], issue: id.split('@')[1] ?? '9.1', addedAt: '2026-10-01',
    status, level: level ? Number(level[1]) : null, due, note: `${id} 的备注`, ...extra,
  };
};
const ids = list => list.map(item => item.id);
const TODAY = '2026-11-05';

// ---- 本机今天：按本机年月日拼，不走 UTC ----
assert.equal(d.localToday(new Date(2026, 10, 5, 0, 0, 0)), '2026-11-05');
assert.equal(d.localToday(new Date(2026, 10, 5, 23, 59, 59)), '2026-11-05');
assert.equal(d.localToday(new Date(2026, 0, 1, 0, 0, 1)), '2026-01-01');
assert.equal(d.localToday(new Date(2024, 1, 29, 12)), '2024-02-29');
// 本机 0:30 时 UTC 可能还在前一天（东八区等），这里结果必须是本机日期。
const lateNight = new Date(2026, 10, 6, 0, 30);
assert.equal(d.localToday(lateNight), '2026-11-06');

// ---- 日期合法性 ----
for (const ok of ['2026-11-05', '2024-02-29', '2000-02-29', '2026-12-31', '2026-01-01']) assert.equal(d.isValidIsoDate(ok), true, ok);
for (const bad of ['2026-02-30', '2026-02-29', '1900-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-11-5', '—', '', ' ', '2026/11/05', '2026-11-05T00:00', 'abc'])
  assert.equal(d.isValidIsoDate(bad), false, JSON.stringify(bad));

// ---- 天数差（跨月、跨年、闰年） ----
assert.equal(d.daysBetween('2026-11-04', '2026-11-05'), 1);
assert.equal(d.daysBetween('2026-10-31', '2026-11-01'), 1);
assert.equal(d.daysBetween('2025-12-31', '2026-01-01'), 1);
assert.equal(d.daysBetween('2024-02-28', '2024-03-01'), 2);
assert.equal(d.daysBetween('2026-11-05', '2026-11-05'), 0);

// ---- 状态 → L 级 ----
assert.equal(d.statusLevel('L1'), 1);
assert.equal(d.statusLevel('L4'), 4);
for (const s of ['L0', 'L5', 'l2', '🌱待考察', '✅已掌握', '🧊冷库', '', 'L1x']) assert.equal(d.statusLevel(s), null, s);

// ---- 筛选：昨天、今天、明天，各种不该进入的情况 ----
const words = [
  word('tomorrow@1', 'L2', '2026-11-06'),
  word('today@1', 'L1', '2026-11-05'),
  word('yesterday@1', 'L3', '2026-11-04'),
  word('empty-dash@1', 'L2', '—'),
  word('empty@1', 'L2', ''),
  word('feb30@1', 'L1', '2026-02-30'),
  word('pending@1', '🌱待考察', '2026-11-01'),
  word('mastered@1', '✅已掌握', '2026-11-01'),
  word('cold@1', '🧊冷库', '2026-11-01'),
  word('unknown@1', '复习中', '2026-11-01', { level: null }),
  word('mismatch@1', 'L2', '2026-11-01', { level: 3 }),
  word('nolevel@1', 'L2', '2026-11-01', { level: null }),
  word('lastyear@1', 'L4', '2025-12-31'),
  word('lastmonth@1', 'L1', '2026-10-31'),
  word('spaces@1', 'L1', ' 2026-11-05 '),
];
const queue = d.dueQueue(words, TODAY);
assert.deepEqual(ids(queue), ['lastyear@1', 'lastmonth@1', 'yesterday@1', 'today@1', 'spaces@1']);
assert.deepEqual(queue.map(w => w.overdueDays), [309, 5, 1, 0, 0]);
assert.equal(queue[4].due, '2026-11-05', '首尾空白的日期去掉空白后显示');
assert.equal(d.dueLabel(queue[3]), '今天到期');
assert.equal(d.dueLabel(queue[2]), '逾期 1 天');

// 合法闰日：在 2024-02-29 当天到期；在 2024-02-28 还没到期。
const leap = [word('leap@1', 'L1', '2024-02-29')];
assert.deepEqual(ids(d.dueQueue(leap, '2024-02-29')), ['leap@1']);
assert.deepEqual(ids(d.dueQueue(leap, '2024-02-28')), []);
assert.deepEqual(ids(d.dueQueue(leap, '2024-03-01')), ['leap@1']);

// 跨年：12-31 到期，第二年 1-1 算逾期 1 天；跨月同理。
const year = d.dueQueue([word('nye@1', 'L2', '2026-12-31')], '2027-01-01');
assert.deepEqual(year.map(w => [w.id, w.overdueDays]), [['nye@1', 1]]);
assert.deepEqual(ids(d.dueQueue([word('nye@1', 'L2', '2026-12-31')], '2026-12-30')), []);

// ---- 同词不同 ID 分开，不按词文本合并；同一天按 ord 再按 ID 稳定排序 ----
ord = 100;
const dup = [
  word('shatter@10.20', 'L2', '2026-11-05'),
  word('shatter@9.24', 'L1', '2026-11-05'),
  word('agenda@9.18', 'L4', '2026-11-03'),
];
const dupQueue = d.dueQueue(dup, TODAY);
assert.deepEqual(ids(dupQueue), ['agenda@9.18', 'shatter@10.20', 'shatter@9.24']);
assert.equal(dupQueue.filter(w => w.word === 'shatter').length, 2);
// ord 相同时按 ID。
const tie = [
  { ...word('b@1', 'L1', '2026-11-05'), ord: 7 },
  { ...word('a@1', 'L1', '2026-11-05'), ord: 7 },
];
assert.deepEqual(ids(d.dueQueue(tie, TODAY)), ['a@1', 'b@1']);
// 打乱输入顺序结果不变。
assert.deepEqual(ids(d.dueQueue([...words].reverse(), TODAY)), ids(queue));

// ---- 全部未到期 → 0；空输入 → 空；不改输入 ----
assert.deepEqual(d.dueQueue([word('x@1', 'L1', '2026-11-06'), word('y@1', 'L4', '2027-01-01')], TODAY), []);
assert.deepEqual(d.dueQueue([], TODAY), []);
const snapshot = JSON.stringify(words);
d.dueQueue(words, TODAY);
assert.equal(JSON.stringify(words), snapshot, 'dueQueue 不能改输入');

// 今天本身不合法时直接报错，不会悄悄当成别的日期。
assert.throws(() => d.dueQueue(words, '2026-02-30'), /不合法/);

console.log('test-vocab-due: 全部通过');
