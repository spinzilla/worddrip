import React, { useCallback, useEffect } from 'react';
import DefinitionPanel from './DefinitionPanel';
import { useLookup } from '../hooks/useLookup';
import { isBlockedWord, scrubDefinition, scrubText, sentenceAround, wordAt } from '../utils/clickWords';

// caretRangeFromPoint 是 Chromium / WebKit 的接口，TypeScript 的 DOM 类型还没写全。
type PointDocument = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
};

const BLOCK = 'p, li, dt, dd, blockquote, h1, h2, h3, h4, h5, h6, th, td, pre, [data-lookup-line]';
const SKIP = 'input, textarea, select, button, a, summary, [contenteditable="true"], [data-no-lookup]';

/** 找到鼠标下面的文字节点和偏移；不选中文字，也不改变原来的焦点。 */
function textAtPoint(x: number, y: number): { node: Text; offset: number } | null {
  const doc = document as PointDocument;
  if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(x, y);
    if (range?.startContainer.nodeType === Node.TEXT_NODE) return { node: range.startContainer as Text, offset: range.startOffset };
  }
  const caret = doc.caretPositionFromPoint?.(x, y);
  return caret?.offsetNode.nodeType === Node.TEXT_NODE ? { node: caret.offsetNode as Text, offset: caret.offset } : null;
}

/**
 * 判断屏幕坐标 (x, y) 是不是正好点在一个可查的英文词上（词形范围内）。
 * 是则返回词、它在文字节点里的位置和屏幕范围；否则 null。Lookable 点击查词和闪卡背面「点词不翻面」共用这一个判断。
 */
export function findWordAt(x: number, y: number) {
  const hit = textAtPoint(x, y);
  if (!hit) return null;
  const found = wordAt(hit.node.data, hit.offset);
  if (!found) return null;
  const range = document.createRange();
  range.setStart(hit.node, found.start);
  range.setEnd(hit.node, found.end);
  const anchor = range.getBoundingClientRect();
  // caret 在少数浏览器会落到词旁边的空白；只有确实点在词形范围内才查。
  if (x < anchor.left - 2 || x > anchor.right + 2 || y < anchor.top - 2 || y > anchor.bottom + 2) return null;
  return { hit, found, range, anchor };
}

/**
 * 让容器里已有的英文纯文本都能点词查词。
 * 不包输入框、按钮和链接；拖选文字时不弹卡，复制和输入操作不受影响。
 * targets 非空时表示正在作答：目标词不能点，其余词的语境、AI 请求和卡片都遮住目标词及变形。
 * addSource（042）：查词卡上「加入词库」写的来源（词库、教练、复习……）；不传或正在作答时不显示这个按钮。
 */
export default function Lookable({ children, targets = [], zIndex = 70, className = 'contents', addSource }: {
  children: React.ReactNode;
  targets?: readonly string[];
  zIndex?: number;
  className?: string;
  addSource?: string;
}) {
  const guarded = targets.length > 0;
  const scrub = useCallback((text: string) => scrubText(text, targets), [targets]);
  const { def, lookup, explain, closeDef } = useLookup('en', '', '', { scrub: guarded ? scrub : undefined });

  useEffect(() => {
    if (!def.word) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeDef();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [def.word, closeDef]);

  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const element = event.target instanceof Element ? event.target : null;
    if (!element || element.closest(SKIP)) return;
    // 复习弹层有自己的防泄题 Lookable，不能让外层页面再处理一次。
    if (element.closest('[data-lookup-root]') !== event.currentTarget) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const got = findWordAt(event.clientX, event.clientY);
    if (!got) return;
    const { hit, found, range, anchor } = got;
    if (guarded && isBlockedWord(found.word, targets)) return;

    const parent = hit.node.parentElement;
    const block = parent?.closest(BLOCK) ?? parent;
    let context = hit.node.data;
    let start = found.start, end = found.end;
    if (block) {
      const before = document.createRange();
      before.selectNodeContents(block);
      before.setEnd(hit.node, found.start);
      start = before.toString().length;
      end = start + found.word.length;
      context = block.textContent ?? context;
      before.detach();
    }
    range.detach();
    void lookup(found.word, sentenceAround(context, start, end), '', anchor);
  };

  const visibleDef = guarded ? scrubDefinition(def, scrub) : def;
  return (
    <div className={className} onClick={onClick} data-lookup-root="">
      {children}
      {visibleDef.word && <DefinitionPanel def={visibleDef} onClose={closeDef} onExplain={explain} zIndex={zIndex}
        vocab={addSource && !guarded ? { source: addSource } : null} />}
    </div>
  );
}
