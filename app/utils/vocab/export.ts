import type { VocabStats } from './types';

export type ExportKind = 'upgrade' | 'review';

export const exportFileName = (kind: ExportKind) =>
  kind === 'upgrade' ? '学术升级库-导出.md' : '词汇复习库-导出.md';

export function exportAvailability(kind: ExportKind, stats: VocabStats, loading: boolean) {
  if (loading) return { disabled: true, reason: '正在读取词库统计' };
  const empty = kind === 'upgrade' ? stats.upgradeEntries === 0 : stats.reviewWords === 0;
  return {
    disabled: empty,
    reason: empty ? `${kind === 'upgrade' ? '学术升级库' : '复习库'}为空，没有可导出的记录` : '',
  };
}

/** 同步上锁防双击；失效后旧 Promise 不能再改新页面状态。 */
export function createExportGate() {
  let epoch = 0;
  let busy = false;
  return {
    begin(): number | null {
      if (busy) return null;
      busy = true;
      epoch += 1;
      return epoch;
    },
    isCurrent(token: number) { return token === epoch; },
    finish(token: number) {
      if (token === epoch) busy = false;
    },
    invalidate() {
      epoch += 1;
      busy = false;
    },
  };
}