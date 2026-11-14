import { findTargetForms, isTargetForm, normalizeRecallAnswer } from './recall';
import type { RecallQuestion } from './recall';
import { statusLabel } from './library';

/**
 * 判分（031）。纯函数，不依赖 Tauri。
 *
 * - 回忆填空由程序判：大小写、首尾空格、句末标点不算错；只差一个字母给「可能是笔误」，由用户决定；其他拼写差异判错。
 * - 改写/造句（句型题）交给模型判；没用上目标表达的，语法再对也算「未完成」。
 * - 没配模型、或模型出错时退回用户自评（界面负责）。
 */

export type GradeVerdict = 'correct' | 'wrong' | 'incomplete';

/** 程序判填空的结果；typo = 只差一个字母，等用户申诉。 */
export interface SpellingGrade {
  kind: 'correct' | 'wrong' | 'typo';
  /** 中文原因，给逐题结果表用。 */
  reason: string;
  /** 目标形式：语境句里应该填的词形。 */
  expected: string;
}

/** 两个字符串的编辑距离（插入、删除、替换各算 1）。 */
export function editDistance(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[right.length];
}

export function gradeSpelling(question: Pick<RecallQuestion, 'answers' | 'target'>, written: string): SpellingGrade {
  const expected = question.answers[0] ?? question.target;
  const normalized = normalizeRecallAnswer(written);
  if (normalized.length === 0) return { kind: 'wrong', reason: '没作答', expected };
  const expectedNorm = normalizeRecallAnswer(expected);
  if (question.answers.some(answer => normalizeRecallAnswer(answer) === normalized)) {
    return { kind: 'correct', reason: normalized === expectedNorm && written.trim() !== expected ? '与答案一致（大小写不计）' : '与答案一致', expected };
  }
  // 写成了目标词的另一个词形（allocate / allocated）：这是词形错，不是笔误。
  if (isTargetForm(written, question.target)) {
    return { kind: 'wrong', reason: `词形不对：这句需要 ${expected}，不是 ${written.trim()}`, expected };
  }
  const distances = question.answers.map(answer => editDistance(normalizeRecallAnswer(answer), normalized));
  const near = question.answers.some((answer, index) => normalizeRecallAnswer(answer).length >= 3 && distances[index] === 1);
  if (near) return { kind: 'typo', reason: `只差一个字母，可能是笔误（应为 ${expected}）`, expected };
  // 只差一两个字母还算拼写问题；差得远多半是写了近义词（reduce 对 mitigate），别归因成「拼写不同」。
  if (Math.min(...distances) <= 2) return { kind: 'wrong', reason: `拼写与答案不同（应为 ${expected}）`, expected };
  return { kind: 'wrong', reason: `答案不是目标词（应为 ${expected}）`, expected };
}

// ---------------------------------------------------------------- 模型判分

export interface ModelGrade {
  usedTarget: boolean;
  grammarOk: boolean;
  verdict: GradeVerdict;
  /** 中文原因。 */
  reason: string;
  /** 用户用的（或应该用的）目标形式。 */
  targetForm: string;
  grammarFix: string;
  academicUpgrade: string;
  /** 038 改写/造句：改写是否保留原句意思、造句是否满足情境要求。只有这两种题才有。 */
  taskOk?: boolean;
}

const malformed = (): Error => new Error('模型返回格式不正确：需要 {"usedTarget":…,"grammarOk":…,"verdict":"correct|wrong|incomplete","reason":"…"}。');
const MAX_FIELD = 600;

/** 只认完整 JSON 或完整 Markdown 代码块。 */
export function parseGrade(content: string): ModelGrade {
  const fenced = content.match(/^\s*```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?\s*```\s*$/i);
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1] : content); } catch { throw malformed(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed();
  const raw = value as Record<string, unknown>;
  const text = (key: string): string => {
    const field = raw[key];
    if (field === undefined || field === null) return '';
    if (typeof field !== 'string' || field.length > MAX_FIELD) throw malformed();
    return field.trim();
  };
  if (typeof raw.usedTarget !== 'boolean' || typeof raw.grammarOk !== 'boolean') throw malformed();
  const verdict = raw.verdict;
  if (verdict !== 'correct' && verdict !== 'wrong' && verdict !== 'incomplete') throw malformed();
  const reason = text('reason');
  if (reason.length === 0) throw malformed();
  if (raw.taskOk !== undefined && raw.taskOk !== null && typeof raw.taskOk !== 'boolean') throw malformed();
  const grade: ModelGrade = {
    usedTarget: raw.usedTarget,
    grammarOk: raw.grammarOk,
    verdict,
    reason,
    targetForm: text('targetForm'),
    grammarFix: text('grammarFix'),
    academicUpgrade: text('academicUpgrade'),
  };
  if (typeof raw.taskOk === 'boolean') grade.taskOk = raw.taskOk;
  return grade;
}

/** 判分要用到的题目信息；task 只有改写/造句题才有。 */
export type GradableQuestion = Pick<RecallQuestion, 'target' | 'meaning' | 'kind'> & Partial<Pick<RecallQuestion, 'format' | 'task'>>;

/**
 * 改写/造句题（038）要求模型必须给出 taskOk、语法修正版和学术升级版；缺了就当判分失败（界面退回自评），
 * 不拿半截结果算分。其他题型原样返回。
 */
export function requireTaskFields(question: GradableQuestion, grade: ModelGrade): ModelGrade {
  if (!question.task) return grade;
  if (typeof grade.taskOk !== 'boolean' || !grade.grammarFix || !grade.academicUpgrade) {
    throw new Error('模型返回格式不正确：改写/造句题缺少「是否完成要求」的判定、语法修正版或学术升级版。');
  }
  return grade;
}

/** 判分提示词。导出供测试核对。 */
export function buildGradingPrompt(question: GradableQuestion, written: string): string {
  if (question.task) return buildTaskGradingPrompt(question, question.task, written);
  return `You grade ONE sentence written by a Chinese university student learning academic English (EAP).
The student was asked to write a sentence that USES the target expression below.

Target expression: ${JSON.stringify(question.target)}
Meaning: ${JSON.stringify(question.meaning)}
Student's sentence: ${JSON.stringify(written)}

Rules:
- "usedTarget": true only if the sentence really uses the target expression (any grammatical form of it is fine). A near-synonym or a paraphrase is NOT the target. Mentioning it inside quotes without using it does not count.
- "grammarOk": true if the sentence is grammatical enough to be understood and has no clear grammar error.
- "verdict": "correct" if usedTarget and grammarOk; "incomplete" if grammarOk but the target expression was not used; "wrong" otherwise (target used but with a wrong meaning/usage/grammar, or both missing).
- "reason": one short sentence in Chinese saying what is right or wrong. Do not praise vaguely.
- "targetForm": the form of the target the student used, or the form that should be used.
- "grammarFix": the sentence with grammar corrected (keep the student's meaning); empty string if nothing to fix.
- "academicUpgrade": a more academic rewrite that still uses the target; empty string if not needed.

Return only one JSON object, no Markdown, exactly in this shape:
{"usedTarget":true,"grammarOk":true,"verdict":"correct","reason":"…","targetForm":"…","grammarFix":"…","academicUpgrade":"…"}`;
}

/**
 * 改写/造句题的判分提示词（038）：比句型题多给原句/情境要求，多判一项 taskOk，
 * 并且一定要给「语法修正版 → 学术升级版」两层，都要保留学生原意。
 */
function buildTaskGradingPrompt(question: GradableQuestion, task: NonNullable<RecallQuestion['task']>, written: string): string {
  const paraphrase = question.format === 'paraphrase';
  const taskLines = paraphrase
    ? `Task type: paraphrase. The student had to rewrite the original sentence using the target expression, keeping its meaning.
Instruction shown to the student: ${JSON.stringify(task.instruction)}
Original sentence: ${JSON.stringify(task.original)}`
    : `Task type: compose. The student had to write ONE new sentence using the target expression in the given situation.
Instruction shown to the student: ${JSON.stringify(task.instruction)}`;
  const taskRule = paraphrase
    ? '- "taskOk": true only if the rewrite keeps the meaning of the original sentence (small changes of wording are fine; adding, dropping or reversing the main idea is not). Copying the original unchanged is false.'
    : '- "taskOk": true only if the sentence fits the situation and obeys every constraint in the instruction (subject, tense, structure, number of items, etc.).';
  return `You grade ONE answer written by a Chinese university student learning academic English (EAP). Be strict and concrete.

Target expression: ${JSON.stringify(question.target)}
Meaning: ${JSON.stringify(question.meaning)}
${taskLines}
Student's answer: ${JSON.stringify(written)}

Rules:
- "usedTarget": true only if the answer really uses the target expression (any grammatical form of it is fine). A near-synonym, a paraphrase, or a word from the same family with a different part of speech is NOT the target. Mentioning it inside quotes without using it does not count.
- Check the usage carefully: the target must be used in the given meaning with a correct structure and collocation (e.g. "comprise" means the whole consists of the parts: "The course comprises six modules", not "Six modules comprise of the course").
- "grammarOk": true if the answer has no clear grammar error.
${taskRule}
- "verdict": "incomplete" if the target was not used (even if everything else is good); "correct" only if usedTarget, grammarOk and taskOk are all true and the usage is right; otherwise "wrong".
- "reason": one or two short sentences in Chinese: what is right or wrong about the target usage and any clear grammar error. Do not praise vaguely.
- "targetForm": the form of the target the student used, or the form that should be used.
- "grammarFix": the student's answer with only grammar and target-usage errors corrected, keeping the student's own meaning and wording as far as possible; if nothing needs fixing, repeat the answer unchanged. Never empty.
- "academicUpgrade": a more academic, more specific version of the student's sentence that uses the target correctly and keeps the student's meaning. Never empty.

Return only one JSON object, no Markdown, exactly in this shape:
{"usedTarget":true,"grammarOk":true,"taskOk":true,"verdict":"correct","reason":"…","targetForm":"…","grammarFix":"…","academicUpgrade":"…"}`;
}

/** 目标里有 X 或省略号的是句型模板，本地认不出它的用法，交给模型；其余目标本地再核一遍有没有出现。 */
const isPattern = (target: string) => target.includes('X') || target.includes('…');

/**
 * 把模型的原始判定收紧成最终判定：
 * 没用上目标表达 → 一律「未完成」，即使语法对、即使模型自己写了 correct；
 * 普通词/短语还要本地核对用户的句子里真有目标词形，模型说用了但文字里根本没有的，也按没用上算。
 */
export function finalizeGrade(question: Pick<RecallQuestion, 'target'>, written: string, raw: ModelGrade): ModelGrade {
  let used = raw.usedTarget;
  if (used && !isPattern(question.target) && findTargetForms(written, question.target).length === 0) used = false;
  if (!used) {
    return { ...raw, usedTarget: false, verdict: 'incomplete', reason: raw.verdict === 'incomplete' || !raw.reason ? raw.reason : `没有用上目标表达 ${question.target}，这题算未完成。${raw.reason}` };
  }
  if (!raw.grammarOk) return { ...raw, verdict: 'wrong' };
  // 038：改写没保留原意、造句没按情境要求，用上了目标词也算错。
  if (raw.taskOk === false) return { ...raw, verdict: 'wrong' };
  if (raw.verdict !== 'correct') return { ...raw, verdict: 'wrong' };
  return raw;
}

/** 状态变化的一行说明：L3 → L1，到期 11-11；状态只显示文字（待考察 → 已掌握），不带表情。 */
export function describeChange(
  before: { status: string; due: string } | undefined,
  after: { status: string; due: string; changed: boolean },
): string {
  const shortDue = (due: string) => (due ? due.slice(5) : '');
  const to = after.due ? `${statusLabel(after.status)}，到期 ${shortDue(after.due)}` : statusLabel(after.status);
  if (!after.changed) return `不变（今天已计入，不再升级）：${to}`;
  return before ? `${statusLabel(before.status)} → ${to}` : to;
}
