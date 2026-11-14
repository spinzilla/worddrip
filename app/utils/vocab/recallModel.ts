import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getAIConfig, getEndpoint, readJsonBody } from '../aiConfig';
import { postCompletion } from '../modelHttp';
import type { ModelQuestionDraft, ModelQuestionRequest, UsageDraft, UsageRequest } from './recall';

/**
 * 复习出题的模型客户端（030）：只负责请求和解析格式，题目是否合格由 recall.ts 的 questionFromDraft 把关。
 * 只发词、词性和词库释义，不发复习备注；错误信息里不带响应正文，避免服务商把密钥回显出来。
 */

declare global {
  interface Window {
    /** 仅供隔离开发窗口接本机假模型；发布版不会读取。 */
    __ES_E2E_HTTP_FETCH__?: typeof fetch;
    /** 仅供开发窗口：030–037 的老验收脚本专测填空流程，设为 true 时不混入改写/造句题；发布版不会读取。 */
    __ES_E2E_FILL_ONLY__?: boolean;
  }
}

/** 这一轮要不要混入改写/造句题（038）。发布版永远是 true；只有开发窗口的老验收脚本能关掉。 */
export function usageMixEnabled(): boolean {
  return !(import.meta.env.DEV && typeof window !== 'undefined' && window.__ES_E2E_FILL_ONLY__ === true);
}

const MAX_ITEMS = 20;
const MAX_FIELD = 600;

/** 设置里配好了接口、密钥和模型名才算可用。 */
export function hasQuestionModel(): boolean {
  return getEndpoint() !== null && getAIConfig().model.trim().length > 0;
}

const malformed = (): Error => new Error('模型返回格式不正确：需要 {"questions":[{"id":"…","meaning":"…","sentence":"…[[词]]…"}]}。');

/** 只接受完整 JSON 或完整 Markdown 代码块，不从散文里猜 JSON。 */
export function parseModelQuestions(content: string): ModelQuestionDraft[] {
  const fenced = content.match(/^\s*```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?\s*```\s*$/i);
  const source = fenced ? fenced[1] : content;
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw malformed(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed();
  const questions = (value as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length > MAX_ITEMS) throw malformed();
  return questions.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw malformed();
    const { id, meaning, sentence } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !id.trim() || id.length > 200
      || typeof meaning !== 'string' || meaning.length > MAX_FIELD
      || typeof sentence !== 'string' || !sentence.trim() || sentence.length > MAX_FIELD) {
      throw malformed();
    }
    return { id: id.trim(), meaning: meaning.trim(), sentence: sentence.trim() };
  });
}

/** 出题提示词。导出供测试核对：不含复习备注、要求 [[ ]] 标记和防泄题。 */
export function buildQuestionPrompt(requests: readonly ModelQuestionRequest[]): string {
  const items = requests.map(item => ({
    id: item.id,
    target: item.word,
    pos: item.pos || undefined,
    meaning: item.english || undefined,
    chinese: item.chinese || undefined,
  }));
  return `You write fill-in-the-blank vocabulary review questions for a Chinese university student learning academic English (EAP).

For EACH item below:
1. "sentence": write ONE natural English sentence (12-30 words, academic or everyday-academic register) that uses the target expression exactly once, in whatever grammatical form fits, wrapped in double square brackets, e.g. "Without more investment, the policy could [[exacerbate]] the housing shortage."
   - The context must make the target the most reasonable answer for someone who knows the meaning.
   - Use the target in the sense given by "meaning" (if provided). Use only common, well-attested collocations; do not invent unusual ones.
   - Outside the brackets, never use the target or any word from its family (e.g. for "evaluate" do not use "evaluation").
2. "meaning": a short English paraphrase (under 20 words) of the target as used in your sentence. It must NOT contain the target or any word from its family.

Return only one JSON object, no Markdown, exactly in this shape, one entry per input id:
{"questions":[{"id":"<input id>","meaning":"...","sentence":"... [[target form]] ..."}]}

Items:
${JSON.stringify(items, null, 2)}`;
}

// ---------------------------------------------------------------- 改写 / 造句出题（038）

const usageMalformed = (): Error => new Error('模型返回格式不正确：需要 {"tasks":[{"id":"…","format":"paraphrase|compose","instruction":"…","original":"…","reference":"…[[词]]…"}]}。');

/** 只接受完整 JSON 或完整 Markdown 代码块。格式对不对在这里查，内容合不合格由 recall.ts 的 usageFromDraft 把关。 */
export function parseUsageTasks(content: string): UsageDraft[] {
  const fenced = content.match(/^\s*```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?\s*```\s*$/i);
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1] : content); } catch { throw usageMalformed(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw usageMalformed();
  const tasks = (value as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks) || tasks.length > MAX_ITEMS) throw usageMalformed();
  return tasks.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw usageMalformed();
    const raw = item as Record<string, unknown>;
    const field = (key: string, required: boolean): string => {
      const text = raw[key] ?? '';
      if (typeof text !== 'string' || text.length > MAX_FIELD || (required && !text.trim())) throw usageMalformed();
      return text.trim();
    };
    const id = field('id', true);
    if (id.length > 200) throw usageMalformed();
    return { id, format: field('format', true), instruction: field('instruction', true), original: field('original', false), reference: field('reference', true) };
  });
}

/** 改写/造句出题提示词。导出供测试核对：不发复习备注；改写题面不许出现目标词；造句要具体情境。 */
export function buildUsagePrompt(requests: readonly UsageRequest[]): string {
  const tasks = requests.map(item => ({
    id: item.id,
    format: item.format,
    target: item.word,
    pos: item.pos || undefined,
    meaning: item.english || undefined,
    chinese: item.chinese || undefined,
  }));
  return `You write vocabulary PRODUCTION tasks for a Chinese university student learning academic English (EAP). Each task checks whether the student can actively USE the target expression, not just recognise it.

For EACH task below, follow its "format":

format "paraphrase" (the student rewrites a sentence using the target, without being told the target):
- "original": ONE natural sentence (10-25 words, academic or everyday-academic register) that expresses the target's meaning with a plainer word or phrase, e.g. for "exacerbate": "Excessive energy consumption worsens air pollution in big cities." It must NOT contain the target or any word of its family (for "evaluate", not "evaluation").
- "instruction": ONE English sentence telling the student what to do. Describe the target by part of speech, register and meaning, e.g. "Rewrite the sentence using a formal verb meaning 'to make a problem or situation worse'." It must NOT contain the target or any word of its family.
- "reference": the original rewritten with the target; keep the meaning; wrap the target form in double square brackets exactly once.

format "compose" (the student writes one new sentence with the given target):
- "instruction": one or two English sentences asking for ONE sentence that uses the target (write the target exactly as given) in a CONCRETE academic or campus situation, with one or two constraints that test real usage (subject, tense, collocation or structure), e.g. "Write one sentence using comprise to describe the structure of a university course. Use the whole course as the subject and mention at least two types of module." Never ask for "any sentence".
- "original": "" (empty string).
- "reference": one good answer that meets every constraint; wrap the target form in double square brackets exactly once.

For both formats: use the target in the sense given by "meaning" (if provided); use only common, well-attested collocations, never invented "advanced" ones.

Return only one JSON object, no Markdown, exactly in this shape, one entry per input id, keeping each input's format:
{"tasks":[{"id":"<input id>","format":"paraphrase","instruction":"...","original":"...","reference":"... [[target form]] ..."}]}

Tasks:
${JSON.stringify(tasks, null, 2)}`;
}

/** 批量请求改写/造句题。没配模型直接报错。 */
export async function requestUsageTasks(requests: UsageRequest[], options: { timeoutMs?: number } = {}): Promise<UsageDraft[]> {
  if (requests.length === 0) return [];
  const content = await postChat(buildUsagePrompt(requests), options.timeoutMs);
  return parseUsageTasks(content);
}

/** 批量请求模型出题。没配模型直接报错（调用方应先用 hasQuestionModel 判断）。 */
export async function requestModelQuestions(
  requests: ModelQuestionRequest[],
  options: { timeoutMs?: number } = {},
): Promise<ModelQuestionDraft[]> {
  if (requests.length === 0) return [];
  const content = await postChat(buildQuestionPrompt(requests), options.timeoutMs);
  return parseModelQuestions(content);
}

/**
 * 发一条用户消息给设置里的模型，返回回复文本。出题（030）和判分（031）共用。
 * 报错是中文，附服务商给的原因（已遮掉密钥）；400 时去掉 temperature 重试一次（见 utils/modelHttp.ts）。
 */
export async function postChat(prompt: string, timeoutMs?: number): Promise<string> {
  const endpoint = getEndpoint();
  const config = getAIConfig();
  if (!endpoint || !config.model.trim()) {
    throw new Error('尚未配置模型：请先在「设置」填写接口地址、API Key 和模型名称。');
  }
  const devFetch = import.meta.env.DEV && typeof window !== 'undefined' ? window.__ES_E2E_HTTP_FETCH__ : undefined;
  const requestFetch = devFetch ?? tauriFetch;
  try {
    const response = await postCompletion(
      requestFetch,
      `${endpoint.baseUrl}/chat/completions`,
      endpoint.apiKey,
      { model: config.model, temperature: 0.3, messages: [{ role: 'user', content: prompt }] },
      AbortSignal.timeout(timeoutMs ?? 90_000),
    );
    const body = await readJsonBody<{ choices?: { message?: { content?: unknown } }[] }>(response);
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw malformed();
    return content;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('模型返回')) throw error;
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new Error('出题请求超时，请检查网络后重试。');
    }
    throw new Error('连接模型失败，请检查网络、接口地址和密钥后重试。');
  }
}
