import type { DictEntry, Seg } from '../dictionary';
import type { DefinitionEnItem, VocabDefinitionEn } from './types';
import { normalizeText } from './library';
import { postChat } from './recallModel';

/**
 * 078 英英释义：纯函数 + 一个模型请求（测试：node test-vocab-definition-en.mjs）。
 *
 * - 存储在 vocab_definition_en（后端 vocab/definition_en.rs），按词挂：键 = normalizeText(词)，和笔记、例句一致。
 * - source：`mine` = 自己写的；`dict:xxx` = 词典查来的。
 * - 显示优先级：自己写的 > 导入的（review_definition.english，不改）> 词典查来的（默认收起）。
 */

export const MINE = 'mine';
/** 词典结果最多存几个义项。 */
export const MAX_DICT_SENSES = 3;
/** 在线查词的最小间隔（毫秒）：每秒不超过 2 个。本地词典不受限。 */
export const ONLINE_MIN_INTERVAL_MS = 500;
/** 一条释义最多多少字（和后端一致）。 */
export const MAX_DEFINITION_CHARS = 1000;

export const definitionKey = (word: string) => normalizeText(word);

export const isMine = (item: Pick<VocabDefinitionEn, 'source'>) => item.source === MINE;

/** 来源的显示文字。 */
export function sourceLabel(source: string): string {
  switch (source) {
    case MINE: return '我写的';
    case 'dict:youdao': return '来自 有道（WordNet）';
    case 'dict:cambridge': return '来自 剑桥英英';
    case 'dict:wiktionary': return '来自 Wiktionary';
    case 'dict:local-wiktionary': return '来自 本地 Wiktionary';
    case 'dict:local': return '来自 本地词典';
    default: return `来自 ${source.replace(/^dict:/, '')}`;
  }
}

export function sortDefinitions(list: readonly VocabDefinitionEn[]): VocabDefinitionEn[] {
  return [...list].sort((a, b) => Number(!isMine(a)) - Number(!isMine(b)) || a.id - b.id);
}

export function groupDefinitions(list: readonly VocabDefinitionEn[]): Map<string, VocabDefinitionEn[]> {
  const map = new Map<string, VocabDefinitionEn[]>();
  for (const item of list) {
    const group = map.get(item.wordKey);
    if (group) group.push(item); else map.set(item.wordKey, [item]);
  }
  for (const [key, group] of map) map.set(key, sortDefinitions(group));
  return map;
}

export interface ImportedEnglish { pos: string; english: string }

export interface DefinitionView {
  /** 自己写的（排第一，默认显示）。 */
  mine: VocabDefinitionEn[];
  /** 导入期笔记带来的 review_definition.english，不改。 */
  imported: ImportedEnglish[];
  /** 词典查来的；有自己写的或导入的时默认收起。 */
  dict: VocabDefinitionEn[];
  /** 三类都没有。 */
  empty: boolean;
  /** 词典那组默认是否收起：前面有别的释义就收起。 */
  dictCollapsed: boolean;
}

/** 显示优先级：我写的 > 导入的 > 词典的。 */
export function definitionView(stored: readonly VocabDefinitionEn[], imported: readonly ImportedEnglish[]): DefinitionView {
  const mine = stored.filter(isMine).sort((a, b) => a.id - b.id);
  const dict = stored.filter(item => !isMine(item)).sort((a, b) => a.id - b.id);
  const importedList = imported.filter(item => item.english.trim());
  return {
    mine,
    imported: importedList,
    dict,
    empty: mine.length + importedList.length + dict.length === 0,
    dictCollapsed: mine.length + importedList.length > 0,
  };
}

/** 这个词有没有任何英英释义（导入的、存下的都算）：没有才需要去查词典。 */
export function hasAnyEnglish(stored: readonly VocabDefinitionEn[], imported: readonly ImportedEnglish[]): boolean {
  return stored.length > 0 || imported.some(item => item.english.trim());
}

// ---------------------------------------------------------------- 词典结果 → 要存的几条

const CJK = /[㐀-鿿]/;
const LATIN = /[A-Za-z]/;

const segText = (parts: readonly Seg[]): string =>
  parts.map(part => (typeof part === 'string' ? part : '')).join('');

/** 只取英文：多行时取第一行英文（剑桥「英文\n中文」）；带中文的整行丢掉。 */
function englishOf(text: string): string {
  for (const line of text.split('\n')) {
    const clean = line.replace(/\s+/g, ' ').trim();
    if (clean && LATIN.test(clean) && !CJK.test(clean)) return clean.slice(0, MAX_DEFINITION_CHARS);
  }
  return '';
}

/** 从词典结果里取前 1–3 个有英文释义的义项（带词性）。一个都没有返回空数组。 */
export function pickDictItems(entries: readonly DictEntry[] | null | undefined): DefinitionEnItem[] {
  const items: DefinitionEnItem[] = [];
  const seen = new Set<string>();
  for (const entry of entries ?? []) {
    for (const sense of entry.senses) {
      const text = englishOf(segText(sense.text));
      const key = normalizeText(text);
      if (!text || seen.has(key)) continue;
      seen.add(key);
      const pos = sense.pos.replace(/\s+/g, ' ').trim();
      items.push({ pos: pos || null, text });
      if (items.length >= MAX_DICT_SENSES) return items;
    }
  }
  return items;
}

/** 查词典的结果：来源、取到的义项、是不是在线查的（在线要限速）。 */
export interface DictFound { source: string; items: DefinitionEnItem[]; online: boolean }
/** 查一个词：查不到返回 null；断网等错误由调用方当作「查不到」处理。 */
export type DictFinder = (word: string) => Promise<{ entries: DictEntry[]; source: string; online: boolean } | null>;

/** 查一个词的英英释义。查不到、断网、没有英文义项都返回 null（不抛错、不写空记录）。 */
export async function findDictDefinitions(word: string, find: DictFinder): Promise<DictFound | null> {
  try {
    const hit = await find(word);
    if (!hit) return null;
    const items = pickDictItems(hit.entries);
    return items.length ? { source: hit.source, items, online: hit.online } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 改完广播

const CHANGED = 'vocab-definition-en-changed';
export function notifyDefinitionsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGED));
}
export function onDefinitionsChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(CHANGED, listener);
  return () => window.removeEventListener(CHANGED, listener);
}

// ---------------------------------------------------------------- AI 帮我看看

export interface DefinitionCheck {
  /** 释义准确、写法也像英英词典。 */
  good: boolean;
  /** 中文说明。 */
  comment: string;
  /** 改写建议（英文）；没有要改的为空串。 */
  suggestion: string;
}

/** 只发词、词性和用户写的释义：不发笔记、复习备注。 */
export function buildDefinitionCheckPrompt(word: string, pos: string, written: string): string {
  return [
    'You are an English learner\'s dictionary editor.',
    `Target word: ${word}${pos ? ` (${pos})` : ''}`,
    `The learner wrote this English definition: "${written}"`,
    'Check (1) whether it is accurate for the word and part of speech, and (2) whether it reads like a learner\'s English-English dictionary definition (simple words, no circular use of the headword, no example sentence mixed in).',
    'Reply with JSON only: {"good": true|false, "comment": "<one or two short sentences in Simplified Chinese>", "suggestion": "<an improved English definition, or an empty string when the original is already fine>"}',
  ].join('\n');
}

const checkMalformed = () => new Error('模型返回格式不正确：需要 {"good":true,"comment":"…","suggestion":"…"}。');

/** 只接受完整 JSON 或完整 Markdown 代码块，不从散文里猜 JSON。 */
export function parseDefinitionCheck(content: string, written: string): DefinitionCheck {
  const fenced = content.match(/^\s*```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?\s*```\s*$/i);
  let data: unknown;
  try { data = JSON.parse(fenced ? fenced[1] : content); } catch { throw checkMalformed(); }
  if (!data || typeof data !== 'object') throw checkMalformed();
  const record = data as Record<string, unknown>;
  if (typeof record.good !== 'boolean' || typeof record.comment !== 'string' || !record.comment.trim()) throw checkMalformed();
  const suggestion = typeof record.suggestion === 'string' ? record.suggestion.replace(/\s+/g, ' ').trim() : '';
  const same = normalizeText(suggestion) === normalizeText(written);
  return {
    good: record.good && (!suggestion || same),
    comment: record.comment.trim(),
    suggestion: same || suggestion.length > MAX_DEFINITION_CHARS ? '' : suggestion,
  };
}

/** 让模型看自己写的这条。没配模型、断网、格式不对都抛中文错误。 */
export async function checkOwnDefinition(word: string, pos: string, written: string, options: { timeoutMs?: number } = {}): Promise<DefinitionCheck> {
  const text = written.replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('先写一条再让 AI 看。');
  if (text.length > MAX_DEFINITION_CHARS) throw new Error(`释义太长了（超过 ${MAX_DEFINITION_CHARS} 字）。`);
  const content = await postChat(buildDefinitionCheckPrompt(word, pos.trim(), text), options.timeoutMs);
  return parseDefinitionCheck(content, text);
}
