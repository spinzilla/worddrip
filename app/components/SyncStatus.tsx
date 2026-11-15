import React, { useSyncExternalStore } from 'react';
import { getSyncState, shouldShowFailNotice, subscribeSync } from '../utils/sync';

const GOTO = 'es-goto-sync-settings';
let pendingTab = false;
/** 设置页打开时问一声：是不是从「同步失败」提示点进来的。 */
export const consumeSyncTabRequest = (): boolean => { const v = pendingTab; pendingTab = false; return v; };
let pendingJoin = false;
/** 083：新装引导里点「输入同步加入码」→ 进同步设置并直接展开「加入」输入框。 */
export const requestSyncJoin = () => { pendingTab = true; pendingJoin = true; window.dispatchEvent(new Event(GOTO)); };
export const peekSyncJoinRequest = (): boolean => pendingJoin;
export const clearSyncJoinRequest = () => { pendingJoin = false; };
export const onGotoSyncSettings = (fn: () => void): (() => void) => { window.addEventListener(GOTO, fn); return () => window.removeEventListener(GOTO, fn); };

/** 导航「设置」旁的小圆点：同步中（呼吸）/ 正常（绿）/ 失败（红）；没开同步不显示。 */
export function SyncDot({ onDark }: { onDark?: boolean }) {
  const s = useSyncExternalStore(subscribeSync, getSyncState);
  if (s.phase === 'off') return null;
  const kind = s.phase === 'running' ? 'running' : s.error ? 'failed' : 'ok';
  const color = kind === 'running' ? 'bg-mute animate-pulse' : kind === 'failed' ? 'bg-danger' : 'bg-accent';
  const title = kind === 'running' ? '同步中' : kind === 'failed' ? `同步失败：${s.error}` : '同步正常';
  return <span role="img" aria-label={title} title={title} data-testid="sync-dot" data-state={kind} className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${onDark ? 'ring-1 ring-white/70 ' : ''}${color}`} />;
}

/** 词库页顶部：连续失败 3 次后一条不显眼的提示，点了去设置看。 */
export function SyncFailNotice() {
  const s = useSyncExternalStore(subscribeSync, getSyncState);
  const dropped = s.phase === 'off' && !!s.notice;
  if (!dropped && !shouldShowFailNotice(s)) return null;
  return (
    <button type="button" onClick={() => { pendingTab = true; window.dispatchEvent(new Event(GOTO)); }} data-testid="sync-fail-notice" className="press mb-3 block w-full rounded-lg bg-shade px-3 py-2 text-left text-xs text-mute hover:text-ink">
      {dropped ? '同步空间已被删除，本机已退出同步，点这里查看' : '同步失败，点这里查看'}
    </button>
  );
}
