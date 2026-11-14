import { postChat } from './recallModel';

/**
 * 048 例句场景标注（测试：node test-vocab-scenes.mjs）。
 *
 * - 10 个固定标签，界面显示英文，悬停看中文。
 * - 标签按「规范化后的句子文字」存：规则和后端 `vocab/scenes.rs` 的 `scene_key` 一致（弯引号统一、合并空白、去首尾空白、转小写）。
 * - 发给模型的只有：这个词、要标的句子、10 个标签的说明；不发笔记、备注、中文释义。
 */

export const SCENES = [
  { id: 'definition', zh: '下定义', hint: 'defines or explains what something is' },
  { id: 'statement', zh: '陈述事实或观点', hint: 'states a fact, claim or opinion' },
  { id: 'evidence', zh: '引用数据或研究', hint: 'cites data, a study or a source as evidence' },
  { id: 'explanation', zh: '解释说明', hint: 'explains how or why something works or happens, or clarifies a point' },
  { id: 'cause-effect', zh: '因果', hint: 'links a cause to its effect or result' },
  { id: 'comparison', zh: '比较和对比', hint: 'compares or contrasts two or more things' },
  { id: 'concession', zh: '让步', hint: 'admits a limit or opposing point before the main point (although, despite)' },
  { id: 'evaluation', zh: '评价', hint: 'judges or assesses how good, important or effective something is' },
  { id: 'recommendation', zh: '建议', hint: 'recommends or proposes an action' },
  { id: 'summary', zh: '总结', hint: 'sums up or concludes what was said' },
] as const;

export type SceneId = typeof SCENES[number]['id'];

const SCENE_IDS: ReadonlySet<string> = new Set(SCENES.map(scene => scene.id));
export const isSceneId = (value: unknown): value is SceneId => typeof value === 'string' && SCENE_IDS.has(value);

/** 悬停/长按显示的中文，例如「comparison · 比较和对比」。 */
export function sceneTitle(id: string): string {
  const scene = SCENES.find(item => item.id === id);
  return scene ? `${scene.id} · ${scene.zh}` : id;
}

/** 句子的规范化键（和后端 `scene_key` 同一规则）。 */
export function sceneKey(sentence: string): string {
  return sentence
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** 去重（按规范化键），保留第一次出现的原文，丢掉空句。 */
export function uniqueSentences(sentences: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sentence of sentences) {
    const key = sceneKey(sentence);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(sentence.split(/\s+/).filter(Boolean).join(' '));
  }
  return out;
}

/** 提示词：只有词、编号的句子、标签说明。导出供测试核对。 */
export function buildScenePrompt(word: string, sentences: readonly string[]): string {
  const labels = SCENES.map(scene => `- ${scene.id}: ${scene.hint}`).join('\n');
  const items = sentences.map((sentence, index) => ({ id: index + 1, sentence }));
  return `You label example sentences by the writing purpose they would serve in an academic essay.

Target expression: ${JSON.stringify(word.trim())}

For each sentence below, pick exactly ONE label that best describes the main purpose of the sentence. Allowed labels:
${labels}

Sentences:
${JSON.stringify(items, null, 2)}

Return only one JSON object, no Markdown, exactly in this shape:
{"scenes":[{"id":1,"scene":"<one allowed label>"}]}`;
}

export interface SceneLabel { sentence: string; scene: SceneId }

/**
 * 解析模型回复。只认完整 JSON 或完整 Markdown 代码块；整体格式错抛中文错误。
 * 单句的标签不在列表里、编号不存在、同一句重复给：那一句就当没标（只取第一次出现的有效标签）。
 */
export function parseSceneLabels(content: string, sentences: readonly string[]): SceneLabel[] {
  const fenced = content.match(/^\s*```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?\s*```\s*$/i);
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1] : content); } catch { throw malformed(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed();
  const list = (value as { scenes?: unknown }).scenes;
  if (!Array.isArray(list)) throw malformed();
  const picked = new Map<number, SceneId>();
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const { id, scene } = item as { id?: unknown; scene?: unknown };
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > sentences.length) continue;
    if (!isSceneId(scene) || picked.has(id)) continue;
    picked.set(id, scene);
  }
  return [...picked.entries()].sort((a, b) => a[0] - b[0]).map(([id, scene]) => ({ sentence: sentences[id - 1], scene }));
}

const malformed = (): Error => new Error('模型返回格式不正确：需要 {"scenes":[{"id":1,"scene":"…"}]}。');

/** 一个词一次请求。没配模型、断网、格式错都会抛中文错误，调用方自己决定吞掉。 */
export async function requestSceneLabels(word: string, sentences: readonly string[], options: { timeoutMs?: number } = {}): Promise<SceneLabel[]> {
  const list = uniqueSentences(sentences);
  if (list.length === 0) return [];
  const content = await postChat(buildScenePrompt(word, list), options.timeoutMs);
  return parseSceneLabels(content, list);
}
