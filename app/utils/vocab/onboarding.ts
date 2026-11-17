// 079 首次引导：什么时候自动出现、从哪里重新打开、测试结果存在哪。本机 localStorage（跟 081 的学习计划缓存一样的做法）。
import type { LevelResult } from './levelTest';

const KEY = 'worddrip_onboarding';
const RESULT_KEY = 'worddrip_level_result';
const OPEN_EVENT = 'vocab-onboarding-open';
const RESULT_EVENT = 'vocab-level-result-changed';

/** 引导从哪一步开始：目标 → 测试 → 每天几个。 */
export type OnboardingStep = 'goal' | 'test' | 'perday';
export interface OpenRequest { step: OnboardingStep; /** 只做这一步（设置里的「重新选目标 / 重新测」），做完直接关掉 */ single: boolean }

/** 做过或跳过引导了吗（是就不再自动弹）。 */
export function onboardingDone(): boolean {
  try { return localStorage.getItem(KEY) === 'done'; } catch { return false; }
}
export function markOnboardingDone(): void {
  try { localStorage.setItem(KEY, 'done'); } catch { /* 存不了就下次再问 */ }
}

/** 该不该自动弹：没做完或跳过，而且词库还是空的；中途关窗后即使已保存目标也要继续引导。 */
export function shouldAutoShow(libraryCount: number): boolean {
  return !onboardingDone() && libraryCount === 0;
}

export function openOnboarding(request: OpenRequest = { step: 'goal', single: false }): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<OpenRequest>(OPEN_EVENT, { detail: request }));
}
export function onOpenOnboarding(listener: (request: OpenRequest) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<OpenRequest>).detail);
  window.addEventListener(OPEN_EVENT, handler);
  return () => window.removeEventListener(OPEN_EVENT, handler);
}

export interface StoredResult extends LevelResult { date: string }

export function getLevelResult(): StoredResult | null {
  try {
    const raw = localStorage.getItem(RESULT_KEY);
    const value = raw ? JSON.parse(raw) : null;
    return value && typeof value.estimate === 'number' && typeof value.date === 'string' ? value as StoredResult : null;
  } catch { return null; }
}
export function saveLevelResult(result: StoredResult): void {
  try { localStorage.setItem(RESULT_KEY, JSON.stringify(result)); } catch { /* ignore */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(RESULT_EVENT));
}
export function onLevelResultChanged(listener: () => void): () => void {
  window.addEventListener(RESULT_EVENT, listener);
  return () => window.removeEventListener(RESULT_EVENT, listener);
}
