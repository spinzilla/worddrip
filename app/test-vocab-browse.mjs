import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const out = join(tmpdir(), `vocab-browse-${process.pid}.mjs`);
await build({ entryPoints: ['utils/vocab/browse.ts'], bundle: true, format: 'esm', outfile: out });
const b = await import(pathToFileURL(out).href);
const data = JSON.parse(readFileSync(new URL('dev/fixtures/vocab/browse/data.json', import.meta.url), 'utf8'));
const ids = list => list.map(item => item.id);

// 空查询 / 纯空白：返回原数组，保持默认顺序。
assert.equal(b.filterUpgrades(data.upgrades, ''), data.upgrades);
assert.equal(b.filterUpgrades(data.upgrades, '   '), data.upgrades);
assert.equal(b.filterReviews(data.reviewWords, '').length, 4);

// 大小写不敏感 + 首尾空白；搜升级表达。
assert.deepEqual(ids(b.filterUpgrades(data.upgrades, '  COMPRISE ')), ['up:be made up of#1']);
// 搜日常表达、出处、备注、例句。
assert.deepEqual(ids(b.filterUpgrades(data.upgrades, 'be made')), ['up:be made up of#1']);
assert.deepEqual(ids(b.filterUpgrades(data.upgrades, 'awl sl5')), ['up:noex#1']);
assert.deepEqual(ids(b.filterUpgrades(data.upgrades, '9.18')), ['up:be made up of#1']);
assert.deepEqual(ids(b.filterUpgrades(data.upgrades, 'five departments')), ['up:be made up of#1']);
// 中文备注。
assert.deepEqual(ids(b.filterUpgrades(data.upgrades, '普通文本')), ['up:html#1']);
// 第 3 条例句（非首条）也要能搜到。
assert.deepEqual(ids(b.filterUpgrades(data.upgrades, 'is composed of')), ['up:be made up of#1']);
// 含 HTML 标记的普通文本：按字面子串匹配，不当标签解析。
assert.deepEqual(ids(b.filterUpgrades(data.upgrades, '<script>')), ['up:html#1']);
assert.deepEqual(ids(b.filterUpgrades(data.upgrades, '<u>underline</u>')), ['up:html#1']);
// 无结果。
assert.deepEqual(b.filterUpgrades(data.upgrades, 'zzz-no-such'), []);
// 清空后恢复默认顺序。
assert.deepEqual(ids(b.filterUpgrades(data.upgrades, '')), ['up:be made up of#1', 'up:html#1', 'up:noex#1']);

// 复习词：词目、期号、状态、完整备注；重复词各自保留。
assert.deepEqual(ids(b.filterReviews(data.reviewWords, 'HOOK')), ['rv:hook@8.25#1']);
assert.deepEqual(ids(b.filterReviews(data.reviewWords, 'shatter')), ['rv:shatter@9.24#1', 'rv:shatter@10.20#1']);
assert.deepEqual(ids(b.filterReviews(data.reviewWords, '10.20')), ['rv:shatter@10.20#1']);
assert.deepEqual(ids(b.filterReviews(data.reviewWords, 'l4')), ['rv:agenda@9.18#1']);
assert.deepEqual(ids(b.filterReviews(data.reviewWords, '待考察')), ['rv:hook@8.25#1', 'rv:shatter@9.24#1', 'rv:shatter@10.20#1']);
// 长备注末尾的内容也能搜到（不能只搜前一段）。
assert.deepEqual(ids(b.filterReviews(data.reviewWords, 'agendas 对，升 L4')), ['rv:agenda@9.18#1']);
assert.deepEqual(ids(b.filterReviews(data.reviewWords, '吸引')), ['rv:hook@8.25#1']);
assert.deepEqual(ids(b.filterReviews(data.reviewWords, '课堂笔记')), ['rv:shatter@9.24#1']);
assert.deepEqual(ids(b.filterReviews(data.reviewWords, '', '未查证')), ['rv:hook@8.25#1', 'rv:agenda@9.18#1']);
assert.deepEqual(ids(b.filterReviews(data.reviewWords, 'shatter', '老师确认')), ['rv:shatter@10.20#1']);
assert.deepEqual(b.filterReviews(data.reviewWords, 'hook', '老师确认'), []);

// 自查搜全文。
assert.deepEqual(ids(b.filterSelfChecks(data.selfChecks, 'VERBOSE expression')), ['sc:1']);
assert.deepEqual(b.filterSelfChecks(data.selfChecks, '啰嗦').length, 1);
assert.deepEqual(b.filterSelfChecks(data.selfChecks, 'nope'), []);

// 过滤不改变输入数据。
const snapshot = JSON.stringify(data);
b.filterUpgrades(data.upgrades, 'x'); b.filterReviews(data.reviewWords, 'x'); b.filterSelfChecks(data.selfChecks, 'x');
assert.equal(JSON.stringify(data), snapshot);

// 空库判断。
assert.equal(b.isBrowseEmpty(b.emptyBrowse()), true);
assert.equal(b.isBrowseEmpty(data), false);

// 例句标签。
assert.equal(b.exampleLabel({ seq: 1, cand: 'a', sentence: 's', ai: true }), 'AI 例句');
assert.equal(b.exampleLabel({ seq: 1, cand: 'a', sentence: 's', ai: false }), '原有例句');

// 异步响应先后颠倒：先发的请求后到，必须被丢弃。
{
  const gate = b.createLatestGate();
  const first = gate.next();
  const second = gate.next();
  const shown = [];
  // 第二个先到、第一个后到。
  if (gate.isCurrent(second)) shown.push('second');
  if (gate.isCurrent(first)) shown.push('first');
  assert.deepEqual(shown, ['second']);
}
// 页面离开后迟到的响应被忽略；StrictMode 重新挂载后可复活，新请求有效。
{
  const gate = b.createLatestGate();
  const t = gate.next();
  gate.dispose();
  assert.equal(gate.isCurrent(t), false);
  gate.revive();
  assert.equal(gate.isCurrent(t), false);
  assert.equal(gate.isCurrent(gate.next()), true);
}
// 离开后即使发起过 next，也不会被判为当前。
{
  const gate = b.createLatestGate();
  gate.dispose();
  assert.equal(gate.isCurrent(gate.next()), false);
}

console.log('vocab browse tests passed');
