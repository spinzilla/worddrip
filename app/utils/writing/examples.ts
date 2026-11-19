import { vocabApi } from '../vocab/api';
import { notifyExamplesChanged, usesTarget } from '../vocab/examples';
import { getWritingScene, type WritingWord } from './model';
import { getWritingRecord, updateWritingRecord, type WritingItem, type WritingRecordOptions } from './records';

/**
 * 096「存成例句」：从「更好的写法」和用户自己的作答里，挑出含某个建议用词的句子。
 * 例句来源：后端数据库只认 AI生成 / 自己写 / AI改过 三种（有 CHECK 约束），所以
 *   用户自己的句子 → 「自己写」；AI 更好的写法 → 「AI改过」（原句记用户的作答）；
 *   「写作练习」和场景、题目写进说明（explanation），词条页例句列表能看到。
 */

export interface WritingExampleCandidate {
  /** 去重用的键：词|句子 */
  key: string;
  word: string;
  sentence: string;
  from: 'better' | 'mine';
}

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** 按句末标点切句；不认识的写法整段当一句。 */
export function splitSentences(text: string): string[] {
  const parts = clean(text).match(/[^.!?。！？]+[.!?。！？]+["”’')\]]*|[^.!?。！？]+$/g) ?? [];
  return parts.map(clean).filter(part => /[A-Za-z]/.test(part));
}

export const writingExampleKey = (word: string, sentence: string): string => `${word.trim().toLowerCase()}|${clean(sentence).toLowerCase()}`;

export function writingExampleCandidates(words: readonly WritingWord[], better: string, answer: string): WritingExampleCandidate[] {
  const out: WritingExampleCandidate[] = [];
  const seen = new Set<string>();
  const add = (from: 'better' | 'mine', text: string) => {
    for (const sentence of splitSentences(text)) {
      for (const item of words) {
        if (!item.word.trim() || !usesTarget(sentence, item.word)) continue;
        const key = writingExampleKey(item.word, sentence);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ key, word: item.word, sentence, from });
      }
    }
  };
  add('better', better);
  add('mine', answer);
  return out;
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** 存一句例句并记进写作记录（已存）。后端说「已经存过」也算存好了。 */
export async function saveWritingExample(record: WritingItem, candidate: WritingExampleCandidate, options: WritingRecordOptions = {}): Promise<void> {
  const scene = getWritingScene(record.scene);
  const where = `写作练习 · ${scene?.nameZh ?? ''}${record.task?.prompt ? `：${record.task.prompt}` : ''}`.slice(0, 300);
  const item = candidate.from === 'mine'
    ? { sentence: candidate.sentence, source: '自己写' as const, explanation: where, sense: null }
    : { sentence: candidate.sentence, source: 'AI改过' as const, explanation: where, sense: null, original: clean(record.answer).slice(0, 900) || null };
  try {
    await vocabApi.addExamples({ word: candidate.word, items: [item] });
  } catch (reason) {
    if (!errorText(reason).includes('存过')) throw reason;
  }
  notifyExamplesChanged();
  const current = getWritingRecord(record.id, options) ?? record;
  updateWritingRecord(record.id, { savedExamples: [...new Set([...(current.savedExamples ?? []), candidate.key])] }, options);
}
