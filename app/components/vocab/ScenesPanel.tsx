import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { vocabApi } from '../../utils/vocab/api';
import { emptyBrowse } from '../../utils/vocab/browse';
import { buildLibrary } from '../../utils/vocab/library';
import { groupNotes, onNotesChanged, removeNote, upsertNote } from '../../utils/vocab/notes';
import { onVocabChanged } from '../../utils/vocab/manualAdd';
import { onExamplesChanged } from '../../utils/vocab/examples';
import { hasQuestionModel } from '../../utils/vocab/recallModel';
import { SCENES, requestSceneLabels, sceneTitle } from '../../utils/vocab/scenes';
import type { SceneId } from '../../utils/vocab/scenes';
import {
  backfillGroups,
  buildSceneRows,
  countByScene,
  labelledCount,
  rowsForScene,
  runBackfill,
  sentenceParts,
} from '../../utils/vocab/sceneBrowse';
import type { BackfillGroup, BackfillProgress, BackfillResult } from '../../utils/vocab/sceneBrowse';
import type { BrowseData, ExampleScene, ReviewMetadataResult, VocabExample, VocabNote } from '../../utils/vocab/types';
import EntryDetail from './EntryDetail';
import type { Selection } from './EntryDetail';
import type { NoteHandlers } from './NotesSection';
import './vocab.css';

// 049 按场景找词：词库页的「按场景找」分页。
// - 上面 10 个场景按钮，每个后面有句数；选中后列出标了这个场景的例句（词库例句 + 我的例句），句中的词高亮。
// - 「补标剩下的」：只发还没有任何标签的句子，一个词一次请求；确认后开跑，可以中途停止，已标的照常保存。
// - 手动标过的句子本来就有标签，不会进补标；后端也不会用 AI 覆盖手动。

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

type Phase = 'idle' | 'confirm' | 'running' | 'done';

// 只在「按场景找」分页打开时才挂载（VocabPage 里用 view 条件渲染）。离开分页 = 卸载 = 补标在下一个词前停下。
export default function ScenesPanel() {
  const [data, setData] = useState<BrowseData>(emptyBrowse());
  const [notes, setNotes] = useState<VocabNote[]>([]);
  const [examples, setExamples] = useState<VocabExample[]>([]);
  const [scenes, setScenes] = useState<Map<string, ExampleScene>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scene, setScene] = useState<SceneId | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  // 被点的那一行（词 + 句子）。只高亮这一行，同一个词的其他例句行不跟着亮（049 返工）。
  const [pickedRow, setPickedRow] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<BackfillProgress | null>(null);
  const [result, setResult] = useState<BackfillResult | null>(null);
  const [stopping, setStopping] = useState(false);
  const stopRef = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // 卸载（切走分页）时让补标在下一个词前停下；已经在飞的那个词照常保存。
      stopRef.current = true;
    };
  }, []);

  const load = useCallback(() => {
    setError('');
    Promise.all([vocabApi.browse(), vocabApi.listNotes(), vocabApi.listExamples(), vocabApi.listScenes()])
      .then(([browse, noteList, exampleList, sceneList]) => {
        if (!alive.current) return;
        setData(browse);
        setNotes(noteList);
        setExamples(exampleList);
        setScenes(new Map(sceneList.map(item => [item.key, item])));
        setLoading(false);
      })
      .catch(reason => {
        if (!alive.current) return;
        setError(`读取词库失败：${errorText(reason)}`);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 手动加词、导入、我的例句变动后重读；笔记单独重读。
  useEffect(() => onVocabChanged(load), [load]);
  useEffect(() => onExamplesChanged(load), [load]);
  useEffect(() => onNotesChanged(() => {
    vocabApi.listNotes().then(list => { if (alive.current) setNotes(list); }).catch(() => {});
  }), []);

  const rows = useMemo(() => buildSceneRows(data, examples), [data, examples]);
  const counts = useMemo(() => countByScene(rows, scenes), [rows, scenes]);
  const labelled = useMemo(() => labelledCount(rows, scenes), [rows, scenes]);
  const groups = useMemo(() => backfillGroups(rows, scenes), [rows, scenes]);
  const pendingSentences = groups.reduce((sum, group) => sum + group.sentences.length, 0);
  const library = useMemo(() => buildLibrary(data, groupNotes(notes)), [data, notes]);
  const shown = useMemo(() => (scene ? rowsForScene(rows, scenes, scene) : []), [rows, scenes, scene]);
  // 每次渲染都看一眼设置里模型配好没有（读的是本机设置，很快）。
  const modelReady = hasQuestionModel();

  const reviewMetadataSaved = (saved: ReviewMetadataResult) => {
    setData(current => ({
      ...current,
      reviewWords: current.reviewWords.map(item => item.id === saved.id
        ? { ...item, source: saved.source, verificationStatus: saved.verificationStatus }
        : item),
    }));
  };

  const noteHandlers: NoteHandlers = {
    onSaved: note => setNotes(current => upsertNote(current, note)),
    onDeleted: id => setNotes(current => removeNote(current, id)),
  };

  const startBackfill = async (toRun: BackfillGroup[]) => {
    stopRef.current = false;
    setStopping(false);
    setResult(null);
    setProgress({ done: 0, total: toRun.length, labelled: 0, failed: 0, lastError: '' });
    setPhase('running');
    const outcome = await runBackfill(toRun, {
      request: (word, sentences) => requestSceneLabels(word, sentences),
      save: async labelsToSave => {
        const saved = await vocabApi.setScenes({
          source: 'AI',
          items: labelsToSave.map(label => ({ sentence: label.sentence, scene: label.scene })),
        });
        if (alive.current) {
          setScenes(old => {
            const next = new Map(old);
            for (const item of saved) next.set(item.key, item);
            return next;
          });
        }
      },
      stopRequested: () => stopRef.current,
      onProgress: next => { if (alive.current) setProgress(next); },
    });
    if (!alive.current) return;
    setResult(outcome);
    setPhase('done');
  };

  if (loading) return <p className="text-sm text-mute" role="status">正在读取词库…</p>;

  if (error) {
    return (
      <div role="alert" className="rounded-xl border border-danger/30 bg-danger-soft p-4 text-sm text-danger">
        <div className="vocab-wrap">{error}</div>
        <button type="button" onClick={load} className="press mt-3 rounded-lg border border-danger/30 bg-page px-3 py-1.5 text-danger">
          <RefreshCw className="mr-1.5 inline" size={14} />重试
        </button>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <section className="rounded-2xl border border-line bg-page p-6 text-center" data-testid="scenes-empty">
        <p className="text-sm text-mute">词库里还没有例句。导入词库，或在「我的例句」里加几句后，这里就能按场景找。</p>
      </section>
    );
  }

  const selectScene = (id: SceneId) => {
    setScene(current => (current === id ? null : id));
    setSelection(null);
    setPickedRow(null);
  };

  return (
    <section className="rounded-2xl border border-line bg-page p-4 md:p-5" data-testid="vocab-scenes">
      <p className="text-sm text-mute">选一个写作场景，看哪些例句用了它，句中的词是哪个。想表达「比较」「让步」「下定义」时，可以从这里找用词。</p>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5" role="group" aria-label="写作场景">
        {SCENES.map(item => {
          const chosen = scene === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={chosen}
              title={sceneTitle(item.id)}
              onClick={() => selectScene(item.id)}
              data-testid={`scene-chip-${item.id}`}
              className={`press rounded-xl border px-3 py-2 text-left text-sm ${chosen ? 'border-ink bg-ink text-white' : 'border-line text-ink hover:border-ink/30'}`}
            >
              <span className="block font-medium">{item.id}</span>
              <span className={`block text-xs ${chosen ? 'text-white/80' : 'text-mute'}`}>{item.zh} · {counts[item.id] ?? 0} 句</span>
            </button>
          );
        })}
      </div>

      <div className="mt-4 rounded-xl bg-shade p-3 text-sm" data-testid="scene-backfill">
        <p className="text-ink" data-testid="scene-coverage">已标 {labelled} 句 / 共 {rows.length} 句</p>

        {(phase === 'idle' || phase === 'done') && pendingSentences > 0 && (
          modelReady ? (
            <button
              type="button"
              onClick={() => setPhase('confirm')}
              className="press mt-2 rounded-full border border-line bg-page px-4 py-1.5 text-ink hover:border-ink/30"
            >
              补标剩下的（{pendingSentences} 句）
            </button>
          ) : (
            <button type="button" disabled className="mt-2 cursor-not-allowed rounded-full border border-line bg-page px-4 py-1.5 text-mute opacity-60">
              补标剩下的（先在「设置」配好模型）
            </button>
          )
        )}

        {phase === 'confirm' && (
          <div className="mt-2" data-testid="scene-confirm">
            <p className="text-ink">
              将按词请求模型：共 {groups.length} 个词，大约请求 {groups.length} 次，{pendingSentences} 句。已标的不会重标，手动标过的不动。
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={() => { void startBackfill(groups); }} className="press rounded-full bg-ink px-4 py-1.5 text-white">开始补标</button>
              <button type="button" onClick={() => setPhase('idle')} className="press rounded-full border border-line bg-page px-4 py-1.5 text-ink">取消</button>
            </div>
          </div>
        )}

        {phase === 'running' && progress && (
          <div className="mt-2" role="status" data-testid="scene-progress">
            <p className="text-ink">
              补标中：已处理 {progress.done} / {progress.total} 个词，已标 {progress.labelled} 句{progress.failed > 0 ? `，${progress.failed} 个词失败` : ''}
            </p>
            <button
              type="button"
              disabled={stopping}
              onClick={() => { stopRef.current = true; setStopping(true); }}
              className="press mt-2 rounded-full border border-line bg-page px-4 py-1.5 text-ink disabled:opacity-50"
            >
              {stopping ? '正在停止（等这一个词完成）…' : '停止'}
            </button>
          </div>
        )}

        {phase === 'done' && result && (
          <div className="mt-2" data-testid="scene-done">
            <p className="text-ink">
              {result.stopped
                ? `已停止。已标的 ${result.labelled} 句已保存；还没标的保持没标。`
                : `补标完成：新标 ${result.labelled} 句。`}
            </p>
            {result.failed > 0 && (
              <p role="alert" className="mt-1 text-xs text-danger">
                {result.failed} 个词请求失败没标上，可以再点「补标剩下的」重试。原因：{result.lastError}
              </p>
            )}
          </div>
        )}
      </div>

      {scene && (
        <div className="vocab-browse mt-4" data-has-detail={selection !== null}>
          <div className="vocab-list-col min-w-0">
            {shown.length === 0 ? (
              <p className="rounded-xl bg-shade p-4 text-sm text-mute" data-testid="scene-no-result">
                这个场景还没有例句。可以点上面的「补标剩下的」，或在闪卡背面给例句手动选场景。
              </p>
            ) : (
              <ul className="vocab-list space-y-2" data-testid="scene-list">
                {shown.map(row => {
                  const rowKey = `${row.wordKey}|${row.sentence}`;
                  const selected = pickedRow === rowKey;
                  return (
                    <li key={rowKey}>
                      <button
                        type="button"
                        aria-current={selected}
                        onClick={() => { setPickedRow(rowKey); setSelection({ kind: 'word', id: row.wordKey }); }}
                        className="vocab-row press w-full"
                        data-testid="scene-row"
                      >
                        <span className="flex items-start gap-2">
                          <span className="vocab-wrap min-w-0 flex-1 font-semibold text-ink">{row.word}</span>
                          <span className="vocab-chip shrink-0 border-line bg-page text-mute">{row.from}</span>
                        </span>
                        <span className="vocab-wrap mt-1 block text-sm text-ink/80">
                          {sentenceParts(row.sentence, row.word).map((part, index) => part.hit
                            ? <mark key={index} className="vocab-mark">{part.text}</mark>
                            : <React.Fragment key={index}>{part.text}</React.Fragment>)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="vocab-detail-col min-w-0">
            {selection && (
              <button type="button" onClick={() => { setSelection(null); setPickedRow(null); }} data-testid="vocab-back" className="vocab-back press mb-3 inline-flex items-center gap-1 rounded-full border border-line px-3 py-1.5 text-sm text-ink">
                <ArrowLeft size={14} />返回列表
              </button>
            )}
            {selection && !library.wordByKey.has(selection.id) && (
              <p className="mb-3 text-sm text-mute" data-testid="scene-not-in-review">这个词还不在复习词库里，只有「我的例句」，没有词条详情。</p>
            )}
            <EntryDetail selection={selection} library={library} query="" onOpen={setSelection} onReviewMetadataSaved={reviewMetadataSaved} noteHandlers={noteHandlers} />
          </div>
        </div>
      )}
    </section>
  );
}
