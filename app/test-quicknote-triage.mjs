import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = process.env.CARGO_TARGET_DIR || 'D:/rust/target';
const bundled = path.join(root, 'quicknote-triage-tests', `triage-${process.pid}.mjs`);
const bundledModelHttp = path.join(root, 'quicknote-triage-tests', `model-http-${process.pid}.mjs`);
fs.mkdirSync(path.dirname(bundled), { recursive: true });
try {
  await build({ entryPoints: ['utils/quicknote/triage.ts'], bundle: true, format: 'esm', outfile: bundled, logLevel: 'silent' });
  await build({ entryPoints: ['utils/modelHttp.ts'], bundle: true, format: 'esm', outfile: bundledModelHttp, logLevel: 'silent' });
  const m = await import(pathToFileURL(bundled).href);
  const modelHttp = await import(pathToFileURL(bundledModelHttp).href);
  const none = { kind: 'none' };
  const caption = { kind: 'video', text: 'The lights went out.', videoName: 'demo', time: 12 };

  for (const body of ['mitigate', 'take into', 'hello.']) assert.equal(m.suggestQuickNoteDestination(body, none), 'vocab', `${body} → 加入词库`);
  for (const body of ['We should reconsider this decision.', 'They support the proposal.', 'We should reconsider this decision', 'I want to go home']) assert.equal(m.suggestQuickNoteDestination(body, none), 'example', `${body} → 存为例句`);
  for (const body of ['remember this', 'x']) assert.equal(m.suggestQuickNoteDestination(body, caption), 'example', `${body} + 字幕上下文 → 存为例句`);
  for (const body of ['为什么要这样做？', '这两个词有什么区别']) assert.equal(m.suggestQuickNoteDestination(body, none), 'ai', `${body} → 问 AI`);
  for (const body of ['记得看第七集', '记得复习这一段']) assert.equal(m.suggestQuickNoteDestination(body, none), 'note', `${body} → 留作笔记`);

  const notes = [
    { id: 1, body: 'We should reconsider this decision.', createdAt: '2026-11-12T12:34:00Z', context: caption, status: '已整理', destination: '例句：mitigate' },
    { id: 2, body: '为什么要这样做？', createdAt: '2026-11-11T09:08:00Z', context: none, status: '待整理', destination: null },
  ];
  const markdown = m.formatQuickNotesMarkdown(notes);
  assert(markdown.indexOf('## 2026-11-12') < markdown.indexOf('## 2026-11-11'), '按日期从新到旧分组');
  assert.match(markdown, /The lights went out\. · 00:12/, '导出上下文');
  assert.match(markdown, /去向：例句：mitigate/, '导出去向');
  assert.match(markdown, /去向：待整理/, '待整理去向明确');
  const boundaryStamp = new Date('2026-11-12T05:30:00Z');
  const pad = value => String(value).padStart(2, '0');
  const localDate = `${boundaryStamp.getFullYear()}-${pad(boundaryStamp.getMonth() + 1)}-${pad(boundaryStamp.getDate())}`;
  const localTime = `${pad(boundaryStamp.getHours())}:${pad(boundaryStamp.getMinutes())}`;
  const boundaryMarkdown = m.formatQuickNotesMarkdown([{ ...notes[0], createdAt: '2026-11-12T05:30:00Z', body: 'Local clock boundary' }]);
  assert(boundaryMarkdown.includes(`## ${localDate}\n`), '导出日期按本机时区分组');
  assert(boundaryMarkdown.includes(`- ${localTime} Local clock boundary`), '导出时刻按本机时区显示');
  assert.deepEqual(m.quickNoteReopenArgs(22), [22, '待整理', ''], '撤回时设置待整理并清空旧去向');
  assert.equal(m.quickNoteWordPrefill('  “mitigate.”  '), 'mitigate');
  assert.equal(m.quickNoteWordPrefill('Why does this happen?'), null);
  await assert.rejects(modelHttp.withRequestTimeout(5, signal => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Request cancelled')));
  })), modelHttp.RequestTimeoutError, 'Tauri 请求被取消时仍按自有计时器识别超时');
  console.log('test-quicknote-triage: ok');
} finally {
  fs.rmSync(bundled, { force: true });
  fs.rmSync(bundledModelHttp, { force: true });
}
