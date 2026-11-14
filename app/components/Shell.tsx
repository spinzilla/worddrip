import React, { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { AppState } from '../types';
import { useT } from '../utils/i18n';
import { IS_MOBILE, IS_WINDOWS, navStates } from '../utils/platform';
import { deckCounts, getAllCards, subscribeCards } from '../utils/review';
import { UpdateBanner } from './UpdateUI';
import { SyncDot } from './SyncStatus';
import useVocabDueCount from './vocab/useVocabDueCount';
import useQuickNoteCount from './vocab/useQuickNoteCount';
import { NoteJobBadge } from './vocab/NoteJobUI';

// Page frame for the non-practice screens: wordmark, a centred pill of tabs (the two
// libraries carry how many cards are due), the quiet "add video" button, scrolling body.
// `podcasts`: the official build's podcast tab.
const Shell: React.FC<{ active: AppState; onNav: (s: AppState) => void; onAdd: () => void; hideAdd?: boolean; podcasts?: boolean; children: React.ReactNode }> = ({ active, onNav, onAdd, hideAdd, podcasts, children }) => {
  const t = useT();
  const navRef = useRef<HTMLElement>(null);
  const [due, setDue] = useState({ line: 0, word: 0 });
  const vocabDue = useVocabDueCount();
  const quickNoteCount = useQuickNoteCount();
  useEffect(() => {
    const load = () => getAllCards().then(c => { const n = deckCounts(c); setDue({ line: n.line.due, word: n.word.due }); }).catch(() => {});
    load();
    return subscribeCards(load);
  }, []);
  // 窄屏导航是横向滚动的：切页或窗口变窄后把当前标签滚进可视区，不用用户自己滑。
  useEffect(() => {
    const reveal = () => {
      const activeTab = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
      activeTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    reveal();
    window.addEventListener('resize', reveal);
    return () => window.removeEventListener('resize', reveal);
  }, [active]);
  const visibleNav = navStates(IS_MOBILE, !!podcasts);
  const NAV: { state: AppState; label: string; badge?: number }[] = [
    { state: AppState.UPLOAD, label: t('nav.videos') },
    ...(podcasts ? [{ state: AppState.PODCASTS, label: t('nav.podcasts') }] : []),
    { state: AppState.LIBRARY, label: t('nav.saved'), badge: due.line },
    { state: AppState.VOCAB, label: t('nav.vocab'), badge: vocabDue + due.word },
    { state: AppState.COACH, label: t('nav.coach') },
    { state: AppState.SETTINGS, label: t('nav.settings') },
  ].filter(item => visibleNav.includes(item.state));
  return (
  <div className="h-full flex flex-col">
    {/* The Mac's traffic lights sit top-left, so the wordmark starts after them. */}
    <header className={`shrink-0 relative ${IS_MOBILE ? 'pl-4' : IS_WINDOWS ? 'pl-6' : 'pl-24'} ${IS_MOBILE ? 'pr-4' : 'pr-6'} lg:pr-10 py-3 md:py-0 md:h-16 flex flex-col md:flex-row md:items-center justify-between gap-2`} data-tauri-drag-region="deep">
      <span className="flex h-8 items-center"><span className="text-[15px] font-semibold select-none">词滴 WordDrip</span></span>
      <nav ref={navRef} className={`static flex w-full max-w-full gap-0.5 overflow-x-auto p-1 bg-page border border-line rounded-full md:absolute md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:w-auto md:max-w-[58vw]${IS_MOBILE ? ' [&>button]:flex-1 [&>button]:justify-center [&>button]:px-3' : ''}`}>
        {NAV.map(({ state, label, badge }) => {
          const on = active === state;
          return (
            <button
              key={state}
              onClick={() => onNav(state)}
              aria-current={on ? 'page' : undefined}
              className={`h-8 shrink-0 whitespace-nowrap px-4 rounded-full flex items-center gap-1.5 text-[13px] transition-colors
                ${on ? 'bg-ink text-white' : 'text-mute hover:text-ink'}`}
            >
              {label}
              {state === AppState.SETTINGS && <SyncDot onDark={on} />}
              {!!badge && <span aria-hidden="true" data-testid="nav-due" data-badge={badge} className={`nav-due-badge text-xs tabular-nums ${on ? 'text-white' : 'text-accent'}`} />}
              {state === AppState.VOCAB && <NoteJobBadge className={on ? 'text-white' : 'text-accent'} testId="nav-note-job" />}
              {state === AppState.VOCAB && quickNoteCount > 0 && <span title={`${quickNoteCount} 条待整理随手记`} data-testid="nav-quicknote-count" data-badge={quickNoteCount} className={`nav-quicknote-badge shrink-0 tabular-nums ${on ? 'text-white' : 'text-clay'}`} />}
            </button>
          );
        })}
      </nav>
      {/* Home's empty state carries its own big add button; one is enough. */}
      {!hideAdd && !IS_MOBILE && (
        <button onClick={onAdd}
          className="press h-[42px] pl-3.5 pr-4 rounded-full bg-page border border-line flex items-center gap-1.5 text-[13px] hover:border-ink/20">
          <Plus size={16} strokeWidth={2.25} className="text-accent" />{t(active === AppState.PODCASTS ? 'home.addPodcast' : 'home.addVideo')}
        </button>
      )}
    </header>
    <UpdateBanner />
    <main className="flex-1 overflow-y-auto">
      <div className={`max-w-[1280px] mx-auto ${IS_MOBILE ? 'px-4' : 'px-6'} md:px-12 lg:px-24 pt-4 pb-12`}>{children}</div>
    </main>
  </div>
  );
};

export default Shell;
