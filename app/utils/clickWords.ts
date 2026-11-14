// 034 全应用点词查词：不依赖界面的纯函数（找点中的英文词、取所在句子、作答时防泄题）。
// 界面部分在 components/Lookable.tsx；测试：node test-click-lookup.mjs。
import type { DefinitionState } from '../components/DefinitionPanel';
import type { DictEntry, Seg } from './dictionary';
import { findLeaks, maskLeaks } from './vocab/recall';

export interface WordSpan { word: string; start: number; end: number }

const LETTER = /[A-Za-z]/;
// 词里允许的连接符：撇号（it's、students’）和连字符（well-known），两边都得是字母。
const JOINER = /['’\-]/;
// 紧挨着这些字符的字母串不当英文词：数字（L2、v3）和下划线（挖空提示 e_____、遮挡 ___）。
const NOT_WORD = /[0-9_]/;

const isLetter = (ch: string | undefined) => !!ch && LETTER.test(ch);

/**
 * text 里 offset 位置（光标落点，可能在字符左边或右边）的英文词；不是英文词返回 null。
 * 只认 ASCII 字母（中文、日文、数字都不算），至少 2 个字母，首尾的撇号/连字符去掉。
 */
export function wordAt(text: string, offset: number): WordSpan | null {
  if (offset < 0 || offset > text.length) return null;
  let i = isLetter(text[offset]) ? offset : isLetter(text[offset - 1]) ? offset - 1 : -1;
  if (i < 0) return null;
  let start = i, end = i + 1;
  while (start > 0 && (isLetter(text[start - 1]) || (JOINER.test(text[start - 1]) && isLetter(text[start - 2])))) start--;
  while (end < text.length && (isLetter(text[end]) || (JOINER.test(text[end]) && isLetter(text[end + 1])))) end++;
  if (NOT_WORD.test(text[start - 1] ?? '') || NOT_WORD.test(text[end] ?? '')) return null;
  const word = text.slice(start, end);
  if (word.replace(/[^A-Za-z]/g, '').length < 2) return null;
  return { word, start, end };
}

/** 把一段文字拆成「英文词 / 其他」片段（逐段渲染或检查用）。 */
export function splitEnglish(text: string): { text: string; word: boolean }[] {
  const out: { text: string; word: boolean }[] = [];
  let i = 0, plain = '';
  while (i < text.length) {
    const hit = isLetter(text[i]) && !isLetter(text[i - 1]) ? wordAt(text, i) : null;
    if (hit && hit.start === i) {
      if (plain) { out.push({ text: plain, word: false }); plain = ''; }
      out.push({ text: hit.word, word: true });
      i = hit.end;
    } else {
      plain += text[i++];
    }
  }
  if (plain) out.push({ text: plain, word: false });
  return out;
}

const MAX_CONTEXT = 300;

/** 词所在的那一句（按 . ! ? 。！？和换行分句），太长时截到词附近 300 字以内。发给 AI 当语境。 */
export function sentenceAround(text: string, start: number, end: number): string {
  const stop = /[.!?。！？](?=\s|$)|\n/g;
  let from = 0, to = text.length;
  for (const m of text.matchAll(stop)) {
    const at = m.index ?? 0;
    if (at < start) from = at + m[0].length;
    else if (at >= end) { to = at + (m[0] === '\n' ? 0 : 1); break; }
  }
  let line = text.slice(from, to);
  let wordAtLine = start - from;
  if (line.length > MAX_CONTEXT) {
    const cut = Math.max(0, Math.min(wordAtLine - MAX_CONTEXT / 2, line.length - MAX_CONTEXT));
    line = line.slice(cut, cut + MAX_CONTEXT);
    wordAtLine -= cut;
  }
  return line.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- 作答时防泄题

/** 把所有还没作答的目标词（含变形、同族词）换成 ___。没有目标词时原样返回。 */
export function scrubText(text: string, targets: readonly string[]): string {
  return targets.reduce((out, target) => (target.trim() ? maskLeaks(out, target) : out), text);
}

/** 点中的词本身就是（或含有）目标词：作答中不能查。 */
export function isBlockedWord(word: string, targets: readonly string[]): boolean {
  return targets.some(target => target.trim() && findLeaks(word, target).length > 0);
}

const scrubSegs = (line: Seg[], scrub: (s: string) => string): Seg[] =>
  line.map(p => (typeof p === 'string' ? scrub(p) : 'ruby' in p ? { ruby: scrub(p.ruby), rt: scrub(p.rt) } : p));

const scrubEntry = (e: DictEntry, scrub: (s: string) => string): DictEntry => ({
  ...e,
  word: scrub(e.word),
  phonetic: scrub(e.phonetic),
  reading: e.reading === undefined ? undefined : scrub(e.reading),
  dictName: e.dictName === undefined ? undefined : scrub(e.dictName),
  note: e.note === undefined ? undefined : scrub(e.note),
  senses: e.senses.map(s => ({
    ...s,
    pos: scrub(s.pos),
    phrase: s.phrase === undefined ? undefined : scrub(s.phrase),
    text: scrubSegs(s.text, scrub),
    examples: s.examples.map(x => scrubSegs(x, scrub)),
  })),
});

/** 查词卡上要显示的所有文字都过一遍 scrub（词典释义、例句、AI 解释、文化含义、出错信息）。 */
export function scrubDefinition(def: DefinitionState, scrub: (s: string) => string): DefinitionState {
  const opt = (s: string | undefined) => (s === undefined ? undefined : scrub(s));
  return {
    ...def,
    word: def.word === null ? null : scrub(def.word),
    context: opt(def.context),
    around: opt(def.around),
    dict: def.dict ? def.dict.map(e => scrubEntry(e, scrub)) : null,
    data: def.data ? {
      ...def.data,
      word: scrub(def.data.word),
      definition: scrub(def.data.definition),
      partOfSpeech: scrub(def.data.partOfSpeech),
      ...(def.data.culture !== undefined ? { culture: scrub(def.data.culture) } : {}),
    } : null,
    pick: def.pick ? { ...def.pick, note: scrub(def.pick.note), ...(def.pick.culture !== undefined ? { culture: scrub(def.pick.culture) } : {}) } : undefined,
    aiError: opt(def.aiError),
    error: opt(def.error),
  };
}
