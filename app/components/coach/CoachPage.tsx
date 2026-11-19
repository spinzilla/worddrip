import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, Circle, RefreshCw } from 'lucide-react';
import { getEndpoint } from '../../utils/aiConfig';
import { coachItemTitle, emptyCoachArchive, isCoachEmpty } from '../../utils/coach/archive';
import { vocabApi } from '../../utils/vocab/api';
import type { CoachItem } from '../../utils/vocab/types';
import EssayReview from './EssayReview';
import WritingPractice from '../writing/WritingPractice';
import Lookable from '../Lookable';
import { useT } from '../../utils/i18n';

function ItemDetail({ item }: { item: CoachItem }) {
  return (
    <article className="min-w-0 border-t border-line py-4 first:border-t-0 first:pt-0" data-testid="coach-item" data-item-id={item.id}>
      <h4 className="break-words text-sm font-medium text-ink">{coachItemTitle(item)}</h4>
      <dl className="mt-3 grid gap-3 text-sm md:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs text-mute">我写的</dt>
          <dd className="mt-1 whitespace-pre-wrap break-words text-ink [overflow-wrap:anywhere]">{item.written || '（空）'}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-mute">改法</dt>
          <dd className="mt-1 whitespace-pre-wrap break-words text-ink [overflow-wrap:anywhere]">{item.correction || '（空）'}</dd>
        </div>
        <div className="min-w-0 md:col-span-2">
          <dt className="text-xs text-mute">说明</dt>
          <dd className="mt-1 whitespace-pre-wrap break-words text-mute [overflow-wrap:anywhere]">{item.note || '（无说明）'}</dd>
        </div>
      </dl>
    </article>
  );
}

type CoachTab = 'writing' | 'essay' | 'errors';
const TAB_KEY = 'english-studio.coach.tab';
const TABS: readonly CoachTab[] = ['writing', 'essay', 'errors'];
const readTab = (): CoachTab => {
  try { const saved = localStorage.getItem(TAB_KEY); return TABS.find(tab => tab === saved) ?? 'writing'; } catch { return 'writing'; }
};

export default function CoachPage() {
  const t = useT();
  const [tab, setTabState] = useState<CoachTab>(readTab);
  const setTab = (next: CoachTab) => { setTabState(next); try { localStorage.setItem(TAB_KEY, next); } catch { /* 记不住就算了 */ } };
  const [data, setData] = useState(emptyCoachArchive);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const modelMissing = getEndpoint() === null;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await vocabApi.coachBrowse());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const empty = isCoachEmpty(data);
  const itemCount = data.batches.reduce((total, batch) => total + batch.items.length, 0);

  return (
    <div className="mx-auto min-w-0 max-w-5xl" data-testid="coach-page"><Lookable addSource="教练">
      <div className="mb-6 flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-ink">{t('nav.coach')}</h1>
          <p className="mt-2 text-sm text-mute">练一练写作、批改作文、回看高频错误，把还没掌握的内容继续巩固。</p>
        </div>
      </div>

      {modelMissing && (
        <p className="mb-4 break-words text-sm text-mute" data-testid="coach-model-hint">
          尚未配置模型：请前往「设置」填写接口地址和 API Key；不影响错误档案浏览。
        </p>
      )}
      {error && <p role="alert" className="mb-4 break-words rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm text-danger">{error}</p>}

      <div role="tablist" aria-label={t('coach.tabs')} className="mb-5 flex min-w-0 flex-wrap gap-2" data-testid="coach-tabs">
        {TABS.map(id => (
          <button key={id} type="button" role="tab" id={`coach-tab-${id}`} aria-selected={tab === id} aria-controls={`coach-panel-${id}`} onClick={() => setTab(id)} data-testid={`coach-tab-${id}`}
            className={`press rounded-xl border px-4 py-2 text-sm ${tab === id ? 'border-ink bg-ink text-white' : 'border-line bg-page text-ink'}`}>{t(`coach.tab.${id}` as 'coach.tab.writing')}</button>
        ))}
      </div>

      <div role="tabpanel" id="coach-panel-writing" aria-labelledby="coach-tab-writing" hidden={tab !== 'writing'} data-testid="coach-panel-writing"><WritingPractice /></div>
      <div role="tabpanel" id="coach-panel-essay" aria-labelledby="coach-tab-essay" hidden={tab !== 'essay'} data-testid="coach-panel-essay"><EssayReview top={data.top} onArchived={load} /></div>

      <div role="tabpanel" id="coach-panel-errors" aria-labelledby="coach-tab-errors" hidden={tab !== 'errors'} data-testid="coach-panel-errors">
      <div className="mb-4 flex justify-end">
        <button type="button" onClick={() => void load()} disabled={loading} title="重新读取错误档案" aria-label="刷新错误档案" data-testid="coach-refresh" className="press shrink-0 rounded-xl border border-line bg-page p-2.5 text-ink">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      {loading && empty ? (
        <p className="rounded-2xl border border-line bg-page p-6 text-sm text-mute">正在读取错误档案……</p>
      ) : empty ? (
        <section className="rounded-2xl border border-line bg-page p-6" data-testid="coach-empty">
          <h2 className="text-base font-medium text-ink">还没有错误档案</h2>
          <p className="mt-2 text-sm leading-6 text-mute">请先到「词库 → 导入」导入错误档案 Markdown。导入后，这里会显示高频错误、错误明细和待巩固清单。</p>
        </section>
      ) : (
        <div className="min-w-0 space-y-5" data-testid="coach-data" data-top-count={data.top.length} data-batch-count={data.batches.length} data-item-count={itemCount} data-todo-count={data.todos.length}>
          <section className="min-w-0 rounded-2xl border border-line bg-page p-4 md:p-5" aria-labelledby="coach-top-title">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="coach-top-title" className="text-base font-medium text-ink">高频错误</h2>
              <span className="shrink-0 text-xs text-mute">{data.top.length} 类</span>
            </div>
            {data.top.length === 0 ? <p className="mt-4 text-sm text-mute">档案中没有高频错误记录。</p> : (
              <div className="mt-3" data-testid="coach-top-list">
                <div className="hidden grid-cols-[minmax(0,1.4fr)_80px_130px_minmax(100px,0.8fr)] gap-3 border-b border-line px-3 pb-2 text-xs text-mute md:grid">
                  <span>错误类型</span><span>次数</span><span>最近一次</span><span>状态</span>
                </div>
                {data.top.map(item => (
                  <div key={item.id} data-testid="coach-top-row" className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 border-b border-line px-1 py-3 last:border-b-0 md:grid-cols-[minmax(0,1.4fr)_80px_130px_minmax(100px,0.8fr)] md:items-center md:px-3">
                    <div className="col-span-2 min-w-0 break-words text-sm font-medium text-ink md:col-span-1">{item.rank}. {item.kind}</div>
                    <div className="min-w-0 text-sm text-ink"><span className="mr-2 text-xs text-mute md:hidden">次数</span>{item.count}</div>
                    <div className="min-w-0 break-words text-sm text-mute"><span className="mr-2 text-xs md:hidden">最近一次</span>{item.lastAt || '—'}</div>
                    <div className="col-span-2 min-w-0 break-words text-sm text-mute md:col-span-1"><span className="mr-2 text-xs md:hidden">状态</span>{item.status || '—'}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="min-w-0 rounded-2xl border border-line bg-page p-4 md:p-5" aria-labelledby="coach-batches-title">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="coach-batches-title" className="text-base font-medium text-ink">错误明细</h2>
              <span className="shrink-0 text-xs text-mute">{data.batches.length} 批 · {itemCount} 条</span>
            </div>
            {data.batches.length === 0 ? <p className="mt-4 text-sm text-mute">档案中没有批改批次。</p> : (
              <div className="mt-3 min-w-0 space-y-2" data-testid="coach-batch-list">
                {data.batches.map((batch, index) => (
                  <details key={batch.id} open={index === 0} data-testid="coach-batch" data-batch-id={batch.id} className="group min-w-0 rounded-xl border border-line bg-page">
                    <summary className="flex min-w-0 cursor-pointer list-none items-center gap-3 p-3 md:p-4">
                      <ChevronDown size={16} className="shrink-0 text-mute transition-transform group-open:rotate-180" />
                      <span className="min-w-0 flex-1 break-words text-sm font-medium text-ink [overflow-wrap:anywhere]">{batch.title}</span>
                      <span className="shrink-0 text-xs text-mute">{batch.items.length} 条</span>
                    </summary>
                    <div className="min-w-0 border-t border-line p-3 md:p-4">
                      {Object.keys(batch.metadata).length > 0 && (
                        <dl className="mb-4 flex min-w-0 flex-wrap gap-x-5 gap-y-2 text-xs text-mute">
                          {Object.entries(batch.metadata).map(([key, value]) => <div key={key} className="min-w-0 break-words"><dt className="inline">{key}：</dt><dd className="inline">{value}</dd></div>)}
                        </dl>
                      )}
                      {batch.items.length === 0 ? (
                        <p className="text-sm text-mute" data-testid="coach-batch-empty">这批没有错误项。</p>
                      ) : batch.items.map(item => <ItemDetail key={item.id} item={item} />)}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </section>

          <section className="min-w-0 rounded-2xl border border-line bg-page p-4 md:p-5" aria-labelledby="coach-todos-title">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="coach-todos-title" className="text-base font-medium text-ink">待巩固清单</h2>
              <span className="shrink-0 text-xs text-mute">{data.todos.filter(todo => !todo.done).length} 项待巩固</span>
            </div>
            {data.todos.length === 0 ? <p className="mt-4 text-sm text-mute">档案中没有待巩固事项。</p> : (
              <ul className="mt-3 min-w-0" data-testid="coach-todo-list">
                {data.todos.map(todo => (
                  <li key={todo.id} data-testid="coach-todo" className="flex min-w-0 items-start gap-2.5 border-b border-line py-3 text-sm last:border-b-0">
                    {todo.done ? <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-mute" /> : <Circle size={17} className="mt-0.5 shrink-0 text-accent" />}
                    <span className={`min-w-0 break-words [overflow-wrap:anywhere] ${todo.done ? 'text-mute line-through' : 'text-ink'}`}>{todo.text}</span>
                    <span className="sr-only">{todo.done ? '已完成' : '待巩固'}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
      </div>
    </Lookable></div>
  );
}
