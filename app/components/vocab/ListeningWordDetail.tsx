import React, { useState } from 'react';
import { Play } from 'lucide-react';
import { clipOf, useClip } from '../../hooks/useClip';
import { clean } from '../../utils/cleanHtml';
import { findSource } from '../../utils/clips';
import { hasAudio, isDue, type ReviewCard } from '../../utils/review';
import VoiceButton from './VoiceButton';

function Html({ html, className }: { html?: string; className?: string }) {
  return html ? <div className={className} dangerouslySetInnerHTML={{ __html: clean(html) }} /> : null;
}

function ListeningCard({ card }: { card: ReviewCard }) {
  const clip = useClip();
  const [error, setError] = useState('');
  const play = async () => {
    setError('');
    const source = await findSource(card).catch(() => null);
    if (!source) { setError('找不到原声片段'); return; }
    clip.play(source, ...clipOf(card));
  };
  const due = isDue(card);
  return (
    <div className="rounded-xl border border-line p-3" data-testid="listening-card" data-card-id={card.id}>
      <div className="vocab-wrap text-[15px] leading-relaxed text-ink" data-testid="listening-original">{card.text}</div>
      <Html html={card.definition} className="vocab-wrap mt-2 text-sm leading-relaxed text-ink" />
      <Html html={card.example} className="vocab-wrap mt-1 text-sm leading-relaxed text-mute" />
      {card.ai && <p className="vocab-wrap mt-2 rounded-lg bg-shade p-2 text-xs text-mute">AI：{card.ai}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" disabled={!hasAudio(card)} onClick={() => { void play(); }}
          className="press inline-flex items-center gap-1.5 rounded-full border border-line bg-page px-3 py-1.5 text-sm text-ink disabled:opacity-40"
          data-testid="listening-clip-play" aria-label={`播放原声：${card.word ?? ''}`}>
          <Play size={14} />播放原声片段
        </button>
        <span className="text-xs text-mute" data-testid="listening-progress">
          {due ? '听力复习已到期' : `听力下次复习 ${new Date(card.fsrs.due).toLocaleDateString('zh-CN')}`} · 已复习 {card.fsrs.reps} 次
        </span>
      </div>
      <p className="mt-1 text-[11px] text-mute">{card.videoName || '旧听力记录'} · 听力进度独立计算</p>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      <div data-testid="listening-clip-player">{clip.video('hidden')}</div>
    </div>
  );
}

export function ListeningWordSections({ cards }: { cards: ReviewCard[] }) {
  if (cards.length === 0) return null;
  return (
    <section className="vocab-section" data-testid="listening-section">
      <h4 className="vocab-section-title">听力单词（{cards.length} 张卡）</h4>
      <p className="mb-2 text-xs text-mute">这里的原句、原声和复习进度来自听力卡；不会改动上面的词库进度。</p>
      <div className="space-y-2">{cards.map(card => <ListeningCard key={card.id} card={card} />)}</div>
    </section>
  );
}

/** 只在听力里有的词：只展示听力能力，不渲染词库专属编辑、笔记和导出操作。 */
export default function ListeningWordDetail({ word, cards }: { word: string; cards: ReviewCard[] }) {
  return (
    <article data-testid="listening-word-detail">
      <header className="vocab-hero">
        <div className="flex items-start gap-2">
          <h3 className="vocab-wrap vocab-headword min-w-0 flex-1" data-testid="detail-headword">{word}</h3>
          <VoiceButton text={word} kind="word" />
        </div>
        <span className="vocab-chip mt-2 inline-flex border-accent/30 bg-accent-soft text-accent" data-testid="listening-badge">听力</span>
        <p className="mt-2 text-xs text-mute">这个词只在听力卡里，没有词库条目，所以不能编辑词库来源、笔记或 Markdown 记录。</p>
      </header>
      <ListeningWordSections cards={cards} />
    </article>
  );
}
