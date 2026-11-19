import React, { useEffect, useState } from 'react';
import { IS_MOBILE } from '../../utils/platform';
import { ArrowRight, BookOpen, Check, Copy, FileText, Link2, NotebookPen, Quote, Scale, TrendingUp } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { vocabApi } from '../../utils/vocab/api';
import { VERIFICATION_STATUSES } from '../../utils/vocab/types';
import type { BrowseSelfCheck, ReviewMetadataResult, VerificationStatus } from '../../utils/vocab/types';
import NotesSection from './NotesSection';
import type { NoteHandlers } from './NotesSection';
import ExamplesSection, { useMyExamples } from './ExamplesSection';
import type { ExampleHandlers } from './ExamplesSection';
import { ExtraDefinitionsEn, MyDefinitionsEn, useMyDefinitions } from './DefinitionsEn';
type DefinitionsEnData = ReturnType<typeof useMyDefinitions>;
import { definitionKey } from '../../utils/vocab/definitionEn';
import VoiceButton from './VoiceButton';
import { registerNoteSource } from '../../utils/quicknote/context';
import { useAiContextWord } from '../ai/panelState';
import { exampleKey, sensesFrom } from '../../utils/vocab/examples';
import type { VocabExample } from '../../utils/vocab/types';
import {
  highlightParts,
  notesForWord,
  realExamplesFirst,
  splitNote,
  statusGroup,
  statusText,
  upgradesForWord,
  wordForCandidate,
} from '../../utils/vocab/library';
import type { Library, UpgradeGroup, WordGroup } from '../../utils/vocab/library';
import type { ReviewCard } from '../../utils/review';
import ListeningWordDetail, { ListeningWordSections } from './ListeningWordDetail';

// 所有内容都按纯文本节点渲染（React 自动转义），不使用 dangerouslySetInnerHTML。

export type Selection = { kind: 'word' | 'listening' | 'upgrade' | 'selfCheck'; id: string };

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** 命中的部分用 <mark> 高亮；文本仍是纯文本节点。 */
export function Hl({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, index) => part.hit
        ? <mark key={index} className="vocab-mark">{part.text}</mark>
        : <React.Fragment key={index}>{part.text}</React.Fragment>)}
    </>
  );
}

const STATUS_CLASS: Record<string, string> = {
  // 只用上游的浅色色板：复习中用唯一的强调色，其余用灰阶区分。
  seed: 'border-line bg-shade text-mute',
  learning: 'border-accent/30 bg-accent-soft text-accent',
  mastered: 'border-ink/20 bg-page text-ink',
  cold: 'border-line bg-page text-faint',
  other: 'border-line bg-page text-mute',
};

export function StatusChip({ status, due }: { status: string; due: string }) {
  return (
    <span className={`vocab-chip ${STATUS_CLASS[statusGroup(status)]}`} data-testid="status-chip">
      {statusText({ status, due })}
    </span>
  );
}

function AiBadge({ ai }: { ai: boolean }) {
  return ai
    ? <span className="vocab-chip border-clay/30 bg-clay-soft text-clay" title="AI 起草，待用真语料或词典核实">AI 草稿·待核实</span>
    : <span className="vocab-chip border-line bg-page text-mute">笔记原句</span>;
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      window.setTimeout(() => setDone(false), 1200);
    } catch {
      setDone(false);
    }
  };
  return (
    <button type="button" onClick={copy} title={`复制 ${text}`} aria-label={`复制 ${text}`} className="press shrink-0 rounded-lg border border-line p-1.5 text-mute hover:text-ink">
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

/** 每节：小图标 + 标题；main = 最重要的一节（带白卡片），其余用细线分隔。 */
function Section({ title, children, testId, icon: Icon, main = false }: { title: string; children: React.ReactNode; testId?: string; icon?: LucideIcon; main?: boolean }) {
  return (
    <section className="vocab-section" data-tone={main ? 'main' : 'light'} data-testid={testId}>
      <h4 className="vocab-section-title">
        {Icon && <Icon size={15} className="shrink-0" aria-hidden />}
        <span className="min-w-0">{title}</span>
      </h4>
      {children}
    </section>
  );
}

/** 到期日距今天几天（负数 = 逾期）；日期格式不对返回 null。按本机日期算。 */
function daysUntil(due: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due.trim());
  if (!match) return null;
  const target = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

/** 学习进度：L1–L5 五个点 + 到期提示（逾期用警示色）。 */
function ProgressMeter({ status, due }: { status: string; due: string }) {
  const level = /^L([1-5])$/.exec(status.trim());
  const days = daysUntil(due);
  let dueNode: React.ReactNode = null;
  if (days !== null) {
    const date = due.trim().slice(5);
    if (days < 0) dueNode = <span className="vocab-chip border-danger/30 bg-danger-soft text-danger" data-testid="due-overdue">逾期 {-days} 天 · {date}</span>;
    else if (days === 0) dueNode = <span className="vocab-chip border-clay/30 bg-clay-soft text-clay" data-testid="due-today">今天到期</span>;
    else dueNode = <span className="vocab-chip border-line bg-page text-mute" data-testid="due-future">{days} 天后到期 · {date}</span>;
  }
  if (!level && !dueNode) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {level && (
        <span className="inline-flex items-center gap-1" role="img" aria-label={`第 ${level[1]} 级，共 5 级`} data-testid="level-dots">
          {[1, 2, 3, 4, 5].map(n => <span key={n} className="vocab-dot" data-on={n <= Number(level[1])} />)}
        </span>
      )}
      {dueNode}
    </div>
  );
}

function Example({ sentence, ai, query, testId }: { sentence: string; ai: boolean; query: string; testId?: string }) {
  return (
    <li className="vocab-example" data-testid={testId}>
      <div className="flex min-w-0 items-start gap-1">
        <p className="vocab-wrap min-w-0 flex-1 font-serif text-base leading-relaxed text-ink"><Hl text={sentence} query={query} /></p>
        <VoiceButton text={sentence} kind="sentence" />
      </div>
      <div className="mt-1"><AiBadge ai={ai} /></div>
    </li>
  );
}

function Warnings({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-1.5" data-testid="usage-warnings">
      {items.map((text, index) => (
        <li key={index} className="vocab-wrap rounded-lg border border-clay/30 bg-clay-soft px-3 py-2 text-sm text-ink">{text}</li>
      ))}
    </ul>
  );
}

function Raw({ raw, line, id }: { raw: string; line: number; id: string }) {
  return (
    <div className="mt-2">
      <div className="text-[11px] text-mute">第 {line} 行 · ID {id}</div>
      <pre className="vocab-wrap mt-1 whitespace-pre-wrap rounded-lg bg-shade p-2.5 font-mono text-[11px] text-ink">{raw}</pre>
    </div>
  );
}

// ---------- 来源与查证（沿用 025 的保存接口） ----------

function MetadataForm({ group, onSaved }: { group: WordGroup; onSaved: (result: ReviewMetadataResult) => void }) {
  const [entryId, setEntryId] = useState(group.latest.id);
  const entry = group.entries.find(item => item.id === entryId) ?? group.latest;
  const [source, setSource] = useState(entry.source);
  const [verificationStatus, setVerificationStatus] = useState<VerificationStatus>(entry.verificationStatus);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => { setEntryId(group.latest.id); }, [group.key]);
  useEffect(() => {
    setSource(entry.source);
    setVerificationStatus(entry.verificationStatus);
    setError('');
    setNotice('');
  }, [entry.id]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const result = await vocabApi.updateReviewMetadata({ id: entry.id, source, verificationStatus });
      onSaved(result);
      setNotice('来源和查证状态已保存。');
    } catch (reason) {
      setError(`保存失败：${errorText(reason)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="rounded-xl border border-line bg-shade p-3" onSubmit={save} data-testid="review-metadata-form">
      {group.entries.length > 1 && (
        <>
          <label className="block text-xs text-mute" htmlFor="review-entry">哪一期的记录</label>
          <select id="review-entry" value={entry.id} onChange={event => setEntryId(event.target.value)} className="mt-1 w-full min-w-0 rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink">
            {group.entries.map(item => <option key={item.id} value={item.id}>{item.issue} 期</option>)}
          </select>
        </>
      )}
      <label className={`${group.entries.length > 1 ? 'mt-3' : ''} block text-xs text-mute`} htmlFor="review-source">来源</label>
      <input
        id="review-source"
        data-testid="review-source"
        type="text"
        value={source}
        onChange={event => { setSource(event.target.value); setNotice(''); }}
        placeholder="例如：Hermes 词库、课堂笔记"
        className="mt-1 w-full min-w-0 rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink"
      />
      <label className="mt-3 block text-xs text-mute" htmlFor="review-verification-status">查证状态</label>
      <select
        id="review-verification-status"
        data-testid="review-verification-status"
        value={verificationStatus}
        onChange={event => { setVerificationStatus(event.target.value as VerificationStatus); setNotice(''); }}
        className="mt-1 w-full min-w-0 rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink"
      >
        {VERIFICATION_STATUSES.map(status => <option key={status} value={status}>{status}</option>)}
      </select>
      <button
        type="submit"
        data-testid="review-metadata-save"
        disabled={saving || (source === entry.source && verificationStatus === entry.verificationStatus)}
        className="press mt-3 rounded-lg bg-ink px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-45"
      >
        {saving ? '正在保存…' : '保存来源与查证状态'}
      </button>
      <div aria-live="polite">
        {notice && <p className="mt-2 text-xs text-success" data-testid="review-metadata-notice">{notice}</p>}
        {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      </div>
    </form>
  );
}

// ---------- 复习词详情 ----------

/** 043：详情页里的「我的例句」用到的数据（EntryDetail 自己读，不用调用方传）。 */
interface ExamplesData { byKey: Map<string, VocabExample[]>; handlers: ExampleHandlers; error: string }

function WordDetail({ group, library, query, onOpen, onSaved, noteHandlers, examples, definitionsEn }: {
  group: WordGroup;
  library: Library;
  query: string;
  onOpen: (selection: Selection) => void;
  onSaved: (result: ReviewMetadataResult) => void;
  noteHandlers: NoteHandlers;
  examples: ExamplesData;
  definitionsEn: DefinitionsEnData;
}) {
  const myExamples = examples.byKey.get(exampleKey(group.word)) ?? [];
  const myDefinitions = definitionsEn.byKey.get(definitionKey(group.word)) ?? [];
  const myNotes = notesForWord(library, group.word);
  const related = upgradesForWord(library, group.word);
  const notes = group.entries.map(entry => ({ entry, parts: splitNote(entry.note) }));
  const warnings = [...new Set(notes.flatMap(n => n.parts.warnings))];
  const noteLines = [...new Set(notes.flatMap(n => n.parts.notes))];
  const unverified = group.entries.every(entry => entry.verificationStatus === '未查证');

  return (
    <article data-testid="word-detail">
      <header className="vocab-hero">
        <h3 className="vocab-wrap vocab-headword min-w-0" data-testid="detail-headword">{group.word}</h3>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-2">
          {group.pos.map(pos => <span key={pos} className="vocab-chip border-ink/15 bg-page text-mute italic">{pos}</span>)}
          <StatusChip status={group.latest.status} due={group.latest.due} />
          {unverified && <span className="vocab-chip border-clay/30 bg-clay-soft text-clay" title="还没有用词典或语料核对过">未查证</span>}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <VoiceButton text={group.word} kind="word" />
            <CopyButton text={group.word} />
          </span>
        </div>
      </header>

      <Section title="意思" testId="review-definitions" icon={BookOpen} main>
        <MyDefinitionsEn word={group.word} stored={myDefinitions} />
        {group.definitions.length === 0 ? (
          <div>
            {group.gloss
              ? <p className="vocab-wrap text-xl font-semibold leading-snug text-ink" data-testid="detail-gloss">{group.gloss}</p>
              : <p className="text-sm text-mute">笔记里没有写意思。</p>}
          </div>
        ) : (
          <ol className="space-y-4">
            {group.definitions.map((definition, index) => (
              <li key={`${definition.sourceFile}-${definition.sourceLine}-${index}`} className="vocab-sense">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  {group.definitions.length > 1 && <span className="text-sm font-semibold text-accent">{index + 1}.</span>}
                  <span className="vocab-chip border-ink/15 bg-shade text-mute italic" data-testid="definition-pos">{definition.pos || '未标词性'}</span>
                </div>
                {definition.chinese && <p className="vocab-wrap mt-1.5 text-xl font-semibold leading-snug text-ink"><Hl text={definition.chinese} query={query} /></p>}
                {definition.english && <p className="vocab-wrap mt-1 font-serif text-base leading-relaxed text-mute"><Hl text={definition.english} query={query} /></p>}
                {definition.examples.length > 0 && (
                  <ul className="mt-2 space-y-2">
                    {realExamplesFirst(definition.examples).map(example => (
                      <Example key={example.seq} sentence={example.sentence} ai={example.ai} query={query} testId="definition-example" />
                    ))}
                  </ul>
                )}
                <div className="mt-1.5 text-[11px] text-mute">出自 {definition.sourceFile} 第 {definition.sourceLine} 行</div>
              </li>
            ))}
          </ol>
        )}
        <ExtraDefinitionsEn word={group.word} stored={myDefinitions} imported={group.definitions.map(d => ({ pos: d.pos, english: d.english }))} loaded={definitionsEn.loaded} />
      </Section>

      {(warnings.length > 0 || related.length > 0) && (
        <Section title="用法与辨析" testId="usage-section" icon={Scale}>
          <Warnings items={warnings} />
          {related.map(upgrade => {
            const self = upgrade.candidates.find(c => c.name.toLowerCase() === group.word.toLowerCase());
            return (
              <div key={upgrade.item.id} className="mt-2 rounded-xl border border-line p-3" data-testid="related-upgrade">
                <div className="vocab-wrap text-xs text-mute">想说「{upgrade.item.plain}」时可选：</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {upgrade.candidates.map(c => (
                    <span key={c.name} className={`vocab-pill vocab-wrap ${c === self ? 'vocab-pill-on' : ''}`} data-current={c === self}>
                      {c.name}
                      {c.preferred && <span className="vocab-pill-tag">首选</span>}
                    </span>
                  ))}
                </div>
                {self?.usage && <p className="vocab-wrap mt-2 text-sm text-ink"><span className="font-medium text-accent">这个词：</span>{self.usage}</p>}
                <button type="button" onClick={() => onOpen({ kind: 'upgrade', id: upgrade.item.id })} className="press mt-2 inline-flex min-h-8 items-center gap-1 rounded-lg px-1 text-sm font-medium text-accent hover:underline">
                  看整组对照<ArrowRight size={14} />
                </button>
              </div>
            );
          })}
        </Section>
      )}

      <Section title={myExamples.length > 0 ? `我的例句（${myExamples.length}）` : '我的例句'} testId="examples-section" icon={Quote}>
        {examples.error && <p role="alert" className="mb-2 text-xs text-danger">{examples.error}</p>}
        <ExamplesSection
          key={group.key}
          word={group.word}
          examples={myExamples}
          // 没导入释义时只给词性：gloss 可能取自表格备注，备注不发给模型。
          senses={sensesFrom(group.definitions, { pos: group.pos[0] })}
          handlers={examples.handlers}
        />
      </Section>

      <Section title={myNotes.length > 0 ? `我的笔记（${myNotes.length}）` : '我的笔记'} testId="notes-section" icon={NotebookPen}>
        <NotesSection word={group.word} notes={myNotes} handlers={noteHandlers} />
      </Section>

      {noteLines.length > 0 && (
        <Section title="表格里的备注" icon={FileText}>
          <ul className="vocab-bullets">
            {noteLines.map((text, index) => <li key={index} className="vocab-wrap"><Hl text={text} query={query} /></li>)}
          </ul>
        </Section>
      )}

      <Section title="学习进度" testId="progress-section" icon={TrendingUp}>
        <ul className="space-y-2">
          {notes.map(({ entry, parts }) => (
            <li key={entry.id} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-medium text-ink">{entry.issue} 期</span>
                <StatusChip status={entry.status} due={entry.due} />
                <span className="text-xs text-mute">入库 {entry.addedAt || '—'}</span>
              </div>
              <ProgressMeter status={entry.status} due={entry.due} />
              {parts.history.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs text-mute">
                  {parts.history.map((text, index) => <li key={index} className="vocab-wrap">{text}</li>)}
                </ul>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-mute">复习只在「今日到期」里进行；这里只看进度，不改状态。</p>
      </Section>

      <Section title="来源与查证" icon={Link2}>
        <MetadataForm group={group} onSaved={onSaved} />
      </Section>

      <details className="vocab-section text-xs text-mute">
        <summary className="cursor-pointer">原始记录（纯文本）</summary>
        {group.entries.map(entry => <Raw key={entry.id} raw={entry.raw} line={entry.line} id={entry.id} />)}
      </details>
    </article>
  );
}

// ---------- 学术升级详情 ----------

function UpgradeDetail({ group, library, query, onOpen, noteHandlers, examples }: {
  group: UpgradeGroup;
  library: Library;
  query: string;
  onOpen: (selection: Selection) => void;
  noteHandlers: NoteHandlers;
  examples: ExamplesData;
}) {
  const { item } = group;
  const note = splitNote(item.note);
  return (
    <article data-testid="upgrade-detail">
      <header className="vocab-hero">
        <div className="text-xs text-mute">想表达</div>
        <h3 className="vocab-wrap vocab-headword" data-testid="detail-headword">{item.plain}</h3>
        <p className="mt-1 text-xs text-mute">候选按原文顺序排列，首选在前。先看用法再挑词。</p>
      </header>

      <Section title={`可选的词（${group.candidates.length}）`} testId="upgrade-candidates">
        <ol className="space-y-3">
          {group.candidates.map(candidate => {
            const word = wordForCandidate(library, candidate.name);
            const candidateNotes = notesForWord(library, candidate.name);
            const candidateExamples = examples.byKey.get(exampleKey(candidate.name)) ?? [];
            return (
              <li key={candidate.name} className={`rounded-xl border p-3 ${candidate.preferred ? 'border-ink/40' : 'border-line'}`} data-testid="upgrade-candidate">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="vocab-wrap min-w-0 text-lg font-semibold text-ink"><Hl text={candidate.name} query={query} /></span>
                  {candidate.preferred && <span className="vocab-chip border-ink bg-ink text-white">首选</span>}
                  {word && (
                    <button type="button" onClick={() => onOpen({ kind: 'word', id: word.key })} className="press vocab-chip inline-flex items-center gap-1 border-line bg-page text-ink hover:border-ink/40" title="在复习库里打开这个词">
                      复习库：{statusText(word.latest)}<ArrowRight size={11} />
                    </button>
                  )}
                </div>
                {candidate.usage && <p className="vocab-wrap mt-1.5 rounded-lg bg-shade px-2.5 py-1.5 text-sm text-ink"><Hl text={candidate.usage} query={query} /></p>}
                {candidate.examples.length > 0 && (
                  <ul className="mt-2 space-y-2">
                    {realExamplesFirst(candidate.examples).map(example => (
                      <Example key={example.seq} sentence={example.sentence} ai={example.ai} query={query} testId="upgrade-example" />
                    ))}
                  </ul>
                )}
                {/* 040：和复习库里同一个词共用一组笔记。 */}
                <details className="vocab-candidate-notes mt-2" open={candidateNotes.length > 0} data-testid="candidate-notes">
                  <summary className="text-xs text-mute hover:text-ink">我的笔记{candidateNotes.length > 0 ? `（${candidateNotes.length}）` : '：还没有，点开记一条'}</summary>
                  <div className="mt-2"><NotesSection word={candidate.name} notes={candidateNotes} handlers={noteHandlers} /></div>
                </details>
                {/* 043：和复习库里同一个词共用一组例句；意思优先用复习库里导入的释义，没有就用这组想表达的意思（不发备注）。 */}
                <details className="vocab-candidate-notes mt-2" open={candidateExamples.length > 0} data-testid="candidate-examples">
                  <summary className="text-xs text-mute hover:text-ink">我的例句{candidateExamples.length > 0 ? `（${candidateExamples.length}）` : '：还没有，点开让 AI 给或自己写'}</summary>
                  <div className="mt-2">
                    <ExamplesSection
                      word={candidate.name}
                      examples={candidateExamples}
                      senses={sensesFrom(word?.definitions ?? [], { pos: word?.pos[0], gloss: item.plain })}
                      handlers={examples.handlers}
                      compact
                    />
                  </div>
                </details>
              </li>
            );
          })}
        </ol>
      </Section>

      {(note.warnings.length > 0 || note.notes.length > 0 || note.history.length > 0) && (
        <Section title="注意">
          <Warnings items={note.warnings} />
          {(note.notes.length > 0 || note.history.length > 0) && (
            <ul className="vocab-bullets mt-2">
              {[...note.notes, ...note.history].map((text, index) => <li key={index} className="vocab-wrap"><Hl text={text} query={query} /></li>)}
            </ul>
          )}
        </Section>
      )}

      <Section title="出处与原文">
        <p className="vocab-wrap text-sm text-ink">{item.source || '（未写出处）'}</p>
        <p className="vocab-wrap mt-1.5 text-xs text-mute">升级表达原文：{item.upgrade.replace(/\*\*/g, '')}</p>
        <details className="mt-2 text-xs text-mute">
          <summary className="cursor-pointer">原始行（纯文本）</summary>
          <Raw raw={item.raw} line={item.line} id={item.id} />
        </details>
      </Section>
    </article>
  );
}

function SelfCheckDetail({ item, query }: { item: BrowseSelfCheck; query: string }) {
  return (
    <article data-testid="selfcheck-detail">
      <div className="text-xs text-mute">写作自查</div>
      <p className="vocab-wrap mt-2 text-base leading-relaxed text-ink"><Hl text={item.text} query={query} /></p>
      <details className="vocab-section text-xs text-mute">
        <summary className="cursor-pointer">原始行（纯文本）</summary>
        <Raw raw={item.raw} line={item.line} id={item.id} />
      </details>
    </article>
  );
}

export default function EntryDetail({ selection, library, query, onOpen, onReviewMetadataSaved, noteHandlers, listeningByKey = new Map() }: {
  selection: Selection | null;
  library: Library;
  query: string;
  onOpen: (selection: Selection) => void;
  onReviewMetadataSaved: (result: ReviewMetadataResult) => void;
  noteHandlers: NoteHandlers;
  listeningByKey?: Map<string, { word: string; cards: ReviewCard[] }>;
}) {
  const examples = useMyExamples();
  const definitionsEn = useMyDefinitions();
  // 055 随手记：详情开着时，Ctrl+J 记下的上下文就是这个词条。
  const shown = selection?.kind === 'word' ? library.wordByKey.get(selection.id) : selection?.kind === 'listening' ? listeningByKey.get(selection.id) : undefined;
  const noteWord = shown?.word;
  const noteEntryId = shown ? selection?.id : undefined;
  useAiContextWord(noteWord); // 091 AI 小窗直接问时带上当前词
  useEffect(() => {
    if (!noteWord) return undefined;
    return registerNoteSource({ snapshot: () => ({ kind: 'entry', entryId: noteEntryId, word: noteWord }) });
  }, [noteWord, noteEntryId]);
  let body: React.ReactNode = null;
  if (selection?.kind === 'word') {
    const group = library.wordByKey.get(selection.id);
    if (group) body = <>
      <WordDetail key={group.key} group={group} library={library} query={query} onOpen={onOpen} onSaved={onReviewMetadataSaved} noteHandlers={noteHandlers} examples={examples} definitionsEn={definitionsEn} />
      <ListeningWordSections cards={listeningByKey.get(group.key)?.cards ?? []} />
    </>;
  } else if (selection?.kind === 'listening') {
    const item = listeningByKey.get(selection.id);
    if (item) body = <ListeningWordDetail word={item.word} cards={item.cards} />;
  } else if (selection?.kind === 'upgrade') {
    const group = library.upgradeById.get(selection.id);
    if (group) body = <UpgradeDetail group={group} library={library} query={query} onOpen={onOpen} noteHandlers={noteHandlers} examples={examples} />;
  } else if (selection?.kind === 'selfCheck') {
    const item = library.selfChecks.find(row => row.id === selection.id);
    if (item) body = <SelfCheckDetail item={item} query={query} />;
  }
  if (!body) {
    return (
      <div className="text-sm text-mute" data-testid="vocab-detail-empty">
        <p className="font-medium text-ink">点一条看完整内容</p>
        <p className="mt-2">词：意思、例句、用法辨析、我的例句、我的笔记、学到哪了。</p>
        <p className="mt-1">升级对照：想表达一个意思时有哪些词可选，各自怎么用。</p>
      </div>
    );
  }
  return <div data-testid="vocab-detail" data-kind={selection?.kind}>{body}</div>;
}
