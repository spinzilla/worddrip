import { loadClip } from '../speech';
import type { Clip } from '../speech';

/** 同一句本次运行只合成一次；失败也记住，避免反复点时不停重试。 */
export const createSentenceClipCache = (load: (sentence: string) => Promise<Clip>) => {
  const cache = new Map<string, Promise<Clip | null>>();
  return (sentence: string): Promise<Clip | null> => {
    let clip = cache.get(sentence);
    if (!clip) {
      clip = load(sentence).then(result => result.url ? result : null).catch(() => null);
      cache.set(sentence, clip);
    }
    return clip;
  };
};

const sentenceClip = createSentenceClipCache(sentence => loadClip(sentence, 'en'));

export const vocabSentenceClip = (sentence: string): Promise<Clip | null> => sentenceClip(sentence);
