// 040 词条笔记：归一化（和 Rust 一致）、分组排序、搜索与「有笔记」筛选，
// 以及「出题、判分、批改的请求里不带笔记」——用本机假 OpenAI 兼容服务抓请求体，不调用真实模型。
// 用法（在 app 目录）：node test-vocab-notes.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundled = path.resolve('src-tauri/target/vocab-recall-tests', `notes-${process.pid}.mjs`);
fs.mkdirSync(path.dirname(bundled), { recursive: true });
await build({
  stdin: {
    contents: [
      "export * from './utils/vocab/notes.ts';",
      "export * from './utils/vocab/library.ts';",
      "export * from './utils/vocab/recall.ts';",
      "export * from './utils/vocab/recallModel.ts';",
      "export * from './utils/vocab/grading.ts';",
      "export * from './utils/vocab/gradingModel.ts';",
      "export * from './utils/vocab/evaluate.ts';",
      "export * from './utils/vocab/due.ts';",
      "export * from './utils/vocab/firstTest.ts';",
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  outfile: bundled,
  logLevel: 'silent',
  define: { 'import.meta.env.DEV': 'false' },
  plugins: [{
    name: 'node-tauri-http',
    setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/plugin-http$/ }, args => ({ path: args.path, namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const fetch = (...args) => globalThis.fetch(...args);' }));
    },
  }],
});
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) };
const m = await import(pathToFileURL(bundled).href);
fs.rmSync(bundled, { force: true });

// ---------------------------------------------------------------- 归一化：和 src-tauri/src/vocab/notes.rs 的 KEY_CASES 同一张表
const rustSource = fs.readFileSync('src-tauri/src/vocab/notes.rs', 'utf8');
const KEY_CASES = [
  ['Resilient', 'resilient'],
  ['  resilient \n', 'resilient'],
  ['In  the Light\tof', 'in the light of'],
  ['**exacerbate**', 'exacerbate'],
  ['students’ work', "students' work"],
  ['It is X that …', 'it is x that …'],
  ['　take part　in ', 'take part in'],
];
for (const [input, expected] of KEY_CASES) assert.equal(m.noteKey(input), expected, JSON.stringify(input));
assert.match(rustSource, /const KEY_CASES: \[\(&str, &str\); 7\]/, 'Rust 端也是 7 条同样的用例');
for (const [, expected] of KEY_CASES) assert.ok(rustSource.includes(`"${expected}"`), `Rust 用例里有 ${expected}`);
// 词库里一个词的键 = w: + 笔记键，两边对得上
assert.equal(m.wordKey(' In the  light OF '), `w:${m.noteKey('in the light of')}`);

// ---------------------------------------------------------------- 分组、排序、增删改
const SECRET = 'MY-PRIVATE-NOTE-用 resilient 造句时想到台风';
let nextId = 0;
const mk = (word, body, createdAt, extra = {}) => ({
  id: ++nextId, wordKey: m.noteKey(word), word, body, source: '词库', createdAt, updatedAt: extra.updatedAt ?? createdAt, ...extra,
});
const notes = [
  mk('Resilient', '旧的一条', '2026-11-09T01:00:00.000Z'),
  mk('resilient', SECRET, '2026-11-10T01:00:00.000Z'),
  mk('in the light of', 'considering 的正式说法\n第二行', '2026-11-08T01:00:00.000Z'),
  mk('deteriorate', '不及物！别写 deteriorate the situation', '2026-11-07T01:00:00.000Z', { source: '闪卡', updatedAt: '2026-11-07T02:00:00.000Z' }),
];
const grouped = m.groupNotes(notes);
assert.deepEqual([...grouped.keys()].sort(), ['deteriorate', 'in the light of', 'resilient']);
assert.deepEqual(grouped.get('resilient').map(note => note.body), [SECRET, '旧的一条'], '同一个词新的在前');
const added = mk('resilient', '新加的', '2026-11-11T01:00:00.000Z');
assert.equal(m.upsertNote(notes, added)[0], added);
const edited = { ...notes[0], body: '改过', updatedAt: '2026-11-12T00:00:00.000Z' };
const afterEdit = m.upsertNote(notes, edited);
assert.equal(afterEdit.length, notes.length);
assert.equal(afterEdit[0].body, '改过');
assert.deepEqual(m.removeNote(notes, notes[1].id).map(note => note.id), [1, 3, 4]);
assert.equal(notes.length, 4, '不改原数组');
assert.equal(m.wasEdited(notes[3]), true);
assert.equal(m.wasEdited(notes[0]), false);
assert.match(m.formatNoteTime('2026-11-10T01:02:00.000Z'), /^2026-11-(09|10) \d{2}:02$/);
assert.equal(m.formatNoteTime('不是时间'), '不是时间');

// ---------------------------------------------------------------- 搜索与筛选
const def = (english, chinese = '', examples = []) => [{ sourceFile: 'a.md', sourceLine: 1, pos: 'adj.', english, chinese, examples }];
let ord = 0;
const rw = (word, issue, extra = {}) => ({
  id: `rv:${word}@${issue}`, ord: ++ord, line: ord, raw: `| ${word} |`, word, issue, addedAt: '2026-11-01', status: 'L1', level: 1,
  due: '2026-11-10', note: extra.note ?? '', source: 'Hermes 词库', verificationStatus: '未查证', definitions: extra.definitions ?? [],
});
const data = {
  reviewWords: [
    rw('resilient', '1', { definitions: def('able to recover quickly from difficulty', '有韧性的', [{ seq: 1, sentence: 'Island economies must become more resilient to cope with storms.', ai: false }]) }),
    rw('Resilient', '2'),
    rw('robust', '1', { definitions: def('strong and healthy', '强健的') }),
    rw('in the light of', '2', { definitions: def('considering something') }),
  ],
  upgrades: [{
    id: 'up:1', ord: 1, line: 1, raw: '| worsen |', plain: 'worsen', source: '', note: '',
    upgrade: '**deteriorate**（不及物）/ exacerbate（及物）', examples: [{ seq: 1, cand: 'deteriorate', sentence: 'Her health deteriorated.', ai: false }],
  }],
  selfChecks: [{ id: 'sc:1', ord: 1, line: 1, raw: '- x', text: '台风 自查' }],
};
const plainLib = m.buildLibrary(data);
assert.equal(plainLib.notesByKey.size, 0, '不传笔记就是没有笔记');
const lib = m.buildLibrary(data, grouped);
assert.equal(lib.words.length, 3, 'resilient 两期合成一个词');
assert.deepEqual(m.notesForWord(lib, 'RESILIENT ').map(note => note.id), [2, 1], '复习库两期共用同一组笔记');
assert.deepEqual(m.notesForWord(lib, 'deteriorate').map(note => note.id), [4], '升级候选词也能取到笔记');
assert.deepEqual(m.notesForWord(lib, 'robust'), []);

// 搜笔记正文：英文、中文都能搜到，原因写「我的笔记」
const chinese = m.searchLibrary(lib, '台风');
assert.equal(chinese[0].id, 'w:resilient');
assert.match(chinese[0].reason, /^我的笔记：/);
assert.ok(chinese.some(hit => hit.kind === 'selfCheck'), '没开筛选时写作自查照常能搜到');
const english = m.searchLibrary(lib, 'considering 的正式说法');
assert.equal(english[0].id, 'w:in the light of');
const upgradeHit = m.searchLibrary(lib, 'deteriorate the situation');
assert.equal(upgradeHit[0].kind, 'upgrade', '升级候选词的笔记也能搜到对应条目');
assert.match(upgradeHit[0].reason, /deteriorate 的笔记/);
assert.deepEqual(m.searchLibrary(plainLib, '台风').map(hit => hit.kind), ['selfCheck'], '没有笔记时搜不到');
assert.deepEqual(m.filterUpgradeGroups(lib, '别写').map(group => group.item.id), ['up:1']);

// 「有笔记的词」筛选
const withNotes = m.searchLibrary(lib, '', { notes: 'has' });
assert.deepEqual(withNotes.map(hit => hit.id).sort(), ['up:1', 'w:in the light of', 'w:resilient'], '空查询：有笔记的复习词 + 候选词有笔记的升级条目');
assert.deepEqual(m.searchLibrary(lib, '', { notes: 'all' }).map(hit => hit.id), ['w:in the light of', 'w:resilient', 'w:robust']);
assert.deepEqual(m.searchLibrary(lib, '台风', { notes: 'has' }).map(hit => hit.kind), ['word'], '筛选时不显示写作自查');
assert.deepEqual(m.searchLibrary(lib, 'strong', { notes: 'has' }), [], 'robust 没笔记，被筛掉');
assert.deepEqual(m.searchLibrary(lib, '', { notes: 'has', status: 'learning' }).map(hit => hit.kind), ['word', 'word'], '和状态筛选叠加时只看复习词');
const issues = m.groupByIssue(lib, '', { notes: 'has' });
assert.deepEqual(issues.map(group => [group.issue, group.words.map(item => item.entry.word)]), [['1', ['resilient']], ['2', ['Resilient', 'in the light of']]]);
assert.deepEqual(m.groupByIssue(lib, '台风').flatMap(group => group.words.map(item => item.entry.id)), ['rv:resilient@1', 'rv:Resilient@2']);

// ---------------------------------------------------------------- 出题、判分、批改的请求里不带笔记
// 1) 静态：会发模型请求的文件、出题/判分逻辑、出题入口，都不读笔记。
//    041 起复习（RecallReview）和闪卡（Flashcards）界面会读笔记给用户看，但只在界面里显示：
//    下面另查它们调用出题/判分函数的地方不带笔记。
const modelFiles = ['utils/ai.ts', 'utils/aiDrills.ts', 'utils/breakdownPrep.ts', 'utils/coach/reviewClient.ts', 'utils/jaSegments.ts',
  'utils/keywordPrep.ts', 'utils/levelPrep.ts', 'utils/modelHttp.ts', 'utils/phrasePrep.ts', 'utils/resegment.ts',
  'utils/vocab/gradingModel.ts', 'utils/vocab/inbox.ts', 'utils/vocab/recallModel.ts', 'utils/vocab/recall.ts', 'utils/vocab/grading.ts',
  'utils/vocab/evaluate.ts', 'utils/vocab/due.ts', 'utils/vocab/firstTest.ts', 'utils/vocab/flashcards.ts',
  'components/vocab/DuePanel.tsx', 'components/vocab/FirstTestPanel.tsx'];
for (const file of modelFiles) {
  const source = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /listNotes|vocab_notes|notesByKey|notesForWord|VocabNote|utils\/vocab\/notes|NotesSection/, `${file} 不该读笔记`);
}
{
  const review = fs.readFileSync('components/vocab/RecallReview.tsx', 'utf8');
  const calls = [...review.matchAll(/(?:evaluateAnswer|makeRecheck|forgotEvaluation|submitRequest)\(([^)]*)\)/g)];
  assert.ok(calls.length >= 5, '找到复习界面里的判分/复检调用');
  for (const [call, args] of calls) assert.doesNotMatch(args, /note/i, `判分/复检调用不该带笔记：${call}`);
  // 作答中：笔记面板是 blind（不传旧笔记），按钮文字是「记一笔」，不显示条数。
  assert.match(review, /const wordNotes = writing \? \[\] :/);
  assert.match(review, /blind=\{writing\}/);
  assert.match(review, /writing \? '记一笔' : `笔记（\$\{wordNotes\.length\}）`/);
  const flash = fs.readFileSync('components/vocab/Flashcards.tsx', 'utf8');
  assert.doesNotMatch(flash, /recallModel|gradingModel|evaluate/, '闪卡不发模型请求');
}
// 浏览数据（复习、首考、闪卡都靠它）里没有笔记：Rust 的 browse 查询不碰笔记表，前端类型也没有笔记字段。
assert.doesNotMatch(fs.readFileSync('src-tauri/src/vocab/query.rs', 'utf8'), /vocab_note/);
const browseType = /export interface BrowseReviewWord \{[\s\S]*?\n\}/.exec(fs.readFileSync('utils/vocab/types.ts', 'utf8'))[0];
assert.doesNotMatch(browseType, /VocabNote/);

// 2) 网络请求：给词硬塞上笔记字段，真实出题/判分代码发出的请求体里也不能出现笔记正文。
const requests = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  requests.push(raw);
  res.setHeader('Content-Type', 'application/json');
  const prompt = JSON.parse(raw).messages[0].content;
  let content = '[]';
  if (/usedTarget/.test(prompt)) {
    content = JSON.stringify({ usedTarget: true, grammarOk: true, verdict: 'correct', reason: '用法正确。', targetForm: 'in the light of', grammarFix: '', academicUpgrade: '' });
  }
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
storage.set('linguaclip_ai_config', JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'dummy-key', model: 'fake', temperature: 0.7 }));
try {
  assert.equal(m.hasQuestionModel(), true);
  const leaky = data.reviewWords.map(word => ({ ...word, notes: m.notesForWord(lib, word.word), myNotes: SECRET }));
  const queue = m.dueQueue(leaky, '2026-11-10');
  assert.ok(queue.length >= 3);
  const options = { generate: requests => m.requestModelQuestions(requests), generateUsage: requests => m.requestUsageTasks(requests), mix: true };
  const round = await m.prepareRecallRound(queue, options);
  assert.ok(round.questions.length > 0);
  const seeds = leaky.map(word => ({ ...word, status: '🌱待考察', level: null }));
  const firstRound = await m.prepareRecallRound(m.firstTestQueue(seeds, m.ALL_ISSUES), { ...options, noun: '新词' });
  assert.ok(firstRound.questions.length > 0);
  const question = { ...m.definitionQuestion(leaky[3], 'x'), selfCheck: true, notes: SECRET };
  await m.gradeWithModel(question, 'In the light of the storms, the island became resilient.');
  await m.evaluateAnswer(question, 'In the light of new data, we changed plans.', { modelOn: true, grader: (q, written) => m.gradeWithModel(q, written) });
  assert.ok(requests.length >= 3, `至少发了出题和判分请求（实际 ${requests.length} 个）`);
  for (const body of requests) {
    assert.equal(body.includes(SECRET), false, '请求体里出现了笔记正文');
    assert.equal(body.includes('台风'), false);
    assert.equal(body.includes('considering 的正式说法'), false);
    assert.equal(body.includes('deteriorate the situation'), false);
  }
} finally {
  server.close();
}

console.log(`test-vocab-notes：全部通过（抓到 ${requests.length} 个模型请求，均不含笔记）`);
