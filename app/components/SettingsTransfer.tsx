import React, { useState } from 'react';
import { Download, FileUp, Loader2, ShieldCheck, X } from 'lucide-react';
import { Btn, Card } from './ui';
import {
  exportWholeLibrary, importWholeLibrary, pickWholeLibrary,
  type LibraryCandidate, type LibraryExportResult,
} from '../utils/vocab/libraryTransfer';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const dateText = (value: string | null) => {
  if (!value) return '老版本词库，没有记录导出时间';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
};

export default function SettingsTransfer() {
  const [busy, setBusy] = useState<'export' | 'pick' | 'import' | null>(null);
  const [candidate, setCandidate] = useState<LibraryCandidate | null>(null);
  const [exported, setExported] = useState<LibraryExportResult | null>(null);
  const [withSettings, setWithSettings] = useState(true);
  const [includeApiKey, setIncludeApiKey] = useState(false);
  const [restoreSettings, setRestoreSettings] = useState(true);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const doExport = async () => {
    setBusy('export'); setError(''); setNotice(''); setExported(null);
    try {
      const result = await exportWholeLibrary({ withSettings, includeApiKey: withSettings && includeApiKey });
      if (result) setExported(result);
      else setNotice('已取消保存，没有写出文件。');
    } catch (reason) { setError(`导出失败：${errorText(reason)}`); }
    finally { setBusy(null); }
  };

  const doPick = async () => {
    setBusy('pick'); setError(''); setNotice(''); setExported(null);
    try {
      const result = await pickWholeLibrary();
      if (result) setCandidate(result);
      else setNotice('已取消选择，本机词库没有改动。');
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(null); }
  };

  const doImport = async () => {
    if (!candidate) return;
    setBusy('import'); setError('');
    try {
      const result = await importWholeLibrary(candidate.data, candidate.summary.settings && restoreSettings ? candidate.summary.settings : null);
      setCandidate(null);
      setNotice(`搬家完成：${result.summary.words} 个词条已入库。${result.backupPath ? '导入前的本机词库已自动备份。' : ''}${result.settingsRestored ? `已恢复 ${result.settingsRestored} 项设置，部分设置重启应用后生效。` : ''}`);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(null); }
  };

  return (
    <section aria-label="整库搬家" data-testid="library-transfer">
      <Card flat className="space-y-4 p-4 sm:p-5">
        <div>
          <h2 className="text-base font-semibold text-ink">整库搬家</h2>
          <p className="mt-1 text-sm leading-6 text-mute">一个 .wdlib 文件带走词、复习进度、笔记、例句、随手记和复习记录。电脑和手机可以互相导入。</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl bg-shade p-4">
            <h3 className="text-sm font-medium text-ink">从这台设备导出</h3>
            <p className="mt-1 min-h-10 text-xs leading-5 text-mute">先做一个完整、一致的 SQLite 副本，再选保存位置。</p>
            <label className="mt-2 flex items-start gap-2 text-xs leading-5 text-ink">
              <input type="checkbox" checked={withSettings} onChange={e => setWithSettings(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-accent" data-testid="library-export-settings" />
              <span className="min-w-0 break-words">同时导出设置</span>
            </label>
            <label className={`mt-1 flex items-start gap-2 text-xs leading-5 ${withSettings ? 'text-ink' : 'text-mute'}`}>
              <input type="checkbox" checked={includeApiKey} disabled={!withSettings} onChange={e => setIncludeApiKey(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-accent" data-testid="library-export-apikey" />
              <span className="min-w-0 break-words">包含 API key</span>
            </label>
            {withSettings && includeApiKey && <p className="mt-1 text-xs leading-5 text-danger" data-testid="library-export-apikey-warn">文件里会有你的密钥，别发给别人。</p>}
            <Btn tone="ink" className="mt-3 w-full" disabled={busy !== null} onClick={() => void doExport()} data-testid="library-export">
              {busy === 'export' ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}导出整个词库
            </Btn>
          </div>
          <div className="rounded-xl bg-shade p-4">
            <h3 className="text-sm font-medium text-ink">导入另一台设备的文件</h3>
            <p className="mt-1 min-h-10 text-xs leading-5 text-mute">先检查并看摘要，确认才覆盖；本机词库会自动备份。</p>
            <Btn tone="white" className="mt-3 w-full border border-line bg-page" disabled={busy !== null} onClick={() => void doPick()} data-testid="library-pick">
              {busy === 'pick' ? <Loader2 size={16} className="animate-spin" /> : <FileUp size={16} />}导入整个词库
            </Btn>
          </div>
        </div>
        <p className="text-xs leading-5 text-mute">设置（AI、词典来源、Anki 等）可选一起带走，API key 默认不带，同步密钥永远不带；视频和本地词典不搬。</p>
        {exported && <p role="status" className="break-all rounded-lg bg-accent-soft p-3 text-xs text-accent" data-testid="library-export-result">已导出 {exported.path}（{(exported.bytes / 1024).toFixed(1)} KB）</p>}
        {notice && <p role="status" className="rounded-lg bg-accent-soft p-3 text-sm text-accent" data-testid="library-import-result">{notice}</p>}
        {error && <p role="alert" className="whitespace-pre-wrap rounded-lg bg-danger-soft p-3 text-sm text-danger">{error}</p>}
      </Card>

      {candidate && (
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-ink/35 p-0 sm:items-center sm:p-6" role="presentation">
          <div role="dialog" aria-modal="true" aria-labelledby="library-confirm-title" className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-page p-5 shadow-card sm:max-w-lg sm:rounded-2xl" data-testid="library-confirm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="library-confirm-title" className="text-lg font-semibold text-ink">确认覆盖本机词库？</h2>
                <p className="mt-1 break-all text-xs text-mute">{candidate.fileName}</p>
              </div>
              <button type="button" aria-label="取消导入" disabled={busy === 'import'} onClick={() => setCandidate(null)} className="press rounded-lg p-2 text-mute hover:bg-shade"><X size={18} /></button>
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
              {[
                ['词条', candidate.summary.words], ['今天到期', candidate.summary.due],
                ['笔记', candidate.summary.notes], ['随手记', candidate.summary.quickNotes],
              ].map(([label, value]) => <div key={label} className="rounded-xl bg-shade p-3"><dt className="text-xs text-mute">{label}</dt><dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{value} 条</dd></div>)}
            </dl>
            <p className="mt-3 text-xs text-mute">导出时间：{dateText(candidate.summary.exportedAt)}</p>
            {candidate.summary.settings && (
              <label className="mt-3 flex items-start gap-2 text-sm leading-6 text-ink">
                <input type="checkbox" checked={restoreSettings} onChange={e => setRestoreSettings(e.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-accent" data-testid="library-restore-settings" />
                <span className="min-w-0 break-words">文件里带了设置，同时恢复（没带 API key 时，本机现有的 key 不会被清掉）</span>
              </label>
            )}
            <div className="mt-4 flex gap-2 rounded-xl border border-clay/30 bg-clay-soft p-3 text-sm leading-6 text-clay">
              <ShieldCheck size={19} className="mt-0.5 shrink-0" />
              <p><strong>会覆盖本机现在的词库。</strong>确认后，本机词库会先自动备份（最多保留最近 3 份），再换成文件里的内容。</p>
            </div>
            {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
            <div className="sticky bottom-0 -mx-5 mt-5 flex gap-3 border-t border-line bg-page px-5 pb-1 pt-4">
              <Btn className="flex-1" disabled={busy === 'import'} onClick={() => setCandidate(null)} data-testid="library-cancel">取消</Btn>
              <Btn tone="ink" className="flex-1" disabled={busy === 'import'} onClick={() => void doImport()} data-testid="library-confirm-import">
                {busy === 'import' && <Loader2 size={15} className="animate-spin" />}备份并覆盖
              </Btn>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
