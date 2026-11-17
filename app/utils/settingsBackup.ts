// 083 设置自动备份 + 启动记录（读写文件的部分；纯逻辑在 settingsBackupLogic.ts）。
// 快照只存在本机数据目录（settings-snapshot.json），不上传、不进同步。
// 什么时候拍：启动时、设置改动后（防抖几秒）、安装更新前。启动时本机看起来像全新、而快照里有东西，就先问用户要不要恢复，
// 问之前不覆盖快照。
import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { appVersion } from './desktop';
import {
  appKeyCount, applyItems, buildDiagText, isSettingsKey, parseInstallTimes, parseSnapshot, secretValues, shouldOfferRestore,
  takeSnapshot, type Snapshot,
} from './settingsBackupLogic';

const DEBOUNCE_MS = 3000;

export type RestoreOffer = { at: number; version: string; keys: number } | null;
let offer: RestoreOffer = null;
let offerSnap: Snapshot | null = null;
let blocked = false; // 有待决定的恢复提示、或正在恢复时，一律不写快照（免得用「空设置」盖掉有用的快照）
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

export const useRestoreOffer = (): RestoreOffer =>
  useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => offer);

async function version(): Promise<string> {
  try { return await appVersion(); } catch { return ''; }
}

/** 立刻拍一份快照写到数据目录；失败只记日志，不打扰用户。 */
export async function snapshotNow(): Promise<boolean> {
  if (blocked) return false;
  try {
    const snap = takeSnapshot(localStorage, await version());
    await invoke('diag_snapshot_write', { json: JSON.stringify(snap) });
    return true;
  } catch (err) {
    console.warn('settings snapshot failed', err);
    return false;
  }
}

function schedule() {
  if (blocked) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void snapshotNow(); }, DEBOUNCE_MS);
}

// 设置散在各个模块里，各自 localStorage.setItem；在这里统一拦一下，清单里的键一变就排一次快照。
function watchStorage() {
  const proto = Storage.prototype;
  const set = proto.setItem; const del = proto.removeItem;
  proto.setItem = function (this: Storage, k: string, v: string) { set.call(this, k, v); if (this === localStorage && isSettingsKey(k)) schedule(); };
  proto.removeItem = function (this: Storage, k: string) { del.call(this, k); if (this === localStorage && isSettingsKey(k)) schedule(); };
}

async function androidTimes() {
  const bridge = (globalThis as { WorddripUpdater?: { installTimes?: () => string } }).WorddripUpdater;
  try { return parseInstallTimes(bridge?.installTimes?.()); } catch { return {}; }
}

/** 启动时调一次（在界面渲染前）：读快照 → 决定要不要问恢复 → 拍快照 → 记一行启动记录。任何一步失败都不挡启动。 */
export async function initSettingsBackup(): Promise<void> {
  try {
    const current = appKeyCount(localStorage);
    let snap: Snapshot | null = null;
    try { snap = parseSnapshot(await invoke<string | null>('diag_snapshot_read')); } catch { /* 读不到当没有 */ }
    if (shouldOfferRestore(current, snap)) {
      blocked = true; offerSnap = snap;
      offer = { at: snap.at, version: snap.version, keys: Object.keys(snap.items).length };
      emit();
    }
    watchStorage();
    if (!blocked) await snapshotNow();
    const times = await androidTimes();
    await invoke('diag_record_launch', { info: { version: await version(), keys: current, snapshotAt: snap?.at ?? null, ...times } });
  } catch (err) {
    console.warn('settings backup init failed', err);
  }
}

/** 用户点「恢复」：写回设置并刷新页面。 */
export function acceptRestore(): void {
  if (!offerSnap) return;
  applyItems(localStorage, offerSnap.items);
  offer = null; offerSnap = null; emit();
  location.reload();
}

/** 用户点「不恢复」：从现在起以当前设置为准，重新拍快照。 */
export async function declineRestore(): Promise<void> {
  blocked = false; offer = null; offerSnap = null; emit();
  await snapshotNow();
}

/** 设置 → 关于 →「复制诊断信息」要复制的文本（不含密钥）。 */
export async function diagnosticsText(): Promise<string> {
  let lines: string[] = [];
  try { lines = (await invoke<string[] | null>('diag_log_tail', { n: 20 })) ?? []; } catch { /* 没有记录 */ }
  return buildDiagText(await version(), lines, secretValues(localStorage));
}
