import type { CoachArchiveData, CoachBatch, CoachItem, ErrorArchiveBatch, ErrorArchiveItem, ErrorArchiveParseResult } from '../vocab/types';

export const emptyCoachArchive = (): CoachArchiveData => ({ top: [], batches: [], todos: [] });

// 档案按写作先后记录，页面先看最近一批；批内错误仍保持原顺序。
export function buildCoachBatches(batches: ErrorArchiveBatch[], items: ErrorArchiveItem[]): CoachBatch[] {
  return [...batches]
    .sort((a, b) => b.ord - a.ord)
    .map(batch => ({
      id: batch.id,
      ord: batch.ord,
      title: batch.title,
      date: batch.date,
      metadata: batch.metadata,
      items: items
        .filter(item => item.batchId === batch.id)
        .sort((a, b) => a.ord - b.ord)
        .map(item => ({
          id: item.id,
          batchId: item.batchId,
          ord: item.ord,
          question: item.question,
          kind: item.kind,
          written: item.written,
          correction: item.correction,
          note: item.note,
        })),
    }));
}

export function buildCoachArchive(data: ErrorArchiveParseResult): CoachArchiveData {
  return {
    top: data.top.map(({ id, ord, rank, kind, count, lastAt, status }) => ({ id, ord, rank, kind, count, lastAt, status })),
    batches: buildCoachBatches(data.batches, data.items),
    todos: data.todos.map(({ id, ord, done, text }) => ({ id, ord, done, text })),
  };
}

export function coachItemTitle(item: CoachItem): string {
  return item.question ? `${item.question} · ${item.kind}` : item.kind;
}

export function isCoachEmpty(data: CoachArchiveData): boolean {
  return data.top.length === 0 && data.batches.length === 0 && data.todos.length === 0;
}
