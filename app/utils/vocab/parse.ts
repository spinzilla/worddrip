import type {
  ReviewParseResult,
  ReviewWord,
  SelfCheck,
  UpgradeEntry,
  UpgradeExample,
  UpgradeParseResult,
  VocabWarning,
} from './types';

const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');

const splitRow = (raw: string) => raw.trim()
  .replace(/^\|/, '')
  .replace(/\|$/, '')
  .split('|')
  .map(cell => cell.trim());

const isSeparator = (cells: string[]) => cells.every(cell => /^:?-{3,}:?$/.test(cell));

const parseExamples = (cell: string, line: number, warnings: VocabWarning[]): UpgradeExample[] => {
  if (cell.trim() === '') return [];

  return cell.split('⧉').map(part => {
    const original = part.trim();
    const ai = /\(AI\)$/.test(original);
    const text = ai ? original.replace(/\s*\(AI\)$/, '') : original;
    const separator = text.indexOf(': ');
    if (separator === -1) {
      warnings.push({ line, kind: 'example', message: `例句段缺少半角冒号加空格：${original}` });
      return { cand: '', sentence: text, ai };
    }
    return {
      cand: text.slice(0, separator).trim(),
      sentence: text.slice(separator + 2).trim(),
      ai,
    };
  });
};

export function parseUpgradeLibrary(md: string): UpgradeParseResult {
  const lines = md.split(/\r\n|\n|\r/);
  const entries: UpgradeEntry[] = [];
  const selfChecks: SelfCheck[] = [];
  const warnings: VocabWarning[] = [];
  const occurrences = new Map<string, number>();
  let inTable = false;
  let inSelfChecks = false;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = index + 1;
    const trimmed = raw.trim();

    if (!inTable && trimmed.startsWith('| 日常/口语')) {
      inTable = true;
      continue;
    }
    if (inTable) {
      if (!trimmed.startsWith('|')) {
        inTable = false;
      } else {
        const cells = splitRow(raw);
        if (isSeparator(cells)) continue;
        if (cells.length !== 5) {
          warnings.push({ line, kind: 'columns', message: `升级库应有 5 列，实际 ${cells.length} 列，已跳过` });
          continue;
        }

        const [plain, upgrade, examples, source, note] = cells;
        const key = normalize(plain);
        const occurrence = (occurrences.get(key) ?? 0) + 1;
        occurrences.set(key, occurrence);
        entries.push({
          id: `up:${key}#${occurrence}`,
          line,
          raw,
          plain,
          upgrade: upgrade.replaceAll('**', ''),
          examples: parseExamples(examples, line, warnings),
          source,
          note,
        });
        continue;
      }
    }

    if (trimmed === '## 写作自查对照') {
      inSelfChecks = true;
      continue;
    }
    if (inSelfChecks && /^##\s/.test(trimmed)) {
      inSelfChecks = false;
    }
    if (inSelfChecks && raw.trimStart().startsWith('- ')) {
      selfChecks.push({
        id: `sc:${selfChecks.length + 1}`,
        line,
        raw,
        text: raw.trimStart().slice(2).trim(),
      });
    }
  }

  return { entries, selfChecks, warnings };
}

export function parseReviewLibrary(md: string): ReviewParseResult {
  const lines = md.split(/\r\n|\n|\r/);
  const words: ReviewWord[] = [];
  const warnings: VocabWarning[] = [];
  const occurrences = new Map<string, number>();
  const firstLines = new Map<string, number>();
  let inSection = false;
  let inTable = false;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = index + 1;
    const trimmed = raw.trim();

    if (!inSection) {
      if (trimmed === '## 总词库') inSection = true;
      continue;
    }
    if (/^##\s/.test(trimmed)) break;
    if (!inTable) {
      if (trimmed.startsWith('| 单词')) inTable = true;
      continue;
    }
    if (trimmed === '') continue;
    if (!trimmed.startsWith('|')) break;

    const cells = splitRow(raw);
    if (isSeparator(cells)) continue;
    if (cells.length !== 6) {
      warnings.push({ line, kind: 'columns', message: `复习库应有 6 列，实际 ${cells.length} 列，已跳过` });
      continue;
    }

    const [word, issue, addedAt, status, due, note] = cells;
    const key = normalize(word);
    const occurrenceKey = `${key}@${issue}`;
    const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
    occurrences.set(occurrenceKey, occurrence);

    const firstLine = firstLines.get(key);
    if (firstLine === undefined) {
      firstLines.set(key, line);
    } else {
      warnings.push({ line, kind: 'duplicate', message: `单词“${word}”与第 ${firstLine} 行重复，仍保留本行` });
    }

    const levelMatch = /^L([1-4])$/.exec(status);
    if (levelMatch === null && !['🌱待考察', '✅已掌握', '🧊冷库'].includes(status)) {
      warnings.push({ line, kind: 'status', message: `未知状态“${status}”，已保留原值` });
    }

    const entry: ReviewWord = {
      id: `rv:${key}@${issue}#${occurrence}`,
      line,
      raw,
      word,
      issue,
      addedAt,
      status,
      level: levelMatch === null ? null : Number(levelMatch[1]) as 1 | 2 | 3 | 4,
      due: due === '—' ? '' : due,
      note,
    };
    words.push(entry);
  }

  return { words, warnings };
}
