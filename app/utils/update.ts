// 应用内更新状态机（任务卡 077）。放在 React 外面，关掉提示条也不会丢下载。
// 电脑：Tauri 官方更新器（latest.json，签名由插件校验）。
// 手机：读 android.json，自己下载 APK、核对 sha256，再调原生安装（MainActivity.kt 里的 WorddripUpdater）。
import { useSyncExternalStore } from 'react';
import { fetch as httpFetch } from '@tauri-apps/plugin-http';
import { appCacheDir, join } from '@tauri-apps/api/path';
import { writeFile } from '@tauri-apps/plugin-fs';
import { appVersion, checkForUpdate, openExternal, relaunchApp, type Update } from './desktop';
import { IS_MOBILE } from './platform';
import { dialog } from '../components/Dialog';
import { getSyncConfig, syncBeforeInstall } from './sync/manager';
import { snapshotNow } from './settingsBackup';
import { guardBeforeInstall } from './updateGuard';
import { t } from './i18n';
import {
  CHECK_EVERY_MS, CHECK_FIRST_MS, UPDATE_BASE, classifyUpdateError, compareVersions, downloadAndVerifyApk,
  fetchAndroidManifest, isNewerAndroid, shouldShowBanner, snoozeFor, type AndroidManifest, type Snooze, type UpdateErrorCode,
} from './updateLogic';

export type Phase =
  | 'idle' | 'checking' | 'latest' | 'failed'
  | 'available' | 'downloading' | 'dlFailed' | 'needPermission' | 'installing' | 'installFailed' | 'ready';

export type UpdateState = {
  phase: Phase; current: string; version: string; notes: string; pct: number | null;
  error: UpdateErrorCode | null; lastCheck: number | null; apkUrl: string;
  /** 083：点了更新、正在做安装前的同步（推送本机改动）。 */
  preparing: boolean;
};

const K_AUTO = 'worddrip.update.auto';
const K_LAST = 'worddrip.update.lastCheck';
const K_SNOOZE = 'worddrip.update.snooze';
const K_URL = 'worddrip.update.base';   // 测试用：把清单目录指到本机静态服务器
const K_DRY = 'worddrip.update.dryRun'; // 测试用：下载并校验完就停，不真的安装

const ls = {
  get: (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 存不了就算了 */ } },
};

export const autoCheckOn = (): boolean => ls.get(K_AUTO) !== '0';
export const manifestBase = (): string => (ls.get(K_URL) || UPDATE_BASE).replace(/\/+$/, '');
const dryRun = (): boolean => ls.get(K_DRY) === '1';
const readSnooze = (): Snooze => { try { return JSON.parse(ls.get(K_SNOOZE) || 'null'); } catch { return null; } };

let state: UpdateState = {
  phase: 'idle', current: '', version: '', notes: '', pct: null, error: null,
  lastCheck: Number(ls.get(K_LAST)) || null, apkUrl: '', preparing: false,
};
let update: Update | null = null;
let manifest: AndroidManifest | null = null;
let apkPath = '';
let checking: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  listeners.forEach(l => l());
}

export const useUpdate = (): UpdateState =>
  useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => state);

export const loadCurrent = () => { if (!state.current) appVersion().then(v => set({ current: v })).catch(() => {}); };

export function setAutoCheck(on: boolean) {
  ls.set(K_AUTO, on ? '1' : '0');
  listeners.forEach(l => l());
}

const FOUND: Phase[] = ['available', 'downloading', 'dlFailed', 'needPermission', 'installing', 'installFailed', 'ready'];
export const hasFound = (p: Phase) => FOUND.includes(p);

/** 要不要显示顶部提示条：有新版，且没有在「稍后」的 24 小时内（下载中、出错时一定显示）。 */
export function bannerVisible(s: UpdateState, now = Date.now()): boolean {
  if (!hasFound(s.phase)) return false;
  if (s.phase !== 'available') return true;
  return shouldShowBanner(s.version, readSnooze(), now);
}

export function snoozeUpdate() {
  if (state.version) ls.set(K_SNOOZE, JSON.stringify(snoozeFor(state.version, Date.now())));
  set({}); // 换个新对象，订阅的组件才会重画
}

// 启动和「检查更新」按钮共用一次请求；已发现新版或正在更新时，再检查不改任何东西。
// manual=true（点按钮）才显示「已是最新」「检查失败」；自动检查出错一律安静回到 idle。
export function checkUpdate(manual = false): Promise<void> {
  // 已发现新版：不重复请求，但通知界面重算一次——「稍后」到期后提示条才会自己回来。
  if (state.phase === 'available') { set({}); return Promise.resolve(); }
  if (!['idle', 'latest', 'failed'].includes(state.phase)) return Promise.resolve();
  checking ??= (async () => {
    set({ phase: 'checking' });
    try {
      if (!state.current) set({ current: await appVersion() });
      let found: { version: string; notes: string; apkUrl?: string } | null = null;
      if (IS_MOBILE) {
        const m = await fetchAndroidManifest(httpFetch as never, `${manifestBase()}/android.json`);
        if (!m) throw new Error('没有拿到安卓清单'); // 断网/404：自动检查安静跳过，手动才提示
        if (isNewerAndroid(m, state.current)) { manifest = m; found = { version: m.version, notes: m.notes, apkUrl: m.url }; }
        else manifest = null;
      } else {
        const u = await checkForUpdate();
        if (u && compareVersions(u.version, state.current) > 0) { update = u; found = { version: u.version, notes: u.body ?? '' }; }
      }
      const now = Date.now();
      ls.set(K_LAST, String(now));
      if (found) set({ phase: 'available', version: found.version, notes: found.notes, apkUrl: found.apkUrl ?? '', lastCheck: now, error: null });
      else set({ phase: 'latest', lastCheck: now });
    } catch (err) {
      // 断网、服务器没清单（404）：安静跳过。只有手动点检查时才告诉用户。
      console.warn('update check skipped', err);
      set({ phase: manual ? 'failed' : 'idle' });
    } finally {
      checking = null;
    }
  })();
  return checking;
}

/** 启动约 10 秒后查一次，之后每 6 小时一次；设置里关了「自动检查」就不查。返回清理函数。 */
export function startAutoCheck(): () => void {
  const run = () => { if (autoCheckOn()) checkUpdate(false); };
  const first = setTimeout(run, CHECK_FIRST_MS);
  const every = setInterval(run, CHECK_EVERY_MS);
  return () => { clearTimeout(first); clearInterval(every); };
}

type Bridge = { canInstall(): boolean; openInstallSettings(): void; installApk(path: string): string };
const bridge = (): Bridge | null => (globalThis as { WorddripUpdater?: Bridge }).WorddripUpdater ?? null;

declare global { interface Window { __wdInstallCalls?: string[] } }

// 没有原生桥时（电脑浏览器里做测试）：只记下「调用了安装」，不真装。
async function installApk(path: string): Promise<void> {
  const b = bridge();
  if (!b) {
    (window.__wdInstallCalls ??= []).push(path);
    set({ phase: 'ready', pct: 100 });
    return;
  }
  if (!b.canInstall()) {
    b.openInstallSettings(); // 第一次要在系统里允许「安装未知应用」
    set({ phase: 'needPermission' });
    return;
  }
  set({ phase: 'installing' });
  const r = b.installApk(path);
  if (r !== 'ok') throw new Error(r);
  // 系统安装确认是另一个界面；用户点「取消」回到应用时页面重新可见，此时还在 installing 就退回
  // 「安装失败，可重试」（apkPath 还在，重试不用重新下载）。真装成功的话应用会被系统替换掉，走不到这里。
  const onBack = () => {
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', onBack);
    if (state.phase === 'installing') set({ phase: 'installFailed', error: null });
  };
  document.addEventListener('visibilitychange', onBack);
}

async function startAndroid(): Promise<void> {
  if (!manifest) return;
  if (!apkPath) {
    apkPath = await downloadAndVerifyApk(httpFetch as never, manifest, {
      save: async bytes => {
        if (!bridge()) return '/mock/worddrip-update.apk';
        const path = await join(await appCacheDir(), 'worddrip-update.apk');
        await writeFile(path, bytes);
        return path;
      },
    }, pct => set({ pct }));
  }
  // 没有原生桥（浏览器测试）时 installApk 本身就是替身：只记录调用。有原生桥又开了 dryRun 才停在安装前。
  if (dryRun() && bridge()) { set({ phase: 'ready', pct: 100 }); return; }
  try {
    await installApk(apkPath);
  } catch (err) {
    console.error('install failed', err);
    set({ phase: 'installFailed', error: null });
  }
}

async function startDesktop(): Promise<void> {
  if (!update) return;
  let total = 0;
  let got = 0;
  await update.download(ev => {
    if (ev.event === 'Started') total = ev.data.contentLength ?? 0;
    if (ev.event === 'Progress') {
      got += ev.data.chunkLength;
      if (total) set({ pct: Math.min(99, Math.floor((got * 100) / total)) });
    }
  });
  set({ pct: 100 });
  if (dryRun()) { set({ phase: 'ready' }); return; }
  set({ phase: 'installing' });
  try {
    await update.install();
    await relaunchApp();
  } catch (err) {
    console.error('update install failed', err);
    set({ phase: 'installFailed' });
  }
}

/**
 * 083：点「现在更新」/下载失败后的「重试」走这里：先拍设置快照；已加入同步就先推一次，
 * 推送失败要用户确认「仍要安装」。通过后才真正开始下载安装。
 */
export async function startUpdateGuarded(): Promise<void> {
  if (state.preparing || !['available', 'dlFailed'].includes(state.phase)) return;
  set({ preparing: true });
  let go = false;
  try {
    go = await guardBeforeInstall({
      snapshot: snapshotNow,
      hasSync: () => getSyncConfig() !== null,
      syncNow: syncBeforeInstall,
      // 弹确认框前先收起「正在同步…」那行，免得和「同步没成功」同时出现。
      confirmUnsynced: async () => { set({ preparing: false }); return (await dialog.confirm(
        t('update.unsyncedTitle'), t('update.unsyncedBody'), { ok: t('update.unsyncedGo'), cancel: t('update.unsyncedNo') },
      )) === true; },
    });
  } finally {
    set({ preparing: false });
  }
  if (go) await startUpdate();
}

/** 点「现在更新」/「重试」/（手机）允许安装后的「继续安装」。 */
export async function startUpdate(): Promise<void> {
  if (!['available', 'dlFailed', 'needPermission', 'installFailed'].includes(state.phase)) return;
  const retryInstall = state.phase === 'needPermission' || (state.phase === 'installFailed' && !!apkPath);
  set({ phase: retryInstall ? 'installing' : 'downloading', pct: retryInstall ? 100 : 0, error: null });
  try {
    if (IS_MOBILE) await startAndroid();
    else await startDesktop();
  } catch (err) {
    // 签名/sha256 不对、断网、空间不够都在这里；不会走到安装。
    console.error('update download failed', err);
    set({ phase: 'dlFailed', pct: null, error: classifyUpdateError(err) });
  }
}

/** 手机原生安装失败后的退路：用浏览器打开 APK 地址自己下。 */
export const openApkInBrowser = () => (state.apkUrl ? openExternal(state.apkUrl).catch(err => console.error(err)) : Promise.resolve());
