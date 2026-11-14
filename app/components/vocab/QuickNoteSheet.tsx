import React, { useEffect, useRef, useState } from 'react';
import { vocabApi } from '../../utils/vocab/api';
import { canSaveBody } from '../../utils/quicknote/context';

/**
 * 063 手机「随手记」底部输入面板：点大按钮从底部滑上来，保存后收起。
 * 保存走和电脑快捷框同一个 vocabApi.addQuickNote（里面会通知角标刷新）；手机上没有视频上下文，所以上下文固定「无」。
 * 内容非空时关闭（点暗处 / 下滑 / 取消）先问「放弃这条？」。
 */

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const CLOSE_MS = 200;

export default function QuickNoteSheet({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [mounted, setMounted] = useState(false);
  const [closing, setClosing] = useState(false);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const startY = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      setMounted(true); setClosing(false); setBody(''); setError(''); setBusy(false); setAsking(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const id = window.setTimeout(() => { setMounted(false); setClosing(false); }, CLOSE_MS);
    return () => window.clearTimeout(id);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (open && mounted) area.current?.focus(); }, [open, mounted]);

  if (!mounted) return null;

  const requestClose = () => {
    if (busy) return;
    if (body.trim()) { setAsking(true); return; }
    onClose();
  };

  const save = async () => {
    if (busy || !canSaveBody(body)) return;
    setBusy(true);
    setError('');
    try {
      await vocabApi.addQuickNote({ body, context: { kind: 'none' } });
      onSaved();
    } catch (reason) {
      setError(`没存上：${errorText(reason)}`);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[96]" data-testid="quicknote-sheet" data-state={closing ? 'closing' : 'open'} data-no-lookup="">
      <div className={`absolute inset-0 bg-ink/30 ${closing ? 'sheet-fade-out' : 'fade-in'}`} onClick={requestClose} data-testid="quicknote-sheet-backdrop" />
      <section role="dialog" aria-label="随手记"
        className={`absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-line bg-page p-4 shadow-lift ${closing ? 'sheet-down' : 'sheet-up'}`}>
        <div className="-mt-2 mb-2 flex justify-center py-2"
          onTouchStart={e => { startY.current = e.touches[0].clientY; }}
          onTouchEnd={e => {
            const y0 = startY.current; startY.current = null;
            if (y0 !== null && e.changedTouches[0].clientY - y0 > 50) requestClose();
          }}>
          <span className="h-1 w-10 rounded-full bg-line" />
        </div>
        {asking ? (
          <div data-testid="quicknote-discard" role="alertdialog" aria-label="放弃这条？">
            <p className="text-base text-ink">放弃这条？</p>
            <p className="mt-1 text-sm text-mute">已经写的内容不会保存。</p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <button type="button" data-testid="quicknote-keep" onClick={() => { setAsking(false); area.current?.focus(); }}
                className="press min-h-[48px] rounded-2xl border border-line bg-page text-base text-ink">继续写</button>
              <button type="button" data-testid="quicknote-discard-yes" onClick={() => { setAsking(false); onClose(); }}
                className="press min-h-[48px] rounded-2xl bg-ink text-base text-white">放弃</button>
            </div>
          </div>
        ) : (
          <>
            <textarea ref={area} value={body} onChange={e => setBody(e.target.value)} rows={4} maxLength={4000} autoFocus
              aria-label="随手记内容" placeholder="想到什么，写一句" data-testid="quicknote-sheet-input" spellCheck={false}
              className="w-full min-w-0 resize-none rounded-xl border border-line bg-page px-3 py-2 text-base text-ink outline-none focus:border-ink" />
            {error && <p role="alert" className="vocab-wrap mt-2 text-sm text-danger" data-testid="quicknote-sheet-error">{error}</p>}
            <div className="mt-3 grid grid-cols-2 gap-3">
              <button type="button" data-testid="quicknote-sheet-cancel" onClick={requestClose}
                className="press min-h-[48px] rounded-2xl border border-line bg-page text-base text-ink">取消</button>
              <button type="button" data-testid="quicknote-sheet-save" onClick={() => void save()} disabled={busy || !canSaveBody(body)}
                className="press min-h-[48px] rounded-2xl bg-ink text-base text-white disabled:opacity-40">保存</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
