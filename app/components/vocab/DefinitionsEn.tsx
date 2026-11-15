import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { vocabApi } from '../../utils/vocab/api';
import {
  MINE,
  checkOwnDefinition,
  definitionKey,
  definitionView,
  groupDefinitions,
  notifyDefinitionsChanged,
  onDefinitionsChanged,
  sourceLabel,
} from '../../utils/vocab/definitionEn';
import type { DefinitionCheck, ImportedEnglish } from '../../utils/vocab/definitionEn';
import { autoFetchDefinition } from '../../utils/vocab/definitionEnDict';
import { hasQuestionModel } from '../../utils/vocab/recallModel';
import type { VocabDefinitionEn } from '../../utils/vocab/types';

// 078 英英释义：我写的（排第一，可改可删，AI 帮我看看）、词典查来的（有别的释义时收起，可「改成我的」）。
// 打开一个没有任何英英释义的词会自动查一次词典（只查这一个词）；查不到时安静地显示「还没有英英释义」。

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** 读一次全部英英释义，别处改了（广播）就重读。 */
export function useMyDefinitions(enabled = true): { byKey: Map<string, VocabDefinitionEn[]>; loaded: boolean; error: string } {
  const [list, setList] = useState<VocabDefinitionEn[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => vocabApi.listDefinitionsEn()
      .then(items => { if (alive) { setList(items); setLoaded(true); setError(''); } })
      .catch(reason => { if (alive) setError(`读取英英释义失败：${errorText(reason)}`); });
    void load();
    const off = onDefinitionsChanged(() => { void load(); });
    return () => { alive = false; off(); };
  }, [enabled]);
  const byKey = useMemo(() => groupDefinitions(list), [list]);
  return { byKey, loaded, error };
}

const btn = 'press inline-flex min-h-8 items-center gap-1 rounded-lg px-2 py-1 text-xs text-mute hover:bg-shade hover:text-ink';

/** 自己写的一条：看、改、删（要确认）、让 AI 看看。 */
function MineItem({ item, word }: { item: VocabDefinitionEn; word: string }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm'>('view');
  const [pos, setPos] = useState(item.pos ?? '');
  const [text, setText] = useState(item.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [check, setCheck] = useState<DefinitionCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const canAi = hasQuestionModel();

  const save = async (nextText = text, nextPos = pos) => {
    if (busy || !nextText.trim()) return;
    setBusy(true); setError('');
    try {
      await vocabApi.updateDefinitionEn({ id: item.id, pos: nextPos, text: nextText });
      notifyDefinitionsChanged();
      setMode('view'); setCheck(null);
    } catch (reason) { setError(`保存失败：${errorText(reason)}`); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { await vocabApi.deleteDefinitionEn(item.id); notifyDefinitionsChanged(); } catch (reason) { setError(`删除失败：${errorText(reason)}`); setBusy(false); }
  };
  const ask = async () => {
    setChecking(true); setError(''); setCheck(null);
    try { setCheck(await checkOwnDefinition(word, item.pos ?? '', item.text)); } catch (reason) { setError(errorText(reason)); } finally { setChecking(false); }
  };

  return (
    <li className="vocab-sense" data-testid="def-en-mine" data-def-id={item.id}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="vocab-chip border-accent/30 bg-accent-soft text-accent" data-testid="def-en-label">{sourceLabel(MINE)}</span>
        {item.pos && <span className="vocab-chip border-ink/15 bg-shade text-mute italic">{item.pos}</span>}
        {mode === 'view' && (
          <span className="ml-auto flex min-w-0 flex-wrap justify-end gap-1">
            {canAi && <button type="button" onClick={() => void ask()} disabled={checking} className={btn} data-testid="def-en-ai">{checking ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}AI 帮我看看</button>}
            <button type="button" onClick={() => { setPos(item.pos ?? ''); setText(item.text); setMode('edit'); setError(''); }} className={btn} data-testid="def-en-edit"><Pencil size={12} />编辑</button>
            <button type="button" onClick={() => { setMode('confirm'); setError(''); }} className={`${btn} hover:text-danger`} data-testid="def-en-delete"><Trash2 size={12} />删除</button>
          </span>
        )}
      </div>
      {mode === 'edit' ? (
        <div className="mt-2">
          <input value={pos} onChange={event => setPos(event.target.value)} placeholder="词性（可不填）" aria-label="词性" className="vocab-note-input mb-2 !min-h-0 py-1.5" data-testid="def-en-pos-input" />
          <textarea value={text} onChange={event => setText(event.target.value)} rows={3} aria-label="修改英英释义" className="vocab-note-input" data-testid="def-en-edit-input" autoFocus />
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => void save()} disabled={busy || !text.trim()} className="press rounded-lg bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-45" data-testid="def-en-save">{busy ? '正在保存…' : '保存'}</button>
            <button type="button" onClick={() => { setMode('view'); setError(''); }} disabled={busy} className="press rounded-lg border border-line px-3 py-1.5 text-sm text-ink">取消</button>
          </div>
        </div>
      ) : (
        <p className="vocab-wrap mt-1.5 font-serif text-base leading-relaxed text-ink" data-testid="def-en-text">{item.text}</p>
      )}
      {check && (
        <div className="mt-2 rounded-xl border border-line bg-page p-3 text-sm" data-testid="def-en-check">
          <p className="vocab-wrap text-ink"><span className="font-medium">{check.good ? '没问题：' : '建议改一改：'}</span>{check.comment}</p>
          {check.suggestion && (
            <>
              <p className="vocab-wrap mt-2 font-serif text-base text-ink" data-testid="def-en-suggestion">{check.suggestion}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" onClick={() => void save(check.suggestion, item.pos ?? '')} disabled={busy} className="press rounded-lg bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-45" data-testid="def-en-apply">用这个替换</button>
                <button type="button" onClick={() => setCheck(null)} className="press rounded-lg border border-line px-3 py-1.5 text-sm text-ink" data-testid="def-en-keep">不换</button>
              </div>
            </>
          )}
          {!check.suggestion && <button type="button" onClick={() => setCheck(null)} className="press mt-2 rounded-lg border border-line px-3 py-1.5 text-sm text-ink">知道了</button>}
        </div>
      )}
      {mode === 'confirm' && (
        <div role="alertdialog" aria-label="确认删除英英释义" className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-ink" data-testid="def-en-delete-confirm">
          <span className="min-w-[10rem] flex-1">删除这条英英释义？删了找不回来。</span>
          <span className="flex shrink-0 gap-2">
            <button type="button" onClick={() => void remove()} disabled={busy} className="press rounded-lg bg-danger px-3 py-1.5 text-sm text-white disabled:opacity-45" data-testid="def-en-delete-yes">{busy ? '正在删除…' : '确定删除'}</button>
            <button type="button" onClick={() => setMode('view')} disabled={busy} className="press rounded-lg border border-line bg-page px-3 py-1.5 text-sm text-ink">不删了</button>
          </span>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </li>
  );
}

/** 「意思」一节的最上面：自己写的英英释义（没有就什么都不渲染）。 */
export function MyDefinitionsEn({ word, stored }: { word: string; stored: readonly VocabDefinitionEn[] }) {
  const mine = stored.filter(item => item.source === MINE).sort((a, b) => a.id - b.id);
  if (mine.length === 0) return null;
  return <ul className="mb-4 space-y-3" data-testid="def-en-mine-list">{mine.map(item => <MineItem key={item.id} item={item} word={word} />)}</ul>;
}

/**
 * 「意思」一节的最下面：词典查来的（有别的释义时收起成「词典释义（n 条）」）、
 * 什么都没有时的空状态（+ 自动查词典）、「＋ 写英英释义」输入框。
 */
export function ExtraDefinitionsEn({ word, stored, imported, loaded = true }: {
  word: string;
  stored: readonly VocabDefinitionEn[];
  imported: readonly ImportedEnglish[];
  /** 词库里的英英释义读完了没有：没读完不自动查，免得把已有的又查一遍。 */
  loaded?: boolean;
}) {
  const view = definitionView(stored, imported);
  const [open, setOpen] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [writing, setWriting] = useState(false);
  const [pos, setPos] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = definitionKey(word);
  const empty = view.empty;

  // 打开一个完全没有英英释义的词：自动查一次词典，存下来；查不到安静地留在空状态。
  useEffect(() => {
    if (!loaded || !empty) return undefined;
    let alive = true;
    setLookingUp(true);
    void autoFetchDefinition(word).finally(() => { if (alive) setLookingUp(false); });
    return () => { alive = false; };
  }, [key, loaded, empty]);

  const add = async () => {
    if (busy || !text.trim()) return;
    setBusy(true); setError('');
    try {
      await vocabApi.addDefinitionsEn({ word, source: MINE, items: [{ pos, text }] });
      notifyDefinitionsChanged();
      setText(''); setPos(''); setWriting(false);
    } catch (reason) { setError(`添加失败：${errorText(reason)}`); } finally { setBusy(false); }
  };
  const adopt = async (item: VocabDefinitionEn) => {
    setError('');
    try {
      await vocabApi.addDefinitionsEn({ word, source: MINE, items: [{ pos: item.pos, text: item.text }] });
      notifyDefinitionsChanged();
    } catch (reason) { setError(`复制失败：${errorText(reason)}`); }
  };

  const dictList = view.dict.length > 0 && (
    <ul className="space-y-2" data-testid="def-en-dict-list">
      {view.dict.map(item => (
        <li key={item.id} className="vocab-sense" data-testid="def-en-dict" data-source={item.source}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[11px] text-mute" data-testid="def-en-source">{sourceLabel(item.source)}</span>
            {item.pos && <span className="vocab-chip border-ink/15 bg-shade text-mute italic">{item.pos}</span>}
            <button type="button" onClick={() => void adopt(item)} className={`${btn} ml-auto`} data-testid="def-en-adopt">改成我的</button>
          </div>
          <p className="vocab-wrap mt-1 font-serif text-base leading-relaxed text-mute">{item.text}</p>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="mt-3" data-testid="def-en-extra">
      {view.dict.length > 0 && (view.dictCollapsed ? (
        <div>
          <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} className={btn} data-testid="def-en-dict-toggle">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}词典释义（{view.dict.length} 条）
          </button>
          {open && <div className="mt-1.5">{dictList}</div>}
        </div>
      ) : dictList)}
      {empty && (
        <p className="text-xs text-mute" data-testid="def-en-empty">
          {lookingUp ? <><Loader2 size={12} className="mr-1 inline animate-spin" />正在查英英词典…</> : '还没有英英释义'}
        </p>
      )}
      {writing ? (
        <div className="mt-2" data-testid="def-en-form">
          <input value={pos} onChange={event => setPos(event.target.value)} placeholder="词性（可不填，如 adj.）" aria-label="词性" className="vocab-note-input mb-2 !min-h-0 py-1.5" data-testid="def-en-new-pos" />
          <textarea value={text} onChange={event => setText(event.target.value)} rows={3} placeholder={`用英文写 ${word} 的意思`} aria-label={`给 ${word} 写英英释义`} className="vocab-note-input" data-testid="def-en-new-text" autoFocus />
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => void add()} disabled={busy || !text.trim()} className="press rounded-lg bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-45" data-testid="def-en-add">{busy ? '正在保存…' : '保存'}</button>
            <button type="button" onClick={() => { setWriting(false); setText(''); setPos(''); setError(''); }} disabled={busy} className="press rounded-lg border border-line px-3 py-1.5 text-sm text-ink">取消</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setWriting(true)} className="press mt-2 inline-flex min-h-8 items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-xs text-ink hover:border-ink/30" data-testid="def-en-open"><Plus size={12} />写英英释义</button>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}

/** 闪卡背面：只读。自己写的在前，词典的在后（有别的释义时收起）；没有就自动查一次。 */
export function FlashDefinitionsEn({ word, stored, imported, loaded, children }: {
  word: string;
  stored: readonly VocabDefinitionEn[];
  imported: readonly ImportedEnglish[];
  loaded: boolean;
  children?: React.ReactNode;
}) {
  const view = definitionView(stored, imported);
  const [open, setOpen] = useState(false);
  const empty = view.empty;
  const key = definitionKey(word);
  useEffect(() => {
    if (!loaded || !empty) return;
    void autoFetchDefinition(word);
  }, [key, loaded, empty]);
  const row = useCallback((item: VocabDefinitionEn) => (
    <li key={item.id} className="vocab-flash-def" data-testid={item.source === MINE ? 'flash-def-en-mine' : 'flash-def-en-dict'}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        {item.pos && <span className="vocab-q-pos">{item.pos}</span>}
        <span className="text-[11px] text-mute">{sourceLabel(item.source)}</span>
      </div>
      <p className="vocab-flash-def-en">{item.text}</p>
    </li>
  ), []);
  if (view.mine.length === 0 && view.dict.length === 0 && !children) return null;
  return (
    <div data-testid="flash-def-en">
      {view.mine.length > 0 && <ol className="vocab-flash-defs">{view.mine.map(row)}</ol>}
      {children}
      {view.dict.length > 0 && (view.dictCollapsed ? (
        <div className="mt-2">
          <button type="button" onClick={event => { event.stopPropagation(); setOpen(value => !value); }} aria-expanded={open} className={btn} data-testid="flash-def-en-toggle">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}词典释义（{view.dict.length} 条）
          </button>
          {open && <ol className="vocab-flash-defs">{view.dict.map(row)}</ol>}
        </div>
      ) : <ol className="vocab-flash-defs">{view.dict.map(row)}</ol>)}
    </div>
  );
}
