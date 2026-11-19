import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowUp, Check, ChevronDown, ChevronRight, CircleAlert, Loader2, PanelRightClose, RotateCcw, Sparkles, Square, Trash2, X } from 'lucide-react';
import { aiTasks, type AiTask } from '../../utils/aiTasks';
import { getAIConfig, getEndpoint } from '../../utils/aiConfig';
import { useT } from '../../utils/i18n';
import { aiPanelState, DOCK_WIDTH, focusAppliedEpoch, markFocusApplied, STRIP_WIDTH, useAiFocus, useAiPanelState, useCurrentContextWord, usePanelMode, type PanelMode } from './panelState';
import OwnCheckResult from './OwnCheckResult';
import ExampleGenResult from './ExampleGenResult';
import DefCheckResult from './DefCheckResult';
import { EXAMPLE_CHECK_KIND } from '../../utils/vocab/ownCheckTask';
import { EXAMPLE_GEN_KIND } from '../../utils/vocab/exampleGenTask';
import { DEF_CHECK_KIND } from '../../utils/vocab/defCheckTask';
import { WRITING_REVIEW_KIND, WRITING_TASK_KIND } from '../../utils/writing';
import { WritingReviewTaskBlock, WritingTaskTaskBlock } from '../writing/WritingBlocks';

// 有结构化结果块的任务（093）：判句、AI 给例句、帮看释义；096 加上写作出题、写作批改。这类任务不显示模型的原始对话，不接追问。
const STRUCTURED_KINDS = new Set<string>([EXAMPLE_CHECK_KIND, EXAMPLE_GEN_KIND, DEF_CHECK_KIND, WRITING_TASK_KIND, WRITING_REVIEW_KIND]);
const structuredBody = (kind: string, task: AiTask) => {
  if (kind === EXAMPLE_CHECK_KIND) return <OwnCheckResult task={task} showOriginal />;
  if (kind === EXAMPLE_GEN_KIND) return <ExampleGenResult task={task} />;
  if (kind === WRITING_TASK_KIND) return <WritingTaskTaskBlock task={task} />;
  if (kind === WRITING_REVIEW_KIND) return <WritingReviewTaskBlock task={task} />;
  return <DefCheckResult task={task} />;
};

/**
 * 091 AI 小窗：任务中心（utils/aiTasks，090）的界面。
 *  - 电脑 ≥1280 宽：右侧一栏，把页面往左让（给 :root 设 --ai-dock，index.css 里的 #root 留出右边距）；可收起成右边一条窄边。
 *  - 电脑 <1280 宽：右下角按钮，点开盖在内容上的右侧浮层，点外面或 Esc 关。
 *  - 手机（或窗口窄到 <640）：右下角圆按钮，点开半屏抽屉，可拖大到全屏、下拉关闭。
 *  - 作答锁（lockAiPanel）：锁着就收起、按钮变灰，点了只提示；已在跑的任务照跑。
 * 挂在 App.tsx 一次。
 */

const modelReady = (): boolean => {
  try { return !!getEndpoint() && !!getAIConfig().model.trim(); } catch { return false; }
};

function useModelReady(active: boolean): boolean {
  const [ready, setReady] = useState(modelReady);
  useEffect(() => {
    const tick = () => setReady(modelReady());
    tick();
    window.addEventListener('storage', tick);
    window.addEventListener('focus', tick);
    const timer = active ? window.setInterval(tick, 1500) : 0;
    return () => { window.removeEventListener('storage', tick); window.removeEventListener('focus', tick); if (timer) window.clearInterval(timer); };
  }, [active]);
  return ready;
}

const useTasks = (): AiTask[] => useSyncExternalStore(aiTasks.subscribe, aiTasks.getTasks);
const useLock = (): string | null => useSyncExternalStore(aiTasks.subscribeLock, aiTasks.getLock);

const isLive = (task: AiTask) => task.status === 'running' || task.status === 'queued';

/** 有进行中的任务时每秒走一次，让「用时」跟着动。 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export const formatElapsed = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
};

const elapsedOf = (task: AiTask, now: number): string | null => {
  if (task.status === 'queued') return null;
  const start = task.startedAt ?? task.createdAt;
  return formatElapsed((task.endedAt ?? now) - start);
};

// ---------- 单条任务 ----------

function StatusIcon({ task }: { task: AiTask }) {
  if (isLive(task)) return <Loader2 size={14} className="shrink-0 animate-spin text-accent" data-testid="ai-spinner" />;
  if (task.status === 'done') return <Check size={14} className="shrink-0 text-success" />;
  if (task.status === 'failed') return <CircleAlert size={14} className="shrink-0 text-danger" />;
  return <Square size={12} className="shrink-0 text-faint" />;
}

function Thinking({ text, live }: { text: string; live?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="mb-1.5">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} data-testid="ai-think-toggle"
        className="inline-flex items-center gap-1 text-xs text-mute hover:text-ink">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {t('ai.thinking', { n: text.length })}
        {live && <Loader2 size={11} className="animate-spin" />}
      </button>
      {open && <p data-testid="ai-think-body" className="mt-1 whitespace-pre-wrap break-words border-l-2 border-line pl-2 text-xs leading-relaxed text-mute">{text}</p>}
    </div>
  );
}

function TaskDetail({ task, ready }: { task: AiTask; ready: boolean }) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const stick = useRef(true);
  const [followUp, setFollowUp] = useState('');
  const [problem, setProblem] = useState('');
  const live = isLive(task);
  const lastIsUser = task.messages.at(-1)?.role === 'user';
  // 结构化任务（判句、给例句、帮看释义）不接追问（追问会让回复不再是 JSON）。
  const structuredKind = STRUCTURED_KINDS.has(task.source.kind) ? task.source.kind : null;
  const checkTask = structuredKind !== null;
  const parseFailed = !!(task.result as { error?: unknown } | undefined)?.error;

  // 展开时把「接着追问」输入框滚到可见区（半屏抽屉里它常在列表底下）。
  useEffect(() => {
    if (!checkTask) formRef.current?.scrollIntoView({ block: 'nearest' });
  }, [task.id, checkTask]);
  // 结构化任务：结果块（判定 + 按钮）在列表底下，展开或出结果时把它的底边（按钮）滚到可见区。
  const checkRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!checkTask) return;
    const last = checkRef.current?.lastElementChild as HTMLElement | null | undefined;
    last?.scrollIntoView({ block: 'end' });
  }, [checkTask, task.id, task.status]);

  // 回复边收边显示：自动滚到底；用户往上翻了就不再抢滚动。
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box && stick.current) box.scrollTop = box.scrollHeight;
  }, [task.text, task.thinking, task.messages.length, task.status]);
  const onScroll = () => {
    const box = boxRef.current;
    if (box) stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  };

  const submit = () => {
    const text = followUp.trim();
    if (!text || live || !ready) return;
    const outcome = aiTasks.followUp(task.id, text);
    if ('reason' in outcome) setProblem(outcome.reason); else { setFollowUp(''); setProblem(''); stick.current = true; }
  };

  return (
    <div className="px-3 pb-3" data-testid="ai-task-detail">
      {!checkTask && <div ref={boxRef} onScroll={onScroll} data-testid="ai-task-scroll" className="max-h-[min(42vh,16rem)] min-h-0 overflow-y-auto overscroll-contain pr-1">
        {task.messages.map((message, index) => {
          const isLastAssistant = message.role === 'assistant' && index === task.messages.length - 1;
          return message.role === 'user' ? (
            <div key={index} className="mb-2 flex justify-end">
              <p className="max-w-[90%] whitespace-pre-wrap break-words rounded-xl bg-shade px-3 py-1.5 text-sm text-ink">{message.shown ?? message.content}</p>
            </div>
          ) : (
            <div key={index} className="mb-2" data-testid={isLastAssistant ? 'ai-reply' : undefined}>
              <Thinking text={message.thinking ?? ''} />
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink" data-testid={isLastAssistant ? 'ai-task-text' : undefined}>{message.content}</p>
            </div>
          );
        })}
        {lastIsUser && (
          <div className="mb-2" data-testid="ai-reply">
            <Thinking text={task.thinking} live={task.status === 'running' && !task.text} />
            {task.text
              ? <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink" data-testid="ai-task-text">{task.text}</p>
              : live && <p className="text-xs text-faint">{task.status === 'queued' ? t('ai.queued') : t('ai.waiting')}</p>}
          </div>
        )}
        {task.status === 'failed' && task.error && (
          <p role="alert" data-testid="ai-task-error" className="mb-2 break-words rounded-lg bg-danger-soft px-2.5 py-1.5 text-xs text-danger">{task.error}</p>
        )}
      </div>}
      {structuredKind && (
        // 结构化任务：不显示模型的原始 JSON 对话，只显示思考、进度和结果块（结果块自带按钮，两处一致）。
        <div ref={checkRef} className="mb-2" data-testid="ai-check-body">
          <Thinking text={task.thinking} live={live && !task.text} />
          {live && <p className="text-xs text-faint">{task.status === 'queued' ? t('ai.queued') : t('ai.waiting')}</p>}
          {structuredBody(structuredKind, task)}
        </div>
      )}
      <div className="mt-1 flex items-center gap-2">
        {live && (
          <button type="button" onClick={() => aiTasks.cancel(task.id)} data-testid="ai-stop"
            className="press inline-flex items-center gap-1 rounded-full border border-line bg-page px-3 py-1 text-xs text-ink">
            <Square size={11} />{t('ai.stop')}
          </button>
        )}
        {!live && (task.status !== 'done' || parseFailed) && (
          <button type="button" onClick={() => aiTasks.retry(task.id)} data-testid="ai-retry"
            className="press inline-flex items-center gap-1 rounded-full bg-ink px-3 py-1 text-xs text-white">
            <RotateCcw size={11} />{t('ai.retry')}
          </button>
        )}
        {!live && (
          <button type="button" onClick={() => aiTasks.remove(task.id)} data-testid="ai-remove"
            className="press ml-auto inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-mute hover:text-danger">
            <Trash2 size={11} />{t('ai.remove')}
          </button>
        )}
      </div>
      {!checkTask && (
        <>
          <form ref={formRef} className="mt-2 flex items-end gap-1.5" onSubmit={event => { event.preventDefault(); submit(); }}>
            <input value={followUp} onChange={event => setFollowUp(event.target.value)} disabled={live || !ready}
              placeholder={t('ai.followUp')} data-testid="ai-followup-input" aria-label={t('ai.followUp')}
              className="min-w-0 flex-1 rounded-full border border-line bg-paper px-3 py-1.5 text-sm text-ink placeholder:text-faint disabled:opacity-50" />
            <button type="submit" disabled={live || !ready || !followUp.trim()} aria-label={t('ai.send')} data-testid="ai-followup-send"
              className="press inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-white"><ArrowUp size={15} /></button>
          </form>
          {problem && <p role="alert" className="mt-1 text-xs text-danger">{problem}</p>}
        </>
      )}
    </div>
  );
}

function TaskRow({ task, open, onToggle, now, ready }: { task: AiTask; open: boolean; onToggle: () => void; now: number; ready: boolean }) {
  const t = useT();
  const state = t(`ai.${task.status}` as 'ai.done');
  const elapsed = elapsedOf(task, now);
  return (
    <li className="border-b border-line last:border-b-0" data-testid="ai-task" data-task-id={task.id} data-status={task.status} data-open={open ? '1' : '0'}>
      <button type="button" onClick={onToggle} aria-expanded={open} data-testid="ai-task-head"
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-shade/60">
        <StatusIcon task={task} />
        <span className="min-w-0 flex-1 truncate text-sm text-ink">{task.title}</span>
        <span className="shrink-0 text-xs text-faint" data-testid="ai-task-meta">{state}{elapsed ? ` · ${elapsed}` : ''}</span>
      </button>
      {open && <TaskDetail task={task} ready={ready} />}
    </li>
  );
}

// ---------- 面板正文（三种形态共用） ----------

function PanelBody({ header, ready, active }: { header: React.ReactNode; ready: boolean; active: boolean }) {
  const t = useT();
  const tasks = useTasks();
  const context = useCurrentContextWord();
  const [dismissedEpoch, setDismissedEpoch] = useState<number | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [problem, setProblem] = useState('');
  const now = useNow(active && tasks.some(isLive));
  const word = context.word && context.epoch !== dismissedEpoch ? context.word : null; // 换了页面，上一次点的 × 就作废

  // 打开时默认展开最新一条；用户自己点开合之后不再替他选。
  const userChose = useRef(false);
  const newestId = tasks[0]?.id ?? null;
  useEffect(() => { if (!userChose.current) setOpenId(newestId); }, [newestId]);

  const ask = () => {
    const text = question.trim();
    if (!text || !ready) return;
    const title = word ? `${word}：${text}` : text;
    const outcome = aiTasks.create({
      title: title.length > 40 ? `${title.slice(0, 40)}…` : title,
      source: { kind: 'panel', ...(word ? { word } : {}) },
      prompt: word ? `（关于单词 ${word}）${text}` : text,
      // 发给模型的带上当前词；气泡里只显示用户打的字，「关于」由上面的标签显示。
      shown: text,
      system: t('ai.system'),
      mode: 'direct',
    });
    if ('reason' in outcome) setProblem(outcome.reason); else { setQuestion(''); setProblem(''); userChose.current = false; setOpenId(outcome.task.id); }
  };

  // 随手记等地方请求「展开这一条」：只响应还没处理过的那一次。小窗收起时请求在面板挂载前发出，
  // 挂载后也要补上（93：不能只靠「默认展开最新一条」），所以记的是模块级「已处理到第几次」，不是挂载时的值。
  const focus = useAiFocus();
  const seenFocus = useRef(focusAppliedEpoch());
  useEffect(() => {
    if (focus.epoch === seenFocus.current || !focus.id) return;
    seenFocus.current = focus.epoch;
    markFocusApplied(focus.epoch);
    userChose.current = true;
    setOpenId(focus.id);
  }, [focus.epoch, focus.id]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="ai-task-list">
        {tasks.length === 0 && <li className="px-4 py-6 text-center text-sm text-mute" data-testid="ai-empty">{t('ai.empty')}</li>}
        {tasks.map(task => (
          <TaskRow key={task.id} task={task} now={now} ready={ready} open={openId === task.id}
            onToggle={() => { userChose.current = true; setOpenId(openId === task.id ? null : task.id); }} />
        ))}
      </ul>
      <div className="shrink-0 border-t border-line bg-page p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {word && (
          <div className="mb-2 flex items-center gap-1">
            <span data-testid="ai-context-chip" className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent-soft py-0.5 pl-2.5 pr-1 text-xs text-accent">
              <span className="truncate">{t('ai.about', { word })}</span>
              <button type="button" onClick={() => setDismissedEpoch(context.epoch)} aria-label={t('ai.aboutClear')} data-testid="ai-context-clear"
                className="inline-flex h-5 w-5 items-center justify-center rounded-full hover:bg-accent/10"><X size={12} /></button>
            </span>
          </div>
        )}
        <form className="flex items-end gap-1.5" onSubmit={event => { event.preventDefault(); ask(); }}>
          <textarea value={question} onChange={event => setQuestion(event.target.value)} rows={2} disabled={!ready}
            placeholder={ready ? t('ai.ask') : t('ai.noModel')} aria-label={t('ai.ask')} data-testid="ai-ask-input"
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); ask(); } }}
            className="min-w-0 flex-1 resize-none rounded-xl border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-faint disabled:opacity-60" />
          <button type="submit" disabled={!ready || !question.trim()} aria-label={t('ai.send')} data-testid="ai-ask-send"
            className="press inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-white"><ArrowUp size={16} /></button>
        </form>
        {!ready && <p data-testid="ai-no-model" className="mt-1.5 text-xs text-clay">{t('ai.noModel')}</p>}
        {problem && <p role="alert" className="mt-1.5 text-xs text-danger">{problem}</p>}
      </div>
    </div>
  );
}

const Header = ({ right }: { right: React.ReactNode }) => {
  const t = useT();
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
      <Sparkles size={15} className="text-accent" />
      <span className="flex-1 text-sm font-semibold text-ink">{t('ai.title')}</span>
      {right}
    </div>
  );
};

// ---------- 手机抽屉：半屏，拖上去变全屏，拖下去关 ----------

function Sheet({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const t = useT();
  const [full, setFull] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef(0);
  const onDown = (event: React.PointerEvent) => { start.current = event.clientY; event.currentTarget.setPointerCapture(event.pointerId); setDrag(0); };
  const onMove = (event: React.PointerEvent) => { if (drag !== null) setDrag(event.clientY - start.current); };
  const onUp = (event: React.PointerEvent) => {
    if (drag === null) return;
    const dy = event.clientY - start.current;
    setDrag(null);
    if (dy > 70) { if (full) setFull(false); else onClose(); } else if (dy < -50) setFull(true);
  };
  return (
    <div data-testid="ai-panel" data-mode="mobile" data-size={full ? 'full' : 'half'}
      className={`card fixed inset-x-0 bottom-0 z-[86] flex flex-col overflow-hidden rounded-b-none ${drag === null ? 'sheet-up' : ''}`}
      style={{ height: full ? 'calc(100dvh - 2rem)' : '58dvh', transform: drag && drag > 0 ? `translateY(${drag}px)` : undefined, transition: drag === null ? 'height 160ms ease' : 'none' }}>
      <div role="separator" aria-label={t('ai.dragHandle')} data-testid="ai-sheet-handle" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}
        className="flex h-6 shrink-0 cursor-grab touch-none select-none items-center justify-center"><span className="h-1 w-10 rounded-full bg-line" /></div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

// ---------- 总入口 ----------

export default function AiPanelHost({ enabled }: { enabled: boolean }) {
  const t = useT();
  const mode: PanelMode = usePanelMode();
  const { collapsed, open } = useAiPanelState();
  const lock = useLock();
  const locked = lock !== null;
  const tasks = useTasks();
  const busy = tasks.some(isLive);
  const shown = enabled && !locked && (mode === 'dock' ? !collapsed : open);
  const ready = useModelReady(shown);
  const [tip, setTip] = useState(false);
  const tipTimer = useRef(0);

  // 电脑侧栏：告诉页面右边要让出多少；其他形态不占位。
  useEffect(() => {
    const root = document.documentElement;
    const width = enabled && mode === 'dock' ? (shown ? DOCK_WIDTH : STRIP_WIDTH) : 0;
    root.style.setProperty('--ai-dock', `${width}px`);
    return () => { root.style.removeProperty('--ai-dock'); };
  }, [enabled, mode, shown]);

  // 浮层 / 抽屉：Esc 关。
  useEffect(() => {
    if (!shown || mode === 'dock') return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); aiPanelState.setOpen(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [shown, mode]);

  useEffect(() => () => window.clearTimeout(tipTimer.current), []);
  const showTip = useCallback(() => {
    setTip(true);
    window.clearTimeout(tipTimer.current);
    tipTimer.current = window.setTimeout(() => setTip(false), 3500);
  }, []);
  useEffect(() => { if (!locked) setTip(false); }, [locked]);

  if (!enabled) return null;

  const dot = busy && !shown && <span data-testid="ai-dot" className="absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-full border-2 border-page bg-accent" />;
  const lockTip = tip && locked && (
    <div role="status" data-testid="ai-lock-tip"
      className={`fixed z-[87] max-w-[16rem] rounded-xl bg-ink px-3 py-2 text-xs text-white shadow-lift fade-in ${mode === 'dock' ? 'right-12 top-3' : 'right-4 bottom-36'}`}>
      {t('ai.locked')}
    </div>
  );

  if (mode === 'dock') {
    if (!shown) {
      return (
        <>
          <button type="button" onClick={() => (locked ? showTip() : aiPanelState.setCollapsed(false))}
            aria-label={t('ai.expand')} aria-disabled={locked} data-testid="ai-toggle" data-mode="dock" data-locked={locked ? '1' : '0'}
            style={{ width: STRIP_WIDTH }}
            className={`fixed bottom-0 right-0 top-0 z-[85] flex flex-col items-center gap-2 border-l border-line pt-4 ${locked ? 'cursor-not-allowed bg-shade text-faint' : 'bg-page text-accent hover:bg-shade'}`}>
            <span className="relative"><Sparkles size={18} />{dot}</span>
          </button>
          {lockTip}
        </>
      );
    }
    return (
      <aside data-testid="ai-panel" data-mode="dock" style={{ width: DOCK_WIDTH }} className="fixed bottom-0 right-0 top-0 z-[85] border-l border-line bg-page">
        <PanelBody active ready={ready} header={
          <Header right={<button type="button" onClick={() => aiPanelState.setCollapsed(true)} aria-label={t('ai.collapse')} data-testid="ai-collapse"
            className="press inline-flex h-7 w-7 items-center justify-center rounded-full text-mute hover:text-ink"><PanelRightClose size={16} /></button>} />
        } />
      </aside>
    );
  }

  const fabPos = mode === 'mobile' ? { right: '0.75rem', bottom: 'calc(5.75rem + env(safe-area-inset-bottom, 0px))' } : { right: '1.25rem', bottom: '1.25rem' };
  return (
    <>
      {!shown && (
        <button type="button" onClick={() => (locked ? showTip() : aiPanelState.setOpen(true))}
          aria-label={t('ai.open')} aria-disabled={locked} data-testid="ai-toggle" data-mode={mode} data-locked={locked ? '1' : '0'}
          style={fabPos}
          className={`press fixed z-[85] inline-flex ${mode === 'mobile' ? 'h-11 w-11' : 'h-12 w-12'} items-center justify-center rounded-full shadow-lift ${locked ? 'cursor-not-allowed bg-shade text-faint' : 'bg-ink text-white'}`}>
          <span className="relative inline-flex"><Sparkles size={20} />{dot}</span>
        </button>
      )}
      {lockTip}
      {shown && (
        <>
          <div className={`fixed inset-0 z-[84] ${mode === 'mobile' ? 'bg-ink/25 fade-in' : ''}`} data-testid="ai-backdrop" onClick={() => aiPanelState.setOpen(false)} />
          {mode === 'mobile' ? (
            <Sheet onClose={() => aiPanelState.setOpen(false)}>
              <PanelBody active ready={ready} header={
                <Header right={<button type="button" onClick={() => aiPanelState.setOpen(false)} aria-label={t('ai.close')} data-testid="ai-close"
                  className="press inline-flex h-8 w-8 items-center justify-center rounded-full text-mute hover:text-ink"><X size={16} /></button>} />
              } />
            </Sheet>
          ) : (
            <aside data-testid="ai-panel" data-mode="float" className="card slide-in fixed bottom-0 right-0 top-0 z-[86] w-[380px] max-w-[92vw] rounded-none rounded-l-2xl">
              <PanelBody active ready={ready} header={
                <Header right={<button type="button" onClick={() => aiPanelState.setOpen(false)} aria-label={t('ai.close')} data-testid="ai-close"
                  className="press inline-flex h-7 w-7 items-center justify-center rounded-full text-mute hover:text-ink"><X size={16} /></button>} />
              } />
            </aside>
          )}
        </>
      )}
    </>
  );
}
