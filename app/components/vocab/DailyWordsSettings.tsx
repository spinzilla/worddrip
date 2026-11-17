import React, { useEffect, useState } from 'react';
import { Group } from '../ui';
import { MAX_PER_DAY, PACKS, PER_DAY_PRESETS, getPlan, onPlanChanged, type Plan } from '../../utils/vocab/dailyWords';
import { savePlanSynced, watchPlan } from '../../utils/vocab/dailyPlanSync';
import { getLevelResult, onLevelResultChanged, openOnboarding } from '../../utils/vocab/onboarding';

/** 081 设置 → 卡片与复习 →「每日新词」：选词表（多选）、每天几个、词库页的卡片开关。存在词库里（会同步），本机只当缓存。 */
export default function DailyWordsSettings({ onSaved }: { onSaved: () => void }) {
  const [plan, setPlan] = useState<Plan>(getPlan);
  const [custom, setCustom] = useState('');
  const [level, setLevel] = useState(getLevelResult);
  useEffect(() => onLevelResultChanged(() => setLevel(getLevelResult())), []);
  useEffect(() => onPlanChanged(() => setPlan(getPlan())), []);
  useEffect(() => watchPlan(), []);

  const update = (patch: Partial<Plan>) => {
    const next = { ...plan, ...patch };
    setPlan(next);
    void savePlanSynced(next).catch(() => { /* 写库失败时本机缓存已经生效，下次打开会重新写 */ });
    onSaved();
  };
  const toggle = (tag: string) => update({ packs: plan.packs.includes(tag) ? plan.packs.filter(item => item !== tag) : [...plan.packs, tag] });
  const isPreset = (PER_DAY_PRESETS as readonly number[]).includes(plan.perDay);
  const chip = (on: boolean) => `press min-h-[40px] rounded-full border px-3.5 text-sm ${on ? 'border-ink bg-ink text-white' : 'border-line bg-page text-ink'}`;

  return (
    <Group title="每日新词">
      <div className="space-y-5 text-sm" data-testid="daily-settings">
        <div>
          <p className="mb-1.5 font-medium">选词表（可多选）</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="词表">
            {PACKS.map(pack => (
              <button key={pack.tag} type="button" aria-pressed={plan.packs.includes(pack.tag)} data-testid={`daily-pack-${pack.tag}`}
                onClick={e => { toggle(pack.tag); e.currentTarget.blur(); }} className={chip(plan.packs.includes(pack.tag))}>
                {pack.label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-mute">每天从所选词表里，按常见程度挑几个你词库里还没有的词，滑一下：认识就跳过，不认识就收下。</p>
        </div>
        <div>
          <p className="mb-1.5 font-medium">每天几个新词</p>
          <div className="flex flex-wrap items-center gap-2">
            {PER_DAY_PRESETS.map(n => (
              <button key={n} type="button" aria-pressed={plan.perDay === n} data-testid={`daily-per-${n}`}
                onClick={e => { setCustom(''); update({ perDay: n }); e.currentTarget.blur(); }} className={chip(plan.perDay === n)}>{n}</button>
            ))}
            <label className="inline-flex items-center gap-1.5 text-mute">
              自定义
              <input type="number" min={1} max={MAX_PER_DAY} inputMode="numeric" data-testid="daily-per-custom"
                value={custom !== '' ? custom : isPreset ? '' : String(plan.perDay)}
                onChange={event => {
                  setCustom(event.target.value);
                  const n = Number(event.target.value);
                  if (Number.isInteger(n) && n >= 1 && n <= MAX_PER_DAY) update({ perDay: n });
                }}
                className="h-10 w-20 rounded-lg border border-line bg-page px-2 text-ink outline-none focus:border-ink" />
            </label>
          </div>
        </div>
        <div>
          <p className="mb-1.5 font-medium">词汇量测试</p>
          <p className="text-xs leading-relaxed text-mute" data-testid="level-last">
            {level ? `上次测试（${level.date}）：约 ${level.estimate.toLocaleString('en-US')} 词。` : '还没测过。测一下，系统就知道哪些词你已经认识，不再推给你。'}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => openOnboarding({ step: 'test', single: true })} data-testid="settings-retest" className="press min-h-[40px] rounded-full border border-line bg-page px-3.5 text-sm text-ink">{level ? '重新测词汇量' : '测词汇量'}</button>
            <button type="button" onClick={() => openOnboarding({ step: 'goal', single: true })} data-testid="settings-regoal" className="press min-h-[40px] rounded-full border border-line bg-page px-3.5 text-sm text-ink">重新选目标</button>
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={plan.cardOn} data-testid="daily-card-on" onChange={event => update({ cardOn: event.target.checked })} />
          在词库页显示「今日新词」卡
        </label>
      </div>
    </Group>
  );
}
