import { vocabApi } from '../vocab/api';
import type { WritingWord } from './model';
import { pickWritingWords } from './wordPicker';

/** 读一次本机词库并挑建议用词；词库为空也正常返回空数组。 */
export async function suggestWritingWords(): Promise<WritingWord[]> {
  const data = await vocabApi.browse();
  return pickWritingWords(data.reviewWords);
}