// 069：录入笔记的原图查看器。原生 pointer 事件 + CSS transform，不加依赖。
// 两种外观：overlay（全屏弹层，手机和窄窗口）、pane（嵌在页面里的左栏，宽屏并排）。
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { NotePage } from '../../utils/vocab/noteMedia';

interface View { scale: number; x: number; y: number }
const MIN_SCALE = 1;
const MAX_SCALE = 6;
const FIT: View = { scale: 1, x: 0, y: 0 };

const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** 放大后允许拖动的范围：图在容器里按 contain 显示，放大 s 倍后四周各多出 (s-1)/2 个容器尺寸。 */
const clampView = (view: View, width: number, height: number): View => {
  const scale = clampScale(view.scale);
  const limitX = (width * (scale - 1)) / 2;
  const limitY = (height * (scale - 1)) / 2;
  return {
    scale,
    x: Math.min(limitX, Math.max(-limitX, view.x)),
    y: Math.min(limitY, Math.max(-limitY, view.y)),
  };
};

export interface NoteViewerProps {
  pages: NotePage[];
  /** 当前页下标（0 起） */
  index: number;
  onIndex: (index: number) => void;
  mode: 'overlay' | 'pane';
  onClose?: () => void;
}

function ViewerBody({ pages, index, onIndex, mode, onClose }: NoteViewerProps) {
  const page = pages[index];
  const boxRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(FIT);
  const viewRef = useRef<View>(FIT);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gesture = useRef<{ dist: number; scale: number; moved: boolean } | null>(null);
  const lastTap = useRef(0);

  const apply = useCallback((next: View) => {
    const box = boxRef.current;
    const fixed = box ? clampView(next, box.clientWidth, box.clientHeight) : next;
    viewRef.current = fixed;
    setView(fixed);
  }, []);

  // 换页时回到「完整显示」
  useEffect(() => { apply(FIT); }, [index, apply]);

  // 滚轮缩放要 preventDefault，React 的 onWheel 是被动监听，只能手动挂
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = viewRef.current;
      // 一格滚轮（deltaY≈100）约放大 16%；触摸板的小 delta 也平滑
      const factor = Math.exp(-Math.max(-300, Math.min(300, event.deltaY)) * 0.0015);
      apply({ ...current, scale: current.scale * factor });
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, [apply]);

  const pinchDistance = () => {
    const [a, b] = [...pointers.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const onPointerDown = (event: React.PointerEvent) => {
    boxRef.current?.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      gesture.current = { dist: pinchDistance(), scale: viewRef.current.scale, moved: true };
    } else if (pointers.current.size === 1) {
      gesture.current = { dist: 0, scale: viewRef.current.scale, moved: false };
    }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const prev = pointers.current.get(event.pointerId);
    if (!prev) return;
    const next = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, next);
    const g = gesture.current;
    if (!g) return;
    if (pointers.current.size >= 2) {
      const dist = pinchDistance();
      if (g.dist > 0) apply({ ...viewRef.current, scale: g.scale * (dist / g.dist) });
      return;
    }
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > 0) g.moved = g.moved || Math.hypot(dx, dy) > 2;
    const current = viewRef.current;
    if (current.scale > 1) apply({ ...current, x: current.x + dx, y: current.y + dy });
  };

  const onPointerUp = (event: React.PointerEvent) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    const g = gesture.current;
    if (pointers.current.size === 1) {
      // 双指变单指：以剩下那根为起点继续拖动，缩放基准更新
      gesture.current = { dist: 0, scale: viewRef.current.scale, moved: true };
      return;
    }
    if (pointers.current.size === 0 && g) {
      if (!g.moved) {
        const now = Date.now();
        if (now - lastTap.current < 320) {
          lastTap.current = 0;
          apply(viewRef.current.scale > 1.01 ? FIT : { scale: 2, x: 0, y: 0 });
        } else {
          lastTap.current = now;
        }
      }
      gesture.current = null;
    }
  };

  const zoomBy = (factor: number) => apply({ ...viewRef.current, scale: viewRef.current.scale * factor });

  const btn = 'press inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-line bg-page text-ink disabled:opacity-40';
  const overlay = mode === 'overlay';

  return (
    <div data-testid={overlay ? 'note-viewer' : 'note-viewer-pane'} className={overlay
      ? 'fixed inset-0 z-[100] flex flex-col bg-page'
      : 'flex h-[calc(100vh-6.5rem)] flex-col overflow-hidden rounded-xl border border-line bg-page'}>
      <div className="flex shrink-0 items-center gap-2 border-b border-line p-2">
        <button type="button" aria-label="上一页" data-testid="note-viewer-prev" className={btn} disabled={index <= 0} onClick={() => onIndex(index - 1)}><ChevronLeft size={20} /></button>
        <span data-testid="note-viewer-title" className="min-w-0 flex-1 text-center text-sm font-medium text-ink">第 {index + 1} / {pages.length} 页</span>
        <button type="button" aria-label="下一页" data-testid="note-viewer-next" className={btn} disabled={index >= pages.length - 1} onClick={() => onIndex(index + 1)}><ChevronRight size={20} /></button>
        <button type="button" aria-label="缩小" data-testid="note-viewer-zoom-out" className={btn} disabled={view.scale <= MIN_SCALE} onClick={() => zoomBy(1 / 1.4)}><ZoomOut size={18} /></button>
        <button type="button" aria-label="放大" data-testid="note-viewer-zoom-in" className={btn} disabled={view.scale >= MAX_SCALE} onClick={() => zoomBy(1.4)}><ZoomIn size={18} /></button>
        {onClose && <button type="button" aria-label="关闭" data-testid="note-viewer-close" className={btn} onClick={onClose}><X size={20} /></button>}
      </div>
      <div
        ref={boxRef}
        data-testid="note-viewer-box"
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-shade"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {page && <img
          data-testid="note-viewer-img"
          data-page={index + 1}
          data-scale={view.scale.toFixed(2)}
          src={`data:${page.mimeType};base64,${page.base64}`}
          alt={`第 ${index + 1} 页原图`}
          draggable={false}
          className="absolute inset-0 h-full w-full object-contain"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: 'center center' }}
        />}
      </div>
      <p className="shrink-0 px-3 py-1 text-center text-xs text-mute">双击放大 / 还原，滚轮或双指缩放，放大后可拖动</p>
    </div>
  );
}

export default function NoteViewer(props: NoteViewerProps) {
  if (props.mode === 'overlay') return createPortal(<ViewerBody {...props} />, document.body);
  return <ViewerBody {...props} />;
}
