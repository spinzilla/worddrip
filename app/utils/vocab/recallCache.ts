import { prepareRecallRound, surfaceKey, surfaceOf } from './recall';
import type { PrepareOptions, QuestionWord, RecallQuestion, RecallRound } from './recall';

/** 出好的题只保存在当前设备的 localStorage，不进同步、设置快照或整库搬家。 */
export const RECALL_CACHE_KEY = 'english-studio.vocab.recall-pending.v1';
export const RECALL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RecallCacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface CacheEntry {
  fingerprint: string;
  /** 出题方式（有没有模型、有没有混入改写/造句）；换了方式，这题作废。 */
  mode: string;
  savedAt: number;
  question: RecallQuestion;
}

type CacheData = Record<string, CacheEntry>;

const browserStorage = (): RecallCacheStorage | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; }
  catch { return null; }
};

function readCache(storage: RecallCacheStorage | null): CacheData {
  if (!storage) return {};
  try {
    const value: unknown = JSON.parse(storage.getItem(RECALL_CACHE_KEY) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as CacheData : {};
  } catch { return {}; }
}

function writeCache(storage: RecallCacheStorage | null, cache: CacheData): void {
  if (!storage) return;
  try { storage.setItem(RECALL_CACHE_KEY, JSON.stringify(cache)); } catch { /* 存储空间不足时照常完成本轮 */ }
}

/** 删掉所有过期（超过 7 天，或时间戳坏了）的条目，不只删本轮遇到的词；返回是否删过。 */
function pruneExpired(cache: CacheData, now: number): boolean {
  let removed = false;
  for (const key of Object.keys(cache)) {
    const savedAt = cache[key]?.savedAt;
    const age = now - savedAt;
    if (!Number.isFinite(savedAt) || age < 0 || age > RECALL_CACHE_TTL_MS) {
      delete cache[key];
      removed = true;
    }
  }
  return removed;
}

/** 出题方式；和 prepareRecallRound 里 usageOn 的判断保持一致。 */
function recallModeOf(options: PrepareOptions): string {
  const model = options.generate !== null;
  const mix = options.mix === true && model && Boolean(options.generateUsage);
  return `model=${model ? 1 : 0};mix=${mix ? 1 : 0}`;
}

/** 用词目、词性、英文释义、中文释义和词库例句做指纹；任一题目来源内容变了就重新出题。 */
export function recallWordFingerprint(word: QuestionWord): string {
  return JSON.stringify({
    word: word.word,
    definitions: word.definitions.map(definition => ({
      pos: definition.pos,
      english: definition.english,
      chinese: definition.chinese,
      examples: definition.examples.map(example => example.sentence),
    })),
  });
}

export function consumePendingRecallQuestion(
  wordId: string,
  storage: RecallCacheStorage | null = browserStorage(),
): void {
  const cache = readCache(storage);
  const pruned = pruneExpired(cache, Date.now());
  const had = wordId in cache;
  delete cache[wordId];
  if (had || pruned) writeCache(storage, cache);
}

/**
 * 先用缓存里有效的题占位，其余词照常出题；结果和没有缓存时的 prepareRecallRound 选中的词一样，
 * 只是有缓存的词不再请求模型。读缓存时顺手清掉所有过期条目。
 */
export async function prepareCachedRecallRound(
  queue: readonly QuestionWord[],
  options: PrepareOptions,
  storage: RecallCacheStorage | null = browserStorage(),
  now = Date.now(),
): Promise<RecallRound> {
  const cache = readCache(storage);
  let changed = pruneExpired(cache, now);
  const mode = recallModeOf(options);
  const valid = new Map<string, RecallQuestion>();
  for (const word of queue) {
    const entry = cache[word.id];
    if (!entry) continue;
    const age = now - entry.savedAt;
    const question = entry.question;
    const usable = Number.isFinite(entry.savedAt)
      && age >= 0 && age <= RECALL_CACHE_TTL_MS
      && entry.mode === mode
      && entry.fingerprint === recallWordFingerprint(word)
      && question?.wordId === word.id
      && Array.isArray(question.answers)
      && !(options.exclude?.has(surfaceKey(word.id, surfaceOf(question))));
    if (usable) valid.set(word.id, question);
    else { delete cache[word.id]; changed = true; }
  }

  const round = await prepareRecallRound(queue, { ...options, known: valid });

  const byId = new Map(queue.map(word => [word.id, word]));
  for (const question of round.questions) {
    const word = byId.get(question.wordId);
    if (!word || valid.has(word.id)) continue;
    cache[word.id] = { fingerprint: recallWordFingerprint(word), mode, savedAt: now, question };
    changed = true;
  }
  if (changed) writeCache(storage, cache);
  return round;
}
