import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, Camera, CheckCircle2, CloudDownload, FilePlus2, Loader2, RotateCw, ScanText, Trash2 } from 'lucide-react';
import { vocabApi } from '../../utils/vocab/api';
import { INBOX_IMAGE_LIMIT, normalizeInboxWord } from '../../utils/vocab/inbox';
import {
  checkPageLimit,
  noteFileKind,
  NOTE_MAX_PAGES,
  pagesLabel,
  validateNoteFile,
  VISION_UNSUPPORTED_TEXT,
} from '../../utils/vocab/noteImport';
import { formatDuration, formatEstimate, isSettled, noteJob, progressOf, type NoteCandidate, type NoteSource, type PageState } from '../../utils/vocab/noteJob';
import { imageFileToPage, openPdf, type NotePage } from '../../utils/vocab/noteMedia';
import NoteViewer from './NoteViewer';
import { getAIConfig, getEndpoint } from '../../utils/aiConfig';
import { IS_MOBILE } from '../../utils/platform';
import { markNotionPagesImported, pullNotionInbox } from '../../utils/vocab/notion';
import type { InboxConfirmResult } from '../../utils/vocab/types';
import { notifyVocabChanged, onVocabChanged } from '../../utils/vocab/manualAdd';

type Candidate = NoteCandidate;

type Busy = 'prepare' | 'pull' | 'confirm' | 'notion-retry' | null;

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const today = () => {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const modelReady = () => !!getEndpoint() && !!getAIConfig().model.trim();

/** 宽屏（≥1024px）才并排显示原图，和 Tailwind 的 lg 一致。 */
const useWideScreen = (): boolean => {
  const query = '(min-width: 1024px)';
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches);
  useEffect(() => {
    if (!window.matchMedia) return;
    const media = window.matchMedia(query);
    const onChange = () => setWide(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return wide;
};

/** 订阅任务快照（单例在页面外面，组件卸载后任务照跑）。 */
export const useNoteJob = () => useSyncExternalStore(noteJob.subscribe, noteJob.getState);

/** 每秒刷新一次的当前时间（只在需要显示「已等 N 秒」时才走表）。 */
const useNow = (tick: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!tick) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [tick]);
  return now;
};

/** 一页的阶段文字：「已等 12 秒」「模型正在写…已收到 340 字」等。 */
const stageText = (status: PageState, now: number, started: boolean): string => {
  const waited = Math.max(0, Math.round((now - status.stageSince) / 1000));
  switch (status.stage) {
    case 'pending': return started ? '排队中' : '待识别';
    case 'preparing': return '准备图片…';
    case 'uploading': return '上传中…';
    case 'waiting': return `等待模型回复（已等 ${waited} 秒）`;
    case 'streaming': return `模型正在写…已收到 ${status.chars ?? 0} 字`;
    case 'done': return `完成 · 认出 ${status.words ?? 0} 个`;
    case 'cancelled': return '已取消';
    case 'failed': return `失败：${status.error ?? ''}`;
  }
};

export default function InboxPanel({ active }: { active: boolean }) {
  const mounted = useRef(true);
  const job = useNoteJob();
  const { pages, states: statuses, started, warnUnclear, candidates, source, error, notice } = job;
  const [existing, setExisting] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Busy>(null);
  const [result, setResult] = useState<InboxConfirmResult | null>(null);
  /** 刚确认入库的那批来自哪里（确认后任务会清空，来源要单独记） */
  const [resultSource, setResultSource] = useState<NoteSource>('手写');
  const [pendingNotionIds, setPendingNotionIds] = useState<string[]>([]);
  /** 069：当前看的原图页下标。窄屏：非 null 就弹全屏查看器；宽屏：左栏显示它（默认第 1 页）。 */
  const [viewIndex, setViewIndex] = useState<number | null>(null);
  /** 窄屏下是否弹出全屏查看器（宽屏并排不用它；窗口从宽拖窄时不会自动弹出） */
  const [overlayOpen, setOverlayOpen] = useState(false);
  const wide = useWideScreen();
  const recognizing = job.running;
  const busyAny = busy !== null || recognizing;
  const setError = (value: string) => noteJob.set({ error: value });
  const setNotice = (value: string) => noteJob.set({ notice: value });
  const setCandidates = (next: Candidate[] | ((items: Candidate[]) => Candidate[])) =>
    noteJob.set(current => ({ candidates: typeof next === 'function' ? next(current.candidates) : next }));

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // 用户正看着录笔记页时，完成提示条不弹；离开时恢复。
  useEffect(() => {
    noteJob.setViewing(active);
    return () => noteJob.setViewing(false);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    vocabApi.browse().then(data => {
      if (mounted.current) setExisting(new Set(data.reviewWords.map(item => normalizeInboxWord(item.word))));
    }).catch(reason => {
      if (mounted.current) setError(`读取现有词库失败：${errorText(reason)}`);
    });
  }, [active]);

  // 042：手动加的词也算「已存在」，候选里默认不勾。
  useEffect(() => onVocabChanged(() => {
    vocabApi.browse().then(data => {
      if (mounted.current) setExisting(new Set(data.reviewWords.map(item => normalizeInboxWord(item.word))));
    }).catch(() => {});
  }), []);

  const selected = useMemo(() => candidates.filter(item => item.checked && !existing.has(normalizeInboxWord(item.word))), [candidates, existing]);

  const resetRun = () => {
    if (busy) return;
    noteJob.reset();
    setViewIndex(null);
    setResult(null);
  };

  /** 选好的文件（图片 / PDF）变成待识别页：图片缩到长边 2000px，PDF 每页渲染成图。 */
  const addFiles = async (list: FileList | File[] | null) => {
    const files = list ? Array.from(list) : [];
    if (files.length === 0 || busyAny || started) return;
    setBusy('prepare');
    setError('');
    setNotice('');
    setResult(null);
    if (source === 'Notion') noteJob.set({ candidates: [], source: '手写' });
    const problems: string[] = [];
    const added: NotePage[] = [];
    const count = () => noteJob.getState().pages.length + added.length;
    for (const file of files) {
      const bad = validateNoteFile(file, INBOX_IMAGE_LIMIT);
      if (bad) { problems.push(bad); continue; }
      try {
        if (noteFileKind(file) === 'pdf') {
          const pdf = await openPdf(file);
          try {
            const over = checkPageLimit(count(), pdf.numPages);
            if (over) { problems.push(`「${file.name}」有 ${pdf.numPages} 页。${over}`); continue; }
            for (let n = 1; n <= pdf.numPages; n++) added.push(await pdf.render(n));
          } finally { pdf.destroy(); }
        } else {
          const over = checkPageLimit(count(), 1);
          if (over) { problems.push(`「${file.name}」没有加入。${over}`); continue; }
          added.push(await imageFileToPage(file));
        }
      } catch (reason) {
        problems.push(errorText(reason));
      }
    }
    // 任务在页面外面：即使中途切走了，也把准备好的页加进去。
    if (added.length) noteJob.addPages(added);
    if (problems.length) setError(problems.join('\n'));
    if (mounted.current) setBusy(null);
  };

  const removePage = (id: string) => {
    if (busyAny || started) return;
    noteJob.removePage(id);
  };

  const recognize = () => {
    if (pages.length === 0 || busyAny) return;
    if (!modelReady()) { setError('请先在设置中配置 OpenAI 兼容接口、API Key 和视觉模型。'); return; }
    setResult(null);
    void noteJob.start();
  };

  const cancelRecognize = () => noteJob.cancel();
  const retryPage = (page: NotePage) => { if (!busyAny) void noteJob.retryPage(page.id); };

  const pullNotion = async () => {
    if (busyAny) return;
    setBusy('pull');
    setError('');
    setNotice('');
    setResult(null);
    try {
      // 拉取和查重都是只读操作；只有下面的确认按钮会写词库。
      const [data, pulled] = await Promise.all([vocabApi.browse(), pullNotionInbox()]);
      const words = new Set(data.reviewWords.map(item => normalizeInboxWord(item.word)));
      if (mounted.current) { setExisting(words); setViewIndex(null); }
      noteJob.set({
        pages: [], states: {}, started: false, warnUnclear: false,
        source: 'Notion',
        candidates: pulled.map((item, index) => ({
          ...item,
          id: item.pageId || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${index}`,
          pages: [],
          checked: !words.has(normalizeInboxWord(item.word)),
        })),
        notice: pulled.length ? `从 Notion 拉取 ${pulled.length} 条候选，请逐条检查后再确认。` : 'Notion 里没有待入库的词条。',
      });
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const update = (id: string, patch: Partial<Candidate>) => {
    setCandidates(items => items.map(item => {
      if (item.id !== id) return item;
      const next = { ...item, ...patch };
      if ('word' in patch || 'note' in patch) next.edited = true;
      if (existing.has(normalizeInboxWord(next.word))) next.checked = false;
      return next;
    }));
  };

  const confirm = async () => {
    if (busyAny || selected.length === 0) return;
    if (selected.some(item => !item.word.trim())) { setError('所选候选里有空词目，请填写或取消勾选。'); return; }
    if (source === 'Notion' && selected.some(item => !item.pageId)) { setError('Notion 候选缺少页面 ID，请重新拉取。'); return; }
    const normalized = selected.map(item => normalizeInboxWord(item.word));
    if (new Set(normalized).size !== normalized.length) { setError('所选候选里有重复词目，请只保留一条。'); return; }
    setBusy('confirm');
    setError('');
    setNotice('');
    let saved: InboxConfirmResult;
    try {
      saved = await vocabApi.confirmInbox({
        date: today(),
        source,
        words: selected.map(item => ({ word: item.word.trim(), note: item.note.trim() })),
      });
    } catch (reason) {
      setError(`确认入库失败，整批未写入：${errorText(reason)}`);
      if (mounted.current) setBusy(null);
      return;
    }

    // 042：词库列表、首考新词数、查词卡「已在词库」跟着刷新。
    notifyVocabChanged();
    // 即使用户在请求期间离开页面，已落库的 Notion 行仍要继续回勾；只是不再更新已卸载的界面。
    noteJob.reset();
    if (mounted.current) {
      setResult(saved);
      setResultSource(source);
      setViewIndex(null);
      setExisting(new Set([...existing, ...normalized]));
    }

    if (source === 'Notion') {
      const pageIds = selected.map(item => item.pageId!);
      setPendingNotionIds(pageIds);
      try {
        await markNotionPagesImported(pageIds);
        if (!mounted.current) return;
        setPendingNotionIds([]);
        setNotice(`词库已更新，并只在 Notion 勾选了本次入库的 ${pageIds.length} 行。`);
      } catch (reason) {
        if (mounted.current) {
          setError(`词条已写入词库，但 Notion 勾选未完成：${errorText(reason)} 可点击「重试勾选 Notion」，不会重复写入词库。`);
        }
      }
    }
    if (mounted.current) setBusy(null);
  };

  const retryNotion = async () => {
    if (busyAny || pendingNotionIds.length === 0) return;
    setBusy('notion-retry');
    setError('');
    setNotice('');
    try {
      await markNotionPagesImported(pendingNotionIds);
      if (!mounted.current) return;
      setPendingNotionIds([]);
      setNotice(`已在 Notion 勾选本次入库的 ${pendingNotionIds.length} 行，没有重复写入词库。`);
    } catch (reason) {
      if (mounted.current) setError(`Notion 勾选仍未完成：${errorText(reason)}`);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const ready = modelReady();
  const now = useNow(recognizing);
  const prog = progressOf(job, now, noteJob.concurrency);
  const total = pages.length;
  const okCount = prog.done;
  /** 总进度（一行文字；进行中和结束后都显示） */
  const progress = !started || total === 0 ? '' : recognizing
    ? `已完成 ${prog.settled} / ${total} 页 · 已用 ${formatDuration(prog.elapsedMs)} · ${prog.remainingMs === null ? '预计时间：估算中' : `预计还要${formatEstimate(prog.remainingMs)}`}`
    : `${pages.some(p => statuses[p.id]?.stage === 'cancelled') ? '已取消' : '识别完成'}：成功 ${okCount} / ${total} 页 · 用时 ${formatDuration(prog.elapsedMs)}`;
  /** 有原图可看：手写识别出过候选，且页面大图还在（确认入库 / 重新选择后会清空） */
  const canView = source === '手写' && started && pages.length > 0 && candidates.length > 0;
  const showPane = canView && wide;
  const openPage = (pageNumber: number) => {
    const index = Math.min(Math.max(pageNumber - 1, 0), pages.length - 1);
    if (index < 0) return;
    setViewIndex(index);
    setOverlayOpen(!wide);
  };
  const visionProblem = pages.some(page => statuses[page.id]?.error === VISION_UNSUPPORTED_TEXT);

  return (
    <section className="vocab-wrap rounded-2xl border border-line bg-page p-4 sm:p-6" aria-label="录入笔记">
      <div className="flex items-start gap-3">
        <ScanText className="mt-1 shrink-0 text-mute" size={22} />
        <div>
          <h2 className="text-lg font-semibold text-ink">录入笔记</h2>
          <p className="mt-1 text-sm text-mute">一次选多张笔记照片或一个 PDF，逐页识别后合并给你检查，最后由你确认。候选阶段不会写入词库；看不清的条目会高亮。</p>
        </div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 rounded-xl border border-line bg-page p-4">
          <p data-testid="inbox-clarity-tip" className="mb-3 rounded-lg border border-clay/30 bg-clay-soft p-3 text-xs leading-relaxed text-ink">
            请用清晰、光线均匀、正对拍摄的图片或 PDF。手写潦草、反光、歪斜会认不准；认不好时，先用手机自带的扫描功能或扫描类 App 扫一遍再录入。
          </p>
          <div className="text-sm font-medium text-ink">选择笔记图片或 PDF（最多 {NOTE_MAX_PAGES} 页）</div>
          <div className="mt-2 flex flex-wrap gap-2">
            <label className={`press inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg bg-ink px-4 text-sm text-white ${busyAny || started ? 'pointer-events-none opacity-40' : ''}`}>
              <FilePlus2 size={17} />选择图片 / PDF
              <input
                data-testid="inbox-file"
                type="file"
                multiple
                accept=".png,.jpg,.jpeg,.webp,.heic,.heif,.pdf,image/png,image/jpeg,image/webp,image/heic,application/pdf"
                disabled={busyAny || started}
                value=""
                onChange={event => { const picked = event.target.files; void addFiles(picked ? Array.from(picked) : null); }}
                className="sr-only"
              />
            </label>
            {IS_MOBILE && <label className={`press inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border border-line bg-page px-4 text-sm text-ink ${busyAny || started ? 'pointer-events-none opacity-40' : ''}`}>
              <Camera size={17} />拍照
              <input
                data-testid="inbox-camera"
                type="file"
                accept="image/*"
                capture="environment"
                disabled={busyAny || started}
                value=""
                onChange={event => { const picked = event.target.files; void addFiles(picked ? Array.from(picked) : null); }}
                className="sr-only"
              />
            </label>}
          </div>
          {busy === 'prepare' && <p data-testid="inbox-preparing" className="mt-2 text-xs text-mute">正在处理文件，PDF 页数多时要几秒…</p>}

          {pages.length > 0 && <ul data-testid="inbox-pages" className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {pages.map((page, index) => {
              const status: PageState = statuses[page.id] ?? { stage: 'pending', stageSince: now };
              const settledPage = isSettled(status.stage);
              return <li key={page.id} data-testid={`inbox-page-${index}`} data-state={status.stage} className="min-w-0 rounded-lg border border-line p-2">
                <div className="relative">
                  <img src={page.thumb} alt={`第 ${index + 1} 页缩略图`} className="h-28 w-full rounded bg-shade object-contain" />
                  <span className="absolute left-1 top-1 rounded bg-ink px-1.5 text-xs text-white">{index + 1}</span>
                </div>
                <p className="mt-1 truncate text-xs text-mute" title={page.label}>{page.label}</p>
                <p data-testid={`inbox-page-status-${index}`} className={`mt-0.5 flex items-start gap-1 text-xs ${status.stage === 'failed' ? 'text-danger' : 'text-mute'}`}>
                  {started && !settledPage && status.stage !== 'pending' && <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin" aria-hidden="true" />}
                  <span className="min-w-0 break-words">{stageText(status, now, started)}</span>
                </p>
                {status.hint && <p data-testid={`inbox-page-hint-${index}`} className="mt-0.5 text-xs text-clay">{status.hint}</p>}
                <div className="mt-1 flex flex-wrap gap-1">
                  {status.stage === 'failed' && <button type="button" data-testid={`inbox-page-retry-${index}`} onClick={() => retryPage(page)} disabled={busyAny}
                    className="press inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-line px-3 text-xs text-ink disabled:opacity-40"><RotateCw size={14} />重试</button>}
                  {!started && <button type="button" aria-label={`删除第 ${index + 1} 页`} data-testid={`inbox-page-delete-${index}`} onClick={() => removePage(page.id)} disabled={busyAny}
                    className="press inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-mute hover:text-danger disabled:opacity-40"><Trash2 size={16} /></button>}
                </div>
              </li>;
            })}
          </ul>}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" data-testid="inbox-recognize" onClick={() => void recognize()}
              disabled={pages.length === 0 || busyAny || started || !ready}
              className="press min-h-[44px] rounded-lg bg-ink px-4 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40">
              {recognizing ? '正在识别…' : `开始识别${pages.length ? `（${pages.length} 页）` : ''}`}
            </button>
            {recognizing && <button type="button" data-testid="inbox-cancel" onClick={cancelRecognize}
              className="press min-h-[44px] rounded-lg border border-line px-4 text-sm text-ink">取消</button>}
            {started && !busyAny && <button type="button" data-testid="inbox-reset" onClick={resetRun}
              className="press min-h-[44px] rounded-lg border border-line px-4 text-sm text-ink">重新选择</button>}
          </div>
          {!ready && <p data-testid="inbox-no-model" className="mt-2 text-xs text-danger">还没配置视觉模型，请先到「设置 → AI」填写接口、密钥和能看图的模型。</p>}
          {progress && <div className="mt-3" data-testid="inbox-progress-box">
            <div role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={prog.settled} data-testid="inbox-progress-bar"
              className="h-2 w-full overflow-hidden rounded-full bg-shade">
              <div className="h-full rounded-full bg-ink transition-all" style={{ width: `${total ? Math.round((prog.settled / total) * 100) : 0}%` }} />
            </div>
            <p data-testid="inbox-progress" className="mt-2 text-sm text-ink">{progress}</p>
          </div>}
          {started && recognizing && <div data-testid="inbox-job-tips" className="mt-1 space-y-0.5 text-xs text-mute">
            {job.model && <p data-testid="inbox-model">正在使用模型：{job.model}</p>}
            <p>识别慢的话，可以在「设置 → AI」换一个更快的看图模型。</p>
            <p data-testid="inbox-leave-note">可以切到别的页面，识别会在后台继续；关闭应用会中断。</p>
          </div>}
        </div>

        <div className="rounded-xl border border-line bg-page p-4">
          <div className="flex items-start gap-2">
            <CloudDownload className="mt-0.5 shrink-0 text-mute" size={18} />
            <div>
              <h3 className="text-sm font-medium text-ink">Notion 收件箱</h3>
              <p className="mt-1 text-xs leading-relaxed text-mute">读取「已入库」未勾选的行；被删除或未勾选的候选不会回写，下次仍会出现。</p>
            </div>
          </div>
          <button type="button" data-testid="notion-pull" onClick={pullNotion} disabled={busyAny}
            className="press mt-3 rounded-lg bg-ink px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40">
            {busy === 'pull' ? '正在从 Notion 拉取…' : '从 Notion 拉取'}
          </button>
        </div>
      </div>

      {error && <div role="alert" data-testid="inbox-error" className="mt-4 whitespace-pre-line rounded-lg border border-danger/30 bg-danger-soft p-3 text-sm text-danger">{error}</div>}
      {visionProblem && <div role="alert" data-testid="inbox-vision-hint" className="mt-4 rounded-lg border border-danger/30 bg-danger-soft p-3 text-sm text-danger">{VISION_UNSUPPORTED_TEXT}</div>}
      {warnUnclear && !busyAny && <div data-testid="inbox-unclear-warning" className="mt-4 flex items-start gap-2 rounded-lg border border-clay/60 bg-clay-soft p-3 text-sm text-ink"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-clay" />这几页可能不够清晰，建议扫描后重录。</div>}
      {notice && <div data-testid="inbox-notice" className="mt-4 rounded-lg border border-line bg-page p-3 text-sm text-ink">{notice}</div>}
      {pendingNotionIds.length > 0 && <button type="button" data-testid="notion-retry" onClick={retryNotion} disabled={busyAny}
        className="press mt-3 rounded-lg border border-clay/30 bg-clay-soft px-4 py-2 text-sm text-ink disabled:opacity-40">
        {busy === 'notion-retry' ? '正在重试…' : '重试勾选 Notion'}
      </button>}

      {candidates.length > 0 && <div className={`mt-5 ${showPane ? 'grid grid-cols-2 items-start gap-4' : ''}`}>
        {showPane && <div className="sticky top-20 min-w-0" data-testid="inbox-viewer-side">
          <NoteViewer mode="pane" pages={pages} index={Math.min(viewIndex ?? 0, pages.length - 1)} onIndex={setViewIndex} />
        </div>}
        <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium text-ink">候选词单</h3>
          <span data-testid="inbox-selected-count" className="text-sm text-mute">已勾选 {selected.length} / {candidates.length} 条</span>
        </div>
        <div data-testid="inbox-candidates" className="space-y-3">
          {candidates.map((item, index) => {
            const exists = existing.has(normalizeInboxWord(item.word));
            return <article key={item.id} data-testid={`inbox-candidate-${index}`}
              onClick={showPane && item.pages.length > 0 ? () => openPage(item.pages[0]) : undefined}
              className={`rounded-xl border p-3 ${item.uncertain ? 'border-clay/60 bg-clay-soft' : 'border-line bg-page'}`}>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input data-testid={`inbox-check-${index}`} type="checkbox" checked={item.checked && !exists} disabled={busyAny || exists}
                    onChange={event => update(item.id, { checked: event.target.checked })} />
                  入库
                </label>
                {item.uncertain && <span data-testid={`inbox-uncertain-${index}`} className="flex items-center gap-1 rounded-full bg-clay-soft px-2 py-0.5 text-xs text-clay"><AlertTriangle size={13} />拿不准，请核对</span>}
                {item.pages && item.pages.length > 0 && <span data-testid={`inbox-pages-${index}`} className="flex flex-wrap items-center gap-1 text-xs text-mute">来自
                  {canView && pages.length > 0
                    ? item.pages.map(number => <button key={number} type="button" data-testid={`inbox-page-chip-${index}-${number}`}
                        onClick={event => { event.stopPropagation(); openPage(number); }}
                        className="press inline-flex min-h-[32px] items-center rounded-full border border-line bg-line px-3 text-xs text-ink">第 {number} 页</button>)
                    : <span className="rounded-full bg-line px-2 py-0.5 text-ink">{pagesLabel(item.pages)}</span>}
                </span>}
                {exists && <span data-testid={`inbox-existing-${index}`} className="rounded-full bg-line px-2 py-0.5 text-xs text-ink">已存在，默认不勾选</span>}
                <button type="button" aria-label={`删除候选 ${index + 1}`} data-testid={`inbox-delete-${index}`} disabled={busyAny}
                  onClick={() => setCandidates(items => items.filter(candidate => candidate.id !== item.id))}
                  className="press ml-auto rounded-lg p-2 text-mute hover:bg-shade hover:text-danger disabled:opacity-40"><Trash2 size={17} /></button>
              </div>
              <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
                <label className="min-w-0 text-xs text-mute">词目
                  <input data-testid={`inbox-word-${index}`} value={item.word} disabled={busy !== null} maxLength={200}
                    onChange={event => update(item.id, { word: event.target.value })}
                    className="mt-1 w-full min-w-0 rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink" />
                </label>
                <label className="min-w-0 text-xs text-mute">备注
                  <input data-testid={`inbox-note-${index}`} value={item.note} disabled={busy !== null} maxLength={2000}
                    onChange={event => update(item.id, { note: event.target.value })}
                    className="mt-1 w-full min-w-0 rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink" />
                </label>
              </div>
            </article>;
          })}
        </div>
        <button type="button" data-testid="inbox-confirm" onClick={confirm} disabled={selected.length === 0 || busyAny}
          className="press mt-4 rounded-lg bg-ink px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40">
          {busy === 'confirm' ? '正在写入…' : `确认入库 ${selected.length} 条`}
        </button>
        </div>
      </div>}

      {canView && !wide && overlayOpen && viewIndex !== null && <NoteViewer mode="overlay" pages={pages} index={Math.min(viewIndex, pages.length - 1)} onIndex={setViewIndex} onClose={() => setOverlayOpen(false)} />}

      {result && <div data-testid="inbox-result" className="mt-5 rounded-xl border border-success/30 bg-success-soft p-4 text-sm text-ink">
        <div className="flex items-center gap-2 font-medium"><CheckCircle2 size={19} />已确认入库 {result.added} 条</div>
        <p className="mt-2">状态均为「待考察」，来源为「{resultSource} {today()}」，查证状态为「未查证」。</p>
        <ul className="mt-2 list-inside list-disc">{result.words.map(word => <li key={word}>{word}</li>)}</ul>
      </div>}
    </section>
  );
}