// 072 同步管理：把 071 的 syncNow 接到界面上。
// 负责：本机保存同步凭证、开启/加入/退出/删除、自动同步时机、同一时间只跑一个、状态订阅。
// 同步码、空间密钥只存本机 localStorage（同 aiConfig.ts），不写日志、不放进错误信息。
import { notifyVocabChanged, onVocabChanged } from '../vocab/manualAdd';
import { notifyQuickNotesChanged } from '../quicknote/changed';
import { createSpace, deleteSpace, messageForStatus, spaceInfo, syncNow, type SpaceInfo, type SyncTarget } from './client';
import { builtInAppKey, DEFAULT_SYNC_URL, NO_BUILT_IN_SYNC_MESSAGE } from './config';
import { decodeSyncCode, encodeSyncCode } from './code';

const KEY_CONFIG = 'es_sync_config';
const KEY_STATE = 'es_sync_state';
const KEY_DEV_APP_KEY = 'es_sync_dev_app_key';
const KEY_NOTICE = 'es_sync_notice';
const KEY_URL_DRAFT = 'es_sync_url_draft';

export interface SyncConfig {
  spaceId: string;
  spaceSecret: string;
  /** 服务器地址；空串 = 用内置值。 */
  baseUrl: string;
  auto: boolean;
}
export type SyncPhase = 'off' | 'idle' | 'running';
export interface SyncState {
  phase: SyncPhase;
  lastAt: number | null;
  lastPushed: number;
  lastPulled: number;
  /** 最近一次失败原因；成功后清空。 */
  error: string;
  failStreak: number;
  info: SpaceInfo | null;
  /** 退出同步后给没开启界面看的一次性说明（比如同步空间已被删除）。 */
  notice: string;
}

export const AUTO_INTERVAL_MS = 5 * 60 * 1000;
const DEBOUNCE_MS = 4000;
const FAIL_NOTICE_AT = 3;

export function getSyncConfig(): SyncConfig | null {
  try {
    const raw = localStorage.getItem(KEY_CONFIG);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<SyncConfig>;
    if (!c.spaceId || !c.spaceSecret) return null;
    return { spaceId: c.spaceId, spaceSecret: c.spaceSecret, baseUrl: c.baseUrl ?? '', auto: c.auto !== false };
  } catch {
    return null;
  }
}
function saveConfig(c: SyncConfig | null) {
  if (c) localStorage.setItem(KEY_CONFIG, JSON.stringify(c));
  else localStorage.removeItem(KEY_CONFIG);
}

/** 应用口令：发布版只用构建时内置的；开发版允许用 localStorage 临时覆盖，方便本机联调。 */
function appKey(): string {
  const built = builtInAppKey();
  if (built) return built;
  try {
    if (import.meta.env?.DEV) return (localStorage.getItem(KEY_DEV_APP_KEY) ?? '').trim();
  } catch { /* ignore */ }
  return '';
}
export function syncAvailable(): boolean { return appKey().length > 0; }
export { NO_BUILT_IN_SYNC_MESSAGE, DEFAULT_SYNC_URL };

function targetOf(c: SyncConfig): SyncTarget {
  return { baseUrl: c.baseUrl.trim() || DEFAULT_SYNC_URL, appKey: appKey(), spaceId: c.spaceId, spaceSecret: c.spaceSecret };
}

export function currentSyncCode(): string | null {
  const c = getSyncConfig();
  return c ? encodeSyncCode(c.spaceId, c.spaceSecret) : null;
}

// ---------- 状态（内存 + localStorage 里只存「上次结果」，不含密钥） ----------

// 074：「空间被删」的说明存本机，直到用户点「知道了」。
function storedNotice(): string {
  try { return localStorage.getItem(KEY_NOTICE) ?? ''; } catch { return ''; }
}
function storeNotice(text: string) {
  try { if (text) localStorage.setItem(KEY_NOTICE, text); else localStorage.removeItem(KEY_NOTICE); } catch { /* ignore */ }
}
/** 用户点「知道了」：清掉说明。 */
export function dismissSyncNotice(): void {
  storeNotice('');
  setState({ notice: '' });
}

// 074：没开启同步时在「高级」里填的服务器地址，存本机，切分页回来还在。
export function getSyncUrlDraft(): string {
  try { return localStorage.getItem(KEY_URL_DRAFT) ?? ''; } catch { return ''; }
}
export function setSyncUrlDraft(url: string): void {
  try { if (url.trim()) localStorage.setItem(KEY_URL_DRAFT, url.trim()); else localStorage.removeItem(KEY_URL_DRAFT); } catch { /* ignore */ }
}

const listeners = new Set<() => void>();
let state: SyncState = loadState();

function loadState(): SyncState {
  const base: SyncState = { phase: getSyncConfig() ? 'idle' : 'off', lastAt: null, lastPushed: 0, lastPulled: 0, error: '', failStreak: 0, info: null, notice: storedNotice() };
  try {
    const raw = localStorage.getItem(KEY_STATE);
    if (raw && base.phase !== 'off') {
      const s = JSON.parse(raw) as Partial<SyncState>;
      return { ...base, lastAt: s.lastAt ?? null, lastPushed: s.lastPushed ?? 0, lastPulled: s.lastPulled ?? 0, error: s.error ?? '', failStreak: s.failStreak ?? 0 };
    }
  } catch { /* ignore */ }
  return base;
}
function setState(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(KEY_STATE, JSON.stringify({ lastAt: state.lastAt, lastPushed: state.lastPushed, lastPulled: state.lastPulled, error: state.error, failStreak: state.failStreak }));
  } catch { /* ignore */ }
  listeners.forEach(l => l());
}
export function getSyncState(): SyncState { return state; }
export function subscribeSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** 词库页顶部要不要给「同步失败」提示。 */
export function shouldShowFailNotice(s: SyncState = state): boolean {
  return s.phase !== 'off' && s.failStreak >= FAIL_NOTICE_AT;
}

// ---------- 动作 ----------

let ignoreChanged = 0;

/** 立即同步一次（同一时间只跑一个）；返回是否成功。 */
export async function runSync(): Promise<boolean> {
  const c = getSyncConfig();
  if (!c) return false;
  if (state.phase === 'running') return false;
  if (!syncAvailable()) { setState({ error: NO_BUILT_IN_SYNC_MESSAGE }); return false; }
  setState({ phase: 'running' });
  const r = await syncNow(targetOf(c));
  // 同步期间用户可能点了「退出同步」，那就别再写回状态。
  if (!getSyncConfig()) return false;
  if (r.error === messageForStatus(401)) {
    // 同步空间已被删除（或同步码失效）：退出同步，本机词库不动。
    leaveSync();
    const notice = '这个同步空间已被删除或同步码已失效，本机已退出同步（本机词库没有改动）。想继续同步，请重新开启，或输入新的同步码。';
    storeNotice(notice);
    setState({ notice });
    return false;
  }
  if (r.error) {
    setState({ phase: 'idle', error: r.error, failStreak: state.failStreak + 1 });
    // 401：同步码失效（空间被删了），别一直重试，提示里已有下一步建议。
    return false;
  }
  setState({ phase: 'idle', error: '', failStreak: 0, lastAt: Date.now(), lastPushed: r.pushed, lastPulled: r.pulled });
  if (r.pulled > 0) {
    ignoreChanged++;
    try { notifyVocabChanged(); notifyQuickNotesChanged(); } finally { ignoreChanged--; }
  }
  void refreshInfo();
  return true;
}

/** 083：安装更新前把本机改动推一次。别的同步正在跑就先等它结束（最多 60 秒），再自己跑一次，确保推的是最新。 */
export async function syncBeforeInstall(): Promise<boolean> {
  const c = getSyncConfig();
  if (!c) return false;
  const deadline = Date.now() + 60_000;
  while (state.phase === 'running' && Date.now() < deadline) await new Promise(r => setTimeout(r, 200));
  if (state.phase === 'running') return false;
  return runSync();
}

export async function refreshInfo(): Promise<void> {
  const c = getSyncConfig();
  if (!c || !syncAvailable()) return;
  try { setState({ info: await spaceInfo(targetOf(c)) }); } catch { /* 用量拿不到不算失败 */ }
}

function setConfigAndStart(c: SyncConfig) {
  saveConfig(c);
  storeNotice('');
  setState({ phase: 'idle', error: '', failStreak: 0, lastAt: null, lastPushed: 0, lastPulled: 0, info: null, notice: '' });
}

/** 在这台设备开启同步：建空间，成功后马上做第一次同步。失败返回中文原因。 */
export async function enableSync(baseUrl = ''): Promise<{ ok: boolean; error?: string }> {
  if (!syncAvailable()) return { ok: false, error: NO_BUILT_IN_SYNC_MESSAGE };
  try {
    const sp = await createSpace({ baseUrl: baseUrl.trim() || DEFAULT_SYNC_URL, appKey: appKey() });
    setConfigAndStart({ spaceId: sp.spaceId, spaceSecret: sp.spaceSecret, baseUrl: baseUrl.trim(), auto: true });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '创建同步空间失败。' };
  }
  await runSync();
  return { ok: true };
}

/** 用同步码加入另一台设备的同步。抄错返回「同步码有误」。 */
export async function joinSync(code: string, baseUrl = ''): Promise<{ ok: boolean; error?: string }> {
  if (!syncAvailable()) return { ok: false, error: NO_BUILT_IN_SYNC_MESSAGE };
  let parsed: { spaceId: string; spaceSecret: string };
  try { parsed = decodeSyncCode(code); } catch { return { ok: false, error: '同步码有误' }; }
  const cfg: SyncConfig = { spaceId: parsed.spaceId, spaceSecret: parsed.spaceSecret, baseUrl: baseUrl.trim(), auto: true };
  // 先确认服务器认这个码，再保存，免得存下一个无效码。
  try { await spaceInfo(targetOf(cfg)); } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '连不上同步服务器。' };
  }
  setConfigAndStart(cfg);
  await runSync();
  return { ok: true };
}

/** 这台设备退出同步：只清本机凭证，服务器数据保留。 */
export function leaveSync(): void {
  saveConfig(null);
  storeNotice('');
  try { localStorage.removeItem(KEY_STATE); } catch { /* ignore */ }
  setState({ phase: 'off', error: '', failStreak: 0, lastAt: null, lastPushed: 0, lastPulled: 0, info: null, notice: '' });
}

/** 删除服务器上的同步数据（所有设备都会断开）；本机词库不动。 */
export async function deleteRemoteSync(): Promise<{ ok: boolean; error?: string }> {
  const c = getSyncConfig();
  if (!c) return { ok: true };
  try { await deleteSpace(targetOf(c)); } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '删除失败。' };
  }
  leaveSync();
  return { ok: true };
}

export function setAutoSync(auto: boolean): void {
  const c = getSyncConfig();
  if (c) saveConfig({ ...c, auto });
  setState({});
}
export function setSyncBaseUrl(baseUrl: string): void {
  const c = getSyncConfig();
  if (c) saveConfig({ ...c, baseUrl: baseUrl.trim() });
  setState({});
}

// ---------- 自动同步 ----------

let timer: ReturnType<typeof setTimeout> | null = null;

/** 有改动时调：已开启且自动同步开着，稍等几秒合并多次请求后同步一次。 */
export function requestSync(): void {
  const c = getSyncConfig();
  if (!c || !c.auto) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void runSync(); }, DEBOUNCE_MS);
}

let started = false;
/** 应用启动时调一次：启动同步、回到前台同步、每 5 分钟同步、词库变了就同步。 */
export function startAutoSync(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const auto = () => { const c = getSyncConfig(); if (c?.auto) void runSync(); };
  setTimeout(auto, 1500);
  setInterval(auto, AUTO_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') auto(); });
  onVocabChanged(() => { if (ignoreChanged === 0) requestSync(); });
}
