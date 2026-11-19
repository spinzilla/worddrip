import { aiTasks, type AiTask, type CreateTaskOutcome } from '../aiTasks';
import { getAIConfig, getEndpoint } from '../aiConfig';
import { vocabApi } from './api';
import {
  buildCheckPrompt, MAX_OWN_SENTENCE, notifyExamplesChanged, ownCheckItem, senseLabel,
} from './examples';
import type { ExampleSense, OwnCheckArgs, OwnCheckRecord, OwnSaveKind } from './examples';
import type { VocabExample } from './types';

// 「自己写一句让 AI 看看」走 AI 任务中心（090）：词条页和 AI 小窗共用同一个任务，结果和「已存 / 都不存」都记在任务的 result 里。
// 这里只放「建任务、找任务、存、收起」；判句提示词和解析规则在 examples.ts，没改。
// 093：解析函数按 resultKind 登记在 utils/aiTasks/index.ts，重启后重试也能出结果。

/** 任务来源种类：词条的「让 AI 看看」。source.word 是词，source.ref 是用户写的原句。 */
export const EXAMPLE_CHECK_KIND = 'example-own';

const NOT_CONFIGURED = '尚未配置模型：请先在「设置」填写接口地址、API Key 和模型名称。';

/** 建一个「让 AI 看」任务。没配模型、句子为空或太长时直接给出中文原因（不建任务）。 */
export function startOwnSentenceCheck(word: string, sense: ExampleSense, written: string): CreateTaskOutcome {
  const endpoint = getEndpoint();
  const config = getAIConfig();
  if (!endpoint || !config.model.trim()) return { ok: false, reason: NOT_CONFIGURED };
  const text = written.replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, reason: '先写一句再让 AI 看。' };
  if (text.length > MAX_OWN_SENTENCE) return { ok: false, reason: `句子太长了（超过 ${MAX_OWN_SENTENCE} 字），只写一句就好。` };
  const args: OwnCheckArgs = { word, sense, text };
  return aiTasks.create({
    title: `让 AI 看：${word} 的例句`,
    source: { kind: EXAMPLE_CHECK_KIND, word, ref: text },
    prompt: buildCheckPrompt(word, sense, text),
    mode: 'task',
    resultKind: EXAMPLE_CHECK_KIND,
    resultArgs: args,
  });
}

/** 存一个按钮对应的句子，并把任务的 saved 记下来（另一处界面随之变成「已存」）。 */
export async function saveOwnCheck(task: AiTask, kind: OwnSaveKind): Promise<VocabExample[]> {
  const record = task.result as OwnCheckRecord | undefined;
  const word = task.source.word;
  if (!record?.check || !word) throw new Error('这次判断还没有结果，没法存。');
  const item = ownCheckItem(kind, record);
  if (!item) throw new Error('这一句没有可存的内容。');
  const saved = await vocabApi.addExamples({ word, items: [item] });
  notifyExamplesChanged();
  aiTasks.updateResult(task.id, { ...record, saved: kind });
  return saved;
}

/**
 * 「都不存」：两处界面都收起（任务本身保留在任务中心，可以手动删）。
 * byEdit = true：是因为改了草稿才收起的，记 edited，词条页据此不把草稿清掉。
 */
export function dismissOwnCheck(task: AiTask, byEdit = false): void {
  const record = task.result as OwnCheckRecord | undefined;
  if (record?.dismissed) return;
  // 连失败的任务（没有结果）也能收起：记一个只有 dismissed 的结果，错误那句就不再显示。
  aiTasks.updateResult(task.id, { original: record?.original ?? '', sense: record?.sense ?? '', ...record, dismissed: true, ...(byEdit ? { edited: true } : {}) });
}

/** 某个词最近一次「让 AI 看看」任务（没有或已收起就是 undefined）。tasks 为 findBySource 的结果（新的在前）。 */
export function visibleOwnCheck(tasks: readonly AiTask[]): AiTask | undefined {
  const latest = tasks[0];
  if (!latest) return undefined;
  const record = latest.result as OwnCheckRecord | undefined;
  return record?.dismissed ? undefined : latest;
}
