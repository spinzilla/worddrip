import { statusGroup } from '../vocab/library';
import type { BrowseReviewWord } from '../vocab/types';
import type { WritingWord } from './model';

/**
 * 从复习词库挑 0–3 个建议用词：排除已掌握和没有英文释义的；最近加的优先，添加时间相同则快到期的优先。
 * 纯函数方便测试；真正从本机词库读取的入口在 library.ts。
 */
export function pickWritingWords(words: readonly BrowseReviewWord[]): WritingWord[] {
  const time = (text: string, fallback: number): number => {
    const value = Date.parse(text);
    return Number.isFinite(value) ? value : fallback;
  };
  return words
    .filter(item => statusGroup(item.status) !== 'mastered' && item.word.trim() && item.definitions.some(def => def.english.trim()))
    .slice()
    .sort((a, b) => time(b.addedAt, 0) - time(a.addedAt, 0) || time(a.due, Number.MAX_SAFE_INTEGER) - time(b.due, Number.MAX_SAFE_INTEGER))
    .slice(0, 3)
    .map(item => {
      const definition = item.definitions.find(def => def.english.trim())!;
      return {
        id: item.id,
        word: item.word.trim(),
        pos: definition.pos.trim(),
        definition: definition.english.replace(/\s+/g, ' ').trim(),
      };
    });
}