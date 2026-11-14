import { useEffect, useRef, useState } from 'react';
import * as AI from '../utils/ai';
import { DefinitionState, emptyDefinition } from '../components/DefinitionPanel';
import { useT } from '../utils/i18n';
import { DictLang, dictsOff, getDictSources, lookupWord, senseList, DictEntry } from '../utils/dictionary';
import { lookupJa } from '../utils/jaLookup';

// Word lookup behind the definition popup, shared by the practice page and review.
// Dictionary first. AI answers instead when the dictionary has nothing (or no
// dictionary covers the language).
// `currentAround` / `around`: the lines before and after, for the AI's cultural meaning.
// `scrub` (034, review/first test while answering): every text that goes to the AI passes
// through it first, so the answer word never leaves the page. Unset = unchanged.
export const useLookup = (dictLang: DictLang | null, currentContext: string, currentAround = '', opts: { scrub?: (text: string) => string } = {}) => {
  const t = useT();
  const scrubRef = useRef(opts.scrub);
  scrubRef.current = opts.scrub;
  const clean = (text: string) => (scrubRef.current ? scrubRef.current(text) : text);
  const [def, setDef] = useState<DefinitionState>(emptyDefinition);
  const seqRef = useRef(0);
  // Every lookup starts from a click on a word: remember where, so the card opens beside
  // it — across from the word, but clear of the whole line above and below.
  const lastPress = useRef<DOMRect | null>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const btn = (e.target as Element)?.closest?.('button');
      const w = btn?.getBoundingClientRect(), l = btn?.closest('[data-lookup-line]')?.getBoundingClientRect() ?? w;
      lastPress.current = w && l ? new DOMRect(w.left, l.top, w.width, l.height) : null;
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, []);

  // `line` overrides the hook's context: a word looked up again from a list, not from the line on screen.
  // `at` (034): where the word is, when the click was on plain text rather than a word button.
  const lookup = async (word: string, line?: string, around?: string, at?: DOMRect) => {
    const context = clean(line ?? currentContext);
    const near = clean(around ?? (line === undefined ? currentAround : ''));
    const { autoPick, aiAlways, aiCulture } = getDictSources();
    const seq = ++seqRef.current;
    const mine = () => seq === seqRef.current;
    const ai = AI.aiReady();
    const anchor = at ?? lastPress.current ?? undefined;
    setDef({ ...emptyDefinition, word, anchor, loading: true });
    let dict: DictEntry[] | null = null;
    let offline = false;
    // Dictionaries switched off in Settings → Look up: nothing to ask, say so if AI can't answer.
    const off = dictLang && await dictsOff(dictLang);
    if (dictLang && !off) {
      try { dict = dictLang === 'ja' ? await lookupJa(word) : await lookupWord(word, dictLang); } catch (e) { offline = true; console.error('Dictionary lookup failed:', e); }
    }
    if (!mine()) return;
    if (dict) {
      setDef({ ...emptyDefinition, word, anchor, dict, context, around: near });
      if (ai && autoPick && (aiAlways || senseList(dict).length > 3)) runPick(seq, word, context, dict, near);
      return;
    }
    if (!ai) {
      const error = t(offline ? 'definition.dictOffline' : off === 'all' ? 'definition.dictsOff' : off === 'noLocal' ? 'definition.noLocalDict' : dictLang ? 'definition.notFound' : 'definition.noDictLang');
      return setDef({ ...emptyDefinition, word, anchor, failed: true, error, context });
    }
    try {
      const data = await AI.getWordDefinition(clean(word), context, near, aiCulture);
      if (mine()) setDef({ ...emptyDefinition, word, anchor, data, context });
    } catch (e) {
      if (mine()) setDef({ ...emptyDefinition, word, anchor, failed: true, error: (e as Error).message, context });
    }
  };

  // AI points at the dictionary meaning this sentence uses.
  const runPick = async (seq: number, word: string, ctx: string | undefined, dict: DictEntry[], around = '') => {
    setDef(d => ({ ...d, aiLoading: true, aiError: undefined }));
    try {
      const pick = await AI.pickSense(clean(word), clean(ctx ?? ''), senseList(dict).map(s => clean(s.line)), clean(around), getDictSources().aiCulture);
      if (seq === seqRef.current) setDef(d => ({ ...d, pick, aiLoading: false }));
    } catch (e) {
      if (seq === seqRef.current) setDef(d => ({ ...d, aiLoading: false, aiError: (e as Error).message }));
    }
  };
  const explain = () => { if (def.word && def.dict) runPick(seqRef.current, def.word, def.context, def.dict, def.around); };

  const closeDef = () => { seqRef.current++; setDef(emptyDefinition); };

  return { def, lookup, explain: AI.aiReady() ? explain : undefined, closeDef };
};

// The line before and after line `i`, for `around`.
export const aroundOf = (lines: { text: string }[], i: number): string =>
  i < 0 ? '' : [lines[i - 1]?.text, lines[i + 1]?.text].filter(Boolean).join('\n');
