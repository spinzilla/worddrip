// 042 手动加词：默认值、查重键、查词结果预填、表单校验；再静态检查界面不显示彩色表情、作答中不给「加入词库」。
// 用法（在 app 目录）：node test-vocab-manual-add.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundled = path.resolve('src-tauri/target/vocab-manual-tests', `manual-${process.pid}.mjs`);
fs.mkdirSync(path.dirname(bundled), { recursive: true });
await build({ entryPoints: ['utils/vocab/manualAdd.ts'], bundle: true, format: 'esm', outfile: bundled, logLevel: 'silent' });
const m = await import(pathToFileURL(bundled).href);

// ---- 默认值：期号月.日不补零，日期 YYYY-MM-DD，来源「手动添加」 ----
const day = new Date(2026, 10, 10, 9, 30);
assert.equal(m.todayIssue(day), '11.10');
assert.equal(m.todayIssue(new Date(2026, 7, 5)), '8.5');
assert.equal(m.todayDate(new Date(2026, 7, 5)), '2026-08-05');
const blank = m.emptyForm({}, day);
assert.deepEqual(blank, { word: '', pos: '', chinese: '', english: '', example: '', note: '', source: '手动添加', issue: '11.10' });
assert.equal(m.emptyForm({ word: 'candid', source: '精听', example: undefined }, day).source, '精听');

// ---- 查重：忽略大小写、首尾和中间多余空白 ----
const words = [{ word: 'Take into account', id: 'a' }, { word: 'candid', id: 'b' }, { word: 'candid ', id: 'c' }];
assert.deepEqual(m.findExisting(words, '  take   INTO account ').map(w => w.id), ['a']);
assert.deepEqual(m.findExisting(words, 'CANDID').map(w => w.id), ['b', 'c']);
assert.deepEqual(m.findExisting(words, 'candidly'), []);
assert.deepEqual(m.findExisting(words, '   '), []);

// ---- 校验 ----
assert.equal(m.validateForm(blank), '请填写词或短语。');
assert.equal(m.validateForm({ ...blank, word: 'a|b' }), '词或短语里不能有竖线「|」。');
assert.match(m.validateForm({ ...blank, word: 'ok', issue: ' ' }), /期号/);
assert.match(m.validateForm({ ...blank, word: 'ok', note: 'a | b' }), /备注/);
assert.equal(m.validateForm({ ...blank, word: 'ok' }), '');

// ---- 请求：短语整段保留、空来源退回默认 ----
const req = m.toRequest({ ...blank, word: '  take   into account ', source: ' ', english: ' to consider ' }, false, day);
assert.deepEqual(req, {
  word: 'take into account', pos: '', chinese: '', english: 'to consider', example: '', source: '手动添加',
  issue: '11.10', date: '2026-11-10', note: '', allowDuplicate: false,
});
assert.equal(m.toRequest({ ...blank, word: 'x' }, true, day).allowDuplicate, true);

// ---- 查词结果预填 ----
const dict = [{
  word: 'shatter', senses: [
    { pos: 'v.', text: ['使粉碎；破灭'], examples: [['The glass shattered.']] },
    { pos: 'n.', text: ['to break suddenly into ', { ruby: 'pieces', rt: 'x' }], examples: [] },
  ],
}];
assert.deepEqual(m.prefillFromLookup({ word: 'shattered', dict, data: null }), {
  word: 'shatter', pos: 'v.', chinese: '使粉碎；破灭', example: 'The glass shattered.',
});
// AI 指出第 2 条义项：用那一条；有所在句子时例句用句子。
assert.deepEqual(m.prefillFromLookup({ word: 'shattered', dict, data: null, pick: { index: 2 } }, ' Hopes  were shattered. '), {
  word: 'shatter', pos: 'n.', english: 'to break suddenly into pieces', example: 'Hopes were shattered.',
});
assert.deepEqual(m.prefillFromLookup({ word: 'resilient', dict: null, data: { word: 'resilient', partOfSpeech: 'adj.', definition: 'able to recover quickly' } }, 'A resilient economy.'), {
  word: 'resilient', pos: 'adj.', english: 'able to recover quickly', example: 'A resilient economy.',
});
assert.deepEqual(m.prefillFromLookup({ word: 'nodata', dict: null, data: null }), { word: 'nodata' });

// 「查词典填写」只填空格子，不覆盖手写内容。
const merged = m.mergeLookup({ ...blank, word: 'x', chinese: '我写的' }, { word: 'y', pos: 'v.', chinese: '词典的', english: 'dict', example: 'ex' });
assert.deepEqual([merged.word, merged.pos, merged.chinese, merged.english, merged.example], ['x', 'v.', '我写的', 'dict', 'ex']);

// 只收英文词和短语。
assert.equal(m.canAddWord('take into account'), true);
assert.equal(m.canAddWord("don't"), true);
assert.equal(m.canAddWord('日本語'), false);
assert.equal(m.canAddWord('niño'), false);
assert.equal(m.canAddWord(''), false);

// ---- 静态检查 ----
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(dir, entry.name)] : []);
for (const file of walk('components')) {
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /[🌱✅🧊]/u, `${file} 里不能再有 🌱 / ✅ / 🧊（界面改用文字标签）`);
}
const recall = fs.readFileSync('components/vocab/RecallReview.tsx', 'utf8');
assert.match(recall, /const addSource = phase === 'write' \|\| lookupTargets\.length > 0 \? undefined/, '复习/首考作答中不能给「加入词库」');
const lookable = fs.readFileSync('components/Lookable.tsx', 'utf8');
assert.match(lookable, /vocab=\{addSource && !guarded \?/, '防泄题（targets 非空）时 Lookable 不给「加入词库」');
for (const [file, source] of [['components/Studio.tsx', '精听'], ['components/WatchPage.tsx', '看剧'], ['components/coach/CoachPage.tsx', '教练'], ['components/vocab/VocabPage.tsx', '词库']]) {
  assert.ok(fs.readFileSync(file, 'utf8').includes(source), `${file} 的查词卡要写来源「${source}」`);
}

fs.rmSync(bundled, { force: true });
console.log('test-vocab-manual-add: 全部通过');
