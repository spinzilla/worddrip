import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// 055 随手记的前端纯逻辑：上下文拼装（视频 / 听写 / 词条 / 无）、去掉上下文、空白不存、来源登记。
const out = join(tmpdir(), `quicknote-${process.pid}.mjs`);
await build({ entryPoints: ['utils/quicknote/context.ts'], bundle: true, format: 'esm', outfile: out });
const m = await import(pathToFileURL(out).href);

// 上下文拼装
const video = { kind: 'video', text: '  It was  a good\n day. ', videoId: 'v1', videoName: 'Demo', time: 192.4 };
assert.deepEqual(m.buildContext(video, true), { kind: 'video', text: 'It was a good day.', videoId: 'v1', videoName: 'Demo', time: 192.4 });
const dict = { kind: 'dictation', text: 'Hello there.', videoId: 'v2', videoName: 'Show', time: 5 };
assert.deepEqual(m.buildContext(dict, true), { kind: 'dictation', text: 'Hello there.', videoId: 'v2', videoName: 'Show', time: 5 });
const entry = { kind: 'entry', entryId: 'mitigate', word: 'mitigate' };
assert.deepEqual(m.buildContext(entry, true), { kind: 'entry', entryId: 'mitigate', word: 'mitigate' });
assert.deepEqual(m.buildContext(null, true), { kind: 'none' }, '没有来源 = 无');
// 去掉上下文
for (const snap of [video, dict, entry]) assert.deepEqual(m.buildContext(snap, false), { kind: 'none' }, '点了小叉 = 无');
// 空字幕句、坏时间点不带上
assert.deepEqual(m.buildContext({ kind: 'video', text: '   ', videoId: 'v1', time: -1 }, true), { kind: 'video', videoId: 'v1' });
assert.deepEqual(m.buildContext({ kind: 'video', time: NaN }, true), { kind: 'video' });
assert.equal(m.buildContext({ kind: 'video', time: 0 }, true).time, 0, '0 秒是合法时间点');

// 小字文案
assert.equal(m.describeContext(m.buildContext(video, true)), '字幕：It was a good day. · 03:12');
assert.equal(m.describeContext(m.buildContext(dict, true)), '字幕：Hello there. · 00:05');
assert.equal(m.describeContext(m.buildContext(entry, true)), '词条：mitigate');
assert.equal(m.describeContext({ kind: 'video', videoName: 'Demo', time: 0 }), '视频：Demo · 00:00', '还没播到第一句');
assert.equal(m.describeContext({ kind: 'none' }), null);
assert.equal(m.describeContext(m.buildContext(video, false)), null);
assert.equal(m.clock(3725), '1:02:05');
assert.equal(m.clock(59.9), '00:59');
assert.equal(m.clock(-3), '00:00');

// 空白不存
for (const blank of ['', '   ', '\n\t  \n']) assert.equal(m.canSaveBody(blank), false, JSON.stringify(blank));
assert.equal(m.canSaveBody(' a '), true);

// 来源登记：后登记的优先；没快照的来源被跳过；注销后回退；暂停交给最后一个带 pause 的
assert.equal(m.currentSnapshot(), null);
assert.equal(m.mediaSource(), null);
let paused = 0;
const media = { snapshot: () => video, pause: () => { paused += 1; return true; }, resume() {} };
const off1 = m.registerNoteSource(media);
assert.equal(m.currentSnapshot().kind, 'video');
const off2 = m.registerNoteSource({ snapshot: () => entry });
assert.equal(m.currentSnapshot().kind, 'entry', '词条在上面，上下文取词条');
assert.equal(m.mediaSource(), media, '暂停仍交给视频来源');
assert.equal(m.mediaSource().pause(), true);
assert.equal(paused, 1);
const off3 = m.registerNoteSource({ snapshot: () => null });
assert.equal(m.currentSnapshot().kind, 'entry', '空来源被跳过');
off3(); off2();
assert.equal(m.currentSnapshot().kind, 'video', '注销后回退到视频');
off2(); // 重复注销不出错
off1();
assert.equal(m.currentSnapshot(), null);

console.log('test-quicknote: ok');
