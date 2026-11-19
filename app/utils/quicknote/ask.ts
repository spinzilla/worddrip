import { aiTasks, type CreateTaskOutcome } from '../aiTasks';
import { getAIConfig, getEndpoint } from '../aiConfig';
import type { QuickNote } from '../vocab/types';
import { quickNoteContextText } from './triage';

/** 随手记「问 AI」的任务来源种类；随手记卡片和小窗都按它找任务。 */
export const QUICKNOTE_ASK_KIND = 'quicknote';

/** 随手记卡片上的「问 AI」：建一个后台任务（090 任务中心），切页面不断，回复在 AI 小窗里看。 */
export function askAboutQuickNote(note: QuickNote): CreateTaskOutcome {
  const endpoint = getEndpoint();
  const config = getAIConfig();
  if (!endpoint || !config.model.trim()) throw new Error('尚未配置模型：请先在「设置」填写接口地址、API Key 和模型名称。');
  const context = quickNoteContextText(note.context);
  const prompt = `请用中文回答下面这条随手记中的问题。若没有明确问题，请解释它可能的意思或给出建议。\n\n随手记：\n${note.body}${context ? `\n\n记录时的上下文：\n${context}` : ''}`;
  const head = [...note.body.trim()].slice(0, 20).join('');
  const title = `问 AI：随手记 ${head}${[...note.body.trim()].length > 20 ? '…' : ''}`;
  return aiTasks.create({
    title,
    source: { kind: QUICKNOTE_ASK_KIND, noteId: String(note.id) },
    prompt,
    // 小窗里气泡只显示随手记原文；发给模型的是带说明的整段提示词。
    shown: note.body.trim(),
    mode: 'task',
  });
}
