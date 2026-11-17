import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Play, RefreshCw } from 'lucide-react';
import { vocabApi } from '../../utils/vocab/api';
import { createLatestGate } from '../../utils/vocab/browse';
import { dueLabel, dueQueue, localToday } from '../../utils/vocab/due';
import { startSession } from '../../utils/vocab/flashcards';
import { statusLabel } from '../../utils/vocab/library';
import type { FlashState } from '../../utils/vocab/flashcards';
import { prepareRecallRound, surfaceKey, surfaceOf } from '../../utils/vocab/recall';
import type { RecallQuestion, RecallRound } from '../../utils/vocab/recall';
import { consumePendingRecallQuestion, prepareCachedRecallRound } from '../../utils/vocab/recallCache';
import { hasQuestionModel, requestModelQuestions, requestUsageTasks, usageMixEnabled } from '../../utils/vocab/recallModel';
import type { BrowseReviewWord } from '../../utils/vocab/types';
import Flashcards from './Flashcards';
import RecallReview from './RecallReview';
import './vocab.css';
import { IS_MOBILE } from '../../utils/platform';
import { notifyVocabDueCount } from './useVocabDueCount';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
type ReviewMode = 'flash' | 'recall' | null;

interface Props {
  /** 变化时重新读取（例如从「导入」切回来）。 */
  refreshKey: string;
  /** 顶部「单词复习」按钮的请求编号；只负责打开，题目仍由本面板生成。 */
  startRequest?: number;
}

/** 今日到期列表；闪卡只读，产出题会把每题结果写回复习库。 */
export default function DuePanel({ refreshKey, startRequest = 0 }: Props) {
  const gateRef = useRef(createLatestGate());
  const startRef = useRef<HTMLButtonElement>(null);
  const recallStartRef = useRef<HTMLButtonElement>(null);
  const [words, setWords] = useState<BrowseReviewWord[]>([]);
  const [today, setToday] = useState(() => localToday());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<ReviewMode>(null);
  const [session, setSession] = useState<FlashState | null>(null);
  const [recallRound, setRecallRound] = useState<RecallRound | null>(null);
  const [recallError, setRecallError] = useState('');
  /** 只控制界面显示；退出后才回来的题照样由缓存工具保存。 */
  const recallTokenRef = useRef(0);
  const [recallBefore, setRecallBefore] = useState<Record<string, { status: string; due: string }>>({});
  const [recallModelOn, setRecallModelOn] = useState(false);
  const flaggedRef = useRef<Set<string>>(new Set());
  const recheckUsedRef = useRef<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const openRef = useRef(false);
  const handledStart = useRef(0);
  openRef.current = mode !== null;

  const load = useCallback(() => {
    // 任一复习进行中都不刷新：进入时固定的队列不会被新数据换掉。
    if (openRef.current) return;
    const gate = gateRef.current;
    const token = gate.next();
    setToday(localToday());
    setLoading(true);
    setError('');
    vocabApi.browse().then(value => {
      if (!gate.isCurrent(token)) return;
      setWords(value.reviewWords);
      setLoading(false);
    }).catch(reason => {
      if (!gate.isCurrent(token)) return;
      setError(`读取到期词失败：${errorText(reason)}`);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    gateRef.current.revive();
    return () => gateRef.current.dispose();
  }, []);

  // 进入页面、切回浏览时读取；窗口重新获得焦点时也刷新（可能已经跨过午夜）。
  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => {
    const onFocus = () => load();
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const queue = useMemo(() => dueQueue(words, today), [words, today]);
  const count = queue.length;
  useEffect(() => { if (!loading && !error) notifyVocabDueCount(count); }, [loading, error, count]);
  const PREVIEW = IS_MOBILE ? 3 : 8; // 手机第一屏要留出「添加词条」入口
  const shown = expanded ? queue : queue.slice(0, PREVIEW);

  const begin = () => {
    const next = startSession(queue);
    if (next === null) return;
    setSession(next);
    setMode('flash');
  };

  // 在点击时出题（只调一次模型）；准备期间弹层显示「正在准备题目」。
  const beginRecall = () => {
    if (queue.length === 0) return;
    const token = ++recallTokenRef.current;
    setRecallRound(null);
    setRecallError('');
    setMode('recall');
    const modelOn = hasQuestionModel();
    const generate = modelOn ? requestModelQuestions : null;
    // 首轮作答前的状态，结果表显示「L3 → L1」要用；用户标过「这题出错了」的题面本轮不再出。
    setRecallBefore(Object.fromEntries(queue.map(word => [word.id, { status: word.status, due: word.due }])));
    setRecallModelOn(modelOn);
    recheckUsedRef.current = new Set();
    vocabApi.flaggedSurfaces()
      .then(flagged => {
        const exclude = new Set(flagged.map(entry => surfaceKey(entry.wordId, entry.detail)));
        flaggedRef.current = exclude;
        // 038：首轮混入改写/造句题（没配模型时只出填空并说明原因）；复检仍只出填空。
        return prepareCachedRecallRound(queue, { generate, exclude, mix: usageMixEnabled(), generateUsage: modelOn ? requestUsageTasks : null });
      })
      .then(round => {
        if (recallTokenRef.current === token) setRecallRound(round);
      })
      .catch(reason => {
        if (recallTokenRef.current === token) setRecallError(`准备题目失败：${errorText(reason)}`);
      });
  };

  useEffect(() => {
    if (!startRequest || handledStart.current === startRequest || loading) return;
    handledStart.current = startRequest;
    if (count > 0 && mode === null) beginRecall();
  }, [startRequest, loading, count, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // 同日复检：同一个词换一个新语境（现成的别的例句，或模型现写）；永远不重复首轮和已用过的题面。
  const makeRecheck = useCallback(async (wordId: string, usedSurface: string): Promise<RecallQuestion | string> => {
    const word = queue.find(entry => entry.id === wordId);
    if (!word) return '找不到这个词，无法换语境。';
    const exclude = new Set([...flaggedRef.current, ...recheckUsedRef.current, surfaceKey(wordId, usedSurface)]);
    const generate = hasQuestionModel() ? requestModelQuestions : null;
    const round = await prepareRecallRound([word], { generate, limit: 1, exclude, requireContext: true });
    const question = round.questions[0];
    if (!question) return round.skipped[0]?.reason ?? '没有别的语境可换。';
    recheckUsedRef.current.add(surfaceKey(wordId, surfaceOf(question)));
    return question;
  }, [queue]);

  // 退出后焦点回到刚才的入口，键盘用户不会迷路。
  const restoreFocusRef = useRef<Exclude<ReviewMode, null> | null>(null);
  useEffect(() => {
    if (mode !== null || restoreFocusRef.current === null) return;
    const previous = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (previous === 'recall') recallStartRef.current?.focus();
    else startRef.current?.focus();
  }, [mode]);

  const exit = useCallback(() => {
    restoreFocusRef.current = mode;
    setMode(null);
    setSession(null);
    setRecallRound(null);
    setRecallError('');
    recallTokenRef.current += 1;
    openRef.current = false;
    load();
  }, [load, mode]);

  return (
    <section className="mb-6 rounded-2xl border border-line bg-page p-4 md:p-5" data-testid="due-panel" aria-label="今日到期">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex w-full items-center gap-3">
          <CalendarClock className="shrink-0 text-ink" size={20} />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-ink">今日到期</h2>
            <p className="text-xs text-mute" data-testid="due-count">
              {loading && words.length === 0 ? '正在读取…' : IS_MOBILE ? `${today} · ${count} 个` : `${today} · ${count} 个词到期或逾期`}
            </p>
          </div>
          <button type="button" onClick={load} disabled={loading} title="重新读取" aria-label="刷新到期词" className="press shrink-0 rounded-xl border border-line p-2.5 text-ink">
            <RefreshCw size={16} />
          </button>
        </div>
        <button
          ref={startRef}
          type="button"
          onClick={begin}
          disabled={count === 0}
          className="press inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-page px-4 py-2 text-sm text-ink max-md:order-2 max-md:w-full max-md:justify-center max-md:min-h-[44px] disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="due-start"
        >
          <Play size={14} />闪卡过一遍（不记进度）
        </button>
        <button
          ref={recallStartRef}
          type="button"
          onClick={beginRecall}
          disabled={count === 0}
          className="press inline-flex shrink-0 items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-sm text-white max-md:order-1 max-md:w-full max-md:justify-center max-md:min-h-[44px] disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="due-recall-start"
        >
          <Play size={14} />开始复习（记进度）
        </button>
      </div>

      {error && (
        <div role="alert" className="vocab-wrap mt-3 rounded-xl border border-danger/30 bg-danger-soft p-3 text-sm text-danger">{error}</div>
      )}

      {!error && !loading && count === 0 && (
        <p className="mt-3 rounded-xl bg-page p-3 text-sm text-mute" data-testid="due-empty">
          今天没有到期的词。只有 L1–L4 且下次到期不晚于今天的复习词会出现在这里。
        </p>
      )}

      {count > 0 && (
        <>
          <ul className="vocab-due-list mt-3" data-testid="due-list">
            {shown.map(item => (
              <li key={item.id} className="vocab-due-row rounded-xl border border-line p-2.5">
                <div className="vocab-wrap text-sm font-medium text-ink">{item.word}</div>
                <div className="vocab-wrap mt-0.5 text-xs text-mute">
                  {item.issue} 期 · {statusLabel(item.status)} · {item.due}
                  <span className={item.overdueDays > 0 ? 'ml-1 text-danger' : 'ml-1'}>（{dueLabel(item)}）</span>
                </div>
              </li>
            ))}
          </ul>
          {count > PREVIEW && (
            <button type="button" onClick={() => setExpanded(value => !value)} className="press mt-2 text-xs text-mute underline">
              {expanded ? '收起' : `展开全部 ${count} 个`}
            </button>
          )}
        </>
      )}

      {mode === 'flash' && session && <Flashcards initial={session} onExit={exit} />}
      {mode === 'recall' && (
        <RecallReview
          round={recallRound}
          prepareError={recallError}
          modelOn={recallModelOn}
          before={recallBefore}
          makeRecheck={makeRecheck}
          onQuestionConsumed={consumePendingRecallQuestion}
          onExit={exit}
        />
      )}
    </section>
  );
}
