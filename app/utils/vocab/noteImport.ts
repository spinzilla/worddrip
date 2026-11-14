// 068 录入笔记：多页合并、页数/尺寸规则、报错判断。全是纯函数，不碰界面和网络，方便单元测试。
import { normalizeInboxWord, type InboxRecognizedWord } from './inbox';

/** 一次最多识别的页数（图片张数 + PDF 页数合计）。 */
export const NOTE_MAX_PAGES = 20;
/** 发给模型前，图片长边缩到不超过这个像素。 */
export const NOTE_LONG_EDGE = 2000;
/** 同时在途的识别请求数。 */
export const NOTE_CONCURRENCY = 3;
/** PDF 本身的大小上限（读进内存再渲染）。 */
export const NOTE_PDF_LIMIT = 50 * 1024 * 1024;

export type NoteFileKind = 'png' | 'jpeg' | 'webp' | 'heic' | 'pdf';

export interface NoteFileInfo { name: string; size: number; type: string }

export const noteFileKind = (file: NoteFileInfo): NoteFileKind | null => {
  const t = file.type.toLowerCase();
  if (t === 'image/png') return 'png';
  if (t === 'image/jpeg' || t === 'image/jpg') return 'jpeg';
  if (t === 'image/webp') return 'webp';
  if (t === 'image/heic' || t === 'image/heif') return 'heic';
  if (t === 'application/pdf') return 'pdf';
  if (t) return null;
  if (/\.png$/i.test(file.name)) return 'png';
  if (/\.jpe?g$/i.test(file.name)) return 'jpeg';
  if (/\.webp$/i.test(file.name)) return 'webp';
  if (/\.(heic|heif)$/i.test(file.name)) return 'heic';
  if (/\.pdf$/i.test(file.name)) return 'pdf';
  return null;
};

/** 单个文件的基本检查（类型、空文件、大小）；通过返回空串。 */
export const validateNoteFile = (file: NoteFileInfo, imageLimit: number): string => {
  const kind = noteFileKind(file);
  if (!kind) return `「${file.name}」不是 PNG、JPG、WEBP、HEIC 图片或 PDF，已跳过。`;
  if (file.size <= 0) return `「${file.name}」是空文件，已跳过。`;
  if (kind === 'pdf') {
    if (file.size > NOTE_PDF_LIMIT) return `「${file.name}」超过 50 MB，请拆分或压缩后再试。`;
  } else if (file.size > imageLimit) {
    return `「${file.name}」超过 ${Math.round(imageLimit / 1024 / 1024)} MB，请压缩后再试。`;
  }
  return '';
};

/** 加上 adding 页后是否超过页数上限；没超返回空串。 */
export const checkPageLimit = (current: number, adding: number): string =>
  current + adding > NOTE_MAX_PAGES
    ? `一次最多识别 ${NOTE_MAX_PAGES} 页（现有 ${current} 页，还想加 ${adding} 页），请分批录入。`
    : '';

/** 长边超过 max 时等比缩小；否则原样返回。结果至少 1 像素。 */
export const fitLongEdge = (width: number, height: number, max = NOTE_LONG_EDGE): { width: number; height: number } => {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const scale = max / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
};

export interface NotePageResult { page: number; words: InboxRecognizedWord[] }

export interface MergedNoteWord extends InboxRecognizedWord { pages: number[] }

/**
 * 把一页的识别结果并进已有列表（不改传入的数组）：同词（归一后相同）只留一条，
 * 备注去重后用「；」合并，记下来自哪几页。已有条目保留其额外字段（如候选的勾选状态、手工修改）。
 */
export const addPageToMerged = <T extends MergedNoteWord>(
  list: T[],
  page: number,
  words: InboxRecognizedWord[],
  make: (item: MergedNoteWord) => T,
): T[] => {
  const next = [...list];
  for (const item of words) {
    const key = normalizeInboxWord(item.word);
    if (!key) continue;
    const index = next.findIndex(entry => normalizeInboxWord(entry.word) === key);
    const note = item.note.trim();
    if (index < 0) {
      next.push(make({ word: item.word.trim(), note, uncertain: item.uncertain, pages: [page] }));
      continue;
    }
    const found = next[index];
    const pages = found.pages.includes(page) ? found.pages : [...found.pages, page].sort((x, y) => x - y);
    const merged = note && !found.note.split('；').includes(note) ? (found.note ? `${found.note}；${note}` : note) : found.note;
    next[index] = { ...found, pages, note: merged, uncertain: found.uncertain || item.uncertain };
  }
  return next;
};

/** 合并多页结果（按页码从小到大）。 */
export const mergeNotePages = (pages: NotePageResult[]): MergedNoteWord[] =>
  [...pages].sort((a, b) => a.page - b.page)
    .reduce<MergedNoteWord[]>((list, { page, words }) => addPageToMerged(list, page, words, item => item), []);

/** 「第 1、3 页」/「第 2 页」。 */
export const pagesLabel = (pages: number[]): string => `第 ${pages.join('、')} 页`;

/** 拿不准的条目超过一半，或有成功的页一个词都没认出 → 提醒用户扫描后重录。 */
export const shouldWarnUnclear = (merged: MergedNoteWord[], pages: NotePageResult[]): boolean => {
  if (pages.some(page => page.words.length === 0)) return true;
  if (merged.length === 0) return false;
  return merged.filter(item => item.uncertain).length * 2 > merged.length;
};

/** 模型返回 400/415，或报错里提到 image/vision/图片/多模态 → 多半是模型不支持看图。 */
export const isVisionUnsupportedError = (message: string): boolean =>
  /HTTP\s*(400|415)\b/.test(message) || /image|vision|多模态|看图/i.test(message);

export const VISION_UNSUPPORTED_TEXT = '当前模型可能不支持看图，请在「设置 → AI」换一个能看图的模型。';

/** 并发池：最多 limit 个同时跑；signal 取消后不再开新的。返回时所有已开始的都已结束。 */
export const runPool = async <T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: { aborted: boolean },
): Promise<void> => {
  let next = 0;
  const lane = async () => {
    while (next < items.length && !signal?.aborted) {
      const index = next++;
      await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
};
