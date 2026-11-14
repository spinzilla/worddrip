// 071 同步：和同步服务（server/sync，协议见 docs/tasks/070）说话，以及「先推后拉」的整个流程。
// 本机词库的读写在 Rust（vocab/sync.rs 的 sync_* 命令）；这里只管联网和把两边接起来。
// 应用口令、空间密钥、同步码只存在内存和本机设置里：不写日志，也不放进错误信息。
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { DEFAULT_SYNC_URL } from './config';

export interface SyncTarget {
  baseUrl: string;
  appKey: string;
  spaceId: string;
  spaceSecret: string;
}
export interface SpaceInfo {
  rows: number;
  bytes: number;
  quotaBytes: number;
  createdAt: number;
}
export interface SyncResult {
  pushed: number;
  pulled: number;
  skipped: number;
  ms: number;
  error?: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type InvokeLike = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
/** 测试时可换掉联网和调 Rust 的函数。 */
export interface SyncDeps {
  fetch?: FetchLike;
  invoke?: InvokeLike;
}

const BATCH = 500;
const TIMEOUT_MS = 30_000;
const MAX_ROUNDS = 10_000;

export class SyncError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'SyncError';
  }
}

/** 把 HTTP 状态翻成中文原因。 */
export function messageForStatus(status: number): string {
  if (status === 401) return '同步码不对，或者这个同步空间已被删除。请重新输入同步码或重新创建空间。';
  if (status === 403) return '同步名额已满，暂时不能创建新的同步空间。等有空位后再试，或先用「整库搬家」在设备之间复制词库。';
  if (status === 413) return '一次要同步的数据太大，服务器拒绝了。';
  if (status === 429) return '操作太频繁了，请过一会儿再试。';
  if (status === 507) return '同步空间已满，不能再存更多数据。可以在「危险操作」里删除服务器上的同步数据后重新开启。';
  if (status === 503) return '同步服务还没配置好，请稍后再试。';
  if (status >= 500) return `同步服务器出错了（HTTP ${status}），请稍后再试。`;
  return `同步请求被拒绝（HTTP ${status}）。`;
}

function base(url: string): string {
  return url.replace(/\/+$/, '');
}

async function request(deps: SyncDeps, t: { baseUrl: string; appKey: string; space?: { id: string; secret: string } }, method: string, path: string, body?: unknown): Promise<Response> {
  // 隔离开发窗口关了 http 插件，测试脚本可换成浏览器 fetch；发布版不读（同 ai.ts）。
  const devFetch = import.meta.env?.DEV && typeof window !== 'undefined' ? window.__ES_E2E_HTTP_FETCH__ : undefined;
  const doFetch = deps.fetch ?? (devFetch as FetchLike | undefined) ?? (tauriFetch as unknown as FetchLike);
  const headers: Record<string, string> = { 'X-App-Key': t.appKey };
  if (t.space) headers.Authorization = `Bearer ${t.space.id}.${t.space.secret}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await doFetch(`${base(t.baseUrl)}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
  } catch (e) {
    const timedOut = controller.signal.aborted;
    // 不把底层错误原文放进去：有的实现会带上完整地址和请求头。
    void e;
    throw new SyncError(timedOut ? '连接同步服务器超时，请检查网络后再试。' : '连不上同步服务器，请检查网络后再试。');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new SyncError(messageForStatus(res.status), res.status);
  return res;
}

const spaceOf = (t: SyncTarget) => ({ id: t.spaceId, secret: t.spaceSecret });

/** 建一个新的同步空间；返回的密钥只在这一次出现。 */
export async function createSpace(opts: { baseUrl?: string; appKey: string }, deps: SyncDeps = {}): Promise<{ spaceId: string; spaceSecret: string }> {
  const res = await request(deps, { baseUrl: opts.baseUrl ?? DEFAULT_SYNC_URL, appKey: opts.appKey }, 'POST', '/spaces', {});
  const j = (await res.json()) as { space_id: string; space_secret: string };
  return { spaceId: j.space_id, spaceSecret: j.space_secret };
}

/** 删除这个同步空间和它在服务器上的全部数据（本机数据不动）。 */
export async function deleteSpace(t: SyncTarget, deps: SyncDeps = {}): Promise<void> {
  await request(deps, { baseUrl: t.baseUrl, appKey: t.appKey, space: spaceOf(t) }, 'DELETE', '/space');
}

export async function spaceInfo(t: SyncTarget, deps: SyncDeps = {}): Promise<SpaceInfo> {
  const res = await request(deps, { baseUrl: t.baseUrl, appKey: t.appKey, space: spaceOf(t) }, 'GET', '/space');
  const j = (await res.json()) as { rows: number; bytes: number; quota_bytes: number; created_at: number };
  return { rows: j.rows, bytes: j.bytes, quotaBytes: j.quota_bytes, createdAt: j.created_at };
}

interface ChangeOut {
  table: string;
  id: string;
  updated_at: number;
  deleted: boolean;
  data: unknown;
}
interface PullPage {
  changes: Array<{ seq: number; table: string; id: string; updated_at: number; deleted: boolean; device_id: string; data: unknown }>;
  cursor: number;
  more: boolean;
}

let running = false;

/** 先推后拉做一次同步。同一时间只允许一次；出错不抛，写在返回的 error 里（本机数据一直是完整的）。 */
export async function syncNow(t: SyncTarget, deps: SyncDeps = {}): Promise<SyncResult> {
  const started = Date.now();
  const result: SyncResult = { pushed: 0, pulled: 0, skipped: 0, ms: 0 };
  if (running) return { ...result, error: '上一次同步还没结束，请稍等。' };
  running = true;
  const call = deps.invoke ?? (tauriInvoke as unknown as InvokeLike);
  const ctx = { baseUrl: t.baseUrl, appKey: t.appKey, space: spaceOf(t) };
  const serverKey = `${base(t.baseUrl)}#${t.spaceId}`;
  try {
    // 074：先确认真的连得上服务器，再让本机落下「这个服务器第一次同步」的状态（否则填错地址会把整库标成待推送）。
    await request(deps, { baseUrl: t.baseUrl, appKey: t.appKey }, 'GET', '/health');
    const begin = await call<{ device_id: string; cursor: number }>('sync_begin', { request: { server_key: serverKey } });
    // 推：每批最多 500 条；服务端收下后才清本机「待推送」标记。
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const batch = await call<ChangeOut[]>('sync_collect', { request: { limit: BATCH } });
      if (batch.length === 0) break;
      await request(deps, ctx, 'POST', '/push', { device_id: begin.device_id, changes: batch });
      const cleared = await call<number>('sync_ack', { request: { items: batch.map(c => ({ table: c.table, id: c.id, updated_at: c.updated_at })) } });
      result.pushed += batch.length;
      if (cleared === 0) break; // 这一批推送期间全被改过了：下次同步再推，别在这里打转
    }
    // 拉：按 cursor 分页，一页一个事务。
    let cursor = begin.cursor;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await request(deps, ctx, 'GET', `/pull?since=${cursor}&limit=${BATCH}`);
      const page = (await res.json()) as PullPage;
      const next = Math.max(cursor, page.cursor ?? cursor);
      // 074：本机自己推上去的回声不应用也不计数。服务端同一行只留最新一条，是自己的就说明本机已是这个版本；cursor 照常前移。
      const foreign = page.changes.filter(c => c.device_id !== begin.device_id);
      const applied = await call<{ applied: number; skipped: number }>('sync_apply', {
        request: { server_key: serverKey, changes: foreign, cursor: next },
      });
      result.pulled += applied.applied;
      result.skipped += applied.skipped;
      cursor = next;
      if (!page.more || page.changes.length === 0) break;
    }
    await call<void>('sync_finish', { request: { server_key: serverKey } });
  } catch (e) {
    result.error = e instanceof SyncError ? e.message : '同步时本机出错了，请再试一次；如果一直这样，请在设置里重置同步状态。';
  } finally {
    running = false;
    result.ms = Date.now() - started;
  }
  return result;
}
