import type { DueWord } from './due';

/**
 * 翻面闪卡的状态与键盘规则（014）。纯函数，不碰数据库：闪卡只帮助查看和回忆，
 * 不改学习等级、到期日或「已掌握」。
 */

export interface FlashState {
  /** 进入时固定的一份队列；本次复习过程中不再变。 */
  readonly queue: readonly DueWord[];
  readonly index: number;
  /** false = 正面（词目和期号），true = 背面（备注、状态、到期日）。 */
  readonly flipped: boolean;
}

/** 开始复习：复制一份队列固定下来；空队列返回 null（不出现空闪卡）。 */
export function startSession(queue: readonly DueWord[]): FlashState | null {
  if (queue.length === 0) return null;
  return { queue: Object.freeze([...queue]), index: 0, flipped: false };
}

export function flip(state: FlashState): FlashState {
  return { ...state, flipped: !state.flipped };
}

export function canPrev(state: FlashState): boolean {
  return state.index > 0;
}

export function canNext(state: FlashState): boolean {
  return state.index < state.queue.length - 1;
}

export function isLast(state: FlashState): boolean {
  return state.index === state.queue.length - 1;
}

/** 下一张：到尾不动；切卡总是回到正面。 */
export function next(state: FlashState): FlashState {
  return canNext(state) ? { ...state, index: state.index + 1, flipped: false } : state;
}

/** 上一张：到头不动；切卡总是回到正面。 */
export function prev(state: FlashState): FlashState {
  return canPrev(state) ? { ...state, index: state.index - 1, flipped: false } : state;
}

export function currentCard(state: FlashState): DueWord {
  return state.queue[state.index];
}

/** 进度文字和百分比；队列一定非空，所以不会出现 NaN。 */
export function progress(state: FlashState): { label: string; percent: number } {
  const total = state.queue.length;
  const current = state.index + 1;
  return { label: `${current} / ${total}`, percent: Math.round((current / total) * 100) };
}

export type FlashKey = 'exit' | 'prev' | 'next' | 'flip';

/** 只取判断需要的字段，测试里可以直接传普通对象。 */
export interface KeyLike {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target?: unknown;
}

/** 焦点是否在输入控件里（输入框、多行文本、下拉框、可编辑区域）。 */
export function isEditableTarget(target: unknown): boolean {
  if (target === null || typeof target !== 'object') return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  const tag = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable === true;
}

/**
 * 把按键翻译成闪卡动作；不是闪卡的键返回 null（留给页面其他功能）。
 * 只在闪卡活动时处理；输入法组字中、带 Ctrl/⌘/Alt 的组合键、焦点在输入控件里都不处理。
 */
export function keyAction(event: KeyLike, active: boolean): FlashKey | null {
  if (!active) return null;
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (isEditableTarget(event.target)) return null;
  switch (event.key) {
    case 'Escape': return 'exit';
    case 'ArrowLeft': return 'prev';
    case 'ArrowRight': return 'next';
    case ' ':
    case 'Spacebar': return 'flip';
    default: return null;
  }
}

export interface KeyTarget {
  addEventListener(type: 'keydown', listener: (event: KeyboardEvent) => void, capture: boolean): void;
  removeEventListener(type: 'keydown', listener: (event: KeyboardEvent) => void, capture: boolean): void;
}

/**
 * 在 target（通常是 window）上挂一个捕获阶段的 keydown 监听，返回解除函数。
 * 认出的闪卡键会 preventDefault + stopPropagation，不会再传到听写等其他快捷键；其他键原样放行。
 * 解除函数可重复调用，只解除一次。
 */
export function attachFlashKeys(target: KeyTarget, onAction: (action: FlashKey) => void, isActive: () => boolean = () => true): () => void {
  const listener = (event: KeyboardEvent) => {
    const action = keyAction(event, isActive());
    if (action === null) return;
    event.preventDefault();
    event.stopPropagation();
    onAction(action);
  };
  target.addEventListener('keydown', listener, true);
  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    target.removeEventListener('keydown', listener, true);
  };
}
