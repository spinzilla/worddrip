import React, { useSyncExternalStore } from 'react';
import { Loader2, X } from 'lucide-react';
import { noteJob, progressOf } from '../../utils/vocab/noteJob';

const useJob = () => useSyncExternalStore(noteJob.subscribe, noteJob.getState);

/** 识别进行中显示一个小转圈和「3/8」（词库页「录笔记」段、顶部「词库」入口共用）；没在识别时什么都不显示。 */
export function NoteJobBadge({ className = '', testId = 'note-job-badge' }: { className?: string; testId?: string }) {
  const job = useJob();
  if (!job.running || job.source !== '手写' || job.pages.length === 0) return null;
  const { settled, total } = progressOf(job, Date.now(), noteJob.concurrency);
  return (
    <span data-testid={testId} data-progress={`${settled}/${total}`} title={`正在识别笔记：${settled}/${total} 页`}
      className={`inline-flex shrink-0 items-center gap-0.5 tabular-nums ${className}`}>
      <Loader2 size={11} className="animate-spin" aria-hidden="true" />
      <span className="text-[10px] leading-none">{settled}/{total}</span>
    </span>
  );
}

/**
 * 识别全部结束、而用户不在「录笔记」页时弹一条不挡操作的提示；点「去确认」跳回录笔记。
 * 挂在 App 最外层，所以不管当时在设置、闪卡复习还是别的页面都能看到。
 */
export function NoteJobToast({ onGo }: { onGo: () => void }) {
  const job = useJob();
  const unseen = job.unseen;
  if (!unseen || job.viewing) return null;
  const text = unseen.words > 0
    ? `笔记识别完成：认出 ${unseen.words} 个词，去确认`
    : unseen.failed > 0 ? `笔记识别结束：有 ${unseen.failed} 页失败，去看看` : '笔记识别完成：没有认出词条';
  return (
    <div role="status" data-testid="note-job-toast" data-no-lookup=""
      className="fixed bottom-24 left-1/2 z-[85] flex w-max max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center gap-1 rounded-2xl bg-ink py-1.5 pl-4 pr-1.5 text-sm text-white shadow-card fade-in md:bottom-6">
      <span className="min-w-0">{text}</span>
      <button type="button" data-testid="note-job-toast-go" onClick={() => { noteJob.dismissUnseen(); onGo(); }}
        className="press min-h-[36px] shrink-0 rounded-xl px-3 text-sm text-white underline">去确认</button>
      <button type="button" aria-label="关闭提示" data-testid="note-job-toast-close" onClick={() => noteJob.dismissUnseen()}
        className="press inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-xl text-white/80"><X size={15} /></button>
    </div>
  );
}
