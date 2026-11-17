import type { DictEntry, DictSource } from '../dictionary';
import type { DictFinder } from './definitionEn';

export type EnglishOnlineSource = 'youdao' | 'cambridgeEn' | 'wiktionary';
export type EnglishOnlineLookup = (source: EnglishOnlineSource, word: string) => Promise<DictEntry[] | null>;

const STORE_SOURCE: Record<EnglishOnlineSource, string> = {
  youdao: 'dict:youdao', cambridgeEn: 'dict:cambridge', wiktionary: 'dict:wiktionary',
};

/** 固定顺序：有道 → 用户选的英英来源 → 另一个。每次请求（包括失败后的重试）都经过同一个限速器。 */
export const onlineSourceOrder = (choice: DictSource): EnglishOnlineSource[] => {
  const selected = choice === 'wiktionary' ? 'wiktionary' : 'cambridgeEn';
  return ['youdao', selected, selected === 'cambridgeEn' ? 'wiktionary' : 'cambridgeEn'];
};

/** 一个来源报错或没有词就换下一个；只有全部失败才返回 null。 */
export async function findOnlineDefinition(
  word: string,
  choice: DictSource,
  lookup: EnglishOnlineLookup,
  wait: () => Promise<void>,
): Promise<Awaited<ReturnType<DictFinder>>> {
  for (const source of onlineSourceOrder(choice)) {
    try {
      await wait();
      const entries = await lookup(source, word);
      if (entries?.length) return { entries, source: STORE_SOURCE[source], online: true };
    } catch { /* 换下一个来源 */ }
  }
  return null;
}
