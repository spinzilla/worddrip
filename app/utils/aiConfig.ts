import { fetch } from '@tauri-apps/plugin-http';
import { AIConfig } from '../types';

// Where the AI settings live, and how they turn into an OpenAI-compatible
// endpoint. Kept apart from ai.ts so utils/resegment.ts can read the same
// settings without dragging i18n/React along.

const STORAGE_KEY_AI = 'linguaclip_ai_config';

export const DEFAULT_PROMPT = `Define the word "{word}" as it is used in this sentence: "{context}". Provide a brief definition and its part of speech.`;

const DEFAULTS: AIConfig = {
  model: '',
  // 073：默认 1。很多推理类模型只接受 1，默认 0.7 会让没留意这一项的用户直接报错。
  temperature: 1,
  promptTemplate: DEFAULT_PROMPT,
  apiKey: '',
  baseUrl: '',
  segmentModel: '',
};

// 073 一次性迁移：旧默认值 0.7 → 1。只在没有迁移标记时做；做完（或本机根本没存过设置）就记下标记，
// 之后用户自己再设成 0.7 也不会被改回去。用户设过的其他值不动。
const STORAGE_KEY_TEMP_MIGRATED = 'linguaclip_ai_temp_v1';
export const migrateTemperatureDefault = (): void => {
  try {
    if (localStorage.getItem(STORAGE_KEY_TEMP_MIGRATED)) return;
    const raw = localStorage.getItem(STORAGE_KEY_AI);
    if (raw) {
      const stored = JSON.parse(raw) as Record<string, unknown>;
      if (stored && typeof stored === 'object' && stored.temperature === 0.7) {
        localStorage.setItem(STORAGE_KEY_AI, JSON.stringify({ ...stored, temperature: 1 }));
      }
    }
    localStorage.setItem(STORAGE_KEY_TEMP_MIGRATED, '1');
  } catch { /* 读写不了就算了，下次再试 */ }
};

export const getAIConfig = (): AIConfig => {
  migrateTemperatureDefault();
  try {
    const stored = localStorage.getItem(STORAGE_KEY_AI);
    return { ...DEFAULTS, ...(stored ? JSON.parse(stored) : {}) };
  } catch {
    return { ...DEFAULTS };
  }
};

export const saveAIConfig = (config: AIConfig) => {
  localStorage.setItem(STORAGE_KEY_AI, JSON.stringify(config));
};

// No default endpoint: the user brings their own provider, address and key.
export const normalizeBaseUrl = (url?: string): string =>
  (url?.trim() ?? '').replace(/\/+$/, '');

// Some gateways glue a trailing SSE "data: [DONE]" onto an otherwise normal
// JSON body, which makes res.json() throw a bare "string did not match the
// expected pattern". Read the text and clean it ourselves instead.
export const readJsonBody = async <T,>(res: Response): Promise<T> => {
  const raw = await res.text();
  return JSON.parse(raw.replace(/\s*data:\s*\[DONE\]\s*$/, '').trim()) as T;
};

export type Endpoint = { baseUrl: string; apiKey: string };

// A key is printable ASCII with no spaces. Anything else (a pasted sentence, a
// stray space) cannot even go into a request header — the webview throws a bare
// "Type error" — so such a key counts as not set, and Settings says why.
export const isBadKey = (key: string): boolean => /[^\x21-\x7e]/.test(key);

export const getEndpoint = (): Endpoint | null => {
  const config = getAIConfig();
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!config.apiKey || !baseUrl || isBadKey(config.apiKey)) return null;
  return { baseUrl, apiKey: config.apiKey };
};

// The fetched list is remembered so the picker still has options the next time
// Settings is opened, without another round trip.
const STORAGE_KEY_MODELS = 'linguaclip_ai_models';

export const getCachedModels = (): string[] => {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_MODELS) || '[]');
    return Array.isArray(stored) ? stored.filter((m): m is string => typeof m === 'string') : [];
  } catch {
    return [];
  }
};

// GET /models — every OpenAI-compatible provider exposes it; used by the
// "fetch models" button in Settings so the user need not type ids by hand.
export const listModels = async (baseUrl: string, apiKey: string): Promise<string[]> => {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await readJsonBody<{ data?: { id?: string }[] }>(res);
  const ids = (body?.data ?? []).map(m => m?.id).filter((id): id is string => !!id);
  if (ids.length === 0) throw new Error('empty model list');
  const sorted = ids.sort();
  try { localStorage.setItem(STORAGE_KEY_MODELS, JSON.stringify(sorted)); } catch { /* ignore */ }
  return sorted;
};
