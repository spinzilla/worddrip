export interface VocabWarning {
  line: number;
  kind: 'columns' | 'status' | 'example' | 'duplicate' | 'section' | 'metadata';
  message: string;
}

export interface UpgradeExample {
  cand: string;
  sentence: string;
  ai: boolean;
}

export interface UpgradeEntry {
  id: string;
  line: number;
  raw: string;
  plain: string;
  upgrade: string;
  examples: UpgradeExample[];
  source: string;
  note: string;
}

export interface SelfCheck {
  id: string;
  line: number;
  raw: string;
  text: string;
}

export interface ReviewWord {
  id: string;
  line: number;
  raw: string;
  word: string;
  issue: string;
  addedAt: string;
  status: string;
  level: 1 | 2 | 3 | 4 | null;
  due: string;
  note: string;
}

export interface UpgradeParseResult {
  entries: UpgradeEntry[];
  selfChecks: SelfCheck[];
  warnings: VocabWarning[];
}

export interface ReviewParseResult {
  words: ReviewWord[];
  warnings: VocabWarning[];
}

export interface SourceSnapshot {
  fileName: string;
  content: string;
}

export interface ImportExample extends UpgradeExample {
  entryId: string;
  seq: number;
}

export interface VocabImportInput {
  upgrade: SourceSnapshot;
  review: SourceSnapshot;
  entries: Omit<UpgradeEntry, 'examples'>[];
  examples: ImportExample[];
  selfChecks: SelfCheck[];
  reviewWords: ReviewWord[];
  warnings: {
    upgrade: VocabWarning[];
    review: VocabWarning[];
  };
}

export interface VocabPreview {
  input: VocabImportInput;
  reviewCounts: ReviewImportCounts | null;
  errors: string[];
  warnings: {
    upgrade: VocabWarning[];
    review: VocabWarning[];
  };
  counts: {
    upgradeEntries: number;
    upgradeExamples: number;
    selfChecks: number;
    reviewWords: number;
  };
}

export interface ImportCounts {
  added: number;
  skipped: number;
}

export interface ReviewImportCounts {
  added: number;
  updated: number;
  skipped: number;
  conflicts: number;
}

export interface ImportPreviewReport {
  reviewWords: ReviewImportCounts;
  conflicts: string[];
}

export interface VocabStats {
  upgradeEntries: number;
  upgradeExamples: number;
  selfChecks: number;
  reviewWords: number;
  importRuns: number;
}

export interface BrowseExample {
  seq: number;
  cand: string;
  sentence: string;
  ai: boolean;
}

export interface BrowseUpgrade {
  id: string;
  ord: number;
  line: number;
  raw: string;
  plain: string;
  upgrade: string;
  source: string;
  note: string;
  examples: BrowseExample[];
}

export interface BrowseSelfCheck {
  id: string;
  ord: number;
  line: number;
  raw: string;
  text: string;
}

export interface BrowseDefinitionExample {
  seq: number;
  sentence: string;
  ai: boolean;
}

export interface BrowseDefinition {
  sourceFile: string;
  sourceLine: number;
  pos: string;
  english: string;
  chinese: string;
  examples: BrowseDefinitionExample[];
}

export interface BrowseReviewWord {
  id: string;
  ord: number;
  line: number;
  raw: string;
  word: string;
  issue: string;
  addedAt: string;
  status: string;
  level: number | null;
  due: string;
  note: string;
  source: string;
  verificationStatus: VerificationStatus;
  definitions: BrowseDefinition[];
}

export const VERIFICATION_STATUSES = ['未查证', '词典或ACL已查', '老师确认'] as const;
export type VerificationStatus = typeof VERIFICATION_STATUSES[number];

export interface ReviewMetadataRequest {
  id: string;
  source: string;
  verificationStatus: VerificationStatus;
}

export interface ReviewMetadataResult extends ReviewMetadataRequest {
  updatedAt: string;
}

export interface InboxConfirmWord {
  word: string;
  note: string;
}

export interface InboxConfirmRequest {
  date: string;
  /** 缺省仍为手写，兼容已有的本地调用。 */
  source?: '手写' | 'Notion';
  words: InboxConfirmWord[];
}

export interface InboxConfirmResult {
  added: number;
  words: string[];
}

/** 042 手动加词。状态、查证、原始行由后端统一写，前端只给内容。 */
export interface ManualAddRequest {
  word: string;
  pos: string;
  chinese: string;
  english: string;
  example: string;
  /** 来源：默认「手动添加」，查词卡上加的写所在页面（精听、教练……）。 */
  source: string;
  /** 期号，默认今天（如 11.10）。 */
  issue: string;
  /** 入库日期 YYYY-MM-DD。 */
  date: string;
  /** 复习备注，写进复习库那一行的「备注」列。 */
  note: string;
  /** 已有同名词时仍要再加一行（新义项 / 新一期）。 */
  allowDuplicate: boolean;
}

export interface ManualAddResult {
  id: string;
  word: string;
  issue: string;
  source: string;
  existing: number;
}

export interface BrowseData {
  upgrades: BrowseUpgrade[];
  selfChecks: BrowseSelfCheck[];
  reviewWords: BrowseReviewWord[];
}

export interface ImportReport {
  upgradeEntries: ImportCounts;
  upgradeExamplesAdded: number;
  selfChecks: ImportCounts;
  reviewWords: ReviewImportCounts;
  totals: VocabStats;
  upgradeSha256: string;
  reviewSha256: string;
}

export interface DefinitionImportRequest {
  issues: SourceSnapshot[];
  eagp: SourceSnapshot | null;
}

export interface DefinitionUnmatched {
  fileName: string;
  line: number;
  word: string;
  reason: string;
}

export interface DefinitionImportReport {
  matched: number;
  added: number;
  skipped: number;
  unmatched: number;
  examplesAdded: number;
  unmatchedItems: DefinitionUnmatched[];
}

export type ReviewKind = 'recall' | 'rewrite' | 'sentence' | 'choice';

export interface ReviewSubmitRequest {
  id: string;
  kind: ReviewKind;
  correct: boolean;
  /** 047：首考前看过释义；缺省 false，到期复习不传。 */
  previewed?: boolean;
}

/** 031：只写日志、不改复习状态的事件。 */
export type ReviewEventKind = 'recheck' | 'question_error' | 'typo';

export interface ReviewEventRequest {
  id: string;
  kind: ReviewEventKind;
  correct: boolean;
  detail: string;
}

export interface ReviewEventResult {
  id: string;
  kind: ReviewEventKind;
  reviewDate: string;
  status: string;
  due: string;
}

export interface FlaggedSurface {
  wordId: string;
  detail: string;
}

export interface ReviewSubmitResult extends ReviewSubmitRequest {
  reviewDate: string;
  changed: boolean;
  status: string;
  level: 1 | 2 | 3 | 4 | null;
  due: string;
  note: string;
}

export interface VocabExportResult {
  path: string;
  kind: 'upgrade' | 'review';
  records: number;
  selfChecks: number;
  sourceCsvPath: string | null;
  /** 040：有笔记时同目录写的「我的笔记.md」；没有笔记为 null。 */
  notesPath: string | null;
  notes: number;
  /** 043：有例句时同目录写的「我的例句.md」；没有例句为 null。 */
  examplesPath: string | null;
  examples: number;
  /** 078：有英英释义时同目录写的「我的英英释义.md」；没有为 null。 */
  definitionsEnPath: string | null;
  definitionsEn: number;
}

// ---------- 040 词条笔记 ----------

/** 笔记从哪里记的。040 词库页只产生「词库」；复习、首考、闪卡是 041 的按钮。 */
export const NOTE_SOURCES = ['词库', '复习', '首考', '闪卡'] as const;
export type NoteSource = typeof NOTE_SOURCES[number];

/** 一条词条笔记。wordKey 是归一化后的词（同 library.ts 的 normalizeText），按它分组。 */
export interface VocabNote {
  id: number;
  wordKey: string;
  /** 记下时的写法（保留大小写），展示用。 */
  word: string;
  body: string;
  source: NoteSource;
  createdAt: string;
  updatedAt: string;
}

export interface NoteAddRequest { word: string; body: string; source: NoteSource }
export interface NoteUpdateRequest { id: number; body: string }

// ---------- 055 随手记 ----------

export type QuickNoteKind = 'none' | 'video' | 'dictation' | 'entry';
export type QuickNoteStatus = '待整理' | '已整理';

/** 记下时在看什么。kind = none 时其余都没有。 */
export interface QuickNoteContext {
  kind: QuickNoteKind;
  /** 字幕句原文 */
  text?: string | null;
  videoId?: string | null;
  videoName?: string | null;
  /** 时间点（秒） */
  time?: number | null;
  entryId?: string | null;
  word?: string | null;
}

export interface QuickNote {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  context: QuickNoteContext;
  status: QuickNoteStatus;
  /** 整理后去了哪（056 填）；没整理是 null。 */
  destination: string | null;
  /** 哪台设备记的（以后同步用）。 */
  deviceId: string;
}

export interface QuickNoteAddRequest { body: string; context?: QuickNoteContext }

// ---------- 043 我的例句 ----------

/** AI生成 = AI 按义项给的；自己写 = 用户原句；AI改过 = AI 改后的句子。 */
export const EXAMPLE_SOURCES = ['AI生成', '自己写', 'AI改过'] as const;
export type ExampleSource = typeof EXAMPLE_SOURCES[number];

/** 一条「我的例句」。wordKey 是归一化后的词（同 normalizeText），按它分组。 */
export interface VocabExample {
  id: number;
  wordKey: string;
  /** 存下时的写法（保留大小写），展示用。 */
  word: string;
  sentence: string;
  source: ExampleSource;
  /** AI 的中文说明；可能为空。 */
  explanation: string | null;
  /** 生成/判断时选的义项；可能为空。 */
  sense: string | null;
  /** 改句前的原句，只有「AI改过」才有。 */
  original: string | null;
  createdAt: string;
}

export interface ExampleItem { sentence: string; source: ExampleSource; explanation?: string | null; sense?: string | null; original?: string | null }
export interface ExampleAddRequest { word: string; items: ExampleItem[] }

/** 048：一句例句的场景标签（按规范化后的句子文字存）。source：AI = 模型标的；手动 = 用户选的。 */
export interface ExampleScene { key: string; sentence: string; scene: string; source: 'AI' | '手动'; updatedAt: string }
export interface SceneSetRequest { items: { sentence: string; scene: string }[]; source: 'AI' | '手动' }

export interface ErrorArchiveTop {
  id: string;
  ord: number;
  line: number;
  raw: string;
  rank: number;
  kind: string;
  count: string;
  lastAt: string;
  status: string;
}

export interface ErrorArchiveBatch {
  id: string;
  ord: number;
  line: number;
  raw: string;
  title: string;
  date: string;
  metadata: Record<string, string>;
}

export interface ErrorArchiveItem {
  id: string;
  batchId: string;
  ord: number;
  line: number;
  raw: string;
  question: string;
  kind: string;
  written: string;
  correction: string;
  note: string;
}

export interface ErrorArchiveTodo {
  id: string;
  ord: number;
  line: number;
  raw: string;
  done: boolean;
  text: string;
}

export interface ErrorArchiveEssay {
  id: string;
  ord: number;
  line: number;
  raw: string;
  date: string;
  standard: string;
  topic: string;
  wordCount: string;
  originalFile: string;
  result: string;
}

export interface ErrorArchiveParseResult {
  top: ErrorArchiveTop[];
  batches: ErrorArchiveBatch[];
  items: ErrorArchiveItem[];
  todos: ErrorArchiveTodo[];
  essays: ErrorArchiveEssay[];
  warnings: VocabWarning[];
}

export interface ErrorArchiveImportInput extends ErrorArchiveParseResult {
  source: SourceSnapshot;
}

export interface ErrorImportReport {
  top: number;
  batches: number;
  items: number;
  todos: number;
  essays: number;
  sourceSha256: string;
  totals: VocabStats;
}

export interface CoachTop {
  id: string;
  ord: number;
  rank: number;
  kind: string;
  count: string;
  lastAt: string;
  status: string;
}

export interface CoachItem {
  id: string;
  batchId: string;
  ord: number;
  question: string;
  kind: string;
  written: string;
  correction: string;
  note: string;
}

export interface CoachBatch {
  id: string;
  ord: number;
  title: string;
  date: string;
  metadata: Record<string, string>;
  items: CoachItem[];
}

export interface CoachTodo {
  id: string;
  ord: number;
  done: boolean;
  text: string;
}

export interface CoachArchiveData {
  top: CoachTop[];
  batches: CoachBatch[];
  todos: CoachTodo[];
}

export interface CoachArchiveItemInput {
  kind: string;
  written: string;
  correction: string;
  note: string;
}

export interface CoachArchiveRequest {
  reviewId: string;
  essay: string;
  resultJson: string;
  title: string;
  date: string;
  paperType: string;
  wordCount: number;
  items: CoachArchiveItemInput[];
}

export interface CoachTopChange {
  topId: string;
  kind: string;
  isNew: boolean;
  occurrences: number;
  beforeCount: number;
  afterCount: number;
  beforeLastAt: string;
  afterLastAt: string;
  beforeStatus: string;
  afterStatus: string;
  beforeClean: number;
  afterClean: number;
}

export interface CoachArchivePlan {
  reviewId: string;
  batchId: string;
  duplicate: boolean;
  itemsAdded: number;
  topChanges: CoachTopChange[];
}

// ---------- 078 英英释义 ----------

/** mine = 自己写的；dict:cambridge / dict:wiktionary / dict:local-wiktionary / dict:local = 词典查来的。 */
export type DefinitionEnSource = string;

/** 一条英英释义（存在 vocab_definition_en 表）。wordKey 是归一化后的词。 */
export interface VocabDefinitionEn {
  id: number;
  wordKey: string;
  word: string;
  pos: string | null;
  text: string;
  source: DefinitionEnSource;
  createdAt: string;
  updatedAt: string;
}

export interface DefinitionEnItem { pos?: string | null; text: string }
export interface DefinitionEnAddRequest { word: string; source: DefinitionEnSource; items: DefinitionEnItem[] }
export interface DefinitionEnUpdateRequest { id: number; pos?: string | null; text: string }
