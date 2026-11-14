// 073 录入笔记的「识别任务」：放在页面外面的单例，切视图、切设置、进复习再回来都还在跑。
// 界面（InboxPanel、词库分段条、导航、完成提示）只订阅它的快照；快照每次变化都是新对象，可直接给 useSyncExternalStore。
// 依赖（识别函数、查现有词库、时钟、前后台状态）都能注入，单元测试用假的。
import { normalizeInboxWord, recognizeInboxImage, type InboxRecognizedWord, type InboxImage, type RecognizeHooks } from './inbox';
import {
  addPageToMerged,
  mergeNotePages,
  isVisionUnsupportedError,
  NOTE_CONCURRENCY,
  runPool,
  shouldWarnUnclear,
  VISION_UNSUPPORTED_TEXT,
  type NotePageResult,
} from './noteImport';
import type { NotePage } from './noteMedia';
import { getAIConfig, getEndpoint } from '../aiConfig';

export type PageStage = 'pending' | 'preparing' | 'uploading' | 'waiting' | 'streaming' | 'done' | 'failed' | 'cancelled';

export interface PageState {
  stage: PageStage;
  error?: string;
  /** 完成后认出几个词（合并前） */
  words?: number;
  /** 流式已收到字数 */
  chars?: number;
  /** 进入当前阶段的时刻（毫秒），界面用它算「已等 N 秒」 */
  stageSince: number;
  startedAt?: number;
  endedAt?: number;
  /** 这页是走流式拿到结果的 */
  streamed?: boolean;
  /** 提示小字，例如「刚才切到后台，已自动重试」 */
  hint?: string;
}

export interface NoteCandidate extends InboxRecognizedWord {
  id: string;
  checked: boolean;
  /** 用户手改过词目/备注：结束时的规范化不再覆盖它 */
  edited?: boolean;
  pageId?: string;
  /** 来自第几页（录入笔记识别出的候选才有） */
  pages: number[];
}

export type NoteSource = '手写' | 'Notion';

export interface NoteJobState {
  pages: NotePage[];
  states: Record<string, PageState>;
  /** 开始过识别：页面列表锁定，要改就点「重新选择」 */
  started: boolean;
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  model: string;
  candidates: NoteCandidate[];
  source: NoteSource;
  warnUnclear: boolean;
  notice: string;
  error: string;
  /** 全部结束时用户不在录笔记页：记下认出几个词，等提示条显示；看到后清空 */
  unseen: { words: number; failed: number } | null;
  viewing: boolean;
}

export const emptyState = (): NoteJobState => ({
  pages: [], states: {}, started: false, running: false, startedAt: null, finishedAt: null, model: '',
  candidates: [], source: '手写', warnUnclear: false, notice: '', error: '', unseen: null, viewing: false,
});

export type Recognizer = (
  image: InboxImage,
  hooks: RecognizeHooks,
  signal: { aborted: boolean },
) => Promise<InboxRecognizedWord[]>;

export interface Visibility {
  /** 累计「切到后台」次数 */
  hiddenCount: () => number;
  isHidden: () => boolean;
  waitVisible: () => Promise<void>;
}

export interface NoteJobDeps {
  recognize: Recognizer;
  browseExisting: () => Promise<Set<string>>;
  now: () => number;
  getModel: () => string;
  modelReady: () => boolean;
  newId: () => string;
  visibility: Visibility;
  concurrency: number;
}

export const BG_RETRY_HINT = '刚才切到后台，已自动重试';
export const NO_MODEL_TEXT = '请先在设置中配置 OpenAI 兼容接口、API Key 和视觉模型。';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
/** 底层报错原文已在 inbox.ts 清洗过，这里只补「不支持看图」提示。 */
export const pageErrorText = (error: unknown): string => {
  const message = errorText(error);
  return isVisionUnsupportedError(message) ? VISION_UNSUPPORTED_TEXT : message;
};
/** 连接失败 / 超时（可能是切后台被系统打断）；模型明确回了错误或格式不对的不算。 */
export const isInterruptError = (message: string): boolean =>
  message.startsWith('连接视觉模型失败') || message.startsWith('识别超时');

const SETTLED: PageStage[] = ['done', 'failed', 'cancelled'];
export const isSettled = (stage: PageStage | undefined): boolean => !!stage && SETTLED.includes(stage);

// ---------- 进度与时间（纯函数，界面和测试共用） ----------

/** 「1 分 20 秒」/「45 秒」。 */
export const formatDuration = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
};

/** 估算还要多久：已完成页的平均用时 × 还要跑几「轮」（每轮同时跑 concurrency 页）。没有完成页返回 null（估算中）。 */
export const estimateRemainingMs = (doneDurations: number[], remaining: number, concurrency = NOTE_CONCURRENCY): number | null => {
  if (remaining <= 0) return 0;
  if (doneDurations.length === 0) return null;
  const avg = doneDurations.reduce((sum, value) => sum + value, 0) / doneDurations.length;
  return avg * Math.ceil(remaining / Math.max(1, concurrency));
};

/** 「约 2 分钟」/「约 40 秒」（取整，不精确到秒）。 */
export const formatEstimate = (ms: number): string => {
  const seconds = Math.max(5, Math.round(ms / 5000) * 5);
  if (seconds < 60) return `约 ${seconds} 秒`;
  return `约 ${Math.ceil(seconds / 60)} 分钟`;
};

export interface JobProgress {
  total: number;
  settled: number;
  done: number;
  failed: number;
  running: number;
  elapsedMs: number;
  /** null = 估算中 */
  remainingMs: number | null;
}

export const progressOf = (state: NoteJobState, now: number, concurrency = NOTE_CONCURRENCY): JobProgress => {
  const list = state.pages.map(page => state.states[page.id]).filter((item): item is PageState => !!item);
  const doneList = list.filter(item => item.stage === 'done');
  const settled = list.filter(item => isSettled(item.stage)).length;
  const durations = doneList.map(item => (item.endedAt ?? now) - (item.startedAt ?? now)).filter(value => value >= 0);
  const end = state.finishedAt ?? now;
  return {
    total: state.pages.length,
    settled,
    done: doneList.length,
    failed: list.filter(item => item.stage === 'failed').length,
    running: list.filter(item => !isSettled(item.stage) && item.stage !== 'pending').length,
    elapsedMs: state.startedAt ? Math.max(0, end - state.startedAt) : 0,
    remainingMs: estimateRemainingMs(durations, state.pages.length - settled, concurrency),
  };
};

// ---------- 任务本体 ----------

export const createNoteJob = (deps: NoteJobDeps) => {
  let state: NoteJobState = emptyState();
  const listeners = new Set<() => void>();
  let runId = 0;
  let signal = { aborted: false };
  const wakes = new Set<() => void>();

  const emit = () => listeners.forEach(fn => fn());
  const set = (patch: Partial<NoteJobState> | ((current: NoteJobState) => Partial<NoteJobState>)) => {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    emit();
  };
  const setPage = (id: string, patch: Partial<PageState>, resetSince = false) => {
    const current = state.states[id] ?? { stage: 'pending' as PageStage, stageSince: deps.now() };
    const next: PageState = { ...current, ...patch };
    if (resetSince || (patch.stage && patch.stage !== current.stage)) next.stageSince = deps.now();
    set({ states: { ...state.states, [id]: next } });
  };

  const makeCandidate = (existing: Set<string>) => (item: { word: string; note: string; uncertain: boolean; pages: number[] }): NoteCandidate => ({
    ...item,
    id: `${deps.newId()}-${item.word}`,
    checked: !existing.has(normalizeInboxWord(item.word)),
  });
  let existingWords = new Set<string>();
  const results = new Map<string, NotePageResult>();

  /** 识别一页（含切后台后自动重试一次）；结果立刻并进候选。 */
  const processPage = async (page: NotePage, number: number, myRun: number): Promise<'done' | 'failed' | 'cancelled'> => {
    const live = () => myRun === runId && !signal.aborted;
    setPage(page.id, { stage: 'preparing', error: undefined, hint: undefined, chars: undefined, words: undefined, startedAt: deps.now(), endedAt: undefined, streamed: false });
    let retried = false;
    for (;;) {
      const epoch = deps.visibility.hiddenCount();
      let wake: () => void = () => {};
      const cancelled = new Promise<'cancelled'>(resolve => { wake = () => resolve('cancelled'); });
      wakes.add(wake);
      try {
        const hooks: RecognizeHooks = {
          onStage: stage => { if (live()) setPage(page.id, { stage }); },
          onChars: chars => { if (live()) setPage(page.id, { stage: 'streaming', chars, streamed: true }); },
        };
        const outcome = await Promise.race([
          deps.recognize({ base64: page.base64, mimeType: page.mimeType }, hooks, signal),
          cancelled,
        ]);
        if (outcome === 'cancelled' || !live()) return 'cancelled';
        results.set(page.id, { page: number, words: outcome });
        const makeFn = makeCandidate(existingWords);
        set(current => ({
          candidates: addPageToMerged<NoteCandidate>(current.candidates, number, outcome, makeFn),
        }));
        setPage(page.id, { stage: 'done', words: outcome.length, endedAt: deps.now() });
        return 'done';
      } catch (reason) {
        if (!live()) return 'cancelled';
        const text = pageErrorText(reason);
        if (!retried && isInterruptError(errorText(reason)) && deps.visibility.hiddenCount() !== epoch) {
          retried = true;
          setPage(page.id, { stage: 'preparing', hint: BG_RETRY_HINT, chars: undefined });
          await deps.visibility.waitVisible();
          if (!live()) return 'cancelled';
          continue;
        }
        setPage(page.id, { stage: 'failed', error: text, endedAt: deps.now() });
        return 'failed';
      } finally {
        wakes.delete(wake);
      }
    }
  };

  /**
   * 页是并发识别、完成顺序不定，边完成边合并出来的拼写/备注顺序可能和「按页码从小到大合并」不同。
   * 结束时按规范合并（mergeNotePages）把没被用户手改过的候选对齐，并按页码、页内顺序排好；勾选状态和 id 保留。
   */
  const canonicalize = (list: NoteCandidate[]): NoteCandidate[] => {
    const canon = mergeNotePages([...results.values()]);
    const order = new Map(canon.map((item, index) => [normalizeInboxWord(item.word), index] as const));
    const fixed = list.map(item => {
      const hit = item.edited ? undefined : canon.find(entry => normalizeInboxWord(entry.word) === normalizeInboxWord(item.word));
      return hit ? { ...item, word: hit.word, note: hit.note, uncertain: hit.uncertain, pages: hit.pages } : item;
    });
    return fixed.map((item, index) => ({ item, index }))
      .sort((a, b) => (a.item.pages[0] ?? 0) - (b.item.pages[0] ?? 0)
        || (order.get(normalizeInboxWord(a.item.word)) ?? 1e9) - (order.get(normalizeInboxWord(b.item.word)) ?? 1e9)
        || a.index - b.index)
      .map(entry => entry.item);
  };

  const finish = (myRun: number) => {
    if (myRun !== runId) return;
    const merged = canonicalize(state.candidates);
    const list = state.pages.map(page => state.states[page.id]);
    const failed = list.filter(item => item?.stage === 'failed').length;
    const okPages = list.filter(item => item?.stage === 'done').length;
    const wasCancelled = signal.aborted;
    const reallyResults = [...results.values()];
    const notice = wasCancelled
      ? `已取消。已识别的 ${okPages} 页保留，共 ${merged.length} 条候选。`
      : merged.length
        ? `识别出 ${merged.length} 条候选${failed ? `（有 ${failed} 页失败，可单独重试）` : ''}，请逐条检查后再确认。`
        : failed ? `有 ${failed} 页识别失败，可单独重试。` : '模型没有识别到词条，可以换更清晰的图片或 PDF。';
    set({
      running: false,
      finishedAt: deps.now(),
      candidates: merged,
      warnUnclear: reallyResults.length > 0 && shouldWarnUnclear(merged, reallyResults),
      notice,
      unseen: !wasCancelled && !state.viewing ? { words: merged.length, failed } : state.unseen,
    });
  };

  const api = {
    getState: () => state,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    /** 界面直接改任务里的东西（确认入库清空、Notion 拉取、编辑候选等）。 */
    set,
    concurrency: deps.concurrency,

    addPages(added: NotePage[]) {
      if (state.started || state.running || added.length === 0) return;
      const fresh = Object.fromEntries(added.map(page => [page.id, { stage: 'pending', stageSince: deps.now() } as PageState]));
      set(current => ({ pages: [...current.pages, ...added], states: { ...current.states, ...fresh } }));
    },
    removePage(id: string) {
      if (state.started || state.running) return;
      const { [id]: _gone, ...rest } = state.states;
      set(current => ({ pages: current.pages.filter(page => page.id !== id), states: rest }));
    },

    async start() {
      if (state.running || state.pages.length === 0) return;
      if (!deps.modelReady()) { set({ error: NO_MODEL_TEXT }); return; }
      const myRun = ++runId;
      signal = { aborted: false };
      results.clear();
      const pages = state.pages;
      set({
        started: true, running: true, startedAt: deps.now(), finishedAt: null, model: deps.getModel(),
        candidates: [], source: '手写', warnUnclear: false, notice: '', error: '', unseen: null,
        states: Object.fromEntries(pages.map(page => [page.id, { stage: 'pending', stageSince: deps.now() } as PageState])),
      });
      try {
        // 先只读现有词库，再请求模型；这一步没有任何数据库写入。
        existingWords = await deps.browseExisting();
        if (myRun !== runId) return;
        await runPool(pages, deps.concurrency, async (page, index) => { await processPage(page, index + 1, myRun); }, signal);
        finish(myRun);
      } catch (reason) {
        if (myRun === runId) set({ error: errorText(reason), running: false, finishedAt: deps.now() });
      }
    },

    cancel() {
      if (!state.running) return;
      signal.aborted = true;
      const now = deps.now();
      const states: Record<string, PageState> = { ...state.states };
      for (const page of state.pages) {
        const item = states[page.id];
        if (item && !isSettled(item.stage)) states[page.id] = { ...item, stage: 'cancelled', stageSince: now, endedAt: now };
      }
      set({ states });
      wakes.forEach(wake => wake());
      // 取消时 runPool 里的页会立刻返回，finish 由 start() 收尾；这里也兜底一次（start 已 await 完时幂等）。
    },

    /** 重试失败的一页：成功后并进现有候选（已改过的候选不动）。 */
    async retryPage(id: string) {
      if (state.running) return;
      const index = state.pages.findIndex(page => page.id === id);
      if (index < 0 || state.states[id]?.stage !== 'failed') return;
      const myRun = ++runId;
      signal = { aborted: false };
      set({ running: true, error: '', unseen: null, finishedAt: null });
      const outcome = await processPage(state.pages[index], index + 1, myRun);
      if (myRun !== runId) return;
      const okCount = state.pages.filter(page => state.states[page.id]?.stage === 'done').length;
      set({
        running: false,
        finishedAt: deps.now(),
        candidates: canonicalize(state.candidates),
        notice: outcome === 'done' ? `第 ${index + 1} 页重试成功，现有 ${state.candidates.length} 条候选。` : state.notice,
        warnUnclear: okCount > 0 && shouldWarnUnclear(state.candidates, [...results.values()]),
      });
    },

    /** 重新选择 / 确认入库后：清空整个任务（进行中的先取消）。 */
    reset() {
      if (state.running) { signal.aborted = true; wakes.forEach(wake => wake()); }
      runId++;
      results.clear();
      set({ ...emptyState(), viewing: state.viewing });
    },

    setViewing(viewing: boolean) {
      if (state.viewing === viewing) return;
      set(viewing ? { viewing, unseen: null } : { viewing });
    },
    dismissUnseen() { if (state.unseen) set({ unseen: null }); },
  };
  return api;
};

export type NoteJob = ReturnType<typeof createNoteJob>;

// ---------- 真实环境用的单例 ----------

const realVisibility = (): Visibility => {
  let hidden = 0;
  const waiters = new Set<() => void>();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) hidden++;
      else { waiters.forEach(fn => fn()); waiters.clear(); }
    });
  }
  return {
    hiddenCount: () => hidden,
    isHidden: () => typeof document !== 'undefined' && document.hidden,
    waitVisible: () => (typeof document === 'undefined' || !document.hidden)
      ? Promise.resolve()
      : new Promise<void>(resolve => { waiters.add(resolve); }),
  };
};

export const noteJob: NoteJob = createNoteJob({
  recognize: async (image, hooks, signal) => recognizeInboxImage(image, { hooks, signal }),
  browseExisting: async () => {
    const { vocabApi } = await import('./api');
    const data = await vocabApi.browse();
    return new Set(data.reviewWords.map(item => normalizeInboxWord(item.word)));
  },
  now: () => Date.now(),
  getModel: () => getAIConfig().model.trim(),
  modelReady: () => !!getEndpoint() && !!getAIConfig().model.trim(),
  newId: () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  visibility: realVisibility(),
  concurrency: NOTE_CONCURRENCY,
});

// ---------- 「去录笔记」请求：完成提示条点了之后，让词库页切到录笔记 ----------

const OPEN_EVENT = 'es-open-inbox';
let pendingOpen = false;
export const requestOpenInbox = () => {
  pendingOpen = true;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_EVENT));
};
export const consumeOpenInbox = (): boolean => { const value = pendingOpen; pendingOpen = false; return value; };
export const onOpenInbox = (fn: () => void): (() => void) => {
  window.addEventListener(OPEN_EVENT, fn);
  return () => window.removeEventListener(OPEN_EVENT, fn);
};
