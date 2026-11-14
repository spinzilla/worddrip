import type { BrowseData, BrowseDefinition, BrowseExample, BrowseReviewWord, BrowseSelfCheck, BrowseUpgrade, VerificationStatus, VocabNote } from './types';

/**
 * 029 查词界面的数据整理与搜索（纯函数，不碰数据库，不改输入）。
 *
 * - 复习词按词目合并成「词」：同一个词在不同期出现多次，查的时候是一个词，详情里分别列出每期的进度。
 * - 学术升级条目拆出候选词：首选（加粗的）在前，每个候选带自己的用法说明和例句。
 * - 搜索按相关度排序：词目完全相同 > 词形变化 > 词目开头 > 中文意思 > 英文释义 > 例句 > 备注。
 *   中文查不到升级条目时，会顺着「命中的复习词正好是某个升级条目的候选」把那个条目也带出来。
 */

// ---------- 文本规范化 ----------

/** 查询规范化：去首尾空白、转小写、多个空白合一、弯引号转直引号。 */
export function normalizeText(text: string): string {
  return text.replace(/\*\*/g, '').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}

const CJK = /[㐀-鿿]/;
export const hasCjk = (text: string) => CJK.test(text);

/** 一个英文词可能的原形（只做常见的规则变化，宁可少认，不乱认）。 */
export function baseForms(token: string): Set<string> {
  const t = token.toLowerCase();
  const forms = new Set<string>([t]);
  const add = (form: string) => { if (form.length >= 2) forms.add(form); };
  const undouble = (stem: string) => {
    if (stem.length >= 3 && stem[stem.length - 1] === stem[stem.length - 2] && !/[aeiouls]/.test(stem[stem.length - 1])) add(stem.slice(0, -1));
  };
  if (t.length < 4) return forms;
  if (t.endsWith('ies')) add(`${t.slice(0, -3)}y`);
  if (t.endsWith('es')) add(t.slice(0, -2));
  if (t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us') && !t.endsWith('is')) add(t.slice(0, -1));
  if (t.endsWith('ied')) add(`${t.slice(0, -3)}y`);
  if (t.endsWith('ed')) {
    add(t.slice(0, -2));
    add(t.slice(0, -1));
    undouble(t.slice(0, -2));
  }
  if (t.endsWith('ing') && t.length >= 5) {
    add(t.slice(0, -3));
    add(`${t.slice(0, -3)}e`);
    undouble(t.slice(0, -3));
  }
  if (t.endsWith('ly') && t.length >= 5) add(t.slice(0, -2));
  return forms;
}

/** 词目和查询是不是同一个词的不同形式（逐词比较，词数必须相同）。 */
export function sameWordForm(head: string, query: string): boolean {
  const a = normalizeText(head).split(' ');
  const b = normalizeText(query).split(' ');
  if (a.length !== b.length || a.join('') === '') return false;
  return a.every((word, index) => {
    const other = b[index];
    return word === other || baseForms(other).has(word) || baseForms(word).has(other);
  });
}

const includes = (text: string, q: string) => normalizeText(text).includes(q);

/** 把文本按查询切成若干段，hit=true 的段在界面上高亮（纯文本，不生成 HTML）。 */
export function highlightParts(text: string, query: string): { text: string; hit: boolean }[] {
  const q = normalizeText(query);
  if (!q || !text) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const parts: { text: string; hit: boolean }[] = [];
  let from = 0;
  for (;;) {
    const at = lower.indexOf(q, from);
    if (at < 0 || q.length === 0) break;
    if (at > from) parts.push({ text: text.slice(from, at), hit: false });
    parts.push({ text: text.slice(at, at + q.length), hit: true });
    from = at + q.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), hit: false });
  return parts.length ? parts : [{ text, hit: false }];
}

/** 取命中位置附近的一小段，列表里展示「为什么搜到它」。 */
export function snippet(text: string, query: string, radius = 28): string {
  const q = normalizeText(query);
  const at = q ? text.toLowerCase().indexOf(q) : -1;
  if (at < 0) return text.length > radius * 2 ? `${text.slice(0, radius * 2)}…` : text;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + q.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

// ---------- 学习状态 ----------

export type StatusGroup = 'seed' | 'learning' | 'mastered' | 'cold' | 'other';

export const STATUS_GROUPS: { key: StatusGroup; label: string }[] = [
  { key: 'seed', label: '待考察' },
  { key: 'learning', label: '复习中 L1–L4' },
  { key: 'mastered', label: '已掌握' },
  { key: 'cold', label: '冷库' },
];

/** 只是把原状态归类用于展示和筛选，不改变任何复习规则。 */
export function statusGroup(status: string): StatusGroup {
  const s = status.trim();
  if (/^L[1-4]$/.test(s)) return 'learning';
  if (s.includes('✅') || s.includes('已掌握')) return 'mastered';
  if (s.includes('🧊') || s.includes('冷库')) return 'cold';
  if (s.includes('🌱') || s.includes('待考察')) return 'seed';
  return 'other';
}

/**
 * 042：界面上显示状态用的文字（不带 🌱 / ✅ / 🧊）。数据库和导出里仍是原值，只在显示层换。
 * 例如「🌱待考察」→「待考察」、「✅已掌握」→「已掌握」、「L2」→「L2」。
 */
export function statusLabel(status: string): string {
  const group = statusGroup(status);
  if (group === 'seed') return '待考察';
  if (group === 'mastered') return '已掌握';
  if (group === 'cold') return '冷库';
  return status.trim();
}

/** 状态的简短中文说明，例如「L2 · 11-11 到期」「已掌握」。 */
export function statusText(entry: Pick<BrowseReviewWord, 'status' | 'due'>): string {
  const group = statusGroup(entry.status);
  const due = /^\d{4}-(\d{2})-(\d{2})$/.exec(entry.due.trim());
  if (group === 'learning') return due ? `${entry.status.trim()} · ${due[1]}-${due[2]} 到期` : entry.status.trim();
  if (group === 'seed') return '待考察';
  if (group === 'mastered') return '已掌握';
  if (group === 'cold') return '冷库';
  return entry.status.trim() || '无状态';
}

// ---------- 备注拆分 ----------

export interface NoteParts {
  /** 意思、搭配、辨析等学习内容。 */
  notes: string[];
  /** 「2026-10-09 填空对」这类复习记录。 */
  history: string[];
  /** 带 ⚠️ 或 ≠ 的提醒，界面上要醒目。 */
  warnings: string[];
}

/** 备注按「；」拆开：日期开头的是复习记录，带 ⚠️/≠ 的是提醒，其余是笔记。 */
export function splitNote(note: string): NoteParts {
  const result: NoteParts = { notes: [], history: [], warnings: [] };
  for (const piece of note.split(/[；;]/)) {
    const text = piece.trim();
    if (!text) continue;
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) result.history.push(text);
    else if (text.includes('⚠') || text.includes('≠')) result.warnings.push(text);
    else result.notes.push(text);
  }
  return result;
}

// ---------- 学术升级：拆候选词 ----------

export interface Candidate {
  name: string;
  preferred: boolean;
  /** 原文里紧跟这个候选的用法说明（搭配、语域、辨析），已去掉 ** 和首尾分隔符。 */
  usage: string;
  examples: BrowseExample[];
}

const stripBold = (text: string) => text.replace(/\*\*/g, '');

function cleanUsage(text: string): string {
  let usage = stripBold(text).replace(/^[\s：:、,，]+/, '').replace(/[\s/／；;，,、]+$/, '').trim();
  if (/^（[^（）]*）$/.test(usage)) usage = usage.slice(1, -1).trim();
  return usage;
}

/**
 * 从「升级表达」原文和例句里拆出候选词。
 * 候选 = 加粗词（「a / b」形式的加粗会拆成两个）∪ 例句标注的候选词，按在原文里出现的位置排序。
 * 首选 = 第一个加粗词；没有加粗就取第一个候选。
 */
export function parseCandidates(item: Pick<BrowseUpgrade, 'upgrade' | 'examples'>): Candidate[] {
  const text = item.upgrade;
  const lower = text.toLowerCase();
  const found: { name: string; at: number; bold: boolean }[] = [];
  const seen = new Set<string>();
  const push = (name: string, at: number, bold: boolean) => {
    const clean = stripBold(name).trim();
    const key = normalizeText(clean);
    if (!key || seen.has(key)) return;
    seen.add(key);
    found.push({ name: clean, at, bold });
  };
  for (const match of text.matchAll(/\*\*(.+?)\*\*/g)) {
    const inner = match[1];
    let offset = 0;
    for (const part of inner.split(/\s\/\s/)) {
      const local = inner.indexOf(part, offset);
      offset = local + part.length;
      push(part, (match.index ?? 0) + 2 + Math.max(local, 0), true);
    }
  }
  for (const example of item.examples) {
    const name = example.cand.trim();
    if (!name) continue;
    push(name, lower.indexOf(name.toLowerCase()), false);
  }
  const positioned = found.filter(x => x.at >= 0).sort((a, b) => a.at - b.at);
  const unplaced = found.filter(x => x.at < 0);
  const ordered = [...positioned, ...unplaced];
  const firstBold = ordered.find(x => x.bold) ?? ordered[0];
  return ordered.map(entry => {
    let usage = '';
    if (entry.at >= 0) {
      const next = positioned.find(x => x.at > entry.at);
      // 只截到下一个候选之前；候选名本身（可能带 **）去掉。
      const segment = text.slice(entry.at, next ? next.at : text.length);
      const nameAt = segment.toLowerCase().indexOf(entry.name.toLowerCase());
      usage = cleanUsage(nameAt >= 0 ? segment.slice(nameAt + entry.name.length) : segment);
    }
    return {
      name: entry.name,
      preferred: entry === firstBold,
      usage,
      examples: item.examples.filter(example => normalizeText(example.cand) === normalizeText(entry.name)),
    };
  });
}

// ---------- 整理成「词库」 ----------

export interface WordGroup {
  key: string;
  word: string;
  /** 按导入顺序（ord）排列的各期记录。 */
  entries: BrowseReviewWord[];
  /** 合并去重后的释义（按词性 + 英英释义去重）。 */
  definitions: BrowseDefinition[];
  /** 最新一期的记录，列表里的状态以它为准。 */
  latest: BrowseReviewWord;
  /** 列表里一句话的意思：优先中文释义，其次备注第一段。 */
  gloss: string;
  pos: string[];
}

export interface UpgradeGroup {
  item: BrowseUpgrade;
  candidates: Candidate[];
  preferred: string;
}

export interface Library {
  words: WordGroup[];
  upgrades: UpgradeGroup[];
  selfChecks: BrowseSelfCheck[];
  wordByKey: Map<string, WordGroup>;
  upgradeById: Map<string, UpgradeGroup>;
  /** 规范化候选词 → 含有它的升级条目 ID。 */
  upgradesByCandidate: Map<string, string[]>;
  /** 040：归一化的词 → 用户笔记（新的在前）。复习词和升级候选词共用同一组。 */
  notesByKey: Map<string, VocabNote[]>;
}

export const wordKey = (word: string) => `w:${normalizeText(word)}`;

/** 「9.18 期」「每日加分表达 10-06」「首考过」这类出处/记录片段，不能当作意思展示。 */
export function isProvenance(text: string): boolean {
  const t = text.trim();
  return /期$/.test(t) || /^每日/.test(t) || /首考|复习|入库/.test(t) || /^[\d.\-\s]+$/.test(t);
}

function mergeDefinitions(entries: BrowseReviewWord[]): BrowseDefinition[] {
  const seen = new Set<string>();
  const merged: BrowseDefinition[] = [];
  for (const entry of entries) {
    for (const definition of entry.definitions ?? []) {
      const key = `${normalizeText(definition.pos)}|${normalizeText(definition.english)}|${normalizeText(definition.chinese)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(definition);
    }
  }
  return merged;
}

/** notesByKey 由 notes.ts 的 groupNotes 生成（键 = normalizeText(词)）；不传就是没有笔记。 */
export function buildLibrary(data: BrowseData, notesByKey: Map<string, VocabNote[]> = new Map()): Library {
  const byWord = new Map<string, BrowseReviewWord[]>();
  for (const entry of data.reviewWords) {
    const key = wordKey(entry.word);
    const list = byWord.get(key);
    if (list) list.push(entry);
    else byWord.set(key, [entry]);
  }
  const words: WordGroup[] = [...byWord.entries()].map(([key, list]) => {
    const entries = [...list].sort((a, b) => a.ord - b.ord);
    const definitions = mergeDefinitions(entries);
    const latest = entries[entries.length - 1];
    const firstNote = entries.map(entry => splitNote(entry.note).notes.find(text => !isProvenance(text))).find(Boolean) ?? '';
    const gloss = definitions.find(d => d.chinese.trim())?.chinese.trim() || firstNote;
    const pos = [...new Set(definitions.map(d => d.pos.trim()).filter(Boolean))];
    return { key, word: entries[0].word.trim(), entries, definitions, latest, gloss, pos };
  });
  const upgrades = data.upgrades.map(item => {
    const candidates = parseCandidates(item);
    return { item, candidates, preferred: candidates.find(c => c.preferred)?.name ?? '' };
  });
  const upgradesByCandidate = new Map<string, string[]>();
  for (const group of upgrades) {
    for (const candidate of group.candidates) {
      const key = normalizeText(candidate.name);
      const list = upgradesByCandidate.get(key) ?? [];
      if (!list.includes(group.item.id)) list.push(group.item.id);
      upgradesByCandidate.set(key, list);
    }
  }
  return {
    words,
    upgrades,
    selfChecks: data.selfChecks,
    wordByKey: new Map(words.map(word => [word.key, word])),
    upgradeById: new Map(upgrades.map(group => [group.item.id, group])),
    upgradesByCandidate,
    notesByKey,
  };
}

/** 一个词（复习词或升级候选词）的笔记，新的在前；没有返回空数组。 */
export function notesForWord(library: Pick<Library, 'notesByKey'>, word: string): VocabNote[] {
  return library.notesByKey.get(normalizeText(word)) ?? [];
}

const hasNotes = (library: Pick<Library, 'notesByKey'>, word: string) => notesForWord(library, word).length > 0;

/** 升级条目里有没有哪个候选词记过笔记。 */
export function upgradeHasNotes(library: Pick<Library, 'notesByKey'>, group: UpgradeGroup): boolean {
  return group.candidates.some(candidate => hasNotes(library, candidate.name));
}

/** 一个复习词出现在哪些升级条目里（作为候选）。 */
export function upgradesForWord(library: Library, word: string): UpgradeGroup[] {
  const ids = library.upgradesByCandidate.get(normalizeText(word)) ?? [];
  return ids.map(id => library.upgradeById.get(id)).filter((x): x is UpgradeGroup => x !== undefined);
}

/** 升级条目的候选词在复习库里对应的词（没有就是 undefined）。 */
export function wordForCandidate(library: Library, name: string): WordGroup | undefined {
  return library.wordByKey.get(wordKey(name));
}

// ---------- 搜索与排序 ----------

export type HitKind = 'word' | 'upgrade' | 'selfCheck';

export type Hit =
  | { kind: 'word'; id: string; score: number; reason: string; word: WordGroup }
  | { kind: 'upgrade'; id: string; score: number; reason: string; upgrade: UpgradeGroup }
  | { kind: 'selfCheck'; id: string; score: number; reason: string; selfCheck: BrowseSelfCheck };

export type SortMode = 'relevance' | 'alpha' | 'recent' | 'due';

export const SORT_MODES: { key: SortMode; label: string }[] = [
  { key: 'relevance', label: '最相关' },
  { key: 'alpha', label: 'A–Z' },
  { key: 'recent', label: '最近入库' },
  { key: 'due', label: '到期最早' },
];

export interface SearchOptions {
  sort?: SortMode;
  status?: StatusGroup | 'all';
  verification?: VerificationStatus | '全部';
  /** 040：只看记过笔记的词。 */
  notes?: NoteFilter;
}

export type NoteFilter = 'all' | 'has';

type Scored = { score: number; reason: string };
const best = (a: Scored, b: Scored) => (b.score > a.score ? b : a);
const NONE: Scored = { score: 0, reason: '' };

function scoreNotes(notes: readonly VocabNote[], q: string, raw: string, label: string): Scored {
  let hit = NONE;
  for (const note of notes) {
    // 中文查询命中笔记，多半是在找自己写过的意思/辨析，排在中文释义附近。
    if (includes(note.body, q)) hit = best(hit, { score: hasCjk(q) ? 62 : 42, reason: `${label}：${snippet(note.body, raw)}` });
  }
  return hit;
}

function scoreWord(group: WordGroup, q: string, raw: string, notes: readonly VocabNote[] = []): Scored {
  const word = normalizeText(group.word);
  if (word === q) return { score: 100, reason: '' };
  if (!hasCjk(q) && sameWordForm(group.word, q)) return { score: 95, reason: '词形变化' };
  let hit = NONE;
  if (q.length >= 2 && word.startsWith(q)) hit = best(hit, { score: 85, reason: '' });
  else if (q.length >= 2 && ` ${word} `.includes(` ${q} `)) hit = best(hit, { score: 78, reason: '' });
  else if (q.length >= 3 && word.includes(q)) hit = best(hit, { score: 72, reason: '' });
  for (const definition of group.definitions) {
    if (includes(definition.chinese, q)) hit = best(hit, { score: 70, reason: `中文：${snippet(definition.chinese, raw)}` });
    if (includes(definition.english, q)) hit = best(hit, { score: 55, reason: `释义：${snippet(definition.english, raw)}` });
    for (const example of definition.examples) {
      if (includes(example.sentence, q)) hit = best(hit, { score: 45, reason: `例句：${snippet(example.sentence, raw)}` });
    }
    if (normalizeText(definition.pos) === q) hit = best(hit, { score: 20, reason: `词性 ${definition.pos}` });
  }
  for (const entry of group.entries) {
    if (normalizeText(entry.issue) === q) hit = best(hit, { score: 60, reason: `${entry.issue} 期` });
    if (includes(entry.note, q)) {
      // 中文查询命中备注，多半是在查意思（备注里第一段常就是中文意思）。
      hit = best(hit, { score: hasCjk(q) ? 65 : 40, reason: `笔记：${snippet(entry.note, raw)}` });
    }
    if (includes(entry.source, q)) hit = best(hit, { score: 30, reason: `来源：${entry.source}` });
    if (includes(entry.issue, q)) hit = best(hit, { score: 30, reason: `${entry.issue} 期` });
    if (includes(entry.status, q) || normalizeText(entry.verificationStatus) === q) hit = best(hit, { score: 25, reason: entry.status });
  }
  return best(hit, scoreNotes(notes, q, raw, '我的笔记'));
}

function scoreUpgrade(group: UpgradeGroup, q: string, raw: string, library?: Pick<Library, 'notesByKey'>): Scored {
  const { item } = group;
  const plain = normalizeText(item.plain);
  if (plain === q) return { score: 100, reason: '' };
  let hit = NONE;
  for (const candidate of group.candidates) {
    const name = normalizeText(candidate.name);
    if (name === q) hit = best(hit, { score: 98, reason: `候选词 ${candidate.name}` });
    else if (!hasCjk(q) && sameWordForm(candidate.name, q)) hit = best(hit, { score: 93, reason: `候选词 ${candidate.name}` });
    else if (q.length >= 2 && name.startsWith(q)) hit = best(hit, { score: 80, reason: `候选词 ${candidate.name}` });
  }
  if (q.length >= 1 && plain.includes(q)) hit = best(hit, { score: plain.startsWith(q) ? 88 : 82, reason: '' });
  if (includes(item.upgrade, q)) hit = best(hit, { score: 70, reason: `用法：${snippet(stripBold(item.upgrade), raw)}` });
  if (includes(item.note, q)) hit = best(hit, { score: 50, reason: `备注：${snippet(item.note, raw)}` });
  for (const example of item.examples) {
    if (includes(example.sentence, q)) hit = best(hit, { score: 45, reason: `例句：${snippet(example.sentence, raw)}` });
  }
  if (includes(item.source, q)) hit = best(hit, { score: 30, reason: `出处：${item.source}` });
  if (library) {
    for (const candidate of group.candidates) {
      hit = best(hit, scoreNotes(notesForWord(library, candidate.name), q, raw, `${candidate.name} 的笔记`));
    }
  }
  return hit;
}

function wordPasses(group: WordGroup, options: SearchOptions, library: Pick<Library, 'notesByKey'>): boolean {
  const status = options.status ?? 'all';
  const verification = options.verification ?? '全部';
  if (options.notes === 'has' && !hasNotes(library, group.word)) return false;
  return group.entries.some(entry =>
    (status === 'all' || statusGroup(entry.status) === status) &&
    (verification === '全部' || entry.verificationStatus === verification),
  );
}

const KIND_ORDER: Record<HitKind, number> = { word: 0, upgrade: 1, selfCheck: 2 };

function headOf(hit: Hit): string {
  if (hit.kind === 'word') return normalizeText(hit.word.word);
  if (hit.kind === 'upgrade') return normalizeText(hit.upgrade.item.plain);
  return normalizeText(hit.selfCheck.text);
}

function ordOf(hit: Hit): number {
  if (hit.kind === 'word') return hit.word.entries[0].ord;
  if (hit.kind === 'upgrade') return hit.upgrade.item.ord;
  return hit.selfCheck.ord;
}

/** 最近入库：取这个词最晚一期的入库日期；没有日期的放最后。 */
function addedOf(hit: Hit): string {
  if (hit.kind !== 'word') return '';
  return hit.word.entries.reduce((max, entry) => (entry.addedAt > max ? entry.addedAt : max), '');
}

/** 最早的到期日（只看 L1–L4 且日期合法的记录），没有就返回空。 */
function dueOf(hit: Hit): string {
  if (hit.kind !== 'word') return '';
  const dues = hit.word.entries
    .filter(entry => statusGroup(entry.status) === 'learning' && /^\d{4}-\d{2}-\d{2}$/.test(entry.due.trim()))
    .map(entry => entry.due.trim())
    .sort();
  return dues[0] ?? '';
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function compareHits(a: Hit, b: Hit, sort: SortMode): number {
  const tie = () => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || cmp(headOf(a), headOf(b)) || ordOf(a) - ordOf(b) || cmp(a.id, b.id);
  if (sort === 'relevance') {
    return b.score - a.score || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || headOf(a).length - headOf(b).length || ordOf(a) - ordOf(b) || cmp(a.id, b.id);
  }
  if (sort === 'alpha') return cmp(headOf(a), headOf(b)) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || ordOf(a) - ordOf(b) || cmp(a.id, b.id);
  if (sort === 'recent') {
    const x = addedOf(a);
    const y = addedOf(b);
    if (x !== y) return x === '' ? 1 : y === '' ? -1 : cmp(y, x);
    return (b.kind === 'word' && a.kind === 'word' ? ordOf(b) - ordOf(a) : 0) || tie();
  }
  const x = dueOf(a);
  const y = dueOf(b);
  if (x !== y) return x === '' ? 1 : y === '' ? -1 : cmp(x, y);
  return tie();
}

/**
 * 统一搜索。空查询时只列复习词（升级条目在「升级对照」里看），按 sort 排；
 * 有查询时三类一起搜，默认按相关度排。状态/查证筛选只作用于复习词，开启时不显示升级和自查。
 * 「有笔记」筛选（040）：复习词要记过笔记；升级条目要有候选词记过笔记（空查询时也列出来）；写作自查不显示。
 */
export function searchLibrary(library: Library, query: string, options: SearchOptions = {}): Hit[] {
  const q = normalizeText(query);
  const sort = options.sort ?? 'relevance';
  const filtered = (options.status ?? 'all') !== 'all' || (options.verification ?? '全部') !== '全部';
  const notesOnly = options.notes === 'has';
  const hits: Hit[] = [];
  if (!q) {
    for (const word of library.words) {
      if (wordPasses(word, options, library)) hits.push({ kind: 'word', id: word.key, score: 0, reason: '', word });
    }
    if (notesOnly && !filtered) {
      for (const group of library.upgrades) {
        if (upgradeHasNotes(library, group)) hits.push({ kind: 'upgrade', id: group.item.id, score: 0, reason: '', upgrade: group });
      }
    }
    return hits.sort((a, b) => compareHits(a, b, sort === 'relevance' ? 'alpha' : sort));
  }
  const wordScores = new Map<string, Scored>();
  for (const word of library.words) {
    if (!wordPasses(word, options, library)) continue;
    const scored = scoreWord(word, q, query.trim(), notesForWord(library, word.word));
    if (scored.score > 0) {
      wordScores.set(word.key, scored);
      hits.push({ kind: 'word', id: word.key, score: scored.score, reason: scored.reason, word });
    }
  }
  if (!filtered) {
    for (const group of library.upgrades) {
      if (notesOnly && !upgradeHasNotes(library, group)) continue;
      let scored = scoreUpgrade(group, q, query.trim(), library);
      // 中文概念查到了复习词，而这个词正是某个升级条目的候选：把条目一起带出来（比那个词略低一点）。
      // 只对中文查询这样做；英文查询候选词本身就能直接命中，期号之类的命中也不该连带。
      for (const candidate of hasCjk(q) ? group.candidates : []) {
        const related = wordScores.get(wordKey(candidate.name));
        if (related && related.score >= 40 && related.score - 1 > scored.score) {
          scored = { score: related.score - 1, reason: `候选词 ${candidate.name} 匹配「${query.trim()}」` };
        }
      }
      if (scored.score > 0) hits.push({ kind: 'upgrade', id: group.item.id, score: scored.score, reason: scored.reason, upgrade: group });
    }
    for (const item of notesOnly ? [] : library.selfChecks) {
      if (includes(item.text, q)) hits.push({ kind: 'selfCheck', id: item.id, score: 35, reason: '', selfCheck: item });
    }
  }
  return hits.sort((a, b) => compareHits(a, b, sort));
}

// ---------- 按期回看 ----------

export interface IssueGroup {
  issue: string;
  words: { group: WordGroup; entry: BrowseReviewWord }[];
  counts: Record<StatusGroup, number>;
}

/**
 * 期号排序键：能读出「月.日」的按学年（8 月起）从新到旧；读不出的（EAGP、熟词生义等）放后面按名字排。
 */
export function issueSortKey(issue: string): number | null {
  const match = /(\d{1,2})[.\-](\d{1,2})/.exec(issue);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return (month < 8 ? month + 12 : month) * 100 + day;
}

export function compareIssues(a: string, b: string): number {
  const x = issueSortKey(a);
  const y = issueSortKey(b);
  if (x !== null && y !== null) return y - x || cmp(a, b);
  if (x !== null) return -1;
  if (y !== null) return 1;
  return cmp(a, b);
}

/** 按期分组；有查询时只保留命中的词（命中规则同 searchLibrary 的复习词部分）。 */
export function groupByIssue(library: Library, query: string, options: SearchOptions = {}): IssueGroup[] {
  const q = normalizeText(query);
  const map = new Map<string, IssueGroup>();
  for (const group of library.words) {
    if (options.notes === 'has' && !hasNotes(library, group.word)) continue;
    if (q && scoreWord(group, q, query.trim(), notesForWord(library, group.word)).score === 0) continue;
    for (const entry of group.entries) {
      const status = options.status ?? 'all';
      if (status !== 'all' && statusGroup(entry.status) !== status) continue;
      if ((options.verification ?? '全部') !== '全部' && entry.verificationStatus !== options.verification) continue;
      const issue = entry.issue.trim() || '（无期号）';
      let bucket = map.get(issue);
      if (!bucket) {
        bucket = { issue, words: [], counts: { seed: 0, learning: 0, mastered: 0, cold: 0, other: 0 } };
        map.set(issue, bucket);
      }
      bucket.words.push({ group, entry });
      bucket.counts[statusGroup(entry.status)] += 1;
    }
  }
  const groups = [...map.values()];
  for (const bucket of groups) bucket.words.sort((a, b) => a.entry.ord - b.entry.ord);
  return groups.sort((a, b) => compareIssues(a.issue, b.issue));
}

/** 升级对照视图：有查询时按相关度，否则保持原顺序。 */
export function filterUpgradeGroups(library: Library, query: string): UpgradeGroup[] {
  const q = normalizeText(query);
  if (!q) return library.upgrades;
  return library.upgrades
    .map(group => ({ group, score: scoreUpgrade(group, q, query.trim(), library).score }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.group.item.ord - b.group.item.ord)
    .map(x => x.group);
}

/** 例句排序：原有（真语料）在前，AI 草稿在后；同类保持原顺序。 */
export function realExamplesFirst<T extends { ai: boolean; seq: number }>(examples: readonly T[]): T[] {
  return [...examples].sort((a, b) => Number(a.ai) - Number(b.ai) || a.seq - b.seq);
}
