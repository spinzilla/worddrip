import { useCallback, useEffect, useState } from 'react';
import { vocabApi } from '../../utils/vocab/api';
import { dueQueue, localToday } from '../../utils/vocab/due';
import { onVocabChanged } from '../../utils/vocab/manualAdd';

export const VOCAB_DUE_EVENT = 'vocab-due-count-changed';

export function notifyVocabDueCount(count: number) {
  window.dispatchEvent(new CustomEvent<number>(VOCAB_DUE_EVENT, { detail: count }));
}

/** 导航和复习入口共用同一个到期口径：L1–L4 且今天已到期。 */
export default function useVocabDueCount() {
  const [count, setCount] = useState(0);
  const load = useCallback(() => {
    vocabApi.browse().then(data => setCount(dueQueue(data.reviewWords, localToday()).length)).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const off = onVocabChanged(load);
    const onCount = (event: Event) => setCount((event as CustomEvent<number>).detail);
    window.addEventListener(VOCAB_DUE_EVENT, onCount);
    window.addEventListener('focus', load);
    return () => { off(); window.removeEventListener(VOCAB_DUE_EVENT, onCount); window.removeEventListener('focus', load); };
  }, [load]);
  return count;
}
