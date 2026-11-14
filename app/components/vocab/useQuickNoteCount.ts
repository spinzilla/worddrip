import { useCallback, useEffect, useState } from 'react';
import { vocabApi } from '../../utils/vocab/api';
import { onQuickNotesChanged } from '../../utils/quicknote/changed';

/** 导航和词库分页共用待整理数量，和复习到期数字分开显示。 */
export default function useQuickNoteCount() {
  const [count, setCount] = useState(0);
  const load = useCallback(() => {
    vocabApi.listQuickNotes('待整理').then(notes => setCount(notes.length)).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const off = onQuickNotesChanged(load);
    window.addEventListener('focus', load);
    return () => { off(); window.removeEventListener('focus', load); };
  }, [load]);
  return count;
}
