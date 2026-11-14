import { gradeSpelling } from './grading';
import type { ModelGrade } from './grading';
import { gradeWithModel } from './gradingModel';
import type { RecallQuestion } from './recall';
import type { ReviewSubmitRequest } from './types';

/**
 * 把「一道题 + 用户答案」变成可显示、可写库的判定（031）。
 * correct = null 表示还要用户来定：笔误申诉，或没配模型/模型失败时的自评。
 */

export interface Grade {
  /** program = 程序判拼写；model = 模型判；self = 用户自评。 */
  origin: 'program' | 'model' | 'self';
  /** typo = 只差一个字母等用户申诉；manual = 要用户自评；forgot = 用户点了「忘记了」（按答错计）。 */
  kind: 'correct' | 'wrong' | 'incomplete' | 'typo' | 'manual' | 'forgot';
  reason: string;
  /** 目标形式。 */
  expected: string;
  model: ModelGrade | null;
}

export interface Evaluation {
  grade: Grade;
  correct: boolean | null;
}

export interface EvaluateOptions {
  /** 设置里配好了模型。 */
  modelOn: boolean;
  /** 测试可注入；默认走真实模型客户端。 */
  grader?: typeof gradeWithModel;
  /** 用户点了「忘记了」：不看写了什么、不请求模型，直接按答错计。 */
  forgot?: boolean;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * 036「忘记了」：和写错完全一样记（correct = false），只是原因写明是自己点的。
 * 不是跳过、不是不计分；写回复习库时和答错走同一条路（见 submitRequest）。
 */
export function forgotEvaluation(question: Pick<RecallQuestion, 'answers' | 'target' | 'selfCheck'>): Evaluation {
  const expected = question.selfCheck ? question.target : question.answers[0] ?? question.target;
  return {
    grade: { origin: 'self', kind: 'forgot', reason: '你点了「忘记了」：和答错一样记录，可以在结果页换个语境再练。', expected, model: null },
    correct: false,
  };
}

export async function evaluateAnswer(question: RecallQuestion, written: string, options: EvaluateOptions): Promise<Evaluation> {
  if (options.forgot) return forgotEvaluation(question);
  if (!question.selfCheck) {
    const spelling = gradeSpelling(question, written);
    const grade: Grade = { origin: 'program', kind: spelling.kind, reason: spelling.reason, expected: spelling.expected, model: null };
    return { grade, correct: spelling.kind === 'typo' ? null : spelling.kind === 'correct' };
  }

  const expected = question.target;
  if (written.trim().length === 0) {
    return { grade: { origin: 'program', kind: 'wrong', reason: '没作答', expected, model: null }, correct: false };
  }
  if (!options.modelOn) {
    return { grade: { origin: 'self', kind: 'manual', reason: '没配置模型，对照答案自评。', expected, model: null }, correct: null };
  }
  try {
    const model = await (options.grader ?? gradeWithModel)(question, written);
    const kind = model.verdict;
    return { grade: { origin: 'model', kind, reason: model.reason, expected: model.targetForm || expected, model }, correct: kind === 'correct' };
  } catch (error) {
    // 格式错误的报错里带着 JSON 结构说明，对用户没用，界面上只说「格式不正确」。
    const why = errorText(error).replace(/：需要 \{[\s\S]*\}。$/u, '');
    return {
      grade: { origin: 'self', kind: 'manual', reason: `模型判分失败（${why}），改为对照答案自评。`, expected, model: null },
      correct: null,
    };
  }
}

export const VERDICT_LABEL: Record<Grade['kind'], string> = {
  correct: '答对',
  wrong: '答错',
  incomplete: '未完成（没用上目标表达）',
  typo: '可能是笔误',
  manual: '待自评',
  forgot: '忘记了（按答错计）',
};

/**
 * 一道题判定之后写回复习库的请求。correct 还没定（笔误申诉、待自评）时返回 null，不能保存。
 * 「忘记了」和答错得到的请求完全相同：同一个 kind（recall/rewrite/sentence）、correct = false。
 * 只有首考前看过释义才传 previewed = true；其他调用保持旧请求形状。
 */
export function submitRequest(question: Pick<RecallQuestion, 'wordId' | 'kind'>, evaluation: Pick<Evaluation, 'correct'>, previewed = false): ReviewSubmitRequest | null {
  if (evaluation.correct === null) return null;
  return { id: question.wordId, kind: question.kind, correct: evaluation.correct, ...(previewed ? { previewed: true } : {}) };
}
