import { parseReviewLibrary, parseUpgradeLibrary } from './parse';
import type { SourceSnapshot, VocabImportInput, VocabPreview } from './types';

const hasLine = (content: string, wanted: string) =>
  content.split(/\r\n|\n|\r/).some(line => line.trim() === wanted);

const hasTableHeader = (content: string, firstCell: string) =>
  content.split(/\r\n|\n|\r/).some(line => line.trim().startsWith(`| ${firstCell}`));

/** 只从当前两份文本构造不可关联到后续文件选择的内容快照。 */
export function buildImportPreview(upgrade: SourceSnapshot, review: SourceSnapshot): VocabPreview {
  const upgradeResult = parseUpgradeLibrary(upgrade.content);
  const reviewResult = parseReviewLibrary(review.content);
  const errors: string[] = [];

  if (!hasLine(upgrade.content, '## 词汇升级')) errors.push('升级库缺少「## 词汇升级」章节');
  if (!hasTableHeader(upgrade.content, '日常/口语')) errors.push('升级库缺少「日常/口语」表头');
  if (!hasLine(upgrade.content, '## 写作自查对照')) errors.push('升级库缺少「## 写作自查对照」章节');
  if (!hasLine(review.content, '## 总词库')) errors.push('复习库缺少「## 总词库」章节');
  if (!hasTableHeader(review.content, '单词')) errors.push('复习库缺少「单词」表头');
  if (upgradeResult.entries.length === 0) errors.push('升级库主表没有有效记录');
  if (reviewResult.words.length === 0) errors.push('复习库主表没有有效记录');

  for (const warning of upgradeResult.warnings) {
    if (warning.kind === 'columns' || warning.kind === 'status') {
      errors.push(`升级库第 ${warning.line} 行：${warning.message}`);
    }
  }
  for (const warning of reviewResult.warnings) {
    if (warning.kind === 'columns' || warning.kind === 'status') {
      errors.push(`复习库第 ${warning.line} 行：${warning.message}`);
    }
  }

  // 逐条复制，调用方之后改写原文件对象或解析结果都不会变动本次提交内容。
  const input: VocabImportInput = {
    upgrade: { fileName: upgrade.fileName, content: upgrade.content },
    review: { fileName: review.fileName, content: review.content },
    entries: upgradeResult.entries.map(({ examples: _examples, ...entry }) => ({ ...entry })),
    examples: upgradeResult.entries.flatMap(entry => entry.examples.map((example, index) => ({
      ...example,
      entryId: entry.id,
      seq: index + 1,
    }))),
    selfChecks: upgradeResult.selfChecks.map(check => ({ ...check })),
    reviewWords: reviewResult.words.map(word => ({ ...word })),
    warnings: {
      upgrade: upgradeResult.warnings.map(warning => ({ ...warning })),
      review: reviewResult.warnings.map(warning => ({ ...warning })),
    },
  };

  return {
    input,
    reviewCounts: null,
    errors,
    warnings: input.warnings,
    counts: {
      upgradeEntries: input.entries.length,
      upgradeExamples: input.examples.length,
      selfChecks: input.selfChecks.length,
      reviewWords: input.reviewWords.length,
    },
  };
}

/**
 * 文件选择与导入共用的同步闸门。token 过期后结果不得上屏；同一 token 同时只能导入一次。
 * 放在纯 TypeScript 中，让竞态规则可以不启动 WebView 就直接测试。
 */
export function createImportGate() {
  let revision = 0;
  let activeImport: number | null = null;
  return {
    nextSelection(): number {
      revision += 1;
      return revision;
    },
    invalidate(): void {
      revision += 1;
    },
    isCurrent(token: number): boolean {
      return token === revision;
    },
    beginImport(token: number): boolean {
      if (token !== revision || activeImport !== null) return false;
      activeImport = token;
      return true;
    },
    finishImport(token: number): void {
      if (activeImport === token) activeImport = null;
    },
  };
}
