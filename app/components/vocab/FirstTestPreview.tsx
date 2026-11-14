import React, { useEffect, useMemo, useState } from 'react';
import { IS_MOBILE } from '../../utils/platform';
import { ArrowRight, BookOpen, SkipForward, X } from 'lucide-react';
import { vocabApi } from '../../utils/vocab/api';
import { advanceFirstTestPreview, initialFirstTestPreview, revealFirstTestDefinition } from '../../utils/vocab/firstTestPreview';
import { realExamplesFirst } from '../../utils/vocab/library';
import { groupNotes, noteKey } from '../../utils/vocab/notes';
import type { BrowseReviewWord, VocabNote } from '../../utils/vocab/types';
import './vocab.css';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

interface Props {
  words: readonly BrowseReviewWord[];
  onStart: (previewed: ReadonlySet<string>) => void;
  onExit: () => void;
}

/** 首考前逐词预习。这里只读词库和笔记；退出、跳过、看释义本身都不写数据库。 */
export default function FirstTestPreview({ words, onStart, onExit }: Props) {
  const [state, setState] = useState(initialFirstTestPreview);
  const [notes, setNotes] = useState<VocabNote[]>([]);
  const [notesError, setNotesError] = useState('');
  const [notesLoading, setNotesLoading] = useState(true);
  const notesByKey = useMemo(() => groupNotes(notes), [notes]);

  useEffect(() => {
    let alive = true;
    vocabApi.listNotes().then(list => {
      if (!alive) return;
      setNotes(list);
      setNotesLoading(false);
    }).catch(reason => {
      if (!alive) return;
      setNotesError(`读取用户笔记失败：${errorText(reason)}`);
      setNotesLoading(false);
    });
    return () => { alive = false; };
  }, []);

  const word = words[state.index];
  if (!word) return null;
  const last = state.index + 1 === words.length;
  const wordNotes = notesByKey.get(noteKey(word.word)) ?? [];
  const hasDefinition = word.definitions.some(definition =>
    definition.pos || definition.english || definition.chinese || definition.examples.length > 0);

  const next = () => {
    if (last) onStart(state.previewed);
    else setState(advanceFirstTestPreview);
  };
  const btn = 'press inline-flex items-center justify-center gap-1.5 rounded-full border border-line bg-page px-4 py-2 text-sm text-ink hover:border-ink/30';

  return (
    <div className={`vocab-flash-overlay vocab-recall-overlay${IS_MOBILE ? ' vocab-quiz-m' : ''}`} role="dialog" aria-modal="true" aria-label="首考前预习" data-testid="first-test-preview">
      <div className="vocab-flash-inner vocab-quiz-inner vocab-wrap">
        <header className="vocab-quiz-top">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="vocab-quiz-title">首考前预习</span>
              <span className="text-sm text-mute" data-testid="first-preview-progress">{state.index + 1} / {words.length}</span>
            </div>
            <div className="vocab-flash-bar mt-2" aria-hidden="true">
              <div className="vocab-flash-bar-fill" style={{ width: `${((state.index + 1) / words.length) * 100}%` }} />
            </div>
          </div>
          <button type="button" onClick={onExit} className={btn} data-testid="first-preview-exit">
            <X size={16} />退出
          </button>
        </header>

        <p className="vocab-quiz-guide">想得起来就下一个，想不起来再看释义。看过释义的词，这次答对也先进 L1，两天后再确认。</p>

        <section className="vocab-quiz-panel mt-5">
          <div className="vocab-wrap py-5 text-center font-serif text-4xl font-semibold leading-tight text-ink md:py-8 md:text-6xl" data-testid="first-preview-word">
            {word.word}
          </div>

          {state.revealed && (
            <div className="mt-2 border-t border-line pt-5 text-left" data-testid="first-preview-definition">
              {!hasDefinition ? (
                <p className="text-sm text-mute" data-testid="first-preview-no-definition">暂无释义</p>
              ) : (
                <ol className="vocab-flash-defs">
                  {word.definitions.map((definition, index) => (
                    <li key={`${definition.sourceFile}-${definition.sourceLine}-${index}`} className="vocab-flash-def">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        {word.definitions.length > 1 && <span className="text-sm font-semibold text-mute">{index + 1}.</span>}
                        {definition.pos && <span className="vocab-q-pos">{definition.pos}</span>}
                      </div>
                      {definition.english && <p className="vocab-flash-def-en vocab-wrap">{definition.english}</p>}
                      {definition.chinese && <p className="vocab-flash-def-zh vocab-wrap">{definition.chinese}</p>}
                      {definition.examples.length > 0 && (
                        <ul className="mt-2 space-y-1.5" data-testid="first-preview-examples">
                          {realExamplesFirst(definition.examples).map(example => (
                            <li key={example.seq} className="vocab-flash-example vocab-wrap">{example.sentence}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ol>
              )}

              <div className="mt-5 border-t border-dashed border-line pt-4" data-testid="first-preview-notes">
                <h3 className="vocab-quiz-h3">用户笔记</h3>
                {notesLoading && <p className="mt-2 text-sm text-mute">正在读取用户笔记…</p>}
                {notesError && <p role="alert" className="mt-2 text-sm text-danger">{notesError}</p>}
                {!notesLoading && !notesError && wordNotes.length === 0 && <p className="mt-2 text-sm text-mute">暂无用户笔记</p>}
                {wordNotes.length > 0 && (
                  <ul className="mt-2 space-y-2">
                    {wordNotes.map(note => <li key={note.id} className="vocab-wrap whitespace-pre-wrap text-sm leading-relaxed text-ink">{note.body}</li>)}
                  </ul>
                )}
              </div>
            </div>
          )}
        </section>

        <div className="vocab-quiz-footer">
          <button type="button" onClick={() => onStart(state.previewed)} className="press inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm text-mute hover:text-ink" data-testid="first-preview-skip">
            <SkipForward size={15} />跳过，直接开考
          </button>
          <div className="flex flex-wrap gap-2">
            {!state.revealed && (
              <button type="button" onClick={() => setState(current => revealFirstTestDefinition(current, word.id))} className={btn} data-testid="first-preview-reveal">
                <BookOpen size={16} />看释义
              </button>
            )}
            <button type="button" onClick={next} className="press inline-flex items-center justify-center gap-1.5 rounded-full bg-ink px-5 py-2 text-sm text-white" data-testid="first-preview-next">
              {last ? '开始答题' : '下一个'}<ArrowRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
