// 056 随手记整理页隔离真实窗口：建议、四种去向、编辑/删除/撤回、导出和窄屏截图。
// 用法（在 app 目录）：node dev/fixtures/quicknote/triage/e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { start, stop, DEV_PORT } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { portInUse } from '../../../e2e/proc.mjs';
import { chooseFile } from '../../../e2e/dialog.mjs';
import { makeSaveDialog } from '../../vocab/export/save-dialog.mjs';

if (await portInUse(DEV_PORT)) {
  console.error(`${DEV_PORT} 端口已被占用，先关掉别的开发窗口再测。`);
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.resolve('D:/tmp/es-e2e', `056-quicknote-triage-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });
const chooseSave = makeSaveDialog(runDir);
const exportPath = path.join(out, '随手记.md');
const openSeed = path.join(out, 'open-seed.md');
fs.writeFileSync(openSeed, '# 仅用于设置隔离保存目录\n', 'utf8');
const today = new Date().toISOString().slice(0, 10);
const importRequest = {
  upgrade: { fileName: 'empty-upgrade.md', content: '# 学术升级库\n' },
  review: { fileName: 'quicknote-triage.md', content: '# 词汇总词库\n' },
  entries: [{ id: 'dummy@1', line: 2, raw: '| dummy |', plain: 'dummy', upgrade: 'dummy', source: '测试', note: '' }],
  examples: [], selfChecks: [],
  reviewWords: [{ id: 'mitigate@1', ord: 1, line: 2, raw: '| mitigate |', word: 'mitigate', issue: '56', addedAt: today, status: 'L1', level: 1, due: today, note: '' }],
  warnings: { upgrade: [], review: [] },
};
const invoke = async (page, command, args = {}) => {
  const result = await page.evaluate(async (cmd, payload) => {
    try { return { value: await window.__TAURI_INTERNALS__.invoke(cmd, payload) }; }
    catch (error) { return { error: typeof error === 'string' ? error : String(error) }; }
  }, command, args);
  if (result.error) throw new Error(`${command} 失败：${result.error}`);
  return result.value;
};
const shot = (page, name) => page.screenshot(path.join(out, name), { full: false });
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const notes = page => invoke(page, 'quicknote_list', { status: null });
const noteByBody = async (page, body) => (await notes(page)).find(note => note.body === body);
const waitCount = (page, count) => page.waitUntil(`待整理数变为 ${count}`, `document.querySelector('[data-testid="nav-quicknote-count"]')?.dataset.badge === ${JSON.stringify(String(count))}`);
const waitNoteStatus = (page, body, status) => page.waitUntil(`随手记「${body}」变为${status}`, `window.__TAURI_INTERNALS__.invoke('quicknote_list', { status: null }).then(list => list.some(note => note.body === ${JSON.stringify(body)} && note.status === ${JSON.stringify(status)}))`);
const waitNoteBody = (page, body) => page.waitUntil(`随手记正文变为「${body}」`, `window.__TAURI_INTERNALS__.invoke('quicknote_list', { status: null }).then(list => list.some(note => note.body === ${JSON.stringify(body)}))`);
const localDateTime = value => {
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
};

let session;
let page;
let ok = false;
try {
  session = await start({ runDir, port: 9478 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.clickText('词库', { timeout: 60000 });
  await invoke(page, 'vocab_import', { request: importRequest });
  const seeded = [
    { body: 'resilient', context: { kind: 'none' } },
    { body: 'The result is clear.', context: { kind: 'entry', word: 'mitigate', entryId: 'mitigate@1' } },
    { body: '为什么这个说法更合适？', context: { kind: 'video', text: 'The lights went out.', videoName: 'demo.mp4', time: 12 } },
    { body: 'remember this', context: { kind: 'dictation', text: 'We should reconsider this decision.', time: 8 } },
    { body: '记得复习这一段', context: { kind: 'none' } },
  ];
  for (const request of seeded) await invoke(page, 'quicknote_add', { request });
  const resilientCreatedAt = (await noteByBody(page, 'resilient')).createdAt;
  assert.equal(typeof resilientCreatedAt, 'string', '夹具随手记应返回 createdAt');
  await page.evaluate(() => {
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({ model: 'fake-model', baseUrl: 'https://fake.invalid/v1', apiKey: 'e2e-dummy-key', temperature: 0.3 }));
  });
  await page.reload();
  await page.waitReady();
  await page.evaluate(() => {
    window.__ES_E2E_HTTP_FETCH__ = async (_url, init) => {
      window.__ES_E2E_LAST_MODEL_REQUEST__ = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '这是隔离测试回答。' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  });
  await page.clickText('词库', { timeout: 60000 });
  await page.clickText('导入', { exact: true, selector: 'button[role=tab]' });
  await page.clickText('选择文件');
  await chooseFile(session, openSeed);
  await page.waitText('重新选择');
  await page.click('[data-testid="quicknotes-tab"]');
  await page.waitFor('[data-testid="quicknotes-panel"]');
  await page.waitFor('[data-testid="quicknote-item"]');
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid="quicknote-item"]').length), 5);
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid="quicknote-item"][data-suggestion="vocab"]').length), 1);
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid="quicknote-item"][data-suggestion="example"]').length), 2);
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid="quicknote-item"][data-suggestion="ai"]').length), 1);
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-testid="quicknote-item"][data-suggestion="note"]').length), 1);
  await waitCount(page, 5);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('[data-testid="quicknote-item"][data-suggestion="ai"] [data-testid="quicknote-context"]')].some(item => /字幕：The lights went out\. · 00:12/.test(item.innerText))), true);
  await shot(page, '01-triage-1280.png');

  // 加入词库：手动加词表单预填正文，成功保存后才标记已整理。
  await page.evaluate(() => [...document.querySelectorAll('[data-testid="quicknote-item"]')].find(item => item.dataset.suggestion === 'vocab').querySelector('[data-testid="quicknote-to-vocab"]').click());
  await page.waitFor('[data-testid="manual-word"]');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="manual-word"]').value), 'resilient');
  await page.click('[data-testid="manual-save"]');
  await page.waitFor('[data-testid="manual-toast"]');
  await waitNoteStatus(page, 'resilient', '已整理');
  assert.equal((await notes(page)).find(note => note.body === 'resilient').destination, '词库：resilient');
  await waitCount(page, 4);
  // 新词入库后，仍停留在整理页时例句词条列表也应立即更新。
  await page.evaluate(() => [...document.querySelectorAll('[data-testid="quicknote-item"]')].find(item => item.innerText.includes('remember this')).querySelector('[data-testid="quicknote-to-example"]').click());
  await page.waitFor('[data-testid="quicknote-example-word"]');
  assert.equal(await page.evaluate(() => [...document.querySelector('[data-testid="quicknote-example-word"]').options].some(option => option.value === 'resilient')), true);
  await page.evaluate(() => [...document.querySelectorAll('[data-testid="quicknote-item"]')].find(item => item.innerText.includes('remember this')).querySelector('[data-testid="quicknote-to-example"]').click());
  await page.waitUntil('添加成功提示自动消失', '!document.querySelector("[data-testid=manual-toast]")', { timeout: 10000 });

  // 词条上下文自动选择词；正文保存为「我的例句」后才标记。
  await page.evaluate(() => [...document.querySelectorAll('[data-testid="quicknote-item"]')].find(item => item.innerText.includes('The result is clear.')).querySelector('[data-testid="quicknote-to-example"]').click());
  await waitNoteStatus(page, 'The result is clear.', '已整理');
  assert.equal((await invoke(page, 'vocab_examples')).some(example => example.word.toLowerCase() === 'mitigate' && example.sentence === 'The result is clear.'), true);

  // 问 AI 请求中包含正文和字幕上下文；只问不整理仍是待整理。
  await page.evaluate(() => [...document.querySelectorAll('[data-testid="quicknote-item"]')].find(item => item.dataset.suggestion === 'ai').querySelector('[data-testid="quicknote-ask-ai"]').click());
  await page.waitFor('[data-testid="quicknote-ai-answer"]');
  assert.match(await page.text('[data-testid="quicknote-ai-answer"]'), /AI 回答（这条仍在待整理）\s+这是隔离测试回答。/);
  const modelRequest = await page.evaluate(() => window.__ES_E2E_LAST_MODEL_REQUEST__);
  const prompt = modelRequest.messages[0].content;
  assert.match(prompt, /为什么这个说法更合适？/);
  assert.match(prompt, /字幕：The lights went out\. · 00:12/);
  assert.equal((await noteByBody(page, '为什么这个说法更合适？')).status, '待整理');

  // 留作笔记，全部列表里可以撤回；撤回清去向并重新进入待整理。
  await page.evaluate(() => [...document.querySelectorAll('[data-testid="quicknote-item"]')].find(item => item.innerText.includes('记得复习这一段')).querySelector('[data-testid="quicknote-to-note"]').click());
  await waitNoteStatus(page, '记得复习这一段', '已整理');
  assert.equal((await noteByBody(page, '记得复习这一段')).destination, '笔记');
  await page.click('[data-testid="quicknotes-filter-all"]');
  const noteId = (await noteByBody(page, '记得复习这一段')).id;
  await page.waitFor(`[data-testid="quicknote-item"][data-note-id="${noteId}"] [data-testid="quicknote-reopen"]`);
  await page.evaluate(() => [...document.querySelectorAll('[data-testid="quicknote-item"]')].find(item => item.innerText.includes('记得复习这一段')).querySelector('[data-testid="quicknote-reopen"]').click());
  await waitNoteStatus(page, '记得复习这一段', '待整理');
  const reopened = await noteByBody(page, '记得复习这一段');
  assert.equal(reopened.status, '待整理');
  assert.equal(reopened.destination, null);

  // 修改、删除都要经过用户确认步骤。
  await page.evaluate(() => [...document.querySelectorAll('[data-testid="quicknote-item"]')].find(item => item.innerText.includes('记得复习这一段')).querySelector('[data-testid="quicknote-edit"]').click());
  await page.evaluate(() => { const input = document.querySelector('[data-testid="quicknote-edit-input"]'); input.focus(); input.select(); });
  await page.send('Input.insertText', { text: '编辑后的随手记' });
  await page.click('[data-testid="quicknote-edit-save"]');
  await waitNoteBody(page, '编辑后的随手记');
  assert.equal((await noteByBody(page, '编辑后的随手记')).body, '编辑后的随手记');
  await page.evaluate(() => [...document.querySelectorAll('[data-testid="quicknote-item"]')].find(item => item.innerText.includes('编辑后的随手记')).querySelector('[data-testid="quicknote-delete"]').click());
  await page.evaluate(() => [...document.querySelectorAll('[data-testid="quicknote-item"]')].find(item => item.innerText.includes('编辑后的随手记')).querySelector('[data-testid="quicknote-delete-yes"]').click());
  await page.waitUntil('随手记删除完成', `window.__TAURI_INTERNALS__.invoke('quicknote_list', { status: null }).then(list => !list.some(note => note.body === '编辑后的随手记'))`);
  assert.equal(await noteByBody(page, '编辑后的随手记'), undefined);

  // 导出全部记录，保存到隔离夹具目录后直接核对文件。
  await page.click('[data-testid="quicknotes-export"]');
  await chooseSave(session, exportPath);
  await page.waitText(exportPath);
  assert.equal(fs.existsSync(exportPath), true);
  const markdown = fs.readFileSync(exportPath, 'utf8');
  assert.match(markdown, /# 随手记/);
  assert.match(markdown, /## \d{4}-\d{2}-\d{2}/);
  const resilientLocalTime = localDateTime(resilientCreatedAt);
  const resilientDateGroup = markdown.split(/^## /m).find(group => group.startsWith(`${resilientLocalTime.date}\n`));
  assert(resilientDateGroup?.includes(`- ${resilientLocalTime.time} resilient\n`), 'resilient 应分到 createdAt 的本机日期，时刻也应按本机时间导出');
  assert.match(markdown, /字幕：The lights went out\. · 00:12/);
  assert.match(markdown, /去向：词库：resilient/);
  assert.match(markdown, /去向：例句：mitigate/);
  assert.match(markdown, /去向：笔记|去向：待整理/);

  // 1280 / 390 窄屏：看过真实窗口截图，页面不横向溢出。
  assert.equal(await noOverflow(page), true);
  await page.setViewport(390, 844, { mobile: false, dpr: 1 });
  assert.equal(await noOverflow(page), true);
  await shot(page, '02-triage-390.png');

  // 没配置模型时按钮禁用并说明去「设置」配置。
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.evaluate(() => localStorage.removeItem('linguaclip_ai_config'));
  await page.reload();
  await page.waitReady();
  await page.clickText('词库', { timeout: 60000 });
  await page.waitFor('[data-testid="quicknotes-tab"]');
  await page.click('[data-testid="quicknotes-tab"]');
  await page.waitUntil('随手记分页选中', `document.querySelector('[data-testid="quicknotes-tab"]')?.getAttribute('aria-selected') === 'true'`);
  await page.waitFor('[data-testid="quicknote-item"]');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('[data-testid="quicknote-ask-ai"]')].every(button => button.disabled)), true);
  assert.match(await page.text('[data-testid="quicknotes-panel"]'), /请去「设置」填写/);

  console.log(JSON.stringify({ result: '通过', runDir, exportPath, remaining: (await notes(page)).length, shots: fs.readdirSync(out).filter(name => name.endsWith('.png')), pageErrors: page.errors }, null, 2));
  ok = true;
} catch (error) {
  console.error(error.stack || error);
  if (page && !page.closed) await shot(page, '99-failure.png').catch(() => {});
} finally {
  page?.close();
  if (session) await stop(runDir).catch(error => console.error(`停止隔离窗口失败：${error.message}`));
}
process.exit(ok ? 0 : 1);
