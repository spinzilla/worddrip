import type { VocabNote } from './types';
import { normalizeText } from './library';

/**
 * 040 词条笔记的纯函数（不碰 Tauri，测试：node test-vocab-notes.mjs）。
 *
 * 笔记按词挂：键 = normalizeText(词)，和后端 `vocab/notes.rs` 的 note_key 规则一致
 * （去 **、弯撇号换直撇号、空白合一、去首尾空白、转小写；短语按整段）。
 * 笔记只在本机显示和导出，出题、判分、批改的请求都不带它。
 */

export const noteKey = (word: string) => normalizeText(word);

/** 新的在前；同一时刻按 ID 倒序。不改原数组。 */
export function sortNotes(notes: readonly VocabNote[]): VocabNote[] {
  return [...notes].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id));
}

/** 按词分组，组内新的在前。 */
export function groupNotes(notes: readonly VocabNote[]): Map<string, VocabNote[]> {
  const map = new Map<string, VocabNote[]>();
  for (const note of sortNotes(notes)) {
    const list = map.get(note.wordKey);
    if (list) list.push(note);
    else map.set(note.wordKey, [note]);
  }
  return map;
}

/** 新增或替换（编辑后）一条，返回新数组。 */
export function upsertNote(notes: readonly VocabNote[], note: VocabNote): VocabNote[] {
  return notes.some(item => item.id === note.id) ? notes.map(item => (item.id === note.id ? note : item)) : [note, ...notes];
}

export function removeNote(notes: readonly VocabNote[], id: number): VocabNote[] {
  return notes.filter(item => item.id !== id);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 本地时间「2026-11-10 14:03」；解析不了原样返回。 */
export function formatNoteTime(stamp: string): string {
  const time = new Date(stamp);
  if (Number.isNaN(time.getTime())) return stamp;
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
}

/**
 * 041：笔记在复习、首考、闪卡里也能加/改/删。改完广播一声，词库页（一直挂着、只在切回来时才重读）收到后重读笔记，
 * 不用手动刷新就能看到。只在浏览器环境里发（node 测试里没有 window 就什么都不做）。
 */
const NOTES_CHANGED = 'vocab-notes-changed';
export function notifyNotesChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(NOTES_CHANGED));
}
export function onNotesChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(NOTES_CHANGED, listener);
  return () => window.removeEventListener(NOTES_CHANGED, listener);
}

export const wasEdited = (note: Pick<VocabNote, 'createdAt' | 'updatedAt'>) => note.updatedAt !== note.createdAt;
