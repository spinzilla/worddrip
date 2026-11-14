import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getAIConfig, getEndpoint, readJsonBody } from '../aiConfig';
import { postCompletion } from '../modelHttp';
import type { CoachTop } from '../vocab/types';
import {
  analyzeEssay,
  buildFirstPrompt,
  buildLongCorrectionsPrompt,
  buildLongOverviewPrompt,
  buildRewritePrompt,
  parseFirstReview,
  parseRewriteReview,
  parseSentenceCorrections,
  type EssayAnalysis,
  type FirstReview,
  type PaperChoice,
  type RewriteReview,
} from './review';

declare global {
  interface Window {
    /** 仅供隔离开发窗口连接本机假模型，发布版不会读取。 */
    __ES_E2E_HTTP_FETCH__?: typeof fetch;
  }
}

async function chat(prompt: string): Promise<string> {
  const endpoint = getEndpoint();
  const config = getAIConfig();
  if (!endpoint || !config.model.trim()) {
    throw new Error('尚未配置模型：请先在「设置」填写接口地址、API Key 和模型名称。');
  }
  const devFetch = import.meta.env.DEV && typeof window !== 'undefined'
    ? window.__ES_E2E_HTTP_FETCH__ : undefined;
  const requestFetch = devFetch ?? tauriFetch;
  try {
    const response = await postCompletion(
      requestFetch,
      `${endpoint.baseUrl}/chat/completions`,
      endpoint.apiKey,
      { model: config.model, temperature: 0.2, messages: [{ role: 'user', content: prompt }] },
      AbortSignal.timeout(180_000),
    );
    const body = await readJsonBody<{ choices?: { message?: { content?: unknown } }[] }>(response);
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('模型返回格式不正确：响应中没有文字内容。');
    return content;
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith('模型返回') || error.name === 'AbortError' || error.name === 'TimeoutError')) {
      if (error.name === 'AbortError' || error.name === 'TimeoutError') throw new Error('批改请求超时，请检查网络后重试。');
      throw error;
    }
    throw new Error('批改请求失败，请检查网络和接口设置后重试。');
  }
}

export async function requestFirstReview(
  essay: string,
  choice: PaperChoice,
  top: CoachTop[],
): Promise<{ analysis: EssayAnalysis; review: FirstReview }> {
  const analysis = analyzeEssay(essay, choice);
  if (analysis.wordCount > 250) {
    const overview = parseFirstReview(await chat(buildLongOverviewPrompt(essay, analysis, top)));
    const corrections = parseSentenceCorrections(await chat(buildLongCorrectionsPrompt(essay, analysis)));
    return { analysis, review: { ...overview, corrections } };
  }
  const content = await chat(buildFirstPrompt(essay, analysis, top));
  return { analysis, review: parseFirstReview(content) };
}

/** 只能由「我改完了」或「跳过」的事件处理器调用，不能在首批评测中预取。 */
export async function requestRewriteReview(
  essay: string,
  analysis: EssayAnalysis,
  review: FirstReview,
): Promise<RewriteReview> {
  return parseRewriteReview(await chat(buildRewritePrompt(essay, analysis, review)));
}
