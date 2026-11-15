import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import QuickNoteSheet from './QuickNoteSheet';
import BrowsePanel from './BrowsePanel';
import DuePanel from './DuePanel';
import FirstTestPanel from './FirstTestPanel';
import DailyWordsCard from './DailyWordsCard';
import ImportPanel from './ImportPanel';
import ExportPanel from './ExportPanel';
import InboxPanel from './InboxPanel';
import ScenesPanel from './ScenesPanel';
import Lookable from '../Lookable';
import { Plus, PencilLine, X } from 'lucide-react';
import { IS_MOBILE } from '../../utils/platform';
import { SyncFailNotice } from '../SyncStatus';
import { openManualAdd } from '../../utils/vocab/manualAdd';
import { useT } from '../../utils/i18n';
import ReviewPage, { useCards } from '../ReviewPage';
import { deckCounts } from '../../utils/review';
import QuickNotesPanel from './QuickNotesPanel';
import useQuickNoteCount from './useQuickNoteCount';
import { NoteJobBadge } from './NoteJobUI';
import { consumeOpenInbox, onOpenInbox } from '../../utils/vocab/noteJob';

type View = 'browse' | 'listening' | 'scenes' | 'inbox' | 'import' | 'export' | 'quicknotes';

const SEGMENTS: [View, string][] = [['browse', '浏览'], ['scenes', '场景'], ['inbox', '录笔记'], ['quicknotes', '随手记']];
const DESKTOP_SEGMENTS: [View, string][] = [['browse', '浏览'], ['scenes', '场景'], ['inbox', '录笔记'], ['quicknotes', '随手记'], ['import', '导入'], ['export', '导出']];

/** 电脑「随手记」按钮：等同按 Ctrl+M（快捷框在 QuickNoteHost 里监听这个键）。 */
const openQuickNote = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', ctrlKey: true, bubbles: true, cancelable: true }));

/** 065 手机右下角「＋」：点开上方展开「随手记」「添加词条」，背后变暗；有未整理随手记时右上角一个小圆点。 */
function FabMenu({ count, onQuick }: { count: number; onQuick: () => void }) {
  const [open, setOpen] = useState(false);
  const pick = (action: () => void) => { setOpen(false); action(); };
  const item = 'press fab-item inline-flex min-h-[44px] items-center gap-2 rounded-full bg-page px-4 text-sm text-ink shadow-lift';
  return (
    <div data-no-lookup="" data-testid="vocab-fab">
      {open && <div className="fixed inset-0 z-40 bg-ink/25 fade-in" data-testid="vocab-fab-backdrop" onClick={() => setOpen(false)} />}
      <div className="fixed right-4 z-40 flex flex-col items-end gap-3" style={{ bottom: 'calc(1.25rem + env(safe-area-inset-bottom, 0px))' }}>
        {open && (
          <>
            <button type="button" onClick={() => pick(() => openManualAdd())} data-testid="vocab-add" className={item} style={{ animationDelay: '60ms' }}>
              <Plus size={16} />添加词条
            </button>
            <button type="button" onClick={() => pick(onQuick)} data-testid="quicknote-quick" className={item}>
              <PencilLine size={16} />随手记
            </button>
          </>
        )}
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label={open ? '收起' : '添加'} data-testid="vocab-fab-toggle"
          className="press relative inline-flex h-14 w-14 items-center justify-center rounded-full bg-ink text-white shadow-lift">
          {open ? <X size={24} /> : <Plus size={26} />}
          {!open && count > 0 && <span className="absolute right-1 top-1 h-3 w-3 rounded-full border-2 border-ink bg-clay" data-testid="vocab-fab-dot" />}
        </button>
      </div>
    </div>
  );
}

export default function VocabPage() {
  const t = useT();
  // 识别完成提示条点了「去确认」：直接落在录笔记（词库页还没挂载时靠挂载时读标记，已挂载时靠事件）。
  const [view, setView] = useState<View>(() => consumeOpenInbox() ? 'inbox' : 'browse');
  const [wordStart] = useState(0);
  // 离开「导入」时让到期 / 首考重新读一次（刚导入的词要能出现）；其余切换不重读，复习区不闪。
  const [dataKey, setDataKey] = useState(0);
  const [listeningStart, setListeningStart] = useState(0);
  const cards = useCards();
  const listeningDue = cards ? deckCounts(cards).word.due : 0;
  const quickNoteCount = useQuickNoteCount();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [toast, setToast] = useState(0);
  // 064（手机）：切标签时标签行不能往下掉。tabsRef 量标签行位置，bodyRef 是四个标签内容的共同外层。
  const tabsRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<number | null>(null);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(0), 5000);
    return () => window.clearTimeout(id);
  }, [toast]);
  // 064：切换前量标签行；内容区设一个最小高度，让它的底边至少到滚动区底边，
  // 这样切到更短的面板时页面不会被夹住滚动。最小高度只在切换时重算一次，之后一直保留
  // （点按、滚动都不放开，点按过程中不会有布局变化）；切换后把滚动拉回，让标签行回到原位。
  const switchViewRef = useRef<(next: View) => void>(() => {});
  useEffect(() => onOpenInbox(() => { consumeOpenInbox(); switchViewRef.current('inbox'); }), []);
  const switchView = (next: View) => {
    if (next === view) return;
    const tabs = tabsRef.current;
    const body = bodyRef.current;
    if (IS_MOBILE && tabs && body) {
      anchorRef.current = tabs.getBoundingClientRect().top;
      const scroller = tabs.closest('main');
      // 内容区顶边到滚动区底边的距离（不随内容变化），再加 2px 余量防止取整后被夹。
      const room = scroller
        ? scroller.clientHeight - (body.getBoundingClientRect().top - scroller.getBoundingClientRect().top)
        : 0;
      body.style.minHeight = `${Math.max(0, Math.ceil(room)) + 2}px`;
    }
    if (view === 'import') setDataKey(k => k + 1);
    setView(next);
  };
  switchViewRef.current = switchView;
  useLayoutEffect(() => {
    const tabs = tabsRef.current;
    const body = bodyRef.current;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (IS_MOBILE && tabs && anchor !== null) {
      const delta = tabs.getBoundingClientRect().top - anchor;
      const scroller = tabs.closest('main');
      if (scroller && Math.abs(delta) >= 0.5) scroller.scrollTop += delta;
    }
    // 四个标签共用一个淡入：每次切换都重新播一遍 fade-in（先去掉再加回，让动画重新开始）。
    if (body) {
      body.classList.remove('fade-in');
      void body.offsetWidth;
      body.classList.add('fade-in');
    }
  }, [view]);
    // 各面板都保持挂载，只切换显示：导入过程和结果不会因为切到浏览而丢失。（手机和电脑共用）
  const panels = (
    <>
      {!IS_MOBILE && view === 'listening' && <ReviewPage key="word-in-vocab" deck="word" startRequest={listeningStart} />}
      {/* 049：按场景找。只在这个分页打开时挂载（设计选择：离开分页就卸载，补标在下一个词前停下，不在别的分页时读四个接口）。
          挂载方式不是 examples 脚本失败的原因：真因是脚本点击时的布局抖动，已在脚本里修（见 049 返工说明）。 */}
      {view === 'scenes' && <ScenesPanel />}
      {!IS_MOBILE && <div hidden={view !== 'import'}>
        <ImportPanel />
      </div>}
      <div hidden={view !== 'inbox'}>
        <InboxPanel active={view === 'inbox'} />
      </div>
      {!IS_MOBILE && <div hidden={view !== 'export'}>
        <ExportPanel active={view === 'export'} />
      </div>}
      {view === 'quicknotes' && <QuickNotesPanel />}
    </>
  );
  return (
    <Lookable className="max-w-5xl mx-auto" addSource="词库">
      <SyncFailNotice />
      {IS_MOBILE ? (
        <>
          {/* 手机版（用户 2026-11-12：只用来复习和记词）：第一屏就是今日到期，然后是记词入口，再是浏览。 */}
          <h1 className="sr-only">{t('nav.vocab')}</h1>
          {/* 063：今日到期、首考、两个大按钮在任何标签下都不动；大按钮只做动作，只有下面的小标签切视图。 */}
          <div>
            <DailyWordsCard />
            {/* 065：手机上切视图不重新读取（读取时「待考察」那段会消失几帧，页面变短）；数据变化由各面板自己的事件刷新。 */}
            <DuePanel refreshKey="m" startRequest={wordStart} />
            <FirstTestPanel refreshKey="m" />
          </div>
          {/* 065：四个视图一条分段切换条（浅底 + 选中白底），四段等宽一行；随手记未整理数做成右上角小角标，不占宽度。 */}
          <div ref={tabsRef} className="mb-4 grid grid-cols-4 gap-0.5 rounded-full border border-line bg-paper p-1" role="tablist" aria-label="词库视图" data-testid="vocab-segments">
            {SEGMENTS.map(([key, text]) => (
              <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => switchView(key)}
                data-testid={key === 'quicknotes' ? 'quicknotes-tab' : undefined}
                className={`press relative min-h-[40px] min-w-0 whitespace-nowrap rounded-full px-1 text-[0.8125rem] ${view === key ? 'bg-page font-semibold text-ink shadow-card' : 'text-mute'}`}>
                {text}
                {key === 'inbox' && <NoteJobBadge className="ml-0.5 align-middle" testId="inbox-tab-job" />}
                {key === 'quicknotes' && quickNoteCount > 0 && <span className="absolute -right-0.5 -top-1 min-w-[16px] z-10 rounded-full bg-clay-soft px-1 text-center text-[10px] leading-4 tabular-nums text-clay" data-testid="quicknotes-tab-count">{quickNoteCount}</span>}
              </button>
            ))}
          </div>
          <div ref={bodyRef} className="fade-in">
            <div hidden={view !== 'browse'}>
              <BrowsePanel active={view === 'browse'} onGoImport={() => {}} hideImport />
            </div>
            {panels}
          </div>
          <div aria-hidden="true" className="h-24" />
          <FabMenu count={quickNoteCount} onQuick={() => setSheetOpen(true)} />
          <QuickNoteSheet open={sheetOpen} onClose={() => setSheetOpen(false)} onSaved={() => { setSheetOpen(false); setToast(n => n + 1); }} />
          {toast > 0 && (
            <div key={toast} role="status" data-testid="quicknote-toast" data-no-lookup=""
              className="fixed bottom-5 left-1/2 z-[85] flex w-max max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center gap-2 rounded-2xl bg-ink py-1.5 pl-4 pr-1.5 text-sm text-white shadow-card fade-in">
              已记下
              <button type="button" data-testid="quicknote-toast-go" onClick={() => { switchView('quicknotes'); setToast(0); }}
                className="press min-h-[36px] rounded-xl px-3 text-sm text-white underline">去整理</button>
            </div>
          )}
        </>
      ) : (
        <>
          {/* 067：电脑版跟手机同一套设计：页头 → 复习区始终在上 → 听力卡小入口 → 分段切换条 → 内容。 */}
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold text-ink">{t('nav.vocab')}</h1>
            <div className="flex items-center gap-2">
              <button type="button" onClick={openQuickNote} data-testid="quicknote-quick" title="随手记（Ctrl+M）"
                className="press inline-flex items-center gap-1.5 rounded-full border border-line bg-page px-4 py-2 text-sm text-ink hover:border-ink/30">
                <PencilLine size={15} />随手记<kbd className="ml-0.5 rounded border border-line px-1 text-[10px] font-normal text-mute">Ctrl+M</kbd>
              </button>
              {/* 042：手动加一个词或短语（查重、可查词典预填），表单挂在应用最外层。 */}
              <button type="button" onClick={() => openManualAdd()} data-testid="vocab-add"
                className="press inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-sm text-white">
                <Plus size={15} />添加词条
              </button>
            </div>
          </div>
          {/* 复习区：宽屏两列并排，窄窗口上下排；不论切到哪个视图都在，切视图时不重读（和手机一致）。 */}
          <DailyWordsCard />
          <div className="mb-3 grid items-start gap-4 lg:grid-cols-2 [&>section]:mb-0">
            <DuePanel refreshKey={`d${dataKey}`} />
            <FirstTestPanel refreshKey={`d${dataKey}`} />
          </div>
          <div className="mb-5 flex flex-wrap items-center gap-x-2 text-xs text-mute" aria-label="听力单词卡" data-testid="listening-entry-row">
            <span>听力单词卡：</span>
            <button type="button" disabled={listeningDue === 0} onClick={() => { setView('listening'); setListeningStart(n => n + 1); }}
              className="press rounded-full px-2 py-1.5 text-ink underline-offset-2 hover:underline disabled:opacity-40 disabled:no-underline" data-testid="listening-review-entry">
              复习 {listeningDue} 张
            </button>
            <span aria-hidden="true">·</span>
            <button type="button" onClick={() => setView('listening')} className="press rounded-full px-2 py-1.5 text-ink underline-offset-2 hover:underline" data-testid="listening-manage-entry">管理</button>
          </div>
          <div ref={tabsRef} className="mb-4 flex flex-wrap gap-0.5 rounded-full border border-line bg-paper p-1" role="tablist" aria-label="词库视图" data-testid="vocab-segments">
            {DESKTOP_SEGMENTS.map(([key, text]) => (
              <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => switchView(key)}
                data-testid={key === 'quicknotes' ? 'quicknotes-tab' : undefined}
                className={`press relative min-h-[36px] flex-1 whitespace-nowrap rounded-full px-4 text-sm ${view === key ? 'bg-page font-semibold text-ink shadow-card' : 'text-mute hover:text-ink'}`}>
                {text}
                {key === 'inbox' && <NoteJobBadge className="ml-1.5 align-middle" testId="inbox-tab-job" />}
                {key === 'quicknotes' && quickNoteCount > 0 && <span className="ml-1.5 rounded-full bg-clay-soft px-1.5 py-0.5 text-xs tabular-nums text-clay" data-testid="quicknotes-tab-count">{quickNoteCount}</span>}
              </button>
            ))}
          </div>
          <div ref={bodyRef} className="fade-in">
            <div hidden={view !== 'browse'}>
              <BrowsePanel active={view === 'browse'} onGoImport={() => switchView('import')} />
            </div>
            {panels}
          </div>
        </>
      )}
    </Lookable>
  );
}
