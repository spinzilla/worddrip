// 081 学习计划的数据库读写（Rust 单行表 daily_plan，会同步）。逻辑在 dailyWords.ts（可单测），这里只接真实依赖。
import { subscribeSync, getSyncState } from '../sync/manager';
import { vocabApi } from './api';
import { refreshPlanFrom, savePlanTo, type Plan } from './dailyWords';

/** 存计划：本机缓存 + 数据库（同步会带走）。设置页、079 首次引导都用这个。 */
export function savePlanSynced(plan: Plan): Promise<void> {
  return savePlanTo(vocabApi, plan);
}

/** 以数据库为准刷新本机缓存。 */
export function refreshPlan(): Promise<Plan> {
  return refreshPlanFrom(vocabApi);
}

/** 组件挂载时调用：立刻读一次库，之后每次同步完成（lastAt 变了）再读一次；返回取消函数。 */
export function watchPlan(): () => void {
  let alive = true;
  const run = () => { if (alive) void refreshPlan().catch(() => { /* 读不到就继续用本机缓存 */ }); };
  run();
  let last = getSyncState().lastAt;
  const off = subscribeSync(() => {
    const now = getSyncState().lastAt;
    if (now !== last) { last = now; run(); }
  });
  return () => { alive = false; off(); };
}
