import type { QuickNote, QuickNoteContext } from '../vocab/types';
import { describeContext } from './context';

export type QuickNoteDestination = 'vocab' | 'example' | 'note' | 'ai';

/** 只用本地文字和上下文给整理建议，不请求模型。 */
export function suggestQuickNoteDestination(body: string, context: QuickNoteContext): QuickNoteDestination {
  const text = body.trim();
  if (/[？?]/.test(text) || /为什么|什么意思|什么含义|有何区别|区别/.test(text)) return 'ai';
  if (context.text?.trim()) return 'example';
  if (quickNoteWordPrefill(text)) return 'vocab';
  if (/^[A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z'’,\-]+){2,}[.!?]?$/.test(text)) return 'example';
  return 'note';
}

const DESTINATION_LABEL: Record<QuickNoteDestination, string> = {
  vocab: '加入词库', example: '存为例句', note: '留作笔记', ai: '问 AI',
};

export function suggestionLabel(destination: QuickNoteDestination): string {
  return DESTINATION_LABEL[destination];
}

export function quickNoteContextText(context: QuickNoteContext): string {
  return describeContext(context) ?? '';
}

/** 按记录时间的日期分组；保留时间、上下文和整理去向，供「随手记.md」导出。 */
export function formatQuickNotesMarkdown(notes: readonly QuickNote[]): string {
  const groups = new Map<string, QuickNote[]>();
  for (const note of notes) {
    const date = localNoteDateTime(note.createdAt).date;
    const group = groups.get(date);
    if (group) group.push(note); else groups.set(date, [note]);
  }
  const lines = ['# 随手记', ''];
  for (const date of [...groups.keys()].sort((a, b) => b.localeCompare(a))) {
    lines.push(`## ${date}`, '');
    for (const note of groups.get(date)!) {
      const time = localNoteDateTime(note.createdAt).time;
      lines.push(`- ${time} ${note.body.replace(/\r?\n/g, '\n  ')}`);
      const context = quickNoteContextText(note.context);
      if (context) lines.push(`  - 上下文：${context.replace(/\r?\n/g, ' ')}`);
      lines.push(`  - 去向：${note.destination || (note.status === '待整理' ? '待整理' : '未填写')}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

/** 导出时间与页面显示一致，按本机时区生成日期和时刻，不能直接截 UTC 字符串。 */
function localNoteDateTime(createdAt: string): { date: string; time: string } {
  const stamp = new Date(createdAt);
  if (Number.isNaN(stamp.getTime())) {
    return { date: createdAt.slice(0, 10) || '日期未知', time: createdAt.slice(11, 16) || '--:--' };
  }
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    date: `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}`,
    time: `${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`,
  };
}

/** 检查单词建议能否安全预填为一个英文词或短语。 */
export function quickNoteWordPrefill(body: string): string | null {
  const text = body.trim().replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '').replace(/\s+/g, ' ');
  return /^[A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*)?$/.test(text) ? text : null;
}

/** 撤回时明确清空旧去向，避免待整理状态仍残留完成标记。 */
export function quickNoteReopenArgs(id: number): [number, '待整理', ''] {
  return [id, '待整理', ''];
}
