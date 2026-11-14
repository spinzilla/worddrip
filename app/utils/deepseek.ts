// 073：设置 → AI 里给没有 API Key 的人用的 DeepSeek 入口。地址、按钮动作都放这里，方便单测。
export const DEEPSEEK_DOCS_URL = 'https://api-docs.deepseek.com/zh-cn/';
export const DEEPSEEK_KEYS_URL = 'https://platform.deepseek.com/api_keys';
/** OpenAI 格式的 base_url，不带 /v1；请求发到 /chat/completions。 */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/** 「按 DeepSeek 填好」：只改接口地址；Key 和模型名原样保留（不把官方会变的模型名写死）。 */
export const applyDeepSeekBaseUrl = <T extends { baseUrl: string; apiKey: string; model: string }>(config: T): T =>
  ({ ...config, baseUrl: DEEPSEEK_BASE_URL });

/** 点链接：交给系统浏览器打开（opener 可注入，测试用替身记录地址）。 */
export const openDeepSeekLink = async (url: string, opener: (url: string) => Promise<void>): Promise<void> => {
  if (url !== DEEPSEEK_DOCS_URL && url !== DEEPSEEK_KEYS_URL) throw new Error('只能打开 DeepSeek 官方页面。');
  await opener(url);
};
