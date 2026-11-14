import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const out = join(tmpdir(), `vocab-listening-merge-${process.pid}.mjs`);
await build({ entryPoints: ['utils/vocab/listeningMerge.ts'], bundle: true, format: 'esm', outfile: out });
const m = await import(pathToFileURL(out).href);

const group = (word, status) => ({ key: `w:${word.toLowerCase()}`, word, latest: { status }, entries: [{ status }], definitions: [], gloss: '', pos: [] });
const card = (id, word, due, text = `Original sentence for ${word}`) => ({
  id, deck: 'word', word, text, definition: `<b>${word}</b> 的听力释义`, example: '', fsrs: { due, reps: id.length }, clip: { file: `${id}.mp4` },
});
const words = [group('shared', 'L2'), group('library-only', 'L1'), group('third', '🌱待考察')];
const cards = [card('due-card', '  ShArEd  ', 10), card('later-card', 'listening-only', 999), card('second-card', 'Another', 500)];

const merged = m.mergeListeningWords(words, cards);
assert.equal(merged.length, 5, '三个词库词 + 三个听力词，其中一个重合，应为五条');
const shared = merged.find(item => item.key === 'w:shared');
assert.equal(shared.word, 'shared');
assert.equal(shared.vocab.latest.status, 'L2', '词库进度对象保留');
assert.equal(shared.listeningCards[0].id, 'due-card', '听力卡对象保留');
assert.equal(shared.listeningCards[0].fsrs.due, 10, '听力进度不被词库覆盖');
assert.equal(shared.listeningCards[0].clip.file, 'due-card.mp4', '原声片段信息保留');
assert.equal(merged.filter(item => item.word === 'shared').length, 1, '大小写和首尾空白归一化后只出现一条');
assert.deepEqual(m.listeningCounts(merged), { all: 5, listening: 3, vocab: 2 });
assert.deepEqual(m.filterListeningWords(merged, 'listening').map(item => item.key).sort(), ['w:another', 'w:listening-only', 'w:shared']);
assert.deepEqual(m.filterListeningWords(merged, 'vocab').map(item => item.key).sort(), ['w:library-only', 'w:third']);
assert.equal(m.filterListeningWords(merged, 'all').length, 5);

const listeningOnly = merged.find(item => item.key === 'w:listening-only');
assert.equal(m.listeningWordMatches(listeningOnly, '  LISTENING-ONLY '), true);
assert.equal(m.listeningWordMatches(listeningOnly, 'original sentence'), true);
assert.equal(m.listeningWordMatches(listeningOnly, '听力释义'), true);
assert.equal(m.listeningWordMatches(listeningOnly, 'not-found'), false);

const before = JSON.stringify({ words, cards });
m.mergeListeningWords(words, cards);
assert.equal(JSON.stringify({ words, cards }), before, '合并不修改输入');
assert.equal(m.mergeListeningWords([], [{ ...cards[0], deck: 'line' }]).length, 0, '听力句子卡不混入单词列表');
assert.equal(m.mergeListeningWords([], [{ ...cards[0], word: '   ' }]).length, 0, '空词头不占一行');

console.log('vocab listening merge tests passed');
