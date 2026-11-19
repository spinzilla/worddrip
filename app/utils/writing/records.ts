import type { WritingReviewResult, WritingSceneId, WritingTaskResult, WritingWord } from './model';

export const WRITING_RECORDS_KEY = 'writing.records.v1';
export const WRITING_RECORDS_KEEP = 100;

export interface WritingItem {
  id: string;
  scene: WritingSceneId;
  /** 出题完成后从 AI 任务抄来；排队或进行中为 null。 */
  task: WritingTaskResult | null;
  words: WritingWord[];
  answer: string;
  review: WritingReviewResult | null;
  taskId: string;
  reviewTaskId?: string;
  /** 已有批改后，「再写一版」的草稿（096）；有它就表示正在改写，批改时变成新的作答。 */
  draft?: string;
  /** 「再写一版」前的旧作答和旧批改（096），最旧的在前。 */
  versions?: WritingVersion[];
  /** 已存成例句的 `词|句子`（096）；页面和小窗的结果块共用，存一次两处都变「已存」。 */
  savedExamples?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface WritingVersion { answer: string; review: WritingReviewResult; at: number }

// 096：界面订阅记录变化（出题完成、批改完成、存草稿都会走 write）。
const changeListeners = new Set<() => void>();
let changeVersion = 0;
export const onWritingRecordsChanged = (listener: () => void): (() => void) => {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
};
export const writingRecordsVersion = (): number => changeVersion;

export interface WritingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface WritingRecordOptions {
  storage?: WritingStorage | null;
  now?: () => number;
  newId?: () => string;
}

export const defaultWritingStorage = (): WritingStorage | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};
const clock = (options: WritingRecordOptions): number => (options.now ?? Date.now)();
export const newWritingId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function read(storage: WritingStorage | null | undefined): WritingItem[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(WRITING_RECORDS_KEY);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is WritingItem => {
      if (!item || typeof item !== 'object') return false;
      const row = item as Partial<WritingItem>;
      return typeof row.id === 'string' && typeof row.taskId === 'string' && typeof row.createdAt === 'number'
        && (row.scene === 'ielts' || row.scene === 'cet' || row.scene === 'academic') && Array.isArray(row.words);
    }).slice(0, WRITING_RECORDS_KEEP);
  } catch { return []; }
}

function write(storage: WritingStorage | null | undefined, items: readonly WritingItem[]): void {
  if (!storage) return;
  try { storage.setItem(WRITING_RECORDS_KEY, JSON.stringify(items.slice(0, WRITING_RECORDS_KEEP))); } catch { /* 本机存不下时保留任务，不让练习中断 */ }
  changeVersion += 1;
  changeListeners.forEach(listener => listener());
}

export function listWritingRecords(options: WritingRecordOptions = {}): WritingItem[] {
  return read(options.storage === undefined ? defaultWritingStorage() : options.storage);
}

export function getWritingRecord(id: string, options: WritingRecordOptions = {}): WritingItem | undefined {
  return listWritingRecords(options).find(item => item.id === id);
}

export function createWritingRecord(scene: WritingSceneId, words: readonly WritingWord[], taskId: string, options: WritingRecordOptions = {}): WritingItem {
  const now = clock(options);
  const item: WritingItem = {
    id: (options.newId ?? newWritingId)(), scene, task: null, words: words.map(word => ({ ...word })),
    answer: '', review: null, taskId, createdAt: now, updatedAt: now,
  };
  const storage = options.storage === undefined ? defaultWritingStorage() : options.storage;
  write(storage, [item, ...read(storage)]);
  return item;
}

export function updateWritingRecord(id: string, change: Partial<Omit<WritingItem, 'id' | 'createdAt'>>, options: WritingRecordOptions = {}): WritingItem | undefined {
  const storage = options.storage === undefined ? defaultWritingStorage() : options.storage;
  let updated: WritingItem | undefined;
  const items = read(storage).map(item => {
    if (item.id !== id) return item;
    updated = { ...item, ...change, id: item.id, createdAt: item.createdAt, updatedAt: clock(options) };
    return updated;
  });
  if (updated) write(storage, items);
  return updated;
}

export function saveWritingDraft(id: string, answer: string, options: WritingRecordOptions = {}): WritingItem | undefined {
  return updateWritingRecord(id, { answer }, options);
}

export function saveWritingTaskResult(id: string, task: WritingTaskResult, options: WritingRecordOptions = {}): WritingItem | undefined {
  return updateWritingRecord(id, { task }, options);
}

export function saveWritingReview(id: string, review: WritingReviewResult, reviewTaskId?: string, options: WritingRecordOptions = {}): WritingItem | undefined {
  return updateWritingRecord(id, { review, ...(reviewTaskId ? { reviewTaskId } : {}) }, options);
}

export function deleteWritingRecord(id: string, options: WritingRecordOptions = {}): boolean {
  const storage = options.storage === undefined ? defaultWritingStorage() : options.storage;
  const items = read(storage);
  const kept = items.filter(item => item.id !== id);
  if (kept.length === items.length) return false;
  write(storage, kept);
  return true;
}