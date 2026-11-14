import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { IS_MOBILE } from '../../utils/platform';
import { Check, Loader2, PenLine, Plus, Quote, Sparkles, Trash2 } from 'lucide-react';
import HelpHint from './HelpHint';
import { vocabApi } from '../../utils/vocab/api';
import {
  addExamplesTo,
  checkOwnSentence,
  generatedExplanation,
  groupExamples,
  MAX_OWN_SENTENCE,
  notifyExamplesChanged,
  onExamplesChanged,
  removeExample,
  requestExamples,
  senseLabel,
} from '../../utils/vocab/examples';
import type { ExampleSense, GeneratedExample, SentenceCheck } from '../../utils/vocab/examples';
import SceneTag from './SceneTag';
import type { SceneControl } from './SceneTag';
import { formatNoteTime } from '../../utils/vocab/notes';
import { hasQuestionModel } from '../../utils/vocab/recallModel';
import type { ExampleItem, VocabExample } from '../../utils/vocab/types';
import VoiceButton from './VoiceButton';

// 043 我的例句：看、删、AI 给例句（勾选后存）、自己写一句让 AI 改（存原句 / 存改后 / 都不存）。
// 句子都按纯文本节点放在 <p> 里（React 自动转义），外层 Lookable 能点里面的英文词查词；按钮、输入框、下拉框不触发查词。
// 复习/首考作答中不渲染这个组件（防泄题），由调用方保证。

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export interface ExampleHandlers {
  onSaved: (examples: VocabExample[]) => void;
  onDeleted: (id: number) => void;
}

/**
 * 读一次全部例句，别处改了（广播）就重读。enabled 为 false 时不读（复习作答中用）。
 */
export function useMyExamples(enabled = true): { byKey: Map<string, VocabExample[]>; handlers: ExampleHandlers; error: string } {
  const [examples, setExamples] = useState<VocabExample[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => vocabApi.listExamples()
      .then(list => { if (alive) { setExamples(list); setError(''); } })
      .catch(reason => { if (alive) setError(`读取例句失败：${errorText(reason)}`); });
    void load();
    const off = onExamplesChanged(() => { void load(); });
    return () => { alive = false; off(); };
  }, [enabled]);
  const byKey = useMemo(() => groupExamples(examples), [examples]);
  const handlers = useMemo<ExampleHandlers>(() => ({
    onSaved: added => setExamples(list => addExamplesTo(list, added)),
    onDeleted: id => setExamples(list => removeExample(list, id)),
  }), []);
  return { byKey, handlers, error };
}

const SOURCE_CLASS: Record<string, string> = {
  AI生成: 'border-clay/30 bg-clay-soft text-clay',
  自己写: 'border-line bg-page text-ink',
  AI改过: 'border-accent/30 bg-accent-soft text-accent',
};

const btnPrimary = 'press inline-flex items-center gap-1 rounded-lg bg-ink px-3 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-45';
const btnSmall = 'press inline-flex items-center gap-1 rounded-lg border border-line bg-page px-2.5 py-1 text-xs text-ink hover:border-ink/30';
const btnPlain = 'press inline-flex items-center gap-1 rounded-lg border border-line bg-page px-3 py-1.5 text-sm text-ink hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-45';

function ExampleItemView({ example, handlers, scenes }: { example: VocabExample; handlers: ExampleHandlers; scenes?: SceneControl }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await vocabApi.deleteExample(example.id);
      handlers.onDeleted(example.id);
      notifyExamplesChanged();
    } catch (reason) {
      setError(`删除失败：${errorText(reason)}`);
      setBusy(false);
    }
  };
  return (
    <li className="vocab-note vocab-note-example" data-testid="example-item" data-example-id={example.id} data-source={example.source}>
      <div className="flex min-w-0 items-start gap-1">
        <p className="vocab-wrap min-w-0 flex-1 font-serif text-base leading-relaxed text-ink" data-testid="example-sentence">{example.sentence}</p>
        <VoiceButton text={example.sentence} kind="sentence" />
      </div>
      {scenes && <div className="mt-1" data-testid="example-scene"><SceneTag sentence={example.sentence} control={scenes} /></div>}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`vocab-chip ${SOURCE_CLASS[example.source] ?? SOURCE_CLASS.自己写}`} data-testid="example-source">{example.source}</span>
        <span className="text-xs text-mute">{formatNoteTime(example.createdAt)}</span>
        {!confirm && (
          <button type="button" onClick={() => { setConfirm(true); setError(''); }} className="press ml-auto inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs text-mute hover:bg-shade hover:text-danger" data-testid="example-delete">
            <Trash2 size={12} />删除
          </button>
        )}
      </div>
      {(example.original || example.explanation || example.sense) && (
        <dl className="mt-1.5 space-y-0.5 text-xs text-mute">
          {example.original && <div className="vocab-wrap"><dt className="inline">原句：</dt><dd className="inline" data-testid="example-original">{example.original}</dd></div>}
          {example.explanation && <div className="vocab-wrap"><dt className="inline">说明：</dt><dd className="inline" data-testid="example-explanation">{example.explanation}</dd></div>}
          {example.sense && <div className="vocab-wrap"><dt className="inline">义项：</dt><dd className="inline">{example.sense}</dd></div>}
        </dl>
      )}
      {confirm && (
        <div role="alertdialog" aria-label="确认删除例句" className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-ink" data-testid="example-delete-confirm">
          <span className="min-w-[10rem] flex-1">删除这句？删了找不回来。</span>
          <span className="flex shrink-0 gap-2">
            <button type="button" onClick={() => void remove()} disabled={busy} className="press rounded-lg bg-danger px-3 py-1.5 text-sm text-white disabled:opacity-45" data-testid="example-delete-yes">{busy ? '正在删除…' : '确定删除'}</button>
            <button type="button" onClick={() => setConfirm(false)} disabled={busy} className="press rounded-lg border border-line bg-page px-3 py-1.5 text-sm text-ink" data-testid="example-delete-no">不删了</button>
          </span>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    </li>
  );
}

type Panel = 'none' | 'generate' | 'own';

/**
 * 一个词的「我的例句」：列表 + AI 给例句 + 自己写让 AI 改。
 * senses 是可选的义项（多义项时先选）；compact = 小入口（闪卡反面、复习结果页），默认只显示条数和两个按钮。
 */
export default function ExamplesSection({ word, examples, senses, handlers, compact = false, scenes }: {
  word: string;
  examples: readonly VocabExample[];
  senses: readonly ExampleSense[];
  handlers: ExampleHandlers;
  compact?: boolean;
  /** 048：传了就在每句后面显示场景标签（只有闪卡背面传）。 */
  scenes?: SceneControl;
}) {
  const [panel, setPanel] = useState<Panel>('none');
  const [senseIndex, setSenseIndex] = useState(0);
  const sense = senses[Math.min(senseIndex, senses.length - 1)] ?? { pos: '', english: '', chinese: '' };
  const senseText = senseLabel(sense);
  const modelOn = hasQuestionModel();
  const [tip, setTip] = useState('');

  // ---- AI 给例句
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<GeneratedExample[]>([]);
  const [picked, setPicked] = useState<boolean[]>([]);
  const [genError, setGenError] = useState('');
  // ---- 自己写
  const [draft, setDraft] = useState('');
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<{ text: string; result: SentenceCheck } | null>(null);
  const [ownError, setOwnError] = useState('');
  // ---- 保存
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const save = useCallback(async (items: ExampleItem[], after: () => void) => {
    if (saving || items.length === 0) return;
    setSaving(true);
    setSaveError('');
    try {
      const saved = await vocabApi.addExamples({ word, items });
      handlers.onSaved(saved);
      notifyExamplesChanged();
      after();
      setTip(`已存 ${saved.length} 句。`);
    } catch (reason) {
      setSaveError(`保存失败：${errorText(reason)}`);
    } finally {
      setSaving(false);
    }
  }, [handlers, saving, word]);

  const generate = async () => {
    if (generating || !modelOn) return;
    setGenerating(true);
    setGenError('');
    setSaveError('');
    setTip('');
    setGenerated([]);
    setPicked([]);
    try {
      const list = await requestExamples(word, sense);
      setGenerated(list);
      setPicked(list.map(() => false));
    } catch (reason) {
      setGenError(errorText(reason));
    } finally {
      setGenerating(false);
    }
  };

  const check = async () => {
    if (checking || !modelOn || !draft.trim()) return;
    setChecking(true);
    setOwnError('');
    setSaveError('');
    setTip('');
    setChecked(null);
    const text = draft.replace(/\s+/g, ' ').trim();
    try {
      setChecked({ text, result: await checkOwnSentence(word, sense, text) });
    } catch (reason) {
      setOwnError(errorText(reason));
    } finally {
      setChecking(false);
    }
  };

  const resetOwn = () => { setDraft(''); setChecked(null); setOwnError(''); };
  const open = (next: Panel) => { setPanel(current => (current === next ? 'none' : next)); setTip(''); setSaveError(''); };
  const pickedCount = picked.filter(Boolean).length;
  const showList = !compact || examples.length > 0;

  return (
    <div data-testid="examples" data-word={word}>
      {showList && examples.length > 0 && (
        <ul className="space-y-2" data-testid="example-list">
          {examples.map(example => <ExampleItemView key={example.id} example={example} handlers={handlers} scenes={scenes} />)}
        </ul>
      )}
      {!compact && examples.length === 0 && (
        <div className="vocab-empty" data-testid="examples-empty">
          <Quote size={16} className="shrink-0 text-faint" />
          <span className="whitespace-nowrap">还没有例句</span>
          <HelpHint text={`可以让 AI 按意思给几句挑着存，也可以自己写一句让 AI 看看对不对。${IS_MOBILE ? '只存在本机。' : '只存在这台电脑上。'}`} />
        </div>
      )}

      <div className={`flex flex-wrap items-center gap-2 ${examples.length > 0 || !compact ? 'mt-3' : ''}`}>
        <button type="button" onClick={() => open('generate')} aria-expanded={panel === 'generate'} className={compact ? btnSmall : btnPlain} data-testid="example-ai-open">
          <Sparkles size={compact ? 12 : 14} />AI 给例句
        </button>
        <button type="button" onClick={() => open('own')} aria-expanded={panel === 'own'} className={compact ? btnSmall : btnPlain} data-testid="example-own-open">
          <PenLine size={compact ? 12 : 14} />自己写一句
        </button>
        {tip && <span className="text-xs text-success" role="status" data-testid="example-saved-tip">{tip}</span>}
      </div>

      {panel !== 'none' && (
        <div className="mt-3 rounded-xl border border-line bg-shade p-3" data-testid={`example-panel-${panel}`}>
          {senses.length > 1 ? (
            <label className="block text-xs text-mute">
              按哪个意思
              <select
                value={senseIndex}
                onChange={event => { setSenseIndex(Number(event.target.value)); setGenerated([]); setPicked([]); setChecked(null); }}
                className="mt-1 block w-full min-w-0 max-w-full truncate rounded-lg border border-line bg-page px-2 py-1.5 text-sm text-ink"
                data-testid="example-sense"
              >
                {senses.map((item, index) => <option key={index} value={index}>{`${index + 1}. ${senseLabel(item) || '（没有写意思）'}`}</option>)}
              </select>
            </label>
          ) : senseText ? (
            <p className="vocab-wrap text-xs text-mute" data-testid="example-sense-text">按这个意思：{senseText}</p>
          ) : null}
          {!modelOn && (
            <p className="mt-2 rounded-lg border border-clay/30 bg-clay-soft px-3 py-2 text-xs text-ink" data-testid="example-no-model">
              还没配模型：先在「设置」里填好接口地址、API Key 和模型名称，才能用 AI 给例句、改句子。{panel === 'own' && '自己写的句子现在也可以直接存。'}
            </p>
          )}

          {panel === 'generate' && (
            <div className="mt-2">
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => void generate()} disabled={!modelOn || generating} className={btnPrimary} data-testid="example-generate">
                  {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  {generating ? '正在请 AI 写…' : generated.length > 0 ? '换一批' : '让 AI 写 2–3 句'}
                </button>
                <span className="text-xs text-mute">只发这个词、词性和所选意思。</span>
              </div>
              {genError && <p role="alert" className="vocab-wrap mt-2 text-xs text-danger" data-testid="example-generate-error">{genError}</p>}
              {generated.length > 0 && (
                <>
                  <p className="mt-3 text-xs text-mute">勾选想存的句子（AI 写的，存前看一眼对不对）：</p>
                  <ul className="mt-1.5 space-y-2" data-testid="generated-list">
                    {generated.map((item, index) => (
                      <li key={index} className="vocab-note flex min-w-0 items-start gap-2" data-testid="generated-item">
                        <input
                          type="checkbox"
                          checked={picked[index] ?? false}
                          onChange={event => setPicked(list => list.map((value, i) => (i === index ? event.target.checked : value)))}
                          aria-label={`选第 ${index + 1} 句`}
                          className="mt-1.5 h-4 w-4 shrink-0"
                          data-testid="generated-check"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="vocab-wrap font-serif text-base leading-relaxed text-ink" data-testid="generated-sentence">{item.sentence}</p>
                          {(item.collocation || item.chinese) && (
                            <p className="vocab-wrap mt-0.5 text-xs text-mute">{generatedExplanation(item)}</p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void save(
                        generated.filter((_, index) => picked[index]).map(item => ({ sentence: item.sentence, source: 'AI生成', explanation: generatedExplanation(item) || null, sense: senseText || null })),
                        () => { setGenerated([]); setPicked([]); },
                      )}
                      disabled={saving || pickedCount === 0}
                      className={btnPrimary}
                      data-testid="generated-save"
                    >
                      <Plus size={14} />{saving ? '正在保存…' : `存勾选的 ${pickedCount} 句`}
                    </button>
                    <button type="button" onClick={() => { setGenerated([]); setPicked([]); }} disabled={saving} className={btnPlain} data-testid="generated-discard">都不要</button>
                  </div>
                </>
              )}
            </div>
          )}

          {panel === 'own' && (
            <div className="mt-2">
              <textarea
                value={draft}
                onChange={event => { setDraft(event.target.value); setChecked(null); setOwnError(''); }}
                onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void check(); } }}
                rows={3}
                maxLength={MAX_OWN_SENTENCE}
                placeholder={IS_MOBILE ? `用 ${word} 写一句，让 AI 看看` : `用 ${word} 写一句（Ctrl+Enter 让 AI 看）`}
                aria-label={`用 ${word} 写一句`}
                className="vocab-note-input"
                data-testid="own-input"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" onClick={() => void check()} disabled={!modelOn || checking || !draft.trim()} className={btnPrimary} data-testid="own-check">
                  {checking ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  {checking ? 'AI 正在看…' : '让 AI 看看'}
                </button>
                {!checked && (
                  <button type="button" onClick={() => void save([{ sentence: draft, source: '自己写' }], resetOwn)} disabled={saving || !draft.trim()} className={btnPlain} data-testid="own-save-direct">
                    不用看，直接存
                  </button>
                )}
              </div>
              {ownError && <p role="alert" className="vocab-wrap mt-2 text-xs text-danger" data-testid="own-error">{ownError}</p>}
              {checked && (
                <div
                  className={`mt-3 rounded-xl border p-3 text-sm ${checked.result.verdict === 'correct' ? 'border-success/30 bg-success-soft' : 'border-clay/30 bg-clay-soft'}`}
                  data-testid="own-result"
                  data-verdict={checked.result.verdict}
                >
                  <div className={`font-semibold ${checked.result.verdict === 'correct' ? 'text-success' : 'text-danger'}`} data-testid="own-verdict">{checked.result.label}</div>
                  <p className="vocab-wrap mt-1 text-ink" data-testid="own-reason">{checked.result.reason}</p>
                  {checked.result.changed && (
                    <div className="mt-2">
                      <div className="text-xs text-mute">改好的句子（只改必须改的地方）</div>
                      <p className="vocab-wrap font-serif text-base text-ink" data-testid="own-fixed">{checked.result.fixed}</p>
                    </div>
                  )}
                  {checked.result.better && (
                    <div className="mt-2">
                      <div className="text-xs text-mute">更地道的说法（可选）</div>
                      <p className="vocab-wrap font-serif text-base text-ink" data-testid="own-better">{checked.result.better}</p>
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void save([{ sentence: checked.text, source: '自己写', explanation: checked.result.reason, sense: senseText || null }], resetOwn)}
                      disabled={saving}
                      className={checked.result.changed ? btnPlain : btnPrimary}
                      data-testid="own-save-original"
                    >
                      <Check size={14} />存原句
                    </button>
                    {checked.result.changed && (
                      <button
                        type="button"
                        onClick={() => void save([{ sentence: checked.result.fixed, source: 'AI改过', explanation: checked.result.reason, sense: senseText || null, original: checked.text }], resetOwn)}
                        disabled={saving}
                        className={btnPrimary}
                        data-testid="own-save-fixed"
                      >
                        <Check size={14} />存改后
                      </button>
                    )}
                    {checked.result.better && (
                      <button
                        type="button"
                        onClick={() => void save([{ sentence: checked.result.better, source: 'AI改过', explanation: checked.result.reason, sense: senseText || null, original: checked.text }], resetOwn)}
                        disabled={saving}
                        className={btnPlain}
                        data-testid="own-save-better"
                      >
                        存更地道的
                      </button>
                    )}
                    <button type="button" onClick={resetOwn} disabled={saving} className={btnPlain} data-testid="own-discard">都不存</button>
                  </div>
                </div>
              )}
            </div>
          )}
          {saveError && <p role="alert" className="vocab-wrap mt-2 text-xs text-danger" data-testid="example-save-error">{saveError}</p>}
        </div>
      )}
    </div>
  );
}
