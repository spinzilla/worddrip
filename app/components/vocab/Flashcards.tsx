import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, RotateCcw, X } from 'lucide-react';
import type { DueWord } from '../../utils/vocab/due';
import { dueLabel } from '../../utils/vocab/due';
import { realExamplesFirst, statusLabel } from '../../utils/vocab/library';
import {
  attachFlashKeys,
  canNext,
  canPrev,
  currentCard,
  flip,
  isLast,
  next,
  prev,
  progress,
} from '../../utils/vocab/flashcards';
import type { FlashKey, FlashState } from '../../utils/vocab/flashcards';
import { vocabApi } from '../../utils/vocab/api';
import { groupNotes, noteKey, removeNote, upsertNote } from '../../utils/vocab/notes';
import type { VocabNote } from '../../utils/vocab/types';
import NotesSection from './NotesSection';
import ExamplesSection, { useMyExamples } from './ExamplesSection';
import SceneTag, { useExampleScenes } from './SceneTag';
import VoiceButton from './VoiceButton';
import { findWordAt } from '../Lookable';
import { exampleKey, sensesFrom } from '../../utils/vocab/examples';
import { IS_MOBILE } from '../../utils/platform';
import './vocab.css';

interface Props {
  /** 进入时固定的会话（队列非空）；本次复习过程中不再变。 */
  initial: FlashState;
  /** 退出或点「结束」：只关闭闪卡，不写数据库。 */
  onExit: () => void;
}

/**
 * 翻面闪卡：正面词目和期号，背面英文释义（含中文、例句）、状态、到期日和完整备注。只看不评分。
 * 036 改版：宽屏卡片放大、占满大部分高度；背面左边释义、右边状态和备注，窄屏上下排。
 * 041：背面右栏在备注下面接「我的笔记」（没有笔记只占一个小按钮），能加一条（来源「闪卡」）；正面不显示笔记。
 * 043：左栏释义下面接「我的例句」小入口（只在背面；正面不显示，免得先看到例句）。
 * 背面不再是一个大按钮（里面要放输入框）：点背面空白处照样翻回正面，点笔记区不翻；焦点在笔记区时闪卡快捷键暂停。
 */
/** 手机左右滑切卡的最小横向距离（像素）。 */
const SWIPE_MIN = 60;

export default function Flashcards({ initial, onExit }: Props) {
  const [state, setState] = useState<FlashState>(initial);
  const cardRef = useRef<HTMLButtonElement>(null);
  const [notes, setNotes] = useState<VocabNote[]>([]);
  const [notesError, setNotesError] = useState('');
  const notesByKey = useMemo(() => groupNotes(notes), [notes]);
  const noteHandlers = useMemo(() => ({
    onSaved: (note: VocabNote) => setNotes(list => upsertNote(list, note)),
    onDeleted: (id: number) => setNotes(list => removeNote(list, id)),
  }), []);
  useEffect(() => {
    let alive = true;
    vocabApi.listNotes()
      .then(list => { if (alive) setNotes(list); })
      .catch(reason => { if (alive) setNotesError(`读取笔记失败：${reason instanceof Error ? reason.message : String(reason)}`); });
    return () => { alive = false; };
  }, []);
  const myExamples = useMyExamples();
  const scenes = useExampleScenes();
  const word: DueWord = currentCard(state);

  // 048：翻到背面时，给这个词还没标过的例句补场景标签（一个词一次请求；标过、试过的不再发）。
  const ensureScenes = scenes.ensure;
  const wordExampleList = myExamples.byKey.get(exampleKey(word.word));
  useEffect(() => {
    if (!state.flipped) return;
    const sentences = [
      ...word.definitions.flatMap(definition => definition.examples.map(example => example.sentence)),
      ...(wordExampleList ?? []).map(example => example.sentence),
    ];
    ensureScenes(word.word, sentences);
  }, [state.flipped, word, wordExampleList, ensureScenes]);
  const { label, percent } = progress(state);
  const last = isLast(state);

  // 键盘：只在闪卡打开时挂一份监听，关闭（卸载）时解除，不会残留影响听写快捷键。
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  // 062 动画：翻面 = 旧面（DOM 副本）淡出 + 新面淡入；换卡 = 旧卡（副本）滑出 + 新卡滑入。
  // 全部只用 transform / opacity（桌面端卡片高度不同时，给舞台高度做一次短过渡）。不用任何旋转或 3D。
  const stageRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const animRef = useRef<{ anims: Animation[]; ghosts: HTMLElement[]; token: number }>({ anims: [], ghosts: [], token: 0 });
  const pendingRef = useRef<{ kind: 'flip' | 'slide'; dir: number; h0: number; ghost: HTMLElement; dx: number } | null>(null);
  const liveCard = () => stageRef.current?.querySelector<HTMLElement>(':scope > .vocab-flash-card:not([data-ghost])') ?? null;
  /** 立刻结束正在进行的动画（取消、删副本、清样式），保证连点不卡、不叠。 */
  const settle = () => {
    const a = animRef.current;
    a.token += 1;
    a.anims.forEach(anim => { try { anim.cancel(); } catch { /* 已结束 */ } });
    a.ghosts.forEach(g => g.remove());
    a.anims = []; a.ghosts = [];
    pendingRef.current?.ghost.remove();
    pendingRef.current = null;
    stageRef.current?.removeAttribute('data-anim');
    const card = liveCard();
    if (card) card.style.transform = '';
  };
  const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  /** 状态改变前调用：给当前卡拍一张「副本」盖在原位，等新卡渲染后一起动。减少动态效果时直接不动画。 */
  const begin = (kind: 'flip' | 'slide', dir: number, dx = 0) => {
    settle();
    const stage = stageRef.current;
    const card = liveCard();
    if (!stage || !card || reduceMotion() || typeof card.animate !== 'function') return;
    const ghost = card.cloneNode(true) as HTMLElement;
    const side = card.getAttribute('data-side') ?? ''; // 065：副本保留面的标记（换名，免得测试选到它），样式靠它保持原来的对齐方式，不然淡出时字会跳到顶部。
    ghost.removeAttribute('data-testid'); ghost.removeAttribute('data-side'); ghost.setAttribute('data-ghost-side', side);
    ghost.querySelectorAll('[data-testid]').forEach(el => el.removeAttribute('data-testid'));
    ghost.setAttribute('data-ghost', ''); ghost.setAttribute('aria-hidden', 'true'); ghost.setAttribute('inert', ''); ghost.tabIndex = -1;
    Object.assign(ghost.style, {
      position: 'absolute', top: `${card.offsetTop}px`, left: `${card.offsetLeft}px`,
      width: `${card.offsetWidth}px`, height: `${card.offsetHeight}px`, margin: '0', pointerEvents: 'none', zIndex: '1',
    });
    card.style.transform = '';
    stage.appendChild(ghost);
    ghost.scrollTop = card.scrollTop;
    pendingRef.current = { kind, dir, h0: stage.offsetHeight, ghost, dx };
  };
  // 新卡已渲染：开始动画。
  useLayoutEffect(() => {
    const p = pendingRef.current;
    pendingRef.current = null;
    if (!p) return;
    const stage = stageRef.current;
    const card = liveCard();
    if (!stage || !card) { p.ghost.remove(); return; }
    const a = animRef.current;
    a.ghosts = [p.ghost];
    stage.setAttribute('data-anim', '');
    const run = (el: HTMLElement, frames: Keyframe[], duration: number, easing: string, fill: FillMode = 'none', delay = 0) => {
      const anim = el.animate(frames, { duration, easing, fill, delay });
      a.anims.push(anim);
      return anim;
    };
    let last: Animation;
    if (p.kind === 'flip') {
      // 065：先淡出再淡入，任何时刻只有一面可见。旧面（副本）在原位淡出 100ms；新面先藏起来，
      // 等旧面完全看不见了再淡入 150ms。两面都不做位移，所以不会出现字跳位。
      run(p.ghost, [{ opacity: 1 }, { opacity: 0 }], 100, 'ease-out', 'forwards');
      last = run(card, [{ opacity: 0 }, { opacity: 1 }], 150, 'ease-out', 'backwards', 100);
    } else {
      const w = stage.offsetWidth;
      const ease = 'cubic-bezier(0.22, 0.8, 0.3, 1)';
      run(p.ghost, [{ transform: `translateX(${p.dx}px)`, opacity: 1 }, { transform: `translateX(${-p.dir * w}px)`, opacity: 0.4 }], 280, ease, 'forwards');
      last = run(card, [{ transform: `translateX(${p.dir * w}px)`, opacity: 0.4 }, { transform: 'none', opacity: 1 }], 280, ease);
    }
    if (!IS_MOBILE) {
      const h1 = stage.offsetHeight;
      if (Math.abs(h1 - p.h0) > 1) run(stage, [{ height: `${p.h0}px` }, { height: `${h1}px` }], 240, 'ease-out');
    }
    const token = a.token;
    void Promise.allSettled(a.anims.map(x => x.finished)).then(() => { if (animRef.current.token === token) settle(); });
    void last;
  }, [state]);

  const doFlip = () => { begin('flip', 0); setState(flip); };
  const doGo = (dir: number, dx = 0) => {
    const s = stateRef.current;
    if (dir > 0 ? !canNext(s) : !canPrev(s)) return;
    begin('slide', dir, dx);
    setState(dir > 0 ? next : prev);
  };
  const actionsRef = useRef({ doFlip, doGo });
  actionsRef.current = { doFlip, doGo };

  useEffect(() => {
    const run = (action: FlashKey) => {
      if (action === 'exit') onExitRef.current();
      else if (action === 'flip') actionsRef.current.doFlip();
      else if (action === 'next') actionsRef.current.doGo(1);
      else actionsRef.current.doGo(-1);
    };
    // 焦点在笔记区（输入框、笔记里的按钮）时不拦按键：空格、方向键、Esc 按原样给笔记区用。
    return attachFlashKeys(window, run, () => !(document.activeElement instanceof Element && document.activeElement.closest('[data-flash-notes]')));
  }, []);

  // 打开时把焦点放到卡片上，键盘用户能直接操作。
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  const btn = `press inline-flex items-center justify-center gap-1 rounded-full border border-line bg-page px-4 py-2 text-sm text-ink md:px-5 md:py-2.5 md:text-base hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40${IS_MOBILE ? ' min-h-[44px] flex-1' : ''}`;

  // 手机：左右滑切卡。横向位移 ≥ SWIPE_MIN 且明显大于竖向位移才算（竖向滚背面长内容不会误切）；输入框里开始的触摸不算。
  // 062：拖动时卡片实时跟手平移（直接写 transform，不走 React 渲染）；松手过阈值就接着滑出，否则弹回。
  const touchRef = useRef<{ x: number; y: number; drag: boolean } | null>(null);
  const springBack = (dx: number) => {
    const card = liveCard();
    if (!card) return;
    card.style.transform = '';
    if (reduceMotion() || typeof card.animate !== 'function' || Math.abs(dx) < 1) return;
    animRef.current.anims.push(card.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 180, easing: 'ease-out' }));
  };
  const swipe = IS_MOBILE ? {
    onTouchStart: (event: React.TouchEvent) => {
      const target = event.target;
      if (event.touches.length !== 1 || (target instanceof Element && target.closest('input, textarea'))) { touchRef.current = null; return; }
      settle(); // 动画中再按住：立刻定格，不叠。
      touchRef.current = { x: event.touches[0].clientX, y: event.touches[0].clientY, drag: false };
    },
    onTouchMove: (event: React.TouchEvent) => {
      const start = touchRef.current;
      if (!start || event.touches.length !== 1) return;
      const dx = event.touches[0].clientX - start.x;
      const dy = event.touches[0].clientY - start.y;
      if (!start.drag) {
        if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.5) return; // 还没确定是横向拖动：竖向滚动不动卡片
        start.drag = true;
      }
      const s = stateRef.current;
      const blocked = dx < 0 ? !canNext(s) : !canPrev(s);
      const card = liveCard();
      if (card) card.style.transform = `translateX(${blocked ? dx * 0.5 : dx}px)`;
    },
    onTouchCancel: () => {
      const start = touchRef.current;
      touchRef.current = null;
      if (start?.drag) springBack(parseFloat((liveCard()?.style.transform ?? '').replace(/[^-\d.]/g, '')) || 0);
    },
    onTouchEnd: (event: React.TouchEvent) => {
      const start = touchRef.current;
      touchRef.current = null;
      if (!start || event.changedTouches.length === 0) return;
      const dx = event.changedTouches[0].clientX - start.x;
      const dy = event.changedTouches[0].clientY - start.y;
      const s = stateRef.current;
      const pass = Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) >= Math.abs(dy) * 1.5 && (dx < 0 ? canNext(s) : canPrev(s));
      if (pass) doGo(dx < 0 ? 1 : -1, dx);
      else if (start.drag) springBack(dx * ((dx < 0 ? !canNext(s) : !canPrev(s)) ? 0.5 : 1));
    },
  } : {};

  return (
    <div className={`vocab-flash-overlay${IS_MOBILE ? ' vocab-flash-m' : ''}`} role="dialog" aria-modal="true" aria-label="到期复习闪卡" data-testid="flash">
      <div className="vocab-flash-inner vocab-flash-wide">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-mute" data-testid="flash-progress">第 {label} 张</div>
            <div className="vocab-flash-bar mt-1.5" aria-hidden="true">
              <div className="vocab-flash-bar-fill" style={{ width: `${percent}%` }} />
            </div>
          </div>
          <button type="button" onClick={onExit} className={btn} aria-label={IS_MOBILE ? '退出闪卡' : '退出闪卡（Esc）'} title={IS_MOBILE ? undefined : '退出（Esc）'}>
            <X size={16} />退出
          </button>
        </div>

        <div className="vocab-flash-stage" ref={stageRef} {...swipe}>
        {!state.flipped ? (
          <button
            ref={cardRef}
            type="button"
            onClick={doFlip}
            title="点击翻面"
            data-no-lookup=""
            className="vocab-flash-card vocab-wrap press mt-5"
            data-testid="flash-card"
            data-side="front"
          >
            <div className="vocab-flash-front">
              <div className="vocab-flash-word" data-testid="flash-word">{word.word}</div>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <span className="vocab-q-tag">{word.issue} 期</span>
              </div>
              <div className="vocab-flash-tip">{IS_MOBILE ? '先在心里说出它的意思和一个例句，再点卡片翻面' : '先在心里说出它的意思和一个例句，再点击卡片或按空格翻面'}</div>
            </div>
          </button>
        ) : (
          <div
            onClick={event => {
              // 点笔记区、按钮、输入框不翻面；点其他空白处翻回正面（和原来整张卡是按钮时一样）。
              if (event.target instanceof Element && event.target.closest('[data-flash-notes], button, a, input, textarea')) return;
              // 064：点到能查词的英文单词时只弹查词卡（Lookable 处理），不翻面。
              if (findWordAt(event.clientX, event.clientY)) return;
              doFlip();
            }}
            title="点击空白处翻回正面"
            className="vocab-flash-card vocab-wrap mt-5"
            data-testid="flash-card"
            data-side="back"
          >
            <div className="vocab-flash-back" data-testid="flash-back">
              <div className="flex min-w-0 items-center gap-1">
                <div className="vocab-flash-back-word min-w-0">{word.word}</div>
                <VoiceButton text={word.word} kind="word" />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-mute">
                <span className="vocab-q-tag">{word.issue} 期</span>
              </div>
              <div className="vocab-flash-back-grid">
                <div className="min-w-0" data-testid="flash-definitions">
                  <div className="vocab-q-label"><span>英文释义</span></div>
                  {word.definitions.length === 0 ? (
                    <p className="mt-2 text-sm text-mute">{IS_MOBILE ? '这个词还没有英英释义，先看下面的完整备注。' : '还没有导入英英释义（可在「导入」里导入期笔记），先看右边的完整备注。'}</p>
                  ) : (
                    <ol className="vocab-flash-defs">
                      {word.definitions.map((definition, index) => (
                        <li key={`${definition.sourceFile}-${definition.sourceLine}-${index}`} className="vocab-flash-def">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            {word.definitions.length > 1 && <span className="text-sm font-semibold text-mute">{index + 1}.</span>}
                            {definition.pos && <span className="vocab-q-pos">{definition.pos}</span>}
                          </div>
                          {definition.english && <p className="vocab-flash-def-en">{definition.english}</p>}
                          {definition.chinese && <p className="vocab-flash-def-zh">{definition.chinese}</p>}
                          {definition.examples.length > 0 && (
                            <ul className="mt-2 space-y-1.5">
                              {realExamplesFirst(definition.examples).map(example => (
                                <li key={example.seq} className="vocab-flash-example">
                                  <div className="flex min-w-0 items-start gap-1">
                                    <span className="vocab-wrap min-w-0 flex-1">{example.sentence}
                                      {example.ai && <span className="vocab-q-tag ml-2 not-italic">AI 例句</span>}
                                      <SceneTag sentence={example.sentence} control={scenes.control} />
                                    </span>
                                    <VoiceButton text={example.sentence} kind="sentence" />
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                  {/* 043：「我的例句」放在释义下面（左栏通常有空位，不把卡片撑高）；data-flash-notes：点这里不翻面、快捷键让给输入框。 */}
                  {(() => {
                    const wordExamples = myExamples.byKey.get(exampleKey(word.word)) ?? [];
                    return (
                      <div className="mt-5 min-w-0" data-flash-notes="" data-testid="flash-examples" data-count={wordExamples.length}>
                        <div className="vocab-q-label mb-2"><span>我的例句{wordExamples.length > 0 ? `（${wordExamples.length}）` : ''}</span></div>
                        {myExamples.error && <p role="alert" className="mb-2 text-xs text-danger">{myExamples.error}</p>}
                        <ExamplesSection key={word.id} word={word.word} examples={wordExamples} senses={sensesFrom(word.definitions)} handlers={myExamples.handlers} compact scenes={scenes.control} />
                      </div>
                    );
                  })()}
                </div>
                <div className="vocab-flash-side">
                  <div className="vocab-flash-aside">
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                      <dt className="text-mute">状态</dt><dd className="font-semibold text-ink">{statusLabel(word.status)}</dd>
                      <dt className="text-mute">到期日</dt><dd className="text-ink">{word.due}（{dueLabel(word)}）</dd>
                    </dl>
                    <div className="mt-3 text-xs font-semibold text-mute">完整备注</div>
                    <p className="vocab-flash-note mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink">{word.note || '（无备注）'}</p>
                  </div>
                  {(() => {
                    const wordNotes = notesByKey.get(noteKey(word.word)) ?? [];
                    return (
                      <div className={wordNotes.length > 0 ? 'vocab-flash-notes' : 'min-w-0'} data-flash-notes="" data-testid="flash-notes" data-count={wordNotes.length}>
                        {wordNotes.length > 0 && <div className="mb-2 text-xs font-semibold text-mute">我的笔记（{wordNotes.length}）</div>}
                        {notesError && <p role="alert" className="mb-2 text-xs text-danger">{notesError}</p>}
                        <NotesSection key={word.id} word={word.word} notes={wordNotes} handlers={noteHandlers} source="闪卡" compact />
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>
          </div>
        )}
        </div>

        <div className="vocab-flash-controls">
          <button type="button" onClick={() => doGo(-1)} disabled={!canPrev(state)} className={btn} aria-label={IS_MOBILE ? '上一张' : '上一张（←）'}>
            <ChevronLeft size={16} />上一张
          </button>
          <button type="button" onClick={doFlip} className={btn} aria-label={IS_MOBILE ? '翻面' : '翻面（空格）'}>
            <RotateCcw size={14} />翻面
          </button>
          {last ? (
            <button type="button" onClick={onExit} className={`press inline-flex items-center justify-center gap-1 rounded-full bg-ink px-5 py-2.5 text-sm text-white md:text-base${IS_MOBILE ? ' min-h-[44px] flex-1' : ''}`}>
              结束
            </button>
          ) : (
            <button type="button" onClick={() => doGo(1)} disabled={!canNext(state)} className={btn} aria-label={IS_MOBILE ? '下一张' : '下一张（→）'}>
              下一张<ChevronRight size={16} />
            </button>
          )}
        </div>
        <p className="vocab-flash-foot mt-3 text-center text-xs text-mute">{IS_MOBILE ? '点卡片翻面，左右滑切换。' : '← → 切换 · 空格翻面 · Esc 退出。'}闪卡只用来回忆，不会改学习等级或到期日。</p>
      </div>
    </div>
  );
}
