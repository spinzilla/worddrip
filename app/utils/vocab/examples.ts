import type { BrowseDefinition, ExampleSource, VocabExample } from './types';
import { normalizeText } from './library';
import { findTargetForms } from './recall';
import type { RecallQuestion } from './recall';
import { buildGradingPrompt } from './grading';
import type { GradableQuestion, GradeVerdict, ModelGrade } from './grading';
import { gradeWithModel } from './gradingModel';
import { postChat } from './recallModel';

/**
 * 043 我的例句：纯函数 + 两个模型请求（测试：node test-vocab-examples.mjs）。
 *
 * - 例句按词挂：键 = normalizeText(词)，和 040 笔记、后端 `vocab/examples.rs` 一致。
 * - 「AI 给例句」：只发词、词性、所选义项的英文/中文释义；不发笔记、复习备注、已存的例句。
 * - 「自己写让 AI 改」：直接复用 038 造句题的判分（同一份提示词 buildGradingPrompt、同一套解析和收紧规则
 *   parseGrade → requireTaskFields → finalizeGrade，经 gradeWithModel 调用），只是把「情境要求」换成「用这个义项随便写一句」。
 *   所以「用法对不对」「改好的句子（只改必须改的）」「更地道的说法」的口径和造句题判分完全一样。
 */

export const exampleKey = (word: string) => normalizeText(word);

// ---------------------------------------------------------------- 列表

/** 新的在前；同一时刻按 ID 倒序。不改原数组。 */
export function sortExamples(examples: readonly VocabExample[]): VocabExample[] {
  return [...examples].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id));
}

/** 按词分组，组内新的在前。 */
export function groupExamples(examples: readonly VocabExample[]): Map<string, VocabExample[]> {
  const map = new Map<string, VocabExample[]>();
  for (const example of sortExamples(examples)) {
    const list = map.get(example.wordKey);
    if (list) list.push(example);
    else map.set(example.wordKey, [example]);
  }
  return map;
}

export function addExamplesTo(examples: readonly VocabExample[], added: readonly VocabExample[]): VocabExample[] {
  const ids = new Set(added.map(item => item.id));
  return [...added, ...examples.filter(item => !ids.has(item.id))];
}

export function removeExample(examples: readonly VocabExample[], id: number): VocabExample[] {
  return examples.filter(item => item.id !== id);
}

/** 改完广播一声：词库页、闪卡、复习结果页各自重读。node 测试里没有 window 就什么都不做。 */
const EXAMPLES_CHANGED = 'vocab-examples-changed';
export function notifyExamplesChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EXAMPLES_CHANGED));
}
export function onExamplesChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EXAMPLES_CHANGED, listener);
  return () => window.removeEventListener(EXAMPLES_CHANGED, listener);
}

// ---------------------------------------------------------------- 义项

/** 一个义项：生成例句和判断句子时只发这三样。 */
export interface ExampleSense {
  pos: string;
  english: string;
  chinese: string;
}

/**
 * 这个词可选的义项：先用导入的英英释义（去重）；没有时用词性 + 中文意思兜底；都没有就给一个空义项（只按词本身）。
 */
export function sensesFrom(
  definitions: readonly Pick<BrowseDefinition, 'pos' | 'english' | 'chinese'>[],
  fallback: { pos?: string; gloss?: string } = {},
): ExampleSense[] {
  const seen = new Set<string>();
  const senses: ExampleSense[] = [];
  for (const definition of definitions) {
    const sense = { pos: definition.pos.trim(), english: definition.english.trim(), chinese: definition.chinese.trim() };
    if (!sense.english && !sense.chinese) continue;
    const key = `${sense.pos}|${sense.english}|${sense.chinese}`;
    if (seen.has(key)) continue;
    seen.add(key);
    senses.push(sense);
  }
  if (senses.length > 0) return senses;
  return [{ pos: (fallback.pos ?? '').trim(), english: '', chinese: (fallback.gloss ?? '').trim() }];
}

/** 下拉框和「义项」一栏显示的文字，例如「adj. able to recover quickly（有韧性的）」。空义项返回空串。 */
export function senseLabel(sense: ExampleSense): string {
  const main = [sense.pos, sense.english].filter(Boolean).join(' ');
  if (main && sense.chinese) return `${main}（${sense.chinese}）`;
  return main || sense.chinese;
}

/** 发给判分提示词的 meaning：英文释义优先，带上词性和中文。 */
function senseMeaning(sense: ExampleSense): string {
  const parts = [sense.pos ? `(${sense.pos})` : '', sense.english, sense.chinese ? (sense.english ? `[Chinese: ${sense.chinese}]` : sense.chinese) : ''];
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------- AI 给例句

export interface GeneratedExample {
  sentence: string;
  /** 这句展示的搭配或结构，例如 exacerbate the problem；可能为空。 */
  collocation: string;
  /** 中文翻译；可能为空。 */
  chinese: string;
}

export const EXAMPLE_COUNT = 3;
const MAX_FIELD = 600;

/** 生成例句的提示词。导出供测试核对：只有词、词性、所选义项，不含笔记、备注。 */
export function buildExamplePrompt(word: string, sense: ExampleSense): string {
  const item = {
    target: word.trim(),
    pos: sense.pos || undefined,
    meaning: sense.english || undefined,
    chinese: sense.chinese || undefined,
  };
  return `You write example sentences for a Chinese university student learning academic English (EAP).

Write ${EXAMPLE_COUNT} natural English example sentences that use the target expression below.
- Use the target in the sense given by "meaning" / "chinese" (if provided) and only in that sense.
- Each sentence: 10-25 words, set in an academic or campus situation (lectures, essays, research, group projects, student life).
- Use the target at least once, in whatever grammatical form fits. Use only common, well-attested collocations; never invent unusual "advanced" ones.
- Where possible, let the sentences show different common collocations or structures of the target.
- "collocation": the collocation or structure the sentence shows, e.g. "exacerbate the problem".
- "chinese": a short, natural Chinese translation of the sentence.

Expression:
${JSON.stringify(item, null, 2)}

Return only one JSON object, no Markdown, exactly in this shape:
{"examples":[{"sentence":"...","collocation":"...","chinese":"..."}]}`;
}

const examplesMalformed = (): Error => new Error('模型返回格式不正确：需要 {"examples":[{"sentence":"…","collocation":"…","chinese":"…"}]}。');

/** 目标里有 X 或省略号的是句型模板，本地认不出它的用法，不做「用没用上」的检查。 */
const isPattern = (target: string) => target.includes('X') || target.includes('…');

/** 句子里真的用上了目标词（任意词形）。 */
export function usesTarget(sentence: string, word: string): boolean {
  return isPattern(word) || findTargetForms(sentence, word).length > 0;
}

/**
 * 只认完整 JSON 或完整 Markdown 代码块。格式不对抛中文错误；
 * 没用上目标词的句子、重复的句子去掉，一句都不剩也抛中文错误。
 */
export function parseGeneratedExamples(content: string, word: string): GeneratedExample[] {
  const fenced = content.match(/^\s*```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?\s*```\s*$/i);
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1] : content); } catch { throw examplesMalformed(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw examplesMalformed();
  const list = (value as { examples?: unknown }).examples;
  if (!Array.isArray(list) || list.length === 0 || list.length > 10) throw examplesMalformed();
  const parsed = list.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw examplesMalformed();
    const raw = item as Record<string, unknown>;
    const field = (key: string, required: boolean): string => {
      const text = raw[key] ?? '';
      if (typeof text !== 'string' || text.length > MAX_FIELD || (required && !text.trim())) throw examplesMalformed();
      return text.replace(/\s+/g, ' ').trim();
    };
    return { sentence: field('sentence', true), collocation: field('collocation', false), chinese: field('chinese', false) };
  });
  const seen = new Set<string>();
  const kept = parsed.filter(example => {
    const key = normalizeText(example.sentence);
    if (seen.has(key) || !usesTarget(example.sentence, word)) return false;
    seen.add(key);
    return true;
  });
  if (kept.length === 0) throw new Error(`模型给的例句都没用上「${word.trim()}」，请再试一次。`);
  return kept;
}

/** 存 AI 例句时的说明：搭配 + 中文翻译。 */
export function generatedExplanation(example: GeneratedExample): string {
  return [example.collocation && `搭配：${example.collocation}`, example.chinese && `译：${example.chinese}`].filter(Boolean).join('；');
}

export async function requestExamples(word: string, sense: ExampleSense, options: { timeoutMs?: number } = {}): Promise<GeneratedExample[]> {
  const content = await postChat(buildExamplePrompt(word, sense), options.timeoutMs);
  return parseGeneratedExamples(content, word);
}

// ---------------------------------------------------------------- 自己写让 AI 改（复用 038 造句判分）

/** 当成一道「没有额外情境限制」的造句题交给 038 的判分。 */
export const OWN_SENTENCE_INSTRUCTION = 'Write one sentence of your own that uses the target expression in the meaning given above. Any academic, campus or everyday situation is fine; there are no other constraints.';

export function ownSentenceQuestion(word: string, sense: ExampleSense): GradableQuestion & { task: NonNullable<RecallQuestion['task']> } {
  return {
    target: word.trim(),
    meaning: senseMeaning(sense),
    kind: 'sentence',
    format: 'compose',
    task: { instruction: OWN_SENTENCE_INSTRUCTION, original: '', reference: '' },
  };
}

/** 改句的提示词 = 038 造句题判分提示词（导出供测试核对两者一字不差）。 */
export function buildCheckPrompt(word: string, sense: ExampleSense, written: string): string {
  return buildGradingPrompt(ownSentenceQuestion(word, sense), written);
}

export interface SentenceCheck {
  verdict: GradeVerdict;
  /** 判定一句话：用法正确 / 没用上这个词 / 用法或语法有问题。 */
  label: string;
  /** 模型给的中文说明。 */
  reason: string;
  /** 改好的句子（只改必须改的地方）；没要改的就是原句。 */
  fixed: string;
  /** 改后和原句不一样（大小写、空白不算）。 */
  changed: boolean;
  /** 更地道/更学术的说法；和改后一样时为空串。 */
  better: string;
}

export const CHECK_LABEL: Record<GradeVerdict, string> = {
  correct: '用法正确',
  incomplete: '没用上这个词',
  wrong: '用法或语法有问题',
};

/** 把 038 的判分结果翻成改句界面要的样子。 */
export function sentenceCheckFrom(written: string, grade: ModelGrade): SentenceCheck {
  const original = written.replace(/\s+/g, ' ').trim();
  const fixed = (grade.grammarFix || original).replace(/\s+/g, ' ').trim();
  const better = grade.academicUpgrade.replace(/\s+/g, ' ').trim();
  return {
    verdict: grade.verdict,
    label: CHECK_LABEL[grade.verdict],
    reason: grade.reason,
    fixed,
    changed: normalizeText(fixed) !== normalizeText(original),
    better: better && normalizeText(better) !== normalizeText(fixed) && normalizeText(better) !== normalizeText(original) ? better : '',
  };
}

export const MAX_OWN_SENTENCE = MAX_FIELD;

/** 判断用户自己写的一句。没配模型、断网、格式不对都抛中文错误（和造句题判分同一套报错）。 */
export async function checkOwnSentence(word: string, sense: ExampleSense, written: string, options: { timeoutMs?: number } = {}): Promise<SentenceCheck> {
  const text = written.replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('先写一句再让 AI 看。');
  if (text.length > MAX_OWN_SENTENCE) throw new Error(`句子太长了（超过 ${MAX_OWN_SENTENCE} 字），只写一句就好。`);
  const grade = await gradeWithModel(ownSentenceQuestion(word, sense), text, options);
  return sentenceCheckFrom(text, grade);
}

// ---------------------------------------------------------------- 复习结果页「存为我的例句」

/**
 * 复习结果页：判分通过（答对）的改写/造句答案可以存成「自己写」的例句。
 * 填空、句型、答错、忘记了、标了「这题出错了」的都不行。返回要存的句子，不能存返回 null。
 */
export function reviewExampleSentence(
  question: Pick<RecallQuestion, 'format' | 'task'>,
  state: { written: string; correct: boolean | null; flagged: boolean; grade: { kind: string } | null },
): string | null {
  if (!question.task || (question.format !== 'paraphrase' && question.format !== 'compose')) return null;
  if (state.correct !== true || state.flagged || state.grade?.kind === 'forgot') return null;
  const sentence = state.written.replace(/\s+/g, ' ').trim();
  return sentence || null;
}

/** 来源的显示文字。 */
export const SOURCE_HINT: Record<ExampleSource, string> = {
  AI生成: 'AI 按意思给的',
  自己写: '自己写的',
  AI改过: 'AI 改过的',
};
