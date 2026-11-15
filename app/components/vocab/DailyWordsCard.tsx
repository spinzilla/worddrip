import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUp, Loader2, RotateCcw, Sprout } from 'lucide-react';
import { vocabApi } from '../../utils/vocab/api';
import { notifyVocabChanged, onVocabChanged, todayIssue } from '../../utils/vocab/manualAdd';
import {
  MORE_BATCH, buildDaily, getPlan, gotoDailySettings, keyDecision, lines, loadDailyState, onPlanChanged, packOf, pickMap,
  remainingOf, requestFirstTest, saveDailyState, swipeDecision, takenToday, today, wordKey,
  type DailyState, type Decision, type PickRow, type Plan, type UndoItem,
} from '../../utils/vocab/dailyWords';
import { watchPlan } from '../../utils/vocab/dailyPlanSync';
import { openOnboarding } from '../../utils/vocab/onboarding';
import { wordpackList, type WordpackEntry } from '../../utils/wordpack';
import VoiceButton from './VoiceButton';
import './vocab.css';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const FLY: Record<Decision, (w: number) => { x: number; y: number }> = {
  known: w => ({ x: -w, y: 0 }), taken: w => ({ x: w, y: 0 }), later: () => ({ x: 0, y: -400 }),
};

/**
 * 081 词库页顶部的「今日新词」卡：每天从所选词表送几个词，滑一下决定——
 * 左滑认识 / 右滑收下 / 上滑以后再说；点一下翻面；← → ↑ 空格同样可用；可撤销。
 */
export default function DailyWordsCard() {
  const [plan, setPlan] = useState<Plan>(getPlan);
  const [picks, setPicks] = useState<PickRow[]>([]);
  const [daily, setDaily] = useState<DailyState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<UndoItem[]>([]);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<{ x: number; y: number; id: number } | null>(null);
  const tokenRef = useRef(0);
  const quietUntil = useRef(0);
  const faceRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<{ el: HTMLElement; anims: Animation[] } | null>(null);

  /** 立刻结束翻面动画：取消、删掉旧面副本，连点也不叠。 */
  const settleFlip = useCallback(() => {
    const ghost = ghostRef.current;
    ghostRef.current = null;
    if (!ghost) return;
    ghost.anims.forEach(anim => { try { anim.cancel(); } catch { /* 已结束 */ } });
    ghost.el.remove();
  }, []);
  /**
   * 翻面，沿用 062 的做法：给当前面拍一张副本盖在原位，新面渲染后——旧面淡出 100ms、新面等它看不见再淡入 150ms，
   * 两面都不做位移，不会出现字跳位。「减少动态效果」打开时不拍副本、不做动画，直接换面。
   */
  const flip = useCallback(() => {
    settleFlip();
    const face = faceRef.current;
    if (face && face.parentElement && !reduceMotion() && typeof face.animate === 'function') {
      const ghost = face.cloneNode(true) as HTMLElement;
      ghost.querySelectorAll('[data-testid]').forEach(el => el.removeAttribute('data-testid'));
      ghost.removeAttribute('data-testid');
      ghost.setAttribute('data-ghost', ''); ghost.setAttribute('aria-hidden', 'true'); ghost.setAttribute('inert', '');
      Object.assign(ghost.style, { position: 'absolute', top: `${face.offsetTop}px`, left: `${face.offsetLeft}px`, width: `${face.offsetWidth}px`, height: `${face.offsetHeight}px`, margin: '0', overflow: 'clip', contain: 'paint', pointerEvents: 'none', zIndex: '1' });
      face.parentElement.appendChild(ghost);
      ghostRef.current = { el: ghost, anims: [] };
    }
    setFlipped(value => !value);
  }, [settleFlip]);
  // 新面已渲染：副本淡出、新面淡入；动画结束后删掉副本。换词（没有副本）时只清理。
  useLayoutEffect(() => {
    const ghost = ghostRef.current;
    const face = faceRef.current;
    if (!ghost) return;
    if (!face || typeof face.animate !== 'function') { settleFlip(); return; }
    const out = ghost.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, easing: 'ease-out', fill: 'forwards' });
    const into = face.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: 'ease-out', fill: 'backwards', delay: 100 });
    ghost.anims = [out, into];
    void Promise.allSettled([out.finished, into.finished]).then(() => { if (ghostRef.current === ghost) settleFlip(); });
  }, [flipped, settleFlip]);
  // 离开页面时不留副本
  useEffect(() => settleFlip, [settleFlip]);

  useEffect(() => onPlanChanged(() => setPlan(getPlan())), []);
  useEffect(() => watchPlan(), []);

  const load = useCallback(async (extra = 0) => {
    const token = ++tokenRef.current;
    const current = getPlan();
    if (current.packs.length === 0 || !current.cardOn) { setLoading(false); setDaily(null); return; }
    setError('');
    try {
      const [data, rows] = await Promise.all([vocabApi.browse(), vocabApi.pickList()]);
      const library = new Set(data.reviewWords.map(word => wordKey(word.word)));
      const date = today();
      const state = await buildDaily({ list: (tags, options) => wordpackList(tags, options) }, current, { library, picks: pickMap(rows), today: date }, loadDailyState(), extra);
      if (token !== tokenRef.current) return;
      saveDailyState(state);
      setPicks(rows);
      setDaily(state);
    } catch (reason) {
      if (token === tokenRef.current) setError(`读取今日新词失败：${errorText(reason)}`);
    } finally {
      if (token === tokenRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, plan.packs.join(','), plan.perDay, plan.cardOn]);
  // 别处改了词库（导入、手动添加）要重读；自己收词发的通知忽略。窗口重新获得焦点时也读一次（可能已经过了午夜）。
  useEffect(() => onVocabChanged(() => { if (Date.now() > quietUntil.current) void load(); }), [load]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible' && daily && daily.date !== today()) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); };
  }, [load, daily]);

  const date = today();
  const pickIndex = useMemo(() => pickMap(picks), [picks]);
  const remaining = useMemo(() => (daily ? remainingOf(daily, pickIndex, date) : []), [daily, pickIndex, date]);
  const taken = useMemo(() => takenToday(picks, date), [picks, date]);
  const current = remaining[0];

  const upsertPick = (rows: PickRow[], row: PickRow | null, key: string) => {
    const rest = rows.filter(item => item.wordKey !== key);
    return row ? [...rest, row] : rest;
  };

  const decide = useCallback(async (decision: Decision) => {
    if (busy || !current) return;
    setBusy(true);
    const entry = current;
    const key = wordKey(entry.word);
    const pack = packOf(entry, plan.packs);
    const previous = pickIndex.get(key) ?? null;
    const card = cardRef.current;
    const fly = FLY[decision](card?.offsetWidth ?? 300);
    try {
      let takeId: string | null = null;
      let definitionEnIds: number[] = [];
      let row: PickRow;
      if (decision === 'taken') {
        const result = await vocabApi.pickTake({
          word: entry.word, pack, pos: entry.pos, phonetic: entry.phonetic, chinese: lines(entry.zh, 3).join('；'),
          english: lines(entry.en, 3), issue: todayIssue(), date,
        });
        takeId = result.id;
        definitionEnIds = result.definitionEnIds;
        row = { wordKey: key, word: entry.word, state: 'taken', pack, decidedAt: date, updatedAt: new Date().toISOString() };
        quietUntil.current = Date.now() + 1500;
        notifyVocabChanged();
      } else {
        await vocabApi.pickSet([{ word: entry.word, state: decision, pack, date }]);
        row = { wordKey: key, word: entry.word, state: decision, pack, decidedAt: date, updatedAt: new Date().toISOString() };
      }
      let anim: Animation | null = null;
      if (card && !reduceMotion() && typeof card.animate === 'function') {
        const from = drag ? `translate(${drag.dx}px, ${drag.dy}px)` : 'none';
        anim = card.animate([{ transform: from, opacity: 1 }, { transform: `translate(${fly.x}px, ${fly.y}px)`, opacity: 0 }], { duration: 200, easing: 'ease-in', fill: 'forwards' });
        await anim.finished.catch(() => {});
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => anim?.cancel()));
      }
      setPicks(rows => upsertPick(rows, row, key));
      setUndo(stack => [...stack, { entry, decision, previous, takeId, definitionEnIds }].slice(-20));
      setFlipped(false);
      setDrag(null);
    } catch (reason) {
      setError(`保存失败：${errorText(reason)}`);
      setDrag(null);
    } finally {
      setBusy(false);
    }
  }, [busy, current, plan.packs, pickIndex, date, drag]);

  const undoLast = useCallback(async () => {
    if (busy || undo.length === 0) return;
    const item = undo[undo.length - 1];
    setBusy(true);
    try {
      await vocabApi.pickUndo({ word: item.entry.word, previous: item.previous, takeId: item.takeId ?? null, definitionEnIds: item.definitionEnIds ?? [] });
      if (item.decision === 'taken') { quietUntil.current = Date.now() + 1500; notifyVocabChanged(); }
      setPicks(rows => upsertPick(rows, item.previous, wordKey(item.entry.word)));
      setUndo(stack => stack.slice(0, -1));
      setFlipped(false);
      setError('');
    } catch (reason) {
      setError(`撤销失败：${errorText(reason)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, undo]);

  // 键盘：← 认识、→ 收下、↑ 以后、空格翻面（只在牌堆展开且没在输入时）
  useEffect(() => {
    if (!open) return;
    const typing = (event: Event) => { const t = event.target; return t instanceof Element && !!t.closest('input, textarea, select, [contenteditable="true"]'); };
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || typing(event)) return;
      const action = keyDecision(event.key);
      if (!action || !current) return;
      event.preventDefault();
      if (event.repeat) return;
      if (action === 'flip') flip(); else void decide(action);
    };
    // 空格在按钮上会在松开时触发点击：拦掉，免得刚点过的按钮又被点一次。
    const onKeyUp = (event: KeyboardEvent) => { if (event.key === ' ' && !typing(event)) event.preventDefault(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); };
  }, [open, current, decide, flip]);

  // 手势：拖动跟手，松手时位移够了就算一次操作；几乎没动就当「点一下翻面」。
  const onPointerDown = (event: React.PointerEvent) => {
    if (busy || (event.target instanceof Element && event.target.closest('button'))) return;
    startRef.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const start = startRef.current;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = Math.min(0, event.clientY - start.y);
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) setDrag({ dx, dy });
  };
  const onPointerUp = (event: React.PointerEvent) => {
    const start = startRef.current;
    startRef.current = null;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) { setDrag(null); flip(); return; }
    const decision = swipeDecision(dx, dy);
    if (decision) void decide(decision); else setDrag(null);
  };

  const more = async () => { setBusy(true); try { await load(1); } finally { setBusy(false); } };
  const goFirstTest = () => { setOpen(false); requestFirstTest(todayIssue()); };

  if (!plan.cardOn) return null;
  // 手机上展开时底部多留一截（浮动「+」高 3.5rem、离底 1.25rem），按钮和提示不会被它压住
  const shell = `mb-3 rounded-2xl border border-line bg-page p-4 md:p-5${open ? ' max-md:pb-24' : ''}`;

  if (plan.packs.length === 0) {
    return (
      <section className={shell} data-testid="daily-card" aria-label="今日新词">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 text-sm text-ink">选个目标，每天送你几个新词</p>
          <button type="button" onClick={gotoDailySettings} data-testid="daily-choose"
            className="press min-h-[44px] shrink-0 rounded-full bg-ink px-4 text-sm text-white">去选词表</button>
        </div>
        <button type="button" onClick={() => openOnboarding({ step: 'test', single: true })} data-testid="daily-level-test" className="press mt-1 min-h-[44px] text-xs text-mute underline-offset-2 hover:underline">测一下词汇量</button>
      </section>
    );
  }

  const total = daily?.entries.length ?? 0;
  const doneToday = total - remaining.length;
  const btn = 'press inline-flex min-h-[44px] items-center justify-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-sm';
  const transform = drag ? `translate(${drag.dx}px, ${drag.dy}px) rotate(${Math.max(-8, Math.min(8, drag.dx / 20))}deg)` : 'none';
  const hint = drag ? (Math.abs(drag.dx) >= Math.abs(drag.dy) ? (drag.dx < 0 ? '认识' : '收下') : '以后再说') : '';
  const zh = current ? lines(current.zh, 3) : [];
  const en = current ? lines(current.en, 2) : [];

  return (
    <section className={shell} data-testid="daily-card" aria-label="今日新词">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">今日新词{daily && !loading ? <> · <span data-testid="daily-remaining">还剩 {remaining.length} 个</span></> : null}</h2>
          <p className="text-xs text-mute">{daily && !loading ? `共 ${total} 个，已处理 ${doneToday} 个；` : ''}认识就跳过，不认识就收下。</p>
        </div>
        {!open && (
          <button type="button" onClick={() => setOpen(true)} disabled={loading || !daily} data-testid="daily-open"
            className="press min-h-[44px] shrink-0 rounded-full bg-ink px-4 text-sm text-white disabled:opacity-40">
            {remaining.length > 0 ? '开始滑' : '查看'}
          </button>
        )}
        {open && <button type="button" onClick={() => setOpen(false)} data-testid="daily-close" className="press min-h-[44px] shrink-0 rounded-full border border-line px-4 text-sm text-ink">收起</button>}
      </div>
      <button type="button" onClick={() => openOnboarding({ step: 'test', single: true })} data-testid="daily-level-test" className="press mt-1 min-h-[44px] text-xs text-mute underline-offset-2 hover:underline">测一下词汇量</button>
      {loading && <p className="mt-3 flex items-center gap-2 text-sm text-mute"><Loader2 size={14} className="animate-spin" />正在挑今天的词…</p>}
      {error && <p role="alert" className="vocab-wrap mt-3 rounded-xl border border-danger/30 bg-danger-soft p-3 text-sm text-danger">{error}</p>}

      {open && !loading && daily && (
        <div className="mt-4" data-testid="daily-deck">
          {current ? (
            <>
              <div className="relative mx-auto w-full max-w-md select-none">
                <div ref={cardRef} data-testid="daily-flashcard" data-flipped={flipped ? '1' : '0'} data-word={current.word}
                  onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { startRef.current = null; setDrag(null); }}
                  style={{ transform, touchAction: 'none', transition: drag || reduceMotion() ? 'none' : 'transform 160ms ease-out' }}
                  className="relative isolate flex min-h-[220px] cursor-grab flex-col items-center justify-center gap-3 overflow-hidden rounded-2xl border border-line bg-paper p-5 text-center shadow-card active:cursor-grabbing">
                  {current.tags.length > 0 && <span className="rounded-full bg-clay-soft px-2.5 py-0.5 text-xs text-clay" data-testid="daily-pack">{packOf(current, plan.packs)}</span>}
                  <div ref={faceRef} className="flex w-full flex-col items-center gap-3">
                  {!flipped ? (
                    <>
                      <p className="vocab-wrap text-3xl font-semibold text-ink" data-testid="daily-word">{current.word}</p>
                      <div className="flex items-center gap-2 text-sm text-mute">
                        {current.phonetic && <span data-testid="daily-phonetic">/{current.phonetic.replace(/^\/|\/$/g, '')}/</span>}
                        <VoiceButton text={current.word} kind="word" />
                      </div>
                      <p className="text-xs text-mute">点一下看意思</p>
                    </>
                  ) : (
                    <div className="w-full space-y-2 text-left" data-testid="daily-back">
                      <p className="vocab-wrap text-lg font-semibold text-ink">{current.word}{current.pos ? <span className="ml-2 text-xs font-normal text-mute">{current.pos}</span> : null}</p>
                      {zh.length > 0 ? zh.map((line, index) => <p key={index} className="vocab-wrap text-sm text-ink" data-testid="daily-zh">{line}</p>) : <p className="text-sm text-mute">（词表里没有中文释义）</p>}
                      {en.length > 0 && (
                        <div className="space-y-1 border-t border-line pt-2">
                          {en.map((line, index) => <p key={index} className="vocab-wrap text-xs text-mute" data-testid="daily-en">{line}</p>)}
                        </div>
                      )}
                    </div>
                  )}
                  </div>
                  {hint &&<span className="absolute right-3 top-3 rounded-full bg-ink px-2.5 py-0.5 text-xs text-white">{hint}</span>}
                </div>
              </div>
              <div className="mx-auto mt-3 grid max-w-md grid-cols-2 gap-2">
                <button type="button" disabled={busy} onClick={e => { e.currentTarget.blur(); void decide('taken'); }} data-testid="daily-take" className={`${btn} col-span-2 border-ink bg-ink text-white disabled:opacity-40`}>
                  不认识，收下<ArrowRight size={15} />
                </button>
                <button type="button" disabled={busy} onClick={e => { e.currentTarget.blur(); void decide('known'); }} data-testid="daily-known" className={`${btn} border-line bg-page text-ink disabled:opacity-40`}>
                  <ArrowLeft size={15} />认识
                </button>
                <button type="button" disabled={busy} onClick={e => { e.currentTarget.blur(); void decide('later'); }} data-testid="daily-later" className={`${btn} border-line bg-page text-ink disabled:opacity-40`}>
                  <ArrowUp size={15} />以后再说
                </button>
              </div>
              <div className="mx-auto mt-2 flex max-w-md flex-wrap items-center justify-between gap-x-3 text-xs text-mute">
                <button type="button" disabled={busy || undo.length === 0} onClick={e => { e.currentTarget.blur(); void undoLast(); }} data-testid="daily-undo"
                  className="press inline-flex min-h-[40px] items-center gap-1 rounded-full px-2 text-ink disabled:opacity-40"><RotateCcw size={14} />撤销</button>
                <span className="hidden md:inline">← 认识　→ 收下　↑ 以后　空格 翻面</span>
                <span className="md:hidden">左滑认识 · 右滑收下 · 上滑以后</span>
              </div>
            </>
          ) : (
            <div className="rounded-xl bg-paper p-4 text-sm text-ink" data-testid="daily-done">
              <p>{total === 0 ? '所选词表里暂时没有新词可送了。可以在设置里多选几个词表。' : '今天的词都处理完了。'}</p>
              {taken > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <span data-testid="daily-taken-count"><Sprout size={14} className="mr-1 inline" />今天收了 {taken} 个</span>
                  <button type="button" onClick={goFirstTest} data-testid="daily-go-first-test" className="press min-h-[44px] rounded-full bg-ink px-4 text-sm text-white">去做首考</button>
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" disabled={busy} onClick={more} data-testid="daily-more" className={`${btn} border-line bg-page text-ink disabled:opacity-40`}>再来 {MORE_BATCH} 个</button>
                <button type="button" disabled={busy || undo.length === 0} onClick={() => void undoLast()} data-testid="daily-undo" className={`${btn} border-line bg-page text-ink disabled:opacity-40`}><RotateCcw size={14} />撤销</button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
