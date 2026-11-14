import type { BrowseReviewWord, ManualAddRequest } from './types';

/**
 * 042 手动加词：表单默认值、查重、从查词卡结果预填、跨页面打开表单。
 *
 * 纯函数和事件都在这里，不碰数据库（写入走 vocabApi.manualAdd → Rust manual.rs）。
 * 状态、查证、原始行由后端统一写成 `🌱待考察` / `未查证` / 六列表格行，和手写收件箱一样。
 */

/** 来源默认值：词库页手动添加。查词卡上加的写所在页面（精听、教练……）。 */
export const MANUAL_SOURCE = '手动添加';

const pad = (n: number) => String(n).padStart(2, '0');

/** 本机今天，YYYY-MM-DD（入库日期）。 */
export function todayDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 默认期号：和 Hermes 现有期号同样写法，月.日、不补零，例如 11.10、8.25。 */
export function todayIssue(now: Date = new Date()): string {
  return `${now.getMonth() + 1}.${now.getDate()}`;
}

/** 查重用的键：去首尾空白、中间空白合一、不分大小写（和后端 normalized_word 一致）。 */
export function manualKey(word: string): string {
  return word.trim().split(/\s+/).filter(Boolean).join(' ').toLowerCase();
}

/** 复习库里和这个词同名的所有词条（不分大小写、忽略多余空白）。 */
export function findExisting<T extends Pick<BrowseReviewWord, 'word'>>(words: readonly T[], word: string): T[] {
  const key = manualKey(word);
  return key ? words.filter(item => manualKey(item.word) === key) : [];
}

export interface ManualForm {
  word: string;
  pos: string;
  chinese: string;
  english: string;
  example: string;
  source: string;
  issue: string;
  note: string;
}

export function emptyForm(prefill: Partial<ManualForm> = {}, now: Date = new Date()): ManualForm {
  return {
    word: '', pos: '', chinese: '', english: '', example: '', note: '',
    source: MANUAL_SOURCE,
    issue: todayIssue(now),
    ...Object.fromEntries(Object.entries(prefill).filter(([, value]) => typeof value === 'string')),
  } as ManualForm;
}

/** 前端先挡一遍（后端还会再查一遍）；返回空串表示可以保存。 */
export function validateForm(form: ManualForm): string {
  const word = form.word.trim();
  if (!word) return '请填写词或短语。';
  if (word.length > 200) return '词或短语不能超过 200 个字符。';
  if (word.includes('|')) return '词或短语里不能有竖线「|」。';
  if (!form.issue.trim()) return '请填写期号（例如 11.10）。';
  if (/[|\r\n]/.test(form.issue.trim())) return '期号里不能有竖线或换行。';
  if (/[|\r\n]/.test(form.note.trim())) return '复习备注里不能有竖线或换行（会写进复习库表格的一行）。';
  if (/[\r\n]/.test(form.source.trim())) return '来源里不能有换行。';
  return '';
}

export function toRequest(form: ManualForm, allowDuplicate: boolean, now: Date = new Date()): ManualAddRequest {
  return {
    word: form.word.trim().split(/\s+/).join(' '),
    pos: form.pos.trim(),
    chinese: form.chinese.trim(),
    english: form.english.trim(),
    example: form.example.trim(),
    source: form.source.trim() || MANUAL_SOURCE,
    issue: form.issue.trim(),
    date: todayDate(now),
    note: form.note.trim(),
    allowDuplicate,
  };
}

// ---------- 从查词结果预填 ----------

type Seg = string | { img: string } | { ruby: string; rt: string };
interface LookupSense { pos: string; text: Seg[]; examples: Seg[][] }
interface LookupEntry { word: string; senses: LookupSense[] }
/** DefinitionPanel 的 DefinitionState 里预填要用到的那几项（不引组件，node 测试能直接跑）。 */
export interface LookupResult {
  word: string | null;
  dict: LookupEntry[] | null;
  data: { word: string; definition: string; partOfSpeech: string } | null;
  pick?: { index: number | null };
}

const CJK = /[㐀-鿿]/;
const segText = (line: Seg[]) => line.map(part => typeof part === 'string' ? part : 'ruby' in part ? part.ruby : '').join('').replace(/\s+/g, ' ').trim();
const isEnglishWord = (word: string) => /^[A-Za-z][A-Za-z'’\- ]*$/.test(word.trim());

/** 查词卡上能不能「加入词库」：词库只收英文词和短语。 */
export const canAddWord = (word: string | null | undefined): boolean => !!word && isEnglishWord(word) && word.trim().length <= 200;

/**
 * 把查词结果变成表单预填：词典优先（AI 指出的那条义项，否则第一条），没有词典就用 AI 释义。
 * 释义里有中文就填「中文意思」，否则填「英文释义」。例句优先用点词时所在的句子。
 */
export function prefillFromLookup(result: LookupResult, sentence = ''): Partial<ManualForm> {
  const fill: Partial<ManualForm> = {};
  const clicked = (result.word ?? '').trim();
  const putMeaning = (text: string) => {
    if (!text) return;
    if (CJK.test(text)) fill.chinese = text; else fill.english = text;
  };
  const senses = (result.dict ?? []).flatMap(entry => entry.senses.map(sense => ({ entry, sense })));
  if (senses.length > 0) {
    const index = result.pick?.index;
    const chosen = (index && senses[index - 1]) || senses[0];
    fill.word = isEnglishWord(chosen.entry.word) ? chosen.entry.word.trim() : clicked;
    fill.pos = chosen.sense.pos.trim();
    putMeaning(segText(chosen.sense.text));
    const example = chosen.sense.examples[0];
    if (example) fill.example = segText(example);
  } else if (result.data) {
    fill.word = isEnglishWord(result.data.word) ? result.data.word.trim() : clicked;
    fill.pos = result.data.partOfSpeech.trim();
    putMeaning(result.data.definition.replace(/\s+/g, ' ').trim());
  } else if (clicked) {
    fill.word = clicked;
  }
  const line = sentence.replace(/\s+/g, ' ').trim();
  if (line) fill.example = line;
  return fill;
}

/** 「查词典填写」：只填用户还空着的格子，已经手写的内容不覆盖。词本身不动。 */
export function mergeLookup(form: ManualForm, fill: Partial<ManualForm>): ManualForm {
  const next = { ...form };
  for (const key of ['pos', 'chinese', 'english', 'example'] as const) {
    if (!next[key].trim() && fill[key]) next[key] = fill[key]!;
  }
  return next;
}

// ---------- 跨页面：打开表单 / 打开已有词条 / 词库变了 ----------

export type VocabAddRequest =
  | { kind: 'add'; prefill: Partial<ManualForm>; onSaved?: (word: string, issue: string) => void }
  | { kind: 'open'; word: string };

const OPEN = 'vocab-manual-open';
const CHANGED = 'vocab-library-changed';

/** 打开「添加词条」表单（任何页面都行，表单挂在应用最外层）。 */
export function openManualAdd(prefill: Partial<ManualForm> = {}, onSaved?: (word: string, issue: string) => void): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<VocabAddRequest>(OPEN, { detail: { kind: 'add', prefill, onSaved } }));
}

/** 弹出已有词条的详情（不离开当前页面，正在练的视频不会被打断）。 */
export function openVocabEntry(word: string): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<VocabAddRequest>(OPEN, { detail: { kind: 'open', word } }));
}

export function onManualAddRequest(listener: (request: VocabAddRequest) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (event: Event) => listener((event as CustomEvent<VocabAddRequest>).detail);
  window.addEventListener(OPEN, handler);
  return () => window.removeEventListener(OPEN, handler);
}

/** 复习库多了词：词库列表、首考面板、查词卡「已在词库」都要重读。 */
export function notifyVocabChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGED));
}

export function onVocabChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(CHANGED, listener);
  return () => window.removeEventListener(CHANGED, listener);
}
