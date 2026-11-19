import { aiTasks, type AiTask, type CreateTaskOutcome } from '../aiTasks';
import { getAIConfig, getEndpoint } from '../aiConfig';
import { vocabApi } from './api';
import { buildExamplePrompt, generatedItem, notifyExamplesChanged, senseLabel } from './examples';
import type { ExampleGenArgs, ExampleGenRecord, ExampleSense } from './examples';
import type { VocabExample } from './types';

// 093：「AI 给例句」走 AI 任务中心：词条页和小窗共用同一个任务。候选、勾选、已存、都不要 都记在任务的 result 里，
// 所以离开再回来还在，一处存了另一处变「已存」。这里只放「建任务、找任务、勾选、存、收起」；提示词和解析在 examples.ts，没改。

/** 任务来源种类：词条的「AI 给例句」。source.word 是词，source.ref 是所选义项的文字。 */
export const EXAMPLE_GEN_KIND = 'example-gen';

const NOT_CONFIGURED = '尚未配置模型：请先在「设置」填写接口地址、API Key 和模型名称。';

/** 建一个「AI 给例句」任务。没配模型时直接给出中文原因（不建任务）。 */
export function startExampleGen(word: string, sense: ExampleSense): CreateTaskOutcome {
  const endpoint = getEndpoint();
  const config = getAIConfig();
  if (!endpoint || !config.model.trim()) return { ok: false, reason: NOT_CONFIGURED };
  if (!word.trim()) return { ok: false, reason: '先选一个词。' };
  const args: ExampleGenArgs = { word, sense };
  return aiTasks.create({
    title: `AI 给例句：${word}`,
    source: { kind: EXAMPLE_GEN_KIND, word, ref: senseLabel(sense) },
    prompt: buildExamplePrompt(word, sense),
    mode: 'task',
    resultKind: EXAMPLE_GEN_KIND,
    resultArgs: args,
  });
}

/** 任务最新的结果（读中心里的，不用界面上可能旧的那份）。 */
const freshRecord = (taskId: string): ExampleGenRecord | undefined => aiTasks.getTask(taskId)?.result as ExampleGenRecord | undefined;

/** 勾选 / 取消勾选一句候选；已存的不能再勾。 */
export function setExampleGenPicked(taskId: string, index: number, value: boolean): void {
  const record = freshRecord(taskId);
  if (!record || record.saved.includes(index)) return;
  const picked = record.candidates.map((_, i) => (i === index ? value : (record.picked[i] ?? false)));
  aiTasks.updateResult(taskId, { ...record, picked });
}

/** 存所有勾选的候选（来源 AI生成）。存完这几句记成「已存」，勾选清掉。 */
export async function saveExampleGen(taskId: string): Promise<VocabExample[]> {
  const task = aiTasks.getTask(taskId);
  const record = freshRecord(taskId);
  const args = task?.resultArgs as ExampleGenArgs | undefined;
  if (!task || !record || !args) throw new Error('这次没有可存的句子。');
  const picks = record.candidates.map((_, i) => i).filter(i => record.picked[i] && !record.saved.includes(i));
  if (picks.length === 0) throw new Error('先勾选想存的句子。');
  const saved = await vocabApi.addExamples({ word: args.word, items: picks.map(i => generatedItem(record.candidates[i], args.sense)) });
  notifyExamplesChanged();
  const latest = freshRecord(taskId) ?? record;
  aiTasks.updateResult(taskId, {
    ...latest,
    saved: [...latest.saved, ...picks.filter(i => !latest.saved.includes(i))],
    picked: latest.candidates.map(() => false),
  });
  return saved;
}

/** 「都不要」或改了义项：这次的候选收起（两处都收起，任务本身保留）。 */
export function dismissExampleGen(task: AiTask): void {
  const record = task.result as ExampleGenRecord | undefined;
  if (record?.dismissed) return;
  aiTasks.updateResult(task.id, { candidates: [], picked: [], saved: [], ...record, dismissed: true });
}

/** 某个词最近一次「AI 给例句」任务（没有或已收起就是 undefined）。tasks 为新的在前。 */
export function visibleExampleGen(tasks: readonly AiTask[]): AiTask | undefined {
  const latest = tasks[0];
  if (!latest) return undefined;
  return (latest.result as ExampleGenRecord | undefined)?.dismissed ? undefined : latest;
}
