import { aiTasks, type AiTask, type CreateTaskOutcome } from '../aiTasks';
import { getAIConfig, getEndpoint } from '../aiConfig';
import { vocabApi } from './api';
import { buildDefinitionCheckPrompt, MAX_DEFINITION_CHARS, notifyDefinitionsChanged } from './definitionEn';
import type { DefCheckArgs, DefCheckRecord } from './definitionEn';
import type { VocabDefinitionEn } from './types';

// 093：英英释义的「AI 帮我看看」走 AI 任务中心：小窗和释义区共用同一个任务。判断和改写建议、「已替换 / 不换」都记在任务的 result 里。
// 替换规则不变：只有用户点「用这个替换」才改。提示词和解析在 definitionEn.ts，没改。

/** 任务来源种类：「AI 帮我看看」。source.word 是词，source.ref 是那条释义的 id（字符串）。 */
export const DEF_CHECK_KIND = 'def-en-check';

const NOT_CONFIGURED = '尚未配置模型：请先在「设置」填写接口地址、API Key 和模型名称。';

/** 建一个「AI 帮我看看」任务。没配模型、释义为空或太长时直接给出中文原因（不建任务）。 */
export function startDefinitionCheck(word: string, item: VocabDefinitionEn): CreateTaskOutcome {
  const endpoint = getEndpoint();
  const config = getAIConfig();
  if (!endpoint || !config.model.trim()) return { ok: false, reason: NOT_CONFIGURED };
  const written = item.text.replace(/\s+/g, ' ').trim();
  if (!written) return { ok: false, reason: '先写一条再让 AI 看。' };
  if (written.length > MAX_DEFINITION_CHARS) return { ok: false, reason: `释义太长了（超过 ${MAX_DEFINITION_CHARS} 字）。` };
  const pos = item.pos ?? '';
  const args: DefCheckArgs = { id: item.id, word, pos, written };
  return aiTasks.create({
    title: `AI 看释义：${word}`,
    source: { kind: DEF_CHECK_KIND, word, ref: String(item.id) },
    prompt: buildDefinitionCheckPrompt(word, pos.trim(), written),
    mode: 'task',
    resultKind: DEF_CHECK_KIND,
    resultArgs: args,
  });
}

/** 「用这个替换」：把那条释义改成模型的建议（只在用户点了才做），并记成「已替换」。 */
export async function replaceWithSuggestion(task: AiTask): Promise<void> {
  const record = aiTasks.getTask(task.id)?.result as DefCheckRecord | undefined;
  if (!record?.check?.suggestion) throw new Error('没有可替换的改写建议。');
  if (record.replaced) return;
  await vocabApi.updateDefinitionEn({ id: record.id, pos: record.pos, text: record.check.suggestion });
  notifyDefinitionsChanged();
  aiTasks.updateResult(task.id, { ...record, replaced: true });
}

/** 「不换」或改了释义：收起（两处都收起，任务本身保留）。 */
export function dismissDefCheck(task: AiTask): void {
  const record = task.result as DefCheckRecord | undefined;
  if (record?.dismissed) return;
  aiTasks.updateResult(task.id, { id: Number(task.source.ref) || 0, pos: '', written: '', ...record, dismissed: true });
}

/** 某条释义最近一次「AI 帮我看看」任务（没有或已收起就是 undefined）。tasks 为新的在前。 */
export function visibleDefCheck(tasks: readonly AiTask[]): AiTask | undefined {
  const latest = tasks[0];
  if (!latest) return undefined;
  return (latest.result as DefCheckRecord | undefined)?.dismissed ? undefined : latest;
}
