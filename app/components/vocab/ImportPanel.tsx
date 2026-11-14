import React, { useEffect, useRef, useState } from 'react';
import DefinitionImportPanel from './DefinitionImportPanel';
import { FileText, Upload } from 'lucide-react';
import { vocabApi } from '../../utils/vocab/api';
import { parseErrorArchive } from '../../utils/vocab/errors';
import { buildImportPreview, createImportGate } from '../../utils/vocab/import';
import type {
  ErrorArchiveParseResult,
  ErrorImportReport,
  ImportReport,
  SourceSnapshot,
  VocabPreview,
  VocabStats,
  VocabWarning,
} from '../../utils/vocab/types';

type SourceKind = 'upgrade' | 'review';
type Sources = Partial<Record<SourceKind, SourceSnapshot>>;

const emptyStats: VocabStats = {
  upgradeEntries: 0,
  upgradeExamples: 0,
  selfChecks: 0,
  reviewWords: 0,
  importRuns: 0,
};

const sourceLabel = (kind: SourceKind) => kind === 'upgrade' ? '学术升级库' : '复习库';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function Warnings({ title, warnings }: { title: string; warnings: VocabWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="mt-3">
      <h4 className="text-xs font-medium text-ink">{title}警告（{warnings.length}）</h4>
      <ul className="mt-1 space-y-1 text-xs text-mute">
        {warnings.map((warning, index) => (
          <li key={`${warning.line}-${warning.kind}-${index}`}>第 {warning.line} 行：{warning.message}</li>
        ))}
      </ul>
    </div>
  );
}

export default function ImportPanel() {
  const gateRef = useRef(createImportGate());
  const sourcesRef = useRef<Sources>({});
  const mountedRef = useRef(true);
  const [sources, setSources] = useState<Sources>({});
  const [preview, setPreview] = useState<{ token: number; value: VocabPreview } | null>(null);
  const [picking, setPicking] = useState<SourceKind | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [stats, setStats] = useState<VocabStats>(emptyStats);
  const [errorArchive, setErrorArchive] = useState<{ source: SourceSnapshot; value: ErrorArchiveParseResult } | null>(null);
  const [errorPicking, setErrorPicking] = useState(false);
  const [errorImporting, setErrorImporting] = useState(false);
  const [errorReport, setErrorReport] = useState<ErrorImportReport | null>(null);
  const busy = importing || picking !== null || errorPicking || errorImporting;

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    // StrictMode 会先清理再初始化；每次加载都取新标记，不能假定仍是初始值 0。
    const token = gateRef.current.nextSelection();
    vocabApi.stats().then(value => {
      if (!cancelled && gateRef.current.isCurrent(token)) setStats(value);
    }).catch(reason => {
      if (!cancelled && gateRef.current.isCurrent(token)) setError(`读取词库统计失败：${errorText(reason)}`);
    });
    return () => {
      cancelled = true;
      mountedRef.current = false;
      gateRef.current.invalidate();
    };
  }, []);

  const selectFile = async (kind: SourceKind) => {
    const gate = gateRef.current;
    const token = gate.nextSelection();
    const remaining = { ...sourcesRef.current };
    delete remaining[kind];
    sourcesRef.current = remaining;
    setSources(remaining);
    setPreview(null);
    setReport(null);
    setError('');
    setPicking(kind);
    try {
      const picked = await vocabApi.pickMarkdown();
      if (!gate.isCurrent(token) || !mountedRef.current) return;
      if (picked) {
        const next = { ...sourcesRef.current, [kind]: picked };
        sourcesRef.current = next;
        setSources(next);
        if (next.upgrade && next.review) {
          const value = buildImportPreview(next.upgrade, next.review);
          setPreview({ token, value });
          if (value.errors.length === 0) {
            const comparison = await vocabApi.previewImport(value.input);
            if (gate.isCurrent(token) && mountedRef.current) {
              setPreview({
                token,
                value: {
                  ...value,
                  reviewCounts: comparison.reviewWords,
                  errors: [...value.errors, ...comparison.conflicts],
                },
              });
            }
          }
        }
      }
      setPicking(null);
    } catch (reason) {
      if (gate.isCurrent(token) && mountedRef.current) {
        setPreview(null);
        setError(`准备导入预览失败：${errorText(reason)}`);
        setPicking(null);
      }
    }
  };

  const confirmImport = async () => {
    if (!preview || !preview.value.reviewCounts || preview.value.errors.length > 0) return;
    const gate = gateRef.current;
    const { token, value } = preview;
    if (!gate.beginImport(token)) return;
    setImporting(true);
    setError('');
    setReport(null);
    try {
      // 只提交点击时这份 preview 的 input，不重新读取文件或当前选择状态。
      const result = await vocabApi.import(value.input);
      if (gate.isCurrent(token) && mountedRef.current) {
        setReport(result);
        setStats(result.totals);
      }
    } catch (reason) {
      if (gate.isCurrent(token) && mountedRef.current) {
        setError(`导入失败，整批已回滚：${errorText(reason)}`);
      }
    } finally {
      gate.finishImport(token);
      if (gate.isCurrent(token) && mountedRef.current) setImporting(false);
    }
  };

  const selectErrorArchive = async () => {
    setErrorArchive(null);
    setErrorReport(null);
    setError('');
    setErrorPicking(true);
    try {
      const picked = await vocabApi.pickMarkdown();
      if (picked && mountedRef.current) {
        const value = parseErrorArchive(picked.content);
        await vocabApi.previewErrorsImport();
        if (mountedRef.current) setErrorArchive({ source: picked, value });
      }
    } catch (reason) {
      if (mountedRef.current) setError(`准备错误档案预览失败：${errorText(reason)}`);
    } finally {
      if (mountedRef.current) setErrorPicking(false);
    }
  };

  const confirmErrorImport = async () => {
    if (!errorArchive) return;
    const current = errorArchive;
    setErrorImporting(true);
    setErrorReport(null);
    setError('');
    try {
      const result = await vocabApi.importErrors({ source: current.source, ...current.value });
      if (mountedRef.current) {
        setErrorReport(result);
        setStats(result.totals);
      }
    } catch (reason) {
      if (mountedRef.current) setError(`错误档案导入失败，旧数据已保留：${errorText(reason)}`);
    } finally {
      if (mountedRef.current) setErrorImporting(false);
    }
  };

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-line bg-page p-5">
        <h2 className="text-base font-semibold text-ink">1. 选择两份 Markdown</h2>
        <p className="mt-1 text-xs text-mute">开始在软件里复习后，这里是主库，Markdown 只作备份导出。</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {(['upgrade', 'review'] as SourceKind[]).map(kind => (
            <div key={kind} className="rounded-xl border border-line p-4">
              <div className="text-sm font-medium text-ink">{sourceLabel(kind)}</div>
              <div className="mt-1 min-h-5 truncate text-xs text-mute" title={sources[kind]?.fileName}>
                {sources[kind]?.fileName ?? '尚未选择'}
              </div>
              <button
                type="button"
                onClick={() => void selectFile(kind)}
                disabled={busy}
                className="mt-3 rounded-lg border border-line px-3 py-2 text-sm text-ink hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <FileText className="mr-1.5 inline" size={15} />
                {picking === kind ? '读取中…' : sources[kind] ? '重新选择' : '选择文件'}
              </button>
              {sources[kind] && (
                <details className="mt-3 text-xs text-mute">
                  <summary className="cursor-pointer">查看原始 Markdown（纯文本）</summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-page p-3 font-mono text-[11px] text-ink">{sources[kind]?.content}</pre>
                </details>
              )}
            </div>
          ))}
        </div>
        {(!sources.upgrade || !sources.review) && !picking && (
          <p className="mt-4 text-xs text-mute">取消选择不会写库；两份文件都就绪后才会生成预览。</p>
        )}
      </section>

      <DefinitionImportPanel />

      <section className="rounded-2xl border border-line bg-page p-5">
        <h2 className="text-base font-semibold text-ink">错误档案（单独导入）</h2>
        <p className="mt-1 text-xs text-mute">导入高频错误、错误批次与明细、待巩固清单和作文索引；确认后整体替换旧错误档案。</p>
        <button
          type="button"
          onClick={() => void selectErrorArchive()}
          disabled={busy}
          className="mt-3 rounded-lg border border-line px-3 py-2 text-sm text-ink hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FileText className="mr-1.5 inline" size={15} />
          {errorPicking ? '读取中…' : errorArchive ? '重新选择错误档案' : '选择错误档案'}
        </button>
        {errorArchive && (
          <div className="mt-4">
            <div className="text-sm text-ink">{errorArchive.source.fileName}</div>
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
              {[
                ['高频错误', errorArchive.value.top.length],
                ['错误批次', errorArchive.value.batches.length],
                ['错误明细', errorArchive.value.items.length],
                ['待巩固', errorArchive.value.todos.length],
                ['作文索引', errorArchive.value.essays.length],
              ].map(([label, count]) => (
                <div key={label} className="rounded-xl bg-page p-3">
                  <div className="text-xs text-mute">{label}</div>
                  <div className="mt-1 text-xl font-semibold tabular-nums text-ink">{count}</div>
                </div>
              ))}
            </div>
            <Warnings title="错误档案" warnings={errorArchive.value.warnings} />
            <details className="mt-3 text-xs text-mute">
              <summary className="cursor-pointer">查看原始 Markdown（纯文本）</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-page p-3 font-mono text-[11px] text-ink">{errorArchive.source.content}</pre>
            </details>
            <button
              type="button"
              onClick={() => void confirmErrorImport()}
              disabled={busy}
              className="press mt-4 rounded-full bg-ink px-5 py-2.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Upload className="mr-1.5 inline" size={16} />
              {errorImporting ? '正在导入…' : '确认整体替换错误档案'}
            </button>
          </div>
        )}
        {errorReport && (
          <div className="mt-4 rounded-xl border border-success/30 bg-success-soft p-4 text-sm text-ink">
            导入成功：高频错误 {errorReport.top}，批次 {errorReport.batches}，错误明细 {errorReport.items}，待巩固 {errorReport.todos}，作文索引 {errorReport.essays}。
          </div>
        )}
      </section>

      {preview && (
        <section className="rounded-2xl border border-line bg-page p-5">
          <h2 className="text-base font-semibold text-ink">2. 检查预览</h2>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              ['升级词条', preview.value.counts.upgradeEntries],
              ['升级例句', preview.value.counts.upgradeExamples],
              ['写作自查', preview.value.counts.selfChecks],
              ['复习词条', preview.value.counts.reviewWords],
            ].map(([label, count]) => (
              <div key={label} className="rounded-xl bg-page p-3">
                <div className="text-xs text-mute">{label}</div>
                <div className="mt-1 text-xl font-semibold tabular-nums text-ink">{count}</div>
              </div>
            ))}
          </div>
          <div className="mt-4" data-testid="review-preview-counts">
            <h3 className="text-sm font-medium text-ink">复习词条与主库对比</h3>
            <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
              {[
                ['新增', preview.value.reviewCounts?.added],
                ['更新', preview.value.reviewCounts?.updated],
                ['跳过', preview.value.reviewCounts?.skipped],
                ['冲突', preview.value.reviewCounts?.conflicts],
              ].map(([label, count]) => (
                <div key={label} className="rounded-xl bg-page p-3" data-count={label}>
                  <div className="text-xs text-mute">{label}</div>
                  <div className="mt-1 text-xl font-semibold tabular-nums text-ink">{count ?? '—'}</div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-mute">
              {preview.value.errors.length > 0
                ? '请先修正上面的阻断问题。'
                : preview.value.reviewCounts
                  ? '有复习记录的词若与文件状态不同，会保留软件状态并计入跳过。'
                  : '正在核对主库；核对完成后才能确认导入。'}
            </p>
          </div>
          {preview.value.errors.length > 0 ? (
            <div className="mt-4 rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm text-danger">
              <div className="font-medium">发现阻断问题，不能导入：</div>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {preview.value.errors.map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}
              </ul>
            </div>
          ) : (
            <p className="mt-4 text-sm text-success">校验通过。重复词和无法拆分的例句只作警告，原文会保留。</p>
          )}
          <Warnings title="升级库" warnings={preview.value.warnings.upgrade} />
          <Warnings title="复习库" warnings={preview.value.warnings.review} />
          <button
            type="button"
            onClick={() => void confirmImport()}
            disabled={busy || !preview.value.reviewCounts || preview.value.errors.length > 0}
            className="press mt-5 rounded-full bg-ink px-5 py-2.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Upload className="mr-1.5 inline" size={16} />
            {importing ? '正在导入…' : '确认导入当前预览'}
          </button>
        </section>
      )}

      {error && <div role="alert" className="rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm text-danger">{error}</div>}

      {report && (
        <section className="rounded-2xl border border-success/30 bg-success-soft p-5 text-sm text-ink">
          <h2 className="font-semibold">导入成功</h2>
          <div className="mt-3 grid gap-2 md:grid-cols-3">
            <div>升级词条：新增 {report.upgradeEntries.added}，跳过 {report.upgradeEntries.skipped}</div>
            <div>写作自查：新增 {report.selfChecks.added}，跳过 {report.selfChecks.skipped}</div>
            <div data-testid="review-import-result">复习词条：新增 {report.reviewWords.added}，更新 {report.reviewWords.updated}，跳过 {report.reviewWords.skipped}，冲突 {report.reviewWords.conflicts}</div>
          </div>
          <p className="mt-2">新增例句 {report.upgradeExamplesAdded} 条。相同 ID 且内容一致的记录保留数据库原值；已复习的词以软件为准。</p>
        </section>
      )}

      <section className="rounded-2xl border border-line bg-page p-5">
        <h2 className="text-base font-semibold text-ink">库内统计</h2>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-mute">
          <span>升级词条 <strong className="text-ink">{stats.upgradeEntries}</strong></span>
          <span>例句 <strong className="text-ink">{stats.upgradeExamples}</strong></span>
          <span>写作自查 <strong className="text-ink">{stats.selfChecks}</strong></span>
          <span>复习词条 <strong className="text-ink">{stats.reviewWords}</strong></span>
          <span>导入日志 <strong className="text-ink">{stats.importRuns}</strong></span>
        </div>
      </section>
    </div>
  );
}
