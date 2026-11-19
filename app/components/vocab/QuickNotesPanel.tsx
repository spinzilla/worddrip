import React, { useCallback, useEffect, useState } from 'react';
import { Download, Loader2, Pencil, Trash2 } from 'lucide-react';
import { save } from '@tauri-apps/plugin-dialog';
import { writePickedTextFile } from '../../utils/vocab/libraryTransfer';
import { vocabApi } from '../../utils/vocab/api';
import { openManualAdd } from '../../utils/vocab/manualAdd';
import { notifyExamplesChanged } from '../../utils/vocab/examples';
import { describeContext } from '../../utils/quicknote/context';
import { askAboutQuickNote, QUICKNOTE_ASK_KIND } from '../../utils/quicknote/ask';
import { aiPanelState } from '../ai/panelState';
import { isLiveTask, useAiTasksBy } from '../ai/useAiTasksBy';
import { formatQuickNotesMarkdown, quickNoteReopenArgs, quickNoteWordPrefill, suggestQuickNoteDestination, suggestionLabel } from '../../utils/quicknote/triage';
import { onQuickNotesChanged } from '../../utils/quicknote/changed';
import useQuickNoteCount from './useQuickNoteCount';
import { hasQuestionModel } from '../../utils/vocab/recallModel';
import type { BrowseReviewWord, QuickNote, QuickNoteStatus } from '../../utils/vocab/types';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const buttonClass = 'press inline-flex items-center gap-1 rounded-lg border border-line bg-page px-2.5 py-1.5 text-xs text-ink hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-45';
const primaryClass = 'press inline-flex items-center gap-1 rounded-lg bg-ink px-2.5 py-1.5 text-xs text-white disabled:cursor-not-allowed disabled:opacity-45';
function createdLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function QuickNoteItem({ note, words, onChanged, onDeleted, onVocabUpdated }: {
  note: QuickNote;
  words: BrowseReviewWord[];
  onChanged: (note: QuickNote) => void;
  onDeleted: (id: number) => void;
  onVocabUpdated: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [chooseWord, setChooseWord] = useState(false);
  const [selectedWord, setSelectedWord] = useState('');
  const [aiError, setAiError] = useState('');
  // 「问 AI」是后台任务（090）：切页面不断；回复在 AI 小窗里看，这里从同一个任务读答案。
  const askTasks = useAiTasksBy({ kind: QUICKNOTE_ASK_KIND, noteId: String(note.id) });
  const askTask = askTasks[0];
  const asking = isLiveTask(askTask);
  const suggestion = suggestQuickNoteDestination(note.body, note.context);
  const context = describeContext(note.context);
  const entryWord = note.context.kind === 'entry' ? words.find(item => item.word.toLowerCase() === note.context.word?.toLowerCase())?.word : undefined;

  const markDone = async (destination: string) => {
    if (saving) return;
    setSaving(true); setError('');
    try { onChanged(await vocabApi.markQuickNote(note.id, '已整理', destination)); }
    catch (reason) { setError(`整理失败：${errorText(reason)}`); }
    finally { setSaving(false); }
  };

  const addToVocab = () => {
    const word = quickNoteWordPrefill(note.body);
    if (!word) { setError('这条内容不是一两个英文词，请先改正文，再加入词库。'); return; }
    openManualAdd({ word }, addedWord => {
      void onVocabUpdated().catch(() => {}).finally(() => markDone(`词库：${addedWord}`));
    });
  };

  const saveExample = async (word: string) => {
    if (saving) return;
    if (!word) { setError('请先选一个词条。'); return; }
    setSaving(true); setError('');
    try {
      await vocabApi.addExamples({ word, items: [{ sentence: note.body.trim(), source: '自己写' }] });
      notifyExamplesChanged();
    } catch (reason) {
      setError(`保存例句失败：${errorText(reason)}`);
      setSaving(false);
      return;
    }
    try { onChanged(await vocabApi.markQuickNote(note.id, '已整理', `例句：${word}`)); }
    catch (reason) { setError(`例句已保存，但随手记仍待整理：${errorText(reason)}`); }
    finally { setSaving(false); }
  };

  // 建任务后请小窗展开到这一条（电脑侧栏 / 手机抽屉）。
  const ask = () => {
    if (asking || !hasQuestionModel()) return;
    setAiError('');
    try {
      const outcome = askAboutQuickNote(note);
      if ('reason' in outcome) setAiError(outcome.reason); else aiPanelState.reveal(outcome.task.id);
    } catch (reason) { setAiError(errorText(reason)); }
  };

  const saveEdit = async () => {
    const body = draft.trim();
    if (!body) { setError('正文不能为空。'); return; }
    setSaving(true); setError('');
    try { onChanged(await vocabApi.updateQuickNote(note.id, body)); setEditing(false); }
    catch (reason) { setError(`修改失败：${errorText(reason)}`); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    setSaving(true); setError('');
    try { await vocabApi.deleteQuickNote(note.id); onDeleted(note.id); }
    catch (reason) { setError(`删除失败：${errorText(reason)}`); setSaving(false); }
  };

  return (
    <article className="min-w-0 rounded-xl border border-line bg-page p-4" data-testid="quicknote-item" data-note-id={note.id} data-suggestion={suggestion}>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-mute">
        <time>{createdLabel(note.createdAt)}</time>
        <span className={`rounded-full border px-2 py-0.5 ${note.status === '待整理' ? 'border-clay/30 bg-clay-soft text-clay' : 'border-success/30 bg-success-soft text-success'}`}>{note.status}</span>
        {note.status === '待整理' && <span className="rounded-full border border-line bg-shade px-2 py-0.5">建议：{suggestionLabel(suggestion)}</span>}
        {note.destination && <span className="vocab-wrap">去向：{note.destination}</span>}
      </div>
      {editing ? (
        <div className="mt-3">
          <textarea value={draft} onChange={event => setDraft(event.target.value)} rows={3} maxLength={4000} aria-label="修改随手记正文" className="w-full min-w-0 resize-y rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink" data-testid="quicknote-edit-input" />
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <button type="button" className={buttonClass} onClick={() => { setEditing(false); setDraft(note.body); setError(''); }}>取消</button>
            <button type="button" className={primaryClass} disabled={saving} onClick={() => void saveEdit()} data-testid="quicknote-edit-save">{saving ? '正在保存…' : '保存正文'}</button>
          </div>
        </div>
      ) : <p className="vocab-wrap mt-3 whitespace-pre-wrap text-sm leading-6 text-ink" data-testid="quicknote-body">{note.body}</p>}
      {context && <p className="vocab-wrap mt-2 rounded-lg bg-shade px-3 py-2 text-xs leading-5 text-mute" data-testid="quicknote-context">{context}</p>}

      {note.status === '待整理' && !editing && (
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
          <button type="button" className={suggestion === 'vocab' ? primaryClass : buttonClass} disabled={saving} onClick={addToVocab} data-testid="quicknote-to-vocab">加入词库</button>
          <button type="button" className={suggestion === 'example' ? primaryClass : buttonClass} disabled={saving} onClick={() => {
            if (entryWord) void saveExample(entryWord);
            else { setChooseWord(value => !value); setError(''); }
          }} data-testid="quicknote-to-example">存为例句</button>
          <button type="button" className={suggestion === 'note' ? primaryClass : buttonClass} disabled={saving} onClick={() => void markDone('笔记')} data-testid="quicknote-to-note">留作笔记</button>
          <button type="button" className={suggestion === 'ai' ? primaryClass : buttonClass} disabled={!hasQuestionModel() || asking} title={hasQuestionModel() ? '把正文和上下文发给设置里的模型' : '请先到「设置」配置模型'} onClick={() => void ask()} data-testid="quicknote-ask-ai">
            {asking && <Loader2 size={13} className="animate-spin" />}{asking ? '正在询问…' : '问 AI'}
          </button>
          {!hasQuestionModel() && <span className="text-xs text-mute">未配置模型；请去「设置」填写接口地址、API Key 和模型名称。</span>}
        </div>
      )}
      {note.status === '待整理' && chooseWord && !entryWord && (
        <div className="mt-3 flex min-w-0 flex-wrap items-end gap-2 rounded-lg border border-line bg-shade p-3" data-testid="quicknote-example-picker">
          <label className="min-w-0 flex-1 text-xs text-mute">这句属于哪个词条？
            <select value={selectedWord} onChange={event => setSelectedWord(event.target.value)} className="mt-1 block w-full min-w-0 rounded-lg border border-line bg-page px-2 py-2 text-sm text-ink" data-testid="quicknote-example-word">
              <option value="">请选择</option>{words.map(word => <option key={word.id} value={word.word}>{word.word}</option>)}
            </select>
          </label>
          <button type="button" className={primaryClass} disabled={saving || !selectedWord} onClick={() => void saveExample(selectedWord)} data-testid="quicknote-example-save">{saving ? '正在保存…' : '保存例句'}</button>
          {words.length === 0 && <span className="text-xs text-mute">词库目前没有词条。</span>}
        </div>
      )}
      {askTask?.text && <div className="mt-3 rounded-xl border border-line bg-shade p-3 text-sm leading-6 text-ink" data-testid="quicknote-ai-answer"><div className="mb-1 flex items-center gap-1 text-xs font-medium text-mute">AI 回答（这条仍在待整理）{asking && <Loader2 size={11} className="animate-spin" />}</div><p className="vocab-wrap whitespace-pre-wrap">{askTask.text}</p></div>}
      {asking && !askTask?.text && <p className="mt-3 text-xs text-mute" data-testid="quicknote-ai-status">AI 正在回答…（在小窗里看进度）</p>}
      {askTask?.status === 'failed' && askTask.error && <p role="alert" className="mt-2 text-xs text-danger" data-testid="quicknote-ai-error">{askTask.error}</p>}
      {aiError && <p role="alert" className="mt-2 text-xs text-danger" data-testid="quicknote-ai-error">{aiError}</p>}
      {!editing && <div className="mt-3 flex flex-wrap items-center gap-2">
        {note.status === '已整理' && <button type="button" className={buttonClass} disabled={saving} onClick={() => {
          const [id, status, destination] = quickNoteReopenArgs(note.id);
          setSaving(true); setError('');
          void vocabApi.markQuickNote(id, status, destination).then(onChanged).catch(reason => setError(`撤回失败：${errorText(reason)}`)).finally(() => setSaving(false));
        }} data-testid="quicknote-reopen">撤回到待整理</button>}
        <button type="button" className={`${buttonClass} ${note.status === '待整理' ? 'ml-auto' : ''}`} disabled={saving} onClick={() => { setEditing(true); setDraft(note.body); setError(''); }} data-testid="quicknote-edit"><Pencil size={12} />改正文</button>
        {!confirmDelete ? <button type="button" className={buttonClass} disabled={saving} onClick={() => setConfirmDelete(true)} data-testid="quicknote-delete"><Trash2 size={12} />删除</button> : (
          <span className="inline-flex items-center gap-1 rounded-lg border border-danger/30 bg-danger-soft px-2 py-1 text-xs text-ink" role="alertdialog" aria-label="确认删除随手记">
            <span>确定删除？</span>
            <button type="button" className="rounded bg-danger px-2 py-1 text-white" disabled={saving} onClick={() => void remove()} data-testid="quicknote-delete-yes">删除</button>
            <button type="button" className="rounded border border-line px-2 py-1" disabled={saving} onClick={() => setConfirmDelete(false)}>取消</button>
          </span>
        )}
      </div>}
      {error && <p role="alert" className="mt-2 text-xs text-danger" data-testid="quicknote-error">{error}</p>}
    </article>
  );
}

export default function QuickNotesPanel() {
  const [filter, setFilter] = useState<QuickNoteStatus | '全部'>('待整理');
  const [notes, setNotes] = useState<QuickNote[]>([]);
  const [words, setWords] = useState<BrowseReviewWord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState('');
  const pendingCount = useQuickNoteCount();

  const refreshWords = useCallback(async () => {
    const data = await vocabApi.browse();
    setWords(data.reviewWords);
  }, []);

  const loadNotes = useCallback(() => {
    let alive = true;
    setLoading(true); setError('');
    const status = filter === '全部' ? undefined : filter;
    vocabApi.listQuickNotes(status).then(list => { if (alive) setNotes(list); })
      .catch(reason => { if (alive) setError(`读取随手记失败：${errorText(reason)}`); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [filter]);

  useEffect(() => {
    const cancel = loadNotes();
    const off = onQuickNotesChanged(() => { cancel(); loadNotes(); });
    return () => { cancel(); off(); };
  }, [loadNotes]);

  useEffect(() => {
    refreshWords().catch(() => {});
  }, [refreshWords]);

  const update = (updated: QuickNote) => setNotes(current => current.flatMap(note => note.id !== updated.id ? [note] : filter === '待整理' && updated.status !== '待整理' ? [] : [updated]));
  const remove = (id: number) => setNotes(current => current.filter(note => note.id !== id));
  const exportNotes = async () => {
    if (exporting) return;
    setExporting(true); setError(''); setExportNotice('');
    try {
      const selected = await save({ defaultPath: '随手记.md', filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] });
      if (typeof selected !== 'string') { setExportNotice('已取消保存，没有写入文件。'); return; }
      const all = await vocabApi.listQuickNotes();
      await writePickedTextFile(selected, formatQuickNotesMarkdown(all));
      setExportNotice(`已导出 ${all.length} 条随手记：${selected}`);
    } catch (reason) { setError(`导出随手记失败：${errorText(reason)}`); }
    finally { setExporting(false); }
  };

  return (
    <section className="min-w-0" data-testid="quicknotes-panel">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label="随手记范围">
          {(['待整理', '全部'] as const).map(value => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)} className={`press rounded-full border px-3 py-1.5 text-sm ${filter === value ? 'border-ink bg-ink text-white' : 'border-line text-ink hover:border-ink/30'}`} data-testid={`quicknotes-filter-${value === '全部' ? 'all' : 'pending'}`}>{value}{value === '待整理' ? `（${pendingCount}）` : ''}</button>)}
        </div>
        <button type="button" onClick={() => void exportNotes()} disabled={exporting} className={`${buttonClass} ml-auto`} data-testid="quicknotes-export"><Download size={14} />{exporting ? '正在导出…' : '导出 随手记.md'}</button>
      </div>
      {exportNotice && <p role="status" className="mt-3 break-all text-xs text-success" data-testid="quicknotes-export-notice">{exportNotice}</p>}
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      {loading ? <p className="mt-4 text-sm text-mute">正在读取随手记…</p> : notes.length === 0 ? <p className="mt-4 rounded-xl border border-line bg-page p-5 text-sm text-mute" data-testid="quicknotes-empty">{filter === '待整理' ? '没有待整理的随手记。' : '还没有随手记。'}</p> : (
        <div className="mt-3 grid min-w-0 gap-3">{notes.map(note => <QuickNoteItem key={note.id} note={note} words={words} onChanged={update} onDeleted={remove} onVocabUpdated={refreshWords} />)}</div>
      )}
    </section>
  );
}
