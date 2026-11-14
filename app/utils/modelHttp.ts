// 出题、判分、作文批改、手写识别共用：发 chat/completions 请求，出错时带上服务商给的原因。
//
// 为什么要这个文件（2026-11-10 用户实际碰到）：
// 1. 以前报错只写「HTTP 400」，用户和开发者都看不出该改模型名、地址还是参数。现在附上服务商返回的说明，
//    但先把密钥和像密钥的长串遮掉，最多 200 字。
// 2. 有些新模型（推理类）只接受默认 temperature，带了就回 400。遇到 400 就去掉 temperature 再试一次。

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** 把服务商的错误正文变成可以给用户看的一句话：优先取 JSON 里的 error.message，遮掉密钥，截到 200 字。 */
export function providerDetail(text: string, apiKey: string): string {
  let detail = text.trim();
  try {
    const json = JSON.parse(detail) as { error?: unknown; message?: unknown };
    const err = json?.error;
    if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') detail = (err as { message: string }).message;
    else if (typeof err === 'string') detail = err;
    else if (typeof json?.message === 'string') detail = json.message;
  } catch {
    /* 不是 JSON，就用原文 */
  }
  if (apiKey) detail = detail.split(apiKey).join('***');
  // 像密钥的长串（sk-…、Bearer 后面的、20 位以上的字母数字串）一律遮掉。
  detail = detail.replace(/Bearer\s+\S+/gi, 'Bearer ***').replace(/\b(?:sk|ntn|key)[-_][A-Za-z0-9_-]{8,}/gi, '***').replace(/[A-Za-z0-9_-]{32,}/g, '***');
  detail = detail.replace(/\s+/g, ' ').trim();
  return detail.length > 200 ? `${detail.slice(0, 200)}…` : detail;
}

/**
 * 判断一次请求失败是不是超时。
 * 浏览器/Node 的 AbortSignal 抛 AbortError；Tauri http 插件在信号触发后抛的是
 * Error('Request cancelled')，所以不能只看 error.name。只认这几种明确说法，
 * 普通断网、DNS 失败、连接被拒仍然按「连接失败」处理。
 */
export function isRequestTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  const message = error.message.trim();
  if (/^request\s+cancell?ed$/i.test(message)) return true;
  return /\b(?:timed?\s*out|timeout|deadline\s+exceeded)\b/i.test(message);
}

/** 我们自己计时触发的超时。和底层（Tauri http 插件）的报错措辞无关。 */
export class RequestTimeoutError extends Error {
  constructor(ms: number) {
    super(`请求超时（${Math.max(1, Math.round(ms / 1000))} 秒）。`);
    this.name = 'RequestTimeoutError';
  }
}

/**
 * 给一次请求套上我们自己的计时器。
 * 为什么不用 `AbortSignal.timeout` 就完事：Tauri http 插件在信号触发后抛什么错、写什么措辞
 * 都随版本变（现在见到的是 `Error('Request cancelled')`）。靠文字匹配迟早失效，
 * 所以这里自己计时：到点就 abort，并直接以 RequestTimeoutError 拒绝；
 * 底层随后才抛的错（哪怕措辞完全陌生）也会被归成超时。
 */
export async function withRequestTimeout<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new RequestTimeoutError(ms));
    }, ms);
  });
  // 用 then 包一层：run 同步抛错也变成拒绝，不会漏掉清计时器。
  const task = Promise.resolve().then(() => run(controller.signal));
  // 超时之后底层请求可能迟到地失败；先挂个空 catch，避免变成未处理的 Promise 拒绝。
  task.catch(() => {});
  try {
    return await Promise.race([task, timeout]);
  } catch (error) {
    if (timedOut) throw new RequestTimeoutError(ms);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 某次请求的 HTTP 失败，message 已是给用户看的中文。 */
export class ModelHttpError extends Error {
  constructor(public status: number, label: string, detail: string) {
    super(`${label} HTTP ${status}${detail ? `：${detail}` : ''}。请检查模型名称、接口地址和密钥。`);
    this.name = 'ModelHttpError';
  }
}

/**
 * 发一次 chat/completions；400 时去掉 temperature 重试一次。成功返回 Response，失败抛 ModelHttpError。
 * label 用在报错开头，例如「模型返回」「视觉模型返回」。
 */
export async function postCompletion(
  fetchFn: FetchLike,
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  label = '模型返回',
): Promise<Response> {
  const send = (payload: Record<string, unknown>) => fetchFn(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  let response = await send(body);
  if (response.status === 400 && 'temperature' in body) {
    const { temperature: _dropped, ...rest } = body;
    await response.text().catch(() => '');
    response = await send(rest);
  }
  if (!response.ok) {
    const detail = providerDetail(await response.text().catch(() => ''), apiKey);
    throw new ModelHttpError(response.status, label, detail);
  }
  return response;
}
