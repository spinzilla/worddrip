import { useMemo, useSyncExternalStore } from 'react';
import { aiTasks, type AiTask, type AiTaskSource } from '../../utils/aiTasks';

/**
 * 按来源找任务，并跟着任务中心变化重新算（切页面再回来，任务还在、结果还在）。
 * 返回的任务新的在前；match 里的字段都要相等。
 */
export function useAiTasksBy(match: Partial<AiTaskSource>): AiTask[] {
  const all = useSyncExternalStore(aiTasks.subscribe, aiTasks.getTasks);
  const key = JSON.stringify(match);
  return useMemo(() => {
    const want = JSON.parse(key) as Partial<AiTaskSource>;
    const fields = Object.keys(want) as (keyof AiTaskSource)[];
    return all.filter(task => fields.every(field => task.source[field] === want[field]));
  }, [all, key]);
}

export const isLiveTask = (task: AiTask | undefined): boolean => task?.status === 'running' || task?.status === 'queued';
