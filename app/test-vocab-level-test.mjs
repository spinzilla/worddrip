// 079 词汇量测试：自适应出题、假词校正、估计值、批量记认识的规则、假词表。
// 用法（在 app 目录）：node test-vocab-level-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const bundled = path.resolve('src-tauri/target/vocab-daily-tests', `level-${process.pid}.mjs`);
fs.mkdirSync(path.dirname(bundled), { recursive: true });
await build({ entryPoints: ['utils/vocab/levelTest.ts'], bundle: true, format: 'esm', outfile: bundled, logLevel: 'silent' });
const lt = await import(pathToFileURL(bundled).href);
const fakeBundled = path.resolve('src-tauri/target/vocab-daily-tests', `fake-${process.pid}.mjs`);
await build({ entryPoints: ['utils/vocab/fakeWords.ts'], bundle: true, format: 'esm', outfile: fakeBundled, logLevel: 'silent' });
const { FAKE_WORDS } = await import(pathToFileURL(fakeBundled).href);

// ---- 真实内置词表（和 Rust 的 band / lookup 规则一致） ----
const pack = JSON.parse(zlib.gunzipSync(fs.readFileSync('src-tauri/resources/wordpack/wordpack.json.gz')).toString('utf8'));
const entries = pack.entries;
const exact = new Map(entries.map(e => [e.word.toLowerCase(), e]));
const roots = new Map();
for (const e of entries) {
  const root = (e.exchange.split('/').find(p => p.startsWith('0:'))?.slice(2) || e.word).toLowerCase();
  roots.set(e.word.toLowerCase(), root);
  for (const part of e.exchange.split('/')) {
    const i = part.indexOf(':');
    if (i > 0 && part.slice(i + 1).trim()) roots.set(part.slice(i + 1).trim().toLowerCase(), root);
  }
}
const lookup = word => { const k = word.toLowerCase(); return exact.get(roots.get(k) ?? k) ?? exact.get(k) ?? null; };
const band = async (from, to, n, seed) => {
  const c = entries.filter(e => e.frq !== null && e.frq >= from && e.frq <= to);
  let s = Math.max(1, seed);
  for (let i = c.length - 1; i > 0; i--) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; const j = s % (i + 1); [c[i], c[j]] = [c[j], c[i]]; }
  return c.slice(0, n);
};
const deps = { band };

async function run(seed, decide) {
  let session = lt.createSession(seed);
  for (let i = 0; i < lt.TOTAL; i += 1) {
    const next = await lt.nextQuestion(deps, session);
    session = lt.answer(next.session, next.question, decide(next.question));
  }
  return session.asked;
}

// 1. 假词表
assert.ok(FAKE_WORDS.length >= 60, `假词至少 60 个，现在 ${FAKE_WORDS.length}`);
assert.equal(new Set(FAKE_WORDS).size, FAKE_WORDS.length, '假词不重复');
for (const w of FAKE_WORDS) {
  assert.match(w, /^[a-z]{5,12}$/, `假词要像英语单词：${w}`);
  assert.equal(lookup(w), null, `假词 ${w} 竟然能在内置词表查到`);
}
// 有完整 ECDICT 的机器上再查一遍（本机在 D:\tmp\es-downloads\wordpack；没有就跳过）
const ecdict = 'D:/tmp/es-downloads/wordpack/ecdict.csv';
if (fs.existsSync(ecdict)) {
  const all = new Set();
  for (const line of fs.readFileSync(ecdict, 'utf8').split('\n')) all.add(line.slice(0, line.indexOf(',')).replace(/^"|"$/g, '').toLowerCase());
  for (const w of FAKE_WORDS) assert.ok(!all.has(w), `假词 ${w} 在 ECDICT 里查到了`);
  console.log(`PASS 假词 ${FAKE_WORDS.length} 个，内置词表和 ECDICT（${all.size} 词条）都查不到`);
} else console.log(`PASS 假词 ${FAKE_WORDS.length} 个，内置词表查不到（没有 ECDICT 文件，跳过全量复核）`);

// 2. 出题：假词约 10%、前 2 题没有假词、不重复出词
for (let seed = 1; seed <= 20; seed += 1) {
  const slots = lt.createSession(seed).fakeSlots;
  assert.equal(slots.length, 5, '50 题里 5 个假词');
  assert.ok(slots.every(s => s >= 2 && s < 50));
}
const probe = await run(7, () => true);
assert.equal(probe.length, 50);
assert.equal(new Set(probe.map(a => a.word)).size, 50, '一场测试里同一个词不出两次');
assert.equal(probe.filter(a => a.fake).length, 5);
assert.ok(probe.filter(a => !a.fake).every(a => a.rank !== null && /^[a-z]{3,}$/.test(a.word)));
console.log('PASS 出题：50 题、5 个假词、不重复');

// 3. 真实词汇量 3000 的模拟者
const knows = limit => q => (q.fake ? false : q.entry.frq <= limit);
for (const limit of [800, 3000, 8000]) {
  const results = [];
  for (let seed = 1; seed <= 25; seed += 1) results.push(lt.evaluate(await run(seed * 97, knows(limit))));
  const mean = results.reduce((s, r) => s + r.estimate, 0) / results.length;
  const lo = Math.min(...results.map(r => r.estimate)), hi = Math.max(...results.map(r => r.estimate));
  console.log(`  真实 ${limit}：估计均值 ${Math.round(mean)}，范围 ${lo}–${hi}`);
  assert.ok(results.every(r => !r.discounted && r.fakeKnown === 0));
  if (limit === 3000) assert.ok(lo >= 2000 && hi <= 4500, `3000 的模拟者估计要在 2000–4500：${lo}–${hi}`);
  else assert.ok(Math.abs(mean - limit) < limit * 0.35 + 300, `均值偏离太多：${mean}`);
}
console.log('PASS 真实词汇量 3000 的模拟者估计在 2000–4500');
// 马虎的模拟者：真词 10% 随机点反，假词偶尔点认识——估计不应离谱
{
  const noisy = [];
  for (let seed = 1; seed <= 25; seed += 1) {
    let k = seed * 7919;
    const flip = () => { k = (Math.imul(k, 1103515245) + 12345) >>> 0; return (k >>> 8) % 10 === 0; };
    noisy.push(lt.evaluate(await run(seed * 131, q => (q.fake ? false : (q.entry.frq <= 3000) !== flip()))).estimate);
  }
  const mean = noisy.reduce((x, y) => x + y, 0) / noisy.length;
  console.log(`  带 10% 手滑的 3000 模拟者：均值 ${Math.round(mean)}，范围 ${Math.min(...noisy)}–${Math.max(...noisy)}`);
  assert.ok(mean > 1800 && mean < 5000, `带噪声的估计偏离太多：${mean}`);
}

// 4. 「全点认识」：假词校正打折 + 提示
for (let seed = 1; seed <= 10; seed += 1) {
  const result = lt.evaluate(await run(seed * 31, () => true));
  assert.equal(result.fakeShown, 5);
  assert.equal(result.fakeKnown, 5);
  assert.equal(result.discounted, true);
  assert.ok(result.estimate <= result.raw * 0.2 + 300, `打折不够：${result.raw} → ${result.estimate}`);
  assert.ok(result.raw > 10000, '没打折前估计很高');
}
// 手滑点错 1 个假词不算
const one = [...(await run(11, knows(3000)))];
const firstFake = one.findIndex(a => a.fake);
one[firstFake] = { ...one[firstFake], known: true };
const slipResult = lt.evaluate(one);
assert.equal(slipResult.fakeKnown, 1);
assert.equal(slipResult.discounted, false);
// 全点不认识：估计很低；一个真词都没答：估计 0
assert.ok(lt.evaluate(await run(3, knows(0))).estimate <= 500);
assert.equal(lt.evaluate([]).estimate, 0);
console.log('PASS 全点认识：假词校正后明显打折并给出提示；点错 1 个不打折');

// 5. 一直认识时难度会推进
{
  let s = lt.createSession(3);
  const bands = [];
  for (let i = 0; i < 12; i += 1) {
    const n = await lt.nextQuestion(deps, s);
    if (!n.question.fake) bands.push(n.question.band);
    s = lt.answer(n.session, n.question, true);
  }
  assert.ok(bands[bands.length - 1] > bands[0], '一直认识，题越来越难');
  assert.ok(Math.max(...bands) <= lt.BANDS - 1);
}

// 6. 批量记认识：只写 rank < 估计 × 0.6，其余不动
const e = (word, frq, exchange = '') => ({ word, phonetic: '', pos: '', zh: '', en: '', frq, bnc: null, tags: ['cet4'], exchange });
const pool = [e('alpha', 100), e('bravo', 1700), e('charlie', 1800), e('delta', 1799), e('echo', 500), e('fox', 600), e('golf', null), e('run', 300, 'i:running'), e('hotel', 700)];
const row = (word, state, packName) => ({ wordKey: word, word, state, pack: packName, decidedAt: '2026-11-14', updatedAt: 'x' });
const answers = [{ word: 'echo', rank: 500, fake: false, known: false }, { word: 'qq', rank: null, fake: true, known: true }];
const picked = lt.estimateKnown(pool, 3000, {
  answers, library: new Set(['running']),
  picks: [row('fox', 'later', '四级'), row('hotel', 'known', 'test-estimate')],
});
assert.deepEqual(picked.map(x => x.word), ['alpha', 'bravo', 'delta', 'hotel'], '只要名次 < 1800；点了不认识的、用户自己决定过的、词库里有变形的、没名次的都不写；旧的自动记录可被覆盖');
assert.ok(picked.every(x => x.frq < 3000 * lt.ESTIMATE_RATIO));
assert.deepEqual(lt.knownWords([...answers, { word: 'bravo', rank: 1700, fake: false, known: true }]), ['bravo'], '假词绝不会被记成认识');
assert.equal(lt.SOURCE_TEST, 'test');
assert.equal(lt.SOURCE_ESTIMATE, 'test-estimate');
console.log('PASS 批量记认识：只写名次 < 估计值 × 0.6 的词，不碰用户自己的决定');

// 7. 目标 → 词表、推荐档、说明
assert.deepEqual(lt.packsOfGoals(['cet', 'school', 'cet']), ['cet4', 'cet6', 'zk', 'gk']);
assert.deepEqual(lt.goalsOfPacks(['cet4', 'cet6', 'gre']), ['cet', 'gre']);
assert.deepEqual(lt.goalsOfPacks(['cet4']), []);
assert.deepEqual(lt.GOALS.map(g => g.label), ['四六级', '考研', '雅思', '托福', 'GRE', '学术英语', '日常交流', '中学']);
assert.equal(lt.recommendPerDay(1200, ['cet4']), 5);
assert.equal(lt.recommendPerDay(4000, ['cet4']), 10);
assert.equal(lt.recommendPerDay(7000, ['gre']), 20);
assert.equal(lt.recommendPerDay(0, []), 10);
assert.match(lt.describeLevel(4200), /四级/);
console.log('PASS 目标映射、推荐档、说明文字');
