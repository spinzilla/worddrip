import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, RefreshCw, Sparkles } from 'lucide-react';
import { vocabApi } from '../../utils/vocab/api';
import { createLatestGate } from '../../utils/vocab/browse';
import {
  ALL_ISSUES,
  FIRST_TEST_LIMIT,
  NO_ISSUE,
  defaultIssue,
  firstTestBatch,
  seedCount,
  seedIssueOptions,
} from '../../utils/vocab/firstTest';
import { prepareRecallRound, surfaceKey, surfaceOf } from '../../utils/vocab/recall';
import type { RecallQuestion, RecallRound } from '../../utils/vocab/recall';
import { consumePendingRecallQuestion, prepareCachedRecallRound } from '../../utils/vocab/recallCache';
import { hasQuestionModel, requestModelQuestions, requestUsageTasks, usageMixEnabled } from '../../utils/vocab/recallModel';
import type { BrowseReviewWord } from '../../utils/vocab/types';
import RecallReview from './RecallReview';
import FirstTestPreview from './FirstTestPreview';
import { onVocabChanged } from '../../utils/vocab/manualAdd';
import { onFirstTestRequest } from '../../utils/vocab/dailyWords';
import './vocab.css';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface Props {
  /** 变化时重新读取（例如从「导入」切回来）。 */
  refreshKey: string;
}

const issueLabel = (issue: string) => (issue === NO_ISSUE ? NO_ISSUE : `${issue} 期`);

/**
 * 新词首考（032）：先选期号，每批从「待考察」的新词里取 7 个，按期内原顺序。
 * 出题/判分/保存/复检全部复用 RecallReview（030 + 031），这里管选词、预习记录和剩余数量。
 */
export default function FirstTestPanel({ refreshKey }: Props) {
  const gateRef = useRef(createLatestGate());
  const startRef = useRef<HTMLButtonElement>(null);
  const [words, setWords] = useState<BrowseReviewWord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [issue, setIssue] = useState('');
  const [mode, setMode] = useState<'preview' | 'first' | null>(null);
  const [previewed, setPreviewed] = useState<ReadonlySet<string>>(new Set());
  const [round, setRound] = useState<RecallRound | null>(null);
  const [prepareError, setPrepareError] = useState('');
  const [modelOn, setModelOn] = useState(false);
  const [before, setBefore] = useState<Record<string, { status: string; due: string }>>({});
  const [batchRemaining, setBatchRemaining] = useState(0);
  /** 只控制界面显示；退出后才回来的题照样由缓存工具保存。 */
  const tokenRef = useRef(0);
  const flaggedRef = useRef<Set<string>>(new Set());
  const recheckUsedRef = useRef<Set<string>>(new Set());
  const openRef = useRef(false);
  openRef.current = mode !== null;

  const load = useCallback(() => {
    // 首考进行中不刷新：本批选好的词不会被新数据换掉。
    if (openRef.current) return;
    const gate = gateRef.current;
    const token = gate.next();
    setLoading(true);
    setError('');
    vocabApi.browse().then(value => {
      if (!gate.isCurrent(token)) return;
      setWords(value.reviewWords);
      setLoading(false);
    }).catch(reason => {
      if (!gate.isCurrent(token)) return;
      setError(`读取新词失败：${errorText(reason)}`);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    gateRef.current.revive();
    return () => gateRef.current.dispose();
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);
  // 042：手动加词、收件箱入库后新词数马上跟着变。
  useEffect(() => onVocabChanged(load), [load]);
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

  const options = useMemo(() => seedIssueOptions(words), [words]);
  const total = useMemo(() => seedCount(words), [words]);
  // 默认最早、且还有新词的一期；用户选的期还在就保留，数据变了自动退回默认。
  const chosen = issue && (issue === ALL_ISSUES || options.some(option => option.issue === issue))
    ? issue
    : defaultIssue(words);
  const batch = useMemo(() => firstTestBatch(words, chosen), [words, chosen]);
  const chosenTotal = chosen === ALL_ISSUES ? total : options.find(option => option.issue === chosen)?.remaining ?? 0;

  const begin = () => {
    if (batch.queue.length === 0) return;
    const token = ++tokenRef.current;
    setRound(null);
    setPrepareError('');
    setPreviewed(new Set());
    setMode('preview');
    const modelOnNow = hasQuestionModel();
    const generate = modelOnNow ? requestModelQuestions : null;
    setBefore(Object.fromEntries(batch.queue.map(word => [word.id, { status: word.status, due: word.due }])));
    setModelOn(modelOnNow);
    setBatchRemaining(batch.remaining);
    recheckUsedRef.current = new Set();
    vocabApi.flaggedSurfaces()
      .then(flagged => {
        const exclude = new Set(flagged.map(entry => surfaceKey(entry.wordId, entry.detail)));
        flaggedRef.current = exclude;
        return prepareCachedRecallRound(batch.queue, {
          generate,
          exclude,
          limit: FIRST_TEST_LIMIT,
          noun: '新词',
          // 038：首考同样混入改写/造句题；没配模型时只出填空并说明原因。
          mix: usageMixEnabled(),
          generateUsage: modelOnNow ? requestUsageTasks : null,
        });
      })
      .then(value => {
        if (tokenRef.current === token) setRound(value);
      })
      .catch(reason => {
        if (tokenRef.current === token) setPrepareError(`准备题目失败：${errorText(reason)}`);
      });
  };

  // 同日复检：同一个词换一个新语境；永远不重复首轮和已用过的题面。
  // 081 每日新词收完后「去做首考」：选好那一期，等词读进来就直接开始。
  const goRef = useRef(false);
  const beginRef = useRef(begin);
  beginRef.current = begin;
  useEffect(() => onFirstTestRequest(requested => {
    setIssue(requested);
    // 首考已经在进行中就不再自动开始（load 也不会刷新），免得结束后凭空又开一轮
    goRef.current = !openRef.current;
    startRef.current?.scrollIntoView?.({ block: 'center' });
    load();
  }), [load]);
  useEffect(() => {
    if (!goRef.current || loading || mode !== null) return;
    // 读完了：有词就开始；这一期没有词或读取出错，也把一次性标志复位，免得之后某次刷新读到词时自动开始
    const ready = !error && batch.queue.length > 0;
    goRef.current = false;
    if (ready) beginRef.current();
  }, [loading, batch, mode, error]);

  const makeRecheck = useCallback(async (wordId: string, usedSurface: string): Promise<RecallQuestion | string> => {
    const word = batch.queue.find(entry => entry.id === wordId);
    if (!word) return '找不到这个词，无法换语境。';
    const exclude = new Set([...flaggedRef.current, ...recheckUsedRef.current, surfaceKey(wordId, usedSurface)]);
    const generate = hasQuestionModel() ? requestModelQuestions : null;
    const recheckRound = await prepareRecallRound([word], { generate, limit: 1, exclude, requireContext: true, noun: '新词' });
    const question = recheckRound.questions[0];
    if (!question) return recheckRound.skipped[0]?.reason ?? '没有别的语境可换。';
    recheckUsedRef.current.add(surfaceKey(wordId, surfaceOf(question)));
    return question;
  }, [batch.queue]);

  // 退出后焦点回到开始按钮，键盘用户不会迷路。
  useEffect(() => {
    if (mode === null) startRef.current?.focus();
  }, [mode]);

  const exit = useCallback(() => {
    setMode(null);
    setRound(null);
    setPrepareError('');
    tokenRef.current += 1;
    openRef.current = false;
    load();
  }, [load]);

  const startReview = (seen: ReadonlySet<string>) => {
    setPreviewed(new Set(seen));
    setMode('first');
  };

  return (
    <section className="mb-6 rounded-2xl border border-line bg-page p-4 md:p-5" data-testid="first-test-panel" aria-label="新词首考">
      <div className="flex flex-wrap items-center gap-3">
        <Sparkles className="shrink-0 text-ink" size={20} />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-ink">新词首考</h2>
          <p className="mt-0.5 text-xs text-mute">
            {loading && words.length === 0
              ? <span data-testid="seed-count">正在读取…</span>
              : <span className="vocab-chip border-line bg-shade text-ink" data-testid="seed-count">待首考 {total} 个</span>}
          </p>
        </div>
        <button type="button" onClick={load} disabled={loading} title="重新读取" aria-label="刷新新词" className="press shrink-0 rounded-xl border border-line p-2.5 text-ink">
          <RefreshCw size={16} />
        </button>
      </div>

      {error && (
        <div role="alert" className="vocab-wrap mt-3 rounded-xl border border-danger/30 bg-danger-soft p-3 text-sm text-danger">{error}</div>
      )}

      {!error && (
        <>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="min-w-0 text-sm text-ink" htmlFor="first-test-issue">
              <span className="block text-xs text-mute">选期号</span>
              <select
                id="first-test-issue"
                value={chosen}
                onChange={event => setIssue(event.target.value)}
                className="press mt-1 max-w-full rounded-xl border border-line bg-page px-3 py-2 text-sm text-ink outline-none focus:border-ink"
                data-testid="first-test-issue"
              >
                {options.map(option => (
                  <option key={option.issue} value={option.issue}>
                    {issueLabel(option.issue)} · 新词 {option.remaining}
                  </option>
                ))}
                <option value={ALL_ISSUES}>全部按期号顺序 · 新词 {total}</option>
              </select>
            </label>
            <button
              ref={startRef}
              type="button"
              onClick={begin}
              disabled={loading || batch.queue.length === 0}
              className="press inline-flex shrink-0 items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40"
              data-testid="first-test-start"
            >
              <Play size={14} />开始首考
            </button>
          </div>
          <p className="vocab-wrap mt-2 text-xs text-mute" data-testid="first-test-hint">
            每次 {FIRST_TEST_LIMIT} 个，按期内原顺序；没有可出题数据的跳过并计数。本范围还有 {chosenTotal} 个新词待首考。
          </p>
          {!loading && total === 0 && (
            <p className="mt-3 rounded-xl bg-page p-3 text-sm text-mute" data-testid="first-test-empty">
              还没有待考察的新词。手动添加、手写收件箱和导入进来的新词都会是「待考察」，攒够一批就能首考。
            </p>
          )}
        </>
      )}

      {mode === 'preview' && (
        <FirstTestPreview words={batch.queue} onStart={startReview} onExit={exit} />
      )}

      {mode === 'first' && (
        <RecallReview
          round={round}
          prepareError={prepareError}
          modelOn={modelOn}
          before={before}
          makeRecheck={makeRecheck}
          onQuestionConsumed={consumePendingRecallQuestion}
          onExit={exit}
          variant="first"
          remaining={batchRemaining}
          previewed={previewed}
        />
      )}
    </section>
  );
}
