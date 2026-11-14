import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Plus, Search, X } from 'lucide-react';
import { vocabApi } from '../../utils/vocab/api';
import { buildLibrary, statusText, wordKey } from '../../utils/vocab/library';
import {
  emptyForm, findExisting, mergeLookup, notifyVocabChanged, onManualAddRequest, prefillFromLookup, toRequest, validateForm,
  type ManualForm, type VocabAddRequest,
} from '../../utils/vocab/manualAdd';
import { groupNotes, removeNote, upsertNote } from '../../utils/vocab/notes';
import type { BrowseData, BrowseReviewWord, ReviewMetadataResult, VocabNote } from '../../utils/vocab/types';
import { useLookup } from '../../hooks/useLookup';
import EntryDetail, { type Selection } from './EntryDetail';
import { IS_MOBILE } from '../../utils/platform';
import './vocab.css';

/**
 * 042：手动加词表单 + 已有词条弹窗，挂在应用最外层一次。
 * 词库页的「添加词条」和各页查词卡上的「加入词库」都通过 openManualAdd / openVocabEntry 事件打开它，
 * 所以在精听、看剧里加词不用离开当前页面，视频进度不受影响。
 */

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

const inputClass = 'mt-1 w-full min-w-0 rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink outline-none focus:border-ink';
const labelClass = 'block min-w-0 text-xs text-mute';

/** Esc 只关这一层：用捕获阶段先拿到，不让底下的复习弹层、查词卡也跟着关。 */
function useEscape(onEscape: () => void) {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      ref.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

function Overlay({ label, onClose, children, testId }: { label: string; onClose: () => void; children: React.ReactNode; testId: string }) {
  useEscape(onClose);
  return (
    <div className={`fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto fade-in ${IS_MOBILE ? 'bg-page' : 'bg-ink/30 px-3 py-6 sm:py-10'}`}
      onMouseDown={onClose} data-no-lookup="" data-testid={testId}>
      <section role="dialog" aria-modal="true" aria-label={label} onMouseDown={event => event.stopPropagation()}
        className={`relative w-full min-w-0 bg-page ${IS_MOBILE ? 'flex min-h-full flex-col p-4 pb-0' : 'max-w-xl rounded-2xl border border-line p-4 shadow-lift sm:p-6'}`}>
        <button type="button" onClick={onClose} aria-label="关闭" title={IS_MOBILE ? undefined : '关闭（Esc）'}
          className="press absolute right-3 top-3 rounded-lg p-2 text-mute hover:bg-shade hover:text-ink"><X size={16} /></button>
        {children}
      </section>
    </div>
  );
}

type LookupNote = { tone: 'ok' | 'error'; text: string } | null;

function AddForm({ initial, onClose, onSaved, onOpenExisting }: {
  initial: Partial<ManualForm>;
  onClose: () => void;
  onSaved: (word: string, issue: string) => void;
  onOpenExisting: (word: string) => void;
}) {
  const [form, setForm] = useState<ManualForm>(() => emptyForm(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dup, setDup] = useState<BrowseReviewWord[] | null>(null);
  const [lookupNote, setLookupNote] = useState<LookupNote>(null);
  const wordRef = useRef<HTMLInputElement>(null);
  const dupRef = useRef<HTMLDivElement>(null);
  // 「查词典填写」走和查词卡同一套流程：本地/在线词典优先，查不到再问 AI；没配模型就只查词典。
  const { def, lookup } = useLookup('en', form.example);
  const waiting = useRef(false);

  useEffect(() => { wordRef.current?.focus(); }, []);
  // 窄屏上查重提示在表单最下面，出现时滚到眼前。
  useEffect(() => { if (dup) dupRef.current?.scrollIntoView({ block: 'nearest' }); }, [dup]);

  useEffect(() => {
    if (!waiting.current || def.loading || !def.word) return;
    if (!def.dict && !def.data && !def.failed) return;
    waiting.current = false;
    if (def.failed) {
      setLookupNote({ tone: 'error', text: `没查到可填的内容：${def.error ?? '词典和 AI 都没有结果'}` });
      return;
    }
    const fill = prefillFromLookup(def, '');
    setForm(current => mergeLookup(current, fill));
    setLookupNote({ tone: 'ok', text: def.dict ? '已用词典结果填写空着的格子，可以再改。' : '已用 AI 查词结果填写空着的格子，请核对后再保存。' });
  }, [def]);

  const set = (key: keyof ManualForm) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const value = event.target.value;
    setForm(current => ({ ...current, [key]: value }));
    if (key === 'word') setDup(null);
  };

  const fillFromDictionary = () => {
    const word = form.word.trim();
    if (!word) { setError('先填写词或短语，再查词典。'); return; }
    setError('');
    setLookupNote(null);
    waiting.current = true;
    void lookup(word, form.example.trim());
  };

  const save = async (allowDuplicate: boolean) => {
    if (busy) return;
    const problem = validateForm(form);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError('');
    try {
      if (!allowDuplicate) {
        // 保存前用最新的复习库查重，不能悄悄重复。
        const data = await vocabApi.browse();
        const existing = findExisting(data.reviewWords, form.word);
        if (existing.length > 0) { setDup(existing); setBusy(false); return; }
      }
      const result = await vocabApi.manualAdd(toRequest(form, allowDuplicate));
      notifyVocabChanged();
      onSaved(result.word, result.issue);
    } catch (reason) {
      setError(`保存失败，没有写入：${errorText(reason)}`);
      setBusy(false);
    }
  };

  const looking = waiting.current && def.loading;
  return (
    <form onSubmit={event => { event.preventDefault(); void save(false); }} data-testid="manual-add-form" noValidate className={IS_MOBILE ? 'flex flex-1 flex-col' : undefined}>
      <h2 className="pr-10 text-lg font-semibold text-ink">添加词条</h2>
      <p className="mt-1 text-xs text-mute">只有「词或短语」必填。入库后状态为「待考察」、查证为「未查证」，和收件箱进来的词一样参加首考和复习。</p>

      <div className="mt-4 flex min-w-0 flex-wrap items-end gap-2">
        <label className={`${labelClass} flex-1 basis-56`}>词或短语（必填）
          <input ref={wordRef} value={form.word} onChange={set('word')} maxLength={200} className={inputClass}
            placeholder="例如 resilient 或 take into account" data-testid="manual-word" autoComplete="off" spellCheck={false} />
        </label>
        <button type="button" onClick={fillFromDictionary} disabled={busy || looking}
          className="press inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink hover:border-ink/30 disabled:opacity-40"
          data-testid="manual-lookup">
          {looking ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}查词典填写
        </button>
      </div>
      {lookupNote && (
        <p className={`vocab-wrap mt-2 text-xs ${lookupNote.tone === 'ok' ? 'text-mute' : 'text-danger'}`} data-testid="manual-lookup-note">{lookupNote.text}</p>
      )}

      <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
        <label className={labelClass}>词性
          <input value={form.pos} onChange={set('pos')} maxLength={60} className={inputClass} placeholder="如 adj. / v. / phr." data-testid="manual-pos" />
        </label>
        <label className={labelClass}>中文意思
          <input value={form.chinese} onChange={set('chinese')} maxLength={1000} className={inputClass} data-testid="manual-chinese" />
        </label>
        <label className={`${labelClass} sm:col-span-2`}>英文释义
          <textarea value={form.english} onChange={set('english')} maxLength={1000} rows={2} className={`${inputClass} resize-y`} data-testid="manual-english" />
        </label>
        <label className={`${labelClass} sm:col-span-2`}>例句
          <textarea value={form.example} onChange={set('example')} maxLength={1000} rows={2} className={`${inputClass} resize-y`} data-testid="manual-example" />
        </label>
        <label className={labelClass}>来源
          <input value={form.source} onChange={set('source')} maxLength={100} className={inputClass} data-testid="manual-source" />
        </label>
        <label className={labelClass}>期号
          <input value={form.issue} onChange={set('issue')} maxLength={40} className={inputClass} placeholder="如 11.10" data-testid="manual-issue" />
        </label>
        <label className={`${labelClass} sm:col-span-2`}>复习备注
          <input value={form.note} onChange={set('note')} maxLength={2000} className={inputClass} placeholder="会写进复习库这一行的「备注」列" data-testid="manual-note" />
        </label>
      </div>

      {error && <div role="alert" className="vocab-wrap mt-4 rounded-lg border border-danger/30 bg-danger-soft p-3 text-sm text-danger" data-testid="manual-error">{error}</div>}

      {dup && (
        <div ref={dupRef} role="alert" className="mt-4 rounded-xl border border-clay/30 bg-clay-soft p-3 text-sm text-ink" data-testid="manual-dup">
          <p className="vocab-wrap font-medium">词库里已经有「{dup[0].word}」了（{dup.length} 条）</p>
          <ul className="mt-1 space-y-0.5 text-xs text-mute">
            {dup.slice(0, 4).map(item => (
              <li key={item.id} className="vocab-wrap">{item.issue}{/^\d/.test(item.issue) ? ' 期' : ''} · {statusText(item)} · 来源 {item.source}</li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => onOpenExisting(dup[0].word)} disabled={busy}
              className="press rounded-lg border border-line bg-page px-3 py-1.5 text-sm text-ink hover:border-ink/30" data-testid="manual-dup-open">打开已有词条</button>
            <button type="button" onClick={() => void save(true)} disabled={busy}
              className="press rounded-lg bg-ink px-3 py-1.5 text-sm text-white disabled:opacity-40" data-testid="manual-dup-add">作为新义项/新一期添加</button>
          </div>
        </div>
      )}

      {/* 手机：操作按钮贴在可见区域底部（原生已让出手势条和键盘的高度），键盘弹出时也看得见。 */}
      <div className={`mt-5 flex flex-wrap justify-end gap-2 ${IS_MOBILE ? 'sticky bottom-0 mt-auto -mx-4 border-t border-line bg-page px-4 py-3' : ''}`}>
        <button type="button" onClick={onClose} className="press rounded-lg border border-line px-4 py-2 text-sm text-ink max-md:min-h-[44px]" data-testid="manual-cancel">取消</button>
        <button type="submit" disabled={busy || !!dup}
          className="press inline-flex items-center gap-1.5 rounded-lg bg-ink px-4 py-2 text-sm text-white max-md:min-h-[44px] disabled:cursor-not-allowed disabled:opacity-40" data-testid="manual-save">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}保存到词库
        </button>
      </div>
    </form>
  );
}

/** 已有词条：复用词库页的详情（意思、例句、状态、笔记都在），不离开当前页面。 */
function ExistingEntry({ word }: { word: string }) {
  const [data, setData] = useState<BrowseData | null>(null);
  const [notes, setNotes] = useState<VocabNote[]>([]);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<Selection>({ kind: 'word', id: wordKey(word) });

  useEffect(() => {
    let alive = true;
    Promise.all([vocabApi.browse(), vocabApi.listNotes()]).then(([value, list]) => {
      if (!alive) return;
      setData(value);
      setNotes(list);
    }).catch(reason => { if (alive) setError(`读取词库失败：${errorText(reason)}`); });
    return () => { alive = false; };
  }, []);

  const library = useMemo(() => data ? buildLibrary(data, groupNotes(notes)) : null, [data, notes]);
  const metadataSaved = (result: ReviewMetadataResult) => setData(current => current && ({
    ...current,
    reviewWords: current.reviewWords.map(item => item.id === result.id ? { ...item, source: result.source, verificationStatus: result.verificationStatus } : item),
  }));

  if (error) return <div role="alert" className="vocab-wrap rounded-lg border border-danger/30 bg-danger-soft p-3 text-sm text-danger">{error}</div>;
  if (!library) return <p className="text-sm text-mute" role="status">正在读取词库…</p>;
  if (selection.kind === 'word' && !library.wordByKey.has(selection.id)) {
    return <p className="text-sm text-mute" data-testid="vocab-entry-missing">词库里没有找到「{word}」。</p>;
  }
  return (
    <div className="pr-6">
      <EntryDetail selection={selection} library={library} query="" onOpen={setSelection} onReviewMetadataSaved={metadataSaved}
        noteHandlers={{ onSaved: note => setNotes(current => upsertNote(current, note)), onDeleted: id => setNotes(current => removeNote(current, id)) }} />
    </div>
  );
}

type Open = { key: number; request: VocabAddRequest } | null;

export default function ManualAddHost() {
  const [open, setOpen] = useState<Open>(null);
  const [toast, setToast] = useState<{ key: number; word: string; issue: string } | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const counter = useRef(0);

  useEffect(() => onManualAddRequest(request => {
    if (!returnFocus.current && document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
    counter.current += 1;
    setToast(null);
    setOpen({ key: counter.current, request });
  }), []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const close = useCallback(() => {
    setOpen(null);
    const element = returnFocus.current;
    returnFocus.current = null;
    if (element?.isConnected) element.focus();
  }, []);

  const showEntry = (word: string) => { counter.current += 1; setOpen({ key: counter.current, request: { kind: 'open', word } }); };

  return (
    <>
      {open?.request.kind === 'add' && (
        <Overlay label="添加词条" onClose={close} testId="manual-add">
          <AddForm key={open.key} initial={open.request.prefill} onClose={close} onOpenExisting={showEntry}
            onSaved={(word, issue) => { if (open.request.kind === 'add') open.request.onSaved?.(word, issue); close(); counter.current += 1; setToast({ key: counter.current, word, issue }); }} />
        </Overlay>
      )}
      {open?.request.kind === 'open' && (
        <Overlay label={`词库里的 ${open.request.word}`} onClose={close} testId="vocab-entry-dialog">
          <ExistingEntry key={open.key} word={open.request.word} />
        </Overlay>
      )}
      {toast && (
        <div key={toast.key} role="status" data-testid="manual-toast" data-no-lookup=""
          className="fixed bottom-5 left-1/2 z-[95] flex max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center gap-2 rounded-2xl bg-ink py-1.5 pl-4 pr-1.5 text-sm text-white shadow-card fade-in">
          <span className="vocab-wrap min-w-0">已加入词库：{toast.word}（{toast.issue}{/^\d/.test(toast.issue) ? ' 期' : ''} · 待考察）</span>
          <button type="button" onClick={() => { const word = toast.word; setToast(null); showEntry(word); }}
            className="press h-7 shrink-0 rounded-full bg-white/15 px-3 font-medium" data-testid="manual-toast-open">查看</button>
        </div>
      )}
    </>
  );
}
