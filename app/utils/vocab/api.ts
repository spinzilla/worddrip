import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import type { DefinitionImportReport, DefinitionImportRequest, BrowseData, CoachArchiveData, CoachArchivePlan, CoachArchiveRequest, ErrorArchiveImportInput, ErrorImportReport, ImportPreviewReport, ImportReport, InboxConfirmRequest, InboxConfirmResult, ManualAddRequest, ManualAddResult, ExampleAddRequest, ExampleScene, SceneSetRequest, QuickNote, QuickNoteAddRequest, QuickNoteStatus, FlaggedSurface, NoteAddRequest, NoteUpdateRequest, ReviewEventRequest, ReviewEventResult, ReviewMetadataRequest, ReviewMetadataResult, ReviewSubmitRequest, ReviewSubmitResult, SourceSnapshot, VocabExportResult, VocabImportInput, VocabExample, VocabNote, VocabStats } from './types';
import { exportFileName, type ExportKind } from './export';
import { notifyQuickNotesChanged } from '../quicknote/changed';
import { requestSync } from '../sync/manager';

// 072：写入类操作成功后请求一次自动同步（没开同步时什么也不做）。
const thenSync = <T,>(p: Promise<T>): Promise<T> => p.then(r => { requestSync(); return r; });

export const vocabApi = {
  async pickMarkdown(): Promise<SourceSnapshot | null> {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    });
    if (typeof selected !== 'string') return null;
    const content = await readTextFile(selected);
    const parts = selected.split(/[/\\]/);
    return { fileName: parts[parts.length - 1] || selected, content };
  },

  import(input: VocabImportInput): Promise<ImportReport> {
    return invoke<ImportReport>('vocab_import', { request: input });
  },

  previewImport(input: VocabImportInput): Promise<ImportPreviewReport> {
    return invoke<ImportPreviewReport>('vocab_import_preview', { request: input });
  },

  async pickMarkdowns(): Promise<SourceSnapshot[]> {
    const selected = await open({
      multiple: true,
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    });
    if (!Array.isArray(selected)) return [];
    return Promise.all(selected.map(async path => {
      const content = await readTextFile(path);
      const parts = path.split(/[/\\]/);
      return { fileName: parts[parts.length - 1] || path, content };
    }));
  },

  previewDefinitions(request: DefinitionImportRequest): Promise<DefinitionImportReport> {
    return invoke<DefinitionImportReport>('vocab_definition_preview', { request });
  },

  importDefinitions(request: DefinitionImportRequest): Promise<DefinitionImportReport> {
    return invoke<DefinitionImportReport>('vocab_definition_import', { request });
  },

  importErrors(input: ErrorArchiveImportInput): Promise<ErrorImportReport> {
    return invoke<ErrorImportReport>('vocab_errors_import', { request: input });
  },

  previewErrorsImport(): Promise<void> {
    return invoke<void>('vocab_errors_import_preview');
  },

  browse(): Promise<BrowseData> {
    return invoke<BrowseData>('vocab_browse');
  },

  coachBrowse(): Promise<CoachArchiveData> {
    return invoke<CoachArchiveData>('vocab_coach_browse');
  },

  previewCoachArchive(request: CoachArchiveRequest): Promise<CoachArchivePlan> {
    return invoke<CoachArchivePlan>('vocab_coach_archive_preview', { request });
  },

  archiveCoachReview(request: CoachArchiveRequest): Promise<CoachArchivePlan> {
    return invoke<CoachArchivePlan>('vocab_coach_archive', { request });
  },
  submitReview(request: ReviewSubmitRequest): Promise<ReviewSubmitResult> {
    return thenSync(invoke<ReviewSubmitResult>('vocab_review_submit', { request }));
  },

  /** 同日复检 / 题目出错 / 笔误申诉：只写日志，不改复习状态。 */
  reviewEvent(request: ReviewEventRequest): Promise<ReviewEventResult> {
    return thenSync(invoke<ReviewEventResult>('vocab_review_event', { request }));
  },

  flaggedSurfaces(): Promise<FlaggedSurface[]> {
    return invoke<FlaggedSurface[]>('vocab_review_flagged');
  },

  updateReviewMetadata(request: ReviewMetadataRequest): Promise<ReviewMetadataResult> {
    return invoke<ReviewMetadataResult>('vocab_review_metadata_update', { request });
  },

  confirmInbox(request: InboxConfirmRequest): Promise<InboxConfirmResult> {
    return invoke<InboxConfirmResult>('vocab_inbox_confirm', { request });
  },

  /** 042 手动加词：同名词默认被拒，allowDuplicate 为 true 才再加一行。 */
  manualAdd(request: ManualAddRequest): Promise<ManualAddResult> {
    return invoke<ManualAddResult>('vocab_manual_add', { request });
  },

  /** 040 词条笔记：只在本机存着，出题、判分、批改都不读。 */
  listNotes(): Promise<VocabNote[]> {
    return invoke<VocabNote[]>('vocab_notes');
  },

  addNote(request: NoteAddRequest): Promise<VocabNote> {
    return invoke<VocabNote>('vocab_note_add', { request });
  },

  updateNote(request: NoteUpdateRequest): Promise<VocabNote> {
    return invoke<VocabNote>('vocab_note_update', { request });
  },

  deleteNote(id: number): Promise<number> {
    return invoke<number>('vocab_note_delete', { request: { id } });
  },

  /** 043 我的例句：按词挂，只在本机存着，出题、判分都不读。 */
  listExamples(): Promise<VocabExample[]> {
    return invoke<VocabExample[]>('vocab_examples');
  },

  /** 给一个词存一句或几句；整批一个事务，有一句不合格就一句都不存。 */
  addExamples(request: ExampleAddRequest): Promise<VocabExample[]> {
    return invoke<VocabExample[]>('vocab_example_add', { request });
  },

  listScenes(): Promise<ExampleScene[]> {
    return invoke<ExampleScene[]>('vocab_scenes');
  },

  setScenes(request: SceneSetRequest): Promise<ExampleScene[]> {
    return invoke<ExampleScene[]>('vocab_scene_set', { request });
  },

  /** 055 随手记：按时间倒序（新的在前），status 可筛「待整理 / 已整理」。 */
  listQuickNotes(status?: QuickNoteStatus): Promise<QuickNote[]> {
    return invoke<QuickNote[]>('quicknote_list', { status: status ?? null });
  },

  addQuickNote(request: QuickNoteAddRequest): Promise<QuickNote> {
    return thenSync(invoke<QuickNote>('quicknote_add', { request })).then(note => { notifyQuickNotesChanged(); return note; });
  },

  /** 只改正文。 */
  updateQuickNote(id: number, body: string): Promise<QuickNote> {
    return invoke<QuickNote>('quicknote_update', { request: { id, body } }).then(note => { notifyQuickNotesChanged(); return note; });
  },

  /** 标状态；destination 不传 = 不动去向，传空串 = 清掉去向。 */
  markQuickNote(id: number, status: QuickNoteStatus, destination?: string): Promise<QuickNote> {
    return invoke<QuickNote>('quicknote_mark', { request: { id, status, destination: destination ?? null } }).then(note => { notifyQuickNotesChanged(); return note; });
  },

  deleteQuickNote(id: number): Promise<number> {
    return invoke<number>('quicknote_delete', { request: { id } }).then(value => { notifyQuickNotesChanged(); return value; });
  },

  deleteExample(id: number): Promise<number> {
    return invoke<number>('vocab_example_delete', { request: { id } });
  },

  stats(): Promise<VocabStats> {
    return invoke<VocabStats>('vocab_stats');
  },

  async exportMarkdown(kind: ExportKind): Promise<VocabExportResult | null> {
    const selected = await save({
      defaultPath: exportFileName(kind),
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    });
    if (typeof selected !== 'string') return null;
    return invoke<VocabExportResult>('vocab_export', { request: { kind, path: selected } });
  },
};
