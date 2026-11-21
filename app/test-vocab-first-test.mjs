// 032 新词首考：选期、每批 7 个、跳过计数、剩余数量（纯函数 + 复用 030 出题）。
// 用法（在 app 目录）：node test-vocab-first-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundled = path.resolve('src-tauri/target/vocab-recall-tests', `first-test-${process.pid}.mjs`);
fs.mkdirSync(path.dirname(bundled), { recursive: true });
await build({
  stdin: {
    contents: [
      "export * from './utils/vocab/firstTest.ts';",
      "export * from './utils/vocab/recall.ts';",
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  outfile: bundled,
  logLevel: 'silent',
});
const f = await import(pathToFileURL(bundled).href);
fs.rmSync(bundled, { force: true });

const definition = (english, sentence) => ({
  sourceFile: '20261020.md', sourceLine: 1, pos: 'v.', english, chinese: '',
  examples: sentence ? [{ seq: 1, sentence, ai: false }] : [],
});
const word = (id, text, issue, status = '🌱待考察', ord = 1, definitions = [definition(`meaning of ${text}`, `This sentence uses ${text} exactly once.`)]) => ({
  id, ord, line: ord + 4, raw: `| ${text} | ${issue} |`, word: text, issue,
  addedAt: '2026-10-01', status, level: /^L([1-7])$/.exec(status) ? Number(/^L([1-7])$/.exec(status)[1]) : null,
  due: '', note: '', source: '测试', verificationStatus: '未查证', definitions,
});
const ids = list => list.map(item => item.id);

// ---- 词库：三期新词 + 无期号 + 不该算进来的 L2/已掌握 ----
const words = [
  word('a@8.25', 'alpha', '8.25', '🌱待考察', 1),
  word('b@8.25', 'bravo', '8.25', '🌱待考察', 2),
  word('c@8.25', 'charlie', '8.25', '🌱待考察', 3),
  word('d@8.25', 'delta', '8.25', '🌱待考察', 4),
  word('e@8.25', 'echo', '8.25', '🌱待考察', 5),
  word('f@8.25', 'foxtrot', '8.25', '🌱待考察', 6),
  word('g@8.25', 'golf', '8.25', '🌱待考察', 7),
  word('h@8.25', 'hotel', '8.25', '🌱待考察', 8),
  word('i@8.25', 'india', '8.25', '待考察', 9),
  word('learning@8.25', 'juliet', '8.25', 'L2', 10),
  word('mastered@8.25', 'kilo', '8.25', '✅已掌握', 11),
  word('j@9.24', 'lima', '9.24', '🌱待考察', 12),
  word('k@9.24', 'mike', '9.24', '🌱待考察', 13),
  word('l@10.20', 'november', '10.20', '🌱待考察', 14, []),
  word('m@EAGP-CS1-', 'oscar', 'EAGP-CS1-', '🌱待考察', 15),
  word('n@', 'papa', '', '🌱待考察', 16),
];
const snapshot = JSON.stringify(words);

// ---- 剩余数量 ----
assert.equal(f.seedCount(words), 14, '只算 🌱待考察 / 待考察，L2 和已掌握不算');
assert.equal(f.isSeedWord(words[0]), true);
assert.equal(f.isSeedWord(words[9]), false);
assert.equal(f.isSeedWord(words[10]), false);

// ---- 期号从早到晚；读不出月日的排在日期之后 ----
assert.deepEqual(f.seedIssueOptions(words).map(option => option.issue), ['8.25', '9.24', '10.20', 'EAGP-CS1-', '（无期号）']);
assert.deepEqual(f.seedIssueOptions(words).map(option => option.remaining), [9, 2, 1, 1, 1]);
assert.ok(f.compareIssuesEarliest('8.25', '9.24') < 0);
assert.ok(f.compareIssuesEarliest('10.20', '1.3') < 0, '10 月在同一学年里早于次年 1 月');
assert.equal(f.compareIssuesEarliest('8.25', 'EAGP-CS1-'), -1, '日期期号排在没有月日的期号前面');
assert.equal(f.defaultIssue(words), '8.25', '默认最早的一期');

// ---- 按期选取：只取这一期的新词，按期内 ord ----
assert.deepEqual(ids(f.firstTestQueue(words, '8.25')), [
  'a@8.25', 'b@8.25', 'c@8.25', 'd@8.25', 'e@8.25', 'f@8.25', 'g@8.25', 'h@8.25', 'i@8.25',
]);
assert.deepEqual(ids(f.firstTestQueue(words, '9.24')), ['j@9.24', 'k@9.24']);
assert.deepEqual(f.firstTestQueue(words, '没有这一期'), []);

// ---- 全部按期号顺序：8.25 → 9.24 → 10.20 → EAGP → 无期号，同一期内按 ord ----
assert.deepEqual(ids(f.firstTestQueue(words, f.ALL_ISSUES)), [
  'a@8.25', 'b@8.25', 'c@8.25', 'd@8.25', 'e@8.25', 'f@8.25', 'g@8.25', 'h@8.25', 'i@8.25',
  'j@9.24', 'k@9.24', 'l@10.20', 'm@EAGP-CS1-', 'n@',
]);

// ---- 每批 7 个，剩余数量是「这一批之后还剩几个 🌱」 ----
const batch = f.firstTestBatch(words, '8.25');
assert.equal(f.FIRST_TEST_LIMIT, 7);
assert.deepEqual(ids(batch.queue), ['a@8.25', 'b@8.25', 'c@8.25', 'd@8.25', 'e@8.25', 'f@8.25', 'g@8.25']);
assert.equal(batch.total, 9);
assert.equal(batch.remaining, 2);
const allBatch = f.firstTestBatch(words, f.ALL_ISSUES);
assert.equal(allBatch.queue.length, 7);
assert.equal(allBatch.total, 14);
assert.equal(allBatch.remaining, 7);
assert.deepEqual(ids(f.firstTestBatch(words, '9.24').queue), ['j@9.24', 'k@9.24'], '不满 7 个就全取');
assert.equal(f.firstTestBatch(words, '9.24').remaining, 0);
assert.throws(() => f.firstTestBatch(words, '8.25', 0), /至少 1 个/);

// ---- 复用 030 出题：7 个词 → 7 题，顺序不变 ----
const round = await f.prepareRecallRound(batch.queue, { generate: null, limit: f.FIRST_TEST_LIMIT, noun: '新词' });
assert.equal(round.questions.length, 7);
assert.deepEqual(round.questions.map(question => question.wordId), ids(batch.queue));
assert.equal(round.skipped.length, 0);
assert.equal(round.remaining, 0, '这一批只传 7 个，队列已看完');
assert.equal(round.notices.some(text => /到期词/.test(text)), false, '首考提示不叫「到期词」');

// ---- 没有可出题数据的词：跳过并计数，不占题位（本批取 7 个，出 6 题） ----
const withGap = [
  word('gap@11.1', 'gapword', '11.1', '🌱待考察', 1, []),
  ...Array.from({ length: 7 }, (_, index) => word(`ok${index}@11.1`, `okword${index}`, '11.1', '🌱待考察', index + 2)),
];
const gapBatch = f.firstTestBatch(withGap, '11.1');
assert.equal(gapBatch.queue.length, 7);
assert.equal(gapBatch.total, 8);
assert.equal(gapBatch.remaining, 1);
const gapRound = await f.prepareRecallRound(gapBatch.queue, { generate: null, limit: f.FIRST_TEST_LIMIT, noun: '新词' });
assert.equal(gapRound.questions.length, 6, '缺数据的跳过，不硬凑第 7 题');
assert.deepEqual(gapRound.skipped.map(entry => entry.wordId), ['gap@11.1']);
assert.ok(gapRound.notices.some(text => /1 个新词缺数据没出题/.test(text)));

// 不传 noun 时仍是原来的「到期词」说法，030 不受影响。
const reviewRound = await f.prepareRecallRound([withGap[0]], { generate: null, limit: 1 });
assert.ok(reviewRound.notices.some(text => /1 个到期词缺数据没出题/.test(text)));

// ---- 不改输入，空库也能算 ----
assert.equal(JSON.stringify(words), snapshot, '选词函数不能修改传入的词库');
assert.equal(f.seedCount([]), 0);
assert.deepEqual(f.seedIssueOptions([]), []);
assert.equal(f.defaultIssue([]), f.ALL_ISSUES);
assert.deepEqual(f.firstTestBatch([], f.ALL_ISSUES), { queue: [], remaining: 0, total: 0 });

console.log('新词首考测试通过：按期选取、每批 7 个、跳过计数、剩余数量、全部按期号顺序。');
