// 090 真实环境的 AI 任务中心单例：读模型配置、用 Tauri http 插件的 fetch 流式请求。
// 界面和调用方只 import 这里；测试用 center.ts 的 createAiTaskCenter 注入假依赖。
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getAIConfig, getEndpoint } from '../aiConfig';
import { createAiTaskCenter, type AiStreamArgs, type AiStreamResult } from './center';
import { streamCompletion, streamErrorText } from './stream';
import { parseOwnCheckRecord, parseExampleGenRecord } from '../vocab/examples';
import type { ExampleGenArgs, OwnCheckArgs } from '../vocab/examples';
import { parseDefCheckRecord } from '../vocab/definitionEn';
import type { DefCheckArgs } from '../vocab/definitionEn';
import { parseWritingTaskRecord, parseWritingReviewRecord } from '../writing/model';
import type { WritingTaskArgs, WritingReviewArgs } from '../writing/model';

declare global {
  interface Window { __ES_E2E_HTTP_FETCH__?: typeof fetch }
}

export * from './center';
export { streamCompletion, streamErrorText, RequestCancelledError, ThinkSplitter, SseLineReader, parseSseData } from './stream';

const NOT_CONFIGURED = '尚未配置模型：请先在「设置」填写接口地址、API Key 和模型名称。';

const realRun = async (args: AiStreamArgs): Promise<AiStreamResult> => {
  const endpoint = getEndpoint();
  const config = getAIConfig();
  if (!endpoint || !config.model.trim()) throw new Error(NOT_CONFIGURED);
  // 开发版真实窗口测试可以换掉请求函数（见 dev/e2e）；发布版永远用 Tauri http 插件。
  const fetchFn = import.meta.env.DEV && typeof window !== 'undefined' ? window.__ES_E2E_HTTP_FETCH__ ?? tauriFetch : tauriFetch;
  const messages = [
    ...(args.system ? [{ role: 'system', content: args.system }] : []),
    ...args.messages.map(({ role, content }) => ({ role, content })),
  ];
  return streamCompletion({
    fetchFn,
    url: `${endpoint.baseUrl}/chat/completions`,
    apiKey: endpoint.apiKey,
    body: { model: config.model, temperature: args.temperature ?? 0.3, messages },
    signal: args.signal,
    onText: args.onText,
    onThink: args.onThink,
  });
};

const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// 结构化结果的解析函数，按 resultKind 登记（093）：任务存盘，重启后点「重试」也能从这里找回。
// 新增一种结构化任务时：在这里登记一个 kind，并在创建任务时带上同样的 resultKind。
export const RESULT_PARSERS = {
  'example-own': (text: string, args: unknown) => parseOwnCheckRecord(args as OwnCheckArgs, text),
  'example-gen': (text: string, args: unknown) => parseExampleGenRecord(args as ExampleGenArgs, text),
  'def-en-check': (text: string, args: unknown) => parseDefCheckRecord(args as DefCheckArgs, text),
  'writing-task': (text: string, args: unknown) => parseWritingTaskRecord(args as WritingTaskArgs, text),
  'writing-review': (text: string, args: unknown) => parseWritingReviewRecord(args as WritingReviewArgs, text),
};

export const aiTasks = createAiTaskCenter({
  run: realRun,
  storage: typeof localStorage === 'undefined' ? null : localStorage,
  now: () => Date.now(),
  newId,
  errorText: streamErrorText,
  resultParsers: RESULT_PARSERS,
});

export const lockAiPanel = (reason: string) => aiTasks.lockPanel(reason);
export const unlockAiPanel = () => aiTasks.unlockPanel();
export const isAiPanelLocked = () => aiTasks.isLocked();
