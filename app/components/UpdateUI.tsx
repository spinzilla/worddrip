import React, { useEffect, useState } from 'react';
import { Btn, Group } from './ui';
import { useT } from '../utils/i18n';
import { IS_MOBILE } from '../utils/platform';
import {
  autoCheckOn, bannerVisible, checkUpdate, hasFound, loadCurrent, openApkInBrowser, setAutoCheck, snoozeUpdate, startUpdate, useUpdate,
} from '../utils/update';
import { wordpackLicense } from '../utils/wordpack';

// 应用内更新（任务卡 077）：顶部提示条 + 设置里的「关于」。逻辑都在 utils/update.ts。

const fmtTime = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// 在页头下面、正文上面；不盖住任何操作。用 break-words 让手机 390 宽和 130% 字号都不横向溢出。
export const UpdateBanner: React.FC = () => {
  const t = useT();
  const u = useUpdate();
  const [open, setOpen] = useState(false);
  if (!bannerVisible(u)) return null;
  const busy = u.phase === 'downloading' || u.phase === 'installing';
  const err = u.phase === 'dlFailed' ? t(`update.err.${u.error ?? 'unknown'}`) : null;
  return (
    <div data-testid="update-banner" role="status"
      className="shrink-0 mx-4 md:mx-12 lg:mx-24 mb-1 rounded-xl border border-line bg-accent-soft text-ink px-4 py-3 text-sm break-words min-w-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-medium min-w-0 flex-1 basis-40">{t('update.found', { v: u.version })}</span>
        <div className="flex flex-wrap items-center gap-2">
          {u.phase === 'available' && <>
            <Btn tone="accent" size="sm" onClick={() => startUpdate()} data-testid="update-now">{t('update.now')}</Btn>
            <Btn size="sm" onClick={snoozeUpdate} data-testid="update-later">{t('update.later')}</Btn>
          </>}
          {u.phase === 'dlFailed' && <Btn tone="accent" size="sm" onClick={() => startUpdate()}>{t('update.retry')}</Btn>}
          {u.phase === 'needPermission' && <Btn tone="accent" size="sm" onClick={() => startUpdate()}>{t('update.continue')}</Btn>}
          {u.phase === 'installFailed' && <>
            <Btn size="sm" onClick={() => startUpdate()}>{t('update.retry')}</Btn>
            {IS_MOBILE && <Btn tone="accent" size="sm" onClick={openApkInBrowser}>{t('update.browser')}</Btn>}
          </>}
        </div>
      </div>
      {u.phase === 'downloading' && (
        <div className="mt-2" data-testid="update-progress">
          <div className="h-1.5 rounded-full bg-line overflow-hidden"><div className="h-full bg-accent" style={{ width: `${u.pct ?? 0}%` }} /></div>
          <div className="mt-1 text-xs text-mute tabular-nums">{t('update.downloading', { p: u.pct ?? 0 })}</div>
        </div>
      )}
      {u.phase === 'installing' && <div className="mt-2 text-xs text-mute">{t('update.installing')}</div>}
      {u.phase === 'ready' && <div className="mt-2 text-xs text-mute" data-testid="update-ready">{t('update.ready')}</div>}
      {u.phase === 'needPermission' && <div className="mt-2 text-xs text-mute">{t('update.needPermission')}</div>}
      {u.phase === 'installFailed' && <div className="mt-2 text-xs text-danger">{t('update.installFailed')}</div>}
      {err && <div className="mt-2 text-xs text-danger" data-testid="update-error">{err}</div>}
      {u.notes && !busy && (
        <div className="mt-2">
          <button type="button" className="text-xs text-accent underline-offset-4 hover:underline" onClick={() => setOpen(o => !o)} aria-expanded={open}>
            {open ? t('update.hideNotes') : t('update.showNotes')}
          </button>
          {open && <p className="mt-1 whitespace-pre-wrap text-xs text-mute" data-testid="update-notes">{u.notes}</p>}
        </div>
      )}
    </div>
  );
};

// 设置最后一块：版本号、检查更新、自动检查开关、上次检查时间。
export const AboutSection: React.FC = () => {
  const t = useT();
  const u = useUpdate();
  const [auto, setAuto] = useState(autoCheckOn());
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [license, setLicense] = useState<string | null>(null);
  const [licenseError, setLicenseError] = useState<string | null>(null);
  useEffect(loadCurrent, []);
  const toggleLicense = async () => {
    const next = !licenseOpen;
    setLicenseOpen(next);
    if (next && !license && !licenseError) {
      try { setLicense(await wordpackLicense()); }
      catch (error) { setLicenseError(String(error)); }
    }
  };
  const found = hasFound(u.phase);
  const status = u.phase === 'checking' ? t('update.checking')
    : found ? t('update.found', { v: u.version })
    : u.phase === 'latest' ? t('update.latest')
    : u.phase === 'failed' ? t('update.failed') : '';
  return (
    <div className="mt-6" data-testid="about">
      <Group title={t('about.title')}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm break-words">
          <span>{t('update.version', { v: u.current || '…' })}</span>
          <Btn size="sm" disabled={u.phase === 'checking' || found} onClick={() => checkUpdate(true)} data-testid="update-check">{t('update.check')}</Btn>
        </div>
        {status && <p className="mt-2 text-xs text-mute break-words" data-testid="update-status">{status}</p>}
        <label className="mt-3 flex items-center justify-between gap-3 text-sm cursor-pointer">
          <span className="min-w-0">{t('update.auto')}</span>
          <input type="checkbox" checked={auto} data-testid="update-auto"
            onChange={e => { setAuto(e.target.checked); setAutoCheck(e.target.checked); }} className="h-5 w-5 shrink-0 accent-accent" />
        </label>
        <p className="mt-2 text-xs text-mute" data-testid="update-last">
          {t('update.lastCheck', { t: u.lastCheck ? fmtTime(u.lastCheck) : t('update.never') })}
        </p>
        {IS_MOBILE && <p className="mt-2 text-xs text-mute">{t('update.installHint')}</p>}
        <div className="mt-4 border-t border-line pt-3">
          <button type="button" onClick={toggleLicense} aria-expanded={licenseOpen} data-testid="wordpack-license-toggle"
            className="press max-w-full rounded-full border border-transparent bg-shade px-3 py-2 text-left text-sm font-medium text-ink hover:bg-line whitespace-normal break-words">
            词表数据：ECDICT（MIT）、NGSL/NAWL（CC BY-SA 4.0）{licenseOpen ? '（收起）' : '（查看许可证）'}
          </button>
          {licenseOpen && <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs text-mute" data-testid="wordpack-license">
            {license ?? licenseError ?? '正在读取许可证…'}
          </pre>}
        </div>
      </Group>
    </div>
  );
};
