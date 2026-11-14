import type { CoachTop } from '../vocab/types';
import { AWL_FAMILIES } from './awl';

export type PaperChoice = 'auto' | 'part-b' | 'part-c' | 'general';
export type PaperType = Exclude<PaperChoice, 'auto'>;

export interface EssayAnalysis {
  wordCount: number;
  awlCount: number;
  awlCoverage: number;
  awlFamilies: { headword: string; sublist: number }[];
  lowAwl: boolean;
  paperType: PaperType;
  paperReason: string;
  wordRequirement: string;
}

export interface WeakFeature {
  feature: string;
  note: string;
}

export interface SentenceCorrection {
  original: string;
  kind: string;
  correction: string;
  why: string;
}

export interface SelfCheck {
  question: string;
  answer: string;
}

export interface FirstReview {
  summary: {
    weakFeatures: WeakFeature[];
    oneThing: string;
    hardChecks: string[];
  };
  corrections: SentenceCorrection[];
  selfCheck: SelfCheck[];
  archiveComparison: {
    recurring: string[];
    newIssues: string[];
  };
}

export interface RewriteReview {
  rewrite: string;
  improvements: string[];
}

export const PAPER_LABELS: Record<PaperType, string> = {
  'part-b': 'EAP Part B',
  'part-c': 'EAP Part C',
  general: '通用学术写作',
};

export const EAP_HONESTY_NOTICE = '⚠️ EAP 这一套评分维度是根据真题卷面硬性要求 + 学术写作通用规范构造的，不是格院官方公布的评分细则（格院从未公开）。硬指标（词数/抄原文/写词数）来自真题原文，可信；语言类维度的权重是我的推断。';

export const honestyNoticeFor = (paperType: PaperType): string => paperType === 'general' ? '' : EAP_HONESTY_NOTICE;

const AWL_LOOKUP = new Map<string, { headword: string; sublist: number }>();
for (const family of AWL_FAMILIES) {
  for (const word of [family.headword, ...family.variants]) {
    AWL_LOOKUP.set(word.toLowerCase(), { headword: family.headword, sublist: family.sublist });
  }
}

/** 与规则中的 text.split() 一致：按空白分词，不让模型猜词数。 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function automaticPaperType(text: string, wordCount: number): { paperType: PaperType; paperReason: string } {
  const hasPartBTexts = ['A', 'B', 'C'].every(label => new RegExp(`Text\\s*${label}\\b`, 'i').test(text));
  const partBLength = /100\s*[-–—]\s*130\s*words?/i.test(text) || (wordCount >= 100 && wordCount <= 130);
  if (hasPartBTexts && /do\s+not\s+copy/i.test(text) && /\bsummary\b/i.test(text) && partBLength) {
    return { paperType: 'part-b', paperReason: '检测到 Text A/B/C、Do not copy、summary 和 100–130 词要求。' };
  }
  const partCNotes = /ASPECTS\s+OF\s+(?:TECHNOLOGY|DESIGN)/i.test(text) && /\bABILITIES\b/i.test(text);
  const technology = /\b(?:device|technology|technical|product|battery|power|design|machine|equipment)\b/i.test(text);
  const partCLength = /150\s*[-–—]\s*250\s*words?/i.test(text) || (wordCount >= 150 && wordCount <= 250);
  if (partCNotes && technology && partCLength) {
    return { paperType: 'part-c', paperReason: '检测到 ASPECTS/ABILITIES 符号笔记、技术产品和 150–250 词要求。' };
  }
  return { paperType: 'general', paperReason: '没有同时满足 EAP Part B 或 Part C 的卷面判据，按通用学术写作处理。' };
}

export function analyzeEssay(text: string, choice: PaperChoice = 'auto'): EssayAnalysis {
  const wordCount = countWords(text);
  const tokens = text.match(/[A-Za-z]+(?:[-’'][A-Za-z]+)*/g) ?? [];
  const families = new Map<string, { headword: string; sublist: number }>();
  let awlCount = 0;
  for (const token of tokens) {
    const normalized = token.toLowerCase().replace(/’/g, "'");
    const family = AWL_LOOKUP.get(normalized);
    if (!family) continue;
    awlCount += 1;
    families.set(family.headword, family);
  }
  const detected = automaticPaperType(text, wordCount);
  const paperType = choice === 'auto' ? detected.paperType : choice;
  const paperReason = choice === 'auto' ? detected.paperReason : `用户手动选择${PAPER_LABELS[choice]}。`;
  const awlCoverage = wordCount === 0 ? 0 : Math.round((awlCount / wordCount) * 1000) / 10;
  return {
    wordCount,
    awlCount,
    awlCoverage,
    awlFamilies: [...families.values()],
    lowAwl: awlCoverage < 5,
    paperType,
    paperReason,
    wordRequirement: paperType === 'part-b' ? '100–130 词' : paperType === 'part-c' ? '150–250 词' : '无固定词数要求',
  };
}

const TOP_RULES = `批改规则：
- 一律按学术英语七特征批改：structured、complex、formal、objective、explicit、hedged、responsible。
- 逐句检查 grammar、七特征和 AWL；缩写、口语连接词、模糊词、泛称 you、俚语等属于 formal 问题。
- 评语用中文；original、correction、rewrite 必须保留或写成英文原文，不把英文句子翻译成中文。
- 每条错误都要说明下次怎么做，不写空泛鼓励，不给 EAP 编官方分数。
- EAP Part B 硬指标：100–130 词、文末写词数、连续四词不得抄原文、覆盖三篇材料的趋势和原因。
- EAP Part C 硬指标：150–250 词、文末写词数、覆盖 ASPECTS 与 ABILITIES、按技术描述逻辑组织。
- 机打文本的小写 i 不计错；EAP 手写卷面才提醒大写 I 和无缩写。
- 先找出最要害的问题和三个自查题，再按指定 JSON 组装结果。`;

function analysisBlock(analysis: EssayAnalysis): string {
  return `程序已经算好的结果（必须原样使用，不得重新估算）：
卷面类型：${PAPER_LABELS[analysis.paperType]}
判定依据：${analysis.paperReason}
词数：${analysis.wordCount}
词数要求：${analysis.wordRequirement}
AWL 命中词次数：${analysis.awlCount}
AWL 覆盖率：${analysis.awlCoverage}%
命中的 AWL 词族：${analysis.awlFamilies.map(item => `${item.headword}（Sublist ${item.sublist}）`).join('、') || '无'}
${analysis.lowAwl ? 'AWL 覆盖率低于 5%，总评必须指出词汇偏泛用。' : ''}`;
}

function topBlock(top: CoachTop[]): string {
  return `历史高频错误 Top（④必须对照，区分老毛病复发和新问题）：
${top.length ? top.map(item => `${item.rank}. ${item.kind}；次数 ${item.count}；最近 ${item.lastAt || '未知'}；状态 ${item.status || '未知'}`).join('\n') : '（档案为空，本次问题都标为新问题，不虚构历史。）'}`;
}

export function buildFirstPrompt(essay: string, analysis: EssayAnalysis, top: CoachTop[]): string {
  return `${TOP_RULES}\n\n${analysisBlock(analysis)}\n\n${topBlock(top)}\n\n学生作文及可能附带的题目材料：\n---\n${essay}\n---\n\n输出要求（最后阅读并严格遵守）：只返回一个 JSON 对象，不要 Markdown 代码块或任何额外文字。结构如下：
{"summary":{"weakFeatures":[{"feature":"七特征英文标签","note":"中文短板说明"}],"oneThing":"中文：最该改的一件事","hardChecks":["中文硬指标核查；通用学术写作为空数组"]},"corrections":[{"original":"英文原句","kind":"grammar / 七特征标签 / AWL","correction":"英文改法","why":"中文原因和下次做法"}],"selfCheck":[{"question":"中文自查问题，引用英文时保留英文","answer":"中文解释，英文改法保留英文"}],"archiveComparison":{"recurring":["老毛病复发"],"newIssues":["新问题"]}}
weakFeatures 只选最弱的 1–2 项；selfCheck 必须恰好 3 条；corrections 覆盖需要修改的原句，没有错误时可为空数组。`;
}

export function buildLongOverviewPrompt(essay: string, analysis: EssayAnalysis, top: CoachTop[]): string {
  return `${TOP_RULES}\n\n这是超过 250 词的长作文，按照 A.7 分成两轮：这一轮只做总评、自查题和档案对照，不做逐句改错。\n\n${analysisBlock(analysis)}\n\n${topBlock(top)}\n\n学生作文及可能附带的题目材料：\n---\n${essay}\n---\n\n输出要求（最后阅读并严格遵守）：只返回一个 JSON 对象，不要 Markdown 代码块或额外文字。字段结构与短作文首批评改相同，但 corrections 必须固定为 []；weakFeatures 只选 1–2 项，selfCheck 恰好 3 条：
{"summary":{"weakFeatures":[{"feature":"七特征英文标签","note":"中文短板说明"}],"oneThing":"中文：最该改的一件事","hardChecks":["中文硬指标核查；通用学术写作为空数组"]},"corrections":[],"selfCheck":[{"question":"中文自查问题","answer":"中文答案，英文改法保留英文"}],"archiveComparison":{"recurring":["老毛病复发"],"newIssues":["新问题"]}}`;
}

export function buildLongCorrectionsPrompt(essay: string, analysis: EssayAnalysis): string {
  return `${TOP_RULES}\n\n这是长作文的第二轮，只逐句改错，不重复总评、不出改写示范。逐句完成分析后再输出。\n\n${analysisBlock(analysis)}\n\n学生作文及可能附带的题目材料：\n---\n${essay}\n---\n\n输出要求（最后阅读并严格遵守）：只返回一个 JSON 对象，不要 Markdown 代码块或额外文字；没有错误时 corrections 为空数组：
{"corrections":[{"original":"英文原句","kind":"grammar / 七特征标签 / AWL","correction":"英文改法","why":"中文原因和下次做法"}]}`;
}

export function buildRewritePrompt(essay: string, analysis: EssayAnalysis, review: FirstReview): string {
  return `请根据已经完成的批改，给学生作文写③整段改写示范。必须整段重写，不是零散换词；保持原意和${PAPER_LABELS[analysis.paperType]}要求，体现七特征与 AWL 升级。评语用中文，rewrite 必须是英文原文。\n\n${analysisBlock(analysis)}\n\n原作文：\n---\n${essay}\n---\n\n逐句批改：\n${JSON.stringify(review.corrections)}\n\n输出要求：只返回一个 JSON 对象，不要 Markdown 代码块或额外文字：
{"rewrite":"完整英文改写示范","improvements":["中文说明这版好在哪个特征或 AWL 升级"]}`;
}

const malformed = (): Error => new Error('模型返回格式不正确：需要符合批改约定的 JSON，请重试或更换模型。');

function jsonValue(content: string): Record<string, unknown> {
  const fenced = content.match(/^\s*```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?\s*```\s*$/i);
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1] : content); } catch { throw malformed(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed();
  return value as Record<string, unknown>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed();
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw malformed();
  return value.trim();
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) throw malformed();
  return value.map(item => text(item));
}

function correctionList(value: unknown): SentenceCorrection[] {
  if (!Array.isArray(value)) throw malformed();
  return value.map(item => {
    const correction = object(item);
    return {
      original: text(correction.original),
      kind: text(correction.kind),
      correction: text(correction.correction),
      why: text(correction.why),
    };
  });
}

export function parseFirstReview(content: string): FirstReview {
  const root = jsonValue(content);
  const summary = object(root.summary);
  const weakFeatures = summary.weakFeatures;
  if (!Array.isArray(weakFeatures) || weakFeatures.length < 1 || weakFeatures.length > 2) throw malformed();
  const corrections = root.corrections;
  const selfCheck = root.selfCheck;
  if (!Array.isArray(selfCheck) || selfCheck.length !== 3) throw malformed();
  const archive = object(root.archiveComparison);
  return {
    summary: {
      weakFeatures: weakFeatures.map(value => {
        const item = object(value);
        return { feature: text(item.feature), note: text(item.note) };
      }),
      oneThing: text(summary.oneThing),
      hardChecks: textList(summary.hardChecks),
    },
    corrections: correctionList(corrections),
    selfCheck: selfCheck.map(value => {
      const item = object(value);
      return { question: text(item.question), answer: text(item.answer) };
    }),
    archiveComparison: {
      recurring: textList(archive.recurring),
      newIssues: textList(archive.newIssues),
    },
  };
}

export function parseSentenceCorrections(content: string): SentenceCorrection[] {
  return correctionList(jsonValue(content).corrections);
}

export function parseRewriteReview(content: string): RewriteReview {
  const root = jsonValue(content);
  return { rewrite: text(root.rewrite), improvements: textList(root.improvements) };
}
