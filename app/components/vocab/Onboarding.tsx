import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { vocabApi } from '../../utils/vocab/api';
import { notifyVocabChanged } from '../../utils/vocab/manualAdd';
import { DEFAULT_PER_DAY, PER_DAY_PRESETS, getPlan, today, wordKey } from '../../utils/vocab/dailyWords';
import { savePlanSynced } from '../../utils/vocab/dailyPlanSync';
import {
  GOALS, SOURCE_ESTIMATE, SOURCE_TEST, TOTAL, answer, createSession, describeLevel, estimateKnown, evaluate, goalsOfPacks,
  knownWords, nextQuestion, packsOfGoals, recommendPerDay,
  type Answer, type LevelResult, type Question, type Session, type TestDeps,
} from '../../utils/vocab/levelTest';
import { markOnboardingDone, onOpenOnboarding, saveLevelResult, shouldAutoShow, type OnboardingStep, type OpenRequest } from '../../utils/vocab/onboarding';
import { refreshPlan } from '../../utils/vocab/dailyPlanSync';
import { wordpackBand, wordpackList, type WordpackEntry } from '../../utils/wordpack';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const chip = (on: boolean) => `press min-h-[44px] rounded-full border px-4 text-sm ${on ? 'border-ink bg-ink text-white' : 'border-line bg-page text-ink'}`;
const primary = 'press min-h-[44px] rounded-full bg-ink px-5 text-sm text-white disabled:opacity-40';
const plain = 'press min-h-[44px] rounded-full border border-line bg-page px-5 text-sm text-ink disabled:opacity-40';
const link = 'press min-h-[44px] px-3 text-sm text-mute underline-offset-2 hover:underline';

const deps: TestDeps = { band: (from, to, n, seed) => wordpackBand(from, to, n, seed) };

/** 比估计值常见得多的词：按词频从常见往少见翻页，翻到名次够了为止（只取要的，不一次读完整个词表）。 */
async function entriesBelow(limit: number): Promise<WordpackEntry[]> {
  const out: WordpackEntry[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const page = await wordpackList([], { offset, limit: PAGE });
    for (const entry of page) if (entry.frq !== null && entry.frq < limit) out.push(entry);
    const last = [...page].reverse().find(entry => entry.frq !== null);
    if (page.length < PAGE || (last && last.frq !== null && last.frq >= limit)) break;
  }
  return out;
}

/** 测完把结果写进候选池：旧的自动记录先清掉，再写「点了认识的真词」和可信时「按估计值批量认识」的词。 */
export async function saveTestResult(answers: readonly Answer[], result: LevelResult): Promise<{ marked: number; estimated: number }> {
  const date = today();
  await vocabApi.pickClearKnown(SOURCE_ESTIMATE);
  const [data, picks] = await Promise.all([vocabApi.browse(), vocabApi.pickList()]);
  const library = new Set(data.reviewWords.map(word => wordKey(word.word)));
  const alreadyKnown = new Set(picks.filter(row => row.state === 'known').map(row => row.wordKey));
  const direct = knownWords(answers).filter(word => !alreadyKnown.has(wordKey(word))).map(word => ({ word, state: 'known' as const, pack: SOURCE_TEST, date }));
  let estimated: WordpackEntry[] = [];
  // 假词校正把估计压到最低值时，结果不可信，不把大量词批量记成认识。
  if (!(result.discounted && result.estimate === 300)) {
    const pool = await entriesBelow(result.estimate * 0.6);
    const directKeys = new Set(direct.map(item => wordKey(item.word)));
    estimated = estimateKnown(pool, result.estimate, { answers, picks, library }).filter(entry => !directKeys.has(wordKey(entry.word)));
  }
  const items = [...direct, ...estimated.map(entry => ({ word: entry.word, state: 'known' as const, pack: SOURCE_ESTIMATE, date }))];
  for (let i = 0; i < items.length; i += 500) await vocabApi.pickSet(items.slice(i, i + 500));
  saveLevelResult({ ...result, date });
  notifyVocabChanged();
  return { marked: direct.length, estimated: estimated.length };
}

// ---------- 第二步：测词汇量 ----------

function LevelTest({ onFinish, onSkip }: { onFinish: (answers: Answer[]) => void; onSkip: () => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = useRef(false);

  const begin = useCallback(async () => {
    setError('');
    try {
      const first = createSession();
      const next = await nextQuestion(deps, first);
      setSession(next.session);
      setQuestion(next.question);
    } catch (reason) { setError(`出题失败：${errorText(reason)}`); }
  }, []);
  useEffect(() => { if (ready.current) return; ready.current = true; void begin(); }, [begin]);

  const choose = useCallback(async (known: boolean) => {
    if (busy || !session || !question) return;
    setBusy(true);
    try {
      const after = answer(session, question, known);
      if (after.asked.length >= TOTAL) { onFinish(after.asked); return; }
      const next = await nextQuestion(deps, after);
      setSession(next.session);
      setQuestion(next.question);
    } catch (reason) { setError(`出题失败：${errorText(reason)}`); } finally { setBusy(false); }
  }, [busy, session, question, onFinish]);

  // 电脑上：← 不认识、→ 认识
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      const t = event.target;
      if (t instanceof Element && t.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); void choose(false); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); void choose(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [choose]);

  const done = session?.asked.length ?? 0;
  const realDone = session ? session.asked.filter(a => !a.fake).length : 0;
  const finishNow = () => { if (session && realDone > 0) onFinish(session.asked); else onSkip(); };

  return (
    <div data-testid="level-test">
      <div className="mb-1 flex items-center justify-between text-xs text-mute">
        <span data-testid="level-progress-text">第 {Math.min(done + 1, TOTAL)} / {TOTAL} 题</span>
        <button type="button" onClick={finishNow} data-testid="level-end" className={link}>结束测试</button>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={TOTAL} aria-valuenow={done} aria-label="测试进度">
        <div className="h-full rounded-full bg-ink transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${(done / TOTAL) * 100}%` }} />
      </div>
      {error && <p role="alert" className="vocab-wrap mt-4 rounded-xl border border-danger/30 bg-danger-soft p-3 text-sm text-danger">{error}<button type="button" onClick={() => void begin()} className="ml-2 underline">重试</button></p>}
      <div className="mt-6 flex min-h-[160px] flex-col items-center justify-center gap-2 rounded-2xl border border-line bg-paper p-5 text-center">
        {question ? <p className="vocab-wrap text-4xl font-semibold text-ink" data-testid="level-word" data-fake={question.fake ? '1' : '0'}>{question.word}</p>
          : !error && <Loader2 size={20} className="animate-spin motion-reduce:animate-none text-mute" />}
      </div>
      <p className="mt-3 text-center text-xs leading-relaxed text-mute">知道意思就点「认识」，<br />拿不准就点「不认识」。<br />有些词是编出来的，别被骗了。</p>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <button type="button" disabled={busy || !question} onClick={e => { e.currentTarget.blur(); void choose(false); }} data-testid="level-no" className={plain}>不认识<span className="hidden md:inline"> ←</span></button>
        <button type="button" disabled={busy || !question} onClick={e => { e.currentTarget.blur(); void choose(true); }} data-testid="level-yes" className={primary}>认识<span className="hidden md:inline"> →</span></button>
      </div>
    </div>
  );
}

// ---------- 整个引导 ----------

/**
 * 079 首次引导：选目标 → 测词汇量 → 定每天几个新词。全屏盖在最上面，每一步都能跳过，随时能关。
 * 设置里的「重新选目标 / 重新测词汇量」用同一个面板，只做那一步（single）。
 */
export default function OnboardingHost({ onFinished }: { onFinished?: () => void }) {
  const [request, setRequest] = useState<OpenRequest | null>(null);
  const [step, setStep] = useState<OnboardingStep>('goal');
  const [goals, setGoals] = useState<string[]>([]);
  const [perDay, setPerDay] = useState<number>(DEFAULT_PER_DAY);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ level: LevelResult; saved: { marked: number; estimated: number } | null } | null>(null);
  const [error, setError] = useState('');
  const [testKey, setTestKey] = useState(0);

  const open = useCallback((req: OpenRequest) => {
    const plan = getPlan();
    setRequest(req);
    setStep(req.step);
    setGoals(goalsOfPacks(plan.packs));
    setPerDay(plan.perDay);
    setRunning(false);
    setResult(null);
    setError('');
    setTestKey(key => key + 1);
  }, []);

  // 自动出现：没做完（也没跳过）引导、词库是空的就弹；中途关窗下次照样弹，已选的目标保留。先以数据库为准刷新一次学习计划，好把已选目标带回来。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await refreshPlan().catch(() => getPlan());
        const data = await vocabApi.browse();
        if (alive && shouldAutoShow(data.reviewWords.length)) open({ step: 'goal', single: false });
      } catch { /* 读不到库就不弹，不影响正常使用 */ }
    })();
    return () => { alive = false; };
  }, [open]);
  useEffect(() => onOpenOnboarding(open), [open]);

  const close = useCallback((finished: boolean) => {
    markOnboardingDone();
    setRequest(null);
    if (finished) onFinished?.();
  }, [onFinished]);

  // Esc = 先不做
  useEffect(() => {
    if (!request) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); void leave(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const savePlan = async (patch: { packs?: string[]; perDay?: number }) => {
    const plan = getPlan();
    await savePlanSynced({ ...plan, ...patch, cardOn: true }).catch(() => { /* 本机缓存已生效，下次打开会重新写库 */ });
  };

  /** 中途关掉：选过目标就保存，其余不动。 */
  const leave = async () => {
    if (!request?.single && goals.length > 0) await savePlan({ packs: packsOfGoals(goals) });
    close(false);
  };

  const after = (from: OnboardingStep) => {
    if (request?.single) { close(false); return; }
    if (from === 'goal') setStep('test');
    else if (from === 'test') {
      setResult(null);
      setRunning(false);
      setPerDay(recommend(result?.level.estimate ?? 0));
      setStep('perday');
    }
  };
  const recommend = (estimate: number) => recommendPerDay(estimate, packsOfGoals(goals).length ? packsOfGoals(goals) : getPlan().packs);

  const goNextFromGoal = async () => {
    if (request?.single || goals.length > 0) await savePlan({ packs: packsOfGoals(goals) }).catch(() => {});
    after('goal');
  };

  const finishTest = useCallback(async (answers: Answer[]) => {
    const level = evaluate(answers);
    setRunning(false);
    setResult({ level, saved: null });
    setError('');
    try {
      const saved = await saveTestResult(answers, level);
      setResult({ level, saved });
    } catch (reason) { setError(`保存测试结果失败：${errorText(reason)}`); }
  }, []);

  const finishAll = async () => {
    const packs = packsOfGoals(goals);
    await savePlan(packs.length > 0 ? { perDay, packs } : { perDay });
    close(true);
  };

  if (!request) return null;
  const single = request.single;
  const stepNo = step === 'goal' ? 1 : step === 'test' ? 2 : 3;
  const title = step === 'goal' ? '你想用词滴学什么？' : step === 'test' ? '测一测你的词汇量' : '每天学几个新词？';
  const recommended = recommend(result?.level.estimate ?? 0);

  return (
    <div className="fixed inset-0 z-[70] flex flex-col overflow-y-auto bg-paper pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]" role="dialog" aria-modal="true" aria-label="新手引导" data-testid="onboarding">
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col px-5 pb-8 pt-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          {single ? <span className="text-xs text-mute">{step === 'goal' ? '重新选目标' : '重新测词汇量'}</span>
            : <span className="text-xs text-mute" data-testid="onboarding-step">第 {stepNo} / 3 步</span>}
          <button type="button" onClick={() => void leave()} data-testid="onboarding-close" aria-label="先不做" className="press -mr-2 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-mute"><X size={20} /></button>
        </div>
        <h1 className="text-xl font-semibold text-ink" data-testid="onboarding-title">{title}</h1>

        {step === 'goal' && (
          <div className="mt-4" data-testid="onboarding-goal">
            <p className="text-sm leading-relaxed text-mute">可以多选。选了以后，每天会从对应的词表里送你几个新词。</p>
            <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="目标">
              {GOALS.map(goal => (
                <button key={goal.id} type="button" aria-pressed={goals.includes(goal.id)} data-testid={`goal-${goal.id}`}
                  onClick={e => { setGoals(list => list.includes(goal.id) ? list.filter(id => id !== goal.id) : [...list, goal.id]); e.currentTarget.blur(); }} className={chip(goals.includes(goal.id))}>
                  {goal.label}
                </button>
              ))}
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void goNextFromGoal()} disabled={goals.length === 0} data-testid="goal-next" className={primary}>{single ? '保存' : '下一步'}</button>
              {!single && <button type="button" onClick={() => after('goal')} data-testid="goal-skip" className={link}>跳过这一步</button>}
            </div>
          </div>
        )}

        {step === 'test' && !running && !result && (
          <div className="mt-4" data-testid="onboarding-test-intro">
            <p className="text-sm leading-relaxed text-mute">一共 {TOTAL} 个词，每个词点「认识」或「不认识」，大约 2 分钟。系统会根据你的回答调整难度，估出你大概认识多少词。测出来认识的词，以后不会再推给你。</p>
            <div className="mt-8 flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => { setRunning(true); setTestKey(key => key + 1); }} data-testid="test-start" className={primary}>开始测试</button>
              <button type="button" onClick={() => (single ? close(false) : after('test'))} data-testid="test-skip" className={link}>{single ? '先不测' : '跳过这一步'}</button>
            </div>
          </div>
        )}

        {step === 'test' && running && <div className="mt-4"><LevelTest key={testKey} onFinish={answers => void finishTest(answers)} onSkip={() => setRunning(false)} /></div>}

        {step === 'test' && !running && result && (
          <div className="mt-4" data-testid="level-result">
            <div className="rounded-2xl border border-line bg-page p-5 text-center">
              <p className="text-xs text-mute">你的词汇量估计</p>
              <p className="mt-1 text-4xl font-semibold text-ink" data-testid="level-estimate">{result.level.discounted && result.level.estimate === 300 ? '结果不太可信' : `约 ${result.level.estimate.toLocaleString('en-US')} 词`}</p>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-ink" data-testid="level-describe">{result.level.discounted && result.level.estimate === 300 ? '这次先不下结论，重测后再看。' : describeLevel(result.level.estimate)}</p>
            {result.level.discounted && result.level.estimate === 300 ? (
              <p className="mt-3 rounded-xl bg-clay-soft p-3 text-sm font-medium leading-relaxed text-clay" data-testid="level-warning">
                你点了不少编出来的假词，词汇量估计压到了最低值，这次结果不太可信。建议重测一次，拿不准就点「不认识」。
              </p>
            ) : result.level.discounted ? (
              <p className="mt-3 rounded-xl bg-clay-soft p-3 text-sm leading-relaxed text-clay" data-testid="level-warning">
                有 {result.level.fakeKnown} 个是编出来的假词，你也点了「认识」，估计已经打了折。如果想测得更准，可以重测一次，拿不准就点「不认识」。
              </p>
            ) : null}
            {error && <p role="alert" className="vocab-wrap mt-3 rounded-xl border border-danger/30 bg-danger-soft p-3 text-sm text-danger">{error}</p>}
            <p className="mt-3 flex items-center gap-1.5 text-xs text-mute" data-testid="level-saved">
              {result.saved ? <><Check size={14} />已记下 {result.saved.marked + result.saved.estimated} 个你认识的词，不会再推给你。</>
                : error ? '' : <><Loader2 size={14} className="animate-spin motion-reduce:animate-none" />正在记录你认识的词…</>}
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <button type="button" disabled={!result.saved} onClick={() => after('test')} data-testid="test-next" className={result.level.discounted && result.level.estimate === 300 ? plain : primary}>{single ? '完成' : '下一步'}</button>
              <button type="button" disabled={!result.saved && !error} onClick={() => { setResult(null); setRunning(true); setTestKey(key => key + 1); }} data-testid="test-retry" className={result.level.discounted && result.level.estimate === 300 ? primary : plain}>重测一次</button>
            </div>
          </div>
        )}

        {step === 'perday' && (
          <div className="mt-4" data-testid="onboarding-perday">
            <p className="text-sm leading-relaxed text-mute">按你的节奏来，之后在设置里随时能改。</p>
            <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="每天几个">
              {PER_DAY_PRESETS.map(n => (
                <button key={n} type="button" aria-pressed={perDay === n} data-testid={`perday-${n}`} onClick={e => { setPerDay(n); e.currentTarget.blur(); }} className={chip(perDay === n)}>
                  {n} 个{n === recommended ? <span className="ml-1 text-xs opacity-80">· 推荐</span> : null}
                </button>
              ))}
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void finishAll()} data-testid="perday-finish" className={primary}>完成，开始学</button>
              <button type="button" onClick={() => close(true)} data-testid="perday-skip" className={link}>跳过</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
