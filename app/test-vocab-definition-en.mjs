// 078 英英释义：显示优先级、词典结果只取前 1–3 个义项并记来源、查不到/断网不写空记录、
// 一键补全（跳过已有、可取消、取消后已写的保留、报告数字）、在线限速、AI 帮我看看的解析。纯逻辑，不联网。
// 用法（在 app 目录）：node test-vocab-definition-en.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundled = path.resolve('src-tauri/target/vocab-recall-tests', `definition-en-${process.pid}.mjs`);
fs.mkdirSync(path.dirname(bundled), { recursive: true });
await build({
  stdin: {
    contents: [
      "export * from './utils/vocab/definitionEn.ts';",
      "export * from './utils/vocab/definitionJob.ts';",
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
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const d = await import(pathToFileURL(bundled).href);

const row = (id, source, text, pos = null, wordKey = 'resilient') => ({ id, wordKey, word: wordKey, pos, text, source, createdAt: 't', updatedAt: 't' });
const entry = (senses, source = 'cambridgeEn') => ({ word: 'w', phonetic: '', source, senses: senses.map(([pos, text]) => ({ pos, text: [text], examples: [] })) });

// ---- 显示优先级：我写的 > 导入的 > 词典的 ----
{
  const stored = [row(3, 'dict:cambridge', 'dict one'), row(2, 'mine', 'my words'), row(1, 'dict:wiktionary', 'dict two')];
  const imported = [{ pos: 'adj.', english: 'imported text' }, { pos: 'n.', english: '  ' }];
  const view = d.definitionView(stored, imported);
  assert.deepEqual(view.mine.map(x => x.id), [2]);
  assert.deepEqual(view.imported.map(x => x.english), ['imported text'], '空的导入释义不算');
  assert.deepEqual(view.dict.map(x => x.id), [1, 3]);
  assert.equal(view.dictCollapsed, true, '有我写的或导入的时，词典的收起');
  assert.equal(view.empty, false);
  const onlyDict = d.definitionView([row(1, 'dict:cambridge', 'x')], []);
  assert.equal(onlyDict.dictCollapsed, false, '只有词典的：直接展开');
  assert.equal(d.definitionView([], []).empty, true);
  assert.equal(d.hasAnyEnglish([], [{ pos: '', english: '' }]), false);
  assert.equal(d.hasAnyEnglish([], [{ pos: '', english: 'x' }]), true);
  assert.equal(d.hasAnyEnglish([row(1, 'dict:wiktionary', 'x')], []), true);
  const grouped = d.groupDefinitions([row(5, 'dict:cambridge', 'a'), row(4, 'mine', 'b')]);
  assert.deepEqual(grouped.get('resilient').map(x => x.id), [4, 5], '同一个词里我写的排第一');
  assert.equal(d.sourceLabel('mine'), '我写的');
  assert.equal(d.sourceLabel('dict:cambridge'), '来自 剑桥英英');
  assert.equal(d.sourceLabel('dict:wiktionary'), '来自 Wiktionary');
}

// ---- 词典结果只取前 1–3 个义项（带词性），只要英文 ----
{
  const items = d.pickDictItems([entry([['adj.', 'able to recover quickly\n能快速恢复'], ['adj.', 'second'], ['n.', 'third'], ['n.', 'fourth'], ['v.', 'fifth']])]);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], { pos: 'adj.', text: 'able to recover quickly' }, '多行时取英文那行');
  assert.deepEqual(items.map(x => x.text), ['able to recover quickly', 'second', 'third']);
  assert.deepEqual(d.pickDictItems([entry([['n.', '只有中文释义']])]), [], '纯中文的不要');
  assert.deepEqual(d.pickDictItems(null), []);
  assert.equal(d.pickDictItems([entry([['', 'same'], ['', 'SAME']])]).length, 1, '重复的只留一条');
}

// ---- 查词典：记录来源；查不到 / 断网不产生记录 ----
{
  const hit = await d.findDictDefinitions('resilient', async () => ({ entries: [entry([['adj.', 'able to recover']])], source: 'dict:cambridge', online: true }));
  assert.deepEqual(hit, { source: 'dict:cambridge', items: [{ pos: 'adj.', text: 'able to recover' }], online: true });
  assert.equal(await d.findDictDefinitions('zzz', async () => null), null);
  assert.equal(await d.findDictDefinitions('zzz', async () => { throw new Error('offline'); }), null, '断网不抛错');
  assert.equal(await d.findDictDefinitions('zzz', async () => ({ entries: [entry([['n.', '中文']])], source: 'dict:cambridge', online: true })), null, '没有英文义项不写空记录');
}

// ---- 一键补全 ----
const makeDeps = (have = new Set()) => {
  const saved = [];
  const queried = [];
  return {
    saved, queried, have,
    deps: {
      find: async word => {
        queried.push(word);
        if (word.startsWith('bad')) return null;
        return { entries: [entry([['n.', `meaning of ${word}`]])], source: 'dict:wiktionary', online: true };
      },
      hasEnglish: word => have.has(word),
      save: async (word, found) => { saved.push([word, found.source, found.items.length]); have.add(word); },
    },
  };
};
{
  const words = Array.from({ length: 20 }, (_, i) => (i % 5 === 4 ? `bad${i}` : `word${i}`));
  const h = makeDeps(new Set(['word0', 'word1']));
  const job = d.createDefinitionJob(h.deps);
  const seen = [];
  job.subscribe(() => seen.push(job.getState().done));
  await job.start(words);
  const s = job.getState();
  assert.equal(s.running, false);
  assert.equal(s.finished, true);
  assert.equal(s.total, 18, '已有英英释义的 2 个词被跳过');
  assert.equal(s.done, 18);
  assert.equal(s.found, 14);
  assert.equal(s.missing, 4);
  assert.ok(!h.queried.includes('word0') && !h.queried.includes('word1'), '跳过的词不去查词典');
  assert.equal(d.jobReport(s), '补了 14 个，查不到 4 个');
  assert.ok(seen.includes(9), '进度逐步推进');
  assert.ok(h.saved.every(([, source]) => source === 'dict:wiktionary'));
  job.dismiss();
  assert.equal(job.getState().finished, false);
}
{
  // 取消：已写入的保留，剩下的不再查。
  const words = Array.from({ length: 10 }, (_, i) => `w${i}`);
  const h = makeDeps();
  let job;
  h.deps.save = async (word, found) => { h.saved.push([word, found.source, found.items.length]); h.have.add(word); if (h.saved.length === 3) job.cancel(); };
  job = d.createDefinitionJob(h.deps);
  await job.start(words);
  const s = job.getState();
  assert.equal(s.cancelled, true);
  assert.equal(s.finished, true);
  assert.equal(h.saved.length, 3, '取消后已写入的保留');
  assert.ok(h.queried.length <= 4, '取消后不再继续查');
  assert.match(d.jobReport(s), /^已取消，补了 3 个/);
  // 取消后能再开一轮，只补剩下的。
  const again = makeDeps(new Set(h.saved.map(x => x[0])));
  const job2 = d.createDefinitionJob(again.deps);
  await job2.start(words);
  assert.equal(job2.getState().total, 7);
}
{
  // 同时只跑一轮。
  const h = makeDeps();
  const job = d.createDefinitionJob(h.deps);
  const first = job.start(['a', 'b']);
  await job.start(['a', 'b']);
  await first;
  assert.equal(h.saved.length, 2);
}

// ---- 在线限速：两次至少隔 500ms（每秒不超过 2 个） ----
{
  let clock = 0;
  const waits = [];
  const throttle = d.createThrottle(d.ONLINE_MIN_INTERVAL_MS, () => clock, async ms => { waits.push(ms); clock += ms; });
  await Promise.all([throttle(), throttle(), throttle()]);
  assert.equal(clock, 1000, '3 个同时来：第 1 个不等，第 3 个在 1000ms 才放行（间隔 500ms）');
  assert.equal(waits.length, 2);
  assert.equal(d.ONLINE_MIN_INTERVAL_MS, 500);
}

// ---- AI 帮我看看：解析 ----
{
  const ok = d.parseDefinitionCheck('{"good":false,"comment":"太宽泛了","suggestion":"able to recover quickly"}', 'good thing');
  assert.deepEqual(ok, { good: false, comment: '太宽泛了', suggestion: 'able to recover quickly' });
  assert.equal(d.parseDefinitionCheck('```json\n{"good":true,"comment":"没问题","suggestion":""}\n```', 'x').good, true);
  assert.equal(d.parseDefinitionCheck('{"good":true,"comment":"ok","suggestion":"Same  text"}', 'same text').suggestion, '', '建议和原文一样就当没有建议');
  assert.throws(() => d.parseDefinitionCheck('随便说说', 'x'), /格式不正确/);
  assert.throws(() => d.parseDefinitionCheck('{"good":"yes"}', 'x'), /格式不正确/);
  const prompt = d.buildDefinitionCheckPrompt('resilient', 'adj.', 'able to recover');
  assert.ok(prompt.includes('resilient') && prompt.includes('able to recover'));
}
console.log('test-vocab-definition-en: 全部通过');
