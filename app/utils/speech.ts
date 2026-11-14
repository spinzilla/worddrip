import { synthesizeSpeech } from './desktop';

// Clean read-aloud for "break it down": Edge's neural voices first, the Mac's
// own speech synthesis when that fails. One clip plays at a time.

export const VOICES: Record<string, string> = {
  en: 'en-US-JennyNeural',
  es: 'es-ES-ElviraNeural',
  fr: 'fr-FR-DeniseNeural',
  de: 'de-DE-KatjaNeural',
  it: 'it-IT-ElsaNeural',
  pt: 'pt-BR-FranciscaNeural',
  ja: 'ja-JP-NanamiNeural',
  ko: 'ko-KR-SunHiNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
  no: 'nb-NO-PernilleNeural',
  nb: 'nb-NO-PernilleNeural',
};

export type Clip = { text: string; lang: string; url: string | null };

type E2EVoice = (kind: 'dictionary' | 'tts', text: string, voice: string) => Promise<ArrayBuffer | null | 'none' | 'error'>;
// 仅开发版主动设置这个全局替身时拦截声音请求；正式版不会读取它。
declare global {
  interface Window { __ES_E2E_VOCAB_VOICE__?: E2EVoice }
}

export async function synthesizeVocabSpeech(text: string, voice: string): Promise<ArrayBuffer | null> {
  const testVoice = import.meta.env.DEV && typeof window !== 'undefined' ? window.__ES_E2E_VOCAB_VOICE__ : undefined;
  if (!testVoice) return synthesizeSpeech(text, voice);
  const result = await testVoice('tts', text, voice);
  if (result === 'error') throw new Error('朗读失败');
  return result instanceof ArrayBuffer ? result : null;
}

export async function loadClip(text: string, lang: string): Promise<Clip> {
  const voice = VOICES[lang];
  const bytes = voice ? await synthesizeVocabSpeech(text, voice) : null;
  const url = bytes ? URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' })) : null;
  return { text, lang, url };
}

export function releaseClip(clip: Clip) {
  if (clip.url) URL.revokeObjectURL(clip.url);
}

let playing: HTMLAudioElement | null = null;
let playingUrl: string | null = null;
let playbackVersion = 0;

const stopPlaying = () => {
  playing?.pause();
  playing = null;
  if (playingUrl) URL.revokeObjectURL(playingUrl);
  playingUrl = null;
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
};

/** 停止当前声音，并返回这一轮请求的编号；过期的慢请求之后不能抢播。 */
export function stopClip() {
  playbackVersion += 1;
  stopPlaying();
  return playbackVersion;
}

export const isClipRequestCurrent = (version: number) => version === playbackVersion;

function playUrl(url: string, version: number, ownedUrl: boolean): Promise<boolean> {
  if (version !== playbackVersion) {
    if (ownedUrl) URL.revokeObjectURL(url);
    return Promise.resolve(false);
  }
  stopPlaying();
  const audio = new Audio(url);
  playing = audio;
  playingUrl = ownedUrl ? url : null;
  const clear = () => {
    if (playing !== audio) return;
    playing = null;
    if (playingUrl) URL.revokeObjectURL(playingUrl);
    playingUrl = null;
  };
  audio.addEventListener('ended', clear, { once: true });
  audio.addEventListener('error', clear, { once: true });
  return audio.play().then(() => true).catch(() => {
    clear();
    return false;
  });
}

export function playClip(clip: Clip, expectedVersion?: number): Promise<boolean> {
  const version = expectedVersion ?? stopClip();
  if (version !== playbackVersion) return Promise.resolve(false);
  if (clip.url) {
    return playUrl(clip.url, version, false);
  }
  if (typeof speechSynthesis === 'undefined') return Promise.resolve(false);
  const u = new SpeechSynthesisUtterance(clip.text);
  u.lang = clip.lang;
  speechSynthesis.speak(u);
  return Promise.resolve(true);
}

/** 播放词典录音 ArrayBuffer，与 loadClip/playClip 共用同一个「只播一段」控制器。 */
export function playAudioBytes(bytes: ArrayBuffer, expectedVersion: number): Promise<boolean> {
  if (expectedVersion !== playbackVersion) return Promise.resolve(false);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
  return playUrl(url, expectedVersion, true);
}
