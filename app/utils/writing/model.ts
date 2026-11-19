/** 写作练习的三种场景、提示词和结构化结果解析。095 只做逻辑，界面在 096。 */

export type WritingSceneId = 'ielts' | 'cet' | 'academic';

export interface WritingScene {
  id: WritingSceneId;
  nameZh: string;
  nameEn: string;
  style: string;
  requirement: string;
}

export const WRITING_SCENES: readonly WritingScene[] = [
  { id: 'ielts', nameZh: '雅思', nameEn: 'IELTS', style: '雅思大作文风格：从教育、科技、环境、社会等话题中选一个，要求表明立场并给理由', requirement: '2–4 句，表明立场并给一个理由' },
  { id: 'cet', nameZh: '四六级', nameEn: 'CET-4/6', style: '四六级写作风格：选日常或校园话题，要求表达看法或提出建议', requirement: '2–4 句，表达看法或建议，并简单说明理由' },
  { id: 'academic', nameZh: '学术场景', nameEn: 'Academic', style: '学术场景：从概括观点、表示同意或反对、描述数据趋势、比较两种做法中选一种', requirement: '2–4 句，完成题目指定的学术表达任务' },
];

export interface WritingWord {
  id: string;
  word: string;
  pos: string;
  definition: string;
}

export interface WritingTaskResult {
  /** 英文题目，1–2 句。 */
  prompt: string;
  /** 一句中文说明。 */
  chinese: string;
  requirements: string;
  /** 模型回复格式不对时，其余字段为空，这里给用户看的中文原因。 */
  error?: string;
}

export type WritingTaskVerdict = 'yes' | 'partly' | 'no';

export interface WritingReviewIssue {
  original: string;
  suggestion: string;
  reason: string;
}

export interface WritingReviewWord {
  word: string;
  used: boolean;
  /** 没使用时为 null；没用不扣分。 */
  correct: boolean | null;
  comment: string;
}

export interface WritingReviewResult {
  task: { verdict: WritingTaskVerdict; comment: string } | null;
  issues: WritingReviewIssue[];
  words: WritingReviewWord[];
  better: string;
  error?: string;
}

export interface WritingTaskArgs { scene: WritingSceneId; words: WritingWord[] }
export interface WritingReviewArgs { recordId: string; words: WritingWord[] }

export function getWritingScene(id: string): WritingScene | undefined {
  return WRITING_SCENES.find(scene => scene.id === id);
}

const wordList = (words: readonly WritingWord[]): string => words.length === 0
  ? '（这次没有合适的建议用词，仍请正常出题。）'
  : words.map((item, index) => `${index + 1}. ${item.word}（${item.pos || '词性未知'}）：${item.definition}`).join('\n');

/** 出题提示词。建议用词只作可选脚手架，不许反过来限制题目。 */
export function buildWritingTaskPrompt(scene: WritingScene, words: readonly WritingWord[]): string {
  return `【写作出题】
你是一名英语写作教练。请仿照该类考试或场景的出题风格，自拟一道小写作题。
场景：${scene.nameZh}（${scene.nameEn}）
风格：${scene.style}。
题目必须原创；只仿照风格，不要照抄、复述或轻微改写任何真题原文。
用户只需写 2–4 句，不要把题目出成需要完整长篇作文才能回答的大题。

下面是从用户词库挑出的建议用词。它们可用可不用，不强制使用，也不要为了塞词而偏离题目：
${wordList(words)}

只返回一个 JSON 对象，不要 Markdown 代码块或其他解释，格式如下：
{"prompt":"1–2 句英文题目","chinese":"一句中文说明，告诉用户要写什么","requirements":"${scene.requirement}"}`;
}

/** 批改提示词。明确不给分数，也没用建议用词不扣分。 */
export function buildWritingReviewPrompt(scene: WritingScene, task: WritingTaskResult, answer: string, words: readonly WritingWord[]): string {
  return `【写作批改】
你是一名英语写作教练。请批改用户针对下面${scene.nameZh}（${scene.nameEn}）小写作题的英文作答。
英文题目：${task.prompt}
中文说明：${task.chinese}
写作要求：${task.requirements}
用户作答：
${answer.trim()}

建议用词（可用可不用；没用就标“没用”，不扣分）：
${wordList(words)}

请优先指出最重要的语法或用词问题，保留用户自己的意思。不打分，不给分数、等级或排名，也不要在 better 里添加用户没有表达的新论点。
只返回一个 JSON 对象，不要 Markdown 代码块或其他解释，格式如下：
{
  "task":{"verdict":"yes、partly 或 no","comment":"一句中文点评，说明有没有回答题目"},
  "issues":[{"original":"原文片段","suggestion":"改法","reason":"一句中文原因"}],
  "words":[{"word":"建议用词原词","used":true,"correct":true,"comment":"一句中文说明；没使用时 correct 为 null"}],
  "better":"2–4 句更好的英文写法，尽量保留用户原意"
}
issues 只列最重要的 0–3 处；words 必须逐个覆盖上面的建议用词，没有建议用词时返回空数组。`;
}

const malformed = (kind: string): Error => new Error(`${kind}结果解析失败：模型没有返回符合要求的 JSON，请重试。`);

function jsonObject(content: string, kind: string): Record<string, unknown> {
  const fenced = content.match(/^\s*```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?\s*```\s*$/i);
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1] : content); } catch { throw malformed(kind); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed(kind);
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, kind: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 5000) throw malformed(kind);
  return value.replace(/\s+/g, ' ').trim();
}

export function parseWritingTask(content: string): WritingTaskResult {
  const raw = jsonObject(content, '写作出题');
  const result = {
    prompt: requiredText(raw.prompt, '写作出题'),
    chinese: requiredText(raw.chinese, '写作出题'),
    requirements: requiredText(raw.requirements, '写作出题'),
  };
  if (!/[A-Za-z]/.test(result.prompt) || !/[\u3400-\u9fff]/.test(result.chinese)) throw malformed('写作出题');
  return result;
}

export function parseWritingTaskRecord(_args: WritingTaskArgs, content: string): WritingTaskResult {
  try { return parseWritingTask(content); }
  catch (error) { return { prompt: '', chinese: '', requirements: '', error: error instanceof Error ? error.message : String(error) }; }
}

export function parseWritingReview(args: WritingReviewArgs, content: string): WritingReviewResult {
  const raw = jsonObject(content, '写作批改');
  const taskRaw = raw.task;
  if (!taskRaw || typeof taskRaw !== 'object' || Array.isArray(taskRaw)) throw malformed('写作批改');
  const verdict = (taskRaw as Record<string, unknown>).verdict;
  if (verdict !== 'yes' && verdict !== 'partly' && verdict !== 'no') throw malformed('写作批改');
  const task: { verdict: WritingTaskVerdict; comment: string } = { verdict, comment: requiredText((taskRaw as Record<string, unknown>).comment, '写作批改') };

  if (!Array.isArray(raw.issues)) throw malformed('写作批改');
  const issues = raw.issues.slice(0, 3).map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw malformed('写作批改');
    const issue = item as Record<string, unknown>;
    return {
      original: requiredText(issue.original, '写作批改'),
      suggestion: requiredText(issue.suggestion, '写作批改'),
      reason: requiredText(issue.reason, '写作批改'),
    };
  });

  const modelWords = Array.isArray(raw.words) ? raw.words : [];
  if (!Array.isArray(raw.words)) throw malformed('写作批改');
  const byWord = new Map<string, Record<string, unknown>>();
  for (const item of modelWords) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.word === 'string') byWord.set(row.word.trim().toLowerCase(), row);
  }
  const words: WritingReviewWord[] = args.words.map(suggested => {
    const row = byWord.get(suggested.word.trim().toLowerCase());
    if (!row || row.used !== true) return { word: suggested.word, used: false, correct: null, comment: '没用，不扣分。' };
    if (typeof row.correct !== 'boolean') throw malformed('写作批改');
    return {
      word: suggested.word,
      used: true,
      correct: row.correct,
      comment: typeof row.comment === 'string' && row.comment.trim() ? row.comment.replace(/\s+/g, ' ').trim() : (row.correct ? '用词正确。' : '这里用得不够准确。'),
    };
  });
  const better = requiredText(raw.better, '写作批改');
  if (!/[A-Za-z]/.test(better)) throw malformed('写作批改');
  return { task, issues, words, better };
}

export function parseWritingReviewRecord(args: WritingReviewArgs, content: string): WritingReviewResult {
  try { return parseWritingReview(args, content); }
  catch (error) { return { task: null, issues: [], words: args.words.map(item => ({ word: item.word, used: false, correct: null, comment: '没用，不扣分。' })), better: '', error: error instanceof Error ? error.message : String(error) }; }
}

/** 空作答或明显不是英文时不浪费一次模型请求。 */
export function writingAnswerError(answer: string): string | null {
  const text = answer.trim();
  if (!text) return '先写下 2–4 句英文，再让 AI 批改。';
  const englishWords = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? [];
  if (englishWords.length < 2 || /[\u3400-\u9fff]/.test(text)) return '这段作答明显不是英文，请用英文写 2–4 句后再批改。';
  return null;
}