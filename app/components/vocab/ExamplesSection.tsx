import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { IS_MOBILE } from '../../utils/platform';
import { Loader2, PenLine, Quote, Sparkles, Trash2 } from 'lucide-react';
import HelpHint from './HelpHint';
import { vocabApi } from '../../utils/vocab/api';
import {
  addExamplesTo,
  groupExamples,
  MAX_OWN_SENTENCE,
  notifyExamplesChanged,
  onExamplesChanged,
  removeExample,
  senseLabel,
} from '../../utils/vocab/examples';
import type { ExampleSense, OwnCheckRecord } from '../../utils/vocab/examples';
import { dismissOwnCheck, EXAMPLE_CHECK_KIND, startOwnSentenceCheck, visibleOwnCheck } from '../../utils/vocab/ownCheckTask';
import { dismissExampleGen, EXAMPLE_GEN_KIND, startExampleGen, visibleExampleGen } from '../../utils/vocab/exampleGenTask';
import { aiPanelState } from '../ai/panelState';
import { isLiveTask, useAiTasksBy } from '../ai/useAiTasksBy';
import OwnCheckResult from '../ai/OwnCheckResult';
import ExampleGenResult from '../ai/ExampleGenResult';
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
  // 「让 AI 看看」的任务在任务中心里（来源：这个词），切页面再回来也能找回；小窗里的同一条任务也共用它。
  const ownTasks = useAiTasksBy({ kind: EXAMPLE_CHECK_KIND, word });
  const ownTask = visibleOwnCheck(ownTasks);
  const ownLive = isLiveTask(ownTasks[0]);
  const ownShown = !!(ownTask?.result as OwnCheckRecord | undefined)?.check; // 已有判定结果（没有就显示「直接存」）

  // 「AI 给例句」的任务（093）：来源是这个词，切页面再回来、小窗里的同一条都能找回。
  const genTasks = useAiTasksBy({ kind: EXAMPLE_GEN_KIND, word });
  const genTask = visibleExampleGen(genTasks);
  const genLive = isLiveTask(genTasks[0]);

  const [panel, setPanel] = useState<Panel>(() => (!compact && genTask ? 'generate' : !compact && ownTask ? 'own' : 'none'));
  const [senseIndex, setSenseIndex] = useState(0);
  const sense = senses[Math.min(senseIndex, senses.length - 1)] ?? { pos: '', english: '', chinese: '' };
  const senseText = senseLabel(sense);
  const modelOn = hasQuestionModel();
  const [tip, setTip] = useState('');

  // ---- AI 给例句：只剩「建任务失败」的一句提示，候选在任务里（ExampleGenResult）
  const [genError, setGenError] = useState('');
  // ---- 自己写
  const [draft, setDraft] = useState('');
  const [ownError, setOwnError] = useState('');
  // 判句存了（任一处）或都不存：草稿清掉，免得同一句再点又建一个任务。
  const ownRecord = ownTasks[0]?.result as OwnCheckRecord | undefined;
  useEffect(() => {
    // 改草稿造成的收起不算（否则重新打一句和旧结果一样的话，刚打的就被清掉）。
    if (!ownRecord || ownRecord.edited || !(ownRecord.saved || ownRecord.dismissed)) return;
    setDraft(current => (current.replace(/\s+/g, ' ').trim() === ownRecord.original ? '' : current));
  }, [ownRecord]);
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

  // 建一个「AI 给例句」任务后台去跑；建完小窗展开到这条。候选、勾选在任务里，这里和小窗都能看、能存。
  const generate = () => {
    if (genLive || !modelOn) return;
    setGenError('');
    setSaveError('');
    setTip('');
    const outcome = startExampleGen(word, sense);
    if ('reason' in outcome) setGenError(outcome.reason);
    else aiPanelState.reveal(outcome.task.id);
  };
  const onGenSaved = (saved: VocabExample[]) => {
    handlers.onSaved(saved);
    setTip(`已存 ${saved.length} 句。`);
  };

  // 建一个「让 AI 看」任务后台去跑（切页面不断），结果在这里和小窗里都能看、能存。
  const check = () => {
    if (ownLive || !modelOn || !draft.trim()) return;
    setOwnError('');
    setSaveError('');
    setTip('');
    const outcome = startOwnSentenceCheck(word, sense, draft);
    if ('reason' in outcome) setOwnError(outcome.reason);
  };

  // 改了草稿：上一条结果（不在跑的）收起，和原来「改了就清掉结果」一样。
  const onDraftChange = (value: string) => {
    setDraft(value);
    setOwnError('');
    if (ownTask && !ownLive) dismissOwnCheck(ownTask, true);
  };

  const resetOwn = () => { setDraft(''); setOwnError(''); };
  const open = (next: Panel) => { setPanel(current => (current === next ? 'none' : next)); setTip(''); setSaveError(''); };
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
                onChange={event => { setSenseIndex(Number(event.target.value)); if (genTask && !genLive) dismissExampleGen(genTask); if (ownTask && !ownLive) dismissOwnCheck(ownTask, true); }}
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
                <button type="button" onClick={() => generate()} disabled={!modelOn || genLive} className={btnPrimary} data-testid="example-generate">
                  {genLive ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  {genLive ? 'AI 正在写…（在小窗里看进度）' : genTask ? '换一批' : '让 AI 写 2–3 句'}
                </button>
                <span className="text-xs text-mute">只发这个词、词性和所选意思。</span>
              </div>
              {genError && <p role="alert" className="vocab-wrap mt-2 text-xs text-danger" data-testid="example-generate-error">{genError}</p>}
              {genTask && <ExampleGenResult task={genTask} onSaved={onGenSaved} />}
            </div>
          )}

          {panel === 'own' && (
            <div className="mt-2">
              <textarea
                value={draft}
                onChange={event => onDraftChange(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void check(); } }}
                rows={3}
                maxLength={MAX_OWN_SENTENCE}
                placeholder={IS_MOBILE ? `用 ${word} 写一句，让 AI 看看` : `用 ${word} 写一句（Ctrl+Enter 让 AI 看）`}
                aria-label={`用 ${word} 写一句`}
                className="vocab-note-input"
                data-testid="own-input"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" onClick={() => check()} disabled={!modelOn || ownLive || !draft.trim()} className={btnPrimary} data-testid="own-check">
                  {ownLive ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  {ownLive ? 'AI 正在看…（在小窗里看进度）' : '让 AI 看看'}
                </button>
                {!ownShown && (
                  <button type="button" onClick={() => void save([{ sentence: draft, source: '自己写' }], resetOwn)} disabled={saving || !draft.trim()} className={btnPlain} data-testid="own-save-direct">
                    不用看，直接存
                  </button>
                )}
              </div>
              {ownError && <p role="alert" className="vocab-wrap mt-2 text-xs text-danger" data-testid="own-error">{ownError}</p>}
              {ownTask && <OwnCheckResult task={ownTask} onSaved={handlers.onSaved} />}
            </div>
          )}
          {saveError && <p role="alert" className="vocab-wrap mt-2 text-xs text-danger" data-testid="example-save-error">{saveError}</p>}
        </div>
      )}
    </div>
  );
}
