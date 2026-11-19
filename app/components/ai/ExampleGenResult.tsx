import React, { useState } from 'react';
import { Check, Plus } from 'lucide-react';
import type { AiTask } from '../../utils/aiTasks';
import { useT } from '../../utils/i18n';
import { dismissExampleGen, saveExampleGen, setExampleGenPicked } from '../../utils/vocab/exampleGenTask';
import { generatedExplanation } from '../../utils/vocab/examples';
import type { ExampleGenRecord } from '../../utils/vocab/examples';
import type { VocabExample } from '../../utils/vocab/types';

// 「AI 给例句」的结果块：词条页和 AI 小窗里的同一个任务都用它。勾选、「已存」、「都不要」都记在任务的 result 里，两处一致。

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const btnPrimary = 'press inline-flex items-center gap-1 rounded-lg bg-ink px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-45';
const btnPlain = 'press inline-flex items-center gap-1 rounded-lg border border-line bg-page px-3 py-1.5 text-sm text-ink hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-45';

export default function ExampleGenResult({ task, onSaved }: { task: AiTask; onSaved?: (examples: VocabExample[]) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const record = task.result as ExampleGenRecord | undefined;

  if (record?.dismissed) return null;
  if (task.status === 'failed' && task.error) {
    return <p role="alert" className="vocab-wrap mt-2 text-xs text-danger" data-testid="example-generate-error">{task.error}</p>;
  }
  if (!record) return null;
  if (record.error) return <p role="alert" className="vocab-wrap mt-2 text-xs text-danger" data-testid="example-generate-error">{record.error}</p>;
  if (record.candidates.length === 0) return null;

  const pickedCount = record.candidates.filter((_, i) => record.picked[i] && !record.saved.includes(i)).length;
  const save = async () => {
    if (busy || pickedCount === 0) return;
    setBusy(true);
    setSaveError('');
    try {
      const saved = await saveExampleGen(task.id);
      onSaved?.(saved);
    } catch (reason) {
      setSaveError(t('aiCard.saveFailed', { detail: errorText(reason) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3" data-testid="generated-result">
      <p className="text-xs text-mute">{t('aiCard.genHint')}</p>
      <ul className="mt-1.5 space-y-2" data-testid="generated-list">
        {record.candidates.map((item, index) => {
          const saved = record.saved.includes(index);
          return (
            <li key={index} className="vocab-note flex min-w-0 items-start gap-2" data-testid="generated-item" data-saved={saved ? '1' : '0'}>
              {saved ? (
                <span className="mt-1 inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-success" data-testid="generated-saved"><Check size={12} />{t('aiCard.saved')}</span>
              ) : (
                <input
                  type="checkbox"
                  checked={record.picked[index] ?? false}
                  onChange={event => setExampleGenPicked(task.id, index, event.target.checked)}
                  aria-label={t('aiCard.genPick', { n: index + 1 })}
                  className="mt-1.5 h-4 w-4 shrink-0"
                  data-testid="generated-check"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="vocab-wrap font-serif text-base leading-relaxed text-ink" data-testid="generated-sentence">{item.sentence}</p>
                {(item.collocation || item.chinese) && (
                  <p className="vocab-wrap mt-0.5 text-xs text-mute">{generatedExplanation(item)}</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex flex-wrap gap-2">
        {record.candidates.some((_, i) => !record.saved.includes(i)) && (
          <button type="button" onClick={() => void save()} disabled={busy || pickedCount === 0} className={btnPrimary} data-testid="generated-save">
            <Plus size={14} />{busy ? t('aiCard.genSaving') : t('aiCard.genSave', { n: pickedCount })}
          </button>
        )}
        <button type="button" onClick={() => dismissExampleGen(task)} disabled={busy} className={btnPlain} data-testid="generated-discard">{t('aiCard.genDiscard')}</button>
      </div>
      {saveError && <p role="alert" className="vocab-wrap mt-2 text-xs text-danger" data-testid="example-save-error">{saveError}</p>}
    </div>
  );
}
