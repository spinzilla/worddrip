import type { ReviewCard } from '../review';
import { normalizeText, wordKey } from './library';
import type { WordGroup } from './library';

/** 只在页面层合并：词库条目和听力卡都保留原对象，绝不互相写回。 */
export interface MergedListeningWord {
  key: string;
  word: string;
  vocab: WordGroup | null;
  listeningCards: ReviewCard[];
}

export type ListeningFilter = 'all' | 'listening' | 'vocab';

export function mergeListeningWords(words: readonly WordGroup[], cards: readonly ReviewCard[]): MergedListeningWord[] {
  const byKey = new Map<string, MergedListeningWord>();
  for (const vocab of words) {
    byKey.set(vocab.key, { key: vocab.key, word: vocab.word, vocab, listeningCards: [] });
  }
  for (const card of cards) {
    if (card.deck !== 'word' || !card.word?.trim()) continue;
    const key = wordKey(card.word);
    const old = byKey.get(key);
    if (old) old.listeningCards.push(card);
    else byKey.set(key, { key, word: card.word.trim(), vocab: null, listeningCards: [card] });
  }
  return [...byKey.values()].sort((a, b) => a.word.localeCompare(b.word, 'en', { sensitivity: 'base' }));
}

export function listeningCounts(items: readonly MergedListeningWord[]) {
  const listening = items.filter(item => item.listeningCards.length > 0).length;
  return { all: items.length, listening, vocab: items.length - listening };
}

export function filterListeningWords(items: readonly MergedListeningWord[], filter: ListeningFilter) {
  return items.filter(item => filter === 'all'
    || (filter === 'listening' ? item.listeningCards.length > 0 : item.listeningCards.length === 0));
}

/** 听力独有的词也能按词头、释义和原句搜到；有词库的词仍走原有相关度搜索。 */
export function listeningWordMatches(item: MergedListeningWord, query: string): boolean {
  const q = normalizeText(query);
  if (!q) return true;
  return [item.word, ...item.listeningCards.flatMap(card => [card.text, card.definition ?? '', card.example ?? ''])]
    .some(text => normalizeText(text).includes(q));
}
