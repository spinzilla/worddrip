// 083 设置备份 / 整库带设置 / 诊断信息 / 更新前保护 的纯逻辑单测。
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const dir = mkdtempSync(join(tmpdir(), 'worddrip-settings-'));
const load = async (entry, name) => {
  const out = join(dir, name);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', outfile: out });
  return import(pathToFileURL(out).href);
};
const L = await load('utils/settingsBackupLogic.ts', 'logic.mjs');
const G = await load('utils/updateGuard.ts', 'guard.mjs');

class Mem {
  constructor(o = {}) { this.m = new Map(Object.entries(o)); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
}

const ai = JSON.stringify({ model: 'm1', apiKey: 'sk-SECRET-123456', baseUrl: 'https://x' });
const sync = JSON.stringify({ spaceId: 'sp1', spaceSecret: 'SYNCSECRET9999', baseUrl: '', auto: true });
const full = () => new Mem({
  linguaclip_ai_config: ai, linguaclip_lang: 'zh', linguaclip_anki_config: '{"url":"u"}',
  es_sync_config: sync, linguaclip_watch_pos: '{"big":1}', 'worddrip.update.lastCheck': '123', unrelated: 'x',
});

// 快照只含清单里的键
const snap = L.takeSnapshot(full(), '0.11.0', 1000);
assert.deepEqual(Object.keys(snap.items).sort(), ['es_sync_config', 'linguaclip_ai_config', 'linguaclip_anki_config', 'linguaclip_lang']);
assert.equal(L.parseSnapshot(JSON.stringify(snap)).at, 1000);
assert.equal(L.parseSnapshot('garbage'), null);
assert.equal(L.parseSnapshot(JSON.stringify({ v: 1, at: 1, items: { evil: 'x', linguaclip_lang: 'en' } })).items.evil, undefined);

// 「看起来像全新」
assert.equal(L.looksFresh(L.appKeyCount(new Mem())), true, '空的算全新');
assert.equal(L.looksFresh(L.appKeyCount(new Mem({ linguaclip_lang: 'zh', other: '1' }))), true, '一两个系统键算全新');
assert.equal(L.looksFresh(L.appKeyCount(new Mem({ linguaclip_lang: 'zh', worddrip_onboarding: 'done' }))), true);
assert.equal(L.looksFresh(L.appKeyCount(full())), false, '正常用过的不算');
assert.equal(L.shouldOfferRestore(0, snap), true);
assert.equal(L.shouldOfferRestore(0, null), false);
assert.equal(L.shouldOfferRestore(L.appKeyCount(full()), snap), false);
assert.equal(L.shouldOfferRestore(0, { ...snap, items: { linguaclip_lang: 'zh' } }), false, '快照也只有一个键就不问');

// 恢复写回
const fresh = new Mem();
assert.equal(L.applyItems(fresh, snap.items), 4);
assert.equal(fresh.getItem('linguaclip_ai_config'), ai);

// 整库导出带设置：不带 key 时无密钥、无同步凭据、无授权码
const noKey = L.exportSettingsJson(new Mem({ ...Object.fromEntries(full().m), linguaclip_pro_license: '{"key":"LIC-1"}' }), '0.11.0', false, 5);
assert.ok(noKey);
assert.ok(!noKey.includes('sk-SECRET'), '不含 API key');
assert.ok(!noKey.includes('SYNCSECRET') && !noKey.includes('es_sync_config'), '永远不含同步凭据');
assert.ok(!noKey.includes('LIC-1'));
assert.equal(JSON.parse(JSON.parse(noKey).items.linguaclip_ai_config).model, 'm1', '其他设置还在');
const withKey = L.exportSettingsJson(full(), '0.11.0', true, 5);
assert.ok(withKey.includes('sk-SECRET-123456'));
assert.ok(!withKey.includes('SYNCSECRET'), '勾了 API key 也不带同步密钥');
assert.equal(L.exportSettingsJson(new Mem(), '1', false), null);

// 导入：带设置能恢复；不带 key 的文件不清掉本机原来的 key
const target = new Mem({ linguaclip_ai_config: JSON.stringify({ model: 'old', apiKey: 'MY-LOCAL-KEY-0000' }) });
L.applyImportedSettings(target, noKey);
const merged = JSON.parse(target.getItem('linguaclip_ai_config'));
assert.equal(merged.model, 'm1', '设置被恢复');
assert.equal(merged.apiKey, 'MY-LOCAL-KEY-0000', '本机原 key 保留');
assert.equal(target.getItem('linguaclip_anki_config'), '{"url":"u"}');
const t2 = new Mem();
L.applyImportedSettings(t2, withKey);
assert.equal(JSON.parse(t2.getItem('linguaclip_ai_config')).apiKey, 'sk-SECRET-123456', '带 key 的文件能恢复 key');
assert.equal(L.applyImportedSettings(new Mem(), 'not json'), 0, '坏内容不写');
// 手改文件塞同步凭据：不写
const evil = JSON.stringify({ v: 1, at: 1, version: '', items: { es_sync_config: sync } });
const t3 = new Mem(); L.applyImportedSettings(t3, evil);
assert.equal(t3.getItem('es_sync_config'), null);

// 旧格式 .wdlib（没有设置）：Rust 端 preview 的 settings 为空，前端什么都不做
assert.equal(L.applyImportedSettings(new Mem(), ''), 0);

// 诊断信息不含密钥
const secrets = L.secretValues(full());
assert.ok(secrets.includes('sk-SECRET-123456') && secrets.includes('SYNCSECRET9999'));
const diag = L.buildDiagText('0.11.0', ['2026 v0.11.0 设置键=5', 'oops key=sk-SECRET-123456 sec=SYNCSECRET9999'], secrets);
assert.ok(!diag.includes('sk-SECRET') && !diag.includes('SYNCSECRET'));
assert.ok(diag.includes('v0.11.0') && diag.includes('设置键=5'));
assert.equal(L.buildDiagText('1', Array.from({ length: 50 }, (_, i) => `L${i}`), []).split('\n').length, 21, '最近 20 行 + 标题');
assert.deepEqual(L.parseInstallTimes('{"firstInstall":1,"lastUpdate":2}'), { firstInstall: 1, lastUpdate: 2 });
assert.deepEqual(L.parseInstallTimes('x'), {});

// 更新前保护
const run = async (o) => {
  const calls = [];
  const r = await G.guardBeforeInstall({
    snapshot: async () => { calls.push('snap'); },
    hasSync: () => o.hasSync,
    syncNow: async () => { calls.push('sync'); return o.syncOk; },
    confirmUnsynced: async () => { calls.push('confirm'); return o.confirm; },
  });
  return { r, calls };
};
assert.deepEqual(await run({ hasSync: true, syncOk: true }), { r: true, calls: ['snap', 'sync'] });
assert.deepEqual(await run({ hasSync: true, syncOk: false, confirm: true }), { r: true, calls: ['snap', 'sync', 'confirm'] });
assert.deepEqual(await run({ hasSync: true, syncOk: false, confirm: false }), { r: false, calls: ['snap', 'sync', 'confirm'] });
assert.deepEqual(await run({ hasSync: false }), { r: true, calls: ['snap'] }, '没加入同步：不拦');

console.log('test-settings-backup ok');
