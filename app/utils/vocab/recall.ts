import type { BrowseDefinition, ReviewKind } from './types';

/**
 * 复习出题（030）。
 *
 * 出题顺序：词库现成例句 → 模型现写语境句 → 只有英文释义的兜底题 → 缺数据跳过。
 * 题面只用英文释义、语境句和首字母提示；中文释义只作补充；复习备注（混着复习历史）不再上题面。
 * 防泄题全部在本地做：语境句里的目标词（含常见变形）挖成空，释义/中文里的同族词遮掉，
 * 模型写的句子要恰好有一个 [[目标词]] 标记、标记外不许出现同族词，否则不用。
 *
 * 本文件不依赖 Tauri，031 判分、032 新词首考可以直接复用 QuestionWord / RecallQuestion / prepareRecallRound。
 */

/** 一轮最多出几个到期词（最逾期优先）。 */
export const RECALL_LIMIT = 8;
/** 每屏最多几题。 */
export const SCREEN_LIMIT = 5;
/** 释义、中文、语境里被遮住的同族词。 */
export const LEAK_MASK = '___';

export type RecallKind = Exclude<ReviewKind, 'choice'>;

/** 单词和不超过 4 词的短语自动判定；长句、X 占位和省略号句型由用户自评。 */
export function recallKind(text: string): RecallKind {
  const word = text.trim();
  const count = word.length === 0 ? 0 : word.split(/\s+/u).length;
  if (count > 4 || word.includes('X') || word.includes('…')) return 'sentence';
  return count > 1 ? 'rewrite' : 'recall';
}

/** 只忽略首尾空白、大小写、连续空白和句末标点；其他拼写差异都保留。 */
export function normalizeRecallAnswer(text: string): string {
  return text
    .trim()
    .replace(/[.!?。！？]+$/u, '')
    .trimEnd()
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

export function recallAnswerMatches(expected: string, written: string): boolean {
  return normalizeRecallAnswer(expected) === normalizeRecallAnswer(written);
}

// ---------------------------------------------------------------- 词形与防泄题

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 一个英文词的常见屈折变形（复数、三单、过去式、-ing、比较级）。不认不规则变化。 */
export function inflections(token: string): string[] {
  const t = token.toLowerCase();
  if (!/^[a-z]{2,}$/u.test(t)) return [t];
  const out = new Set([t, `${t}s`, `${t}es`, `${t}ed`, `${t}ing`, `${t}er`, `${t}est`]);
  if (t.endsWith('e')) {
    const stem = t.slice(0, -1);
    out.add(`${t}d`).add(`${t}r`).add(`${t}st`).add(`${stem}ing`);
  }
  if (/[^aeiou]y$/u.test(t)) {
    const stem = t.slice(0, -1);
    for (const end of ['ies', 'ied', 'ier', 'iest']) out.add(stem + end);
  }
  if (/[^aeiou][aeiou][bdgklmnprt]$/u.test(t)) {
    const doubled = t + t[t.length - 1];
    for (const end of ['ed', 'ing', 'er']) out.add(doubled + end);
  }
  return [...out];
}

/** 目标词（短语逐词）允许变形的正则主体，不含边界。 */
function formsSource(target: string): string {
  return target.trim().split(/\s+/u)
    .map(token => `(?:${inflections(token).sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})`)
    .join('\\s+');
}

function boundaryRegex(target: string, flags: string): RegExp | null {
  const word = target.trim();
  if (word.length === 0) return null;
  const left = /^[A-Za-z0-9]/u.test(word) ? '(?<![A-Za-z0-9])' : '';
  const right = /[A-Za-z0-9]$/u.test(word) ? '(?![A-Za-z0-9])' : '';
  return new RegExp(`${left}${formsSource(word)}${right}`, flags);
}

export interface FormHit {
  index: number;
  text: string;
}

/** 在文本里找目标词及其屈折变形（整词匹配、不分大小写；apple 不会命中 pineapple）。 */
export function findTargetForms(text: string, target: string): FormHit[] {
  const re = boundaryRegex(target, 'giu');
  if (re === null) return [];
  return [...text.matchAll(re)].map(match => ({ index: match.index ?? 0, text: match[0] }));
}

/** 整段文字是不是目标词的某个变形（模型标记里的词、用户答案都可以用它查）。 */
export function isTargetForm(text: string, target: string): boolean {
  if (target.trim().length === 0) return false;
  return new RegExp(`^${formsSource(target)}$`, 'iu').test(text.trim().replace(/\s+/gu, ' '));
}

/** 单词目标的「同族词根」：6 个字母以上取前 max(5, 长度-2) 个字母，evaluate → evalua，能抓到 evaluation。 */
function familyRoot(target: string): string | null {
  const t = target.trim().toLowerCase();
  if (!/^[a-z]{6,}$/u.test(t)) return null;
  return t.slice(0, Math.max(5, t.length - 2));
}

/** 文本里会泄题的词：目标词的变形，以及（单词目标）同词根的派生词。 */
export function findLeaks(text: string, target: string): string[] {
  const hits = new Set(findTargetForms(text, target).map(hit => hit.text));
  const root = familyRoot(target);
  if (root !== null) {
    for (const match of text.matchAll(/[A-Za-z]+/gu)) {
      if (match[0].toLowerCase().startsWith(root)) hits.add(match[0]);
    }
  }
  return [...hits];
}

/** 把会泄题的词换成 ___；用于释义、中文和现成例句里挖空以外的部分。 */
export function maskLeaks(text: string, target: string): string {
  const re = boundaryRegex(target, 'giu');
  let masked = re === null ? text : text.replace(re, LEAK_MASK);
  const root = familyRoot(target);
  if (root !== null) {
    masked = masked.replace(/[A-Za-z]+/gu, word => (word.toLowerCase().startsWith(root) ? LEAK_MASK : word));
  }
  return masked;
}

/** 首字母提示：每个英文词只留首字母，其余字母换成下划线；词数、字母数由提示本身给出，不会写错。 */
export function letterHint(answer: string): string {
  return answer.trim().replace(/\s+/gu, ' ').replace(/[A-Za-z]+/gu, word => word[0] + '_'.repeat(word.length - 1));
}

/** 提示旁边的文字说明：单词说字母数，短语说词数。 */
export function hintLabel(answer: string): string {
  const words = answer.trim().split(/\s+/u).filter(Boolean);
  if (words.length > 1) return `${words.length} 个词`;
  return `${(words[0] ?? '').replace(/[^A-Za-z]/gu, '').length} 个字母`;
}

// ---------------------------------------------------------------- 题目结构

/** 出题需要的最少词条信息：到期复习词、新词首考的词都能直接传进来。 */
export interface QuestionWord {
  id: string;
  word: string;
  definitions: readonly BrowseDefinition[];
}

/** example = 词库现成例句；model = 模型现写（语境句或改写/造句要求）；definition = 只有英文释义（缺语境的兜底）。 */
export type QuestionSource = 'example' | 'model' | 'definition';

/**
 * 题型（038）：fill = 看释义填空（含短语、句型）；paraphrase = 用目标词改写一句话；compose = 按情境用目标词造句。
 * 三种都是产出题，写回复习库时分别记 recall/rewrite/sentence（句型填空沿用 sentence），升级规则完全一样。
 */
export type QuestionFormat = 'fill' | 'paraphrase' | 'compose';

/** 改写/造句题的要求（模型出、本地校验过）。 */
export interface UsageTask {
  /** 英文要求。改写题不含目标词（只说词性、语域和意思）；造句题必须写出目标词。 */
  instruction: string;
  /** 改写题要改写的原句（不含目标词及同族词）；造句题为空串。 */
  original: string;
  /** 模型给的参考答案（已去掉 [[ ]] 标记），判完分才显示。 */
  reference: string;
}

export interface RecallContext {
  /** 空格前后的句子；已遮掉同族词。 */
  before: string;
  after: string;
  /** 这句是 AI 写的（词库里标了 AI 的例句，或模型现写）。 */
  ai: boolean;
}

export interface RecallQuestion {
  /** 词条 ID，写回复习库用。 */
  wordId: string;
  /** 词库里的目标词原形；作答前不能显示。 */
  target: string;
  /** 写回复习库时的题型。 */
  kind: RecallKind;
  source: QuestionSource;
  /** 英文释义（已遮同族词）。 */
  meaning: string;
  meaningOrigin: 'library' | 'model';
  pos: string;
  /** 中文释义，只作补充；可能为空。 */
  chinese: string;
  context: RecallContext | null;
  /** 首字母提示，例如 e_________。 */
  hint: string;
  hintLabel: string;
  /** 判对的答案（语境题是句中实际词形）。 */
  answers: string[];
  /** 句型题：写完对照答案自评。 */
  selfCheck: boolean;
  /** 兜底题给用户的说明（为什么没有语境句）；正常题为空串。 */
  fallbackReason: string;
  /** 题型（038）；改写/造句时 task 非空。 */
  format: QuestionFormat;
  task: UsageTask | null;
}

/** 造句题的题面本来就写出目标词；其余题型作答前都不能露出目标词。 */
export const revealsTarget = (question: Pick<RecallQuestion, 'format'>): boolean => question.format === 'compose';

/** 题面标识：同一个词的同一道题面永远是同一个字符串；「这题出错了」靠它下一轮跳过。 */
export function surfaceOf(question: Pick<RecallQuestion, 'context' | 'answers' | 'meaning'> & Partial<Pick<RecallQuestion, 'format' | 'task'>>): string {
  const { context, task } = question;
  if (task) return `${question.format ?? 'task'}:${task.original}|${task.instruction}`;
  return context ? `${context.before}[[${question.answers[0] ?? ''}]]${context.after}` : `def:${question.meaning}`;
}

/** 「词 ID + 题面」合成一个集合键。 */
export const surfaceKey = (wordId: string, surface: string) => `${wordId}\u0001${surface}`;

/** 题面上会显示给用户的所有文字（作答前）。测试和运行时都用它查泄题。 */
export function visibleText(question: RecallQuestion): string[] {
  const parts = [question.meaning, question.chinese, question.pos, question.hint, question.fallbackReason];
  if (question.context) parts.push(question.context.before, question.context.after);
  if (question.task) parts.push(question.task.instruction, question.task.original);
  return parts;
}

/** 题面泄题检查：返回题面里出现的目标词/同族词，空数组表示干净。 */
export function questionLeaks(question: RecallQuestion): string[] {
  if (revealsTarget(question)) return [];
  return [...new Set(visibleText(question).flatMap(text => findLeaks(text, question.target)))];
}

const usableDefinitions = (word: QuestionWord) => word.definitions.filter(def => def.english.trim().length > 0);

function baseQuestion(word: QuestionWord, def: BrowseDefinition | undefined): Omit<RecallQuestion, 'source' | 'context' | 'hint' | 'hintLabel' | 'answers' | 'fallbackReason' | 'meaning' | 'meaningOrigin'> & { format: 'fill'; task: null } {
  const kind = recallKind(word.word);
  return {
    wordId: word.id,
    target: word.word.trim(),
    kind,
    pos: def ? maskLeaks(def.pos.trim(), word.word) : '',
    chinese: def ? maskLeaks(def.chinese.trim(), word.word) : '',
    selfCheck: kind === 'sentence',
    format: 'fill',
    task: null,
  };
}

/** 从一句话里挖掉目标词：必须恰好出现一次，否则这句不能用（挖两个空会让题面含糊）。 */
export function cutSentence(sentence: string, target: string): { before: string; after: string; answer: string } | null {
  const text = sentence.trim();
  const hits = findTargetForms(text, target);
  if (hits.length !== 1) return null;
  const [hit] = hits;
  return {
    before: maskLeaks(text.slice(0, hit.index), target),
    after: maskLeaks(text.slice(hit.index + hit.text.length), target),
    answer: hit.text,
  };
}

/** 现成例句去掉目标词后至少要有这么多词，否则「A resilient system.」这类太短的句子限定不了答案。 */
export const MIN_EXAMPLE_CONTEXT_WORDS = 6;

/** 数一句话里的英文词：纯标点、空格、遮词下划线都不算。 */
const contextWordCount = (text: string): number =>
  text.split(/\s+/u).filter(part => /[A-Za-z]/u.test(part)).length;

/** 用词库现成例句出题；没有能用的例句返回 null。人工例句优先于 AI 例句。 */
export function exampleQuestion(word: QuestionWord, exclude?: ReadonlySet<string>): RecallQuestion | null {
  for (const def of usableDefinitions(word)) {
    const examples = [...def.examples].sort((a, b) => Number(a.ai) - Number(b.ai) || a.seq - b.seq);
    for (const example of examples) {
      const cut = cutSentence(example.sentence, word.word);
      if (cut === null) continue;
      if (contextWordCount(`${cut.before} ${cut.after}`) < MIN_EXAMPLE_CONTEXT_WORDS) continue;
      if (exclude?.has(surfaceKey(word.id, `${cut.before}[[${cut.answer}]]${cut.after}`))) continue;
      return {
        ...baseQuestion(word, def),
        source: 'example',
        meaning: maskLeaks(def.english.trim(), word.word),
        meaningOrigin: 'library',
        context: { before: cut.before, after: cut.after, ai: example.ai },
        hint: letterHint(cut.answer),
        hintLabel: hintLabel(cut.answer),
        answers: [cut.answer],
        fallbackReason: '',
      };
    }
  }
  return null;
}

/** 兜底题：只有英文释义 + 首字母提示，答案是原形。没有英文释义返回 null。 */
export function definitionQuestion(word: QuestionWord, reason: string): RecallQuestion | null {
  const def = usableDefinitions(word)[0];
  if (!def) return null;
  return {
    ...baseQuestion(word, def),
    source: 'definition',
    meaning: maskLeaks(def.english.trim(), word.word),
    meaningOrigin: 'library',
    context: null,
    hint: letterHint(word.word),
    hintLabel: hintLabel(word.word),
    answers: [word.word.trim()],
    fallbackReason: reason,
  };
}

// ---------------------------------------------------------------- 模型出题

/** 发给模型的一条出题请求（只给词、词性和词库释义，不给复习备注）。 */
export interface ModelQuestionRequest {
  id: string;
  word: string;
  pos: string;
  english: string;
  chinese: string;
}

/** 模型返回的一条草稿：语境句里用 [[...]] 标出目标词。 */
export interface ModelQuestionDraft {
  id: string;
  meaning: string;
  sentence: string;
}

export type ModelQuestionGenerator = (requests: ModelQuestionRequest[]) => Promise<ModelQuestionDraft[]>;

export function modelRequest(word: QuestionWord): ModelQuestionRequest {
  const def = usableDefinitions(word)[0];
  return {
    id: word.id,
    word: word.word.trim(),
    pos: def?.pos.trim() ?? '',
    english: def?.english.trim() ?? '',
    chinese: def?.chinese.trim() ?? '',
  };
}

const MARK = /\[\[([^[\]]+)\]\]/gu;
const MAX_TEXT = 400;

/** 校验模型草稿并转成题目；不合格返回原因（中文，给用户看）。 */
export function questionFromDraft(word: QuestionWord, draft: ModelQuestionDraft): RecallQuestion | string {
  const sentence = draft.sentence.trim();
  if (sentence.length === 0 || sentence.length > MAX_TEXT) return '语境句为空或太长';
  const marks = [...sentence.matchAll(MARK)];
  if (marks.length !== 1) return '语境句里没有恰好一个目标词标记';
  const mark = marks[0];
  const answer = mark[1].trim().replace(/\s+/gu, ' ');
  if (!isTargetForm(answer, word.word)) return '标记里的词不是目标词';
  const start = mark.index ?? 0;
  const before = sentence.slice(0, start);
  const after = sentence.slice(start + mark[0].length);
  if (/\[\[|\]\]/u.test(before + after)) return '语境句标记格式不对';
  if (findLeaks(before + ' ' + after, word.word).length > 0) return '语境句别处出现了目标词或同族词';
  if ((before + ' ' + after).split(/\s+/u).filter(part => /[A-Za-z]/u.test(part)).length < 4) return '语境句太短，限定不了答案';

  const def = usableDefinitions(word)[0];
  let meaning: string;
  let meaningOrigin: RecallQuestion['meaningOrigin'];
  if (def) {
    meaning = maskLeaks(def.english.trim(), word.word);
    meaningOrigin = 'library';
  } else {
    meaning = draft.meaning.trim();
    meaningOrigin = 'model';
    if (meaning.length === 0 || meaning.length > MAX_TEXT) return '模型没给英文释义';
    if (findLeaks(meaning, word.word).length > 0) return '模型的英文释义里出现了目标词';
  }
  return {
    ...baseQuestion(word, def),
    source: 'model',
    meaning,
    meaningOrigin,
    context: { before, after, ai: true },
    hint: letterHint(answer),
    hintLabel: hintLabel(answer),
    answers: [answer],
    fallbackReason: '',
  };
}

// ---------------------------------------------------------------- 改写 / 造句（038）

export type UsageFormat = Exclude<QuestionFormat, 'fill'>;

/** 发给模型的一条改写/造句出题请求。 */
export interface UsageRequest extends ModelQuestionRequest {
  format: UsageFormat;
}

/** 模型返回的改写/造句草稿。reference 里用 [[...]] 标出目标词。 */
export interface UsageDraft {
  id: string;
  format: string;
  instruction: string;
  original: string;
  reference: string;
}

export type UsageGenerator = (requests: UsageRequest[]) => Promise<UsageDraft[]>;

/**
 * 一轮里改写+造句一共几题：约一半（向下取整），只有 1 题时不出（复检、只剩一个词的一轮都只出填空）。
 * 8 题 → 4（改写 2、造句 2）；7 题首考 → 3（改写 2、造句 1）；4 题 → 2；3 题 → 1。
 */
export function usageCount(total: number): number {
  return total < 2 ? 0 : Math.floor(total / 2);
}

/**
 * 从能出改写/造句的位置里均匀挑 count 个，改写、造句交替（改写先）。
 * 返回 [位置, 题型]，位置是 eligible 里的下标。均匀挑是为了每屏都混着几种题，而不是前一屏全填空、后一屏全造句。
 */
export function pickUsageSlots(eligible: number, count: number): [number, UsageFormat][] {
  const take = Math.max(0, Math.min(eligible, count));
  const picked: [number, UsageFormat][] = [];
  for (let i = 0; i < take; i += 1) {
    picked.push([Math.floor(((i + 0.5) * eligible) / take), i % 2 === 0 ? 'paraphrase' : 'compose']);
  }
  return picked;
}

/** 能出改写/造句的词：单词或 4 词以内短语（X/… 句型本来就是写整句），且有英文释义。 */
export function usageEligible(word: QuestionWord): boolean {
  return recallKind(word.word) !== 'sentence' && usableDefinitions(word).length > 0;
}

export function usageRequest(word: QuestionWord, format: UsageFormat): UsageRequest {
  return { ...modelRequest(word), format };
}

const englishWords = (text: string) => text.split(/\s+/u).filter(part => /[A-Za-z]/u.test(part)).length;
const hasMarkSyntax = (text: string) => /\[\[|\]\]/u.test(text);

/** 校验改写/造句草稿并转成题目；不合格返回中文原因。 */
export function usageFromDraft(word: QuestionWord, format: UsageFormat, draft: UsageDraft): RecallQuestion | string {
  if (draft.format !== format) return '题型和要求的不一致';
  const def = usableDefinitions(word)[0];
  if (!def) return '没有英文释义';
  const instruction = draft.instruction.trim();
  const original = draft.original.trim();
  const referenceRaw = draft.reference.trim();
  if (instruction.length === 0 || instruction.length > MAX_TEXT) return '题目要求为空或太长';
  if (referenceRaw.length === 0 || referenceRaw.length > MAX_TEXT) return '参考答案为空或太长';
  const marks = [...referenceRaw.matchAll(MARK)];
  if (marks.length !== 1 || !isTargetForm(marks[0][1], word.word)) return '参考答案里没有恰好一个标出的目标词';
  const reference = referenceRaw.replace(MARK, (_, inner: string) => inner.trim());
  if (hasMarkSyntax(reference) || hasMarkSyntax(instruction)) return '标记格式不对';

  if (format === 'paraphrase') {
    if (original.length === 0 || original.length > MAX_TEXT) return '改写题没给原句';
    if (englishWords(original) < 6) return '原句太短';
    if (hasMarkSyntax(original)) return '标记格式不对';
    if (findLeaks(`${original} ${instruction}`, word.word).length > 0) return '改写题的原句或要求里出现了目标词或同族词';
    if (normalizeRecallAnswer(original) === normalizeRecallAnswer(reference)) return '参考答案和原句一样';
  } else {
    if (findTargetForms(instruction, word.word).length === 0) return '造句题的要求里没写出目标词';
    if (englishWords(instruction) < 8) return '造句要求太笼统（没给具体情境）';
  }

  return {
    ...baseQuestion(word, def),
    kind: format === 'paraphrase' ? 'rewrite' : 'sentence',
    selfCheck: true,
    source: 'model',
    meaning: maskLeaks(def.english.trim(), word.word),
    meaningOrigin: 'library',
    context: null,
    hint: format === 'paraphrase' ? letterHint(word.word) : '',
    hintLabel: format === 'paraphrase' ? hintLabel(word.word) : '',
    answers: [word.word.trim()],
    fallbackReason: '',
    format,
    task: { instruction, original: format === 'paraphrase' ? original : '', reference },
  };
}

export interface CrossLeak {
  /** 作答前藏着答案的那题（下标）。 */
  hidden: number;
  /** 题面露出了它答案的那题（下标）。 */
  shown: number;
  words: string[];
}

/**
 * 同一批题之间的泄题：一题题面上的文字（造句题会写出它自己的目标词，模型写的原句也可能碰巧用到）
 * 出现了另一道「答案藏着」的题的目标词或同族词。例如同一轮有 evaluate 填空和 evaluation 造句。
 */
export function crossLeaks(questions: readonly RecallQuestion[]): CrossLeak[] {
  const found: CrossLeak[] = [];
  questions.forEach((hidden, h) => {
    if (revealsTarget(hidden)) return;
    questions.forEach((shown, v) => {
      if (v === h) return;
      const words = [...new Set(visibleText(shown).flatMap(text => findLeaks(text, hidden.target)))];
      if (words.length > 0) found.push({ hidden: h, shown: v, words });
    });
  });
  return found;
}

// ---------------------------------------------------------------- 一轮复习

export interface SkippedWord {
  wordId: string;
  word: string;
  reason: string;
}

export interface RecallRound {
  /** 本轮题目，按传入队列顺序（最逾期在前）。 */
  readonly questions: readonly RecallQuestion[];
  /** 因缺数据没出题的词（只统计本轮看过的词）。 */
  readonly skipped: readonly SkippedWord[];
  /** 本轮没轮到的到期词数（每轮最多 RECALL_LIMIT 题）。 */
  readonly remaining: number;
  /** 给用户的整体说明：没配模型、模型失败等。 */
  readonly notices: readonly string[];
}

export interface PrepareOptions {
  /** 没配模型时传 null：只用现成例句和释义兜底。 */
  generate: ModelQuestionGenerator | null;
  /** 默认 RECALL_LIMIT。 */
  limit?: number;
  /** 用户标过「这题出错了」的题面（surfaceKey）；这些题面不再出。 */
  exclude?: ReadonlySet<string>;
  /** 同日复检：只要有新语境的题，不要纯释义题。 */
  requireContext?: boolean;
  /** 提示语里的名词，默认「到期词」；新词首考传「新词」。 */
  noun?: string;
  /**
   * 038：这一轮混入改写/造句题（到期复习、新词首考的首轮传 true；复检不传）。
   * 需要 generate 和 generateUsage 都在（配了模型）；没配模型时只出填空，并给出说明。
   */
  mix?: boolean;
  /** 改写/造句出题；没配模型传 null。 */
  generateUsage?: UsageGenerator | null;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const NO_EXAMPLE_NO_MODEL = '这个词没有现成例句，也没配置模型，所以只有英文释义，没有语境句。';
const NO_DEF_NO_MODEL = '没有英文释义，也没配置模型，出不了合格的题。先在「导入」里导入释义，或在「设置」里配置模型。';
const SENTENCE_NO_EXAMPLE = '句型没有现成例句（句型不交给模型现写），这题只有英文释义；写完对照答案自评。';
const SENTENCE_NO_DEF ='句型没有英文释义，出不了合格的题。先在「导入」里导入释义。';
export const USAGE_NO_MODEL = '没配置模型：这一轮只出看释义填空题。改写、造句题要由模型出题和判分，在「设置」配置模型后会自动加入。';

/**
 * 固定一轮复习题。队列按最逾期在前传入；依次挑能出题的词，凑够 limit 个为止。
 * 现成例句能用就不调模型；其余单词/短语一次性批量请求模型；模型失败或不合格的题退回释义题，
 * 连释义都没有的词跳过并说明原因。不修改传入数组。
 */
export async function prepareRecallRound(queue: readonly QuestionWord[], options: PrepareOptions): Promise<RecallRound> {
  const limit = options.limit ?? RECALL_LIMIT;
  const modelOn = options.generate !== null;
  const slots: { word: QuestionWord; question: RecallQuestion | null; wantModel: boolean; usage: UsageFormat | null; fill: RecallQuestion | null }[] = [];
  const skipped: SkippedWord[] = [];
  let consumed = 0;

  for (const word of queue) {
    if (slots.length >= limit) break;
    consumed += 1;
    const fromExample = exampleQuestion(word, options.exclude);
    if (fromExample) {
      slots.push({ word, question: fromExample, wantModel: false, usage: null, fill: null });
      continue;
    }
    const sentence = recallKind(word.word) === 'sentence';
    const wantModel = modelOn && !sentence;
    const fallback = definitionQuestion(word, sentence ? SENTENCE_NO_EXAMPLE : NO_EXAMPLE_NO_MODEL);
    if (!wantModel && fallback === null) {
      skipped.push({ wordId: word.id, word: word.word, reason: sentence ? SENTENCE_NO_DEF : NO_DEF_NO_MODEL });
      continue;
    }
    slots.push({ word, question: wantModel ? null : fallback, wantModel, usage: null, fill: null });
  }

  const notices: string[] = [];
  const usageOn = options.mix === true && modelOn && Boolean(options.generateUsage);
  if (options.mix === true && !usageOn) notices.push(USAGE_NO_MODEL);
  if (usageOn) {
    const eligible = slots.filter(slot => usageEligible(slot.word));
    for (const [position, format] of pickUsageSlots(eligible.length, usageCount(slots.length))) eligible[position].usage = format;
  }
  const usageSlots = slots.filter(slot => slot.usage !== null);
  // 填空出题和改写/造句出题同时发；改写/造句失败的词退回它的填空题（现成例句、模型语境句或仅释义）。
  const usageCall: Promise<{ drafts: UsageDraft[]; failure: string }> = usageSlots.length > 0 && options.generateUsage
    ? options.generateUsage(usageSlots.map(slot => usageRequest(slot.word, slot.usage as UsageFormat)))
      .then(drafts => ({ drafts, failure: '' }), (error: unknown) => ({ drafts: [] as UsageDraft[], failure: errorText(error) }))
    : Promise.resolve({ drafts: [], failure: '' });

  const pending = slots.filter(slot => slot.wantModel);
  if (pending.length > 0 && options.generate) {
    let drafts: ModelQuestionDraft[] = [];
    let failure = '';
    try {
      drafts = await options.generate(pending.map(slot => modelRequest(slot.word)));
    } catch (error) {
      failure = errorText(error);
    }
    const byId = new Map<string, ModelQuestionDraft>();
    for (const draft of drafts) if (!byId.has(draft.id)) byId.set(draft.id, draft);
    let rejected = 0;
    let missing = 0;
    for (const slot of pending) {
      const draft = byId.get(slot.word.id);
      const outcome = failure ? failure : draft ? questionFromDraft(slot.word, draft) : '模型没给这个词出题';
      if (typeof outcome !== 'string') {
        slot.question = outcome;
        continue;
      }
      if (!failure) {
        if (draft) rejected += 1;
        else missing += 1;
      }
      slot.question = definitionQuestion(slot.word, `模型出的语境句没用上（${outcome}），这题只有英文释义。`);
      if (slot.question === null) {
        skipped.push({ wordId: slot.word.id, word: slot.word.word, reason: `模型出题失败（${outcome}），又没有英文释义可兜底。` });
      }
    }
    if (failure) notices.push(`模型出题失败：${failure} 这 ${pending.length} 个词改用英文释义题，没有释义的跳过。`);
    if (missing > 0) notices.push(`模型有 ${missing} 个词没给题（回复里没有这些词），已改用英文释义题或跳过。`);
    if (rejected > 0) notices.push(`模型给 ${rejected} 个词出的题没通过格式或防泄题检查，已改用英文释义题或跳过。`);
  }

  if (usageSlots.length > 0) {
    const { drafts, failure } = await usageCall;
    const byId = new Map<string, UsageDraft>();
    for (const draft of drafts) if (!byId.has(draft.id)) byId.set(draft.id, draft);
    let rejected = 0;
    let missing = 0;
    for (const slot of usageSlots) {
      // 填空题都出不来（连释义都没有）就不出这个词；usageEligible 已要求有释义，这里只是保险。
      if (slot.question === null) { slot.usage = null; continue; }
      const draft = byId.get(slot.word.id);
      const outcome = failure || !draft ? null : usageFromDraft(slot.word, slot.usage as UsageFormat, draft);
      if (outcome !== null && typeof outcome !== 'string') {
        slot.fill = slot.question;
        slot.question = outcome;
        continue;
      }
      if (!failure) {
        if (draft) rejected += 1;
        else missing += 1;
      }
      slot.usage = null;
    }
    if (failure) notices.push(`模型出改写/造句题失败：${failure} 这 ${usageSlots.length} 题改回填空题。`);
    if (missing > 0) notices.push(`模型漏了 ${missing} 道改写/造句题（回复里没有这些词），已改回填空题。`);
    if (rejected > 0) notices.push(`模型出的 ${rejected} 道改写/造句题没通过格式或防泄题检查，已改回填空题。`);

    // 题与题之间互相泄题：露出别人答案、或答案被别人露出的改写/造句题换回填空题；改到没有这类冲突为止。
    let demoted = 0;
    for (let guard = 0; guard < slots.length; guard += 1) {
      const live = slots.filter(slot => slot.question !== null);
      const conflict = crossLeaks(live.map(slot => slot.question as RecallQuestion))
        .map(leak => [live[leak.shown], live[leak.hidden]].find(slot => slot.fill !== null))
        .find(slot => slot !== undefined);
      if (!conflict) break;
      conflict.question = conflict.fill;
      conflict.fill = null;
      conflict.usage = null;
      demoted += 1;
    }
    if (demoted > 0) notices.push(`${demoted} 道改写/造句题会让同一轮别的题露出答案，已改回填空题。`);
  }

  const questions = slots.flatMap(slot => (slot.question ? [slot.question] : []));
  // 最后一道保险：任何题面还能看到目标词就不出这题。
  const clean = questions.filter(question => {
    if (options.exclude?.has(surfaceKey(question.wordId, surfaceOf(question)))) {
      skipped.push({ wordId: question.wordId, word: question.target, reason: '这道题面你标过「这题出错了」，不再使用。' });
      return false;
    }
    if (options.requireContext && question.context === null) {
      skipped.push({ wordId: question.wordId, word: question.target, reason: '没有别的语境可换（没有别的现成例句，也没配置模型）。' });
      return false;
    }
    const leaks = questionLeaks(question);
    if (leaks.length === 0) return true;
    skipped.push({ wordId: question.wordId, word: question.target, reason: '题面遮不干净目标词，为防泄题没出这题。' });
    return false;
  });

  if (!modelOn) {
    const bare = clean.filter(question => question.source === 'definition').length;
    if (bare > 0) notices.push(`没配置模型：${bare} 题没有现成例句，只给英文释义和首字母提示。在「设置」配置模型后，这类词会自动生成语境句。`);
  }
  if (skipped.length > 0) notices.push(`${skipped.length} 个${options.noun ?? '到期词'}缺数据没出题，原因见结果页。`);

  return Object.freeze({
    questions: Object.freeze(clean),
    skipped: Object.freeze(skipped),
    remaining: queue.length - consumed,
    notices: Object.freeze(notices),
  });
}

/** 把题目分屏：每屏不超过 max 题，各屏题数尽量平均（8 题分成 4 + 4，而不是 5 + 3）。 */
export function splitScreens<T>(items: readonly T[], max: number = SCREEN_LIMIT): T[][] {
  if (max < 1) throw new Error('每屏题数至少为 1');
  if (items.length === 0) return [];
  const count = Math.ceil(items.length / max);
  const base = Math.floor(items.length / count);
  const extra = items.length % count;
  const screens: T[][] = [];
  let start = 0;
  for (let i = 0; i < count; i += 1) {
    const size = base + (i < extra ? 1 : 0);
    screens.push(items.slice(start, start + size));
    start += size;
  }
  return screens;
}

/** 本卡的临时判定：自动判词形是否与答案一致；句型题返回 null 表示让用户自评。031 会替换判分。 */
export function judgeRecall(question: RecallQuestion, written: string): boolean | null {
  if (question.selfCheck) return null;
  if (written.trim().length === 0) return false;
  return question.answers.some(answer => recallAnswerMatches(answer, written));
}
