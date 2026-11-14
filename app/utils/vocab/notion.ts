import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { isBadKey } from '../aiConfig';
import { isRequestTimeout, RequestTimeoutError, withRequestTimeout } from '../modelHttp';
import type { InboxRecognizedWord } from './inbox';

export interface NotionConfig {
  token: string;
  databaseId: string;
}

export interface NotionInboxWord extends InboxRecognizedWord {
  pageId: string;
}

export interface NotionRequestOptions {
  timeoutMs?: number;
  /** 自动测试传入本机假服务；界面永远使用 Notion 官方地址。 */
  baseUrl?: string;
}

const STORAGE_KEY = 'linguaclip_notion_config';
const OFFICIAL_BASE_URL = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export const getNotionConfig = (): NotionConfig => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { token: '', databaseId: '' };
    const config = value as Record<string, unknown>;
    return {
      token: typeof config.token === 'string' ? config.token : '',
      databaseId: typeof config.databaseId === 'string' ? config.databaseId : '',
    };
  } catch {
    return { token: '', databaseId: '' };
  }
};

export const saveNotionConfig = (config: NotionConfig) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
};

declare global {
  interface Window {
    /** 仅供隔离开发窗口接本机假 Notion；发布版不会读取。 */
    __ES_E2E_NOTION_BASE_URL__?: string;
  }
}

const malformed = (detail = '请检查「词目」「备注」「已入库」三列的名称和类型。') =>
  new Error(`Notion 返回的数据格式不正确，${detail}`);

const configured = (): NotionConfig => {
  const config = getNotionConfig();
  const token = config.token.trim();
  const databaseId = config.databaseId.trim();
  if (!token || !databaseId || isBadKey(token)) {
    throw new Error('请先在设置中填写有效的 Notion 令牌和数据库 ID。');
  }
  return { token, databaseId };
};

const request = async (
  path: string,
  init: { method: 'POST' | 'PATCH'; body: unknown },
  options: NotionRequestOptions,
): Promise<Response> => {
  const config = configured();
  const devBaseUrl = import.meta.env.DEV && typeof window !== 'undefined'
    ? window.__ES_E2E_NOTION_BASE_URL__ : undefined;
  const baseUrl = (options.baseUrl ?? devBaseUrl ?? OFFICIAL_BASE_URL).replace(/\/+$/, '');
  const devFetch = import.meta.env.DEV && typeof window !== 'undefined'
    ? window.__ES_E2E_HTTP_FETCH__ : undefined;
  const requestFetch = devFetch ?? tauriFetch;
  try {
    const res = await withRequestTimeout(options.timeoutMs ?? 30_000, signal => requestFetch(`${baseUrl}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(init.body),
      signal,
    }));
    if (res.status === 401 || res.status === 403) {
      throw new Error('Notion 令牌无效或没有数据库访问权限，请检查令牌、数据库 ID 和集成共享设置。');
    }
    if (res.status === 404) {
      throw new Error('找不到 Notion 数据库或页面，请检查 ID，并确认已共享给当前集成。');
    }
    if (res.status === 429) {
      throw new Error('Notion 请求过于频繁（429），请稍后再试。');
    }
    if (!res.ok) throw new Error(`Notion 返回 HTTP ${res.status}，请检查设置或稍后重试。`);
    return res;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Notion ')) throw error;
    // 超时以我们自己的计时器为准；isRequestTimeout 只作兜底。
    if (error instanceof RequestTimeoutError || isRequestTimeout(error)) {
      throw new Error('连接 Notion 超时，请检查网络后重试。');
    }
    // 不显示底层异常和响应正文，避免服务商把令牌回显到界面或日志。
    throw new Error('连接 Notion 失败，请检查网络后重试。');
  }
};

interface NotionText {
  plain_text?: unknown;
}

const text = (value: unknown, type: 'title' | 'rich_text'): string => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed();
  const property = value as Record<string, unknown>;
  if (property.type !== type || !Array.isArray(property[type])) throw malformed();
  return property[type].map(part => {
    if (!part || typeof part !== 'object' || typeof (part as NotionText).plain_text !== 'string') throw malformed();
    return (part as NotionText).plain_text;
  }).join('').trim();
};

const parsePage = (value: unknown): NotionInboxWord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed();
  const page = value as Record<string, unknown>;
  if (typeof page.id !== 'string' || !page.id || !page.properties || typeof page.properties !== 'object' || Array.isArray(page.properties)) {
    throw malformed();
  }
  const properties = page.properties as Record<string, unknown>;
  const imported = properties['已入库'];
  if (!imported || typeof imported !== 'object' || Array.isArray(imported)) throw malformed();
  const checkbox = imported as Record<string, unknown>;
  if (checkbox.type !== 'checkbox' || typeof checkbox.checkbox !== 'boolean') throw malformed();
  // 查询条件之外再检查一次，已勾选行即使被假服务或异常响应返回也不会进入候选。
  if (checkbox.checkbox) return null;
  const word = text(properties['词目'], 'title');
  if (!word || word.length > 200) throw malformed('「词目」不能为空，且不能超过 200 个字符。');
  const note = text(properties['备注'], 'rich_text');
  if (note.length > 2000) throw malformed('「备注」不能超过 2000 个字符。');
  return { pageId: page.id, word, note, uncertain: false };
};

export const pullNotionInbox = async (options: NotionRequestOptions = {}): Promise<NotionInboxWord[]> => {
  const { databaseId } = configured();
  const words: NotionInboxWord[] = [];
  const seenPages = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const res = await request(`/databases/${encodeURIComponent(databaseId)}/query`, {
      method: 'POST',
      body: {
        filter: { property: '已入库', checkbox: { equals: false } },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      },
    }, options);
    let body: unknown;
    try { body = await res.json(); } catch { throw malformed('查询响应不是有效 JSON。'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw malformed();
    const page = body as Record<string, unknown>;
    if (!Array.isArray(page.results) || typeof page.has_more !== 'boolean') throw malformed();
    for (const item of page.results) {
      const parsed = parsePage(item);
      if (parsed && !seenPages.has(parsed.pageId)) {
        seenPages.add(parsed.pageId);
        words.push(parsed);
      }
    }
    if (!page.has_more) cursor = undefined;
    else {
      if (typeof page.next_cursor !== 'string' || !page.next_cursor || seenCursors.has(page.next_cursor)) {
        throw malformed('分页游标缺失或重复。');
      }
      cursor = page.next_cursor;
      seenCursors.add(cursor);
    }
  } while (cursor);
  return words;
};

export const markNotionPagesImported = async (pageIds: string[], options: NotionRequestOptions = {}): Promise<void> => {
  configured();
  const uniqueIds = [...new Set(pageIds)];
  if (uniqueIds.some(id => !id.trim())) throw new Error('Notion 页面 ID 为空，无法勾选「已入库」。');
  // 逐条执行，调用方只传本次真正写入词库的页面；重复 PATCH 也是幂等的，可安全重试。
  for (const pageId of uniqueIds) {
    await request(`/pages/${encodeURIComponent(pageId)}`, {
      method: 'PATCH',
      body: { properties: { '已入库': { checkbox: true } } },
    }, options);
  }
};