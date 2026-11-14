// 034 全应用点词查词公共纯函数：node test-click-lookup.mjs（在 app 目录下）。
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const out = join(tmpdir(), `click-lookup-${process.pid}.mjs`);
await build({ entryPoints: ['utils/clickWords.ts'], bundle: true, format: 'esm', outfile: out, logLevel: 'silent' });
const c = await import(pathToFileURL(out).href);
rmSync(out, { force: true });

// 只点英文词；保留连接符，排除中文、单字母、数字编号和挖空提示。
assert.deepEqual(c.wordAt('A well-known word.', 5), { word: 'well-known', start: 2, end: 12 });
assert.equal(c.wordAt('students books', 3).word, 'students');
assert.equal(c.wordAt('中文 word 中文', 1), null);
assert.equal(c.wordAt('a word', 0), null);
assert.equal(c.wordAt('L2 v3 e_____ ___', 1), null);
assert.equal(c.wordAt('e_____', 1), null);
assert.equal(c.wordAt('word', -1), null);

const original = '中文 Well-known, word2 and it\'s fine!';
const pieces = c.splitEnglish(original);
assert.equal(pieces.map(piece => piece.text).join(''), original);
assert.deepEqual(pieces.filter(piece => piece.word).map(piece => piece.text), ['Well-known', 'and', "it's", 'fine']);
assert.equal(c.splitEnglish('中文 123 ___').some(piece => piece.word), false);

// AI 语境取点中词所在的一句，而不是整篇；超长句会截断。
assert.equal(c.sentenceAround('First sentence. A resilient community adapts well! Third sentence.', 17, 26), 'A resilient community adapts well!');
assert.equal(c.sentenceAround('第一行\nSecond line here\n第三行', 12, 18), 'Second line here');
const long = `start ${'x'.repeat(400)} target ${'y'.repeat(400)}`;
const clipped = c.sentenceAround(long, 407, 413);
assert.ok(clipped.length <= 300);
assert.ok(clipped.includes('target'));

// 作答时：目标词及同族变形不能点，其他词可查，但所有可见内容都遮目标。
assert.equal(c.isBlockedWord('evaluation', ['evaluate']), true);
assert.equal(c.isBlockedWord('community', ['evaluate']), false);
assert.equal(c.scrubText('To evaluate means evaluation; evaluations change.', ['evaluate']), 'To ___ means ___; ___ change.');
assert.equal(c.scrubText('No answer here.', []), 'No answer here.');

const scrub = text => c.scrubText(text, ['evaluate']);
const dirty = {
  word: 'evaluate', context: 'evaluation helps', around: 'evaluate again',
  dict: [{
    word: 'evaluation', phonetic: 'evaluate', reading: 'evaluate', dictName: 'evaluate dictionary', source: 'local',
    note: 'evaluation note',
    senses: [{ pos: 'evaluate', phrase: 'evaluation', text: ['to evaluate', { ruby: 'evaluation', rt: 'evaluate' }], examples: [['evaluations help']] }],
  }],
  data: { word: 'evaluate', partOfSpeech: 'evaluation', definition: 'to evaluate', culture: 'evaluation culture' },
  loading: false, failed: true, error: 'evaluate failed', aiError: 'evaluation failed',
  pick: { index: 1, note: 'evaluation note', culture: 'evaluate culture' },
};
const clean = c.scrubDefinition(dirty, scrub);
const serialized = JSON.stringify(clean);
for (const leak of ['evaluate', 'evaluation', 'evaluations']) assert.equal(serialized.toLowerCase().includes(leak), false, `${leak} 不应留在卡片里`);
assert.equal(clean.dict[0].senses[0].text[1].ruby, '___');
assert.equal(clean.pick.index, 1, '遮文字不能破坏词典义项编号');

console.log('点词查词公共函数：全部通过');
