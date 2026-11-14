import type {
  ErrorArchiveBatch,
  ErrorArchiveEssay,
  ErrorArchiveItem,
  ErrorArchiveParseResult,
  ErrorArchiveTodo,
  ErrorArchiveTop,
  VocabWarning,
} from './types';

const splitRow = (raw: string) => raw.trim()
  .replace(/^\|/, '')
  .replace(/\|$/, '')
  .split('|')
  .map(cell => cell.trim());

const isSeparator = (cells: string[]) => cells.length > 0
  && cells.every(cell => /^:?-{3,}:?$/.test(cell));

const sameCells = (cells: string[], expected: string[]) => cells.length === expected.length
  && cells.every((cell, index) => cell === expected[index]);

// 注释只遮字符、不删行，后面的所有行号仍对应原文件。
const maskHtmlComments = (md: string) => md.replace(/<!--[\s\S]*?-->/g, comment => (
  comment.replace(/[^\r\n]/g, ' ')
));

interface Section {
  start: number;
  end: number;
}

function findSection(
  lines: string[],
  heading: RegExp,
  label: string,
  warnings: VocabWarning[],
): Section | null {
  const start = lines.findIndex(line => heading.test(line.trim()));
  if (start < 0) {
    warnings.push({ line: 1, kind: 'section', message: `找不到「${label}」分区` });
    return null;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  return { start: start + 1, end };
}

function nextId(base: string, occurrences: Map<string, number>) {
  const occurrence = (occurrences.get(base) ?? 0) + 1;
  occurrences.set(base, occurrence);
  return occurrence === 1 ? base : `${base}#${occurrence}`;
}

function parseTop(
  lines: string[],
  originalLines: string[],
  section: Section | null,
  warnings: VocabWarning[],
): ErrorArchiveTop[] {
  if (!section) return [];
  const top: ErrorArchiveTop[] = [];
  const occurrences = new Map<string, number>();
  for (let index = section.start; index < section.end; index += 1) {
    const raw = lines[index];
    if (!raw.trim().startsWith('|')) continue;
    const cells = splitRow(raw);
    if (isSeparator(cells) || sameCells(cells, ['排名', '错误类型', '出现次数', '最近一次', '状态'])) continue;
    if (cells.length !== 5) {
      warnings.push({ line: index + 1, kind: 'columns', message: `高频错误应有 5 列，实际 ${cells.length} 列，已跳过` });
      continue;
    }
    const rank = Number.parseInt(cells[0], 10);
    if (!Number.isInteger(rank) || rank < 1 || String(rank) !== cells[0]) {
      warnings.push({ line: index + 1, kind: 'columns', message: `高频错误排名“${cells[0]}”无效，原文仍保留` });
    }
    const validRank = Number.isInteger(rank) && rank > 0 ? rank : 0;
    const id = nextId(validRank > 0 ? `et:${validRank}` : `et:line-${index + 1}`, occurrences);
    top.push({
      id,
      ord: top.length + 1,
      line: index + 1,
      raw: originalLines[index],
      rank: validRank,
      kind: cells[1],
      count: cells[2],
      lastAt: cells[3],
      status: cells[4],
    });
  }
  return top;
}

function parseBatches(
  lines: string[],
  originalLines: string[],
  section: Section | null,
  warnings: VocabWarning[],
): { batches: ErrorArchiveBatch[]; items: ErrorArchiveItem[] } {
  if (!section) return { batches: [], items: [] };
  const headings: number[] = [];
  for (let index = section.start; index < section.end; index += 1) {
    if (/^###\s+/.test(lines[index].trim())) headings.push(index);
  }
  const batches: ErrorArchiveBatch[] = [];
  const items: ErrorArchiveItem[] = [];
  const occurrences = new Map<string, number>();

  headings.forEach((start, batchIndex) => {
    const end = batchIndex + 1 < headings.length ? headings[batchIndex + 1] : section.end;
    const title = lines[start].trim().replace(/^###\s+/, '');
    const date = /^(\d{4}-\d{2}-\d{2})/.exec(title)?.[1] ?? '';
    if (!date) warnings.push({ line: start + 1, kind: 'section', message: '批次标题缺少 YYYY-MM-DD 日期' });
    const id = nextId(`eb:${date || `line-${start + 1}`}`, occurrences);
    const metadata: Record<string, string> = {};
    for (let index = start + 1; index < end; index += 1) {
      const match = /^\s*-\s+\*\*(.+?)\*\*([^：:]*)[：:]\s*(.*)$/.exec(lines[index]);
      if (!match) continue;
      const key = `${match[1]}${match[2]}`.trim();
      if (Object.hasOwn(metadata, key)) {
        warnings.push({ line: index + 1, kind: 'metadata', message: `批次元数据“${key}”重复，两个值都保留` });
        metadata[key] += `\n${match[3].trim()}`;
      } else {
        metadata[key] = match[3].trim();
      }
    }
    const batch: ErrorArchiveBatch = {
      id,
      ord: batches.length + 1,
      line: start + 1,
      raw: originalLines.slice(start, end).join('\n').trimEnd(),
      title,
      date,
      metadata,
    };
    batches.push(batch);

    let tableKind: 'normal' | 'question' | null = null;
    let itemInBatch = 0;
    for (let index = start + 1; index < end; index += 1) {
      const raw = lines[index];
      if (!raw.trim().startsWith('|')) {
        tableKind = null;
        continue;
      }
      const cells = splitRow(raw);
      if (sameCells(cells, ['类型', '我写的', '改法', '说明'])) {
        tableKind = 'normal';
        continue;
      }
      if (sameCells(cells, ['题', '类型', '我写的', '改法'])) {
        tableKind = 'question';
        continue;
      }
      if (isSeparator(cells)) continue;
      if (!tableKind) {
        warnings.push({ line: index + 1, kind: 'columns', message: '无法识别错误表表头，本行已跳过' });
        continue;
      }
      const expected = 4;
      if (cells.length !== expected) {
        warnings.push({ line: index + 1, kind: 'columns', message: `错误项应有 ${expected} 列，实际 ${cells.length} 列，已跳过` });
        continue;
      }
      itemInBatch += 1;
      const [question, kind, written, correction, note] = tableKind === 'question'
        ? [cells[0], cells[1], cells[2], cells[3], '']
        : ['', cells[0], cells[1], cells[2], cells[3]];
      items.push({
        id: `ei:${id.slice(3)}:${itemInBatch}`,
        batchId: id,
        ord: items.length + 1,
        line: index + 1,
        raw: originalLines[index],
        question,
        kind,
        written,
        correction,
        note,
      });
    }
  });
  return { batches, items };
}

function parseTodos(
  lines: string[],
  originalLines: string[],
  section: Section | null,
  warnings: VocabWarning[],
): ErrorArchiveTodo[] {
  if (!section) return [];
  const todos: ErrorArchiveTodo[] = [];
  for (let index = section.start; index < section.end; index += 1) {
    const raw = lines[index];
    const match = /^\s*-\s+\[([ xX])\]\s+(.+)$/.exec(raw);
    if (match) {
      todos.push({
        id: `todo:${todos.length + 1}`,
        ord: todos.length + 1,
        line: index + 1,
        raw: originalLines[index],
        done: match[1].toLowerCase() === 'x',
        text: match[2].trim(),
      });
    } else if (/^\s*-\s+/.test(raw)) {
      warnings.push({ line: index + 1, kind: 'columns', message: '待巩固项不是复选框格式，已跳过' });
    }
  }
  return todos;
}

function parseEssays(
  lines: string[],
  originalLines: string[],
  section: Section | null,
  warnings: VocabWarning[],
): ErrorArchiveEssay[] {
  if (!section) return [];
  const essays: ErrorArchiveEssay[] = [];
  const occurrences = new Map<string, number>();
  for (let index = section.start; index < section.end; index += 1) {
    const raw = lines[index];
    if (!raw.trim().startsWith('|')) continue;
    const cells = splitRow(raw);
    if (isSeparator(cells) || sameCells(cells, ['日期', '标准', '主题', '词数', '原始文件', '批改结果'])) continue;
    if (cells.length !== 6) {
      warnings.push({ line: index + 1, kind: 'columns', message: `作文索引应有 6 列，实际 ${cells.length} 列，已跳过` });
      continue;
    }
    const id = nextId(`ee:${cells[0] || `line-${index + 1}`}`, occurrences);
    essays.push({
      id,
      ord: essays.length + 1,
      line: index + 1,
      raw: originalLines[index],
      date: cells[0],
      standard: cells[1],
      topic: cells[2],
      wordCount: cells[3],
      originalFile: cells[4],
      result: cells[5],
    });
  }
  return essays;
}

export function parseErrorArchive(md: string): ErrorArchiveParseResult {
  const warnings: VocabWarning[] = [];
  const originalLines = md.split(/\r\n|\n|\r/);
  const lines = maskHtmlComments(md).split(/\r\n|\n|\r/);
  const top = parseTop(lines, originalLines, findSection(lines, /^##\s+一、高频错误 Top/, '一、高频错误 Top', warnings), warnings);
  const { batches, items } = parseBatches(lines, originalLines, findSection(lines, /^##\s+二、错误明细/, '二、错误明细', warnings), warnings);
  const todos = parseTodos(lines, originalLines, findSection(lines, /^##\s+四、待巩固清单/, '四、待巩固清单', warnings), warnings);
  const essays = parseEssays(lines, originalLines, findSection(lines, /^##\s+五、作文存档索引/, '五、作文存档索引', warnings), warnings);
  return { top, batches, items, todos, essays, warnings };
}