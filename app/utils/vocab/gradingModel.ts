import { buildGradingPrompt, finalizeGrade, parseGrade, requireTaskFields } from './grading';
import type { GradableQuestion, ModelGrade } from './grading';
import { postChat } from './recallModel';

/**
 * 句型题（031）和改写/造句题（038）交给模型判。
 * 请求通道和出题共用 postChat；这里只负责「发提示词 → 解析 JSON → 收紧判定」。
 * 失败（没配模型、断网、格式不对）一律抛中文错误，界面退回用户自评。
 */
export async function gradeWithModel(
  question: GradableQuestion,
  written: string,
  options: { timeoutMs?: number } = {},
): Promise<ModelGrade> {
  const content = await postChat(buildGradingPrompt(question, written), options.timeoutMs);
  return finalizeGrade(question, written, requireTaskFields(question, parseGrade(content)));
}
