// 090 全局 AI 任务中心：任务在模块级状态里跑，不依赖组件；切页面不会断。
// 写法照 073 的 noteJob：单例 + 订阅，快照每次变化都是新对象，可直接给 useSyncExternalStore。
// 依赖（真正发请求的函数、本机存储、时钟）都能注入，单元测试用假的。
// 本机只保留最近 20 条，不同步，不进设置快照（不要加进 settingsBackupLogic 的 SETTINGS_KEYS），也不存 API key。

export type AiTaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** 任务来源：随手记 / 例句 / 直接问…… 带词或随手记 id，方便原页面找回自己的任务。 */
export interface AiTaskSource {
  kind: string;
  word?: string;
  noteId?: string;
  /** 例句等细分位置，由调用方自己约定 */
  ref?: string;
}

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 助手这条回复的思考内容（有就存，界面可折叠显示） */
  thinking?: string;
  /** 用户这条气泡里显示的字（没有就显示 content）。发给模型的 content 可以带上前缀，气泡只显示用户打的字。 */
  shown?: string;
}

export interface AiTask {
  id: string;
  title: string;
  source: AiTaskSource;
  /** direct = 用户直接问（受作答锁限制）；task = 随手记、例句等后台任务 */
  mode: 'direct' | 'task';
  status: AiTaskStatus;
  /** 已完成的问答（用户、助手交替；追问时整串带给模型）。进行中的这条回复在 text / thinking 里。 */
  messages: AiMessage[];
  /** 当前（最近一次）回复的正文，流式中边收边长 */
  text: string;
  thinking: string;
  /** 结构化结果（可选，由 parseResult 解析正文得到，必须能 JSON 化） */
  result?: unknown;
  /** 结构化结果的类型名（093）：重启后按它从 deps.resultParsers 找回解析函数，点「重试」照样出结果。 */
  resultKind?: string;
  /** 解析时要用的参数（093，必须能 JSON 化，和 resultKind 一起存盘）。 */
  resultArgs?: unknown;
  error?: string;
  /** 重启时发现它还在「进行中」，被标成中断 */
  interrupted?: boolean;
  /** 这次回复是真的流式收到的 */
  streamed?: boolean;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** 收到第一块内容的时刻，界面可算「首字等了多久」 */
  firstChunkAt?: number;
}

export interface AiStreamArgs {
  messages: AiMessage[];
  system?: string;
  temperature?: number;
  signal: AbortSignal;
  onText: (delta: string) => void;
  onThink: (delta: string) => void;
}

export interface AiStreamResult { text: string; thinking: string; streamed: boolean }

export interface AiStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 结构化结果的解析函数：正文 + 任务存的 resultArgs → 结果（抛错即没有结果）。 */
export type ResultParser = (text: string, args: unknown) => unknown;

export interface AiCenterDeps {
  /** 真正发请求；报错时抛 Error（message 已是给用户看的中文）。取消时抛任意错误即可，中心自己认取消。 */
  run: (args: AiStreamArgs) => Promise<AiStreamResult>;
  storage: AiStorage | null;
  now: () => number;
  newId: () => string;
  /** 按 resultKind 找解析函数（093）：启动后、重试时都用它，不靠内存里的闭包。 */
  resultParsers?: Record<string, ResultParser>;
  /** 把底层错误变成一句话；默认取 message */
  errorText?: (error: unknown) => string;
  /** 同时跑几个，其余排队；默认 3 */
  maxConcurrent?: number;
  keep?: number;
}

export interface CreateTaskInput {
  title: string;
  source: AiTaskSource;
  /** 第一条用户消息 */
  prompt: string;
  system?: string;
  temperature?: number;
  mode?: 'direct' | 'task';
  /** 从正文解析结构化结果；抛错或返回 undefined 都不影响任务完成（只在本次运行有效，不存盘；要存盘用 resultKind） */
  parseResult?: (text: string) => unknown;
  /** 结构化结果的类型名：解析函数登记在 deps.resultParsers 里，任务存盘后重启也能用。 */
  resultKind?: string;
  /** 解析参数（必须能 JSON 化），和 resultKind 一起存盘。 */
  resultArgs?: unknown;
  /** 第一条用户气泡里显示的字（不给就显示 prompt） */
  shown?: string;
}

export type CreateTaskOutcome = { ok: true; task: AiTask } | { ok: false; reason: string };

export const AI_TASKS_STORAGE_KEY = 'english-studio.ai-tasks.v1';
export const AI_TASKS_KEEP = 20;
export const INTERRUPTED_TEXT = '中断了，可重试';
export const LOCKED_TEXT = '正在作答，暂时不能直接提问。';

export const createAiTaskCenter = (deps: AiCenterDeps) => {
  const keep = deps.keep ?? AI_TASKS_KEEP;
  const maxConcurrent = Math.max(1, deps.maxConcurrent ?? 3);
  const errorText = deps.errorText ?? ((error: unknown) => (error instanceof Error ? error.message : String(error)));
  let tasks: AiTask[] = []; // 新的在前
  const listeners = new Set<() => void>();
  const taskListeners = new Map<string, Set<() => void>>();
  const lockListeners = new Set<() => void>();
  // 运行时才有的东西（函数、取消器），不存盘。
  const controllers = new Map<string, AbortController>();
  const runtime = new Map<string, { system?: string; temperature?: number; parseResult?: (text: string) => unknown }>();
  /** 每次开跑 +1；旧的一轮迟到的增量/结果据此丢弃 */
  const generation = new Map<string, number>();
  let lock: string | null = null;

  const emit = (id?: string) => {
    listeners.forEach(fn => fn());
    if (id) taskListeners.get(id)?.forEach(fn => fn());
  };
  const find = (id: string) => tasks.find(task => task.id === id);
  const patch = (id: string, change: Partial<AiTask>) => {
    tasks = tasks.map(task => (task.id === id ? { ...task, ...change } : task));
    emit(id);
  };

  // ---------- 本机存储 ----------

  const isSettled = (task: AiTask) => task.status === 'done' || task.status === 'failed' || task.status === 'cancelled';
  const trim = () => {
    // 总数超过上限就删最旧的已结束任务；进行中和排队的不删。
    while (tasks.length > keep) {
      let index = -1;
      for (let i = tasks.length - 1; i >= 0; i -= 1) if (isSettled(tasks[i])) { index = i; break; }
      if (index < 0) break;
      const [gone] = tasks.splice(index, 1);
      runtime.delete(gone.id); generation.delete(gone.id); controllers.delete(gone.id);
    }
  };
  const save = () => {
    trim();
    if (!deps.storage) return;
    try { deps.storage.setItem(AI_TASKS_STORAGE_KEY, JSON.stringify({ v: 1, tasks })); } catch { /* 存不下就算了 */ }
  };
  const load = () => {
    if (!deps.storage) return;
    try {
      const raw = deps.storage.getItem(AI_TASKS_STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as { v?: number; tasks?: AiTask[] };
      if (data?.v !== 1 || !Array.isArray(data.tasks)) return;
      tasks = data.tasks.filter(task => task && typeof task.id === 'string' && Array.isArray(task.messages)).slice(0, keep).map(task => (
        task.status === 'running' || task.status === 'queued'
          ? { ...task, status: 'failed' as const, interrupted: true, error: INTERRUPTED_TEXT, endedAt: task.endedAt ?? deps.now() }
          : task
      ));
    } catch { /* 坏数据当没有 */ }
  };
  load();

  // ---------- 跑任务 ----------

  const runningCount = () => tasks.filter(task => task.status === 'running').length;
  const pump = () => {
    while (runningCount() < maxConcurrent) {
      const next = [...tasks].reverse().find(task => task.status === 'queued'); // 先来的先跑
      if (!next) return;
      start(next.id);
    }
  };

  const start = (id: string) => {
    const task = find(id);
    if (!task) return;
    const gen = (generation.get(id) ?? 0) + 1;
    generation.set(id, gen);
    const controller = new AbortController();
    controllers.set(id, controller);
    const extra = runtime.get(id) ?? {};
    patch(id, { status: 'running', startedAt: deps.now(), endedAt: undefined, error: undefined, interrupted: undefined, text: '', thinking: '', firstChunkAt: undefined, streamed: undefined });
    save();
    const live = () => generation.get(id) === gen && !controller.signal.aborted;
    const grow = (field: 'text' | 'thinking') => (delta: string) => {
      if (!live() || !delta) return;
      const current = find(id);
      if (!current) return;
      patch(id, { [field]: current[field] + delta, firstChunkAt: current.firstChunkAt ?? deps.now() } as Partial<AiTask>);
    };
    const history = task.messages;
    void (async () => {
      try {
        const out = await deps.run({
          messages: history, system: extra.system, temperature: extra.temperature, signal: controller.signal,
          onText: grow('text'), onThink: grow('thinking'),
        });
        if (!live()) return;
        const current = find(id);
        if (!current) return;
        let result: unknown;
        const registered = current.resultKind ? deps.resultParsers?.[current.resultKind] : undefined;
        try {
          if (extra.parseResult) result = extra.parseResult(out.text);
          else if (registered) result = registered(out.text, current.resultArgs);
        } catch { result = undefined; }
        const reply: AiMessage = { role: 'assistant', content: out.text, ...(out.thinking ? { thinking: out.thinking } : {}) };
        patch(id, {
          status: 'done', text: out.text, thinking: out.thinking, streamed: out.streamed, result,
          messages: [...history, reply], endedAt: deps.now(), error: undefined,
        });
      } catch (error) {
        if (!live()) return;
        patch(id, { status: 'failed', error: errorText(error), endedAt: deps.now() });
      } finally {
        if (generation.get(id) === gen) controllers.delete(id);
        save();
        pump();
      }
    })();
  };

  // ---------- 对外接口 ----------

  const api = {
    getTasks: () => tasks,
    getTask: (id: string) => find(id),
    /** 订阅全部任务（有任何变化都通知）。 */
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    /** 订阅单个任务。 */
    subscribeTask(id: string, fn: () => void) {
      let set = taskListeners.get(id);
      if (!set) { set = new Set(); taskListeners.set(id, set); }
      set.add(fn);
      return () => { set!.delete(fn); if (set!.size === 0) taskListeners.delete(id); };
    },
    /** 按来源找任务（原页面找回自己的任务）；新的在前。 */
    findBySource(match: Partial<AiTaskSource>): AiTask[] {
      return tasks.filter(task => (Object.keys(match) as (keyof AiTaskSource)[]).every(key => task.source[key] === match[key]));
    },

    create(input: CreateTaskInput): CreateTaskOutcome {
      const mode = input.mode ?? 'task';
      if (mode === 'direct' && lock !== null) return { ok: false, reason: `${LOCKED_TEXT}（${lock}）` };
      const prompt = input.prompt.trim();
      if (!prompt) return { ok: false, reason: '问题不能为空。' };
      const id = deps.newId();
      const task: AiTask = {
        id, title: input.title, source: input.source, mode, status: 'queued',
        messages: [{ role: 'user', content: prompt, ...(input.shown ? { shown: input.shown } : {}) }], text: '', thinking: '', createdAt: deps.now(),
        ...(input.resultKind ? { resultKind: input.resultKind, resultArgs: input.resultArgs } : {}),
      };
      runtime.set(id, { system: input.system, temperature: input.temperature, parseResult: input.parseResult });
      tasks = [task, ...tasks];
      emit(id);
      save();
      pump();
      return { ok: true, task: find(id) ?? task };
    },

    /** 取消排队中或进行中的任务；状态立刻变「已取消」，之后迟到的增量不再收。 */
    cancel(id: string): boolean {
      const task = find(id);
      if (!task || (task.status !== 'queued' && task.status !== 'running')) return false;
      generation.set(id, (generation.get(id) ?? 0) + 1);
      controllers.get(id)?.abort();
      controllers.delete(id);
      patch(id, { status: 'cancelled', endedAt: deps.now(), error: undefined });
      save();
      pump();
      return true;
    },

    /** 失败、取消、中断（或想重新生成的完成）任务重试：用同一串消息重新请求。 */
    retry(id: string): boolean {
      const task = find(id);
      if (!task || task.status === 'queued' || task.status === 'running') return false;
      const messages = task.messages.at(-1)?.role === 'assistant' ? task.messages.slice(0, -1) : task.messages;
      if (messages.length === 0 || messages.at(-1)?.role !== 'user') return false;
      patch(id, { messages, status: 'queued', text: '', thinking: '', error: undefined, interrupted: undefined, result: undefined, endedAt: undefined });
      save();
      pump();
      return true;
    },

    /** 追问：把之前的问答带上再请求。任务正在跑时不行。 */
    followUp(id: string, text: string): CreateTaskOutcome {
      const task = find(id);
      if (!task) return { ok: false, reason: '找不到这个任务。' };
      if (task.status === 'queued' || task.status === 'running') return { ok: false, reason: '上一条还在回答中。' };
      if (task.mode === 'direct' && lock !== null) return { ok: false, reason: `${LOCKED_TEXT}（${lock}）` };
      const content = text.trim();
      if (!content) return { ok: false, reason: '问题不能为空。' };
      // 上一轮没有成功收尾（最后一条是用户消息）时，先去掉它再接新问题，免得连续两条用户消息。
      const base = task.messages.at(-1)?.role === 'user' ? task.messages.slice(0, -1) : task.messages;
      patch(id, {
        messages: [...base, { role: 'user', content }], status: 'queued', text: '', thinking: '',
        error: undefined, interrupted: undefined, result: undefined, endedAt: undefined,
      });
      save();
      pump();
      return { ok: true, task: find(id)! };
    },

    /**
     * 改任务的结构化结果（例句「存了 / 都不存」这类界面状态记在这里，两处界面都从这里读）。
     * 只改 result，不动状态和消息；进行中也能改。
     */
    updateResult(id: string, result: unknown): boolean {
      if (!find(id)) return false;
      patch(id, { result });
      save();
      return true;
    },

    /** 删掉一个已结束的任务。 */
    remove(id: string): boolean {
      const task = find(id);
      if (!task || !isSettled(task)) return false;
      tasks = tasks.filter(item => item.id !== id);
      runtime.delete(id); generation.delete(id);
      emit(id);
      save();
      return true;
    },

    // ---------- 作答锁：091 的界面在用户作答时锁上，锁着就不能新建「直接问」；已在跑的任务照跑 ----------
    lockPanel(reason: string) { lock = reason || '作答中'; lockListeners.forEach(fn => fn()); },
    unlockPanel() { if (lock === null) return; lock = null; lockListeners.forEach(fn => fn()); },
    /** 当前锁定原因；没锁返回 null。 */
    getLock: () => lock,
    isLocked: () => lock !== null,
    subscribeLock(fn: () => void) { lockListeners.add(fn); return () => { lockListeners.delete(fn); }; },
  };
  return api;
};

export type AiTaskCenter = ReturnType<typeof createAiTaskCenter>;
