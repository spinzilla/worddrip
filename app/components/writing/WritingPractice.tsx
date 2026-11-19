import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Loader2, PenLine, RotateCcw, Trash2 } from 'lucide-react';
import { aiTasks } from '../../utils/aiTasks';
import { aiPanelState } from '../ai/panelState';
import { isLiveTask, useAiTasksBy } from '../ai/useAiTasksBy';
import { useLang, useT } from '../../utils/i18n';
import {
  deleteWritingRecord, getWritingScene, listWritingRecords, onWritingRecordsChanged, saveWritingDraft,
  startWritingReview, startWritingTask, suggestWritingWords, updateWritingRecord, writingAnswerError,
  writingRecordsVersion, WRITING_REVIEW_KIND, WRITING_SCENES, WRITING_TASK_KIND, type WritingItem, type WritingSceneId,
} from '../../utils/writing';
import { useWritingRecord, WritingReviewBlock, WritingTaskCard } from './WritingBlocks';

// 096 写作练习页：选场景 → 出一题 → 写 2–4 句 → AI 批改。逻辑在 utils/writing（095），这里只接界面。

const SCENE_KEY = 'english-studio.writing.scene';
const CURRENT_KEY = 'english-studio.writing.current';
const btnPrimary = 'press inline-flex items-center justify-center gap-1.5 rounded-xl bg-ink px-4 py-2.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-45';
const btnPlain = 'press inline-flex items-center justify-center gap-1.5 rounded-xl border border-line bg-page px-4 py-2.5 text-sm text-ink hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-45';

const readKey = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const writeKey = (key: string, value: string | null): void => {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* 存不下就算了 */ }
};

const countWords = (text: string): number => (text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? []).length;

function useWritingList(): WritingItem[] {
  const version = useSyncExternalStore(onWritingRecordsChanged, writingRecordsVersion);
  return useMemo(() => listWritingRecords(), [version]);
}

export default function WritingPractice() {
  const t = useT();
  const lang = useLang();
  const records = useWritingList();
  const [sceneId, setSceneId] = useState<WritingSceneId>(() => {
    const saved = readKey(SCENE_KEY);
    return getWritingScene(saved ?? '') ? saved as WritingSceneId : 'ielts';
  });
  const [currentId, setCurrentIdState] = useState<string | null>(() => {
    const saved = readKey(CURRENT_KEY);
    const all = listWritingRecords();
    return saved && all.some(item => item.id === saved) ? saved : all[0]?.id ?? null;
  });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const [reviewError, setReviewError] = useState('');
  const [openWord, setOpenWord] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const setCurrentId = useCallback((id: string | null) => { writeKey(CURRENT_KEY, id); setCurrentIdState(id); }, []);
  const record = useWritingRecord(currentId);
  const taskTask = useAiTasksBy({ kind: WRITING_TASK_KIND, ref: currentId ?? '' })[0];
  const reviewTask = useAiTasksBy({ kind: WRITING_REVIEW_KIND, ref: currentId ?? '' })[0];

  const task = record?.task ?? null;
  const taskOk = !!task && !task.error;
  const review = record?.review ?? null;
  const reviewed = !!review && !review.error;
  // 批改中：记录里还没有批改，但批改任务在跑。
  const reviewing = !review && isLiveTask(reviewTask);
  const rewriting = reviewed && record?.draft !== undefined;
  const locked = reviewing || (reviewed && !rewriting);

  // ---------- 作答框：草稿自动存（没有批改时存进 answer，改写时存进 draft）；切题、离开页面时立刻存 ----------
  const [draft, setDraft] = useState(() => record?.draft ?? record?.answer ?? '');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dirtyRef = useRef(false);
  const targetRef = useRef<'answer' | 'draft'>('answer');
  targetRef.current = reviewed ? 'draft' : 'answer';
  const flush = useCallback((id: string | null) => {
    if (!id || !dirtyRef.current) return;
    dirtyRef.current = false;
    if (targetRef.current === 'draft') updateWritingRecord(id, { draft: draftRef.current });
    else saveWritingDraft(id, draftRef.current);
  }, []);
  useEffect(() => {
    const id = currentId;
    const found = id ? listWritingRecords().find(item => item.id === id) : undefined;
    dirtyRef.current = false;
    setDraft(found?.draft ?? found?.answer ?? '');
    setReviewError('');
    setOpenWord(null);
    return () => flush(id);
  }, [currentId, flush]);
  useEffect(() => {
    if (!currentId || !dirtyRef.current) return undefined;
    const timer = window.setTimeout(() => flush(currentId), 400);
    return () => window.clearTimeout(timer);
  }, [draft, currentId, flush]);
  // 批改完成后，作答框要显示被批改的那版作答（任务完成时 answer 已在记录里）。
  useEffect(() => {
    if (!dirtyRef.current && record && locked) setDraft(record.answer);
  }, [record?.answer, locked]); // eslint-disable-line react-hooks/exhaustive-deps

  const onDraft = (value: string) => { dirtyRef.current = true; setDraft(value); };

  // ---------- 出题 ----------
  const startTask = async () => {
    if (starting) return;
    setStarting(true);
    setStartError('');
    try {
      let words: Awaited<ReturnType<typeof suggestWritingWords>> = [];
      try { words = await suggestWritingWords(); } catch { /* 词库读不出来也能出题，只是没有建议用词 */ }
      const outcome = startWritingTask(sceneId, words);
      if ('reason' in outcome) { setStartError(outcome.reason); return; }
      if (outcome.task.source.ref) setCurrentId(outcome.task.source.ref);
      aiPanelState.reveal(outcome.task.id);
    } finally {
      setStarting(false);
    }
  };

  // ---------- 批改 ----------
  const answerProblem = writingAnswerError(draft);
  const canReview = !!record && taskOk && !answerProblem && !reviewing && !(reviewed && !rewriting);
  const submit = () => {
    if (!record || !canReview) return;
    const outcome = startWritingReview(record, draft);
    if ('reason' in outcome) { setReviewError(outcome.reason); return; }
    // 再写一版：旧作答和旧批改留在记录里。
    if (record.review && !record.review.error) {
      updateWritingRecord(record.id, {
        versions: [...(record.versions ?? []), { answer: record.answer, review: record.review, at: Date.now() }],
        draft: undefined,
      });
    }
    dirtyRef.current = false;
    setReviewError('');
    aiPanelState.reveal(outcome.task.id);
  };
  const startRewrite = () => { if (record) updateWritingRecord(record.id, { draft: record.answer }); };

  const remove = (id: string) => {
    if (confirmId !== id) { setConfirmId(id); return; }
    setConfirmId(null);
    if (id === currentId) { dirtyRef.current = false; setCurrentId(null); }
    deleteWritingRecord(id);
  };
  const open = (id: string) => { setConfirmId(null); setCurrentId(id); window.scrollTo?.({ top: 0 }); };

  const pickScene = (id: WritingSceneId) => { setSceneId(id); writeKey(SCENE_KEY, id); };
  const sceneName = (id: string) => { const s = getWritingScene(id); return s ? (lang === 'zh' ? s.nameZh : s.nameEn) : id; };
  const snippet = (item: WritingItem) => {
    const words = item.task?.prompt?.split(/\s+/).filter(Boolean) ?? [];
    return words.length > 0 ? `${words.slice(0, 6).join(' ')}${words.length > 6 ? '…' : ''}` : t('writing.historyNoTask');
  };
  const dateOf = (ms: number) => new Date(ms).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US');
  const taskLive = isLiveTask(taskTask);

  return (
    <div className="min-w-0 space-y-5" data-testid="writing-page">
      {/* 场景 + 出一题 */}
      <section className="min-w-0 rounded-2xl border border-line bg-page p-4 md:p-5" aria-labelledby="writing-scene-title">
        <h2 id="writing-scene-title" className="text-base font-medium text-ink">{t('writing.sceneTitle')}</h2>
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2" role="radiogroup" aria-labelledby="writing-scene-title">
          {WRITING_SCENES.map(scene => (
            <button key={scene.id} type="button" role="radio" aria-checked={sceneId === scene.id} onClick={() => pickScene(scene.id)} data-testid={`writing-scene-${scene.id}`}
              className={`press rounded-xl border px-4 py-2 text-sm ${sceneId === scene.id ? 'border-ink bg-ink text-white' : 'border-line bg-page text-ink'}`}>
              {lang === 'zh' ? scene.nameZh : scene.nameEn}
            </button>
          ))}
          <button type="button" onClick={() => void startTask()} disabled={starting} data-testid="writing-new" className={`${btnPrimary} w-full sm:ml-auto sm:w-auto`}>
            {starting ? <Loader2 size={15} className="animate-spin" /> : <PenLine size={15} />}{t('writing.newTask')}
          </button>
        </div>
        {startError && <p role="alert" className="vocab-wrap mt-3 text-sm text-danger" data-testid="writing-start-error">{startError}</p>}
      </section>

      {/* 题目 + 作答 + 批改 */}
      {!record ? (
        <section className="rounded-2xl border border-line bg-page p-6" data-testid="writing-empty">
          <h2 className="text-base font-medium text-ink">{t('writing.emptyTitle')}</h2>
          <p className="mt-2 text-sm leading-6 text-mute">{t('writing.emptyBody')}</p>
        </section>
      ) : (
        <section className="min-w-0 rounded-2xl border border-line bg-page p-4 md:p-5" data-testid="writing-current" data-record-id={record.id} data-scene={record.scene}>
          <div className="mb-3 flex min-w-0 items-baseline justify-between gap-3">
            <h2 className="text-base font-medium text-ink">{t('writing.taskTitle', { scene: sceneName(record.scene) })}</h2>
            <span className="shrink-0 text-xs text-mute">{dateOf(record.createdAt)}</span>
          </div>

          {taskOk && task ? (
            <>
              <WritingTaskCard task={task} />
              {record.words.length > 0 && (
                <div className="mt-3" data-testid="writing-words">
                  <div className="text-xs text-mute">{t('writing.wordsHint')}</div>
                  <div className="mt-1.5 flex min-w-0 flex-wrap gap-2">
                    {record.words.map(item => (
                      <button key={item.id || item.word} type="button" onClick={() => setOpenWord(openWord === item.word ? null : item.word)} aria-expanded={openWord === item.word}
                        data-testid="writing-word" data-word={item.word} className="press rounded-lg border border-line bg-paper px-2.5 py-1 text-sm text-ink">
                        {item.word}<span className="ml-1.5 text-xs text-mute">{t('writing.optional')}</span>
                      </button>
                    ))}
                  </div>
                  {record.words.filter(item => item.word === openWord).map(item => (
                    <p key={item.word} className="vocab-wrap mt-2 rounded-lg bg-shade/60 px-3 py-2 text-sm text-ink" data-testid="writing-word-def">
                      <span className="font-medium">{item.word}</span>{item.pos && <span className="ml-1 text-xs text-mute">{item.pos}</span>} — {item.definition}
                    </p>
                  ))}
                </div>
              )}
            </>
          ) : task?.error ? (
            <div role="alert" className="vocab-wrap rounded-xl border border-danger/30 bg-danger-soft p-3 text-sm text-danger" data-testid="writing-task-failed">
              {task.error}
              {taskTask && <div className="mt-2"><button type="button" className={btnPlain} onClick={() => aiTasks.retry(taskTask.id)} data-testid="writing-task-retry"><RotateCcw size={14} />{t('ai.retry')}</button></div>}
            </div>
          ) : taskLive || taskTask?.status === 'done' ? (
            <p className="flex items-center gap-2 text-sm text-mute" data-testid="writing-task-progress"><Loader2 size={15} className="animate-spin text-accent" />{t('writing.taskProgress')}</p>
          ) : (
            <div role="alert" className="vocab-wrap rounded-xl border border-danger/30 bg-danger-soft p-3 text-sm text-danger" data-testid="writing-task-failed">
              {taskTask?.error || t('writing.taskFailed')}
              {taskTask && <div className="mt-2"><button type="button" className={btnPlain} onClick={() => aiTasks.retry(taskTask.id)} data-testid="writing-task-retry"><RotateCcw size={14} />{t('ai.retry')}</button></div>}
            </div>
          )}

          {taskOk && (
            <div className="mt-4 min-w-0">
              <label htmlFor="writing-answer" className="text-sm font-medium text-ink">{t('writing.answerTitle')}</label>
              <textarea
                id="writing-answer" data-testid="writing-answer" value={draft} onChange={event => onDraft(event.target.value)} readOnly={locked}
                rows={6} placeholder={t('writing.answerPlaceholder')} spellCheck={false}
                className={`mt-2 block min-h-[9rem] w-full min-w-0 resize-y rounded-xl border border-line p-3 text-base leading-relaxed text-ink placeholder:text-faint ${locked ? 'bg-shade/40' : 'bg-paper'}`}
              />
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                <span className="text-xs text-mute" data-testid="writing-count">{t('writing.wordCount', { n: countWords(draft) })} · {t('writing.sentenceHint')}</span>
                <div className="flex w-full flex-wrap gap-2 sm:ml-auto sm:w-auto">
                  {reviewed && !rewriting && (
                    <button type="button" onClick={startRewrite} disabled={reviewing} data-testid="writing-rewrite" className={`${btnPlain} flex-1 sm:flex-none`}><PenLine size={14} />{t('writing.rewrite')}</button>
                  )}
                  {!(reviewed && !rewriting) && (
                    <button type="button" onClick={submit} disabled={!canReview} data-testid="writing-review-btn" className={`${btnPrimary} flex-1 sm:flex-none`}>
                      {reviewing ? <Loader2 size={15} className="animate-spin" /> : null}{reviewing ? t('writing.reviewing') : t('writing.review')}
                    </button>
                  )}
                </div>
              </div>
              {!locked && answerProblem && draft.trim() !== '' && <p className="mt-1 text-xs text-mute" data-testid="writing-answer-hint">{answerProblem}</p>}
              {reviewError && <p role="alert" className="vocab-wrap mt-2 text-sm text-danger" data-testid="writing-review-start-error">{reviewError}</p>}
            </div>
          )}

          {reviewing && (
            <p className="mt-3 flex items-center gap-2 text-sm text-mute" data-testid="writing-review-progress"><Loader2 size={15} className="animate-spin text-accent" />{t('writing.reviewProgress')}</p>
          )}
          {!review && !reviewing && reviewTask?.status === 'failed' && (
            <div role="alert" className="vocab-wrap mt-3 rounded-xl border border-danger/30 bg-danger-soft p-3 text-sm text-danger" data-testid="writing-review-failed">
              {reviewTask.error || t('writing.reviewFailed')}
              <div className="mt-2"><button type="button" className={btnPlain} onClick={() => aiTasks.retry(reviewTask.id)} data-testid="writing-review-retry"><RotateCcw size={14} />{t('ai.retry')}</button></div>
            </div>
          )}
          {review && (
            <div data-testid="writing-review-area">
              <WritingReviewBlock recordId={record.id} review={review} />
              {review.error && reviewTask && (
                <button type="button" className={`${btnPlain} mt-2`} onClick={() => aiTasks.retry(reviewTask.id)} data-testid="writing-review-retry"><RotateCcw size={14} />{t('ai.retry')}</button>
              )}
            </div>
          )}

          {(record.versions?.length ?? 0) > 0 && (
            <details className="mt-4 rounded-xl border border-line bg-paper p-3 text-sm" data-testid="writing-versions">
              <summary className="cursor-pointer text-ink">{t('writing.versions', { n: record.versions?.length ?? 0 })}</summary>
              <ul className="mt-2 space-y-3">
                {record.versions?.map((version, index) => (
                  <li key={version.at + index} className="vocab-wrap" data-testid="writing-version">
                    <p className="whitespace-pre-wrap text-ink">{version.answer}</p>
                    {version.review.task && <p className="mt-1 text-xs text-mute">{version.review.task.comment}</p>}
                    {version.review.better && <p className="mt-1 font-serif text-ink">{version.review.better}</p>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {/* 历史 */}
      <section className="min-w-0 rounded-2xl border border-line bg-page p-4 md:p-5" aria-labelledby="writing-history-title" data-testid="writing-history">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="writing-history-title" className="text-base font-medium text-ink">{t('writing.historyTitle')}</h2>
          <span className="shrink-0 text-xs text-mute">{t('writing.historyCount', { n: records.length })}</span>
        </div>
        {records.length === 0 ? <p className="mt-3 text-sm text-mute">{t('writing.historyEmpty')}</p> : (
          <ul className="mt-3 min-w-0">
            {records.slice(0, 20).map(item => (
              <li key={item.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-3 last:border-b-0" data-testid="writing-history-item" data-record-id={item.id} data-current={item.id === currentId ? '1' : '0'}>
                <button type="button" onClick={() => open(item.id)} data-testid="writing-history-open" className="press min-w-0 flex-1 basis-56 text-left">
                  <span className="vocab-wrap block text-sm text-ink">{snippet(item)}</span>
                  <span className="mt-0.5 block text-xs text-mute">{sceneName(item.scene)} · {dateOf(item.createdAt)} · {item.review && !item.review.error ? t('writing.historyReviewed') : t('writing.historyNotReviewed')}</span>
                </button>
                <button type="button" onClick={() => remove(item.id)} data-testid="writing-history-delete" aria-label={t('writing.delete')}
                  className={`press inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs ${confirmId === item.id ? 'bg-danger-soft text-danger' : 'text-mute hover:text-danger'}`}>
                  <Trash2 size={13} />{confirmId === item.id ? t('writing.deleteConfirm') : t('writing.delete')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
