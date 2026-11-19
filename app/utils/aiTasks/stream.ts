// 090 流式请求：发 stream:true，逐块解析 SSE（OpenAI 兼容格式），把「正文增量」和「思考增量」分开回调。
// 服务端不支持流式（返回的不是 text/event-stream，或明确报不支持 stream）时自动退回普通请求，整段当一次增量交出去。
// 超时、400 去掉 temperature 重试、报错不带 API key，这些沿用 modelHttp.ts 的 postCompletion。
import { ModelHttpError, postCompletion, providerDetail, RequestTimeoutError, isRequestTimeout } from '../modelHttp';

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// ---------- SSE 解析（纯函数，单测直接测） ----------

export interface DeltaChunk { text?: string; thinking?: string }

/** 把「正文里的 <think>…</think>」归到思考。标签可能被拆在两个增量中间，所以带一个小缓冲。 */
export class ThinkSplitter {
  private inThink = false;
  private pending = '';

  /** 喂一段正文增量，返回能确定归属的正文/思考。 */
  push(piece: string): DeltaChunk {
    let data = this.pending + piece;
    this.pending = '';
    let text = '';
    let thinking = '';
    for (;;) {
      const tag = this.inThink ? '</think>' : '<think>';
      const at = data.indexOf(tag);
      if (at >= 0) {
        const before = data.slice(0, at);
        if (this.inThink) thinking += before; else text += before;
        data = data.slice(at + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      // 末尾可能是标签的前半截（例如 "<thi"），先留着等下一块。
      let keep = 0;
      for (let n = Math.min(tag.length - 1, data.length); n > 0; n -= 1) {
        if (tag.startsWith(data.slice(data.length - n))) { keep = n; break; }
      }
      this.pending = data.slice(data.length - keep);
      const rest = data.slice(0, data.length - keep);
      if (this.inThink) thinking += rest; else text += rest;
      break;
    }
    return { text: text || undefined, thinking: thinking || undefined };
  }

  /** 流结束时把缓冲里剩下的吐出来（不完整的标签当普通字符）。 */
  flush(): DeltaChunk {
    const rest = this.pending;
    this.pending = '';
    if (!rest) return {};
    return this.inThink ? { thinking: rest } : { text: rest };
  }
}

/** 流式里的一条 `data:` 内容 → 增量；`[DONE]` 返回 'done'；解析不了的行返回 null。 */
export function parseSseData(payload: string, splitter: ThinkSplitter, apiKey = ''): DeltaChunk | 'done' | null {
  const body = payload.trim();
  if (!body) return null;
  if (body === '[DONE]') return 'done';
  let json: unknown;
  try { json = JSON.parse(body); } catch { return null; }
  const record = json as { error?: unknown; choices?: { delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } }[] };
  if (record?.error) {
    const err = record.error;
    const message = typeof err === 'string' ? err : (err as { message?: unknown })?.message;
    // 错误文字可能回显请求里的 API key，和普通请求的报错一样先遮掉再抛。
    throw new Error(`模型返回错误：${typeof message === 'string' ? providerDetail(message, apiKey) : '流式响应中出现错误'}`);
  }
  const delta = record?.choices?.[0]?.delta;
  if (!delta) return null;
  const out: DeltaChunk = {};
  const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
  if (reasoning) out.thinking = reasoning;
  if (typeof delta.content === 'string' && delta.content) {
    const split = splitter.push(delta.content);
    if (split.text) out.text = split.text;
    if (split.thinking) out.thinking = (out.thinking ?? '') + split.thinking;
  }
  return out.text || out.thinking ? out : null;
}

/** 增量地吃文本块，按行切；跨块断开的一行会等下一块补齐。 */
export class SseLineReader {
  private buffer = '';

  /** 返回这一块里新完成的 `data:` 行内容。 */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines.map(extractData).filter((value): value is string => value !== null);
  }

  /** 流结束时，最后一行没有换行也要处理。 */
  end(): string[] {
    const last = extractData(this.buffer);
    this.buffer = '';
    return last === null ? [] : [last];
  }
}

function extractData(line: string): string | null {
  const clean = line.replace(/\r$/, '');
  if (!clean.startsWith('data:')) return null;
  return clean.slice(5).replace(/^ /, '');
}

// ---------- 流式请求 ----------

export interface StreamRequest {
  fetchFn: FetchLike;
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  label?: string;
  /** 多久没收到任何数据就算超时（流式下是「空闲超时」，每收到一块就重新计时）。默认 90 秒。 */
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onThink?: (delta: string) => void;
}

export interface StreamResult {
  text: string;
  thinking: string;
  /** 真的是边收边处理的（false = 退回了普通请求） */
  streamed: boolean;
}

/** 用户主动取消。和超时、断网区分开。 */
export class RequestCancelledError extends Error {
  constructor() { super('已取消。'); this.name = 'RequestCancelledError'; }
}

const looksLikeStreamUnsupported = (error: unknown): boolean =>
  error instanceof ModelHttpError && [400, 404, 405, 415, 422, 501].includes(error.status) && /stream/i.test(error.message);

export async function streamCompletion(req: StreamRequest): Promise<StreamResult> {
  const idleMs = req.idleTimeoutMs ?? 90_000;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectIdle: (reason: unknown) => void = () => {};
  const idle = new Promise<never>((_resolve, reject) => { rejectIdle = reject; });
  idle.catch(() => {});
  const touch = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; controller.abort(); rejectIdle(new RequestTimeoutError(idleMs)); }, idleMs);
  };
  const onAbort = () => controller.abort();
  if (req.signal) {
    if (req.signal.aborted) throw new RequestCancelledError();
    req.signal.addEventListener('abort', onAbort, { once: true });
  }
  touch();
  const work = runStream(req, controller.signal, touch);
  work.catch(() => {});
  try {
    return await Promise.race([work, idle]);
  } catch (error) {
    if (req.signal?.aborted && !timedOut) throw new RequestCancelledError();
    if (timedOut) throw new RequestTimeoutError(idleMs);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    req.signal?.removeEventListener('abort', onAbort);
  }
}

async function runStream(req: StreamRequest, signal: AbortSignal, touch: () => void): Promise<StreamResult> {
  const label = req.label ?? '模型返回';
  let response: Response;
  let usedStream = true;
  try {
    response = await postCompletion(req.fetchFn, req.url, req.apiKey, { ...req.body, stream: true }, signal, label);
  } catch (error) {
    if (!looksLikeStreamUnsupported(error)) throw error;
    const { stream: _drop, ...rest } = req.body;
    usedStream = false;
    response = await postCompletion(req.fetchFn, req.url, req.apiKey, rest, signal, label);
  }
  touch();
  const splitter = new ThinkSplitter();
  let text = '';
  let thinking = '';
  const emit = (chunk: DeltaChunk) => {
    if (chunk.thinking) { thinking += chunk.thinking; req.onThink?.(chunk.thinking); }
    if (chunk.text) { text += chunk.text; req.onText?.(chunk.text); }
  };
  const contentType = response.headers.get('content-type') ?? '';
  const isSse = /text\/event-stream/i.test(contentType);

  if (!isSse || !usedStream) {
    // 退回普通请求：整段 JSON，当成一次增量。
    const raw = await response.text();
    touch();
    let json: { choices?: { message?: { content?: unknown; reasoning_content?: unknown } }[] };
    try { json = JSON.parse(raw.replace(/\s*data:\s*\[DONE\]\s*$/, '').trim()); }
    catch { throw new Error(`${label}格式不正确：不是有效的 JSON。`); }
    const message = json?.choices?.[0]?.message;
    const content = message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error(`${label}格式不正确：没有回答内容。`);
    const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content : '';
    if (reasoning) emit({ thinking: reasoning });
    const split = splitter.push(content);
    emit(split);
    emit(splitter.flush());
    return { text: text.trim(), thinking: thinking.trim(), streamed: false };
  }

  const lines = new SseLineReader();
  let finished = false;
  const handle = (payloads: string[]) => {
    for (const payload of payloads) {
      const parsed = parseSseData(payload, splitter, req.apiKey);
      if (parsed === 'done') { finished = true; return; }
      if (parsed) emit(parsed);
    }
  };
  const decoder = new TextDecoder();
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        touch();
        handle(lines.push(decoder.decode(value, { stream: true })));
        if (finished) break;
      }
    } finally {
      // 提前结束（[DONE]、取消、超时）时让底层连接释放。
      reader.cancel().catch(() => {});
    }
  } else {
    // 少数环境拿不到 body 流：只能整段读完再解析（等于没有流式，但结果不丢）。
    usedStream = false;
    handle(lines.push(await response.text()));
  }
  if (!finished) handle(lines.end());
  emit(splitter.flush());
  if (!text.trim()) throw new Error(`${label}格式不正确：没有回答内容。`);
  return { text: text.trim(), thinking: thinking.trim(), streamed: usedStream };
}

/** 报错转成给用户看的一句话（不带 API key）：ModelHttpError 和「模型返回…」「尚未配置…」原样，超时/断网换成固定说法。 */
export function streamErrorText(error: unknown): string {
  if (error instanceof RequestCancelledError) return '已取消。';
  if (error instanceof Error && (error.message.startsWith('模型返回') || error.message.startsWith('尚未配置') || error instanceof ModelHttpError)) return error.message;
  if (error instanceof RequestTimeoutError || isRequestTimeout(error)) return '请求超时，请检查网络后重试。';
  return '连接模型失败，请检查网络、接口地址和密钥后重试。';
}
