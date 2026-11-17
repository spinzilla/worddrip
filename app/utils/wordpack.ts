import { invoke } from '@tauri-apps/api/core';

export interface WordpackEntry {
  word: string;
  phonetic: string;
  pos: string;
  zh: string;
  en: string;
  frq: number | null;
  bnc: number | null;
  tags: string[];
  exchange: string;
}

export interface WordpackInfo {
  version: number;
  wordCount: number;
  tagCounts: Record<string, number>;
}

export interface WordpackListOptions {
  exclude?: string[];
  offset?: number;
  limit?: number;
}

export const wordpackInfo = () => invoke<WordpackInfo>('wordpack_info');
export const wordpackList = (tags: string[] = [], options: WordpackListOptions = {}) =>
  invoke<WordpackEntry[]>('wordpack_list', { tags, options });
export const wordpackLookup = (word: string) =>
  invoke<WordpackEntry | null>('wordpack_lookup', { word });
export const wordpackBand = (rankFrom: number, rankTo: number, n: number, seed?: number) =>
  invoke<WordpackEntry[]>('wordpack_band', { rankFrom, rankTo, n, seed: seed ?? null });
export const wordpackLicense = () => invoke<string>('wordpack_license');
