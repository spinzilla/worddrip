import type { BrowseData, ExampleScene, VocabExample } from './types';
import { findTargetForms } from './recall';
import { wordKey } from './library';
import { sceneKey } from './scenes';
import type { SceneLabel } from './scenes';

/**
 * 049 按场景找词（纯函数 + 补标循环；测试：node test-vocab-scene-browse.mjs）。
 *
 * - 例句从两处来：词库例句（复习词的释义例句）和「我的例句」（043）。同一个词、同一句只出现一行。
 * - 场景标签按句子文字存（048 的 example_scene），这里用 sceneKey 去查，不改存储。
 * - 补标：只挑「还没有任何标签」的句子，按词分组，一个词一次请求；手动标过的句子根本不进请求，后端也不会覆盖。
 */

export type ExampleFrom = '词库' | '我的例句';

export interface SceneRow {
  /** 展示用的词（原写法）。 */
  word: string;
  /** 词库分组键（和 library.ts 的 wordKey 一致），点词时用它打开详情。 */
  wordKey: string;
  /** 句子（空白已合并）。 */
  sentence: string;
  from: ExampleFrom;
}

/** 把词库例句和我的例句摊平成一行一句。 */
export function buildSceneRows(data: BrowseData, examples: readonly VocabExample[]): SceneRow[] {
  const seen = new Set<string>();
  const rows: SceneRow[] = [];
  const add = (word: string, sentence: string, from: ExampleFrom) => {
    const text = sentence.split(/\s+/).filter(Boolean).join(' ');
    const key = sceneKey(text);
    if (!key || !word.trim()) return;
    const owner = wordKey(word);
    const id = `${owner}|${key}`;
    if (seen.has(id)) return;
    seen.add(id);
    rows.push({ word: word.trim(), wordKey: owner, sentence: text, from });
  };
  for (const entry of data.reviewWords) {
    for (const definition of entry.definitions ?? []) {
      for (const example of definition.examples) add(entry.word, example.sentence, '词库');
    }
  }
  for (const example of examples) add(example.word, example.sentence, '我的例句');
  return rows;
}

/** 每个场景有多少句（只数有标签的）。所有 10 个场景都有键，没有的是 0。 */
export function countByScene(rows: readonly SceneRow[], scenes: ReadonlyMap<string, ExampleScene>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const scene = scenes.get(sceneKey(row.sentence))?.scene;
    if (scene) counts[scene] = (counts[scene] ?? 0) + 1;
  }
  return counts;
}

/** 已经有标签（AI 或手动）的句子数。 */
export function labelledCount(rows: readonly SceneRow[], scenes: ReadonlyMap<string, ExampleScene>): number {
  return rows.filter(row => scenes.has(sceneKey(row.sentence))).length;
}

/** 选中一个场景后的行：按词、再按句子排序，稳定展示。 */
export function rowsForScene(rows: readonly SceneRow[], scenes: ReadonlyMap<string, ExampleScene>, scene: string): SceneRow[] {
  return rows
    .filter(row => scenes.get(sceneKey(row.sentence))?.scene === scene)
    .sort((a, b) => a.word.localeCompare(b.word) || a.sentence.localeCompare(b.sentence));
}

export interface BackfillGroup { word: string; sentences: string[] }

/** 还没有任何标签的句子，按词分组（同一个词的同一句只留一份）。按词排序。 */
export function backfillGroups(rows: readonly SceneRow[], scenes: ReadonlyMap<string, ExampleScene>): BackfillGroup[] {
  const groups = new Map<string, { word: string; sentences: string[]; keys: Set<string> }>();
  for (const row of rows) {
    const key = sceneKey(row.sentence);
    if (scenes.has(key)) continue;
    let group = groups.get(row.wordKey);
    if (!group) {
      group = { word: row.word, sentences: [], keys: new Set() };
      groups.set(row.wordKey, group);
    }
    if (group.keys.has(key)) continue;
    group.keys.add(key);
    group.sentences.push(row.sentence);
  }
  return [...groups.values()]
    .map(({ word, sentences }) => ({ word, sentences }))
    .sort((a, b) => a.word.localeCompare(b.word));
}

/** 句子里的目标词（含变形）切成若干段，hit 的那段高亮。找不到就整句不高亮。 */
export function sentenceParts(sentence: string, word: string): { text: string; hit: boolean }[] {
  const hits = findTargetForms(sentence, word);
  if (hits.length === 0) return [{ text: sentence, hit: false }];
  const parts: { text: string; hit: boolean }[] = [];
  let from = 0;
  for (const hit of hits) {
    if (hit.index < from) continue;
    if (hit.index > from) parts.push({ text: sentence.slice(from, hit.index), hit: false });
    parts.push({ text: hit.text, hit: true });
    from = hit.index + hit.text.length;
  }
  if (from < sentence.length) parts.push({ text: sentence.slice(from), hit: false });
  return parts;
}

// ---------------------------------------------------------------- 补标循环

export interface BackfillProgress {
  /** 已处理（请求过或失败过）的词数。 */
  done: number;
  total: number;
  /** 本次新标上的句子数。 */
  labelled: number;
  /** 请求或保存失败的词数（失败的词不标，下次再点补标会重试）。 */
  failed: number;
  lastError: string;
}

export interface BackfillResult extends BackfillProgress {
  /** 是不是被「停止」中断的（没处理完）。 */
  stopped: boolean;
}

export interface BackfillDeps {
  /** 一个词一次请求（生产环境是 requestSceneLabels）。 */
  request: (word: string, sentences: string[]) => Promise<SceneLabel[]>;
  /** 把这一个词标好的句子存下（AI 来源；后端不覆盖手动）。 */
  save: (labels: SceneLabel[]) => Promise<void>;
  /** 每个词开始前看一眼；为 true 就不再开新的请求。正在飞的那个请求会等它返回并保存。 */
  stopRequested: () => boolean;
  onProgress: (progress: BackfillProgress) => void;
}

/** 按词一个一个处理。某个词失败只记一笔，继续下一个；停止后已标的已经存好了。 */
export async function runBackfill(groups: readonly BackfillGroup[], deps: BackfillDeps): Promise<BackfillResult> {
  const progress: BackfillProgress = { done: 0, total: groups.length, labelled: 0, failed: 0, lastError: '' };
  for (const group of groups) {
    if (deps.stopRequested()) return { ...progress, stopped: true };
    try {
      const labels = await deps.request(group.word, group.sentences);
      if (labels.length > 0) await deps.save(labels);
      progress.labelled += labels.length;
    } catch (error) {
      progress.failed += 1;
      progress.lastError = error instanceof Error ? error.message : String(error);
    }
    progress.done += 1;
    deps.onProgress({ ...progress });
  }
  return { ...progress, stopped: false };
}
