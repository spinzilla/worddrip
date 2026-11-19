import React, { useState } from 'react';
import { Check } from 'lucide-react';
import type { AiTask } from '../../utils/aiTasks';
import { useT } from '../../utils/i18n';
import { dismissDefCheck, replaceWithSuggestion } from '../../utils/vocab/defCheckTask';
import type { DefCheckRecord } from '../../utils/vocab/definitionEn';

// 「AI 帮我看看」（英英释义）的结果块：释义区和 AI 小窗里的同一个任务都用它。「已替换 / 不换」记在任务的 result 里，两处一致。
// 替换规则不变：只有用户点「用这个替换」才改释义。

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const btnPrimary = 'press inline-flex items-center gap-1 rounded-lg bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-45';
const btnPlain = 'press inline-flex items-center gap-1 rounded-lg border border-line bg-page px-3 py-1.5 text-sm text-ink hover:border-ink/30 disabled:opacity-45';

export default function DefCheckResult({ task }: { task: AiTask }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [replaceError, setReplaceError] = useState('');
  const record = task.result as DefCheckRecord | undefined;

  if (record?.dismissed) return null;
  if (task.status === 'failed' && task.error) {
    return <p role="alert" className="vocab-wrap mt-2 text-xs text-danger" data-testid="def-en-error">{task.error}</p>;
  }
  if (!record) return null;
  if (record.error) return <p role="alert" className="vocab-wrap mt-2 text-xs text-danger" data-testid="def-en-error">{record.error}</p>;
  const check = record.check;
  if (!check) return null;

  const replace = async () => {
    if (busy) return;
    setBusy(true);
    setReplaceError('');
    try {
      await replaceWithSuggestion(task);
    } catch (reason) {
      setReplaceError(t('aiCard.replaceFailed', { detail: errorText(reason) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-xl border border-line bg-page p-3 text-sm" data-testid="def-en-check">
      <p className="vocab-wrap text-ink"><span className="font-medium">{check.good ? t('aiCard.defGood') : t('aiCard.defFix')}</span>{check.comment}</p>
      {check.suggestion && (
        <>
          <p className="vocab-wrap mt-2 font-serif text-base text-ink" data-testid="def-en-suggestion">{check.suggestion}</p>
          {record.replaced ? (
            <p className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-success" data-testid="def-en-replaced"><Check size={14} />{t('aiCard.replaced')}</p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={() => void replace()} disabled={busy} className={btnPrimary} data-testid="def-en-apply">{t('aiCard.defUse')}</button>
              <button type="button" onClick={() => dismissDefCheck(task)} disabled={busy} className={btnPlain} data-testid="def-en-keep">{t('aiCard.defKeep')}</button>
            </div>
          )}
        </>
      )}
      {!check.suggestion && <button type="button" onClick={() => dismissDefCheck(task)} className={`${btnPlain} mt-2`} data-testid="def-en-ok">{t('aiCard.defOk')}</button>}
      {replaceError && <p role="alert" className="vocab-wrap mt-2 text-xs text-danger" data-testid="def-en-replace-error">{replaceError}</p>}
    </div>
  );
}
