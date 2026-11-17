import { useEffect, useState } from 'react';
import { vocabApi } from '../utils/vocab/api';
import { manualKey, onVocabChanged } from '../utils/vocab/manualAdd';

// 042：查词卡上判断「已在词库」。全应用共用一份复习库词表，复习库一变（手动加词、收件箱入库）就作废重读。
// 读不到（例如浏览器开发模式没有 Tauri）时当作不在词库：按钮照常显示，真正保存时后端还会查重。

let cache: Promise<Set<string> | null> | null = null;
let version = 0;
const listeners = new Set<() => void>();

const load = () => {
  cache ??= vocabApi.browse()
    .then(data => new Set(data.reviewWords.map(item => manualKey(item.word))))
    .catch(() => null);
  return cache;
};

if (typeof window !== 'undefined') {
  onVocabChanged(() => {
    cache = null;
    version += 1;
    listeners.forEach(listener => listener());
  });
}

export type VocabMatch = { found: boolean; word: string | null };

/**
 * 这些写法里哪个已在复习库，返回那个写法本身（用来打开已有词条）；还没读完返回 null。
 * 例：点了 shattered、库里是 shatter → { found: true, word: 'shatter' }。
 */
export function useInVocabMatch(words: readonly (string | null | undefined)[], enabled = true): VocabMatch | null {
  const forms = words.map(word => (word ?? '').trim()).filter(Boolean);
  const keys = forms.map(manualKey).filter(Boolean);
  const signature = keys.join('\u0001');
  const [state, setState] = useState<{ signature: string; version: number; matched: string | null } | null>(null);
  const [tick, setTick] = useState(version);

  useEffect(() => {
    const listener = () => setTick(version);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);

  useEffect(() => {
    if (!enabled || !signature) return;
    let alive = true;
    const at = version;
    load().then(set => {
      if (!alive) return;
      const atIndex = set ? keys.findIndex(key => set.has(key)) : -1;
      setState({ signature, version: at, matched: atIndex >= 0 ? forms[atIndex] : null });
    });
    return () => { alive = false; };
  }, [signature, enabled, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!enabled || !signature) return null;
  if (!state || state.signature !== signature || state.version !== tick) return null;
  return { found: state.matched !== null, word: state.matched };
}

/** 这些写法里任意一个已在复习库就返回 true；还没读完返回 null。 */
export function useInVocab(words: readonly (string | null | undefined)[], enabled = true): boolean | null {
  const match = useInVocabMatch(words, enabled);
  return match ? match.found : null;
}
