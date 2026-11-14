import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { vocabApi } from '../../utils/vocab/api';
import { hasQuestionModel } from '../../utils/vocab/recallModel';
import { requestSceneLabels, sceneKey, SCENES, sceneTitle, uniqueSentences } from '../../utils/vocab/scenes';
import type { ExampleScene } from '../../utils/vocab/types';

// 048 例句场景标注：闪卡背面每个例句后面一个场景标签（只在背面；复习、首考作答界面不用这个组件）。
// - 翻到背面时一个词一次请求，把还没标过的句子一起发给模型；结果存库。会话里记着「已经试过」的句子，来回翻不再请求。
// - 请求中不显示标签；没配模型或失败：不显示标签、不弹错（失败的句子下次翻到再试）。
// - 点标签 / 点「＋场景」弹出 10 个选项，选了存为「手动」，之后 AI 不再覆盖。

export interface SceneControl {
  get: (sentence: string) => ExampleScene | undefined;
  isPending: (sentence: string) => boolean;
  setManual: (sentence: string, scene: string) => Promise<void>;
}

export interface ExampleScenes {
  control: SceneControl;
  /** 列表读完了（读完前不判断「哪些没标过」，免得误发请求）。 */
  loaded: boolean;
  /** 给一个词补标：只发还没标过、本次会话也没试过的句子。 */
  ensure: (word: string, sentences: readonly string[]) => void;
}

export function useExampleScenes(): ExampleScenes {
  const [scenes, setScenes] = useState<Map<string, ExampleScene>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const scenesRef = useRef(scenes);
  scenesRef.current = scenes;
  const attempted = useRef(new Set<string>());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    vocabApi.listScenes()
      .then(list => { if (alive.current) { setScenes(new Map(list.map(item => [item.key, item]))); setLoaded(true); } })
      .catch(() => { /* 读不到就当都没标；不弹错 */ if (alive.current) setLoaded(true); });
    return () => { alive.current = false; };
  }, []);

  const merge = useCallback((list: ExampleScene[]) => {
    if (!alive.current) return;
    setScenes(old => {
      const next = new Map(old);
      for (const item of list) next.set(item.key, item);
      return next;
    });
  }, []);

  const ensure = useCallback((word: string, sentences: readonly string[]) => {
    if (!loaded || !hasQuestionModel()) return;
    const todo = uniqueSentences(sentences).filter(sentence => {
      const key = sceneKey(sentence);
      return !scenesRef.current.has(key) && !attempted.current.has(key);
    });
    if (todo.length === 0) return;
    const keys = todo.map(sceneKey);
    keys.forEach(key => attempted.current.add(key));
    setPending(old => new Set([...old, ...keys]));
    const done = () => { if (alive.current) setPending(old => new Set([...old].filter(key => !keys.includes(key)))); };
    requestSceneLabels(word, todo)
      .then(async labels => {
        if (labels.length === 0) return;
        merge(await vocabApi.setScenes({ source: 'AI', items: labels.map(label => ({ sentence: label.sentence, scene: label.scene })) }));
      })
      .catch(() => { keys.forEach(key => attempted.current.delete(key)); /* 失败：不弹错，下次翻到再试 */ })
      .finally(done);
  }, [loaded, merge]);

  const control = useMemo<SceneControl>(() => ({
    get: sentence => scenes.get(sceneKey(sentence)),
    isPending: sentence => pending.has(sceneKey(sentence)),
    setManual: async (sentence, scene) => {
      const saved = await vocabApi.setScenes({ source: '手动', items: [{ sentence, scene }] });
      attempted.current.add(sceneKey(sentence));
      merge(saved);
    },
  }), [scenes, pending, merge]);

  return { control, loaded, ensure };
}

/**
 * 一句例句后面的标签。外层 data-flash-notes：点这里不翻面，焦点在里面时闪卡快捷键让开。
 * 请求中且还没标：什么都不显示。
 */
export default function SceneTag({ sentence, control }: { sentence: string; control: SceneControl }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const found = control.get(sentence);
  const pending = control.isPending(sentence);
  if (!found && pending) return null;

  const choose = async (scene: string) => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await control.setManual(sentence, scene);
      setOpen(false);
    } catch (reason) {
      setError(`保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <span
      className="vocab-scene"
      data-flash-notes=""
      data-testid="scene-wrap"
      onKeyDown={event => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); } }}
    >
      <button
        type="button"
        onClick={() => { setOpen(value => !value); setError(''); }}
        aria-expanded={open}
        title={found ? `${sceneTitle(found.scene)}${found.source === '手动' ? '（手动）' : '（AI）'}；点击修改` : '选一个写作场景'}
        className={found ? 'vocab-q-tag vocab-scene-tag' : 'vocab-q-tag vocab-scene-add'}
        data-testid={found ? 'scene-tag' : 'scene-add'}
        data-scene={found?.scene}
        data-source={found?.source}
      >
        {found ? found.scene : '＋场景'}
      </button>
      {open && (
        <span className="vocab-scene-picker" role="group" aria-label="选择写作场景" data-testid="scene-picker">
          {SCENES.map(scene => (
            <button
              key={scene.id}
              type="button"
              disabled={saving}
              onClick={() => { void choose(scene.id); }}
              title={`${scene.id} · ${scene.zh}`}
              className={`vocab-q-tag vocab-scene-option${found?.scene === scene.id ? ' is-current' : ''}`}
              data-testid={`scene-option-${scene.id}`}
            >
              {scene.id}<span className="vocab-scene-zh">{scene.zh}</span>
            </button>
          ))}
          {error && <span role="alert" className="text-xs text-danger">{error}</span>}
        </span>
      )}
    </span>
  );
}
