import React, { useState } from 'react';
import { Check } from 'lucide-react';
import type { AiTask } from '../../utils/aiTasks';
import { useT } from '../../utils/i18n';
import { dismissOwnCheck, saveOwnCheck } from '../../utils/vocab/ownCheckTask';
import type { OwnCheckRecord } from '../../utils/vocab/examples';
import type { VocabExample } from '../../utils/vocab/types';

// 「让 AI 看看」的结果块：词条页的例句区和 AI 小窗里的同一个任务都用它，按钮、存的内容、「已存 / 都不存」状态都一样。
// 状态全在任务的 result 里（saved / dismissed），所以一处存了，另一处也变成「已存」。
// showOriginal：小窗里要在最上面多一行「原句：…」（词条页的输入框里已经有原句了，不用）。

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const btnPrimary = 'press inline-flex items-center gap-1 rounded-lg bg-ink px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-45';
const btnPlain = 'press inline-flex items-center gap-1 rounded-lg border border-line bg-page px-3 py-1.5 text-sm text-ink hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-45';

export default function OwnCheckResult({ task, onSaved, showOriginal = false }: { task: AiTask; onSaved?: (examples: VocabExample[]) => void; showOriginal?: boolean }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const record = task.result as OwnCheckRecord | undefined;

  if (record?.dismissed) return null;
  if (task.status === 'failed' && task.error) {
    return <p role="alert" className="vocab-wrap mt-2 text-xs text-danger" data-testid="own-error">{task.error}</p>;
  }
  if (!record) return null;
  if (record.error) return <p role="alert" className="vocab-wrap mt-2 text-xs text-danger" data-testid="own-error">{record.error}</p>;
  const check = record.check;
  if (!check) return null;

  const save = async (kind: 'original' | 'fixed' | 'better') => {
    if (busy) return;
    setBusy(true);
    setSaveError('');
    try {
      const saved = await saveOwnCheck(task, kind);
      onSaved?.(saved);
    } catch (reason) {
      setSaveError(t('aiCard.saveFailed', { detail: errorText(reason) }));
    } finally {
      setBusy(false);
    }
  };

  const good = check.verdict === 'correct';
  return (
    <div className={`mt-3 rounded-xl border p-3 text-sm ${good ? 'border-success/30 bg-success-soft' : 'border-clay/30 bg-clay-soft'}`} data-testid="own-result" data-verdict={check.verdict}>
      {showOriginal && <p className="vocab-wrap mb-1.5 text-xs text-mute" data-testid="own-original">{t('aiCard.original', { text: record.original })}</p>}
      <div className={`font-semibold ${good ? 'text-success' : 'text-danger'}`} data-testid="own-verdict">{t(VERDICT_KEY[check.verdict])}</div>
      <p className="vocab-wrap mt-1 text-ink" data-testid="own-reason">{check.reason}</p>
      {check.changed && (
        <div className="mt-2">
          <div className="text-xs text-mute">{t('aiCard.fixedHint')}</div>
          <p className="vocab-wrap font-serif text-base text-ink" data-testid="own-fixed">{check.fixed}</p>
        </div>
      )}
      {check.better && (
        <div className="mt-2">
          <div className="text-xs text-mute">{t('aiCard.betterHint')}</div>
          <p className="vocab-wrap font-serif text-base text-ink" data-testid="own-better">{check.better}</p>
        </div>
      )}
      {record.saved ? (
        <p className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-success" data-testid="own-saved"><Check size={14} />{t('aiCard.saved')}</p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => void save('original')} disabled={busy} className={check.changed ? btnPlain : btnPrimary} data-testid="own-save-original">
            <Check size={14} />{t('aiCard.saveOriginal')}
          </button>
          {check.changed && (
            <button type="button" onClick={() => void save('fixed')} disabled={busy} className={btnPrimary} data-testid="own-save-fixed">
              <Check size={14} />{t('aiCard.saveFixed')}
            </button>
          )}
          {check.better && (
            <button type="button" onClick={() => void save('better')} disabled={busy} className={btnPlain} data-testid="own-save-better">{t('aiCard.saveBetter')}</button>
          )}
          <button type="button" onClick={() => dismissOwnCheck(task)} disabled={busy} className={btnPlain} data-testid="own-discard">{t('aiCard.discard')}</button>
        </div>
      )}
      {saveError && <p role="alert" className="vocab-wrap mt-2 text-xs text-danger" data-testid="own-save-error">{saveError}</p>}
    </div>
  );
}

const VERDICT_KEY = {
  correct: 'aiCard.verdict.correct',
  incomplete: 'aiCard.verdict.incomplete',
  wrong: 'aiCard.verdict.wrong',
} as const;
