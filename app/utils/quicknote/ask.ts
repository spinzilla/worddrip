import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getAIConfig, getEndpoint, readJsonBody } from '../aiConfig';
import { isRequestTimeout, postCompletion, RequestTimeoutError, withRequestTimeout } from '../modelHttp';
import type { QuickNote } from '../vocab/types';
import { quickNoteContextText } from './triage';

declare global {
  interface Window { __ES_E2E_HTTP_FETCH__?: typeof fetch }
}

export async function askAboutQuickNote(note: QuickNote): Promise<string> {
  const endpoint = getEndpoint();
  const config = getAIConfig();
  if (!endpoint || !config.model.trim()) throw new Error('尚未配置模型：请先在「设置」填写接口地址、API Key 和模型名称。');
  const context = quickNoteContextText(note.context);
  const prompt = `请用中文回答下面这条随手记中的问题。若没有明确问题，请解释它可能的意思或给出建议。\n\n随手记：\n${note.body}${context ? `\n\n记录时的上下文：\n${context}` : ''}`;
  const requestFetch = import.meta.env.DEV && typeof window !== 'undefined' ? window.__ES_E2E_HTTP_FETCH__ ?? tauriFetch : tauriFetch;
  try {
    const response = await withRequestTimeout(90_000, signal => postCompletion(requestFetch, `${endpoint.baseUrl}/chat/completions`, endpoint.apiKey,
      { model: config.model, temperature: 0.3, messages: [{ role: 'user', content: prompt }] }, signal));
    const body = await readJsonBody<{ choices?: { message?: { content?: unknown } }[] }>(response);
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('模型返回格式不正确：没有回答内容。');
    return content.trim();
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith('模型返回') || error.message.startsWith('尚未配置'))) throw error;
    if (error instanceof RequestTimeoutError || isRequestTimeout(error)) throw new Error('请求超时，请检查网络后重试。');
    throw new Error('连接模型失败，请检查网络、接口地址和密钥后重试。');
  }
}
