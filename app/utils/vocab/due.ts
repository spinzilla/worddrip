import type { BrowseReviewWord } from './types';

/**
 * 到期复习的筛选规则（014）。
 *
 * 只认「状态是 L1–L7、level 字段与状态一致、下次到期是合法日期、且不晚于本机今天」的记录。
 * 待考察、已掌握、冷库、空日期（— 或空串）、无效日期一律不进入。
 * 日期一律按「本机自然日」比较：不用 toISOString（那是 UTC），也不把 YYYY-MM-DD 当成 UTC 时刻解析。
 * 软删除的记录在 Rust 查询（vocab_browse）里已经排除，这里拿到的都是未删除的。
 */

/** 本机今天，格式 YYYY-MM-DD（按本机时区的年月日拼，不经过 UTC）。 */
export function localToday(now: Date = new Date()): string {
  const y = String(now.getFullYear()).padStart(4, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** 严格校验 YYYY-MM-DD 是真实存在的日期（2026-02-30、2026-13-01 都不算）。 */
export function isValidIsoDate(text: string): boolean {
  const match = ISO_DATE.exec(text);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

/** 两个合法 YYYY-MM-DD 之间差几天（b - a），按日历天数算，不受时区和夏令时影响。 */
export function daysBetween(a: string, b: string): number {
  const toDay = (text: string) => {
    const [y, m, d] = text.split('-').map(Number);
    return Date.UTC(y, m - 1, d) / 86_400_000;
  };
  return Math.round(toDay(b) - toDay(a));
}

/** 状态里的 L 级：只认 L1–L7，其他返回 null。 */
export function statusLevel(status: string): 1 | 2 | 3 | 4 | 5 | 6 | 7 | null {
  const match = /^L([1-7])$/.exec(status.trim());
  return match === null ? null : Number(match[1]) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

export interface DueWord extends BrowseReviewWord {
  /** 逾期天数：今天到期为 0，昨天到期为 1。 */
  overdueDays: number;
}

/** 这条复习词今天是否到期（规则见文件开头）。today 必须是合法 YYYY-MM-DD。 */
export function isDue(word: BrowseReviewWord, today: string): boolean {
  const level = statusLevel(word.status);
  if (level === null || word.level !== level) return false;
  const due = word.due.trim();
  if (!isValidIsoDate(due)) return false;
  // 两边都是补零的 YYYY-MM-DD，按字符串比较就是按日期比较。
  return due <= today;
}

/**
 * 今天的到期队列：先按到期日升序（逾期最久的在前），同一天按导入顺序 ord，再按 ID，结果稳定。
 * 同词不同 ID（不同期号）分别保留，不按词文本合并。不修改输入数组。
 */
export function dueQueue(words: readonly BrowseReviewWord[], today: string): DueWord[] {
  if (!isValidIsoDate(today)) throw new Error(`今天的日期不合法：${today}`);
  return words
    .filter(word => isDue(word, today))
    .map(word => ({ ...word, due: word.due.trim(), overdueDays: daysBetween(word.due.trim(), today) }))
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0) || a.ord - b.ord || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 列表里的到期说明：今天到期 / 逾期 N 天。 */
export function dueLabel(word: DueWord): string {
  return word.overdueDays === 0 ? '今天到期' : `逾期 ${word.overdueDays} 天`;
}
