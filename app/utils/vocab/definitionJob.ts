// 078「一键补全英英释义」后台任务：放在页面外面的单例，切页面不中断（做法同 073 noteJob）。
// 依赖（查词典、存库、判断这个词有没有英英释义）都能注入，单元测试用假的。
// 限速不在这里：在线查词的限速在 definitionEnDict.ts 的 throttleOnline（每秒不超过 2 个），本地词典不限。
import { findDictDefinitions } from './definitionEn';
import type { DictFinder, DictFound } from './definitionEn';

export interface DefinitionJobState {
  running: boolean;
  /** 要处理几个词（已跳过有英英释义的）。 */
  total: number;
  /** 已处理几个（查到的 + 查不到的）。 */
  done: number;
  /** 补上了几个词。 */
  found: number;
  /** 查不到几个词。 */
  missing: number;
  cancelled: boolean;
  /** 跑完或取消后为 true；开新一轮时清掉。 */
  finished: boolean;
  /** 最近一个处理的词，进度条下面显示。 */
  current: string;
  error: string;
}

export const emptyJobState = (): DefinitionJobState => ({
  running: false, total: 0, done: 0, found: 0, missing: 0, cancelled: false, finished: false, current: '', error: '',
});

export interface DefinitionJobDeps {
  find: DictFinder;
  /** 这个词现在有没有英英释义（导入的、存下的、自己写的都算）：有就跳过。 */
  hasEnglish: (word: string) => Promise<boolean> | boolean;
  /** 把查到的存进词库。 */
  save: (word: string, found: DictFound) => Promise<void>;
}

/** 结束后的一句话报告。 */
export function jobReport(state: DefinitionJobState): string {
  if (!state.finished) return '';
  const head = state.cancelled ? '已取消，' : '';
  return `${head}补了 ${state.found} 个，查不到 ${state.missing} 个${state.cancelled ? `（还有 ${Math.max(0, state.total - state.done)} 个没处理，已补的保留）` : ''}`;
}

export function createDefinitionJob(deps: DefinitionJobDeps) {
  let state = emptyJobState();
  let token = { cancelled: false };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<DefinitionJobState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  async function run(words: string[], mine: { cancelled: boolean }) {
    // 先过滤掉已经有英英释义的词（同一个词只算一次）。
    const todo: string[] = [];
    const seen = new Set<string>();
    for (const word of words) {
      const key = word.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (!(await deps.hasEnglish(word))) todo.push(word);
    }
    set({ total: todo.length });
    for (const word of todo) {
      if (mine.cancelled) break;
      set({ current: word });
      // 查词前再看一眼：用户可能已经在别处给它写了释义。
      if (await deps.hasEnglish(word)) { set({ total: state.total - 1 }); continue; }
      const found = await findDictDefinitions(word, deps.find);
      if (mine.cancelled) break;
      if (found) {
        try {
          await deps.save(word, found);
          set({ done: state.done + 1, found: state.found + 1 });
        } catch (error) {
          set({ done: state.done + 1, missing: state.missing + 1, error: error instanceof Error ? error.message : String(error) });
        }
      } else {
        set({ done: state.done + 1, missing: state.missing + 1 });
      }
    }
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** 开始一轮；已经在跑就忽略。返回这一轮结束时的 Promise（测试用）。 */
    start(words: string[]): Promise<void> {
      if (state.running) return Promise.resolve();
      const mine = { cancelled: false };
      token = mine;
      state = { ...emptyJobState(), running: true };
      set({});
      return run(words, mine)
        .catch(error => set({ error: error instanceof Error ? error.message : String(error) }))
        .then(() => set({ running: false, finished: true, cancelled: mine.cancelled, current: '' }));
    },
    cancel() {
      if (state.running) { token.cancelled = true; set({ cancelled: true }); }
    },
    /** 看完报告后清掉，回到空闲。 */
    dismiss() { if (!state.running) set(emptyJobState()); },
  };
}

export type DefinitionJob = ReturnType<typeof createDefinitionJob>;

/** 限速器：两次在线查词至少隔 minMs（每秒不超过 2 个）。时钟和等待都能注入，测试用假的。 */
export function createThrottle(minMs: number, now: () => number = Date.now, sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))) {
  let next = 0;
  return async () => {
    const at = Math.max(now(), next);
    next = at + minMs;
    const wait = at - now();
    if (wait > 0) await sleep(wait);
  };
}
