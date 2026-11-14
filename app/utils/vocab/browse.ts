import type { BrowseData, BrowseExample, BrowseReviewWord, BrowseUpgrade, BrowseSelfCheck, VerificationStatus } from './types';

export type VocabTab = 'upgrade' | 'review' | 'selfCheck';

/** 查询规范化：去首尾空白、转小写；空串表示不过滤。 */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

const has = (text: string, q: string) => text.toLowerCase().includes(q);

function upgradeHit(item: BrowseUpgrade, q: string): boolean {
  return (
    has(item.plain, q) ||
    has(item.upgrade, q) ||
    has(item.source, q) ||
    has(item.note, q) ||
    item.examples.some(example => has(example.sentence, q) || has(example.cand, q))
  );
}

function reviewHit(item: BrowseReviewWord, q: string): boolean {
  return has(item.word, q) || has(item.issue, q) || has(item.status, q) || has(item.note, q) || has(item.source, q) || has(item.verificationStatus, q) ||
    (item.definitions ?? []).some(definition => has(definition.pos, q) || has(definition.english, q) || has(definition.chinese, q) || definition.examples.some(example => has(example.sentence, q)));
}

/** 按子串过滤，保持原顺序；空查询返回原数组（默认顺序）。 */
export function filterUpgrades(items: BrowseUpgrade[], query: string): BrowseUpgrade[] {
  const q = normalizeQuery(query);
  return q ? items.filter(item => upgradeHit(item, q)) : items;
}

export function filterReviews(items: BrowseReviewWord[], query: string, verificationStatus: VerificationStatus | '全部' = '全部'): BrowseReviewWord[] {
  const q = normalizeQuery(query);
  return items.filter(item =>
    (verificationStatus === '全部' || item.verificationStatus === verificationStatus) &&
    (!q || reviewHit(item, q))
  );
}

export function filterSelfChecks(items: BrowseSelfCheck[], query: string): BrowseSelfCheck[] {
  const q = normalizeQuery(query);
  return q ? items.filter(item => has(item.text, q)) : items;
}

export function emptyBrowse(): BrowseData {
  return { upgrades: [], selfChecks: [], reviewWords: [] };
}

export function isBrowseEmpty(data: BrowseData): boolean {
  return data.upgrades.length === 0 && data.selfChecks.length === 0 && data.reviewWords.length === 0;
}

/** 例句里 AI 标记的中文展示文字。 */
export function exampleLabel(example: BrowseExample): string {
  return example.ai ? 'AI 例句' : '原有例句';
}

/**
 * 「只认最新一次」闸门：每次发起请求取一个 token，先发后到的旧响应、
 * 以及页面离开（dispose）之后到达的响应都会被判为过期。
 */
export function createLatestGate() {
  let revision = 0;
  let disposed = false;
  return {
    next(): number {
      revision += 1;
      return revision;
    },
    isCurrent(token: number): boolean {
      return !disposed && token === revision;
    },
    dispose(): void {
      disposed = true;
      revision += 1;
    },
    /** StrictMode 会先清理再重新挂载，重新挂载时要复活。 */
    revive(): void {
      disposed = false;
    },
  };
}
