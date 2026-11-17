// 078 英英释义：真实的查词典（本地英英词典优先，否则在线）、限速、存库、自动补全单词。
// 纯逻辑在 definitionEn.ts / definitionJob.ts；这里只接真实的词典和词库接口。
import { fromSource, getDictChoice, getDictSources, lookupYoudaoEnglish } from '../dictionary';
import { localDictsFor, localDictsReady, lookupLocal } from '../localDict';
import { vocabApi } from './api';
import { ONLINE_MIN_INTERVAL_MS, definitionKey, findDictDefinitions, notifyDefinitionsChanged } from './definitionEn';
import type { DictFinder, DictFound } from './definitionEn';
import { createDefinitionJob, createThrottle } from './definitionJob';
import { findOnlineDefinition } from './definitionEnOnline';


export const throttleOnline = createThrottle(ONLINE_MIN_INTERVAL_MS);

const localSource = (dictName: string | undefined) => (/wiktionary|wty/i.test(dictName ?? '') ? 'dict:local-wiktionary' : 'dict:local');

/** 本地英英词典 → 有道 → 用户选的在线英英来源 → 另一个。 */
export const defaultFinder: DictFinder = async word => {
  // 仅开发/真实窗口测试：用测试替身代替真实词典（不打真实网站）。正式包里 import.meta.env.DEV 为 false，这段不会生效。
  const stub = import.meta.env.DEV ? (window as unknown as { __ES_E2E_DICT__?: DictFinder }).__ES_E2E_DICT__ : undefined;
  if (stub) return stub(word);
  await localDictsReady();
  const { online, local } = getDictSources();
  if (local && localDictsFor('en').length) {
    const entries = await lookupLocal(word, 'en').catch(() => null);
    if (entries?.length) return { entries, source: localSource(entries[0].dictName), online: false };
  }
  if (!online) return null;
  return findOnlineDefinition(word, getDictChoice().en, async (source, text) => {
    if (source === 'youdao') return lookupYoudaoEnglish(text);
    return fromSource(source, text, 'en');
  }, throttleOnline);
};

/** 把查到的存进词库（词典来的重复由后端跳过），并通知界面重读。 */
export async function saveFound(word: string, found: DictFound): Promise<void> {
  await vocabApi.addDefinitionsEn({ word, source: found.source, items: found.items });
  notifyDefinitionsChanged();
}

// ---- 打开一个词时自动查一次（只查这一个词） ----
// 本次运行里查过（不管有没有结果）的词不再重复查，免得每次打开都联网。
const tried = new Set<string>();
const inflight = new Map<string, Promise<DictFound | null>>();

export function autoFetchDefinition(word: string, find: DictFinder = defaultFinder): Promise<DictFound | null> {
  const key = definitionKey(word);
  const running = inflight.get(key);
  if (running) return running;
  if (tried.has(key)) return Promise.resolve(null);
  tried.add(key);
  const work = findDictDefinitions(word, find)
    .then(async found => {
      if (!found) return null;
      await saveFound(word, found);
      return found;
    })
    .catch(() => null)
    .finally(() => { inflight.delete(key); });
  inflight.set(key, work);
  return work;
}

// ---- 一键补全：全局单例，切页面不中断 ----
let known: (word: string) => boolean = () => false;
/** 界面把「现在哪些词已有英英释义」告诉任务（每次渲染更新）。 */
export const setHasEnglish = (fn: (word: string) => boolean) => { known = fn; };

export const definitionJob = createDefinitionJob({
  find: defaultFinder,
  hasEnglish: word => known(word),
  save: saveFound,
});
