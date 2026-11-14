import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { vocabApi } from '../utils/vocab/api';
import { buildContext, canSaveBody, currentSnapshot, describeContext, mediaSource, type NoteSnapshot, type NoteSource } from '../utils/quicknote/context';

/**
 * 055 随手记快捷框：任何页面按 Ctrl+M 打开，右下角一个小框。
 * 回车保存并关闭，Shift+回车换行，Esc 关闭不存。打开时暂停视频，关闭后只在原来在播时恢复。
 * 上下文（字幕句 + 时间点 / 词条）从各页面登记的来源读（utils/quicknote/context.ts）。
 * 挂在应用最外层一次（App.tsx）。
 */

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Open = { snap: NoteSnapshot | null };

export default function QuickNoteHost() {
  const [open, setOpen] = useState<Open | null>(null);
  const [body, setBody] = useState('');
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const openRef = useRef(false);
  const paused = useRef<NoteSource | null>(null); // 是我们暂停的视频来源；非空 = 关闭时要恢复
  const returnFocus = useRef<HTMLElement | null>(null);
  openRef.current = !!open;

  const close = useCallback(() => {
    setOpen(null);
    setBody('');
    setError('');
    setBusy(false);
    const media = paused.current;
    paused.current = null;
    media?.resume?.();
    const element = returnFocus.current;
    returnFocus.current = null;
    // 听写格等输入框：把焦点还回去，用户接着打字。
    if (element?.isConnected) element.focus();
  }, []);

  // Ctrl+M（Ctrl+J 是听写「从这个词播」，用户 2026-11-12 定随手记用 M）：捕获阶段拦下，别的页面（听写格、看视频快捷键）都收不到这一下。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || !(e.code === 'KeyM' || e.key.toLowerCase() === 'm')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (openRef.current) { area.current?.focus(); return; }
      if (e.repeat) return;
      if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) returnFocus.current = document.activeElement;
      const media = mediaSource();
      paused.current = media?.pause?.() ? media : null;
      setBody('');
      setError('');
      setKeep(true);
      setOpen({ snap: currentSnapshot() });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Esc 只关这一层：捕获阶段先拿到，底下的查词卡、听写面板不跟着关。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  useEffect(() => { if (open) area.current?.focus(); }, [open]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(0), 1800);
    return () => window.clearTimeout(id);
  }, [toast]);

  const save = async () => {
    if (!open || busy || !canSaveBody(body)) return;
    setBusy(true);
    setError('');
    try {
      await vocabApi.addQuickNote({ body, context: buildContext(open.snap, keep) });
      close();
      setToast(t => t + 1);
    } catch (reason) {
      setError(`没存上：${errorText(reason)}`);
      setBusy(false);
    }
  };

  const label = open && keep ? describeContext(buildContext(open.snap, true)) : null;

  return (
    <>
      {open && (
        <section role="dialog" aria-label="随手记" data-no-lookup="" data-testid="quicknote"
          className="fixed bottom-4 right-4 z-[96] w-[360px] max-w-[calc(100vw-2rem)] min-w-0 rounded-2xl border border-line bg-page p-3 shadow-lift fade-in">
          {label ? (
            <div className="mb-2 flex min-w-0 items-center gap-1.5 text-xs text-mute" data-testid="quicknote-context" data-kind={open.snap?.kind}>
              <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
              <button type="button" onClick={() => { setKeep(false); area.current?.focus(); }} aria-label="不带上下文" title="这条不带上下文" data-testid="quicknote-drop"
                className="press shrink-0 rounded-md p-1 text-mute hover:bg-shade hover:text-ink"><X size={13} /></button>
            </div>
          ) : (
            <p className="mb-2 text-xs text-mute" data-testid="quicknote-context" data-kind="none">{open.snap && !keep ? '这条不带上下文' : '随手记'}</p>
          )}
          <textarea ref={area} value={body} onChange={e => setBody(e.target.value)} rows={3} maxLength={4000} autoFocus
            aria-label="随手记内容" placeholder="想到什么，写一句" data-testid="quicknote-input" spellCheck={false}
            onKeyDown={e => {
              // 所有键都留在框里，不让页面上的快捷键（空格、回车、字母）听到。
              e.stopPropagation();
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void save(); }
            }}
            className="w-full min-w-0 resize-none rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink outline-none focus:border-ink" />
          {error && <p role="alert" className="vocab-wrap mt-2 text-xs text-danger" data-testid="quicknote-error">{error}</p>}
          <p className="mt-1.5 text-xs text-mute">回车保存 · Shift+回车换行 · Esc 关闭</p>
        </section>
      )}
      {toast > 0 && (
        <div key={toast} role="status" data-testid="quicknote-toast" data-no-lookup=""
          className="fixed bottom-4 right-4 z-[96] rounded-2xl bg-ink px-4 py-2 text-sm text-white shadow-card fade-in">已记下</div>
      )}
    </>
  );
}
