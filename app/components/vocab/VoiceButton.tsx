import React, { useEffect, useRef, useState } from 'react';
import { Volume2 } from 'lucide-react';
import { isClipRequestCurrent, playAudioBytes, playClip, stopClip } from '../../utils/speech';
import { wordVoiceForLanguage } from '../../utils/wordVoice';
import { vocabSentenceClip } from '../../utils/vocab/voice';

export default function VoiceButton({ text, kind }: { text: string; kind: 'word' | 'sentence' }) {
  const [noSound, setNoSound] = useState(false);
  const version = useRef(0);
  const timer = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  const showNoSound = () => {
    setNoSound(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { setNoSound(false); timer.current = null; }, 1600);
  };

  const play = async () => {
    const request = ++version.current;
    const playback = stopClip();
    setNoSound(false);
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    try {
      if (kind === 'word') {
        const bytes = await wordVoiceForLanguage(text, 'en');
        if (request !== version.current) return;
        if (!bytes) { showNoSound(); return; }
        if (!await playAudioBytes(bytes, playback) && request === version.current && isClipRequestCurrent(playback)) showNoSound();
      } else {
        const clip = await vocabSentenceClip(text);
        if (request !== version.current) return;
        if (!clip?.url) { showNoSound(); return; }
        if (!await playClip(clip, playback) && request === version.current && isClipRequestCurrent(playback)) showNoSound();
      }
    } catch {
      if (request === version.current) showNoSound();
    }
  };

  return (
    <span className="inline-flex min-w-0 items-center gap-1 align-middle" data-flash-notes="">
      <button
        type="button"
        onClick={event => { event.preventDefault(); event.stopPropagation(); void play(); }}
        onKeyDown={event => event.stopPropagation()}
        className="press inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-mute hover:bg-shade hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
        aria-label={`播放${kind === 'word' ? '单词' : '例句'}：${text}`}
        title={`播放${kind === 'word' ? '单词' : '例句'}`}
        data-testid="vocab-voice"
        data-kind={kind}
        data-text={text}
      >
        <Volume2 size={14} aria-hidden="true" />
      </button>
      {noSound && <span role="status" className="shrink-0 text-xs text-mute" data-testid="vocab-voice-error">没有声音</span>}
    </span>
  );
}
