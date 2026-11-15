import React, { useEffect, useRef, useState } from 'react';
import { Download, FileCheck2 } from 'lucide-react';
import { vocabApi } from '../../utils/vocab/api';
import { createExportGate, exportAvailability, type ExportKind } from '../../utils/vocab/export';
import type { VocabExportResult, VocabStats } from '../../utils/vocab/types';

const emptyStats: VocabStats = { upgradeEntries: 0, upgradeExamples: 0, selfChecks: 0, reviewWords: 0, importRuns: 0 };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const label = (kind: ExportKind) => kind === 'upgrade' ? '学术升级库' : '复习库';

export default function ExportPanel({ active }: { active: boolean }) {
  const gateRef = useRef(createExportGate());
  const mountedRef = useRef(true);
  const [stats, setStats] = useState<VocabStats>(emptyStats);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<ExportKind | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState<VocabExportResult | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      gateRef.current.invalidate();
    };
  }, []);

  useEffect(() => {
    if (!active) {
      gateRef.current.invalidate();
      setExporting(null);
      setError('');
      setNotice('');
      setResult(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    vocabApi.stats().then(value => {
      if (!cancelled) setStats(value);
    }).catch(reason => {
      if (!cancelled) setError(`读取词库统计失败：${errorText(reason)}`);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [active]);

  const runExport = async (kind: ExportKind) => {
    const availability = exportAvailability(kind, stats, loading);
    if (availability.disabled || exporting !== null) return;
    const token = gateRef.current.begin();
    if (token === null) return;
    setExporting(kind);
    setError('');
    setNotice('');
    setResult(null);
    try {
      const value = await vocabApi.exportMarkdown(kind);
      if (!mountedRef.current || !gateRef.current.isCurrent(token)) return;
      if (value === null) {
        setNotice('已取消保存，没有写入文件。');
      } else {
        setResult(value);
        setNotice(`已导出 ${value.records} 条${label(kind)}记录${value.selfChecks ? `、${value.selfChecks} 条写作自查` : ''}。`);
      }
    } catch (reason) {
      if (mountedRef.current && gateRef.current.isCurrent(token)) {
        setError(`导出${label(kind)}失败：${errorText(reason)}`);
      }
    } finally {
      gateRef.current.finish(token);
      if (mountedRef.current && gateRef.current.isCurrent(token)) setExporting(null);
    }
  };

  const renderButton = (kind: ExportKind) => {
    const availability = exportAvailability(kind, stats, loading);
    const disabled = availability.disabled || exporting !== null;
    return (
      <div className="rounded-xl border border-line bg-page p-4">
        <button
          type="button"
          disabled={disabled}
          title={availability.reason || `导出${label(kind)}为新的 Markdown 文件`}
          onClick={() => void runExport(kind)}
          className="press inline-flex items-center gap-2 rounded-lg bg-ink px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Download size={16} />{exporting === kind ? '正在导出…' : `导出${label(kind)}`}
        </button>
        <p className="mt-2 text-xs text-mute">
          {availability.reason || (kind === 'upgrade'
            ? `${stats.upgradeEntries} 条升级词，另含 ${stats.selfChecks} 条写作自查`
            : `${stats.reviewWords} 条复习记录；同目录另存词条来源 CSV，记过笔记、存过例句时还会存「我的笔记.md」「我的例句.md」`)}
        </p>
      </div>
    );
  };

  return (
    <section className="rounded-2xl border border-line bg-paper p-5">
      <h2 className="text-lg font-medium text-ink">导出为新的 Markdown</h2>
      <p className="mt-2 text-sm leading-6 text-mute">
        保留已导入的记录行、业务数据和顺序；不还原源文件中未导入的说明、其他章节、空行、换行格式或原行号。已存在的文件不会被覆盖。
      </p>
      <p className="mt-2 text-sm leading-6 text-mute">
        Markdown 是导出给人看的，不支持导入。要换设备并保留笔记、例句和英英释义，请使用「整库搬家」（.wdlib）。
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">{renderButton('upgrade')}{renderButton('review')}</div>
      <div aria-live="polite">
        {notice && <p className="mt-4 text-sm text-success">{notice}</p>}
        {result && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-success/30 bg-success-soft p-3 text-sm text-ink">
            <FileCheck2 className="mt-0.5 shrink-0 text-success" size={17} />
            <div><div>新文件已保存到：</div><div className="mt-1 break-all font-mono text-xs">{result.path}</div></div>
          </div>
        )}
        {result?.sourceCsvPath && (
          <div className="mt-2 rounded-lg border border-success/30 bg-success-soft p-3 text-sm text-ink">
            <div>词条来源与查证 CSV 已保存到：</div>
            <div className="mt-1 break-all font-mono text-xs">{result.sourceCsvPath}</div>
          </div>
        )}
        {result?.notesPath && (
          <div className="mt-2 rounded-lg border border-success/30 bg-success-soft p-3 text-sm text-ink" data-testid="export-notes-path">
            <div>{result.notes} 条笔记已保存到：</div>
            <div className="mt-1 break-all font-mono text-xs">{result.notesPath}</div>
          </div>
        )}
        {result?.examplesPath && (
          <div className="mt-2 rounded-lg border border-success/30 bg-success-soft p-3 text-sm text-ink" data-testid="export-examples-path">
            <div>{result.examples} 句我的例句已保存到：</div>
            <div className="mt-1 break-all font-mono text-xs">{result.examplesPath}</div>
          </div>
        )}
        {result?.definitionsEnPath && (
          <div className="mt-2 rounded-lg border border-success/30 bg-success-soft p-3 text-sm text-ink" data-testid="export-definitions-en-path">
            <div>{result.definitionsEn} 条英英释义已保存到：</div>
            <div className="mt-1 break-all font-mono text-xs">{result.definitionsEnPath}</div>
          </div>
        )}
        {error && <p role="alert" className="mt-4 whitespace-pre-wrap text-sm text-danger">{error}</p>}
      </div>
    </section>
  );
}
