import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { ChevronDown, Copy, Eye, EyeOff, Loader2, RefreshCw } from 'lucide-react';
import { Btn, Card, inputCls } from './ui';
import {
  currentSyncCode, DEFAULT_SYNC_URL, deleteRemoteSync, dismissSyncNotice, enableSync, getSyncUrlDraft, setSyncUrlDraft, getSyncConfig, getSyncState, joinSync, leaveSync,
  NO_BUILT_IN_SYNC_MESSAGE, refreshInfo, runSync, setAutoSync, setSyncBaseUrl, subscribeSync, syncAvailable,
} from '../utils/sync';

const timeText = (ms: number | null) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '还没有同步过');
const sizeText = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const maskCode = (code: string) => code.replace(/[A-Z2-7]/g, '•');

/** 设置里的「同步」：开启 / 加入 / 立即同步 / 退出 / 删除服务器数据。 */
export default function SettingsSync() {
  const state = useSyncExternalStore(subscribeSync, getSyncState);
  const config = getSyncConfig();
  const code = currentSyncCode();
  const [busy, setBusy] = useState<'enable' | 'join' | 'delete' | null>(null);
  const [joinText, setJoinText] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const available = syncAvailable();
  const on = state.phase !== 'off' && !!config;

  useEffect(() => { if (on) void refreshInfo(); }, [on]);

  const doEnable = async () => {
    setBusy('enable'); setError('');
    const r = await enableSync(baseUrlDraft.value);
    if (!r.ok) setError(r.error ?? '');
    setBusy(null);
  };
  const doJoin = async () => {
    setBusy('join'); setError('');
    const r = await joinSync(joinText, baseUrlDraft.value);
    if (r.ok) { setJoinText(''); setJoining(false); } else setError(r.error ?? '');
    setBusy(null);
  };
  const doCopy = async () => {
    if (!code) return;
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { setError('复制失败，请点「显示」后手动抄下来。'); }
  };
  const doDelete = async () => {
    setBusy('delete'); setError('');
    const r = await deleteRemoteSync();
    if (!r.ok) setError(r.error ?? '');
    setConfirmDelete(false); setBusy(null);
  };

  return (
    <section aria-label="同步" data-testid="sync-settings">
      <Card flat className="space-y-4 p-4 sm:p-5">
        <div>
          <h2 className="text-base font-semibold text-ink">同步</h2>
          <p className="mt-1 text-sm leading-6 text-mute">同步：两台设备自动合并改动；整库搬家：用一个文件整库覆盖。</p>
        </div>

        {!available && <p className="rounded-lg bg-shade p-3 text-sm text-mute" data-testid="sync-unavailable">{NO_BUILT_IN_SYNC_MESSAGE}</p>}

        {!on && available && (
          <div className="space-y-3" data-testid="sync-off">
            {state.notice && (
              <div role="status" className="space-y-2 rounded-lg bg-clay-soft p-3 text-sm text-clay" data-testid="sync-notice">
                <p>{state.notice}</p>
                <Btn tone="white" className="border border-line bg-page" onClick={dismissSyncNotice} data-testid="sync-notice-dismiss">知道了</Btn>
              </div>
            )}
            <p className="text-xs leading-5 text-mute">第一次同步会把本机词库全部上传一次，之后只传改动。数据存放在作者的服务器上，只用于你的设备之间同步。</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Btn tone="ink" disabled={busy !== null} onClick={() => void doEnable()} data-testid="sync-enable">
                {busy === 'enable' && <Loader2 size={16} className="animate-spin" />}在这台设备开启同步
              </Btn>
              <Btn tone="white" className="border border-line bg-page" disabled={busy !== null} onClick={() => { setJoining(j => !j); setError(''); }} data-testid="sync-join-open">
                加入另一台设备的同步
              </Btn>
            </div>
            {joining && (
              <div className="space-y-2 rounded-xl bg-shade p-3">
                <label className="block text-xs text-mute" htmlFor="sync-code-input">粘贴另一台设备上显示的同步码</label>
                <input id="sync-code-input" data-testid="sync-code-input" className={`${inputCls} font-mono tracking-wide`} value={joinText} autoComplete="off" spellCheck={false}
                  onChange={e => { setJoinText(e.target.value); setError(''); }} placeholder="XXXX-XXXX-XXXX-…" />
                <Btn tone="ink" className="w-full" disabled={busy !== null || !joinText.trim()} onClick={() => void doJoin()} data-testid="sync-join">
                  {busy === 'join' && <Loader2 size={16} className="animate-spin" />}加入
                </Btn>
              </div>
            )}
          </div>
        )}

        {on && (
          <div className="space-y-4" data-testid="sync-on">
            <div className="rounded-xl bg-shade p-3">
              <div className="text-xs text-mute">同步码</div>
              <div className="mt-1 flex items-start gap-2">
                <code className="min-w-0 flex-1 break-all font-mono text-sm leading-6 text-ink" data-testid="sync-code">{code ? (reveal ? code : maskCode(code)) : ''}</code>
                <button type="button" onClick={() => setReveal(v => !v)} data-testid="sync-code-toggle" className="press inline-flex min-h-[36px] shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-mute hover:bg-line">
                  {reveal ? <EyeOff size={14} /> : <Eye size={14} />}{reveal ? '隐藏' : '显示'}
                </button>
                <button type="button" onClick={() => void doCopy()} data-testid="sync-code-copy" className="press inline-flex min-h-[36px] shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-mute hover:bg-line">
                  <Copy size={14} />{copied ? '已复制' : '复制'}
                </button>
              </div>
              <p className="mt-2 text-xs leading-5 text-mute">在另一台设备输入这个同步码即可加入。请自己保存一份，两台设备都卸载后无法找回。</p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Btn tone="ink" disabled={state.phase === 'running'} onClick={() => void runSync()} data-testid="sync-now">
                {state.phase === 'running' ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}立即同步
              </Btn>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={config?.auto !== false} onChange={e => setAutoSync(e.target.checked)} data-testid="sync-auto" />
                自动同步
              </label>
            </div>

            <dl className="grid gap-2 text-sm sm:grid-cols-2" data-testid="sync-status">
              <div className="rounded-xl bg-shade p-3">
                <dt className="text-xs text-mute">上次同步</dt>
                <dd className="mt-1 text-ink" data-testid="sync-last-at">{timeText(state.lastAt)}</dd>
              </div>
              <div className="rounded-xl bg-shade p-3">
                <dt className="text-xs text-mute">结果</dt>
                <dd className="mt-1 text-ink" data-testid="sync-last-result">{state.lastAt ? `上传 ${state.lastPushed} 条，下载 ${state.lastPulled} 条` : '—'}</dd>
              </div>
              {state.info && (
                <div className="rounded-xl bg-shade p-3 sm:col-span-2">
                  <dt className="text-xs text-mute">空间用量</dt>
                  <dd className="mt-1 text-ink" data-testid="sync-usage">{sizeText(state.info.bytes)} / {sizeText(state.info.quotaBytes)}</dd>
                </div>
              )}
            </dl>
            {state.error && <p role="alert" className="whitespace-pre-wrap rounded-lg bg-danger-soft p-3 text-sm text-danger" data-testid="sync-error">上次同步失败：{state.error}</p>}

            <details className="rounded-xl border border-line p-3" data-testid="sync-danger">
              <summary className="flex cursor-pointer list-none items-center justify-between text-sm text-mute">危险操作<ChevronDown size={16} /></summary>
              <div className="mt-3 space-y-3">
                <div>
                  <Btn tone="white" className="w-full border border-line bg-page" onClick={() => { leaveSync(); setReveal(false); }} data-testid="sync-leave">这台设备退出同步</Btn>
                  <p className="mt-1 text-xs text-mute">只清掉本机的同步凭证，服务器上的数据保留，其它设备不受影响。</p>
                </div>
                <div>
                  {!confirmDelete ? (
                    <Btn tone="danger-soft" className="w-full" onClick={() => setConfirmDelete(true)} data-testid="sync-delete">删除服务器上的同步数据</Btn>
                  ) : (
                    <div className="space-y-2 rounded-lg bg-danger-soft p-3 text-sm text-danger" data-testid="sync-delete-confirm">
                      <p>确定删除？服务器上的数据会清空，所有设备都会断开同步（各设备本机词库不受影响）。</p>
                      <div className="flex gap-2">
                        <Btn className="flex-1" disabled={busy === 'delete'} onClick={() => setConfirmDelete(false)}>取消</Btn>
                        <Btn tone="ink" className="flex-1" disabled={busy === 'delete'} onClick={() => void doDelete()} data-testid="sync-delete-yes">
                          {busy === 'delete' && <Loader2 size={15} className="animate-spin" />}确认删除
                        </Btn>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </details>
          </div>
        )}

        {error && <p role="alert" className="whitespace-pre-wrap rounded-lg bg-danger-soft p-3 text-sm text-danger" data-testid="sync-action-error">{error}</p>}

        <details className="rounded-xl border border-line p-3" data-testid="sync-advanced">
          <summary className="flex cursor-pointer list-none items-center justify-between text-sm text-mute">高级<ChevronDown size={16} /></summary>
          <div className="mt-3 space-y-1">
            <label className="block text-xs text-mute" htmlFor="sync-url">服务器地址（留空用内置值，供测试用）</label>
            <input id="sync-url" data-testid="sync-url" className={inputCls} placeholder={DEFAULT_SYNC_URL} defaultValue={config?.baseUrl ?? getSyncUrlDraft()}
              onBlur={e => { if (on) setSyncBaseUrl(e.target.value); else setSyncUrlDraft(e.target.value); }} />
          </div>
        </details>
      </Card>
    </section>
  );
}

// 没开启时填的服务器地址存在本机（manager 的 getSyncUrlDraft），开启/加入时带上。
const baseUrlDraft = { get value() { return getSyncUrlDraft(); } };
