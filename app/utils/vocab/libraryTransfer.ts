import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile } from '@tauri-apps/plugin-fs';
import { notifyVocabChanged } from './manualAdd';
import { notifyQuickNotesChanged } from '../quicknote/changed';
import { appVersion } from '../desktop';
import { applyImportedSettings, exportSettingsJson } from '../settingsBackupLogic';

export interface LibrarySummary {
  words: number;
  due: number;
  notes: number;
  quickNotes: number;
  exportedAt: string | null;
  schemaVersion: number;
  /** 083：文件里带的设置（JSON 文本）；旧版导出的文件没有。 */
  settings?: string | null;
}

export interface LibraryImportResult {
  summary: LibrarySummary;
  backupPath: string | null;
}

export interface LibraryCandidate {
  fileName: string;
  data: Uint8Array;
  summary: LibrarySummary;
}

export interface LibraryExportResult {
  path: string;
  bytes: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
export function libraryFileName(now = new Date()): string {
  return `词滴词库-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.wdlib`;
}

/** 同一个 writeFile 同时支持电脑普通路径和安卓 content://，不在 Rust 里打开选择器返回值。 */
export async function writePickedFile(path: string, data: Uint8Array): Promise<void> {
  await writeFile(path, data);
}

export async function writePickedTextFile(path: string, text: string): Promise<void> {
  await writePickedFile(path, new TextEncoder().encode(text));
}

/** 先做 SQLite 在线备份，再弹保存框；取消时只留下本机原库，不产生半成品。 */
export interface ExportOptions { withSettings: boolean; includeApiKey: boolean }

/** 083：勾了「同时导出设置」就把设置一起放进文件；API key 默认不带，同步空间凭据永远不带。 */
export async function exportWholeLibrary(opts: ExportOptions = { withSettings: false, includeApiKey: false }): Promise<LibraryExportResult | null> {
  const settings = opts.withSettings
    ? exportSettingsJson(localStorage, await appVersion().catch(() => ''), opts.includeApiKey)
    : null;
  const bytes = await invoke<number[]>('vocab_library_export', { settings });
  const selected = await save({ defaultPath: libraryFileName() });
  if (typeof selected !== 'string') return null;
  await writePickedFile(selected, Uint8Array.from(bytes));
  return { path: selected, bytes: bytes.length };
}

/** 安卓按 MIME 过滤会漏掉自定义扩展名，所以这里不加扩展名过滤器。 */
export async function pickWholeLibrary(): Promise<LibraryCandidate | null> {
  const selected = await open({ multiple: false });
  if (typeof selected !== 'string') return null;
  const data = await readFile(selected);
  const summary = await invoke<LibrarySummary>('vocab_library_preview', { request: { data: Array.from(data) } });
  return { fileName: selected.split(/[/\\]/).pop() || selected, data, summary };
}

/** restoreSettings：文件里带了设置、且用户选了恢复时传入那段 JSON；不带 API key 的文件不会清掉本机原来的 key。 */
export async function importWholeLibrary(data: Uint8Array, restoreSettings?: string | null): Promise<LibraryImportResult & { settingsRestored: number }> {
  const result = await invoke<LibraryImportResult>('vocab_library_import', { request: { data: Array.from(data) } });
  const settingsRestored = restoreSettings ? applyImportedSettings(localStorage, restoreSettings) : 0;
  // 设置页仍挂着，词库页靠原有事件在下次显示时重读；随手记计数也同步刷新。
  notifyVocabChanged();
  notifyQuickNotesChanged();
  return { ...result, settingsRestored };
}
