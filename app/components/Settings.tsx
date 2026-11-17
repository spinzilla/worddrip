import React, { useEffect, useRef, useState } from 'react';
import { AnkiConfig, AIConfig, AnkiCardTemplateConfig } from '../types';
import * as Anki from '../utils/anki';
import * as AI from '../utils/ai';
import * as Storage from '../utils/storage';
import { useAnkiConnection } from '../hooks/useAnkiConnection';
import { Seg, Stamp } from './ui';
import SettingsPractice from './SettingsPractice';
import SettingsLookup from './SettingsLookup';
import SettingsCards from './SettingsCards';
import SettingsAI, { AiAfterImport, AiPrompt } from './SettingsAI';
import SettingsAnki from './SettingsAnki';
import SettingsShortcuts from './SettingsShortcuts';
import SettingsTranscribe from './SettingsTranscribe';
import { Languages } from 'lucide-react';
import { useT, useLang, setLang, Lang } from '../utils/i18n';
import { AboutSection } from './UpdateUI';
import BackupRow from './BackupRow';
import SettingsTransfer from './SettingsTransfer';
import SettingsSync from './SettingsSync';
import { consumeDailySettingsRequest } from '../utils/vocab/dailyWords';
import { consumeSyncTabRequest } from './SyncStatus';
import { IS_MOBILE, settingsTabs, SettingsTab } from '../utils/platform';
import { FontScale, getFontScale, saveFontScale } from '../utils/fontScale';

type DeckByLang = NonNullable<AnkiCardTemplateConfig['deckByLang']>;

// Always shown as "中文" / "English" in their own language, regardless of the current UI language.
const LANG_OPTS: { value: Lang; label: string }[] = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
];

type Tab = SettingsTab;

const TAB_LABEL = (t: ReturnType<typeof useT>): Record<Tab, string> => ({
  practice: t('settings.practice'), lookup: t('settings.lookup'), cards: t('settings.cards'),
  import: t('settings.import'), transfer: '同步与搬家', ai: 'AI', shortcuts: t('shortcuts.title'),
});

type AnkiPatch = {
  url?: string;
  deckName?: string;
  modelName?: string;
  fieldMapping?: Record<string, string>;
  deckByLang?: DeckByLang;
};

const Settings: React.FC = () => {
  const t = useT();
  const lang = useLang();
  const [deckName, setDeckName] = useState('');
  const [modelName, setModelName] = useState('');
  const [fieldMapping, setFieldMapping] = useState<Record<string, string>>({});
  const [deckByLang, setDeckByLang] = useState<DeckByLang>({});

  const [aiModel, setAiModel] = useState('');
  const [aiTemperature, setAiTemperature] = useState(0.7);
  const [aiPrompt, setAiPrompt] = useState(AI.DEFAULT_PROMPT);
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiBaseUrl, setAiBaseUrl] = useState('');
  const [aiSegmentModel, setAiSegmentModel] = useState('');
  const [aiAutoBreakdown, setAiAutoBreakdown] = useState(false);
  const [aiBreakdownSounds, setAiBreakdownSounds] = useState(true);
  const [aiAutoCloze, setAiAutoCloze] = useState(false);
  const [aiAutoKeywords, setAiAutoKeywords] = useState(false);
  const [aiAutoPhrases, setAiAutoPhrases] = useState(false);
  const [aiJaCheck, setAiJaCheck] = useState(false);
  const [aiLimits, setAiLimits] = useState<NonNullable<AIConfig['limits']>>({});

  const [sectionLength, setSectionLength] = useState(Storage.DEFAULT_SECTION_LENGTH);
  const [fontScale, setFontScaleState] = useState<FontScale>(getFontScale);

  const [tab, setTab] = useState<Tab>(consumeSyncTabRequest() ? 'transfer' : consumeDailySettingsRequest() ? 'cards' : settingsTabs(IS_MOBILE)[0]);
  const [savedFlash, setSavedFlash] = useState(false);
  const flashTimer = useRef<number>(0);
  const ankiConnection = useAnkiConnection();

  const flashSaved = () => {
    setSavedFlash(true);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setSavedFlash(false), 1500);
  };

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  useEffect(() => {
    const savedAnki = Anki.getAnkiConfig();
    if (savedAnki) {
      ankiConnection.setUrl(savedAnki.url);
      if (savedAnki.card) {
        setDeckName(savedAnki.card.deckName);
        setModelName(savedAnki.card.modelName);
        setFieldMapping(savedAnki.card.fieldMapping || {});
        setDeckByLang(savedAnki.card.deckByLang || {});
      }
      if (!IS_MOBILE) ankiConnection.connect(savedAnki.url);
    }

    const savedAI = AI.getAIConfig();
    setAiModel(savedAI.model);
    setAiTemperature(savedAI.temperature);
    setAiPrompt(savedAI.promptTemplate || AI.DEFAULT_PROMPT);
    setAiApiKey(savedAI.apiKey || '');
    setAiBaseUrl(savedAI.baseUrl || '');
    setAiSegmentModel(savedAI.segmentModel || '');
    setAiAutoBreakdown(!!savedAI.autoBreakdown);
    setAiBreakdownSounds(savedAI.breakdownSounds !== false);
    setAiAutoCloze(!!savedAI.autoCloze);
    setAiAutoKeywords(!!savedAI.autoKeywords);
    setAiAutoPhrases(!!savedAI.autoPhrases);
    setAiJaCheck(!!savedAI.jaSegmentAi);
    setAiLimits(savedAI.limits || {});

    const savedPractice = Storage.getPracticeConfig();
    setSectionLength(savedPractice.sectionLength);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buildAnkiConfig = (patch: AnkiPatch = {}): AnkiConfig => {
    const url = patch.url ?? ankiConnection.url;
    const d = patch.deckName ?? deckName;
    const m = patch.modelName ?? modelName;
    const map = patch.fieldMapping ?? fieldMapping;
    const byLang = patch.deckByLang ?? deckByLang;
    return { url, card: d && m ? { deckName: d, modelName: m, fieldMapping: map, deckByLang: byLang } : null };
  };

  const saveAnki = (patch: AnkiPatch = {}) => {
    Anki.saveAnkiConfig(buildAnkiConfig(patch));
    flashSaved();
  };

  // Throws on failure; SettingsAnki shows the message next to the button.
  const createLinguaClip = async () => {
    const card = await Anki.setupLinguaClipCard(ankiConnection.url);
    setDeckName(card.deckName);
    setModelName(card.modelName);
    setFieldMapping(card.fieldMapping);
    saveAnki(card);
    ankiConnection.connect(); // pick up the new deck / note type in the dropdowns
    return card;
  };

  const saveAI = (next: Partial<AIConfig> & { prompt?: string } = {}) => {
    AI.saveAIConfig({
      model: next.model ?? aiModel,
      temperature: next.temperature ?? aiTemperature,
      promptTemplate: next.promptTemplate ?? next.prompt ?? aiPrompt,
      apiKey: next.apiKey ?? aiApiKey,
      baseUrl: next.baseUrl ?? aiBaseUrl,
      segmentModel: next.segmentModel ?? aiSegmentModel,
      autoBreakdown: next.autoBreakdown ?? aiAutoBreakdown,
      breakdownSounds: next.breakdownSounds ?? aiBreakdownSounds,
      autoCloze: next.autoCloze ?? aiAutoCloze,
      autoKeywords: next.autoKeywords ?? aiAutoKeywords,
      autoPhrases: next.autoPhrases ?? aiAutoPhrases,
      jaSegmentAi: next.jaSegmentAi ?? aiJaCheck,
      limits: next.limits ?? aiLimits,
    });
    flashSaved();
  };

  const badAiKey = AI.isBadKey(aiApiKey);
  const aiReady = !!(aiApiKey && !badAiKey && aiBaseUrl.trim() && (aiModel.trim() || aiSegmentModel.trim()));
  const goAI = () => setTab('ai');

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <Seg<Tab> className="flex-wrap" value={tab} onChange={setTab}
          options={settingsTabs(IS_MOBILE).map(value => ({ value, label: TAB_LABEL(t)[value] }))} />
        <div className="flex items-center gap-2 text-mute" title={t('settings.language')}>
          <Languages size={16} aria-hidden />
          <Seg<Lang> size="sm" value={lang} onChange={v => { setLang(v); flashSaved(); }} options={LANG_OPTS} />
        </div>
      </div>

      {tab === 'practice' && (
        <SettingsPractice
          sectionLength={sectionLength}
          setSectionLength={(v) => {
            setSectionLength(v);
            Storage.savePracticeConfig({ ...Storage.getPracticeConfig(), sectionLength: v });
            flashSaved();
          }}
        />
      )}

      {tab === 'lookup' && (
        <SettingsLookup onSaved={flashSaved} aiReady={AI.aiReady()} goAI={goAI}
          fontScale={fontScale}
          setFontScale={(v) => {
            setFontScaleState(v);
            saveFontScale(v);
            flashSaved();
          }}>
          <AiPrompt
            aiReady={AI.aiReady() /* the same check word lookup makes: needs the main model */}
            goAI={goAI}
            prompt={aiPrompt}
            setPrompt={(v) => {
              setAiPrompt(v);
              saveAI({ promptTemplate: v });
            }}
          />
        </SettingsLookup>
      )}

      {tab === 'import' && (
        <SettingsTranscribe onSaved={flashSaved}>
          <AiAfterImport
            aiReady={aiReady}
            goAI={goAI}
            segmentModel={aiSegmentModel}
            setSegmentModel={(v) => {
              setAiSegmentModel(v);
              saveAI({ segmentModel: v });
            }}
            autoBreakdown={aiAutoBreakdown}
            setAutoBreakdown={(v) => {
              setAiAutoBreakdown(v);
              saveAI({ autoBreakdown: v });
            }}
            breakdownSounds={aiBreakdownSounds}
            setBreakdownSounds={(v) => {
              setAiBreakdownSounds(v);
              saveAI({ breakdownSounds: v });
            }}
            autoCloze={aiAutoCloze}
            setAutoCloze={(v) => {
              setAiAutoCloze(v);
              saveAI({ autoCloze: v });
            }}
            autoKeywords={aiAutoKeywords}
            setAutoKeywords={(v) => {
              setAiAutoKeywords(v);
              saveAI({ autoKeywords: v });
            }}
            autoPhrases={aiAutoPhrases}
            setAutoPhrases={(v) => {
              setAiAutoPhrases(v);
              saveAI({ autoPhrases: v });
            }}
            jaCheck={aiJaCheck}
            setJaCheck={(v) => {
              setAiJaCheck(v);
              saveAI({ jaSegmentAi: v });
            }}
          />
        </SettingsTranscribe>
      )}

      {tab === 'transfer' && <div className="space-y-4"><SettingsSync /><SettingsTransfer /></div>}

      {tab === 'shortcuts' && <SettingsShortcuts onSaved={flashSaved} />}

      {tab === 'ai' && (
        <SettingsAI
          aiModel={aiModel}
          setAiModel={(v) => {
            setAiModel(v);
            saveAI({ model: v });
          }}
          aiTemperature={aiTemperature}
          setAiTemperature={(v) => {
            setAiTemperature(v);
            saveAI({ temperature: v });
          }}
          aiApiKey={aiApiKey}
          setAiApiKey={(v) => {
            setAiApiKey(v);
            saveAI({ apiKey: v });
          }}
          aiBaseUrl={aiBaseUrl}
          setAiBaseUrl={(v) => {
            setAiBaseUrl(v);
            saveAI({ baseUrl: v });
          }}
          aiLimits={aiLimits}
          setAiLimits={(v) => {
            setAiLimits(v);
            saveAI({ limits: v });
          }}
          goTab={setTab}
        />
      )}

      {tab === 'cards' && (
        <SettingsCards onSaved={flashSaved}>
          {!IS_MOBILE && <SettingsAnki
            url={ankiConnection.url}
            setUrl={(v) => {
              ankiConnection.setUrl(v);
              saveAnki({ url: v });
            }}
            status={ankiConnection.status}
            error={ankiConnection.error}
            onConnect={() => ankiConnection.connect()}
            decks={ankiConnection.decks}
            models={ankiConnection.models}
            deckName={deckName}
            setDeckName={(v) => {
              setDeckName(v);
              saveAnki({ deckName: v });
            }}
            modelName={modelName}
            setModelName={(v) => {
              setModelName(v);
              saveAnki({ modelName: v });
            }}
            fieldMapping={fieldMapping}
            setFieldMapping={setFieldMapping}
            fetchModelFields={ankiConnection.fetchModelFields}
            saveAnki={saveAnki}
            createLinguaClip={createLinguaClip}
            deckByLang={deckByLang}
            setDeckByLang={(v) => {
              setDeckByLang(v);
              saveAnki({ deckByLang: v });
            }}
            refreshDecks={() => ankiConnection.connect()}
          />}
        </SettingsCards>
      )}

      {!IS_MOBILE && <BackupRow />}
      {/* 许可证署名：本软件基于 LinguaClip（AGPL-3.0），改名后也要留着这句。 */}
      <p className="mt-3 text-center text-xs text-mute" data-testid="based-on">{t('settings.basedOn')}</p>
      <AboutSection />

      {savedFlash && (
        <div className="fixed bottom-6 right-6 z-50 max-md:right-4">
          <Stamp tone="accent-soft" className="shadow-card">{t('settings.savedFlash')}</Stamp>
        </div>
      )}
    </div>
  );
};

export default Settings;
