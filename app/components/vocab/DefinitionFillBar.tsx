import React, { useMemo, useSyncExternalStore } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import { useMyDefinitions } from './DefinitionsEn';
import { definitionKey, hasAnyEnglish } from '../../utils/vocab/definitionEn';
import { definitionJob, setHasEnglish } from '../../utils/vocab/definitionEnDict';
import { jobReport } from '../../utils/vocab/definitionJob';
import type { WordGroup } from '../../utils/vocab/library';

// 078 一键补全英英释义：给所有还没有英英释义的词批量查词典。后台跑（切页面不中断），可取消，在线查词限速每秒不超过 2 个。
// 只有用户点了按钮才跑；不会自动批量跑。

export default function DefinitionFillBar({ words }: { words: readonly WordGroup[] }) {
  const job = useSyncExternalStore(definitionJob.subscribe, definitionJob.getState);
  const defs = useMyDefinitions();
  const missing = useMemo(
    () => words.filter(group => !hasAnyEnglish(defs.byKey.get(definitionKey(group.word)) ?? [], group.definitions.map(d => ({ pos: d.pos, english: d.english })))),
    [words, defs.byKey],
  );
  // 任务每处理一个词前都会问「这个词现在有没有英英释义」，答案用最新的词库数据。
  const byWord = useMemo(() => new Map(words.map(group => [definitionKey(group.word), group])), [words]);
  setHasEnglish(word => {
    const group = byWord.get(definitionKey(word));
    return hasAnyEnglish(defs.byKey.get(definitionKey(word)) ?? [], (group?.definitions ?? []).map(d => ({ pos: d.pos, english: d.english })));
  });

  const percent = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  const report = jobReport(job);
  if (!job.running && !job.finished && (!defs.loaded || missing.length === 0)) return null;
  return (
    <div className="mt-3 rounded-xl border border-line bg-shade/40 px-3 py-2.5 text-sm" data-testid="def-fill">
      {job.running ? (
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Loader2 size={14} className="animate-spin text-mute" />
            <span className="min-w-0 flex-1" data-testid="def-fill-progress">正在补全 {job.done} / {job.total}{job.current ? `：${job.current}` : ''}</span>
            <button type="button" onClick={() => definitionJob.cancel()} className="press inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-xs text-ink" data-testid="def-fill-cancel"><X size={12} />取消</button>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
          </div>
        </div>
      ) : job.finished ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1" role="status" data-testid="def-fill-report">{report}</span>
          <button type="button" onClick={() => definitionJob.dismiss()} className="press rounded-lg border border-line px-2.5 py-1 text-xs text-ink">知道了</button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-mute">有 {missing.length} 个词还没有英英释义。</span>
          <button type="button" onClick={() => void definitionJob.start(missing.map(group => group.word))} className="press inline-flex items-center gap-1 rounded-lg bg-ink px-3 py-1.5 text-xs text-white" data-testid="def-fill-start"><Sparkles size={12} />一键补全英英释义</button>
        </div>
      )}
    </div>
  );
}
