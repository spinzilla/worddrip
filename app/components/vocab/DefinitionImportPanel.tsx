import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, FileText, Upload } from 'lucide-react';
import { vocabApi } from '../../utils/vocab/api';
import type { DefinitionImportReport, SourceSnapshot } from '../../utils/vocab/types';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function DefinitionImportPanel() {
  const revisionRef = useRef(0);
  const mountedRef = useRef(true);
  const [issues, setIssues] = useState<SourceSnapshot[]>([]);
  const [eagp, setEagp] = useState<SourceSnapshot | null>(null);
  const [preview, setPreview] = useState<DefinitionImportReport | null>(null);
  const [report, setReport] = useState<DefinitionImportReport | null>(null);
  const [picking, setPicking] = useState<'issues' | 'eagp' | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const busy = picking !== null || previewing || importing;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      revisionRef.current += 1;
    };
  }, []);

  const makePreview = async (nextIssues: SourceSnapshot[], nextEagp: SourceSnapshot | null) => {
    const revision = ++revisionRef.current;
    setPreview(null);
    setReport(null);
    setError('');
    if (nextIssues.length === 0) return;
    setPreviewing(true);
    try {
      const value = await vocabApi.previewDefinitions({ issues: nextIssues, eagp: nextEagp });
      if (mountedRef.current && revision === revisionRef.current) setPreview(value);
    } catch (reason) {
      if (mountedRef.current && revision === revisionRef.current) setError(`释义预览失败：${errorText(reason)}`);
    } finally {
      if (mountedRef.current && revision === revisionRef.current) setPreviewing(false);
    }
  };

  const chooseIssues = async () => {
    setPicking('issues');
    setError('');
    try {
      const picked = await vocabApi.pickMarkdowns();
      if (!mountedRef.current || picked.length === 0) return;
      setIssues(picked);
      await makePreview(picked, eagp);
    } catch (reason) {
      if (mountedRef.current) setError(`读取期文件失败：${errorText(reason)}`);
    } finally {
      if (mountedRef.current) setPicking(null);
    }
  };

  const chooseEagp = async () => {
    setPicking('eagp');
    setError('');
    try {
      const picked = await vocabApi.pickMarkdown();
      if (!mountedRef.current || !picked) return;
      setEagp(picked);
      await makePreview(issues, picked);
    } catch (reason) {
      if (mountedRef.current) setError(`读取 EAGP 词表失败：${errorText(reason)}`);
    } finally {
      if (mountedRef.current) setPicking(null);
    }
  };

  const clearEagp = async () => {
    setEagp(null);
    await makePreview(issues, null);
  };

  const confirm = async () => {
    if (!preview || preview.added === 0 || importing) return;
    setImporting(true);
    setError('');
    setReport(null);
    try {
      const result = await vocabApi.importDefinitions({ issues, eagp });
      if (!mountedRef.current) return;
      setReport(result);
      setPreview(null);
    } catch (reason) {
      if (mountedRef.current) setError(`释义导入失败，整批已回滚：${errorText(reason)}`);
    } finally {
      if (mountedRef.current) setImporting(false);
    }
  };

  return (
    <section className="rounded-2xl border border-line bg-page p-5" data-testid="definition-import-panel">
      <h2 className="text-base font-semibold text-ink">导入释义</h2>
      <p className="mt-1 text-xs text-mute">期文件可多选；EAGP 词表可选，只给还没有释义的词兜底。先看预览，确认后只写释义和例句。</p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-line p-4">
          <div className="text-sm font-medium text-ink">期文件（可多选）</div>
          <div className="mt-1 text-xs text-mute">{issues.length > 0 ? `已选 ${issues.length} 份` : '尚未选择'}</div>
          {issues.length > 0 && (
            <ul className="mt-2 max-h-24 space-y-1 overflow-auto text-xs text-mute">
              {issues.map(file => <li key={file.fileName} className="vocab-wrap">{file.fileName}</li>)}
            </ul>
          )}
          <button type="button" data-testid="definition-choose-issues" onClick={() => void chooseIssues()} disabled={busy} className="mt-3 rounded-lg border border-line px-3 py-2 text-sm text-ink hover:border-ink/30 disabled:opacity-50">
            <FileText className="mr-1.5 inline" size={15} />{picking === 'issues' ? '读取中…' : issues.length > 0 ? '重新选择期文件' : '选择期文件'}
          </button>
        </div>
        <div className="rounded-xl border border-line p-4">
          <div className="text-sm font-medium text-ink">EAGP 词表（可选）</div>
          <div className="vocab-wrap mt-1 min-h-5 text-xs text-mute">{eagp?.fileName ?? '尚未选择'}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" data-testid="definition-choose-eagp" onClick={() => void chooseEagp()} disabled={busy} className="rounded-lg border border-line px-3 py-2 text-sm text-ink hover:border-ink/30 disabled:opacity-50">
              <FileText className="mr-1.5 inline" size={15} />{picking === 'eagp' ? '读取中…' : eagp ? '重新选择 EAGP' : '选择 EAGP 词表'}
            </button>
            {eagp && <button type="button" onClick={() => void clearEagp()} disabled={busy} className="rounded-lg px-3 py-2 text-sm text-mute hover:text-ink">移除</button>}
          </div>
        </div>
      </div>
      {issues.length > 0 && (
        <button type="button" data-testid="definition-preview" onClick={() => void makePreview(issues, eagp)} disabled={busy} className="press mt-4 rounded-lg border border-line px-4 py-2 text-sm text-ink disabled:opacity-50">
          <BookOpen className="mr-1.5 inline" size={15} />{previewing ? '正在匹配…' : '刷新释义预览'}
        </button>
      )}

      {preview && (
        <div className="mt-4 rounded-xl bg-page p-4" data-testid="definition-preview-result">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {[
              ['匹配', preview.matched],
              ['未匹配', preview.unmatched],
              ['跳过', preview.skipped],
              ['将写入释义', preview.added],
              ['将写入例句', preview.examplesAdded],
            ].map(([label, count]) => (
              <div key={label} className="rounded-lg bg-page p-3" data-definition-count={label}>
                <div className="text-xs text-mute">{label}</div>
                <div className="mt-1 text-xl font-semibold tabular-nums text-ink">{count}</div>
              </div>
            ))}
          </div>
          {preview.unmatchedItems.length > 0 && (
            <details className="mt-3 text-xs text-mute" data-testid="definition-unmatched">
              <summary className="cursor-pointer">查看未匹配明细（{preview.unmatchedItems.length}）</summary>
              <ul className="mt-2 max-h-52 space-y-1 overflow-auto">
                {preview.unmatchedItems.slice(0, 30).map((item, index) => (
                  <li key={`${item.fileName}-${item.line}-${index}`} className="vocab-wrap">
                    {item.fileName} 第 {item.line} 行 · {item.word}：{item.reason}
                  </li>
                ))}
              </ul>
              {preview.unmatchedItems.length > 30 && <p className="mt-2">只显示前 30 条；完整数量见上方。</p>}
            </details>
          )}
          <button type="button" data-testid="definition-confirm" onClick={() => void confirm()} disabled={busy || preview.added === 0} className="press mt-4 rounded-full bg-ink px-5 py-2.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40">
            <Upload className="mr-1.5 inline" size={16} />{importing ? '正在导入…' : preview.added === 0 ? '没有需要写入的新释义' : '确认导入当前预览'}
          </button>
        </div>
      )}

      {error && <div role="alert" className="mt-4 rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm text-danger">{error}</div>}
      {report && (
        <div className="mt-4 rounded-xl border border-success/30 bg-success-soft p-4 text-sm text-ink" data-testid="definition-import-result">
          释义导入完成：匹配 {report.matched}，新增 {report.added}，跳过 {report.skipped}，未匹配 {report.unmatched}；写入例句 {report.examplesAdded} 条。
        </div>
      )}
    </section>
  );
}
