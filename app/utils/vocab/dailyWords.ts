// 081 每日新词：学习计划、挑词、当天固定、撤销。纯函数 + 本机 localStorage，不碰数据库
// （候选池和收词写入走 vocabApi → Rust pick.rs；内置词表走 utils/wordpack.ts）。
import type { WordpackEntry } from '../wordpack';

// ---------- 词表与计划 ----------

export interface PackDef { tag: string; label: string }

/** 设置里能选的词表（tag 是内置词表数据里的标签，label 是界面和「来源」里用的名字）。 */
export const PACKS: readonly PackDef[] = [
  { tag: 'cet4', label: '四级' }, { tag: 'cet6', label: '六级' }, { tag: 'ky', label: '考研' },
  { tag: 'ielts', label: '雅思' }, { tag: 'toefl', label: '托福' }, { tag: 'gre', label: 'GRE' },
  { tag: 'gk', label: '高考' }, { tag: 'zk', label: '中考' },
  { tag: 'ngsl', label: '核心 2800' }, { tag: 'nawl', label: '学术词' },
];

export const PER_DAY_PRESETS = [5, 10, 20] as const;
export const DEFAULT_PER_DAY = 10;
export const MAX_PER_DAY = 100;
/** 「再来 5 个」 */
export const MORE_BATCH = 5;
/** 「以后再说」几天后再出现 */
export const LATER_DAYS = 7;

export interface Plan {
  /** 选了哪些词表（tag），按选的顺序 */
  packs: string[];
  perDay: number;
  /** 词库页是否显示「今日新词」卡（老用户可以关掉） */
  cardOn: boolean;
}

export const DEFAULT_PLAN: Plan = { packs: [], perDay: DEFAULT_PER_DAY, cardOn: true };

export const packLabel = (tag: string): string => PACKS.find(pack => pack.tag === tag)?.label ?? tag;

const PLAN_KEY = 'worddrip_daily_plan';
const STATE_KEY = 'worddrip_daily_state';
const PLAN_EVENT = 'vocab-daily-plan-changed';

export function normalizePlan(raw: unknown): Plan {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const known = new Set(PACKS.map(pack => pack.tag));
  const packs = Array.isArray(value.packs) ? [...new Set(value.packs.filter((tag): tag is string => typeof tag === 'string' && known.has(tag)))] : [];
  const perDay = typeof value.perDay === 'number' && Number.isFinite(value.perDay) ? Math.min(MAX_PER_DAY, Math.max(1, Math.round(value.perDay))) : DEFAULT_PER_DAY;
  return { packs, perDay, cardOn: value.cardOn !== false };
}

export function getPlan(): Plan {
  try {
    const raw = localStorage.getItem(PLAN_KEY);
    return normalizePlan(raw ? JSON.parse(raw) : null);
  } catch { return { ...DEFAULT_PLAN }; }
}

/**
 * 只写本机缓存并通知界面（不写数据库）。要持久化、同步，用 `utils/vocab/dailyPlanSync.ts` 的 `savePlanSynced`
 * ——079 首次引导写学习计划也要用它。
 */
export function savePlan(plan: Plan): void {
  const next = normalizePlan(plan);
  try { localStorage.setItem(PLAN_KEY, JSON.stringify(next)); } catch { /* 存不了就只在内存里生效 */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PLAN_EVENT));
}

/** 学习计划的数据库一侧（Rust 单行表 daily_plan，会同步、会跟整库搬家）。 */
export interface PlanBackend {
  planGet(): Promise<{ packs: string[]; perDay: number; cardOn: boolean } | null>;
  planSet(plan: Plan): Promise<unknown>;
}

const samePlan = (a: Plan, b: Plan) => a.perDay === b.perDay && a.cardOn === b.cardOn && a.packs.join(',') === b.packs.join(',');

/** 正在写库的操作；读库要等它写完，免得读到旧值把刚改的盖掉。 */
let writing: Promise<unknown> = Promise.resolve();

/** 存学习计划：先更新本机缓存（界面立刻变），再写数据库（之后由同步带到别的设备）。 */
export function savePlanTo(backend: PlanBackend, plan: Plan): Promise<void> {
  const next = normalizePlan(plan);
  savePlan(next);
  const job = writing.catch(() => {}).then(() => backend.planSet(next)).then(() => {});
  writing = job;
  return job;
}

/**
 * 以数据库为准刷新本机缓存：库里有计划 → 缓存改成库里的（有变化才通知界面）；
 * 库里没有但本机缓存里有（升级前存的）→ 把缓存写进库。
 */
export async function refreshPlanFrom(backend: PlanBackend): Promise<Plan> {
  await writing.catch(() => {});
  const row = await backend.planGet();
  if (row) {
    const fromDb = normalizePlan(row);
    if (!samePlan(fromDb, getPlan())) savePlan(fromDb);
    return fromDb;
  }
  const cached = getPlan();
  let stored = false;
  try { stored = localStorage.getItem(PLAN_KEY) !== null; } catch { /* 读不到就当没有 */ }
  if (stored) await backend.planSet(cached);
  return cached;
}

export function onPlanChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(PLAN_EVENT, listener);
  return () => window.removeEventListener(PLAN_EVENT, listener);
}

// ---------- 日期 ----------

const pad = (n: number) => String(n).padStart(2, '0');

/** 本机今天，YYYY-MM-DD。 */
export function today(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(y, m - 1, d + days);
  return today(next);
}

// ---------- 候选池 ----------

export type PickState = 'known' | 'taken' | 'later';

export interface PickRow {
  wordKey: string;
  word: string;
  state: PickState;
  pack: string;
  decidedAt: string;
  updatedAt: string;
}

/** 和后端 note_key 同一个规则：去空白、转小写、弯引号变直引号。 */
export function wordKey(word: string): string {
  return word.replace(/\*\*/g, '').replace(/[’‘]/g, "'").trim().split(/\s+/).filter(Boolean).join(' ').toLowerCase();
}

/** 这个词现在还不该出现吗：认识、收下永远不再出现；以后再说要等满 7 天。 */
export function isBlocked(row: Pick<PickRow, 'state' | 'decidedAt'> | undefined, date: string): boolean {
  if (!row) return false;
  if (row.state === 'later') return date < addDays(row.decidedAt, LATER_DAYS);
  return true;
}

export function pickMap(rows: readonly PickRow[]): Map<string, PickRow> {
  return new Map(rows.map(row => [row.wordKey, row]));
}

// ---------- 挑词 ----------

/** 一个词的所有形态：原形 + 词形变化（ECDICT 的 exchange：p:ran/d:run/i:running/0:原形……）。 */
export function formKeys(entry: Pick<WordpackEntry, 'word' | 'exchange'>): string[] {
  const forms = new Set([wordKey(entry.word)]);
  for (const part of (entry.exchange || '').split('/')) {
    const form = part.includes(':') ? part.slice(part.indexOf(':') + 1) : '';
    if (form.trim()) forms.add(wordKey(form));
  }
  return [...forms];
}

/** 词库里已经有这个词（原形或任何一个变形，如库里有 running，就不再送 run）。 */
export function inLibrary(entry: Pick<WordpackEntry, 'word' | 'exchange'>, library: ReadonlySet<string>): boolean {
  return formKeys(entry).some(key => library.has(key));
}

/** 这个词属于所选词表里的哪一个（按计划里的顺序，取第一个）；返回名字，如「四级」。 */
export function packOf(entry: Pick<WordpackEntry, 'tags'>, packs: readonly string[]): string {
  const tag = packs.find(tag => entry.tags.includes(tag)) ?? entry.tags.find(tag => PACKS.some(pack => pack.tag === tag)) ?? '';
  return tag ? packLabel(tag) : '';
}

export interface PickDeps {
  /** wordpackList：按词频从常见到少见 */
  list: (tags: string[], options: { offset: number; limit: number }) => Promise<WordpackEntry[]>;
}

export interface PickContext {
  packs: readonly string[];
  /** 用户词库里所有词的 wordKey（小写） */
  library: ReadonlySet<string>;
  picks: ReadonlyMap<string, PickRow>;
  today: string;
  /** 不要再挑这些（当天已经固定下来的） */
  skip?: ReadonlySet<string>;
}

const PAGE = 400;

/** 从所选词表里按词频挑 n 个新词：跳过词库里已有的（含变形）、已决定的、以后再说还没满 7 天的。 */
export async function pickCandidates(deps: PickDeps, ctx: PickContext, n: number): Promise<WordpackEntry[]> {
  const out: WordpackEntry[] = [];
  const seen = new Set<string>();
  if (n <= 0 || ctx.packs.length === 0) return out;
  for (let offset = 0; out.length < n; offset += PAGE) {
    const page = await deps.list([...ctx.packs], { offset, limit: PAGE });
    for (const entry of page) {
      const key = wordKey(entry.word);
      if (seen.has(key)) continue;
      seen.add(key);
      if (ctx.skip?.has(key) || isBlocked(ctx.picks.get(key), ctx.today) || inLibrary(entry, ctx.library)) continue;
      out.push(entry);
      if (out.length >= n) break;
    }
    if (page.length < PAGE) break;
  }
  return out;
}

// ---------- 当天固定 ----------

export interface DailyState {
  date: string;
  /** 选了哪些词表（变了就重新挑） */
  sig: string;
  /** 再来 5 个 点了几次 */
  extra: number;
  entries: WordpackEntry[];
}

export const planSig = (packs: readonly string[]) => [...packs].sort().join(',');

export function loadDailyState(): DailyState | null {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    const value = raw ? JSON.parse(raw) : null;
    if (!value || typeof value.date !== 'string' || !Array.isArray(value.entries)) return null;
    return { date: value.date, sig: String(value.sig ?? ''), extra: Number(value.extra) || 0, entries: value.entries };
  } catch { return null; }
}

export function saveDailyState(state: DailyState): void {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

/**
 * 今天的词：同一天、同一组词表就沿用已经固定下来的（换页、重启都不变），不够今天的数量再补；
 * 第二天或换了词表就重新挑。saved 是上次存的状态，返回新状态（调用方负责存）。
 */
export async function buildDaily(deps: PickDeps, plan: Pick<Plan, 'packs' | 'perDay'>, ctx: Omit<PickContext, 'packs' | 'skip'>, saved: DailyState | null, extraWanted = 0): Promise<DailyState> {
  const sig = planSig(plan.packs);
  const same = saved && saved.date === ctx.today && saved.sig === sig;
  const state: DailyState = same ? { ...saved, entries: [...saved.entries] } : { date: ctx.today, sig, extra: 0, entries: [] };
  state.extra += extraWanted;
  const target = plan.perDay + state.extra * MORE_BATCH;
  const need = target - state.entries.length;
  if (need > 0) {
    const skip = new Set(state.entries.map(entry => wordKey(entry.word)));
    const fresh = await pickCandidates(deps, { ...ctx, packs: plan.packs, skip }, need);
    state.entries.push(...fresh);
  }
  return state;
}

/** 今天固定的词里还没处理的（按固定顺序）。 */
export function remainingOf(state: Pick<DailyState, 'entries'>, picks: ReadonlyMap<string, PickRow>, date: string): WordpackEntry[] {
  return state.entries.filter(entry => !isBlocked(picks.get(wordKey(entry.word)), date));
}

/** 今天一共收下了几个（不限于固定名单里的）。 */
export function takenToday(picks: readonly PickRow[], date: string): number {
  return picks.filter(row => row.state === 'taken' && row.decidedAt === date).length;
}

// ---------- 文字整理 ----------

/** 词表里的释义是多行（每行一个词性义项）。 */
export function lines(text: string, max: number): string[] {
  return (text || '').split(/\r?\n|\\n/).map(line => line.trim()).filter(Boolean).slice(0, max);
}

// ---------- 滑动判断 ----------

export type Decision = 'known' | 'taken' | 'later';

/** 手势位移 → 操作：左滑认识、右滑收下、上滑以后再说；位移不够返回 null。 */
export function swipeDecision(dx: number, dy: number, threshold = 70): Decision | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < threshold) return null;
  if (ay > ax) return dy < 0 ? 'later' : null;
  return dx < 0 ? 'known' : 'taken';
}

/** 键盘：← 认识、→ 收下、↑ 以后、空格翻面。 */
export function keyDecision(key: string): Decision | 'flip' | null {
  switch (key) {
    case 'ArrowLeft': return 'known';
    case 'ArrowRight': return 'taken';
    case 'ArrowUp': return 'later';
    case ' ': case 'Spacebar': return 'flip';
    default: return null;
  }
}

export interface UndoItem {
  entry: WordpackEntry;
  decision: Decision;
  previous: PickRow | null;
  takeId?: string | null;
  definitionEnIds?: number[];
}

// ---------- 跨页面小事件 ----------

const GOTO_SETTINGS = 'vocab-daily-goto-settings';
const FIRST_TEST = 'vocab-daily-first-test';
let pendingSettings = false;

/** 「选个目标」：切到设置 → 卡片与复习（那里有「每日新词」）。 */
export function gotoDailySettings(): void {
  pendingSettings = true;
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(GOTO_SETTINGS));
}
export const consumeDailySettingsRequest = (): boolean => { const v = pendingSettings; pendingSettings = false; return v; };
export function onGotoDailySettings(listener: () => void): () => void {
  window.addEventListener(GOTO_SETTINGS, listener);
  return () => window.removeEventListener(GOTO_SETTINGS, listener);
}

/** 收完词后「去做首考」：首考面板收到后选好今天这一期并直接开始。 */
export function requestFirstTest(issue: string): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<string>(FIRST_TEST, { detail: issue }));
}
export function onFirstTestRequest(listener: (issue: string) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<string>).detail);
  window.addEventListener(FIRST_TEST, handler);
  return () => window.removeEventListener(FIRST_TEST, handler);
}
