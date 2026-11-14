// 应用内更新的纯逻辑（不碰界面、不碰 Tauri），方便单测：版本比较、「稍后」规则、
// 安卓清单解析与下载校验。状态机和界面在 update.ts / UpdateUI.tsx。

export const UPDATE_BASE = 'https://vocab.uestceee.art/worddrip-updates';
export const SNOOZE_MS = 24 * 60 * 60 * 1000;
export const CHECK_FIRST_MS = 10_000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export type UpdateErrorCode = 'network' | 'checksum' | 'space' | 'unknown';
export class UpdateError extends Error {
  code: UpdateErrorCode;
  constructor(code: UpdateErrorCode, message = code) {
    super(message);
    this.code = code;
  }
}

/** 逐段按数字比较：0.9.10 > 0.9.9；短的补 0；带 -beta 之类后缀的只看数字部分。返回 1 / 0 / -1。 */
export function compareVersions(a: string, b: string): number {
  const nums = (v: string) => v.trim().replace(/^v/i, '').split(/[-+]/)[0].split('.').map(s => parseInt(s, 10) || 0);
  const x = nums(a);
  const y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 和 release.mjs 一致：major*1_000_000 + minor*1_000 + patch。 */
export function versionCodeOf(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.trim().replace(/^v/i, '').split(/[-+]/)[0].split('.').map(s => parseInt(s, 10) || 0);
  return major * 1_000_000 + minor * 1_000 + patch;
}

export type Snooze = { version: string; until: number } | null;

/** 点「稍后」：同一版本 24 小时内不再弹条。 */
export const snoozeFor = (version: string, now: number): NonNullable<Snooze> => ({ version, until: now + SNOOZE_MS });

/** 要不要弹条：没点过稍后、点的是别的版本、或已过 24 小时，都要弹。 */
export function shouldShowBanner(version: string, snooze: Snooze, now: number): boolean {
  if (!snooze || snooze.version !== version) return true;
  return now >= snooze.until;
}

export type AndroidManifest = { version: string; versionCode: number; url: string; sha256: string; size: number; notes: string };

/** 清单不合格（缺字段、sha256 不是 64 位十六进制）一律当没有，不弹错。 */
export function parseAndroidManifest(raw: unknown): AndroidManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.version !== 'string' || typeof o.url !== 'string' || typeof o.sha256 !== 'string') return null;
  if (!/^[0-9a-f]{64}$/i.test(o.sha256)) return null;
  const versionCode = typeof o.versionCode === 'number' ? o.versionCode : versionCodeOf(o.version);
  return {
    version: o.version,
    versionCode,
    url: o.url,
    sha256: o.sha256.toLowerCase(),
    size: typeof o.size === 'number' ? o.size : 0,
    notes: typeof o.notes === 'string' ? o.notes : '',
  };
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** 拉安卓清单。断网、404、不是 JSON、格式不对都返回 null（安静跳过）。 */
export async function fetchAndroidManifest(fetchFn: FetchFn, url: string): Promise<AndroidManifest | null> {
  try {
    const res = await fetchFn(url, { headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) return null;
    return parseAndroidManifest(await res.json());
  } catch {
    return null;
  }
}

/** 比当前已装的新才算更新（按 versionCode；当前版本号由版本号算出来）。 */
export const isNewerAndroid = (m: AndroidManifest, currentVersion: string): boolean => m.versionCode > versionCodeOf(currentVersion);

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export async function readAll(res: Response, onProgress: (got: number, total: number) => void, expected: number): Promise<Uint8Array> {
  const total = Number(res.headers.get('content-length')) || expected;
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress(buf.length, total || buf.length);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export type ApkSink = {
  /** 把已校验的 APK 写到本机，返回路径。写不下要抛错（会被当成「空间不足」）。 */
  save: (bytes: Uint8Array) => Promise<string>;
};

/**
 * 下载 APK → 核对大小和 sha256 → 才写盘。校验不过抛 checksum，绝不调 save。
 * 返回写好的路径。
 */
export async function downloadAndVerifyApk(
  fetchFn: FetchFn, m: AndroidManifest, sink: ApkSink, onProgress: (pct: number) => void,
): Promise<string> {
  let bytes: Uint8Array;
  try {
    const res = await fetchFn(m.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = await readAll(res, (got, total) => { if (total) onProgress(Math.min(99, Math.floor((got * 100) / total))); }, m.size);
  } catch {
    throw new UpdateError('network');
  }
  if ((m.size && bytes.length !== m.size) || (await sha256Hex(bytes)) !== m.sha256) throw new UpdateError('checksum');
  try {
    const path = await sink.save(bytes);
    onProgress(100);
    return path;
  } catch {
    throw new UpdateError('space');
  }
}

/** 把任意错误归成三类中文原因之一（电脑端更新器的报错只有英文文字，靠关键词判断）。 */
export function classifyUpdateError(err: unknown): UpdateErrorCode {
  if (err instanceof UpdateError) return err.code;
  const msg = String((err as { message?: unknown })?.message ?? err).toLowerCase();
  if (/signature|checksum|verif|mismatch|minisign/.test(msg)) return 'checksum';
  if (/no space|disk full|space/.test(msg)) return 'space';
  if (/network|request|connect|timed? ?out|dns|error sending|status code|http/.test(msg)) return 'network';
  return 'unknown';
}
