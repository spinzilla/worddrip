import React, { useMemo, useState, type FormEvent } from 'react';
import { ChevronDown, LoaderCircle, PenLine } from 'lucide-react';
import type { CoachArchiveItemInput, CoachArchivePlan, CoachTop } from '../../utils/vocab/types';
import { vocabApi } from '../../utils/vocab/api';
import { makeArchiveRequest, suggestedArchiveItems } from '../../utils/coach/archiveWrite';
import { requestFirstReview, requestRewriteReview } from '../../utils/coach/reviewClient';
import {
  analyzeEssay,
  honestyNoticeFor,
  PAPER_LABELS,
  type EssayAnalysis,
  type FirstReview,
  type PaperChoice,
  type RewriteReview,
} from '../../utils/coach/review';

type Phase = 'idle' | 'reviewing' | 'self-check' | 'rewriting' | 'done';

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold text-ink">{children}</h3>;
}

export default function EssayReview({ top, onArchived }: { top: CoachTop[]; onArchived: () => void | Promise<void> }) {
  const [essay, setEssay] = useState('');
  const [choice, setChoice] = useState<PaperChoice>('auto');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [longPending, setLongPending] = useState(false);
  const [analysis, setAnalysis] = useState<EssayAnalysis | null>(null);
  const [review, setReview] = useState<FirstReview | null>(null);
  const [rewrite, setRewrite] = useState<RewriteReview | null>(null);
  // 点过「我改完了」或「跳过」就展开自查答案；改写请求失败也照常显示。
  const [answersShown, setAnswersShown] = useState(false);
  const [archiveReviewId, setArchiveReviewId] = useState('');
  const [archiveItems, setArchiveItems] = useState<CoachArchiveItemInput[]>([]);
  const [archivePreview, setArchivePreview] = useState<CoachArchivePlan | null>(null);
  const [archiveReport, setArchiveReport] = useState<CoachArchivePlan | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState('');
  const preview = useMemo(() => analyzeEssay(essay, choice), [essay, choice]);
  const busy = phase === 'reviewing' || phase === 'rewriting';

  const clearResult = () => {
    setPhase('idle');
    setError('');
    setLongPending(false);
    setAnalysis(null);
    setReview(null);
    setRewrite(null);
    setAnswersShown(false);
    setArchiveReviewId('');
    setArchiveItems([]);
    setArchivePreview(null);
    setArchiveReport(null);
    setArchiveError('');
  };

  const startReview = async (longConfirmed = false) => {
    const source = essay.trim();
    if (!source) {
      setError('请先粘贴一篇英语作文。');
      return;
    }
    const current = analyzeEssay(source, choice);
    if (current.wordCount > 400 && !longConfirmed) {
      setLongPending(true);
      setError('');
      return;
    }
    setPhase('reviewing');
    setError('');
    setLongPending(false);
    setAnalysis(null);
    setReview(null);
    setRewrite(null);
    setAnswersShown(false);
    setArchiveReviewId('');
    setArchiveItems([]);
    setArchivePreview(null);
    setArchiveReport(null);
    setArchiveError('');
    try {
      const result = await requestFirstReview(source, choice, top);
      setAnalysis(result.analysis);
      setReview(result.review);
      setPhase('self-check');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPhase('idle');
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy) void startReview();
  };

  const showRewrite = async () => {
    if (!analysis || !review || busy) return;
    // 「跳过」也算看过自查了：答案不再等改写成功才显示。
    setAnswersShown(true);
    setPhase('rewriting');
    setError('');
    try {
      setRewrite(await requestRewriteReview(essay.trim(), analysis, review));
      setPhase('done');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPhase('self-check');
    }
  };


  const loadArchivePreview = async (reviewId: string, items: CoachArchiveItemInput[]) => {
    if (!analysis || !review) return;
    setArchiveBusy(true);
    setArchiveError('');
    try {
      const request = makeArchiveRequest(reviewId, essay.trim(), analysis, review, rewrite, items);
      setArchivePreview(await vocabApi.previewCoachArchive(request));
    } catch (reason) {
      setArchivePreview(null);
      setArchiveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setArchiveBusy(false);
    }
  };

  const openArchive = async () => {
    if (!review || archiveReport) return;
    const reviewId = archiveReviewId || crypto.randomUUID();
    const items = suggestedArchiveItems(review.corrections, top);
    setArchiveReviewId(reviewId);
    setArchiveItems(items);
    setArchiveReport(null);
    await loadArchivePreview(reviewId, items);
  };

  const changeArchiveKind = async (index: number, kind: string) => {
    const items = archiveItems.map((item, itemIndex) => itemIndex === index ? { ...item, kind } : item);
    setArchiveItems(items);
    await loadArchivePreview(archiveReviewId, items);
  };

  const confirmArchive = async () => {
    if (!analysis || !review || !archivePreview || archiveBusy) return;
    setArchiveBusy(true);
    setArchiveError('');
    try {
      const request = makeArchiveRequest(archiveReviewId, essay.trim(), analysis, review, rewrite, archiveItems);
      const result = await vocabApi.archiveCoachReview(request);
      setArchiveReport(result);
      setArchivePreview(null);
      await onArchived();
    } catch (reason) {
      setArchiveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setArchiveBusy(false);
    }
  };
  return (
    <section className="mb-5 min-w-0 rounded-2xl border border-line bg-page p-4 md:p-5" aria-labelledby="essay-review-title" data-testid="essay-review">
      <div className="flex min-w-0 items-start gap-3">
        <span className="rounded-xl bg-accent/10 p-2 text-accent"><PenLine size={18} /></span>
        <div className="min-w-0">
          <h2 id="essay-review-title" className="text-base font-medium text-ink">批改作文</h2>
          <p className="mt-1 text-sm leading-6 text-mute">先看逐句改错和自查题；你改完或跳过后，才会请求整段改写示范。</p>
        </div>
      </div>

      <form className="mt-4" onSubmit={submit}>
        <label htmlFor="coach-essay" className="text-sm font-medium text-ink">作文和题目材料</label>
        <textarea
          id="coach-essay"
          data-testid="review-essay"
          value={essay}
          disabled={busy}
          onChange={event => { setEssay(event.target.value); clearResult(); }}
          placeholder="粘贴英语作文；如果是 EAP 真题，也可以把题目要求一起贴上，方便自动判定卷面。"
          className="mt-2 min-h-40 w-full resize-y rounded-xl border border-line bg-page p-3 text-sm leading-6 text-ink outline-none placeholder:text-mute focus:border-accent disabled:opacity-60"
        />
        <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="min-w-0">
            <label htmlFor="coach-paper-type" className="text-xs text-mute">卷面类型</label>
            <select
              id="coach-paper-type"
              data-testid="review-paper-type"
              value={choice}
              disabled={busy}
              onChange={event => { setChoice(event.target.value as PaperChoice); clearResult(); }}
              className="mt-1 w-full rounded-xl border border-line bg-page px-3 py-2.5 text-sm text-ink outline-none focus:border-accent disabled:opacity-60"
            >
              <option value="auto">自动判定</option>
              <option value="part-b">EAP Part B</option>
              <option value="part-c">EAP Part C</option>
              <option value="general">通用学术写作</option>
            </select>
          </div>
          <button data-testid="review-submit" type="submit" disabled={busy} className="press inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-white disabled:cursor-wait disabled:opacity-60">
            {phase === 'reviewing' && <LoaderCircle size={16} className="animate-spin" />}
            {phase === 'reviewing' ? '正在批改……' : '开始批改'}
          </button>
        </div>
      </form>

      <div className="mt-3 flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs text-mute" data-testid="review-metrics-preview">
        <span>程序实测：{preview.wordCount} 词</span>
        <span>AWL 覆盖率：{preview.awlCoverage}%</span>
        <span className="break-words">{PAPER_LABELS[preview.paperType]}</span>
      </div>
      {essay.trim() && preview.lowAwl && <p className="mt-2 text-xs text-clay">AWL 覆盖率低于 5%，词汇偏泛用；总评会重点提醒。</p>}
      {longPending && (
        <div className="mt-4 rounded-xl border border-clay/30 bg-clay-soft/60 p-4" data-testid="review-long-confirm">
          <p className="text-sm leading-6 text-ink">这篇有 {preview.wordCount} 词，超过 400 词。完整批改会更慢、花费更多，要继续吗？</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => void startReview(true)} className="press rounded-lg bg-accent px-4 py-2 text-sm text-white">继续完整批改</button>
            <button type="button" onClick={() => setLongPending(false)} className="press rounded-lg border border-line bg-page px-4 py-2 text-sm text-ink">先不批</button>
          </div>
        </div>
      )}
      {error && <p role="alert" data-testid="review-error" className="mt-4 break-words rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm text-danger">{error}</p>}

      {analysis && review && (
        <div className="mt-5 min-w-0 space-y-5 border-t border-line pt-5" data-testid="review-result">
          <section>
            <SectionTitle>① 总评</SectionTitle>
            <dl className="mt-3 grid gap-2 rounded-xl bg-paper p-3 text-sm sm:grid-cols-2">
              <div><dt className="inline text-mute">卷面：</dt><dd className="inline text-ink">{PAPER_LABELS[analysis.paperType]}</dd></div>
              <div><dt className="inline text-mute">词数：</dt><dd className="inline text-ink">{analysis.wordCount} / {analysis.wordRequirement}</dd></div>
              <div><dt className="inline text-mute">AWL：</dt><dd className="inline text-ink">{analysis.awlCoverage}%（命中 {analysis.awlCount} 词次）</dd></div>
              <div><dt className="inline text-mute">AWL 词族：</dt><dd className="inline break-words text-ink">{analysis.awlFamilies.map(item => item.headword).join('、') || '无'}</dd></div>
            </dl>
            <p className="mt-2 text-xs leading-5 text-mute">{analysis.paperReason}</p>
            {analysis.lowAwl && <p className="mt-2 text-sm text-clay">词汇偏泛用：AWL 覆盖率低于 5%，优先把模糊、口语化表达换成更准确的学术词。</p>}
            {honestyNoticeFor(analysis.paperType) && <p className="mt-3 rounded-xl border border-line p-3 text-xs leading-5 text-mute" data-testid="review-honesty">{honestyNoticeFor(analysis.paperType)}</p>}
            {analysis.paperType !== 'general' && review.summary.hardChecks.length > 0 && (
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-6 text-ink">{review.summary.hardChecks.map(item => <li key={item}>{item}</li>)}</ul>
            )}
            <div className="mt-3 space-y-2">
              {review.summary.weakFeatures.map(item => <p key={item.feature} className="text-sm leading-6 text-ink"><strong>{item.feature}</strong>：{item.note}</p>)}
            </div>
            <p className="mt-3 text-sm leading-6 text-ink"><strong>最该改的一件事：</strong>{review.summary.oneThing}</p>
          </section>

          <section>
            <SectionTitle>② 逐句改错</SectionTitle>
            {review.corrections.length === 0 ? <p className="mt-2 text-sm text-mute">没有发现需要逐句修改的问题。</p> : (
              <div className="mt-3 space-y-3">
                {review.corrections.map((item, index) => (
                  <article key={`${index}-${item.original}`} className="min-w-0 rounded-xl border border-line p-3">
                    <p className="text-xs text-clay">{item.kind}</p>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-ink [overflow-wrap:anywhere]">{item.original}</p>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-ink [overflow-wrap:anywhere]"><span className="text-mute">改法：</span>{item.correction}</p>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-mute">{item.why}</p>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section>
            <SectionTitle>②+ 先自查，再看示范</SectionTitle>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6 text-ink">
              {review.selfCheck.map((item, index) => <li key={`${index}-${item.question}`}>{item.question}</li>)}
            </ol>
            {phase !== 'done' && (
              <div className="mt-4 flex flex-wrap gap-2">
                <button data-testid="review-done" type="button" disabled={busy} onClick={() => void showRewrite()} className="press rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60">我改完了</button>
                <button data-testid="review-skip" type="button" disabled={busy} onClick={() => void showRewrite()} className="press rounded-xl border border-line bg-page px-4 py-2.5 text-sm text-ink disabled:opacity-60">跳过</button>
                {phase === 'rewriting' && <span className="inline-flex items-center gap-2 text-sm text-mute"><LoaderCircle size={15} className="animate-spin" />正在生成改写示范……</span>}
              </div>
            )}
          </section>

          {rewrite && (
            <section data-testid="review-rewrite">
              <SectionTitle>③ 整段改写示范</SectionTitle>
              <p className="mt-3 whitespace-pre-wrap break-words rounded-xl border border-line p-4 text-sm leading-7 text-ink [overflow-wrap:anywhere]">{rewrite.rewrite}</p>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-6 text-mute">{rewrite.improvements.map(item => <li key={item}>{item}</li>)}</ul>
            </section>
          )}

          <section>
            <SectionTitle>④ 与档案对照</SectionTitle>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl bg-paper p-3"><h4 className="text-xs font-medium text-clay">老毛病复发</h4><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink">{review.archiveComparison.recurring.join('\n') || '本次未发现。'}</p></div>
              <div className="rounded-xl bg-paper p-3"><h4 className="text-xs font-medium text-ink">新问题</h4><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink">{review.archiveComparison.newIssues.join('\n') || '本次未发现。'}</p></div>
            </div>
          </section>

          {answersShown && (
              <details className="group rounded-xl border border-line" data-testid="review-answers">
                <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-sm font-medium text-ink"><ChevronDown size={16} className="text-mute transition-transform group-open:rotate-180" />自查题答案（需要时再展开）</summary>
                <ol className="list-decimal space-y-3 border-t border-line p-4 pl-9 text-sm leading-6 text-ink">
                  {review.selfCheck.map((item, index) => <li key={`${index}-${item.answer}`}><span className="text-mute">{item.question}</span><br />{item.answer}</li>)}
                </ol>
              </details>
          )}

          <section className="rounded-xl border border-line p-4" data-testid="review-archive">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <div><SectionTitle>⑤ 归档这篇批改</SectionTitle><p className="mt-1 text-xs leading-5 text-mute">先核对错误类别和统计变化，确认后才写入；旧批次和旧错误不会被覆盖。</p></div>
              {!archivePreview && !archiveReport && <button type="button" data-testid="archive-open" disabled={archiveBusy} onClick={() => void openArchive()} className="press rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60">归档</button>}
            </div>
            {archiveError && <p role="alert" className="mt-3 break-words text-sm text-danger">{archiveError}</p>}
            {archiveBusy && <p className="mt-3 inline-flex items-center gap-2 text-sm text-mute"><LoaderCircle size={15} className="animate-spin" />正在处理归档……</p>}
            {archivePreview && !archiveBusy && (
              <div className="mt-4 space-y-4">
                <div>
                  <h4 className="text-xs font-medium text-ink">将新增 {archivePreview.itemsAdded} 条错误；点击类别可改成已有高频项</h4>
                  {archiveItems.length === 0 ? <p className="mt-2 text-sm text-mute">本次没有逐句错误，只保存作文、批改结果，并更新各类别的连续未犯次数。</p> : (
                    <div className="mt-2 space-y-2">{archiveItems.map((item, index) => {
                      const isNew = !top.some(candidate => candidate.kind === item.kind);
                      return <div key={`${index}-${item.written}`} className="grid min-w-0 gap-2 rounded-lg bg-paper p-3 text-sm md:grid-cols-[minmax(0,1fr)_minmax(180px,0.6fr)] md:items-center">
                        <span className="min-w-0 break-words text-ink [overflow-wrap:anywhere]">{item.written}</span>
                        <select aria-label={`第 ${index + 1} 条错误的归档类别`} value={item.kind} onChange={event => void changeArchiveKind(index, event.target.value)} className="min-w-0 rounded-lg border border-line bg-page px-2 py-2 text-sm text-ink">
                          {isNew && <option value={item.kind}>新增：{item.kind}</option>}
                          {top.map(candidate => <option key={candidate.id} value={candidate.kind}>{candidate.kind}</option>)}
                        </select>
                      </div>;
                    })}</div>
                  )}
                </div>
                <div>
                  <h4 className="text-xs font-medium text-ink">高频统计预览</h4>
                  {archivePreview.topChanges.length === 0 ? <p className="mt-2 text-sm text-mute">没有高频类别变化。</p> : <ul className="mt-2 space-y-2">{archivePreview.topChanges.map(change => <li key={change.topId} className="break-words rounded-lg border border-line p-3 text-xs leading-5 text-ink">
                    <strong>{change.isNew ? '新增类别 · ' : ''}{change.kind}</strong>：次数 {change.beforeCount} → {change.afterCount}（本次 +{change.occurrences}）；连续未犯 {change.beforeClean} → {change.afterClean} 次；状态 {change.beforeStatus || '—'} → {change.afterStatus}{change.occurrences > 0 ? `；最近一次改为 ${change.afterLastAt}` : '；最近一次不变'}
                  </li>)}</ul>}
                </div>
                <div className="flex flex-wrap gap-2"><button type="button" data-testid="archive-confirm" onClick={() => void confirmArchive()} className="press rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white">确认写入</button><button type="button" onClick={() => setArchivePreview(null)} className="press rounded-xl border border-line bg-page px-4 py-2.5 text-sm text-ink">取消</button></div>
              </div>
            )}
            {archiveReport && (
              <div className="mt-4 rounded-xl bg-paper p-3" data-testid="archive-report">
                <h4 className="text-sm font-medium text-ink">{archiveReport.duplicate ? '这篇已经归档，没有重复写入。' : '归档完成，实际改动如下'}</h4>
                {!archiveReport.duplicate && <><p className="mt-2 text-sm leading-6 text-ink">数据库新增：1 篇作文及批改结果、1 个错误批次、{archiveReport.itemsAdded} 条错误项、{archiveReport.topChanges.filter(change => change.isNew).length} 个高频类别。</p>
                <ul className="mt-2 space-y-1 text-xs leading-5 text-mute">{archiveReport.topChanges.map(change => <li key={change.topId}>{change.kind}：次数 {change.beforeCount} → {change.afterCount}，连续未犯 {change.beforeClean} → {change.afterClean} 次，状态 {change.beforeStatus || '—'} → {change.afterStatus}。</li>)}</ul></>}
              </div>
            )}
          </section>        </div>
      )}
    </section>
  );
}
