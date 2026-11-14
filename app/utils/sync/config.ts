// 071 同步：内置服务器地址和应用口令。
// 应用口令只用来挡外部乱请求，构建时从环境变量 VITE_SYNC_APP_KEY 读进来（本机放 app/.env.local，已被 .gitignore 忽略）。
// 仓库里不放真实口令；没配置时，同步功能显示「这个版本没有内置同步」并不可用。

/** 内置同步服务器（用户 2026-11-13 同意）。 */
export const DEFAULT_SYNC_URL = 'https://vocab.uestceee.art/sync-api';

/** 构建时写进来的应用口令；没配置返回空串。 */
export function builtInAppKey(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return (env?.VITE_SYNC_APP_KEY ?? '').trim();
}

/** 这个版本有没有内置同步（有应用口令才有）。 */
export function hasBuiltInSync(): boolean {
  return builtInAppKey().length > 0;
}

export const NO_BUILT_IN_SYNC_MESSAGE = '这个版本没有内置同步';
