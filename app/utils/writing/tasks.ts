import { aiTasks, type AiTask, type AiTaskCenter, type CreateTaskOutcome } from '../aiTasks';
import { getAIConfig, getEndpoint } from '../aiConfig';
import {
  buildWritingReviewPrompt, buildWritingTaskPrompt, getWritingScene, writingAnswerError,
  type WritingReviewResult, type WritingSceneId, type WritingTaskArgs, type WritingTaskResult, type WritingWord,
  type WritingReviewArgs,
} from './model';
import {
  createWritingRecord, defaultWritingStorage, getWritingRecord, saveWritingReview,
  saveWritingTaskResult, updateWritingRecord, type WritingItem, type WritingRecordOptions, type WritingStorage,
} from './records';

export const WRITING_TASK_KIND = 'writing-task';
export const WRITING_REVIEW_KIND = 'writing-review';
export const WRITING_NOT_CONFIGURED = '尚未配置模型：请先在「设置」填写接口地址、API Key 和模型名称。';

export interface WritingTaskOptions extends WritingRecordOptions {
  /** 测试可注入任务中心；界面不用传。 */
  center?: AiTaskCenter;
  /** 测试可注入模型配置检查；界面不用传。 */
  configured?: () => boolean;
}

const modelConfigured = (): boolean => !!getEndpoint() && !!getAIConfig().model.trim();
const storageOf = (options: WritingRecordOptions): WritingStorage | null => options.storage === undefined ? defaultWritingStorage() : options.storage ?? null;

/** 把一条已完成的写作任务抄进独立记录。任务中心以后清掉旧任务，记录仍在。 */
function mirrorTask(task: AiTask, storage: WritingStorage | null, options: WritingRecordOptions): void {
  if (task.status !== 'done' || !task.source.ref || !task.result) return;
  if (task.source.kind === WRITING_TASK_KIND) {
    const current = getWritingRecord(task.source.ref, { ...options, storage });
    if (current && current.taskId === task.id && JSON.stringify(current.task) !== JSON.stringify(task.result)) {
      saveWritingTaskResult(current.id, task.result as WritingTaskResult, { ...options, storage });
    }
  } else if (task.source.kind === WRITING_REVIEW_KIND) {
    const current = getWritingRecord(task.source.ref, { ...options, storage });
    // 再次批改时，旧任务仍留在中心里；只许当前 reviewTaskId 写记录，避免旧结果盖掉新一轮。
    if (current && (!current.reviewTaskId || current.reviewTaskId === task.id) && JSON.stringify(current.review) !== JSON.stringify(task.result)) {
      saveWritingReview(current.id, task.result as WritingReviewResult, task.id, { ...options, storage });
    }
  }
}

export function syncWritingRecords(center: AiTaskCenter = aiTasks, options: WritingRecordOptions = {}): void {
  const storage = storageOf(options);
  for (const task of center.getTasks()) mirrorTask(task, storage, options);
}

// 一个任务中心只挂一个订阅；重启后第一次载入本模块也会先扫一遍已存任务。
const mirroredCenters = new WeakMap<AiTaskCenter, true>();
function ensureMirror(center: AiTaskCenter, options: WritingRecordOptions = {}): void {
  syncWritingRecords(center, options);
  if (mirroredCenters.has(center)) return;
  mirroredCenters.set(center, true);
  center.subscribe(() => syncWritingRecords(center, options));
}

/** 测试或重建任务中心后重新接上“完成 → 记录”的镜像；真实单例在模块载入时已自动接上。 */
export function watchWritingTasks(center: AiTaskCenter = aiTasks, options: WritingRecordOptions = {}): void {
  ensureMirror(center, options);
}

/** 建出题记任务，同时先建一条记录；完成后题目自动抄入记录。0 个建议用词也能出题。 */
export function startWritingTask(sceneId: WritingSceneId, words: readonly WritingWord[], options: WritingTaskOptions = {}): CreateTaskOutcome {
  const configured = options.configured ?? modelConfigured;
  if (!configured()) return { ok: false, reason: WRITING_NOT_CONFIGURED };
  const scene = getWritingScene(sceneId);
  if (!scene) return { ok: false, reason: '请选择雅思、四六级或学术场景。' };
  const center = options.center ?? aiTasks;
  const storage = storageOf(options);
  const cleanWords = words.map(word => ({ ...word }));
  const recordId = (options.newId ?? (() => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`))();
  const args: WritingTaskArgs = { scene: scene.id, words: cleanWords };
  const made = center.create({
    title: `写作出题：${scene.nameZh}`,
    source: { kind: WRITING_TASK_KIND, ref: recordId },
    prompt: buildWritingTaskPrompt(scene, cleanWords),
    shown: `出一道${scene.nameZh}小写作题（2–4 句）`,
    mode: 'task',
    resultKind: WRITING_TASK_KIND,
    resultArgs: args,
  });
  if (!made.ok) return made;
  // 记录沿用预先放进 source.ref 的 id，任务和记录才能互相对应。
  const created = createWritingRecord(scene.id, cleanWords, made.task.id, { ...options, storage, newId: () => recordId });
  if (!created) return { ok: false, reason: '无法建立写作记录。' };
  ensureMirror(center, { ...options, storage });
  syncWritingRecords(center, { ...options, storage });
  return made;
}

/** 建批改任务。空作答或明显不是英文直接给中文原因，不建任务。 */
export function startWritingReview(item: WritingItem, answer: string, options: WritingTaskOptions = {}): CreateTaskOutcome {
  const configured = options.configured ?? modelConfigured;
  if (!configured()) return { ok: false, reason: WRITING_NOT_CONFIGURED };
  const answerError = writingAnswerError(answer);
  if (answerError) return { ok: false, reason: answerError };
  const scene = getWritingScene(item.scene);
  if (!scene) return { ok: false, reason: '这条写作记录的场景无法识别。' };
  if (!item.task || item.task.error || !item.task.prompt) return { ok: false, reason: '这道题还没有出好，请先重试出题。' };
  const center = options.center ?? aiTasks;
  const storage = storageOf(options);
  const args: WritingReviewArgs = { recordId: item.id, words: item.words.map(word => ({ ...word })) };
  const made = center.create({
    title: `写作批改：${scene.nameZh}`,
    source: { kind: WRITING_REVIEW_KIND, ref: item.id },
    prompt: buildWritingReviewPrompt(scene, item.task, answer, item.words),
    shown: `批改我的${scene.nameZh}小写作（2–4 句）`,
    mode: 'task',
    resultKind: WRITING_REVIEW_KIND,
    resultArgs: args,
  });
  if (!made.ok) return made;
  updateWritingRecord(item.id, { answer, review: null, reviewTaskId: made.task.id }, { ...options, storage });
  ensureMirror(center, { ...options, storage });
  syncWritingRecords(center, { ...options, storage });
  return made;
}

/** 按记录 id 找最近的出题任务，tasks 新的在前。 */
export function findWritingTask(recordId: string, tasks: readonly AiTask[] = aiTasks.getTasks()): AiTask | undefined {
  return tasks.find(task => task.source.kind === WRITING_TASK_KIND && task.source.ref === recordId);
}

/** 按记录 id 找最近的批改任务，tasks 新的在前。 */
export function findWritingReview(recordId: string, tasks: readonly AiTask[] = aiTasks.getTasks()): AiTask | undefined {
  return tasks.find(task => task.source.kind === WRITING_REVIEW_KIND && task.source.ref === recordId);
}

// 真实应用重启：模块载入即读回任务并补抄结果，之后的重试也由订阅接住。
ensureMirror(aiTasks);