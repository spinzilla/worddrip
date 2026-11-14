import type { CoachArchiveItemInput, CoachArchivePlan, CoachArchiveRequest, CoachTop, CoachTopChange } from '../vocab/types';
import type { EssayAnalysis, FirstReview, RewriteReview, SentenceCorrection } from './review';
import { PAPER_LABELS } from './review';

export const ARCHIVE_RED = '🔴 在犯';
export const ARCHIVE_YELLOW = '🟡 已改善';
export const ARCHIVE_GREEN = '🟢 已掌握';

export function localDate(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 模型给类别建议，用户仍可在预览里改；无法精确匹配时作为新类别。 */
export function suggestedArchiveItems(corrections: SentenceCorrection[], top: CoachTop[]): CoachArchiveItemInput[] {
  return corrections.map(item => ({
    kind: item.kind.trim(),
    written: item.original,
    correction: item.correction,
    note: item.why,
  }));
}

export function makeArchiveRequest(
  reviewId: string,
  essay: string,
  analysis: EssayAnalysis,
  review: FirstReview,
  rewrite: RewriteReview | null,
  items: CoachArchiveItemInput[],
  date = localDate(),
): CoachArchiveRequest {
  return {
    reviewId,
    essay,
    resultJson: JSON.stringify({ analysis, review, rewrite }),
    title: `${date} · 作文批改 · ${PAPER_LABELS[analysis.paperType]}`,
    date,
    paperType: PAPER_LABELS[analysis.paperType],
    wordCount: analysis.wordCount,
    items,
  };
}

function missedStatus(status: string, clean: number): string {
  if (clean < 3 || status.includes('已掌握')) return status;
  return status.includes('已改善') ? ARCHIVE_GREEN : ARCHIVE_YELLOW;
}

/** 与 Rust 事务使用同一套规则；前端测试用它核对预览和模拟写入。 */
export function buildArchivePreview(
  request: CoachArchiveRequest,
  top: CoachTop[],
  cleanById: Record<string, number> = {},
): CoachArchivePlan {
  const occurrences = new Map<string, number>();
  for (const item of request.items) occurrences.set(item.kind.trim(), (occurrences.get(item.kind.trim()) || 0) + 1);
  const changes: CoachTopChange[] = top.map(item => {
    const count = Number(item.count);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`高频错误“${item.kind}”的次数无效。`);
    const hit = occurrences.get(item.kind) || 0;
    const beforeClean = cleanById[item.id] || 0;
    const afterClean = hit > 0 ? 0 : beforeClean + 1;
    return {
      topId: item.id, kind: item.kind, isNew: false, occurrences: hit,
      beforeCount: count, afterCount: count + hit,
      beforeLastAt: item.lastAt, afterLastAt: hit > 0 ? request.date : item.lastAt,
      beforeStatus: item.status, afterStatus: hit > 0 ? ARCHIVE_RED : missedStatus(item.status, afterClean),
      beforeClean, afterClean,
    };
  });
  const existing = new Set(top.map(item => item.kind));
  let newIndex = 0;
  for (const [kind, hit] of occurrences) {
    if (existing.has(kind)) continue;
    changes.push({
      topId: `coach-top:${request.reviewId}:${newIndex++}`, kind, isNew: true, occurrences: hit,
      beforeCount: 0, afterCount: hit, beforeLastAt: '', afterLastAt: request.date,
      beforeStatus: '', afterStatus: ARCHIVE_RED, beforeClean: 0, afterClean: 0,
    });
  }
  return {
    reviewId: request.reviewId,
    batchId: `coach-batch:${request.reviewId}`,
    duplicate: false,
    itemsAdded: request.items.length,
    topChanges: changes,
  };
}
