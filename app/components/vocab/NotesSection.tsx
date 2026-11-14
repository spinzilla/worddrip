import React, { useState } from 'react';
import { IS_MOBILE } from '../../utils/platform';
import { NotebookPen, Pencil, Plus, Trash2 } from 'lucide-react';
import HelpHint from './HelpHint';
import { vocabApi } from '../../utils/vocab/api';
import { formatNoteTime, notifyNotesChanged, wasEdited } from '../../utils/vocab/notes';
import type { NoteSource, VocabNote } from '../../utils/vocab/types';

// 040 词条笔记：看、加、改、删。正文按纯文本节点渲染（React 自动转义），
// 放在 <p> 里，外层 Lookable 能点里面的英文词查词；按钮和输入框不触发查词。
// 041 的复习、首考、闪卡会复用这个组件，只是 source 不同。

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export interface NoteHandlers {
  onSaved: (note: VocabNote) => void;
  onDeleted: (id: number) => void;
}

function NoteItem({ note, handlers }: { note: VocabNote; handlers: NoteHandlers }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm'>('view');
  const [draft, setDraft] = useState(note.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (busy || !draft.trim()) return;
    setBusy(true);
    setError('');
    try {
      handlers.onSaved(await vocabApi.updateNote({ id: note.id, body: draft }));
      notifyNotesChanged();
      setMode('view');
    } catch (reason) {
      setError(`保存失败：${errorText(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await vocabApi.deleteNote(note.id);
      handlers.onDeleted(note.id);
      notifyNotesChanged();
    } catch (reason) {
      setError(`删除失败：${errorText(reason)}`);
      setBusy(false);
    }
  };

  return (
    <li className="vocab-note" data-testid="note-item" data-note-id={note.id}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs text-mute" data-testid="note-time">{formatNoteTime(note.createdAt)}</span>
        <span className="vocab-chip border-line bg-page text-mute" data-testid="note-source">{note.source}</span>
        {wasEdited(note) && <span className="text-[11px] text-faint" title={`改于 ${formatNoteTime(note.updatedAt)}`}>已修改</span>}
        {mode === 'view' && (
          <span className="ml-auto flex shrink-0 gap-1">
            <button type="button" onClick={() => { setDraft(note.body); setMode('edit'); setError(''); }} className="press inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-mute hover:bg-shade hover:text-ink" data-testid="note-edit">
              <Pencil size={12} />编辑
            </button>
            <button type="button" onClick={() => { setMode('confirm'); setError(''); }} className="press inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-mute hover:bg-shade hover:text-danger" data-testid="note-delete">
              <Trash2 size={12} />删除
            </button>
          </span>
        )}
      </div>

      {mode === 'edit' ? (
        <div className="mt-2">
          <textarea
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); } }}
            // 窄屏一行放不了几个字：按换行数 + 字数粗估高度，4–10 行之间。
            rows={Math.min(10, Math.max(4, draft.split('\n').length + Math.ceil(draft.length / 40)))}
            aria-label="修改笔记"
            className="vocab-note-input"
            data-testid="note-edit-input"
            autoFocus
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => void save()} disabled={busy || !draft.trim() || draft === note.body} className="press rounded-lg bg-ink px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-45" data-testid="note-save">
              {busy ? '正在保存…' : '保存'}
            </button>
            <button type="button" onClick={() => { setMode('view'); setError(''); }} disabled={busy} className="press rounded-lg border border-line px-3 py-1.5 text-sm text-ink" data-testid="note-cancel">
              取消
            </button>
          </div>
        </div>
      ) : (
        <p className="vocab-wrap mt-1.5 whitespace-pre-wrap text-[15px] leading-relaxed text-ink" data-testid="note-body">{note.body}</p>
      )}

      {mode === 'confirm' && (
        <div role="alertdialog" aria-label="确认删除笔记" className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-ink" data-testid="note-delete-confirm">
          <span className="min-w-[10rem] flex-1">删除这条笔记？删了找不回来。</span>
          {/* 两个按钮一组：窄屏换行时一起挪到下一行，不会拆开。 */}
          <span className="flex shrink-0 gap-2">
            <button type="button" onClick={() => void remove()} disabled={busy} className="press rounded-lg bg-danger px-3 py-1.5 text-sm text-white disabled:opacity-45" data-testid="note-delete-yes">
              {busy ? '正在删除…' : '确定删除'}
            </button>
            <button type="button" onClick={() => setMode('view')} disabled={busy} className="press rounded-lg border border-line bg-page px-3 py-1.5 text-sm text-ink" data-testid="note-delete-no">
              不删了
            </button>
          </span>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </li>
  );
}

/**
 * 一个词的笔记列表 + 添加框。word 是给哪个词记（按归一化后的词分组）。
 * 041：blind = 作答中（提交前）只能新写——不显示旧笔记、条数，界面和 DOM 里都不出现 word；
 * label 代替 word 出现在输入框提示里（例如「第 2 题」）。blind 从 true 变 false 时组件不重建，没保存的草稿还在。
 */
export default function NotesSection({ word, notes, handlers, source = '词库', compact = false, blind = false, label }: {
  word: string;
  notes: readonly VocabNote[];
  handlers: NoteHandlers;
  source?: NoteSource;
  compact?: boolean;
  blind?: boolean;
  label?: string;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(!compact);
  /** blind 模式下保存成功的提示（不带条数）。 */
  const [savedTip, setSavedTip] = useState(false);
  const name = label ?? word;

  const add = async () => {
    if (busy || !draft.trim()) return;
    setBusy(true);
    setError('');
    try {
      handlers.onSaved(await vocabApi.addNote({ word, body: draft, source }));
      notifyNotesChanged();
      setDraft('');
      setSavedTip(true);
    } catch (reason) {
      setError(`添加失败：${errorText(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="notes" data-word={blind ? undefined : word} data-blind={blind ? 'true' : undefined}>
      {!blind && notes.length > 0 && (
        <ul className="space-y-2" data-testid="note-list">
          {notes.map(note => <NoteItem key={note.id} note={note} handlers={handlers} />)}
        </ul>
      )}
      {!blind && notes.length === 0 && !compact && (
        <div className="vocab-empty" data-testid="notes-empty">
          <NotebookPen size={16} className="shrink-0 text-faint" />
          <span className="whitespace-nowrap">还没有笔记</span>
          <HelpHint text={`记下易混词、搭配、自己的例句都行，${IS_MOBILE ? '只存在本机' : '只存在这台电脑上'}，不会发给模型。`} />
        </div>
      )}
      {open ? (
        <div className={!blind && (notes.length > 0 || !compact) ? 'mt-3' : ''}>
          <textarea
            value={draft}
            onChange={event => { setDraft(event.target.value); setSavedTip(false); }}
            onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void add(); } }}
            rows={3}
            placeholder={blind ? `给${name}记一笔：易混词、搭配、想到的例句都行${IS_MOBILE ? '' : '（Ctrl+Enter 保存）'}` : `给 ${name} 记一条笔记${IS_MOBILE ? '' : '（Ctrl+Enter 保存）'}`}
            aria-label={blind ? `给${name}记笔记` : `给 ${name} 记笔记`}
            className="vocab-note-input"
            data-testid="note-input"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void add()} disabled={busy || !draft.trim()} className="press inline-flex items-center gap-1 rounded-lg bg-ink px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-45" data-testid="note-add">
              <Plus size={14} />{busy ? '正在保存…' : '添加笔记'}
            </button>
            {savedTip && <span className="text-xs text-success" role="status" data-testid="note-saved-tip">{blind ? '已保存。提交这一屏后能看到这个词的全部笔记。' : '已保存。'}</span>}
            {compact && <button type="button" onClick={() => { setOpen(false); setDraft(''); }} className="press rounded-lg border border-line px-3 py-1.5 text-sm text-ink">收起</button>}
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className={`press inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-xs text-ink hover:border-ink/30 ${!blind && notes.length > 0 ? 'mt-2' : ''}`} data-testid="note-open">
          <Plus size={12} />记笔记
        </button>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}
