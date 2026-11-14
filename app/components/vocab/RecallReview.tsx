import React, { useEffect, useMemo, useRef, useState } from 'react';
import { IS_MOBILE } from '../../utils/platform';
import { ArrowRight, BookmarkPlus, Check, ChevronDown, ChevronUp, CircleHelp, Flag, Loader2, NotebookPen, RotateCcw, Undo2, X } from 'lucide-react';
import { vocabApi } from '../../utils/vocab/api';
import { evaluateAnswer, forgotEvaluation, submitRequest, VERDICT_LABEL } from '../../utils/vocab/evaluate';
import type { Evaluation, Grade } from '../../utils/vocab/evaluate';
import { describeChange } from '../../utils/vocab/grading';
import { statusLabel } from '../../utils/vocab/library';
import { splitScreens, surfaceOf } from '../../utils/vocab/recall';
import type { RecallQuestion, RecallRound } from '../../utils/vocab/recall';
import { groupNotes, noteKey, removeNote, upsertNote } from '../../utils/vocab/notes';
import type { ReviewSubmitResult, VocabNote } from '../../utils/vocab/types';
import Lookable from '../Lookable';
import NotesSection from './NotesSection';
import ExamplesSection, { useMyExamples } from './ExamplesSection';
import { exampleKey, notifyExamplesChanged, reviewExampleSentence, sensesFrom } from '../../utils/vocab/examples';
import './vocab.css';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

interface ItemState {
  written: string;
  /** 判分说明；null = 还没提交。 */
  grade: Grade | null;
  /** 判定结果；null = 还要用户定（笔误申诉、自评）。 */
  correct: boolean | null;
  grading: boolean;
  /** 036「忘记了」：提交这一屏时按答错判，提交前可撤销。 */
  forgot: boolean;
  /** 「这题出错了」：不计分、不改状态，只在保存这一屏时记日志。 */
  flagged: boolean;
  flagLogged: boolean;
  typoLogged: boolean;
  result: ReviewSubmitResult | null;
  saving: boolean;
  error: string;
}

const EMPTY: ItemState = {
  written: '', grade: null, correct: null, grading: false, forgot: false, flagged: false,
  flagLogged: false, typoLogged: false, result: null, saving: false, error: '',
};

/** 同日复检的状态。结果只写日志，永不改复习状态。 */
interface RecheckState {
  phase: 'preparing' | 'answer' | 'judged' | 'unavailable';
  question: RecallQuestion | null;
  written: string;
  grade: Grade | null;
  correct: boolean | null;
  grading: boolean;
  message: string;
  error: string;
}

interface Props {
  /** null 表示还在准备题目（可能在等模型）。 */
  round: RecallRound | null;
  /** 准备题目本身出错（不是单题失败）。 */
  prepareError: string;
  /** 设置里是否配了模型：决定句型题由模型判还是自评。 */
  modelOn: boolean;
  /** 首轮作答前每个词的状态，用来显示「L3 → L1」。 */
  before: Readonly<Record<string, { status: string; due: string }>>;
  /** 为答错的词换一个新语境的题；失败返回中文原因。 */
  makeRecheck: (wordId: string, usedSurface: string) => Promise<RecallQuestion | string>;
  onExit: () => void;
  /** review = 到期复习；first = 新词首考，首考可用 previewed 传预习标记。 */
  variant?: 'review' | 'first';
  /** 覆盖「还有 N 个没轮到」里的 N；首考传本批选取后剩下的新词数。 */
  remaining?: number;
  /** 047：首考预习时看过释义的词；到期复习不传。 */
  previewed?: ReadonlySet<string>;
}

/** 题型标签（038）：填空再按单词/短语/句型细分；改写、造句单独标。 */
function formatLabel(question: RecallQuestion): string {
  if (question.format === 'paraphrase') return '改写';
  if (question.format === 'compose') return '造句';
  return question.kind === 'recall' ? '填空 · 单词' : question.kind === 'rewrite' ? '填空 · 短语' : '句型';
}

function sourceLabel(question: RecallQuestion): string {
  if (question.task) return 'AI 出题';
  if (question.source === 'model') return 'AI 语境句';
  if (question.source === 'definition') return '仅释义';
  return question.context?.ai ? '词库例句（AI）' : '词库例句';
}

const btn = 'press inline-flex items-center justify-center gap-1.5 rounded-full border border-line bg-page px-4 py-2 text-sm text-ink hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40';
const primary = 'press inline-flex items-center justify-center gap-1.5 rounded-full bg-ink px-5 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40';

/**
 * 题面（036 改版）：英文释义是主角（衬线大字），语境句单独一块、空格高亮；中文提示默认折叠。
 * 首轮和复检共用。number 是题号圆标；reveal 后空格里填上答案。
 */
function QuestionFace({ question, label, number, reveal }: { question: RecallQuestion; label: string; number?: number; reveal: boolean }) {
  const answer = question.answers[0] ?? question.target;
  return (
    <>
      <div className="vocab-q-head">
        {number !== undefined && <span className="vocab-q-num" aria-hidden="true">{number}</span>}
        <span className="font-semibold text-ink">{label}</span>
        <span className="vocab-q-tag" data-testid="recall-format">{formatLabel(question)}</span>
        <span className="vocab-q-tag" data-testid="recall-source">{sourceLabel(question)}</span>
      </div>
      <div className="vocab-q-meaning">
        <div className="vocab-q-label">
          <span>英文释义</span>
          {question.pos && <span className="vocab-q-pos">{question.pos}</span>}
          {question.meaningOrigin === 'model' && <span className="vocab-q-tag">AI 释义</span>}
        </div>
        <p className="vocab-q-meaning-text vocab-wrap" data-testid="recall-meaning">{question.meaning}</p>
      </div>
      {question.task ? (
        <TaskFace question={question} task={question.task} />
      ) : question.context ? (
        <div className="vocab-q-sentence-box">
          <div className="vocab-q-label"><span>语境句</span></div>
          <p className="vocab-q-sentence vocab-wrap" data-testid="recall-context">
            {question.context.before}
            {reveal ? (
              <span className="vocab-recall-blank vocab-recall-blank-filled" data-testid="recall-filled">{answer}</span>
            ) : (
              <span className="vocab-recall-blank" aria-label={`空格，提示 ${question.hint}`}>{question.hint}</span>
            )}
            {question.context.after}
          </p>
        </div>
      ) : (
        <p className="vocab-wrap mt-4 rounded-xl border border-clay/30 bg-clay-soft p-3 text-sm text-ink" data-testid="recall-missing-note">
          {question.fallbackReason}
        </p>
      )}
      {question.chinese && (
        <details className="vocab-q-chinese">
          <summary>看中文提示</summary>
          <p className="vocab-wrap mt-1 text-ink" data-testid="recall-chinese">{question.chinese}</p>
        </details>
      )}
    </>
  );
}

/**
 * 改写/造句题面（038）。改写：要求 + 原句，作答前不出现目标词（首字母提示在填写区上方）；
 * 造句：题目本身就要写出目标词，所以单独醒目地标出来。参考答案要判完分才显示（在 GradeDetail 里）。
 */
function TaskFace({ question, task }: { question: RecallQuestion; task: NonNullable<RecallQuestion['task']> }) {
  const paraphrase = question.format === 'paraphrase';
  return (
    <div className="vocab-q-sentence-box" data-testid="recall-task">
      <div className="vocab-q-label">
        <span>{paraphrase ? '改写要求' : '造句要求'}</span>
        {!paraphrase && <span className="vocab-q-target" data-testid="recall-task-target">{question.target}</span>}
      </div>
      <p className="vocab-q-task vocab-wrap" data-testid="recall-task-instruction">{task.instruction}</p>
      {paraphrase && (
        <>
          <div className="vocab-q-label mt-3"><span>原句</span></div>
          <p className="vocab-q-sentence vocab-wrap" data-testid="recall-task-original">{task.original}</p>
        </>
      )}
      <p className="mt-2 text-xs text-mute">
        {paraphrase
          ? '用目标词（按首字母提示）改写这句，意思不变；用近义词不算完成。'
          : '按要求写一句完整的话，必须用上这个词（词形可以变）。'}
      </p>
    </div>
  );
}

/** 填写区上方的提示行：空格首字母 + 字母数。造句题没有提示（目标词已经给出）。 */
function HintLine({ question }: { question: RecallQuestion }) {
  if (!question.hint) return null;
  return (
    <p className="vocab-q-hint" data-testid="recall-hint">
      {question.format === 'paraphrase' ? '目标词：' : '提示：'}<span className="vocab-q-hint-letters">{question.hint}</span>
      <span className="text-mute">（{question.hintLabel}{question.format === 'paraphrase' ? '，词形可变' : ''}）</span>
    </p>
  );
}

/** 手机没有「导入」入口：把出题失败原因里的「先在『导入』里导入释义」换成手机能做的说法。 */
function mobileReason(reason: string): string {
  return reason
    .replace('先在「导入」里导入释义，或在「设置」里配置模型。', '可在「设置」里配置模型。')
    .replace('先在「导入」里导入释义。', '先在电脑上补全释义。');
}

function placeholderFor(question: RecallQuestion, modelOn: boolean, forgot: boolean): string {
  if (forgot) return '已选「忘记了」';
  if (question.format === 'paraphrase') return '用目标词改写上面的原句，提交后由模型判';
  if (question.format === 'compose') return '按要求用 ' + question.target + ' 写一句话，提交后由模型判';
  if (question.selfCheck) return modelOn ? '用这个表达写一句完整的话，提交后由模型判' : '写一句用上这个表达的话，提交后对照答案自评';
  return '填空格里的词';
}

function verdictText(grade: Grade, correct: boolean | null, written: string): string {
  if (grade.kind === 'typo') {
    if (correct === true) return '按笔误判对';
    if (correct === false) return '答错（拼写不同）';
    return VERDICT_LABEL.typo;
  }
  if (grade.kind === 'manual') return correct === null ? VERDICT_LABEL.manual : correct ? '答对（自评）' : '答错（自评）';
  if (grade.kind === 'wrong' && written.trim().length === 0) return '没作答，按答错计';
  return VERDICT_LABEL[grade.kind];
}

/** 判分详情：模型给的语法修正、学术升级版也在这里。 */
function GradeDetail({ grade, correct, written, answer, reference }: { grade: Grade; correct: boolean | null; written: string; answer: string; reference?: string }) {
  const tone = correct === true ? 'border-success/30 bg-success-soft text-success'
    : correct === false ? 'border-danger/30 bg-danger-soft text-danger'
      : 'border-clay/30 bg-clay-soft text-ink';
  return (
    <div className={`vocab-q-result rounded-xl border p-3 text-sm ${tone}`} data-testid="recall-result" data-correct={correct === null ? 'pending' : correct ? 'true' : 'false'} data-kind={grade.kind}>
      <div className="text-base font-semibold" data-testid="recall-verdict">{verdictText(grade, correct, written)}</div>
      <p className="vocab-wrap mt-1" data-testid="recall-reason">{grade.reason}</p>
      {correct !== true && (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-2">
          <span className="text-mute">目标形式</span>
          <span className="vocab-q-answer-word vocab-wrap" data-testid="recall-correct-answer">{answer}</span>
        </div>
      )}
      {(grade.model?.grammarFix || grade.model?.academicUpgrade) && (
        <ol className="vocab-q-fixes mt-2" data-testid="recall-fixes">
          {grade.model?.grammarFix && (
            <li><span className="vocab-q-fix-label">① 语法修正版</span><span className="vocab-wrap text-ink" data-testid="recall-grammar-fix">{grade.model.grammarFix}</span></li>
          )}
          {grade.model?.academicUpgrade && (
            <li><span className="vocab-q-fix-label">② 学术升级版</span><span className="vocab-wrap text-ink" data-testid="recall-upgrade">{grade.model.academicUpgrade}</span></li>
          )}
        </ol>
      )}
      {reference && (
        <div className="vocab-wrap mt-2"><span className="text-mute">参考答案：</span><span className="text-ink" data-testid="recall-reference">{reference}</span></div>
      )}
    </div>
  );
}

/**
 * 到期复习（030 出题 + 031 判分）。
 * 提交一屏后先逐题判分（不写库），用户可以改判笔误、标「这题出错了」；
 * 点「保存并下一屏」时才把没标出错的题写回复习库。最后一屏之后给逐题结果表，答错的词可以换语境复检。
 */
export default function RecallReview({ round, prepareError, modelOn, before, makeRecheck, onExit, variant = 'review', remaining, previewed }: Props) {
  const firstTest = variant === 'first';
  const questions = round?.questions ?? [];
  const screens = useMemo(() => splitScreens(questions.map((_, index) => index)), [questions]);
  const [screen, setScreen] = useState(0);
  const [phase, setPhase] = useState<'write' | 'check' | 'done'>('write');
  const [items, setItems] = useState<Record<number, ItemState>>({});
  const [rechecks, setRechecks] = useState<Record<number, RecheckState>>({});
  const [committing, setCommitting] = useState(false);
  /**
   * 041 词条笔记：进来时读一次全部笔记，只在本机显示；出题、判分的请求从不带它。
   * 作答中（提交这一屏前）笔记面板只能新写，旧笔记和条数要等判分后才显示，免得借笔记看到答案。
   */
  const [notes, setNotes] = useState<VocabNote[]>([]);
  const [notesError, setNotesError] = useState('');
  const [notesOpen, setNotesOpen] = useState<Record<number, boolean>>({});
  const notePanelRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const inputRefs = useRef<(HTMLInputElement | HTMLTextAreaElement | null)[]>([]);
  const submitRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  // 复习遮罩打开期间，让其周围的页面分支 inert：Tab 和 focus 都不能摸到背景详情。
  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const changed: Array<{ element: HTMLElement; wasInert: boolean }> = [];
    let branch: HTMLElement = modal;
    while (branch.parentElement) {
      const parent = branch.parentElement;
      for (const sibling of Array.from(parent.children)) {
        if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
        changed.push({ element: sibling, wasInert: sibling.inert });
        sibling.inert = true;
      }
      if (parent === document.body) break;
      branch = parent;
    }
    modal.focus({ preventScroll: true });
    return () => {
      for (const { element, wasInert } of changed.reverse()) element.inert = wasInert;
      if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    vocabApi.listNotes()
      .then(list => { if (aliveRef.current) setNotes(list); })
      .catch(reason => { if (aliveRef.current) setNotesError(`读取笔记失败：${errorText(reason)}`); });
  }, []);
  const notesByKey = useMemo(() => groupNotes(notes), [notes]);
  const noteHandlers = useMemo(() => ({
    onSaved: (note: VocabNote) => { if (aliveRef.current) setNotes(list => upsertNote(list, note)); },
    onDeleted: (id: number) => { if (aliveRef.current) setNotes(list => removeNote(list, id)); },
  }), []);
  const toggleNotes = (index: number) => {
    const open = !notesOpen[index];
    setNotesOpen(state => ({ ...state, [index]: open }));
    // 打开后焦点进输入框，键盘用户接着就能写。
    if (open) window.setTimeout(() => notePanelRefs.current[index]?.querySelector<HTMLTextAreaElement>('[data-testid=note-input]')?.focus(), 0);
  };

  const ready = round !== null;
  const finished = ready && (questions.length === 0 || phase === 'done');
  /**
   * 043 我的例句：只在整轮结束的结果页出现（防泄题：作答中、逐屏判分时都不读、不显示）。
   * 判分通过的改写/造句答案可以「存为我的例句」（来源「自己写」）；每个词还有一个收起的小入口。
   */
  const myExamples = useMyExamples(finished);
  const [exampleSaves, setExampleSaves] = useState<Record<number, { busy: boolean; error: string }>>({});
  const saveAnswerAsExample = async (index: number, sentence: string) => {
    if (exampleSaves[index]?.busy) return;
    setExampleSaves(state => ({ ...state, [index]: { busy: true, error: '' } }));
    try {
      myExamples.handlers.onSaved(await vocabApi.addExamples({ word: questions[index].target, items: [{ sentence, source: '自己写' }] }));
      notifyExamplesChanged();
      if (aliveRef.current) setExampleSaves(state => ({ ...state, [index]: { busy: false, error: '' } }));
    } catch (reason) {
      if (aliveRef.current) setExampleSaves(state => ({ ...state, [index]: { busy: false, error: `保存失败：${errorText(reason)}` } }));
    }
  };
  /** 结果页「还有 N 个没轮到」：首考用本批选取后的剩余数，复习用到期队列剩下的。 */
  const left = remaining ?? round?.remaining ?? 0;
  const current = screens[screen] ?? [];
  const item = (index: number) => items[index] ?? EMPTY;
  const patch = (index: number, change: Partial<ItemState>) => {
    if (!aliveRef.current) return;
    setItems(state => ({ ...state, [index]: { ...(state[index] ?? EMPTY), ...change } }));
  };
  const patchRecheck = (index: number, change: Partial<RecheckState>) => {
    if (!aliveRef.current) return;
    setRechecks(state => ({ ...state, [index]: { ...state[index], ...change } }));
  };

  // 只捕获本弹层的 Esc；组件关闭即解除，不会残留到精听听写页。
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (document.querySelector('[data-definition-popup]')) return;
      event.preventDefault();
      event.stopPropagation();
      // 焦点在某题的笔记面板里：Esc 只收起这个面板、焦点回到「记一笔」按钮，不退出整轮。
      // 面板收起只是隐藏不卸载，没保存的草稿还在，再点开就能接着写。
      const active = document.activeElement instanceof Element ? document.activeElement : null;
      const panel = active?.closest<HTMLElement>('.vocab-q-notes[id^="recall-notes-"]');
      if (panel) {
        const index = Number(panel.id.slice('recall-notes-'.length));
        setNotesOpen(state => ({ ...state, [index]: false }));
        document.querySelector<HTMLElement>(`[aria-controls="${panel.id}"]`)?.focus();
        return;
      }
      onExitRef.current();
    };
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, []);

  useEffect(() => {
    if (ready && phase === 'write') inputRefs.current[current[0]]?.focus();
  }, [ready, screen, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 提交这一屏：逐题判分，不写库。 */
  const submitScreen = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (phase !== 'write') return;
    setPhase('check');
    await Promise.all(current.map(async index => {
      const state = item(index);
      if (state.flagged) return;
      patch(index, { grading: true });
      const outcome: Evaluation = await evaluateAnswer(questions[index], state.written, { modelOn, forgot: state.forgot });
      patch(index, { grading: false, grade: outcome.grade, correct: outcome.correct });
    }));
  };

  /** 保存这一屏：没标出错的题写回复习库，标了的只写日志。可重复点，已成功的不会重复写。 */
  const commitScreen = async (): Promise<boolean> => {
    setCommitting(true);
    let ok = true;
    for (const index of current) {
      const question = questions[index];
      const state = item(index);
      if (state.flagged) {
        if (!state.flagLogged) {
          try {
            await vocabApi.reviewEvent({ id: question.wordId, kind: 'question_error', correct: false, detail: surfaceOf(question) });
            patch(index, { flagLogged: true, error: '' });
          } catch (reason) {
            patch(index, { error: `记录失败：${errorText(reason)}` });
            ok = false;
          }
        }
        continue;
      }
      // 「忘记了」在判分时已变成 correct = false，这里和答错走同一条写回路径。
      const request = submitRequest(question, state, firstTest && previewed?.has(question.wordId) === true);
      if (request === null) { ok = false; continue; }
      let result = state.result;
      if (result === null) {
        patch(index, { saving: true, error: '' });
        try {
          result = await vocabApi.submitReview(request);
          patch(index, { result, saving: false });
        } catch (reason) {
          patch(index, { saving: false, error: `保存失败：${errorText(reason)}` });
          ok = false;
          continue;
        }
      }
      if (state.grade?.kind === 'typo' && state.correct && !state.typoLogged) {
        try {
          await vocabApi.reviewEvent({ id: question.wordId, kind: 'typo', correct: true, detail: `笔误：用户写法 ${state.written.trim()}（应为 ${state.grade.expected}）` });
          patch(index, { typoLogged: true });
        } catch (reason) {
          patch(index, { error: `笔误记录失败：${errorText(reason)}` });
          ok = false;
        }
      }
    }
    if (aliveRef.current) setCommitting(false);
    return ok;
  };

  const ready2Commit = current.every(index => {
    const state = item(index);
    return !state.grading && !state.saving && (state.flagged || state.correct !== null);
  });
  const isLast = screen + 1 >= screens.length;

  const next = async () => {
    if (!ready2Commit || committing) return;
    const ok = await commitScreen();
    if (!ok || !aliveRef.current) return;
    if (isLast) { setPhase('done'); return; }
    setScreen(value => value + 1);
    setPhase('write');
  };

  const onInputKey = (event: React.KeyboardEvent, position: number) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.target instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    const following = current[position + 1];
    if (following !== undefined) inputRefs.current[following]?.focus();
    else void submitScreen();
  };

  /**
   * 「忘记了」开关：只在作答阶段可点，提交这一屏后就锁定。
   * 点下后焦点跳到下一题（最后一题就跳到「提交这一屏」），撤销时回到本题输入框，键盘可以一路答下去。
   * 答案此时不显示：要等整屏提交后才露出来，免得撤销后照抄、也免得提前看到同屏别的提示。
   */
  const toggleForgot = (index: number, position: number) => {
    if (phase !== 'write') return;
    const forgot = !item(index).forgot;
    patch(index, { forgot, flagged: forgot ? false : item(index).flagged });
    window.setTimeout(() => {
      if (!forgot) { inputRefs.current[index]?.focus(); return; }
      const following = current[position + 1];
      if (following !== undefined) inputRefs.current[following]?.focus();
      else submitRef.current?.focus();
    }, 0);
  };

  const blanks = current.filter(index => !item(index).flagged && !item(index).forgot && item(index).written.trim().length === 0).length;
  const forgotCount = current.filter(index => !item(index).flagged && item(index).forgot).length;
  const saved = questions.map((question, index) => ({ question, index, state: item(index) })).filter(entry => entry.state.result !== null);
  const flaggedDone = questions.map((question, index) => ({ question, index, state: item(index) })).filter(entry => entry.state.flagged && entry.state.flagLogged);
  const correctCount = saved.filter(entry => entry.state.correct).length;
  const progress = !ready ? 0 : finished ? 100 : Math.round((current[0] ?? 0) / Math.max(questions.length, 1) * 100);

  const notices = round && round.notices.length > 0 && (
    <ul className="vocab-wrap mt-4 space-y-1 rounded-xl border border-clay/30 bg-clay-soft p-3 text-sm text-ink" data-testid="recall-notices">
      {round.notices.map(text => <li key={text}>{text}</li>)}
    </ul>
  );

  // ------------------------------------------------ 首轮每题

  const decide = (index: number, correct: boolean) => patch(index, { correct });

  /** 模型判分失败退到自评后，可以再请模型判一次（038）；仍失败就继续自评，绝不默认算对。 */
  const regrade = async (index: number) => {
    const state = item(index);
    if (state.grading || state.result !== null) return;
    patch(index, { grading: true, grade: null, correct: null });
    const outcome = await evaluateAnswer(questions[index], state.written, { modelOn });
    patch(index, { grading: false, grade: outcome.grade, correct: outcome.correct });
  };

  const renderQuestion = (index: number, position: number) => {
    const question = questions[index];
    const state = item(index);
    const writing = phase === 'write';
    const answer = state.grade?.expected ?? question.answers[0] ?? question.target;
    const locked = state.result !== null;
    const reveal = !writing && state.grade !== null && state.correct !== null;
    const tone = state.flagged ? 'flagged'
      : writing ? (state.forgot ? 'forgot' : 'writing')
        : state.correct === true ? 'correct' : state.correct === false ? 'wrong' : 'pending';
    const inputClass = `vocab-q-input vocab-wrap${state.forgot && !state.flagged ? ' vocab-q-input-forgot' : ''}`;
    // 作答中不算、也不传旧笔记（连条数都不露）；判分后才取这个词的全部笔记。
    const wordNotes = writing ? [] : notesByKey.get(noteKey(question.target)) ?? [];
    return (
      <article
        key={question.wordId}
        className="vocab-q"
        data-tone={tone}
        data-testid="recall-question"
        data-source={question.source}
        data-format={question.format}
        data-word={question.wordId}
        data-flagged={state.flagged ? 'true' : 'false'}
        data-forgot={state.forgot ? 'true' : 'false'}
      >
        <div className="vocab-q-prompt">
          <QuestionFace question={question} label={`第 ${index + 1} 题`} number={index + 1} reveal={reveal} />
        </div>

        <div className="vocab-q-answer">
          <HintLine question={question} />
          <label htmlFor={`recall-input-${index}`} className="sr-only">第 {index + 1} 题答案</label>
          <div className="vocab-q-input-row">
            {question.selfCheck ? (
              <textarea
                ref={element => { inputRefs.current[index] = element; }}
                id={`recall-input-${index}`}
                value={state.written}
                onChange={event => patch(index, { written: event.target.value })}
                readOnly={!writing || state.flagged || state.forgot}
                rows={question.task ? 4 : 3}
                spellCheck={false}
                autoComplete="off"
                placeholder={placeholderFor(question, modelOn, state.forgot)}
                className={`${inputClass} resize-y`}
                data-testid="recall-input"
              />
            ) : (
              <input
                ref={element => { inputRefs.current[index] = element; }}
                id={`recall-input-${index}`}
                type="text"
                value={state.written}
                onChange={event => patch(index, { written: event.target.value })}
                onKeyDown={event => onInputKey(event, position)}
                readOnly={!writing || state.flagged || state.forgot}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                placeholder={placeholderFor(question, modelOn, state.forgot)}
                className={inputClass}
                data-testid="recall-input"
              />
            )}
            {writing && !state.flagged && (
              <button
                type="button"
                onClick={() => toggleForgot(index, position)}
                aria-pressed={state.forgot}
                className={`vocab-q-forgot press${state.forgot ? ' vocab-q-forgot-on' : ''}`}
                title={state.forgot ? '撤销「忘记了」，继续作答' : '想不起来：按答错计，提交这一屏后显示答案'}
                data-testid="recall-forgot"
              >
                {state.forgot ? <><Undo2 size={16} />撤销</> : <><CircleHelp size={16} />忘记了</>}
              </button>
            )}
          </div>

          {writing && state.forgot && !state.flagged && (
            <p className="vocab-wrap mt-2 rounded-xl border border-danger/25 bg-danger-soft px-3 py-2 text-sm text-ink" data-testid="recall-forgot-note">
              已选「忘记了」：这题按答错计，提交这一屏后显示答案。提交前可以点「撤销」。
            </p>
          )}

          {state.flagged ? (
            <p className="vocab-wrap mt-3 rounded-xl border border-clay/30 bg-clay-soft p-3 text-sm text-ink" data-testid="recall-flagged-note">
              已标记「这题出错了」：这题不计分、不改状态，下一轮不再出这道题面。
              {state.flagLogged && <span className="ml-1 text-mute">（已记入日志）</span>}
            </p>
          ) : (
            <>
              {state.grading && (
                <p className="mt-3 inline-flex items-center gap-2 text-sm text-mute" data-testid="recall-grading"><Loader2 size={14} className="animate-spin" />模型正在判分…</p>
              )}

              {state.grade && state.grade.kind === 'manual' && state.correct === null && (
                <div className="mt-3" data-testid="recall-self-check">
                  <p className="vocab-wrap text-sm text-mute" data-testid="recall-reason">{state.grade.reason}</p>
                  <div className="mt-2 text-xs text-mute">{question.task ? '目标词' : '参考答案'}</div>
                  <p className="vocab-q-answer-word vocab-wrap mt-1 rounded-xl border border-line bg-paper p-3" data-testid="recall-correct-answer">{question.target}</p>
                  {question.task && (
                    <>
                      <div className="mt-2 text-xs text-mute">参考答案（对照自评：没用上目标词就算没写对）</div>
                      <p className="vocab-wrap mt-1 rounded-xl border border-line bg-paper p-3 text-sm text-ink" data-testid="recall-reference">{question.task.reference}</p>
                    </>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => decide(index, true)} className={primary} data-testid="recall-self-correct"><Check size={16} />我写对了</button>
                    <button type="button" onClick={() => decide(index, false)} className={btn} data-testid="recall-self-wrong"><X size={16} />我写错了</button>
                    {modelOn && !locked && (
                      <button type="button" onClick={() => void regrade(index)} className={btn} data-testid="recall-regrade"><RotateCcw size={16} />重新让模型判</button>
                    )}
                  </div>
                </div>
              )}

              {state.grade && !(state.grade.kind === 'manual' && state.correct === null) && (
                <div className="mt-3" aria-live="polite">
                  <GradeDetail grade={state.grade} correct={state.correct} written={state.written} answer={answer} reference={question.task?.reference} />
                  {state.grade.kind === 'typo' && !locked && (
                    <div className="mt-2 flex flex-wrap gap-2" data-testid="recall-typo-actions">
                      <button type="button" onClick={() => decide(index, true)} aria-pressed={state.correct === true} className={state.correct === true ? primary : btn} data-testid="recall-typo-accept">按笔误判对</button>
                      <button type="button" onClick={() => decide(index, false)} aria-pressed={state.correct === false} className={state.correct === false ? primary : btn} data-testid="recall-typo-reject">就是拼错了，判错</button>
                    </div>
                  )}
                </div>
              )}

              {state.saving && <p className="mt-2 text-sm text-mute" data-testid="recall-saving">正在保存…</p>}
              {state.result && (
                <p className="mt-2 text-sm text-ink" data-testid="recall-saved">
                  {state.result.due
                    ? <>新到期日：<span className="font-semibold" data-testid="recall-new-due">{state.result.due}</span> · {statusLabel(state.result.status)}</>
                    : <span className="font-semibold" data-testid="recall-new-due">已掌握</span>}
                  {!state.result.changed && <span className="ml-2 text-mute" data-testid="recall-unchanged">今天已计入，不再升级</span>}
                </p>
              )}
            </>
          )}

          {state.error && (
            <div role="alert" className="vocab-wrap mt-2 rounded-xl border border-danger/30 bg-danger-soft p-2 text-sm text-danger">
              {state.error}（点右下角按钮可重试）
            </div>
          )}

          <div className="vocab-q-tools">
            {!locked && !state.flagLogged && !state.grading && (
              <button
                type="button"
                onClick={() => patch(index, { flagged: !state.flagged, forgot: writing ? false : state.forgot })}
                aria-pressed={state.flagged}
                className="press inline-flex items-center gap-1.5 text-xs text-mute underline"
                data-testid="recall-flag"
              >
                <Flag size={12} />{state.flagged ? '取消「这题出错了」' : '这题出错了'}
              </button>
            )}
            <button
              type="button"
              onClick={() => toggleNotes(index)}
              aria-expanded={!!notesOpen[index]}
              aria-controls={`recall-notes-${index}`}
              className="vocab-q-note-btn press"
              title={writing ? '随手记一笔；提交这一屏后能看到这个词的全部笔记' : '看这个词的全部笔记，也能接着加'}
              data-testid="recall-note-toggle"
            >
              <NotebookPen size={14} />
              {writing ? '记一笔' : `笔记（${wordNotes.length}）`}
              {notesOpen[index] ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>
          {/* 收起时只隐藏不卸载：没保存的草稿不会丢，作答 → 判分切换时也不会丢。 */}
          <div
            id={`recall-notes-${index}`}
            ref={element => { notePanelRefs.current[index] = element; }}
            hidden={!notesOpen[index]}
            className="vocab-q-notes"
            data-testid="recall-notes"
            data-phase={writing ? 'blind' : 'open'}
          >
            <p className="mb-2 text-xs text-mute">
              {writing
                ? `第 ${index + 1} 题 · 记一笔。保存后立刻存好，中途退出也不会丢，不影响这题的作答和判分。`
                : `这个词的全部笔记（新的在上）。只存在这台电脑上，不会发给模型。`}
            </p>
            {notesError && !writing && <p role="alert" className="mb-2 text-xs text-danger">{notesError}</p>}
            <NotesSection
              word={question.target}
              notes={writing ? [] : wordNotes}
              handlers={noteHandlers}
              source={firstTest ? '首考' : '复习'}
              blind={writing}
              label={writing ? `第 ${index + 1} 题` : undefined}
            />
          </div>
        </div>
      </article>
    );
  };

  // ------------------------------------------------ 同日复检

  const startRecheck = async (index: number) => {
    const question = questions[index];
    patchRecheck(index, { phase: 'preparing', question: null, written: '', grade: null, correct: null, grading: false, message: '', error: '' });
    let outcome: RecallQuestion | string;
    try {
      outcome = await makeRecheck(question.wordId, surfaceOf(question));
    } catch (reason) {
      outcome = `准备复检题失败：${errorText(reason)}`;
    }
    if (typeof outcome === 'string') patchRecheck(index, { phase: 'unavailable', message: outcome });
    else patchRecheck(index, { phase: 'answer', question: outcome });
  };

  const logRecheck = async (index: number, correct: boolean, grade: Grade | null): Promise<boolean> => {
    const state = rechecks[index];
    const question = questions[index];
    if (!state?.question) return false;
    const typo = grade?.kind === 'typo' && correct ? '（笔误：用户写法）' : '';
    const answerText = grade?.kind === 'forgot' ? '忘记了' : `答：${state.written.trim()}${typo}`;
    try {
      await vocabApi.reviewEvent({ id: question.wordId, kind: 'recheck', correct, detail: `${surfaceOf(state.question)} | ${answerText}` });
      patchRecheck(index, { correct, phase: 'judged', error: '' });
      return true;
    } catch (reason) {
      patchRecheck(index, { error: `记录失败：${errorText(reason)}` });
      return false;
    }
  };

  const judgeRecheck = async (index: number) => {
    const state = rechecks[index];
    if (!state?.question || state.grading) return;
    patchRecheck(index, { grading: true, error: '' });
    const outcome = await evaluateAnswer(state.question, state.written, { modelOn });
    patchRecheck(index, { grading: false, grade: outcome.grade });
    if (outcome.correct !== null) await logRecheck(index, outcome.correct, outcome.grade);
    else patchRecheck(index, { phase: 'judged', correct: null });
  };

  /** 复检里的「忘记了」：复检只有一题，点了直接记一条答错的复检日志并显示答案（复检本来就不改状态）。 */
  const forgetRecheck = async (index: number) => {
    const state = rechecks[index];
    if (!state?.question || state.grading || state.phase !== 'answer') return;
    const outcome = forgotEvaluation(state.question);
    // 先不显示答案：日志写成功才进入「已判」并露出答案；失败就留在作答状态，可以再点一次。
    const logged = await logRecheck(index, false, outcome.grade);
    if (logged) patchRecheck(index, { grade: outcome.grade });
  };

  const renderRecheck = (index: number) => {
    const state = rechecks[index];
    if (!state) return null;
    const question = questions[index];
    const recheckQuestion = state.question;
    const tone = state.phase !== 'judged' ? 'writing' : state.correct === true ? 'correct' : state.correct === false ? 'wrong' : 'pending';
    return (
      <article key={`recheck-${question.wordId}`} className="vocab-q vocab-q-recheck" data-tone={tone} data-testid="recheck-card" data-phase={state.phase}>
        <div className="vocab-q-span">
          <div className="text-base font-semibold text-ink">复检：{question.target}</div>
          <p className="mt-1 text-xs text-mute">换一个新语境再答一次。复检只记日志，不改状态、不升级，也不抵消首轮答错。</p>
          {state.phase === 'preparing' && (
            <p className="mt-3 inline-flex items-center gap-2 text-sm text-mute"><Loader2 size={14} className="animate-spin" />正在准备新语境的题…</p>
          )}
          {state.phase === 'unavailable' && (
            <p className="vocab-wrap mt-3 rounded-xl border border-clay/30 bg-clay-soft p-3 text-sm text-ink" data-testid="recheck-unavailable">{state.message}</p>
          )}
        </div>
        {recheckQuestion && (state.phase === 'answer' || state.phase === 'judged') && (
          <form
            className="vocab-q-span vocab-q-grid"
            onSubmit={event => { event.preventDefault(); if (state.phase === 'answer') void judgeRecheck(index); }}
          >
            <div className="vocab-q-prompt">
              <QuestionFace question={recheckQuestion} label="新语境" reveal={state.phase === 'judged' && state.correct !== null} />
            </div>
            <div className="vocab-q-answer">
              <HintLine question={recheckQuestion} />
              <div className="vocab-q-input-row">
                {recheckQuestion.selfCheck ? (
                  <textarea
                    value={state.written}
                    onChange={event => patchRecheck(index, { written: event.target.value })}
                    readOnly={state.phase !== 'answer'}
                    rows={3}
                    spellCheck={false}
                    autoComplete="off"
                    aria-label="复检答案"
                    className="vocab-q-input vocab-wrap resize-y"
                    data-testid="recheck-input"
                  />
                ) : (
                  <input
                    type="text"
                    value={state.written}
                    onChange={event => patchRecheck(index, { written: event.target.value })}
                    readOnly={state.phase !== 'answer'}
                    spellCheck={false}
                    autoComplete="off"
                    autoCapitalize="off"
                    aria-label="复检答案"
                    placeholder="填空格里的词"
                    className="vocab-q-input vocab-wrap"
                    data-testid="recheck-input"
                  />
                )}
              </div>
              {state.phase === 'answer' && (
                <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                  <button type="button" onClick={() => void forgetRecheck(index)} disabled={state.grading} className="vocab-q-forgot press" data-testid="recheck-forgot">
                    <CircleHelp size={16} />忘记了
                  </button>
                  <button type="submit" disabled={state.grading} className={primary} data-testid="recheck-submit">{state.grading ? '判分中…' : '提交复检'}</button>
                </div>
              )}
              {state.grade && (
                <div className="mt-3" data-testid="recheck-result">
                  {state.grade.kind === 'manual' && state.correct === null ? (
                    <div>
                      <p className="vocab-wrap text-sm text-mute">{state.grade.reason}</p>
                      <p className="vocab-q-answer-word vocab-wrap mt-2 rounded-xl border border-line bg-paper p-3">{recheckQuestion.target}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button type="button" onClick={() => void logRecheck(index, true, state.grade)} className={primary} data-testid="recheck-self-correct"><Check size={16} />我写对了</button>
                        <button type="button" onClick={() => void logRecheck(index, false, state.grade)} className={btn} data-testid="recheck-self-wrong"><X size={16} />我写错了</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <GradeDetail grade={state.grade} correct={state.correct} written={state.written} answer={state.grade.expected} />
                      {state.grade.kind === 'typo' && state.correct === null && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button type="button" onClick={() => void logRecheck(index, true, state.grade)} className={btn} data-testid="recheck-typo-accept">按笔误判对</button>
                          <button type="button" onClick={() => void logRecheck(index, false, state.grade)} className={btn} data-testid="recheck-typo-reject">就是拼错了，判错</button>
                        </div>
                      )}
                    </>
                  )}
                  {state.correct !== null && <p className="mt-2 text-xs text-mute" data-testid="recheck-logged">复检结果已记入日志（{state.correct ? '答对' : '答错'}），状态没有变化。</p>}
                </div>
              )}
            </div>
          </form>
        )}
        {state.error && <div role="alert" className="vocab-q-span vocab-wrap mt-2 rounded-xl border border-danger/30 bg-danger-soft p-2 text-sm text-danger">{state.error}</div>}
      </article>
    );
  };

  // ------------------------------------------------ 结果表

  const resultRows = questions.map((question, index) => ({ question, index, state: item(index) }))
    .filter(entry => entry.state.result !== null || (entry.state.flagged && entry.state.flagLogged));
  const forgotSaved = saved.filter(entry => entry.state.grade?.kind === 'forgot').length;

  const rowCells = ({ question, state }: { question: RecallQuestion; state: ItemState }) => {
    if (state.flagged) {
      return {
        written: state.written.trim() || '—',
        verdict: '题目出错（不计分）',
        form: question.answers[0] ?? question.target,
        reason: '你标了「这题出错了」，只记日志，不改状态。',
        change: `不变：${statusLabel(before[question.wordId]?.status ?? '')}`,
        tone: 'text-clay',
      };
    }
    const grade = state.grade;
    return {
      written: grade?.kind === 'forgot' ? '（忘记了）' : state.written.trim() || '—',
      verdict: grade ? verdictText(grade, state.correct, state.written) : state.correct ? '答对' : '答错',
      form: grade?.expected ?? question.answers[0] ?? question.target,
      reason: grade?.reason ?? '',
      change: state.result ? describeChange(before[question.wordId], state.result) : '',
      tone: state.correct ? 'text-success' : 'text-danger',
    };
  };

  const rechecksOpen = Object.keys(rechecks).map(Number).sort((a, b) => a - b);
  // 作答时才遮答案；提交后（包括首轮结果页）恢复正常查词。复检作答仍单独遮住复检目标。
  const lookupTargets = [
    ...(phase === 'write' ? current.flatMap(index => {
      const question = questions[index];
      return question ? [question.target, ...question.answers] : [];
    }) : []),
    ...rechecksOpen.flatMap(index => {
      const state = rechecks[index];
      return state?.phase === 'answer' && state.question ? [state.question.target, ...state.question.answers] : [];
    }),
  ];

  const title = firstTest ? '新词首考' : '到期复习';
  const hasTasks = questions.some(question => question.task !== null);

  // 042：作答中（phase === 'write' 或复检作答中）不给「加入词库」；判完分才给，来源记首考/复习。
  const addSource = phase === 'write' || lookupTargets.length > 0 ? undefined : firstTest ? '首考' : '复习';

  return (
    <Lookable targets={lookupTargets} zIndex={90} addSource={addSource}>
      <div ref={modalRef} tabIndex={-1} className={`vocab-flash-overlay vocab-recall-overlay${IS_MOBILE ? ' vocab-quiz-m' : ''}`} role="dialog" aria-modal="true" aria-label={firstTest ? '新词首考' : '到期词复习'} data-testid="recall">
      <div className="vocab-flash-inner vocab-quiz-inner">
        <header className="vocab-quiz-top">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="vocab-quiz-title">{title}</span>
              <span className="text-sm text-mute" data-testid="recall-progress">
                {!ready ? '正在准备题目' : finished ? '本轮结束' : `第 ${screen + 1} / ${screens.length} 屏 · 本屏 ${current.length} 题 · 共 ${questions.length} 题`}
              </span>
            </div>
            <div className="vocab-flash-bar mt-2" aria-hidden="true">
              <div className="vocab-flash-bar-fill" style={{ width: `${progress}%` }} />
            </div>
          </div>
          <button type="button" onClick={onExit} className={btn} aria-label={IS_MOBILE ? '退出复习' : '退出复习（Esc）'} title={IS_MOBILE ? undefined : '退出（Esc）'}>
            <X size={16} />退出
          </button>
        </header>

        {!ready ? (
          <section className="vocab-quiz-panel mt-6 text-sm" data-testid="recall-preparing">
            {prepareError ? (
              <div role="alert" className="vocab-wrap text-danger">{prepareError}</div>
            ) : (
              <p className="inline-flex items-center gap-2 text-mute"><Loader2 size={16} className="animate-spin" />正在准备题目（需要时会请模型写语境句）…</p>
            )}
          </section>
        ) : finished ? (
          <section className="vocab-quiz-panel mt-6" data-testid="recall-summary">
            <h2 className="vocab-quiz-summary-title">{questions.length === 0 ? '这一轮出不了题' : firstTest ? '本轮首考完成' : '本轮复习完成'}</h2>
            <div className="vocab-quiz-stats mt-4">
              <div className="vocab-quiz-stat" data-tone="correct"><div className="vocab-quiz-stat-num text-success" data-testid="recall-correct-count">{correctCount}</div><div className="vocab-quiz-stat-label">答对</div></div>
              <div className="vocab-quiz-stat" data-tone="wrong">
                <div className="vocab-quiz-stat-num text-danger" data-testid="recall-wrong-count">{saved.length - correctCount}</div>
                <div className="vocab-quiz-stat-label">答错{forgotSaved > 0 && <span data-testid="recall-forgot-count">（含忘记了 {forgotSaved}）</span>}</div>
              </div>
              <div className="vocab-quiz-stat"><div className="vocab-quiz-stat-num text-clay" data-testid="recall-flagged-count">{flaggedDone.length}</div><div className="vocab-quiz-stat-label">题目出错</div></div>
              <div className="vocab-quiz-stat"><div className="vocab-quiz-stat-num text-ink" data-testid="recall-skipped-count">{round.skipped.length}</div><div className="vocab-quiz-stat-label">缺数据跳过</div></div>
            </div>
            {left > 0 && (
              <p className="mt-3 text-sm text-mute" data-testid="recall-remaining">
                {firstTest
                  ? `这个范围还有 ${left} 个新词没轮到（每次最多 7 个），可以再开一轮。`
                  : `还有 ${left} 个到期词没轮到（每轮最多 8 个），可以再开一轮。`}
              </p>
            )}
            {notices}

            {round.skipped.length > 0 && (
              <div className="mt-6">
                <h3 className="vocab-quiz-h3">没出题的词</h3>
                <ul className="mt-2 space-y-2" data-testid="recall-skipped-list">
                  {round.skipped.map(entry => (
                    <li key={entry.wordId} className="vocab-wrap rounded-xl border border-line p-3 text-sm">
                      <span className="font-medium text-ink">{entry.word}</span>
                      <span className="ml-2 text-mute">{IS_MOBILE ? mobileReason(entry.reason) : entry.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {resultRows.length > 0 && (
              <div className="mt-6">
                <h3 className="vocab-quiz-h3">逐题结果</h3>
                <table className="vocab-grade-table mt-2 w-full text-sm" data-testid="recall-result-table">
                  <thead>
                    <tr className="text-left text-xs text-mute">
                      <th>词</th><th>你的答案</th><th>判定</th><th>目标形式</th><th>原因</th><th>状态变化</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resultRows.map(entry => {
                      const cells = rowCells(entry);
                      const canRecheck = entry.state.correct === false && !entry.state.flagged && entry.state.result !== null;
                      const recheck = rechecks[entry.index];
                      return (
                        <tr key={entry.question.wordId} data-testid="recall-result-row" data-word={entry.question.wordId}>
                          <td data-label="词" className="vocab-grade-word">
                            {entry.question.target}
                            {firstTest && previewed?.has(entry.question.wordId) && (
                              <span className="vocab-q-tag mt-1" data-testid="row-previewed">看过释义</span>
                            )}
                          </td>
                          <td data-label="你的答案" className="vocab-wrap">
                            {/* row-written 只包答案文字：老验收脚本按它的文字比对，「存为我的例句」放在它外面。 */}
                            <span data-testid="row-written">{cells.written}</span>
                            {(() => {
                              const sentence = reviewExampleSentence(entry.question, entry.state);
                              if (!sentence) return null;
                              const already = (myExamples.byKey.get(exampleKey(entry.question.target)) ?? []).some(example => exampleKey(example.sentence) === exampleKey(sentence));
                              const save = exampleSaves[entry.index];
                              return (
                                <span className="mt-1 block">
                                  {already ? (
                                    <span className="inline-flex items-center gap-1 text-xs text-success" data-testid="recall-example-saved"><Check size={12} />已存为我的例句</span>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => void saveAnswerAsExample(entry.index, sentence)}
                                      disabled={save?.busy}
                                      className="press inline-flex items-center gap-1 rounded-full border border-line bg-page px-3 py-1 text-xs text-ink disabled:opacity-40"
                                      data-testid="recall-save-example"
                                    >
                                      <BookmarkPlus size={12} />{save?.busy ? '正在保存…' : '存为我的例句'}
                                    </button>
                                  )}
                                  {save?.error && <span role="alert" className="mt-1 block text-xs text-danger">{save.error}</span>}
                                </span>
                              );
                            })()}
                          </td>
                          <td data-label="判定" className={`vocab-wrap font-semibold ${cells.tone}`} data-testid="row-verdict">{cells.verdict}</td>
                          <td data-label="目标形式" className="vocab-wrap font-semibold text-ink" data-testid="row-form">{cells.form}</td>
                          <td data-label="原因" className="vocab-wrap text-mute" data-testid="row-reason">{cells.reason}</td>
                          <td data-label="状态变化" className="vocab-wrap" data-testid="row-change">
                            {cells.change}
                            {canRecheck && (
                              <button
                                type="button"
                                onClick={() => void startRecheck(entry.index)}
                                disabled={recheck?.phase === 'preparing'}
                                className="press mt-1 inline-flex items-center gap-1 rounded-full border border-line bg-page px-3 py-1 text-xs text-ink disabled:opacity-40"
                                data-testid="recall-recheck"
                              >
                                <RotateCcw size={12} />{recheck ? '再换一个语境' : '换个语境再练'}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {(() => {
              // 正在复检作答（或准备复检题）的词不给例句入口，免得复检时先看到例句。
              const examWords = resultRows.filter(entry => {
                const recheck = rechecks[entry.index];
                return !(recheck && (recheck.phase === 'preparing' || recheck.phase === 'answer'));
              });
              if (examWords.length === 0) return null;
              return (
                <div className="mt-6" data-testid="recall-examples">
                  <h3 className="vocab-quiz-h3">我的例句</h3>
                  <p className="mt-1 text-xs text-mute">点开一个词：看已存的例句，或让 AI 给几句、自己写一句让 AI 改。</p>
                  {myExamples.error && <p role="alert" className="mt-2 text-xs text-danger">{myExamples.error}</p>}
                  <div className="mt-2 space-y-2">
                    {examWords.map(entry => {
                      const list = myExamples.byKey.get(exampleKey(entry.question.target)) ?? [];
                      return (
                        <details key={entry.question.wordId} className="vocab-candidate-notes rounded-xl border border-line p-3" data-testid="recall-example-entry" data-word={entry.question.wordId}>
                          <summary className="text-sm text-ink"><span className="font-semibold">{entry.question.target}</span><span className="ml-2 text-xs text-mute">我的例句（{list.length}）</span></summary>
                          <div className="mt-2">
                            <ExamplesSection
                              word={entry.question.target}
                              examples={list}
                              senses={sensesFrom([{ pos: entry.question.pos, english: entry.question.meaning, chinese: entry.question.chinese }])}
                              handlers={myExamples.handlers}
                              compact
                            />
                          </div>
                        </details>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {rechecksOpen.length > 0 && (
              <div className="mt-6 space-y-4" data-testid="recheck-list">
                {rechecksOpen.map(renderRecheck)}
              </div>
            )}
            <div className="mt-6 text-center">
              <button type="button" onClick={onExit} className={primary} data-testid="recall-finish"><Check size={16} />完成</button>
            </div>
          </section>
        ) : (
          <form onSubmit={event => void submitScreen(event)} className="mt-5 min-w-0" data-testid="recall-screen">
            {screen === 0 && notices}
            <p className="vocab-quiz-guide">
              {hasTasks && '这一轮有改写、造句题：按要求写一整句，必须用上目标词（近义词不算），由模型判分并给出「语法修正版 → 学术升级版」。'}
              {firstTest
                ? '看英文释义和语境句，在空格里填出目标词（按句子需要的词形），中文提示只作补充。想不起来就点「忘记了」：按答错计，提交后显示答案。首考答对记为已掌握，答错进入 L1 复习（按现有规则）。题目本身有问题，点「这题出错了」，这题就不计分。'
                : '看英文释义和语境句，在空格里填出目标词（按句子需要的词形），中文提示只作补充。想不起来就点「忘记了」：按答错计，提交后显示答案。题目本身有问题，点「这题出错了」，这题就不计分。'}
            </p>
            {IS_MOBILE && <p className="vocab-quiz-guide" data-testid="recall-save-note">点「保存」后这一屏才写入复习库，中途退出的这一屏不会保存。</p>}
            <div className="vocab-quiz-list">{current.map((index, position) => renderQuestion(index, position))}</div>

            <div className="vocab-quiz-footer">
              <p className="vocab-quiz-footer-note">{IS_MOBILE ? '' : 'Esc 退出 · Tab / 回车 换到下一题。'}点「保存」后这一屏才写入复习库，中途退出的这一屏不会保存。</p>
              <div className="flex flex-wrap items-center justify-end gap-3">
                {phase === 'write' ? (
                  <>
                    {forgotCount > 0 && <span className="text-xs text-danger" data-testid="recall-forgot-pending">{forgotCount} 题选了「忘记了」</span>}
                    {blanks > 0 && <span className="text-xs text-mute" data-testid="recall-blank-note">还有 {blanks} 题没写，提交后按答错计</span>}
                    <button ref={submitRef} type="submit" className={`${primary} vocab-quiz-cta`} data-testid="recall-submit">提交这一屏</button>
                  </>
                ) : (
                  <button type="button" onClick={() => void next()} disabled={!ready2Commit || committing} className={`${primary} vocab-quiz-cta`} data-testid="recall-next">
                    {committing ? '正在保存…' : isLast ? <>保存并查看结果</> : <>保存并下一屏<ArrowRight size={16} /></>}
                  </button>
                )}
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
    </Lookable>
  );
}
