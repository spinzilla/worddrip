// 029 查词界面：搜索、排序、候选词拆分、按期分组的单元测试。
// 用法（在 app 目录）：node test-vocab-library.mjs
// 有 D:\tmp\es-import 的真实原料副本时，会额外用真实 80 组升级条目 + 486 条复习词跑一遍（只读）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const out = join(tmpdir(), `vocab-library-${process.pid}.mjs`);
await build({
  stdin: { contents: "export * from './utils/vocab/library.ts'; export * from './utils/vocab/parse.ts';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', outfile: out,
});
const L = await import(pathToFileURL(out).href);

const def = (pos, english, chinese, examples = []) => ({ sourceFile: 'f.md', sourceLine: 1, pos, english, chinese, examples: examples.map((sentence, i) => ({ seq: i + 1, sentence: sentence.replace(/ \(AI\)$/, ''), ai: sentence.endsWith('(AI)') })) });
let ord = 0;
const rw = (word, issue, status, extra = {}) => {
  ord += 1;
  const level = /^L([1-4])$/.exec(status);
  return {
    id: `rv:${word}@${issue}#1`, ord, line: ord + 10, raw: `| ${word} |`, word, issue, addedAt: extra.addedAt ?? '2026-10-14', status,
    level: level ? Number(level[1]) : null, due: extra.due ?? '—', note: extra.note ?? '', source: extra.source ?? '',
    verificationStatus: extra.verificationStatus ?? '未查证', definitions: extra.definitions ?? [],
  };
};
const up = (id, plain, upgrade, examples, note = '', source = '学术高频') => ({
  id, ord: Number(id.replace(/\D/g, '')) || 1, line: 1, raw: `| ${plain} |`, plain, upgrade, source, note,
  examples: examples.map(([cand, sentence], i) => ({ seq: i + 1, cand, sentence: sentence.replace(/ \(AI\)$/, ''), ai: sentence.endsWith('(AI)') })),
});

const data = {
  reviewWords: [
    rw('exacerbate', '每日表达10-06', 'L1', { due: '2026-11-11', addedAt: '2026-10-06', note: '每日加分表达 10-06；加剧（替换 worsen），exacerbate air pollution；2026-10-09 填空对；⚠️拼写 exaccerbates 多 c' }),
    rw('shatter', '9.24', '🌱待考察', { note: '粉碎；破灭', definitions: [def('v.', 'to break suddenly into very small pieces', '粉碎；使破灭', ['The scandal shattered public confidence in the institution.'])] }),
    rw('shatter', '10.20', '🌱待考察', { addedAt: '2026-10-22', note: '粉碎；抽象', verificationStatus: '老师确认', definitions: [def('v.', 'to break suddenly into very small pieces', '粉碎；使破灭'), def('v.', 'to destroy feelings or hopes', '使（希望）破灭', ['His hopes were shattered. (AI)'])] }),
    rw('conduct', '9.24', 'L3', { due: '2026-11-20', addedAt: '2026-10-05' }),
    rw('conductive', '10.20', '✅已掌握', { addedAt: '2026-10-22' }),
    rw('misconduct', '10.20', '🧊冷库', { addedAt: '2026-10-22' }),
    rw('agenda', '9.18', 'L4', { due: '2026-11-11', addedAt: '2026-10-04', note: '9.18 期；多方主体用复数；2026-10-26 复习复数 agendas 对，升 L4' }),
    rw('hypothesis', 'EAGP-CS1-', '🌱待考察', { note: '假设（复数 hypotheses）' }),
    rw('process', '8.25', 'L2', { due: '2026-11-10', addedAt: '2026-10-14' }),
    rw('outset', '8.25', '✅已掌握', { note: 'n. 开端（from the outset 从一开始）' }),
    rw('from the outset', '8.25', '🌱待考察', { note: '从一开始' }),
    rw('<b>tag</b>', '9.1', '🌱待考察', { note: '<script>alert(1)</script>' }),
  ],
  upgrades: [
    up('up:1', 'worsen', '**deteriorate**（不及物，自身变坏 her health deteriorated）/ **exacerbate**（及物，使更糟 exacerbate air pollution）',
      [['deteriorate', 'Her health deteriorated rapidly.'], ['exacerbate', 'The drought exacerbated the food shortage. (AI)']], '10.05 期；exacerbate 在复习库'),
    up('up:2', 'be made up of', '**comprise**（不接 of）/ consist of / be composed of',
      [['comprise', 'The committee comprises five departments. (AI)'], ['consist of', 'The committee consists of five departments. (AI)'], ['be composed of', 'The committee is composed of five departments.']], '9.18 期', 'AWL SL7'),
    up('up:3', 'carry out', '**conduct**（conduct an experiment/research）/ **implement**（effective/successful implementation）',
      [['conduct', 'The team conducted a series of experiments. (AI)'], ['implement', 'The new policy was successfully implemented. (AI)']]),
    up('up:4', '学以致用', '**put … into practice / put … into (practical) application**：put the newly acquired skills into practical application',
      [['put … into practice', 'We must put the theory into practice. (AI)'], ['put … into (practical) application', 'It is strongly suggested that the newly acquired skills be put into practical application.']], '9.24 期；⚠️application（应用）≠ appliance（电器）'),
    up('up:5', 'use（利用资源/方法）', '**utilize**（英式 utilise）：utilize data / utilize a mixed-methods approach；**employ**：employ a method/technique',
      [['utilize', 'The study utilized a mixed-methods approach to analyze the data.']]),
    up('up:6', 'exact and clear', '**precise**：precise definition, precise nature', [['precise', 'Precise measurements are essential in experimental work.']]),
    up('up:7', 'break', '**shatter**（粉碎 + 抽象破灭 shatter confidence/hopes）/ **crack**（裂而未碎）',
      [['shatter', 'The scandal shattered public confidence in the institution.'], ['crack', 'The ice cracked as I stepped onto it.']]),
  ],
  selfChecks: [{ id: 'sc:1', ord: 1, line: 9, raw: '- x', text: 'concise（简明）↔ verbose（啰嗦）：改稿时删 verbose expression' }],
};
const snapshot = JSON.stringify(data);
const lib = L.buildLibrary(data);
const ids = hits => hits.map(hit => hit.id);
const search = (q, options) => L.searchLibrary(lib, q, options);

// ---- 合并同词 ----
assert.equal(lib.words.length, data.reviewWords.length - 1, 'shatter 两期合并成一个词');
const shatter = lib.wordByKey.get('w:shatter');
assert.equal(shatter.entries.length, 2);
assert.equal(shatter.latest.issue, '10.20', '最新一期为准');
assert.equal(shatter.definitions.length, 2, '两期相同的释义去重，不同的保留');
assert.equal(shatter.gloss, '粉碎；使破灭');
assert.deepEqual(shatter.pos, ['v.']);
assert.equal(lib.wordByKey.get('w:exacerbate').gloss, '加剧（替换 worsen），exacerbate air pollution', '没有释义时用备注里第一段意思，跳过「每日加分表达 10-06」这种出处');
assert.equal(lib.wordByKey.get('w:agenda').gloss, '多方主体用复数', '跳过「9.18 期」');
assert.equal(L.isProvenance('惩罚 → 不利后果（复现 10.05）'), false, '带期号的意思不算出处');

// ---- 中文概念搜索：「加剧」先出词，再出它所在的升级条目 ----
{
  const hits = search('加剧');
  assert.deepEqual(ids(hits), ['w:exacerbate', 'up:1']);
  assert.match(hits[1].reason, /exacerbate/);
  assert.ok(hits[0].score > hits[1].score);
}
// 中文释义命中
assert.deepEqual(ids(search('破灭')).slice(0, 2), ['w:shatter', 'up:7']);
assert.deepEqual(ids(search('应用')), ['up:4'], '升级条目的备注/用法里的中文也能搜到');

// ---- 英文搜索与排序 ----
assert.deepEqual(ids(search('exacerbate')), ['w:exacerbate', 'up:1'], '词本身在前，升级条目紧随');
assert.deepEqual(ids(search('  EXACERBATE ')), ['w:exacerbate', 'up:1'], '大小写、首尾空格不影响');
assert.deepEqual(ids(search('conduct')), ['w:conduct', 'up:3', 'w:conductive', 'w:misconduct'], '完全相同 > 候选完全相同 > 开头 > 包含');
assert.deepEqual(ids(search('worsen')).slice(0, 1), ['up:1'], '日常说法完全相同时升级条目排第一');
assert.deepEqual(ids(search('outset')), ['w:outset', 'w:from the outset'], '短语里的整词排在完全相同之后');

// ---- 词形变化 ----
assert.deepEqual(ids(search('exacerbated')).slice(0, 2), ['w:exacerbate', 'up:1']);
assert.equal(search('exacerbated')[0].reason, '词形变化');
assert.deepEqual(ids(search('shattered')).slice(0, 2), ['w:shatter', 'up:7']);
assert.deepEqual(ids(search('conducting')).slice(0, 2), ['w:conduct', 'up:3']);
assert.deepEqual(ids(search('agendas')).slice(0, 1), ['w:agenda']);
assert.equal(L.sameWordForm('process', 'proces'), false, 'ss 结尾不去 s');
assert.equal(L.sameWordForm('hypothesis', 'hypothesi'), false, 'is 结尾不去 s');
assert.equal(L.sameWordForm('stop', 'stopped'), true, '双写辅音');
assert.equal(L.sameWordForm('study', 'studies'), true);
assert.equal(L.sameWordForm('make', 'making'), true);
assert.equal(L.sameWordForm('from the outset', 'from the outsets'), true, '短语逐词比较');
assert.equal(L.sameWordForm('outset', 'from the outset'), false, '词数不同不算');
assert.equal(L.sameWordForm('is', 'i'), false, '短词不做变化');

// ---- 期号、HTML 文本、无结果 ----
assert.deepEqual(ids(search('9.24')), ['w:shatter', 'w:conduct', 'up:4'], '按期号搜：期号完全相同的词在前（同分按导入顺序），备注里提到期号的升级条目在后');
assert.deepEqual(ids(search('<script>')), ['w:<b>tag</b>'], '含标记的文本按字面匹配');
assert.deepEqual(search('zzz-no-such'), []);

// ---- 筛选 ----
assert.deepEqual(ids(search('', { status: 'learning', sort: 'alpha' })), ['w:agenda', 'w:conduct', 'w:exacerbate', 'w:process']);
assert.deepEqual(ids(search('conduct', { status: 'learning' })), ['w:conduct'], '状态筛选时不显示升级条目');
assert.deepEqual(ids(search('shatter', { verification: '老师确认' })), ['w:shatter'], '任一期满足即可');
assert.deepEqual(search('shatter', { verification: '词典或ACL已查' }), []);
assert.deepEqual(ids(search('', { status: 'cold' })), ['w:misconduct']);

// ---- 空查询排序 ----
assert.deepEqual(ids(search('')).slice(0, 3), ['w:<b>tag</b>', 'w:agenda', 'w:conduct'], '空查询默认 A–Z');
assert.deepEqual(ids(search('', { sort: 'due' })).slice(0, 4), ['w:process', 'w:agenda', 'w:exacerbate', 'w:conduct'], '到期最早在前，同日按 A–Z');
assert.deepEqual(ids(search('', { sort: 'recent' })).slice(0, 4), ['w:misconduct', 'w:conductive', 'w:shatter', 'w:<b>tag</b>'], '最近入库：同日期按导入顺序倒序');
assert.equal(search('', { sort: 'recent' }).length, lib.words.length);
// 有查询时也能改成 A–Z（按词目/日常说法）
assert.deepEqual(ids(search('conduct', { sort: 'alpha' })), ['up:3', 'w:conduct', 'w:conductive', 'w:misconduct']);

// ---- 候选词拆分 ----
const cands = id => lib.upgradeById.get(id).candidates.map(c => [c.name, c.preferred, c.usage, c.examples.length]);
assert.deepEqual(cands('up:1'), [
  ['deteriorate', true, '不及物，自身变坏 her health deteriorated', 1],
  ['exacerbate', false, '及物，使更糟 exacerbate air pollution', 1],
]);
assert.deepEqual(cands('up:2'), [['comprise', true, '不接 of', 1], ['consist of', false, '', 1], ['be composed of', false, '', 1]]);
assert.deepEqual(cands('up:4'), [
  ['put … into practice', true, '', 1],
  ['put … into (practical) application', false, 'put the newly acquired skills into practical application', 1],
]);
assert.deepEqual(cands('up:5'), [
  ['utilize', true, '（英式 utilise）：utilize data / utilize a mixed-methods approach', 1],
  ['employ', false, 'employ a method/technique', 0],
]);
assert.deepEqual(cands('up:6'), [['precise', true, 'precise definition, precise nature', 1]]);
assert.equal(lib.upgradeById.get('up:1').preferred, 'deteriorate');
assert.deepEqual(L.upgradesForWord(lib, 'Exacerbate').map(g => g.item.id), ['up:1']);
assert.equal(L.wordForCandidate(lib, 'shatter').key, 'w:shatter');
assert.equal(L.wordForCandidate(lib, 'crack'), undefined);
// 例句：原有在前，AI 在后
assert.deepEqual(L.realExamplesFirst([{ seq: 1, ai: true }, { seq: 2, ai: false }, { seq: 3, ai: true }]).map(e => e.seq), [2, 1, 3]);

// ---- 备注拆分、状态 ----
assert.deepEqual(L.splitNote('每日加分表达 10-06；加剧（替换 worsen）；2026-10-09 填空对；⚠️拼写 exaccerbates 多 c；'), {
  notes: ['每日加分表达 10-06', '加剧（替换 worsen）'], history: ['2026-10-09 填空对'], warnings: ['⚠️拼写 exaccerbates 多 c'],
});
assert.equal(L.statusGroup('🌱待考察'), 'seed');
assert.equal(L.statusGroup('L3'), 'learning');
assert.equal(L.statusGroup('L5'), 'other');
assert.equal(L.statusGroup('✅已掌握'), 'mastered');
assert.equal(L.statusGroup('🧊冷库'), 'cold');
assert.equal(L.statusText({ status: 'L2', due: '2026-11-11' }), 'L2 · 11-11 到期');
assert.equal(L.statusText({ status: 'L2', due: '—' }), 'L2');
assert.equal(L.statusText({ status: '🌱待考察', due: '—' }), '待考察');

// ---- 按期回看 ----
{
  const issues = L.groupByIssue(lib, '');
  assert.deepEqual(issues.map(g => g.issue), ['10.20', '每日表达10-06', '9.24', '9.18', '9.1', '8.25', 'EAGP-CS1-']);
  const latest = issues[0];
  assert.deepEqual(latest.words.map(w => w.entry.word), ['shatter', 'conductive', 'misconduct']);
  assert.equal(latest.counts.seed, 1);
  assert.equal(latest.counts.mastered, 1);
  assert.equal(latest.counts.cold, 1);
  assert.deepEqual(L.groupByIssue(lib, 'shatter').map(g => g.issue), ['10.20', '9.24'], '查询时只留命中的期');
  assert.deepEqual(L.groupByIssue(lib, '', { status: 'learning' }).map(g => g.issue), ['每日表达10-06', '9.24', '9.18', '8.25']);
  assert.deepEqual(['9.1', '1.5', 'EAGP', '12.31', '8.25', '熟词生义'].sort(L.compareIssues), ['1.5', '12.31', '9.1', '8.25', 'EAGP', '熟词生义'], '1 月算下一年');
}

// ---- 升级对照筛选 ----
assert.deepEqual(L.filterUpgradeGroups(lib, '').map(g => g.item.id), ['up:1', 'up:2', 'up:3', 'up:4', 'up:5', 'up:6', 'up:7']);
assert.deepEqual(L.filterUpgradeGroups(lib, 'composed').map(g => g.item.id), ['up:2']);

// ---- 高亮与摘要 ----
assert.deepEqual(L.highlightParts('Use <u>x</u> and <U>y</U>', '<u>'), [
  { text: 'Use ', hit: false }, { text: '<u>', hit: true }, { text: 'x</u> and ', hit: false }, { text: '<U>', hit: true }, { text: 'y</U>', hit: false },
]);
assert.deepEqual(L.highlightParts('abc', ''), [{ text: 'abc', hit: false }]);
assert.equal(L.snippet('0123456789加剧0123456789', '加剧', 3), '…789加剧012…');

// ---- 不改输入 ----
search('加剧'); search('', { sort: 'due' }); L.groupByIssue(lib, 'x');
assert.equal(JSON.stringify(data), snapshot);

console.log('fixture tests passed');

// ---- 真实原料（只读副本）----
const realUpgrade = 'D:/tmp/es-import/学术升级库-20261109.md';
const realReview = 'D:/tmp/es-import/词汇复习库-20261109.md';
if (existsSync(realUpgrade) && existsSync(realReview)) {
  const u = L.parseUpgradeLibrary(readFileSync(realUpgrade, 'utf8'));
  const r = L.parseReviewLibrary(readFileSync(realReview, 'utf8'));
  const real = {
    upgrades: u.entries.map((e, i) => ({ ...e, ord: i + 1, examples: e.examples.map((x, j) => ({ seq: j + 1, ...x })) })),
    selfChecks: u.selfChecks.map((s, i) => ({ ...s, ord: i + 1 })),
    reviewWords: r.words.map((w, i) => ({ ...w, ord: i + 1, source: '', verificationStatus: '未查证', definitions: [] })),
  };
  const realLib = L.buildLibrary(real);
  let examples = 0;
  for (const group of realLib.upgrades) {
    assert.ok(group.candidates.length >= 1, `${group.item.plain} 至少一个候选`);
    assert.equal(group.candidates.filter(c => c.preferred).length, 1, `${group.item.plain} 恰好一个首选`);
    assert.ok(group.candidates.every(c => c.name.trim() !== '' && !c.name.includes('**')), `${group.item.plain} 候选名干净`);
    const mapped = group.candidates.reduce((n, c) => n + c.examples.length, 0);
    assert.equal(mapped, group.item.examples.filter(e => e.cand.trim()).length, `${group.item.plain} 每条例句都挂到候选上`);
    examples += mapped;
  }
  // 人工抽查用：DUMP_CANDIDATES=文件路径 时把每组的候选拆分写出来。
  if (process.env.DUMP_CANDIDATES) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.DUMP_CANDIDATES, realLib.upgrades.map(g => `${g.item.plain} => ${g.candidates.map(c => `${c.preferred ? '*' : ''}${c.name} [${c.usage}] ex${c.examples.length}`).join(' | ')}`).join('\n'), 'utf8');
  }
  const hits = L.searchLibrary(realLib, '加剧');
  assert.equal(hits[0].id, 'w:exacerbate');
  assert.ok(hits.some(h => h.kind === 'upgrade' && h.upgrade.item.plain === 'worsen'), '真实数据：加剧 能带出 worsen 条目');
  assert.equal(L.searchLibrary(realLib, 'exacerbates')[0].id, 'w:exacerbate');
  const issues = L.groupByIssue(realLib, '');
  assert.equal(issues[0].issue, '10.20', '真实数据最新一期在最前');
  assert.equal(issues.reduce((n, g) => n + g.words.length, 0), real.reviewWords.length, '按期分组不丢词');
  console.log(`real data tests passed: upgrades=${realLib.upgrades.length} examples=${examples} words=${realLib.words.length} reviewRows=${real.reviewWords.length} issues=${issues.length}`);
} else {
  console.log('real data skipped: D:/tmp/es-import 不存在');
}
