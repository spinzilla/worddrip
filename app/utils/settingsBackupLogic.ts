// 083 设置备份的纯逻辑（不碰 Tauri / React，方便单测）：哪些键算「本应用的设置」、拍快照、判断是不是全新、
// 导出整库时去掉密钥、诊断信息里抹掉密钥。读写文件的部分在 settingsBackup.ts。

/** 能读写的最小存储接口（localStorage 满足；测试里用 Map 包一个）。 */
export interface KV {
  readonly length: number;
  key(i: number): string | null;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

// ───────────── 设置清单（快照只包含这些键） ─────────────
// 新增设置时在这里加一行；没列的键（观看位置、进度、复习延后、更新检查时间等会频繁变的缓存）不进快照。
//   AI            linguaclip_ai_config（含 API key）、linguaclip_ai_temp_v1、linguaclip_ai_models
//   词典来源      linguaclip_dict_sources、linguaclip_dict_choice、linguaclip_dict_choice_en
//   Anki          linguaclip_anki_config、linguaclip_anki_tpl
//   学习计划缓存  worddrip_daily_plan、worddrip_daily_state
//   首次引导      worddrip_onboarding、worddrip_level_result
//   界面/练习     linguaclip_lang、linguaclip_practice_config、linguaclip_audio_padding、linguaclip_watch_prefs、linguaclip_loop（句循环）、
//                 linguaclip_keys、linguaclip_keys_pinned、linguaclip_deck_lang、import_lang、import_trash_original
//   转写 / Notion linguaclip_transcribe_config（含云端 key）、linguaclip_notion_config（含 token）
//   授权          linguaclip_pro_license
//   更新          worddrip.update.auto
//   同步空间凭据  es_sync_config（含空间密钥）、es_sync_url_draft
export const SETTINGS_KEYS: readonly string[] = [
  'linguaclip_ai_config', 'linguaclip_ai_temp_v1', 'linguaclip_ai_models',
  'linguaclip_dict_sources', 'linguaclip_dict_choice', 'linguaclip_dict_choice_en',
  'linguaclip_anki_config', 'linguaclip_anki_tpl',
  'worddrip_daily_plan', 'worddrip_daily_state',
  'worddrip_onboarding', 'worddrip_level_result',
  'linguaclip_lang', 'linguaclip_practice_config', 'linguaclip_audio_padding', 'linguaclip_watch_prefs', 'linguaclip_loop',
  'linguaclip_keys', 'linguaclip_keys_pinned', 'linguaclip_deck_lang', 'import_lang', 'import_trash_original',
  'linguaclip_transcribe_config', 'linguaclip_notion_config',
  'linguaclip_pro_license',
  'worddrip.update.auto',
  'es_sync_config', 'es_sync_url_draft',
];

/** 同步空间凭据：只进本机快照，导出整库时永远不带。 */
const SYNC_KEYS = ['es_sync_config', 'es_sync_url_draft'];
const LICENSE_KEY = 'linguaclip_pro_license';
const SET = new Set(SETTINGS_KEYS);
export const isSettingsKey = (k: string): boolean => SET.has(k);

// 判断「本机是不是看起来全新」用的前缀：本应用写的键都以这些开头（含不进快照的缓存）。
const APP_PREFIXES = ['linguaclip_', 'worddrip', 'es_sync_', 'import_'];
export const isAppKey = (k: string): boolean => APP_PREFIXES.some(p => k.startsWith(p));

export function listKeys(s: KV): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k) out.push(k); }
  return out;
}
export const appKeyCount = (s: KV): number => listKeys(s).filter(isAppKey).length;

/** 全新判断：本应用的键 ≤ 2 个（空的、或只有语言之类一两个系统键）算全新；正常用过的有一大把键。 */
export const FRESH_MAX_KEYS = 2;
export const looksFresh = (count: number): boolean => count <= FRESH_MAX_KEYS;

// ───────────── 快照 ─────────────
export interface Snapshot { v: 1; at: number; version: string; items: Record<string, string> }

export function takeSnapshot(s: KV, version: string, now = Date.now()): Snapshot {
  const items: Record<string, string> = {};
  for (const k of listKeys(s)) if (SET.has(k)) { const v = s.getItem(k); if (v !== null) items[k] = v; }
  return { v: 1, at: now, version, items };
}

export function parseSnapshot(text: string | null | undefined): Snapshot | null {
  if (!text) return null;
  try {
    const o = JSON.parse(text);
    if (!o || o.v !== 1 || typeof o.at !== 'number' || !o.items || typeof o.items !== 'object') return null;
    const items: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.items)) if (SET.has(k) && typeof v === 'string') items[k] = v;
    return { v: 1, at: o.at, version: typeof o.version === 'string' ? o.version : '', items };
  } catch { return null; }
}

/** 快照里「正经设置」的键数（不算只是语言之类的）。 */
export const snapshotKeyCount = (snap: Snapshot): number => Object.keys(snap.items).length;

/** 该不该问「发现之前的设置，恢复吗」：本机看起来全新，且快照明显比现在丰富。 */
export const shouldOfferRestore = (currentAppKeys: number, snap: Snapshot | null): snap is Snapshot =>
  !!snap && looksFresh(currentAppKeys) && snapshotKeyCount(snap) > currentAppKeys && snapshotKeyCount(snap) > FRESH_MAX_KEYS;

/** 把快照写回存储（只写清单里的键），返回写了几个。 */
export function applyItems(s: KV, items: Record<string, string>): number {
  let n = 0;
  for (const [k, v] of Object.entries(items)) if (SET.has(k) && typeof v === 'string') { s.setItem(k, v); n++; }
  return n;
}

// ───────────── 密钥处理 ─────────────
const SECRET_FIELD = /(key|token|secret)$/i;
// 只有这几个键里存着密钥字段；其他键（比如快捷键设置，字段名可能也带 key）不按名字乱删。
const SECRET_STORES = ['linguaclip_ai_config', 'linguaclip_transcribe_config', 'linguaclip_notion_config', 'es_sync_config', LICENSE_KEY];

/** 递归去掉名字以 key / token / secret 结尾的字段（apiKey、groqKey、bailianKey、token、spaceSecret…）。 */
export function stripSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecretFields);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!SECRET_FIELD.test(k)) out[k] = stripSecretFields(v);
    return out;
  }
  return value;
}

/**
 * 整库导出带的设置 JSON：永远不含同步凭据；includeApiKey=false 时再去掉所有密钥字段和授权码。
 * 返回 null 表示没有任何设置可带。
 */
export function exportSettingsJson(s: KV, version: string, includeApiKey: boolean, now = Date.now()): string | null {
  const snap = takeSnapshot(s, version, now);
  const items: Record<string, string> = {};
  for (const [k, v] of Object.entries(snap.items)) {
    if (SYNC_KEYS.includes(k)) continue;
    if (!includeApiKey && SECRET_STORES.includes(k)) {
      if (k === LICENSE_KEY) continue;
      try { items[k] = JSON.stringify(stripSecretFields(JSON.parse(v))); continue; } catch { /* 不是 JSON（如语言）原样带 */ }
    }
    items[k] = v;
  }
  if (Object.keys(items).length === 0) return null;
  return JSON.stringify({ v: 1, at: now, version, items, secrets: includeApiKey });
}

/**
 * 导入文件里的设置写回本机。不带 API key 的文件不覆盖本机原有密钥：
 * 每个键里的密钥字段保留本机现值；本机没有这个键就直接写入文件里的值。
 */
export function applyImportedSettings(s: KV, json: string): number {
  const snap = parseSnapshot(json);
  if (!snap) return 0;
  const carriesSecrets = (() => { try { return JSON.parse(json).secrets === true; } catch { return false; } })();
  let n = 0;
  for (const [k, v] of Object.entries(snap.items)) {
    if (SYNC_KEYS.includes(k)) continue; // 文件里本来就不带；防手改文件把别人的同步空间写进来
    let value = v;
    if (!carriesSecrets && SECRET_STORES.includes(k)) {
      if (k === LICENSE_KEY) continue;
      const mine = s.getItem(k);
      if (mine !== null) {
        try {
          const cur = JSON.parse(mine); const inc = JSON.parse(v);
          if (cur && inc && typeof cur === 'object' && typeof inc === 'object' && !Array.isArray(cur) && !Array.isArray(inc)) {
            const merged: Record<string, unknown> = { ...inc };
            for (const [f, fv] of Object.entries(cur)) if (SECRET_FIELD.test(f)) merged[f] = fv;
            value = JSON.stringify(merged);
          }
        } catch { /* 非 JSON 直接覆盖 */ }
      }
    }
    s.setItem(k, value); n++;
  }
  return n;
}

/** 收集本机所有密钥的值（API key、转写 key、Notion token、同步空间密钥、授权码），用来在诊断信息里抹掉。 */
export function secretValues(s: KV): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (SECRET_FIELD.test(k) && typeof x === 'string' && x.length >= 4) out.add(x);
        else walk(x);
      }
    }
  };
  for (const k of SECRET_STORES) {
    const raw = s.getItem(k); if (!raw) continue;
    try { walk(JSON.parse(raw)); } catch { /* ignore */ }
  }
  return [...out];
}

/** 「复制诊断信息」的文本：当前版本 + 最近 20 行启动记录；任何密钥原文一律替换成 ***。 */
export function buildDiagText(version: string, lines: string[], secrets: string[], now = new Date()): string {
  let text = [`词滴诊断信息 v${version}（${now.toISOString()}）`, ...lines.slice(-20)].join('\n');
  for (const secret of secrets) text = text.split(secret).join('***');
  return text;
}

/** 手机上「首次安装 / 最近更新」那个只读桥的返回值解析。 */
export function parseInstallTimes(raw: string | null | undefined): { firstInstall?: number; lastUpdate?: number } {
  try {
    const o = JSON.parse(raw || '{}');
    return {
      firstInstall: typeof o.firstInstall === 'number' ? o.firstInstall : undefined,
      lastUpdate: typeof o.lastUpdate === 'number' ? o.lastUpdate : undefined,
    };
  } catch { return {}; }
}
