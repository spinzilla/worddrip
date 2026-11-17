// 079 词汇量测试：按词频分段自适应出题，混进假词校正，估出一个词汇量。纯函数，不碰界面和数据库。
// （内置词表接口见 utils/wordpack.ts 的 wordpackBand；写候选池见 utils/vocab/api.ts 的 pickSet / pickClearKnown。）
import type { WordpackEntry } from '../wordpack';
import { FAKE_WORDS } from './fakeWords';
import { formKeys, wordKey, type PickRow } from './dailyWords';

/** 总题数（真词 + 假词）。 */
export const TOTAL = 50;
/** 每段多少个词频名次（rank 1–1000 是第 0 段）。 */
export const BAND_SIZE = 1000;
/** 一共多少段：覆盖到词频 25000 名。 */
export const BANDS = 25;
/** 从中间偏易的一段开始（第 4 段 = 4001–5000 名）。 */
export const START_BAND = 4;
/** 约 10% 假词：每 10 题里随机一题是假词。 */
export const FAKE_EVERY = 10;
/** 候选池里「测试里点了认识的真词」的来源标记。 */
export const SOURCE_TEST = 'test';
/** 候选池里「按估计值批量记认识」的来源标记；重测只清这一批。 */
export const SOURCE_ESTIMATE = 'test-estimate';
/** 比估计值 × 0.6 还常见的词，批量记为认识。 */
export const ESTIMATE_RATIO = 0.6;
/** 点了认识的假词至少这么多个，才按比例打折（偶尔手滑一个不算）。 */
export const FAKE_PENALTY_FROM = 2;

export interface Answer {
  word: string;
  /** 词频名次；假词没有 */
  rank: number | null;
  fake: boolean;
  known: boolean;
}

export type Question = { fake: true; word: string } | { fake: false; word: string; entry: WordpackEntry; band: number };

export interface Session {
  asked: Answer[];
  band: number;
  step: number;
  /** 上一次往哪个方向走：1 往难、-1 往易、0 还没走 */
  dir: 1 | -1 | 0;
  /** 第几题（从 0 数）是假词 */
  fakeSlots: number[];
  rng: number;
}

export interface TestDeps {
  /** wordpackBand(rankFrom, rankTo, n, seed) */
  band: (rankFrom: number, rankTo: number, n: number, seed: number) => Promise<WordpackEntry[]>;
}

/** 小随机数发生器（mulberry32），传同一个种子出同一串数，测试能复现。 */
function rand(state: number): { value: number; state: number } {
  let t = (state + 0x6d2b79f5) >>> 0;
  const next = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: next };
}

export function createSession(seed: number = Date.now() >>> 0, total = TOTAL): Session {
  let state = seed >>> 0;
  const fakeSlots: number[] = [];
  for (let start = 0; start < total; start += FAKE_EVERY) {
    const r = rand(state);
    state = r.state;
    // 前 2 题不放假词，免得一上来就懵
    const from = Math.max(start, 2);
    const to = Math.min(start + FAKE_EVERY, total);
    if (to > from) fakeSlots.push(from + Math.floor(r.value * (to - from)));
  }
  return { asked: [], band: START_BAND, step: 3, dir: 0, fakeSlots, rng: state };
}

/** 测试里能出的真词：单个小写字母词，不要带连字符 / 空格 / 缩写。 */
const plainWord = (entry: WordpackEntry) => /^[a-z]{3,}$/.test(entry.word) && entry.frq !== null;

const bandRange = (band: number): [number, number] => [band * BAND_SIZE + 1, (band + 1) * BAND_SIZE];

/** 下一题。假词位置由 fakeSlots 决定；真词从当前段抽一个没问过的（这一段抽空了就找邻近的段）。 */
export async function nextQuestion(deps: TestDeps, session: Session): Promise<{ question: Question; session: Session }> {
  const index = session.asked.length;
  const askedWords = new Set(session.asked.map(a => a.word));
  let rng = session.rng;
  if (session.fakeSlots.includes(index)) {
    const pool = FAKE_WORDS.filter(word => !askedWords.has(word));
    const r = rand(rng);
    rng = r.state;
    const word = pool[Math.floor(r.value * pool.length)] ?? FAKE_WORDS[0];
    return { question: { fake: true, word }, session: { ...session, rng } };
  }
  for (let offset = 0; offset < BANDS; offset += 1) {
    for (const band of offset === 0 ? [session.band] : [session.band - offset, session.band + offset]) {
      if (band < 0 || band >= BANDS) continue;
      const r = rand(rng);
      rng = r.state;
      const [from, to] = bandRange(band);
      const entries = await deps.band(from, to, 12, Math.floor(r.value * 2147483646) + 1);
      const entry = entries.find(e => plainWord(e) && !askedWords.has(e.word));
      if (entry) return { question: { fake: false, word: entry.word, entry, band }, session: { ...session, rng } };
    }
  }
  throw new Error('词表里找不到可出的题');
}

/** 记一次回答并调整难度：认识往难的段走，不认识往易的段走；方向一变步子缩小（3 → 2 → 1 段）。假词只记数，不动难度。 */
export function answer(session: Session, question: Question, known: boolean): Session {
  const record: Answer = { word: question.word, rank: 'entry' in question ? question.entry.frq : null, fake: question.fake, known };
  const asked = [...session.asked, record];
  if (question.fake) return { ...session, asked };
  const dir: 1 | -1 = known ? 1 : -1;
  const step = session.dir !== 0 && session.dir !== dir ? Math.max(1, session.step - 1) : session.step;
  const band = Math.min(BANDS - 1, Math.max(0, session.band + dir * step));
  return { ...session, asked, band, step, dir };
}

// ---------- 估计 ----------

export interface LevelResult {
  /** 没打折前的估计 */
  raw: number;
  /** 最终估计（按 100 取整） */
  estimate: number;
  realAnswered: number;
  fakeShown: number;
  fakeKnown: number;
  /** 假词点了认识偏多，已打折 */
  discounted: boolean;
}

/**
 * 拟合一个「认识的分界名次」：认识的词都排在它前面、不认识的都排在它后面——
 * 在所有可能的分界里选「和回答矛盾最少」的；有一串分界同样好，就取这一串的中点。
 */
export function fitThreshold(answers: readonly Pick<Answer, 'rank' | 'known'>[]): number {
  const items = answers.filter((a): a is { rank: number; known: boolean } => a.rank !== null).sort((a, b) => a.rank - b.rank);
  if (items.length === 0) return 0;
  const unknownTotal = items.filter(a => !a.known).length;
  // 区间 j：分界落在第 j 个词和第 j+1 个词之间（j = 0 在所有词前面，j = n 在所有词后面）
  let best = -1;
  let first = 0;
  let last = 0;
  let known = 0;
  let unknown = 0;
  for (let j = 0; j <= items.length; j += 1) {
    if (j > 0) { if (items[j - 1].known) known += 1; else unknown += 1; }
    const score = known + (unknownTotal - unknown);
    const lo = j === 0 ? 0 : items[j - 1].rank;
    const hi = j === items.length ? items[j - 1].rank + BAND_SIZE : items[j].rank;
    if (score > best) { best = score; first = lo; last = hi; } else if (score === best) { last = hi; }
  }
  return Math.round((first + last) / 2);
}

export function evaluate(answers: readonly Answer[]): LevelResult {
  const real = answers.filter(a => !a.fake);
  const fakes = answers.filter(a => a.fake);
  const fakeKnown = fakes.filter(a => a.known).length;
  const raw = real.length === 0 ? 0 : fitThreshold(real);
  const discounted = fakeKnown >= FAKE_PENALTY_FROM;
  const rate = fakes.length === 0 ? 0 : fakeKnown / fakes.length;
  const corrected = discounted ? raw * (1 - rate) : raw;
  const estimate = real.length === 0 ? 0 : Math.max(300, Math.round(corrected / 100) * 100);
  return { raw: Math.round(raw / 100) * 100, estimate, realAnswered: real.length, fakeShown: fakes.length, fakeKnown, discounted };
}

// ---------- 写候选池 ----------

/** 测试里点了认识的真词。 */
export const knownWords = (answers: readonly Answer[]): string[] => answers.filter(a => !a.fake && a.known).map(a => a.word);

/**
 * 按估计值批量「认识」的词：词频名次 < 估计值 × 0.6。
 * 跳过：测试里点了「不认识」的、词库里已有的（含变形）、候选池里已有用户自己决定的（旧的自动记录不算，重测时会先清掉）。
 */
export function estimateKnown(
  entries: readonly WordpackEntry[], estimate: number,
  ctx: { answers: readonly Answer[]; picks: readonly PickRow[]; library: ReadonlySet<string> },
): WordpackEntry[] {
  const limit = estimate * ESTIMATE_RATIO;
  const unknown = new Set(ctx.answers.filter(a => !a.fake && !a.known).map(a => wordKey(a.word)));
  const decided = new Set(ctx.picks.filter(p => !(p.state === 'known' && p.pack === SOURCE_ESTIMATE)).map(p => p.wordKey));
  return entries.filter(entry => {
    if (entry.frq === null || entry.frq >= limit) return false;
    const key = wordKey(entry.word);
    if (unknown.has(key) || decided.has(key)) return false;
    return !formKeys(entry).some(form => ctx.library.has(form));
  });
}

// ---------- 说明文字 ----------

/** 估计词汇量的大白话说明。 */
export function describeLevel(estimate: number): string {
  if (estimate < 1500) return '你认识的主要是最常用的基础词。先把日常高频词学扎实，进步会很快。';
  if (estimate < 3500) return '大约是初中到高中水平：日常常见词基本认识，书面一点的词还要补。';
  if (estimate < 6000) return '大约是四级前后的水平：常见词认识不少，每天加一点新词就能稳步上升。';
  if (estimate < 9000) return '大约是六级、考研的水平：常用词基础不错，重点补不太常见的词。';
  return '词汇量已经不小，接下来主要是补雅思、托福、GRE 这类较难的词。';
}

/** 每天几个新词的推荐档（5 / 10 / 20）。 */
export function recommendPerDay(estimate: number, packs: readonly string[]): 5 | 10 | 20 {
  if (estimate > 0 && estimate < 2000) return 5;
  const hard = packs.some(tag => tag === 'gre' || tag === 'toefl' || tag === 'ielts' || tag === 'ky');
  if (estimate >= 6000 && hard) return 20;
  return 10;
}

// ---------- 目标 ----------

export interface Goal { id: string; label: string; hint: string; packs: string[] }

/** 第一步能选的目标，对应的词表标签见 dailyWords.ts 的 PACKS。 */
export const GOALS: readonly Goal[] = [
  { id: 'cet', label: '四六级', hint: '大学英语四级、六级', packs: ['cet4', 'cet6'] },
  { id: 'ky', label: '考研', hint: '考研英语', packs: ['ky'] },
  { id: 'ielts', label: '雅思', hint: '', packs: ['ielts'] },
  { id: 'toefl', label: '托福', hint: '', packs: ['toefl'] },
  { id: 'gre', label: 'GRE', hint: '', packs: ['gre'] },
  { id: 'nawl', label: '学术英语', hint: 'NAWL 学术词', packs: ['nawl'] },
  { id: 'ngsl', label: '日常交流', hint: 'NGSL 核心词', packs: ['ngsl'] },
  { id: 'school', label: '中学', hint: '中考、高考', packs: ['zk', 'gk'] },
];

/** 选中的目标 → 词表标签（按选的顺序，去重）。 */
export function packsOfGoals(goalIds: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of goalIds) for (const tag of GOALS.find(g => g.id === id)?.packs ?? []) if (!out.includes(tag)) out.push(tag);
  return out;
}

/** 当前学习计划里的词表 → 反推已选的目标（目标的词表全在计划里才算选中）。 */
export function goalsOfPacks(packs: readonly string[]): string[] {
  return GOALS.filter(g => g.packs.every(tag => packs.includes(tag))).map(g => g.id);
}
