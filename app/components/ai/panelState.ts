// 091 AI 小窗的界面状态：收起（记在本机）、浮层/抽屉是否打开、当前页面登记的「关于哪个词」、窗口布局档位。
// 任务本身在 utils/aiTasks（090），这里只管界面。
import { useEffect, useState, useSyncExternalStore } from 'react';
import { IS_MOBILE } from '../../utils/platform';

export const AI_PANEL_COLLAPSED_KEY = 'english-studio.ai-panel.collapsed';
/** 电脑上放得下一栏侧栏的最小窗口宽度（小于它改成浮层） */
export const DOCK_MIN_WIDTH = 1280;
/** 手机判断：真手机，或窗口窄到跟手机一样（电脑窗口拖很窄、测试里模拟 390 宽） */
export const MOBILE_MAX_WIDTH = 640;
export const DOCK_WIDTH = 360;
export const STRIP_WIDTH = 40;

export type PanelMode = 'dock' | 'float' | 'mobile';

export const panelModeFor = (width: number, mobileUa: boolean = IS_MOBILE): PanelMode =>
  mobileUa || width < MOBILE_MAX_WIDTH ? 'mobile' : width >= DOCK_MIN_WIDTH ? 'dock' : 'float';

interface PanelSnapshot { collapsed: boolean; open: boolean }

const readCollapsed = (): boolean => {
  try { return localStorage.getItem(AI_PANEL_COLLAPSED_KEY) === '1'; } catch { return false; }
};

let snapshot: PanelSnapshot = { collapsed: readCollapsed(), open: false };
const listeners = new Set<() => void>();
const set = (next: Partial<PanelSnapshot>) => {
  const merged = { ...snapshot, ...next };
  if (merged.collapsed === snapshot.collapsed && merged.open === snapshot.open) return;
  snapshot = merged;
  listeners.forEach(fn => fn());
};

// 「请展开这一条」：随手记点了「问 AI」，小窗要自动展开到这条任务。epoch 每次 +1，面板据此只响应新的一次。
interface FocusSnapshot { id: string | null; epoch: number }
let focus: FocusSnapshot = { id: null, epoch: 0 };
const focusListeners = new Set<() => void>();

export const aiPanelState = {
  get: () => snapshot,
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  setCollapsed(collapsed: boolean) {
    try { localStorage.setItem(AI_PANEL_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch { /* 存不下就算了 */ }
    set({ collapsed });
  },
  setOpen(open: boolean) { set({ open }); },
  /** 展开小窗（电脑侧栏取消收起；浮层 / 抽屉打开），并让它展开这条任务。 */
  reveal(taskId: string) {
    focus = { id: taskId, epoch: focus.epoch + 1 };
    focusListeners.forEach(fn => fn());
    aiPanelState.setCollapsed(false);
    set({ open: true });
  },
  getFocus: () => focus,
  subscribeFocus(fn: () => void) { focusListeners.add(fn); return () => { focusListeners.delete(fn); }; },
};

// 「请展开这一条」已经被面板处理过的最后一次 epoch（模块级，面板卸载再挂载也记得）。
// 小窗收起时 reveal 发生在面板挂载之前，挂载后要补上这一次，否则定位不到刚建的任务（093）。
let appliedFocusEpoch = 0;
export const focusAppliedEpoch = (): number => appliedFocusEpoch;
export const markFocusApplied = (epoch: number): void => { appliedFocusEpoch = Math.max(appliedFocusEpoch, epoch); };

export const useAiPanelState = (): PanelSnapshot => useSyncExternalStore(aiPanelState.subscribe, aiPanelState.get);
export const useAiFocus = (): FocusSnapshot => useSyncExternalStore(aiPanelState.subscribeFocus, aiPanelState.getFocus);

export function usePanelMode(): PanelMode {
  const [mode, setMode] = useState<PanelMode>(() => panelModeFor(typeof window === 'undefined' ? 1440 : window.innerWidth));
  useEffect(() => {
    const update = () => setMode(panelModeFor(window.innerWidth));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return mode;
}

// ---------- 当前页面「关于哪个词」：词条详情、闪卡挂载时登记，最后登记的优先 ----------

const words: { id: object; word: string }[] = [];
const wordListeners = new Set<() => void>();
/** epoch 每次登记 / 注销都 +1：换了页面（哪怕还是同一个词），用户之前点的 × 就作废。 */
export interface ContextWord { word: string | null; epoch: number }
let currentWord: ContextWord = { word: null, epoch: 0 };
const refreshWord = () => {
  currentWord = { word: words.length > 0 ? words[words.length - 1].word : null, epoch: currentWord.epoch + 1 };
  wordListeners.forEach(fn => fn());
};

/** 页面里调用：这个词正显示着，小窗直接问时可以带上。word 为空就不登记。 */
export function useAiContextWord(word: string | null | undefined): void {
  useEffect(() => {
    const text = word?.trim();
    if (!text) return undefined;
    const entry = { id: {}, word: text };
    words.push(entry);
    refreshWord();
    return () => {
      const index = words.indexOf(entry);
      if (index >= 0) words.splice(index, 1);
      refreshWord();
    };
  }, [word]);
}

export const useCurrentContextWord = (): ContextWord =>
  useSyncExternalStore(fn => { wordListeners.add(fn); return () => { wordListeners.delete(fn); }; }, () => currentWord);
