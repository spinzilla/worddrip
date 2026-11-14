import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, RefreshCw, Search, X } from 'lucide-react';
import { vocabApi } from '../../utils/vocab/api';
import { createLatestGate, emptyBrowse, isBrowseEmpty } from '../../utils/vocab/browse';
import {
  SORT_MODES,
  STATUS_GROUPS,
  buildLibrary,
  filterUpgradeGroups,
  groupByIssue,
  notesForWord,
  searchLibrary,
} from '../../utils/vocab/library';
import type { Hit, NoteFilter, SortMode, StatusGroup, UpgradeGroup } from '../../utils/vocab/library';
import { groupNotes, onNotesChanged, removeNote, upsertNote } from '../../utils/vocab/notes';
import { onVocabChanged } from '../../utils/vocab/manualAdd';
import { VERIFICATION_STATUSES } from '../../utils/vocab/types';
import type { BrowseData, BrowseSelfCheck, ReviewMetadataResult, VerificationStatus, VocabNote } from '../../utils/vocab/types';
import type { NoteHandlers } from './NotesSection';
import EntryDetail, { Hl, StatusChip } from './EntryDetail';
import type { Selection } from './EntryDetail';
import { getAllCards, subscribeCards, type ReviewCard } from '../../utils/review';
import { filterListeningWords, listeningCounts, listeningWordMatches, mergeListeningWords } from '../../utils/vocab/listeningMerge';
import type { ListeningFilter, MergedListeningWord } from '../../utils/vocab/listeningMerge';
import './vocab.css';

type View = 'search' | 'issues' | 'upgrades';

const VIEWS: { key: View; label: string; hint: string }[] = [
  { key: 'search', label: '查词', hint: '中英文都能搜，按相关度排' },
  { key: 'issues', label: '按期回看', hint: '一期一组，新的在前' },
  { key: 'upgrades', label: '升级对照', hint: '想表达一个意思时可选哪些词' },
];

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

interface Props {
  /** 页面当前是否显示；从隐藏变为显示时重新读取，导入后能看到新数据。 */
  active: boolean;
  /** 空库引导里的「去导入」。 */
  onGoImport: () => void;
  /** 手机版不显示「去导入」（整库搬家由 060 另做）。 */
  hideImport?: boolean;
}

const rowClass = 'vocab-row press';

function NoteCount({ count }: { count: number }) {
  if (count === 0) return null;
  return <span className="vocab-chip shrink-0 border-line bg-page text-mute" title={`记过 ${count} 条笔记`} data-testid="row-note-count">笔记 {count}</span>;
}

function ListeningBadge() {
  return <span className="vocab-chip shrink-0 border-accent/30 bg-accent-soft text-accent" data-testid="listening-badge">听力</span>;
}

function WordRow({ hit, query, selected, noteCount, listening, onSelect }: { hit: Extract<Hit, { kind: 'word' }>; query: string; selected: boolean; noteCount: number; listening: boolean; onSelect: () => void }) {
  const { word } = hit;
  return (
    <button type="button" aria-current={selected} onClick={onSelect} className={rowClass} data-kind="word" data-word-key={word.key}>
      <div className="flex items-start gap-2">
        <span className="vocab-wrap min-w-0 flex-1 text-base font-semibold text-ink"><Hl text={word.word} query={query} /></span>
        {listening && <ListeningBadge />}
        <NoteCount count={noteCount} />
        <StatusChip status={word.latest.status} due={word.latest.due} />
      </div>
      <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-sm">
        {word.pos.length > 0 && <span className="shrink-0 text-xs text-mute">{word.pos.join(' ')}</span>}
        <span className="vocab-clamp vocab-wrap min-w-0 text-ink/80">{word.gloss || '（还没有意思）'}</span>
      </div>
      {hit.reason && <div className="vocab-clamp vocab-wrap mt-1 text-xs text-mute"><Hl text={hit.reason} query={query} /></div>}
      {word.entries.length > 1 && <div className="mt-1 text-[11px] text-mute">出现在 {word.entries.map(e => e.issue).join('、')} 期</div>}
    </button>
  );
}

function ListeningRow({ item, query, selected, onSelect }: { item: MergedListeningWord; query: string; selected: boolean; onSelect: () => void }) {
  const first = item.listeningCards[0];
  return (
    <button type="button" aria-current={selected} onClick={onSelect} className={rowClass} data-kind="listening" data-word-key={item.key}>
      <div className="flex items-start gap-2">
        <span className="vocab-wrap min-w-0 flex-1 text-base font-semibold text-ink"><Hl text={item.word} query={query} /></span>
        <ListeningBadge />
      </div>
      <div className="vocab-clamp vocab-wrap mt-0.5 text-sm text-ink/80">{first.definition ? <Hl text={first.definition.replace(/<[^>]+>/g, '')} query={query} /> : '（听力卡还没有释义）'}</div>
      <div className="vocab-clamp vocab-wrap mt-1 text-xs text-mute"><Hl text={first.text} query={query} /></div>
    </button>
  );
}

function UpgradeRow({ group, query, reason, selected, onSelect }: { group: UpgradeGroup; query: string; reason?: string; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" aria-current={selected} onClick={onSelect} className={rowClass} data-kind="upgrade">
      <div className="flex items-start gap-2">
        <span className="vocab-wrap min-w-0 flex-1 text-sm text-mute">想说 <span className="text-ink"><Hl text={group.item.plain} query={query} /></span></span>
        <span className="vocab-chip border-line bg-shade text-mute">升级对照</span>
      </div>
      <div className="vocab-wrap mt-0.5 text-base text-ink">
        {group.candidates.map((c, index) => (
          <React.Fragment key={c.name}>
            {index > 0 && <span className="text-mute"> · </span>}
            <span className={c.preferred ? 'font-semibold' : ''}><Hl text={c.name} query={query} /></span>
          </React.Fragment>
        ))}
      </div>
      {reason && <div className="vocab-clamp vocab-wrap mt-1 text-xs text-mute"><Hl text={reason} query={query} /></div>}
    </button>
  );
}

function SelfCheckRow({ item, query, selected, onSelect }: { item: BrowseSelfCheck; query: string; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" aria-current={selected} onClick={onSelect} className={rowClass} data-kind="selfCheck">
      <div className="flex items-start gap-2">
        <span className="vocab-wrap min-w-0 flex-1 text-sm text-ink"><Hl text={item.text} query={query} /></span>
        <span className="vocab-chip border-line bg-shade text-mute">写作自查</span>
      </div>
    </button>
  );
}

export default function BrowsePanel({ active, onGoImport, hideImport }: Props) {
  const gateRef = useRef(createLatestGate());
  const detailRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<BrowseData>(emptyBrowse());
  const [notes, setNotes] = useState<VocabNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('search');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('relevance');
  const [status, setStatus] = useState<StatusGroup | 'all'>('all');
  const [verification, setVerification] = useState<VerificationStatus | '全部'>('全部');
  const [noteFilter, setNoteFilter] = useState<NoteFilter>('all');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [cards, setCards] = useState<ReviewCard[] | null>(null);
  const [sourceFilter, setSourceFilter] = useState<ListeningFilter>('all');

  useEffect(() => {
    const loadCards = () => getAllCards().then(setCards).catch(() => setCards([]));
    loadCards();
    return subscribeCards(loadCards);
  }, []);

  const load = useCallback(() => {
    const gate = gateRef.current;
    const token = gate.next();
    setLoading(true);
    setError('');
    // 040：笔记单独一个接口读，只在词库页用（出题、判分不读它）。
    Promise.all([vocabApi.browse(), vocabApi.listNotes()]).then(([value, noteList]) => {
      if (!gate.isCurrent(token)) return;
      setData(value);
      setNotes(noteList);
      setLoading(false);
    }).catch(reason => {
      if (!gate.isCurrent(token)) return;
      setError(`读取词库失败：${errorText(reason)}`);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    gateRef.current.revive();
    return () => gateRef.current.dispose();
  }, []);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  // 041：复习、首考、闪卡里记的笔记，回到词库页时直接能看到（只重读笔记，不动列表和筛选）。
  useEffect(() => {
    let alive = true;
    const off = onNotesChanged(() => {
      vocabApi.listNotes().then(list => { if (alive) setNotes(list); }).catch(() => {});
    });
    return () => { alive = false; off(); };
  }, []);

  // 042：手动加词、收件箱入库后列表立即重读（保留搜索词和筛选），新词马上能搜到。
  useEffect(() => onVocabChanged(load), [load]);

  const library = useMemo(() => buildLibrary(data, groupNotes(notes)), [data, notes]);
  const mergedWords = useMemo(() => mergeListeningWords(library.words, cards ?? []), [library.words, cards]);
  const mergedByKey = useMemo(() => new Map(mergedWords.map(item => [item.key, item])), [mergedWords]);
  const sourceCounts = listeningCounts(mergedWords);
  const listeningByKey = useMemo(() => new Map(mergedWords.filter(item => item.listeningCards.length > 0).map(item => [item.key, { word: item.word, cards: item.listeningCards }])), [mergedWords]);
  const options = { sort, status, verification, notes: noteFilter };
  const hits = useMemo(() => view === 'search' ? searchLibrary(library, query, options) : [], [library, query, sort, status, verification, noteFilter, view]);
  const issues = useMemo(() => view === 'issues' ? groupByIssue(library, query, options) : [], [library, query, status, verification, noteFilter, view]);
  const upgrades = useMemo(() => view === 'upgrades' ? filterUpgradeGroups(library, query) : [], [library, query, view]);
  const selfChecks = useMemo(() => {
    if (view !== 'upgrades') return [];
    const q = query.trim().toLowerCase();
    return q ? library.selfChecks.filter(item => item.text.toLowerCase().includes(q)) : library.selfChecks;
  }, [library, query, view]);
  const visibleHits = useMemo(() => hits.filter(hit => {
    if (sourceFilter === 'all') return true;
    if (hit.kind !== 'word') return false;
    const listening = (mergedByKey.get(hit.word.key)?.listeningCards.length ?? 0) > 0;
    return sourceFilter === 'listening' ? listening : !listening;
  }), [hits, sourceFilter, mergedByKey]);
  const listeningOnly = useMemo(() => {
    if (view !== 'search' || sourceFilter === 'vocab' || status !== 'all' || verification !== '全部' || noteFilter !== 'all') return [];
    return filterListeningWords(mergedWords.filter(item => !item.vocab && listeningWordMatches(item, query)), sourceFilter);
  }, [view, sourceFilter, status, verification, noteFilter, mergedWords, query]);

  const open = (next: Selection) => {
    setSelection(next);
    // 窄屏时列表被隐藏、详情顶上来，滚回详情顶部。
    window.requestAnimationFrame(() => {
      const element = detailRef.current;
      if (element && window.matchMedia('(max-width: 899px)').matches) element.scrollIntoView({ block: 'start' });
    });
  };
  const isSelected = (kind: Selection['kind'], id: string) => selection?.kind === kind && selection.id === id;

  const reviewMetadataSaved = (result: ReviewMetadataResult) => {
    setData(current => ({
      ...current,
      reviewWords: current.reviewWords.map(item => item.id === result.id
        ? { ...item, source: result.source, verificationStatus: result.verificationStatus }
        : item),
    }));
  };

  const noteHandlers: NoteHandlers = {
    onSaved: note => setNotes(current => upsertNote(current, note)),
    onDeleted: id => setNotes(current => removeNote(current, id)),
  };

  if (loading && isBrowseEmpty(data) && cards === null && !error) {
    return <p className="text-sm text-mute" role="status">正在读取词库…</p>;
  }

  if (error) {
    return (
      <div role="alert" className="rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm text-danger">
        <div className="vocab-wrap">{error}</div>
        <button type="button" onClick={load} className="press mt-3 rounded-lg border border-danger/30 bg-page px-3 py-1.5 text-danger">
          <RefreshCw className="mr-1.5 inline" size={14} />重试
        </button>
      </div>
    );
  }

  if (isBrowseEmpty(data) && mergedWords.length === 0) {
    return (
      <section className="rounded-2xl border border-line bg-page p-6 text-center" data-testid="vocab-empty">
        <h2 className="text-base font-semibold text-ink">词库还是空的</h2>
        <p className="mt-2 text-sm text-mute">{hideImport ? '词库里还没有词。可以点上面的「添加词条」，或到「设置 → 同步与搬家」导入另一台设备的完整词库。' : '先导入学术升级库和复习库，导入后就能在这里查词。'}</p>
        {!hideImport && <button type="button" onClick={onGoImport} className="press mt-4 rounded-full bg-ink px-5 py-2.5 text-sm text-white">
          去导入
        </button>}
      </section>
    );
  }

  const trimmed = query.trim();
  const reviewFiltered = status !== 'all' || verification !== '全部';
  const filtering = trimmed !== '' || reviewFiltered || noteFilter !== 'all';
  let shown = 0;
  let total = 0;
  if (view === 'search') {
    shown = visibleHits.length + listeningOnly.length;
    total = ((trimmed || noteFilter !== 'all') && !reviewFiltered ? library.words.length + library.upgrades.length + library.selfChecks.length : library.words.length)
      + mergedWords.filter(item => !item.vocab).length;
  } else if (view === 'issues') {
    shown = issues.reduce((n, g) => n + g.words.length, 0);
    total = data.reviewWords.length;
  } else {
    shown = upgrades.length + selfChecks.length;
    total = library.upgrades.length + library.selfChecks.length;
  }
  const countText = filtering ? `匹配 ${shown} / 共 ${total} 条` : view === 'issues' ? `共 ${issues.length} 期 ${total} 条` : `共 ${total} 条`;
  const viewHint = VIEWS.find(item => item.key === view)?.hint ?? '';

  return (
    <section className="rounded-2xl border border-line bg-page p-4 md:p-5" data-testid="vocab-browse">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mute" size={18} />
        <input
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="查一个词，或想表达的中文意思（如「加剧」）"
          aria-label="搜索词库"
          data-testid="vocab-search"
          className="vocab-search w-full min-w-0 rounded-2xl border border-line bg-page py-3 pl-11 pr-11 text-base text-ink"
        />
        {query && (
          <button type="button" onClick={() => setQuery('')} aria-label="清空搜索" className="press absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-mute hover:text-ink">
            <X size={16} />
          </button>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="vocab-tabs" role="tablist" aria-label="词库视图">
          {VIEWS.map(item => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={view === item.key}
              onClick={() => { setView(item.key); setSelection(null); }}
              className={`press rounded-full border px-3.5 py-1.5 text-sm ${view === item.key ? 'border-ink bg-ink text-white' : 'border-line text-ink hover:border-ink/30'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button type="button" onClick={load} disabled={loading} title="重新读取词库" aria-label="刷新" className="press ml-auto shrink-0 rounded-xl border border-line p-2 text-ink">
          <RefreshCw size={15} />
        </button>
      </div>

      {view !== 'upgrades' && (
        <div className="vocab-filters mt-3" data-testid="vocab-filters">
          {view === 'search' && (
            <label className="vocab-filter">
              <span>排序</span>
              <select value={sort} onChange={event => setSort(event.target.value as SortMode)} data-testid="vocab-sort">
                {SORT_MODES.map(mode => <option key={mode.key} value={mode.key}>{mode.key === 'relevance' && !trimmed ? '最相关（无搜索时 A–Z）' : mode.label}</option>)}
              </select>
            </label>
          )}
          <label className="vocab-filter">
            <span>学习状态</span>
            <select value={status} onChange={event => setStatus(event.target.value as StatusGroup | 'all')} data-testid="status-filter">
              <option value="all">全部</option>
              {STATUS_GROUPS.map(group => <option key={group.key} value={group.key}>{group.label}</option>)}
            </select>
          </label>
          {view === 'search' && (
            <label className="vocab-filter">
              <span>单词来源</span>
              <select value={sourceFilter} onChange={event => { setSourceFilter(event.target.value as ListeningFilter); setSelection(null); }} data-testid="listening-filter">
                <option value="all">全部（{sourceCounts.all}）</option>
                <option value="listening">听力（{sourceCounts.listening}）</option>
                <option value="vocab">非听力（{sourceCounts.vocab}）</option>
              </select>
            </label>
          )}
          <label className="vocab-filter">
            <span>查证</span>
            <select value={verification} onChange={event => setVerification(event.target.value as VerificationStatus | '全部')} data-testid="verification-filter">
              <option value="全部">全部</option>
              {VERIFICATION_STATUSES.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label className="vocab-filter">
            <span>笔记</span>
            <select value={noteFilter} onChange={event => setNoteFilter(event.target.value as NoteFilter)} data-testid="note-filter">
              <option value="all">全部</option>
              <option value="has">有笔记的词</option>
            </select>
          </label>
        </div>
      )}

      <p className="mt-2 text-xs text-mute" data-testid="vocab-count">
        {countText}<span className="vocab-hint"> · {viewHint}</span>
        {view === 'search' && reviewFiltered && trimmed && <span>（筛选时只看复习词）</span>}
      </p>

      <div className="vocab-browse mt-3" data-has-detail={selection !== null}>
        <div className="vocab-list-col min-w-0">
          {view === 'search' && (
            <div className="vocab-list" data-testid="vocab-list">
              {visibleHits.length === 0 && listeningOnly.length === 0 && <NoResult filtering={filtering || sourceFilter !== 'all'} />}
              {visibleHits.map(hit => hit.kind === 'word'
                ? <WordRow key={hit.id} hit={hit} query={trimmed} selected={isSelected('word', hit.id)} noteCount={notesForWord(library, hit.word.word).length} listening={(mergedByKey.get(hit.word.key)?.listeningCards.length ?? 0) > 0} onSelect={() => open({ kind: 'word', id: hit.id })} />
                : hit.kind === 'upgrade'
                  ? <UpgradeRow key={hit.id} group={hit.upgrade} query={trimmed} reason={hit.reason} selected={isSelected('upgrade', hit.id)} onSelect={() => open({ kind: 'upgrade', id: hit.id })} />
                  : <SelfCheckRow key={hit.id} item={hit.selfCheck} query={trimmed} selected={isSelected('selfCheck', hit.id)} onSelect={() => open({ kind: 'selfCheck', id: hit.id })} />)}
              {listeningOnly.map(item => <ListeningRow key={item.key} item={item} query={trimmed} selected={isSelected('listening', item.key)} onSelect={() => open({ kind: 'listening', id: item.key })} />)}
            </div>
          )}

          {view === 'issues' && (
            <div className="vocab-list space-y-2" data-testid="vocab-list">
              {issues.length === 0 && <NoResult filtering={filtering} />}
              {issues.map((issue, index) => (
                <details key={issue.issue} open={filtering || index === 0} className="vocab-issue" data-testid="issue-group">
                  <summary className="vocab-issue-head">
                    <span className="text-base font-semibold text-ink">{issue.issue}{/^\d/.test(issue.issue) ? ' 期' : ''}</span>
                    <span className="text-xs text-mute">{issue.words.length} 词</span>
                    <span className="vocab-issue-counts text-[11px] text-mute">
                      {STATUS_GROUPS.filter(g => issue.counts[g.key] > 0).map(g => `${g.label.replace(' L1–L4', '')} ${issue.counts[g.key]}`).join(' · ')}
                    </span>
                  </summary>
                  <div className="vocab-issue-words">
                    {issue.words.map(({ group, entry }) => (
                      <button key={entry.id} type="button" aria-current={isSelected('word', group.key)} onClick={() => open({ kind: 'word', id: group.key })} className="vocab-row press" data-kind="word">
                        <div className="flex items-start gap-2">
                          <span className="vocab-wrap min-w-0 flex-1 font-semibold text-ink"><Hl text={entry.word} query={trimmed} /></span>
                          <NoteCount count={notesForWord(library, entry.word).length} />
                          <StatusChip status={entry.status} due={entry.due} />
                        </div>
                        <div className="vocab-clamp vocab-wrap mt-0.5 text-sm text-ink/80">
                          {group.pos.length > 0 && <span className="mr-1.5 text-xs text-mute">{group.pos.join(' ')}</span>}
                          {group.gloss || '（还没有意思）'}
                        </div>
                      </button>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          )}

          {view === 'upgrades' && (
            <div className="vocab-list" data-testid="vocab-list">
              {upgrades.length === 0 && selfChecks.length === 0 && <NoResult filtering={filtering} />}
              {upgrades.map(group => (
                <UpgradeRow key={group.item.id} group={group} query={trimmed} selected={isSelected('upgrade', group.item.id)} onSelect={() => open({ kind: 'upgrade', id: group.item.id })} />
              ))}
              {selfChecks.length > 0 && (
                <h3 className="px-1 pt-3 text-xs font-medium text-mute" data-testid="selfcheck-heading">写作自查对照（{selfChecks.length}）</h3>
              )}
              {selfChecks.map(item => (
                <SelfCheckRow key={item.id} item={item} query={trimmed} selected={isSelected('selfCheck', item.id)} onSelect={() => open({ kind: 'selfCheck', id: item.id })} />
              ))}
            </div>
          )}
        </div>

        <div ref={detailRef} className="vocab-detail-col min-w-0">
          {selection && (
            <button type="button" onClick={() => setSelection(null)} className="vocab-back press mb-3 inline-flex items-center gap-1 rounded-full border border-line px-3 py-1.5 text-sm text-ink" data-testid="vocab-back">
              <ArrowLeft size={14} />返回列表
            </button>
          )}
          <EntryDetail selection={selection} library={library} query={trimmed} onOpen={open} onReviewMetadataSaved={reviewMetadataSaved} noteHandlers={noteHandlers} listeningByKey={listeningByKey} />
        </div>
      </div>
    </section>
  );
}

function NoResult({ filtering }: { filtering: boolean }) {
  return (
    <p className="rounded-xl bg-shade p-4 text-sm text-mute" data-testid="vocab-no-result">
      {filtering ? '没有找到。可以换个说法、只输入词的一部分，或者清空筛选。' : '这一类还没有记录。'}
    </p>
  );
}
