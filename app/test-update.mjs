// 077 应用内更新的纯逻辑单测：版本比较、「稍后」24 小时、清单 404/断网安静跳过、sha256 不符拒绝安装。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const out = join(mkdtempSync(join(tmpdir(), 'worddrip-update-')), 'updateLogic.mjs');
await build({ entryPoints: ['utils/updateLogic.ts'], bundle: true, format: 'esm', outfile: out });
const L = await import(pathToFileURL(out).href);

// 版本比较
assert.equal(L.compareVersions('0.9.10', '0.9.9'), 1, '0.9.10 > 0.9.9');
assert.equal(L.compareVersions('0.9.9', '0.9.10'), -1);
assert.equal(L.compareVersions('0.10.0', '0.9.99'), 1);
assert.equal(L.compareVersions('1.0', '1.0.0'), 0);
assert.equal(L.compareVersions('v0.9.2', '0.9.2'), 0);
assert.equal(L.compareVersions('0.9.3-beta.1', '0.9.2'), 1);
assert.equal(L.versionCodeOf('0.9.2'), 9002);
assert.equal(L.versionCodeOf('0.10.0'), 10000);

// 「稍后」24 小时规则
const t0 = 1_800_000_000_000;
const sn = L.snoozeFor('0.10.0', t0);
assert.equal(L.shouldShowBanner('0.10.0', null, t0), true, '没点过稍后要弹');
assert.equal(L.shouldShowBanner('0.10.0', sn, t0 + 1000), false, '刚点稍后不弹');
assert.equal(L.shouldShowBanner('0.10.0', sn, t0 + 24 * 3600_000 - 1), false, '24 小时内不弹');
assert.equal(L.shouldShowBanner('0.10.0', sn, t0 + 24 * 3600_000), true, '满 24 小时再弹');
assert.equal(L.shouldShowBanner('0.10.1', sn, t0 + 1000), true, '更新的版本不受上一个版本的稍后影响');

// 清单解析 + 404 / 断网 / 坏格式 安静跳过
const apk = new Uint8Array(5000).map((_, i) => i % 251);
const sha = createHash('sha256').update(apk).digest('hex');
const good = { version: '0.9.99', versionCode: 9099, url: 'http://x/a.apk', sha256: sha, size: apk.length, notes: '修了点东西' };
const json = body => async () => new Response(JSON.stringify(body), { status: 200 });
assert.deepEqual(await L.fetchAndroidManifest(json(good), 'u'), { ...good });
assert.equal(await L.fetchAndroidManifest(async () => new Response('nope', { status: 404 }), 'u'), null, '404 返回 null');
assert.equal(await L.fetchAndroidManifest(async () => { throw new TypeError('fetch failed'); }, 'u'), null, '断网返回 null');
assert.equal(await L.fetchAndroidManifest(async () => new Response('<html>', { status: 200 }), 'u'), null, '不是 JSON 返回 null');
assert.equal(await L.fetchAndroidManifest(json({ ...good, sha256: 'abc' }), 'u'), null, 'sha256 格式不对当没有');
assert.equal(L.isNewerAndroid(good, '0.9.2'), true);
assert.equal(L.isNewerAndroid(good, '0.9.99'), false);
assert.equal(L.isNewerAndroid(good, '0.10.0'), false);

// 下载 + sha256：对的才写盘；不对的拒绝，save（安装前的落盘）一次都不调
const serve = bytes => async () => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
let saved = [];
const sink = { save: async b => { saved.push(b.length); return '/cache/x.apk'; } };
const pcts = [];
assert.equal(await L.downloadAndVerifyApk(serve(apk), good, sink, p => pcts.push(p)), '/cache/x.apk');
assert.deepEqual(saved, [5000]);
assert.equal(pcts.at(-1), 100, '进度走到 100');

saved = [];
const bad = new Uint8Array(apk); bad[100] ^= 1; // 改一个字节
await assert.rejects(L.downloadAndVerifyApk(serve(bad), good, sink, () => {}), e => e.code === 'checksum');
assert.deepEqual(saved, [], 'sha256 不符不能落盘安装');
await assert.rejects(L.downloadAndVerifyApk(serve(apk.slice(0, 4000)), good, sink, () => {}), e => e.code === 'checksum', '大小不符也拒绝');
await assert.rejects(L.downloadAndVerifyApk(async () => { throw new Error('x'); }, good, sink, () => {}), e => e.code === 'network');
await assert.rejects(L.downloadAndVerifyApk(async () => new Response('', { status: 500 }), good, sink, () => {}), e => e.code === 'network');
await assert.rejects(L.downloadAndVerifyApk(serve(apk), good, { save: async () => { throw new Error('ENOSPC'); } }, () => {}), e => e.code === 'space');
assert.equal(L.classifyUpdateError(new Error('the signature could not be verified')), 'checksum');
assert.equal(L.classifyUpdateError(new Error('error sending request')), 'network');

console.log('test-update 通过');
