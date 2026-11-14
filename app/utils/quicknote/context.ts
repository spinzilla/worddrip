import type { QuickNoteContext } from '../vocab/types';

/**
 * 055 随手记：「当时在看什么」的拿法（纯函数 + 一个很小的全局登记处，不碰 Tauri；测试：node test-quicknote.mjs）。
 *
 * 做法：各页面（看视频、听写、词库词条）在自己挂载时登记一个「来源」，来源只会被读、不会推数据，
 * 所以页面不用为随手记多渲染。快捷框打开时读最上面（最后登记）的那个来源。
 * 暂停/恢复视频由带 pause 的来源负责：词条来源没有 pause，所以在看视频时又打开词条弹窗，
 * 上下文是词条，暂停仍交给视频来源。
 */

/** 来源给出的当前快照（还没决定带不带）。 */
export interface NoteSnapshot {
  kind: 'video' | 'dictation' | 'entry';
  /** 字幕句原文 */
  text?: string;
  videoId?: string;
  videoName?: string;
  /** 时间点（秒） */
  time?: number;
  entryId?: string;
  word?: string;
}

export interface NoteSource {
  snapshot(): NoteSnapshot | null;
  /** 正在播放就暂停并返回 true；本来就没在播（或不能暂停）返回 false。 */
  pause?(): boolean;
  resume?(): void;
}

const sources: NoteSource[] = [];

/** 登记一个来源，返回注销函数。后登记的优先。 */
export function registerNoteSource(source: NoteSource): () => void {
  sources.push(source);
  return () => {
    const index = sources.lastIndexOf(source);
    if (index >= 0) sources.splice(index, 1);
  };
}

/** 当前该用哪个快照：最上面一个有内容的来源，没有就 null。 */
export function currentSnapshot(): NoteSnapshot | null {
  for (let i = sources.length - 1; i >= 0; i -= 1) {
    const snap = sources[i].snapshot();
    if (snap) return snap;
  }
  return null;
}

/** 管视频暂停/恢复的来源：最后一个带 pause 的。 */
export function mediaSource(): NoteSource | null {
  for (let i = sources.length - 1; i >= 0; i -= 1) if (sources[i].pause) return sources[i];
  return null;
}

/** 存之前拼成后端要的上下文；keep = false（用户点了小叉）或没有快照 → 「无」。 */
export function buildContext(snapshot: NoteSnapshot | null, keep: boolean): QuickNoteContext {
  if (!snapshot || !keep) return { kind: 'none' };
  const ctx: QuickNoteContext = { kind: snapshot.kind };
  const text = snapshot.text?.replace(/\s+/g, ' ').trim();
  if (text) ctx.text = text;
  if (snapshot.videoId) ctx.videoId = snapshot.videoId;
  if (snapshot.videoName) ctx.videoName = snapshot.videoName;
  if (typeof snapshot.time === 'number' && Number.isFinite(snapshot.time) && snapshot.time >= 0) ctx.time = snapshot.time;
  if (snapshot.entryId) ctx.entryId = snapshot.entryId;
  if (snapshot.word) ctx.word = snapshot.word;
  return ctx;
}

/** 分:秒（超过一小时显示 时:分:秒）。 */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/** 框上方那行小字；「无」返回 null（不显示）。 */
export function describeContext(ctx: QuickNoteContext): string | null {
  const at = typeof ctx.time === 'number' ? clock(ctx.time) : '';
  if (ctx.kind === 'video' || ctx.kind === 'dictation') {
    // 有字幕句显示「字幕：句子 · 时间」；没有（比如还没播到第一句）显示「视频：名字 · 时间」。
    const parts = ctx.text ? [`字幕：${ctx.text}`, at] : [`${ctx.kind === 'video' ? '视频' : '听写'}：${ctx.videoName ?? ''}`, at];
    return parts.filter(Boolean).join(' · ');
  }
  if (ctx.kind === 'entry' && ctx.word) return `词条：${ctx.word}`;
  return null;
}

/** 正文能不能存：去掉空白后非空。 */
export const canSaveBody = (body: string) => body.trim().length > 0;
