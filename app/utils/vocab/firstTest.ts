import { statusGroup } from './library';
import type { BrowseReviewWord } from './types';

/**
 * 新词首考（032）：从 🌱待考察 里按期挑词。
 *
 * 纯函数，不碰数据库。只负责「选哪一期、每批取几个、还剩几个」；
 * 出题、判分、笔误申诉、题目出错、同日复检全部复用 030 / 031，不在这里另做一套。
 * 状态怎么变仍由 022 的 vocab_review_submit 决定：首考答对 → ✅已掌握，答错 → L1（两天后到期）。
 */

/** 每批最多几个新词。规范要求新词固定 7 题。 */
export const FIRST_TEST_LIMIT = 7;

/** 下拉框里「全部按期号顺序」的值。期号本身不会叫这个名字。 */
export const ALL_ISSUES = '__all__';

/** 没有期号的词归到这一组，和按期回看（029）一致。 */
export const NO_ISSUE = '（无期号）';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const issueOf = (word: Pick<BrowseReviewWord, 'issue'>) => word.issue.trim() || NO_ISSUE;

/** 是否还没首考的新词（只认 🌱/待考察，不认 L1–L4）。 */
export function isSeedWord(word: Pick<BrowseReviewWord, 'status'>): boolean {
  return statusGroup(word.status) === 'seed';
}

/** 词库里还剩多少个待考察的新词。 */
export function seedCount(words: readonly BrowseReviewWord[]): number {
  return words.filter(isSeedWord).length;
}

/**
 * 期号从早到晚：8 月的期在 9 月之前，10 月的期在次年 1 月之前（按学年算，和 029 的 issueSortKey 一致）。
 * 读不出月日的期号（EAGP 等）排在所有日期之后，按名字排。029 的 compareIssues 是新的在前，这里相反。
 */
export function compareIssuesEarliest(a: string, b: string): number {
  const x = issueSortKeySafe(a);
  const y = issueSortKeySafe(b);
  if (x !== null && y !== null) return x - y || cmp(a, b);
  if (x !== null) return -1;
  if (y !== null) return 1;
  return cmp(a, b);
}

/** 与 029 的 issueSortKey 相同；这里复制一份，避免首考逻辑依赖展示模块的私有实现。 */
function issueSortKeySafe(issue: string): number | null {
  const match = /(\d{1,2})[.\-](\d{1,2})/.exec(issue);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return (month < 8 ? month + 12 : month) * 100 + day;
}

export interface SeedIssue {
  issue: string;
  /** 这一期还剩几个 🌱。 */
  remaining: number;
}

/**
 * 词库里出现过的每一期，按从早到晚排；每期带剩余待考察数量（可能是 0）。
 * 默认选第一个 remaining > 0 的期；全为 0 时再退回第一期。
 */
export function seedIssueOptions(words: readonly BrowseReviewWord[]): SeedIssue[] {
  const counts = new Map<string, number>();
  for (const word of words) {
    const issue = issueOf(word);
    if (!counts.has(issue)) counts.set(issue, 0);
    if (isSeedWord(word)) counts.set(issue, (counts.get(issue) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([issue, remaining]) => ({ issue, remaining }))
    .sort((a, b) => compareIssuesEarliest(a.issue, b.issue));
}

/** 默认期号：最早、且还有 🌱 的那一期；没有新词时返回 ALL_ISSUES。 */
export function defaultIssue(words: readonly BrowseReviewWord[]): string {
  const options = seedIssueOptions(words);
  return options.find(option => option.remaining > 0)?.issue ?? options[0]?.issue ?? ALL_ISSUES;
}

/**
 * 待考察词的出题队列。
 * - 指定期号：只取这一期的 🌱，按期内导入顺序（ord）排。
 * - ALL_ISSUES：按期号从早到晚排，同一期内再按 ord 排（「全部按期号顺序」）。
 * 不修改输入数组。
 */
export function firstTestQueue(words: readonly BrowseReviewWord[], issue: string): BrowseReviewWord[] {
  const seeds = words.filter(isSeedWord);
  const ordered = seeds.slice().sort((a, b) => {
    if (issue === ALL_ISSUES) {
      const byIssue = compareIssuesEarliest(issueOf(a), issueOf(b));
      if (byIssue !== 0) return byIssue;
    }
    return a.ord - b.ord || cmp(a.id, b.id);
  });
  return issue === ALL_ISSUES ? ordered : ordered.filter(word => issueOf(word) === issue);
}

export interface FirstTestBatch {
  /** 本批要出题的新词（最多 7 个，按期内原顺序）。没有可出题数据的会在出题时跳过并计数。 */
  queue: BrowseReviewWord[];
  /** 本批之后这个范围还剩多少个 🌱（不含本批取走的 7 个）。 */
  remaining: number;
  /** 这个范围一共有多少个 🌱。 */
  total: number;
}

/**
 * 取一批新词：最多 FIRST_TEST_LIMIT 个，按期内原顺序。
 * 数据不全的词不在这里剔除——交给 030 的 prepareRecallRound 跳过并计数，和到期复习同一套逻辑。
 */
export function firstTestBatch(
  words: readonly BrowseReviewWord[],
  issue: string,
  limit: number = FIRST_TEST_LIMIT,
): FirstTestBatch {
  if (limit < 1) throw new Error('每批新词至少 1 个');
  const queue = firstTestQueue(words, issue);
  const take = queue.slice(0, limit);
  return { queue: take, remaining: queue.length - take.length, total: queue.length };
}
