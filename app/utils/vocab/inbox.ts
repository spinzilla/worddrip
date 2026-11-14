import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getAIConfig, getEndpoint, readJsonBody } from '../aiConfig';
import { isRequestTimeout, ModelHttpError, postCompletion, RequestTimeoutError, withRequestTimeout } from '../modelHttp';

// 068：单张原图放宽到 20MB（发给模型前会先缩小到长边 2000px）。
export const INBOX_IMAGE_LIMIT = 20 * 1024 * 1024;

export interface InboxImage {
  base64: string;
  mimeType: 'image/png' | 'image/jpeg';
}

export interface InboxRecognizedWord {
  word: string;
  note: string;
  uncertain: boolean;
}

export interface InboxImageFile {
  name: string;
  size: number;
  type: string;
}

export const normalizeInboxWord = (word: string): string =>
  word.trim().split(/\s+/).join(' ').toLowerCase();

export const inboxImageMime = (file: InboxImageFile): 'image/png' | 'image/jpeg' | null => {
  if (file.type === 'image/png' || file.type === 'image/jpeg') return file.type;
  if (file.type) return null;
  if (/\.png$/i.test(file.name)) return 'image/png';
  if (/\.jpe?g$/i.test(file.name)) return 'image/jpeg';
  return null;
};

export const validateInboxImage = (file: InboxImageFile): string => {
  if (!inboxImageMime(file)) return '请选择 PNG 或 JPG 图片。';
  if (file.size <= 0) return '图片是空文件，请重新选择。';
  if (file.size > INBOX_IMAGE_LIMIT) return '图片超过 20 MB，请压缩后再试。';
  return '';
};

const malformed = (): Error => new Error('模型返回格式不正确：需要 {"words":[{"word":"词目","note":"备注","uncertain":false}]}。');

/** 只接受完整 JSON 或完整 Markdown 代码块，不猜测夹杂在散文里的 JSON。 */
export const parseInboxResponse = (content: string): InboxRecognizedWord[] => {
  const fenced = content.match(/^\s*```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?\s*```\s*$/i);
  const source = fenced ? fenced[1] : content;
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw malformed(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed();
  const words = (value as { words?: unknown }).words;
  if (!Array.isArray(words) || words.length > 200) throw malformed();
  return words.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw malformed();
    const { word, note, uncertain } = item as Record<string, unknown>;
    if (typeof word !== 'string' || !word.trim() || word.length > 200
      || typeof note !== 'string' || note.length > 2000 || typeof uncertain !== 'boolean') {
      throw malformed();
    }
    return { word: word.trim(), note: note.trim(), uncertain };
  });
};

const PROMPT = `请识别这页笔记图片里的英文词目和对应备注。笔记里可能有中文释义、例句、划线和箭头，只提取英文词目/短语和它旁边的备注。只返回一个 JSON 对象，不要用 Markdown 代码块，格式严格为：
{"words":[{"word":"词目","note":"备注","uncertain":false}]}
每个条目都必须有 word、note、uncertain 三个字段；没有备注时 note 用空字符串。看不清或拿不准时 uncertain 用 true，不要猜成确定结果。没有识别到词条时返回 {"words":[]}。`;

declare global {
  interface Window {
    /** 仅供隔离开发窗口接本机假模型；发布版不会读取。 */
    __ES_E2E_HTTP_FETCH__?: typeof fetch;
  }
}

/** 一页识别过程中的进度回调：stage 由请求进展触发，chars 是流式已收到的字数。 */
export interface RecognizeHooks {
  onStage?: (stage: 'uploading' | 'waiting' | 'streaming') => void;
  onChars?: (chars: number) => void;
}

export interface RecognizeOptions {
  timeoutMs?: number;
  /** 是否先尝试流式（默认 true）；接口不支持时自动退回一次性请求。 */
  stream?: boolean;
  hooks?: RecognizeHooks;
  /** 外部取消：置 aborted 后流式读取会停下。 */
  signal?: { aborted: boolean };
}

/**
 * 解析 OpenAI 兼容的流式（SSE）输出：喂入一段段文本，吐出新增的 content 文字。
 * 跨块被截断的行会先存着；`data: [DONE]` 结束；推理字段（reasoning_content）不算内容。
 */
export const createSseParser = () => {
  let buffer = '';
  let done = false;
  const lineDelta = (line: string): string => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return '';
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') { done = true; return ''; }
    try {
      const json = JSON.parse(data) as { choices?: { delta?: { content?: unknown }; message?: { content?: unknown } }[] };
      const choice = json?.choices?.[0];
      const piece = choice?.delta?.content ?? choice?.message?.content;
      return typeof piece === 'string' ? piece : '';
    } catch { return ''; }
  };
  return {
    feed(chunk: string): string {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      return lines.map(lineDelta).join('');
    },
    /** 流结束时处理最后没换行的一行。 */
    end(): string {
      const rest = buffer;
      buffer = '';
      return lineDelta(rest);
    },
    get done() { return done; },
  };
};

/** 读完一个流式响应体，返回拼好的完整文字；每收到内容就回调当前总字数。 */
export const readSseContent = async (
  body: ReadableStream<Uint8Array>,
  onChars?: (chars: number) => void,
  signal?: { aborted: boolean },
): Promise<string> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  let content = '';
  const push = (piece: string) => {
    if (!piece) return;
    content += piece;
    onChars?.(content.length);
  };
  try {
    for (;;) {
      if (signal?.aborted) { await reader.cancel().catch(() => {}); break; }
      const { value, done } = await reader.read();
      if (done) break;
      push(parser.feed(decoder.decode(value, { stream: true })));
      if (parser.done) { await reader.cancel().catch(() => {}); break; }
    }
    push(parser.feed(decoder.decode()));
    push(parser.end());
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return content;
};

export const recognizeInboxImage = async (
  image: InboxImage,
  options: RecognizeOptions = {},
): Promise<InboxRecognizedWord[]> => {
  const endpoint = getEndpoint();
  const config = getAIConfig();
  if (!endpoint || !config.model.trim()) {
    throw new Error('请先在设置中配置 OpenAI 兼容接口、API Key 和视觉模型。');
  }
  const hooks = options.hooks ?? {};
  const wantStream = options.stream !== false;
  const baseTimeout = options.timeoutMs ?? 60_000;
  const devFetch = import.meta.env.DEV && typeof window !== 'undefined'
    ? window.__ES_E2E_HTTP_FETCH__ : undefined;
  const requestFetch = devFetch ?? tauriFetch;
  const payload = (stream: boolean): Record<string, unknown> => ({
    model: config.model,
    temperature: 0,
    ...(stream ? { stream: true } : {}),
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PROMPT },
        { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } },
      ],
    }],
  });
  /** 一次请求；stream 为 true 时按 SSE 读，服务端不按流返回（普通 JSON）也能接住。 */
  const attempt = async (stream: boolean): Promise<string> => {
    hooks.onStage?.('uploading');
    // 请求头回来之前没法知道「上传完」的确切时刻，约 1 秒后就当作已上传、在等模型。
    const waitTimer = setTimeout(() => hooks.onStage?.('waiting'), 1000);
    try {
      return await withRequestTimeout(stream ? (options.timeoutMs ?? 120_000) : baseTimeout, async signal => {
        const res = await postCompletion(requestFetch, `${endpoint.baseUrl}/chat/completions`, endpoint.apiKey,
          payload(stream), signal, '视觉模型返回');
        const type = res.headers?.get?.('content-type') ?? '';
        if (stream && res.body && /event-stream/i.test(type)) {
          clearTimeout(waitTimer);
          hooks.onStage?.('streaming');
          const text = await readSseContent(res.body, chars => hooks.onChars?.(chars), options.signal);
          if (!text) throw new Error('STREAM_EMPTY');
          return text;
        }
        const body = await readJsonBody<{ choices?: { message?: { content?: unknown } }[] }>(res);
        const content = body?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw malformed();
        return content;
      });
    } finally {
      clearTimeout(waitTimer);
    }
  };
  try {
    let content: string;
    if (wantStream) {
      try {
        content = await attempt(true);
      } catch (error) {
        const timedOut = error instanceof RequestTimeoutError || isRequestTimeout(error);
        // 服务端明说「不认这个请求」（400/404/405/415/422/501）、流里没内容、读流出错 → 退回一次性请求；
        // 密钥错、限流、服务器 5xx 这类退回去多半一样失败，不重发。
        const httpRefused = error instanceof ModelHttpError && ![400, 404, 405, 415, 422, 501].includes(error.status);
        const fallbackable = !timedOut && !httpRefused && !options.signal?.aborted;
        if (!fallbackable) throw error;
        // 不支持流式、报错或流里什么都没有：退回现在的一次性请求。
        content = await attempt(false);
      }
    } else {
      content = await attempt(false);
    }
    return parseInboxResponse(content);
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith('模型返回格式') || error.message.startsWith('视觉模型返回 HTTP'))) {
      throw error;
    }
    // 超时以我们自己的计时器为准；isRequestTimeout 只作兜底（例如调用方自己传了已超时的信号）。
    if (error instanceof RequestTimeoutError || isRequestTimeout(error)) {
      throw new Error('识别超时，请检查网络后重试。');
    }
    // 不把底层异常或响应正文带给界面，避免服务商把密钥回显到错误里。
    throw new Error('连接视觉模型失败，请检查网络、接口地址和密钥后重试。');
  }
};
