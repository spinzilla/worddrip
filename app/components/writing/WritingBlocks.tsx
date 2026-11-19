import React, { useState, useSyncExternalStore } from 'react';
import { Check, Plus } from 'lucide-react';
import type { AiTask } from '../../utils/aiTasks';
import { useT } from '../../utils/i18n';
import {
  getWritingRecord, onWritingRecordsChanged, saveWritingExample, writingExampleCandidates, writingRecordsVersion,
  type WritingReviewResult, type WritingTaskResult, type WritingItem,
} from '../../utils/writing';

// 096 写作练习的结果块：页面和 AI 小窗里的同一个任务都用这里的组件（照 093）。
// 「已存」记在写作记录里（savedExamples），所以两处一致；批改不显示分数。

const btnPlain = 'press inline-flex items-center gap-1 rounded-lg border border-line bg-page px-3 py-1.5 text-sm text-ink hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-45';

/** 订阅写作记录：存草稿、出题 / 批改完成、存例句都会刷新。 */
export function useWritingRecord(id: string | null | undefined): WritingItem | undefined {
  const version = useSyncExternalStore(onWritingRecordsChanged, writingRecordsVersion);
  return React.useMemo(() => (id ? getWritingRecord(id) : undefined), [id, version]);
}

export function WritingTaskCard({ task, testid = 'writing-task-card' }: { task: WritingTaskResult; testid?: string }) {
  const t = useT();
  return (
    <div className="min-w-0 rounded-xl border border-line bg-paper p-4" data-testid={testid}>
      <p className="vocab-wrap font-serif text-lg leading-relaxed text-ink" data-testid="writing-prompt">{task.prompt}</p>
      <p className="vocab-wrap mt-2 text-sm text-ink" data-testid="writing-chinese">{task.chinese}</p>
      <p className="vocab-wrap mt-1 text-xs text-mute" data-testid="writing-requirements">{t('writing.require', { text: task.requirements })}</p>
    </div>
  );
}

const VERDICT_KEY = { yes: 'writing.verdict.yes', partly: 'writing.verdict.partly', no: 'writing.verdict.no' } as const;

/** 批改结果块。recordId 用来找记录里的建议用词、作答和「已存」状态。 */
export function WritingReviewBlock({ recordId, review }: { recordId: string; review: WritingReviewResult }) {
  const t = useT();
  const record = useWritingRecord(recordId);
  const [busyKey, setBusyKey] = useState('');
  const [saveError, setSaveError] = useState('');

  if (review.error) {
    return <p role="alert" className="vocab-wrap mt-2 text-xs text-danger" data-testid="writing-review-error">{review.error}</p>;
  }
  const candidates = record ? writingExampleCandidates(record.words, review.better, record.answer) : [];
  const saved = new Set(record?.savedExamples ?? []);

  const save = async (index: number) => {
    const candidate = candidates[index];
    if (!record || !candidate || busyKey) return;
    setBusyKey(candidate.key);
    setSaveError('');
    try {
      await saveWritingExample(record, candidate);
    } catch (reason) {
      setSaveError(t('writing.saveFailed', { detail: reason instanceof Error ? reason.message : String(reason) }));
    } finally {
      setBusyKey('');
    }
  };

  const verdict = review.task?.verdict;
  return (
    <div className="mt-3 min-w-0 rounded-xl border border-line bg-paper p-3 text-sm" data-testid="writing-review">
      {review.task && verdict && (
        <div data-testid="writing-review-task" data-verdict={verdict}>
          <div className={`font-semibold ${verdict === 'yes' ? 'text-success' : verdict === 'partly' ? 'text-ink' : 'text-danger'}`}>{t(VERDICT_KEY[verdict])}</div>
          <p className="vocab-wrap mt-1 text-ink">{review.task.comment}</p>
        </div>
      )}

      <div className="mt-3" data-testid="writing-review-issues">
        <div className="text-xs text-mute">{t('writing.issues')}</div>
        {review.issues.length === 0 ? <p className="mt-1 text-ink">{t('writing.noIssues')}</p> : (
          <ul className="mt-1 space-y-2">
            {review.issues.map((issue, index) => (
              <li key={index} className="vocab-wrap rounded-lg bg-shade/60 p-2" data-testid="writing-issue">
                <p className="text-ink"><span className="text-danger line-through decoration-danger/40">{issue.original}</span> → <span className="font-medium text-success">{issue.suggestion}</span></p>
                <p className="mt-0.5 text-xs text-mute">{issue.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {review.words.length > 0 && (
        <div className="mt-3" data-testid="writing-review-words">
          <div className="text-xs text-mute">{t('writing.words')}</div>
          <ul className="mt-1 space-y-1">
            {review.words.map(item => (
              <li key={item.word} className="vocab-wrap" data-testid="writing-review-word" data-used={item.used ? '1' : '0'}>
                <span className="font-medium text-ink">{item.word}</span>
                <span className={`ml-2 text-xs ${!item.used ? 'text-mute' : item.correct ? 'text-success' : 'text-danger'}`}>
                  {!item.used ? t('writing.wordUnused') : item.correct ? t('writing.wordOk') : t('writing.wordBad')}
                </span>
                <span className="ml-2 text-xs text-mute">{item.comment}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {review.better && (
        <div className="mt-3" data-testid="writing-review-better">
          <div className="text-xs text-mute">{t('writing.better')}</div>
          <p className="vocab-wrap font-serif text-base leading-relaxed text-ink" data-testid="writing-better-text">{review.better}</p>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="mt-3" data-testid="writing-save-list">
          <div className="text-xs text-mute">{t('writing.saveHint')}</div>
          <ul className="mt-1 space-y-2">
            {candidates.map((candidate, index) => {
              const done = saved.has(candidate.key);
              return (
                <li key={candidate.key} className="vocab-wrap flex min-w-0 flex-wrap items-start gap-2" data-testid="writing-save-item" data-saved={done ? '1' : '0'}>
                  <p className="min-w-0 flex-1 basis-48 text-ink"><span className="mr-1 rounded bg-shade px-1.5 py-0.5 text-xs text-mute">{candidate.word} · {t(candidate.from === 'better' ? 'writing.fromBetter' : 'writing.fromMine')}</span>{candidate.sentence}</p>
                  {done ? (
                    <span className="inline-flex shrink-0 items-center gap-0.5 py-1.5 text-sm font-medium text-success" data-testid="writing-saved"><Check size={14} />{t('aiCard.saved')}</span>
                  ) : (
                    <button type="button" onClick={() => void save(index)} disabled={!!busyKey} className={btnPlain} data-testid="writing-save">
                      <Plus size={14} />{busyKey === candidate.key ? t('aiCard.genSaving') : t('writing.save')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {saveError && <p role="alert" className="vocab-wrap mt-2 text-xs text-danger" data-testid="writing-save-error">{saveError}</p>}
    </div>
  );
}

/** AI 小窗里：批改任务的结果块。 */
export function WritingReviewTaskBlock({ task }: { task: AiTask }) {
  if (task.status === 'failed' && task.error) {
    return <p role="alert" className="vocab-wrap mt-2 text-xs text-danger" data-testid="writing-review-error">{task.error}</p>;
  }
  const review = task.result as WritingReviewResult | undefined;
  if (!review || !task.source.ref) return null;
  return <WritingReviewBlock recordId={task.source.ref} review={review} />;
}

/** AI 小窗里：出题任务的结果块（只显示题目）。 */
export function WritingTaskTaskBlock({ task }: { task: AiTask }) {
  if (task.status === 'failed' && task.error) {
    return <p role="alert" className="vocab-wrap mt-2 text-xs text-danger" data-testid="writing-task-error">{task.error}</p>;
  }
  const result = task.result as WritingTaskResult | undefined;
  if (!result) return null;
  if (result.error) return <p role="alert" className="vocab-wrap mt-2 text-xs text-danger" data-testid="writing-task-error">{result.error}</p>;
  return <div className="mt-2"><WritingTaskCard task={result} testid="writing-task-card-panel" /></div>;
}
