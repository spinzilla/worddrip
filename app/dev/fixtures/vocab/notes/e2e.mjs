// 040 真实窗口验证：隔离数据库里给一个词加两条笔记、改一条、删一条（删除要二次确认）；
// 笔记里的英文能点词查词；重启后还在；「有笔记的词」筛选和搜笔记正文都能找到它；升级对照里同一个词看到同一组笔记；
// 导出复习库时同目录多一份「我的笔记.md」，原 Markdown 不变；1280 / 390 宽截图。不调用真实模型。
// 用法（在 app 目录）：node dev/fixtures/vocab/notes/e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { start, stop, restart, DEV_PORT } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { openDb, queryRows } from '../../../e2e/db.mjs';
import { portInUse } from '../../../e2e/proc.mjs';

if (await portInUse(DEV_PORT)) {
  console.error(`${DEV_PORT} 端口已被占用（可能有别的开发窗口在跑），先关掉再测。`);
  process.exit(1);
}

const root = path.resolve('src-tauri/target/e2e');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.join(root, `040-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });

// alpha 同时是复习词和升级条目的候选词，用来验证两处看到同一组笔记。
const upgrade = `## 词汇升级
| 日常/口语 | 学术升级 | 例句 | 出处 | 备注 |
|---|---|---|---|---|
| first | **alpha** / beta | alpha: Alpha comes first. | 测试 | 保留 |

## 写作自查对照
- dummy check
`;
const review = `# 词汇总词库
## 总词库
| 单词 | 期号 | 入库日期 | 状态 | 下次到期 | 备注 |
|---|---|---|---|---|---|
| alpha | 1 | 2026-11-01 | L1 | 2026-11-09 | alpha 表格备注 |
| beta | 1 | 2026-11-01 | L1 | 2026-11-09 | beta note |
| gamma | 1 | 2026-11-01 | L1 | 2026-11-09 | gamma note |
`;
const bundled = path.join(runDir, 'import-preview.mjs');
await build({ entryPoints: ['utils/vocab/import.ts'], bundle: true, format: 'esm', outfile: bundled, logLevel: 'silent' });
const { buildImportPreview } = await import(pathToFileURL(bundled).href);
const preview = buildImportPreview({ fileName: 'upgrade.md', content: upgrade }, { fileName: 'review.md', content: review });
assert.deepEqual(preview.errors, []);

const NOTE_1 = '第一条：和 beta 容易混。\nThe economy proved resilient after the storm.';
const NOTE_1_EDITED = '第一条（改过）：和 beta 容易混，看语境。\nThe economy proved resilient after the storm.';
const NOTE_2 = '第二条：这条会被删掉';

const log = [];
const note = (key, value) => { const line = `${key}: ${value}`; log.push(line); console.log(line); };
const invoke = async (page, command, args = {}) => {
  const outcome = await page.evaluate(async (cmd, payload) => {
    try { return { value: await window.__TAURI_INTERNALS__.invoke(cmd, payload) }; }
    catch (error) { return { error: typeof error === 'string' ? error : String(error) }; }
  }, command, args);
  if (outcome.error) throw new Error(`${command} 失败：${outcome.error}`);
  return outcome.value;
};
const select = async (page, selector, value) => {
  await page.evaluate(({ selector, value }) => {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLSelectElement)) throw new Error(`找不到下拉框：${selector}`);
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, { selector, value });
  await new Promise(resolve => setTimeout(resolve, 150));
};
const openReviews = async page => {
  await page.clickText('词库');
  await page.clickText('查词', { selector: 'button[role=tab]', exact: true });
  await page.waitFor('[data-testid=vocab-list]');
};
const openWord = async (page, word) => {
  await page.evaluate(wanted => {
    const row = [...document.querySelectorAll('[data-testid=vocab-list] > button')].find(element => element.innerText.trim().startsWith(wanted));
    if (!row) throw new Error(`列表里没有 ${wanted}`);
    row.click();
  }, word);
  await page.waitFor('[data-testid=notes-section]');
};
const rowTexts = page => page.evaluate(() => [...document.querySelectorAll('[data-testid=vocab-list] > button')].map(element => element.innerText));
const noteBodies = page => page.evaluate(() => [...document.querySelectorAll('[data-testid=notes-section] [data-testid=note-body]')].map(element => element.innerText));
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const clickInItem = async (page, index, testId) => {
  await page.evaluate(({ index, testId }) => {
    const item = document.querySelectorAll('[data-testid=notes-section] [data-testid=note-item]')[index];
    const button = item?.querySelector(`[data-testid=${testId}]`);
    if (!(button instanceof HTMLElement)) throw new Error(`第 ${index + 1} 条笔记里找不到 ${testId}`);
    button.click();
  }, { index, testId });
  await new Promise(resolve => setTimeout(resolve, 150));
};
const addNote = async (page, body) => {
  const before = (await noteBodies(page)).length;
  await page.type('[data-testid=notes-section] [data-testid=note-input]', body);
  await page.click('[data-testid=notes-section] [data-testid=note-add]');
  await page.waitUntil('笔记出现在列表里', `document.querySelectorAll('[data-testid=notes-section] [data-testid=note-item]').length === ${before + 1}`);
};
/** 用 Range 找词的屏幕坐标，再走 CDP 鼠标事件点它（和 034 的点词查词测试同一做法）。 */
const clickWord = async (page, selector, word) => {
  const point = await page.evaluate((sel, wanted) => {
    const root = document.querySelector(sel);
    root.scrollIntoView({ block: 'center' });
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const at = node.data.indexOf(wanted);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + wanted.length);
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    throw new Error(`在 ${sel} 里找不到词：${wanted}`);
  }, selector, word);
  await page.mouseClick(point.x, point.y);
  await page.waitFor('[data-definition-popup] [role=dialog]');
};

let session;
let page;
let passed = false;
const evidence = { runDir, checks: {} };
try {
  session = await start({ runDir, port: 9480 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.clickText('词库');
  assert.equal((await invoke(page, 'vocab_import', { request: preview.input })).reviewWords.added, 3);
  assert.deepEqual(await invoke(page, 'vocab_notes'), []);
  await page.reload();
  await openReviews(page);
  assert.equal((await rowTexts(page)).length, 3);

  // 1. 空状态 → 加两条（新的在上）
  await openWord(page, 'alpha');
  await page.waitFor('[data-testid=notes-empty]');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=note-add]').disabled), true, '空内容不能添加');
  await page.screenshot(path.join(out, '01-empty-1280.png'));
  await addNote(page, NOTE_1);
  await new Promise(resolve => setTimeout(resolve, 20));
  await addNote(page, NOTE_2);
  assert.deepEqual(await noteBodies(page), [NOTE_2, NOTE_1], '新的在上，多行原样显示');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=note-input]').value), '', '添加后清空输入框');
  const sources = await page.evaluate(() => [...document.querySelectorAll('[data-testid=note-source]')].map(element => element.innerText));
  assert.deepEqual(sources, ['词库', '词库']);
  const times = await page.evaluate(() => [...document.querySelectorAll('[data-testid=note-time]')].map(element => element.innerText));
  assert.ok(times.every(text => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)), times.join(','));
  assert.match(await page.text('[data-testid=notes-section] h4'), /我的笔记（2）/);
  assert.match((await rowTexts(page)).find(text => text.startsWith('alpha')), /笔记 2/, '列表行显示笔记条数');
  note('添加', 'alpha 加了两条笔记，新的在上，带日期和来源「词库」');

  // 2. 改旧的那条
  await clickInItem(page, 1, 'note-edit');
  await page.type('[data-testid=note-edit-input]', NOTE_1_EDITED);
  await page.screenshot(path.join(out, '02-editing-1280.png'));
  await page.click('[data-testid=note-save]');
  await page.waitUntil('编辑保存完成', `!document.querySelector('[data-testid=note-edit-input]')`);
  assert.deepEqual(await noteBodies(page), [NOTE_2, NOTE_1_EDITED]);
  assert.match(await page.evaluate(() => document.querySelectorAll('[data-testid=note-item]')[1].innerText), /已修改/);
  note('编辑', '第二条（较旧那条）改好，显示「已修改」');

  // 3. 删新的那条：先点「不删了」确认不会误删，再真删
  await clickInItem(page, 0, 'note-delete');
  await page.waitFor('[data-testid=note-delete-confirm]');
  await page.screenshot(path.join(out, '03-delete-confirm-1280.png'));
  await page.click('[data-testid=note-delete-no]');
  assert.equal((await noteBodies(page)).length, 2, '取消删除后还在');
  await clickInItem(page, 0, 'note-delete');
  await page.click('[data-testid=note-delete-yes]');
  await page.waitUntil('删除完成', `document.querySelectorAll('[data-testid=notes-section] [data-testid=note-item]').length === 1`);
  assert.deepEqual(await noteBodies(page), [NOTE_1_EDITED]);
  note('删除', '二次确认后删掉一条，剩 1 条');

  // 4. 笔记里的英文能点词查词
  await clickWord(page, '[data-testid=notes-section] [data-testid=note-body]', 'resilient');
  // 隔离环境没配模型、没装词典：等「查询中」结束，卡片上至少要有被点的词。
  await page.waitUntil('查词卡加载完', `!(document.querySelector('[data-definition-popup]')?.innerText ?? '').includes('Looking it up')`, { timeout: 30000 });
  evidence.lookupPopup = await page.text('[data-definition-popup]');
  assert.match(evidence.lookupPopup, /resilient/i);
  await page.screenshot(path.join(out, '04-note-lookup-1280.png'));
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await page.waitUntil('查词卡关闭', `!document.querySelector('[data-definition-popup]')`);
  evidence.checks.lookup = true;
  note('点词查词', '点笔记里的 resilient 弹出查词卡');

  // 5. 重启后还在；筛选「有笔记的词」；搜笔记正文
  session = await restart(runDir);
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await openReviews(page);
  await select(page, '[data-testid=note-filter]', 'has');
  const filtered = await rowTexts(page);
  // 空查询 + 有笔记：alpha（复习词）+ 含 alpha 候选的升级条目
  assert.equal(filtered.filter(text => text.startsWith('alpha')).length, 1);
  assert.equal(filtered.some(text => /beta|gamma/.test(text.split('\n')[0])), false, '没笔记的词被筛掉');
  assert.match(await page.text('[data-testid=vocab-count]'), /匹配 \d+ \/ 共 \d+ 条/);
  await page.screenshot(path.join(out, '05-filter-has-notes-1280.png'));
  await openWord(page, 'alpha');
  assert.deepEqual(await noteBodies(page), [NOTE_1_EDITED], '重启后笔记还在');
  await select(page, '[data-testid=note-filter]', 'all');
  await page.type('[data-testid=vocab-search]', '容易混');
  await page.waitUntil('搜到笔记正文', `[...document.querySelectorAll('[data-testid=vocab-list] > button')].some(b => b.innerText.startsWith('alpha') && b.innerText.includes('我的笔记'))`);
  await page.screenshot(path.join(out, '06-search-note-text-1280.png'));
  note('重启/筛选/搜索', '重启后在；「有笔记的词」只剩 alpha；搜「容易混」命中 alpha，原因写「我的笔记」');

  // 6. 升级对照里同一个词看到同一组笔记
  await page.type('[data-testid=vocab-search]', '');
  await page.clickText('升级对照', { selector: 'button[role=tab]', exact: true });
  await page.click('[data-testid=vocab-list] > button[data-kind=upgrade]');
  await page.waitFor('[data-testid=candidate-notes]');
  const candidateNotes = await page.evaluate(() => [...document.querySelectorAll('[data-testid=upgrade-candidate]')].map(item => ({
    name: item.querySelector('.text-lg')?.innerText ?? '',
    open: item.querySelector('[data-testid=candidate-notes]')?.open ?? null,
    bodies: [...item.querySelectorAll('[data-testid=note-body]')].map(element => element.innerText),
  })));
  assert.deepEqual(candidateNotes.find(item => item.name === 'alpha'), { name: 'alpha', open: true, bodies: [NOTE_1_EDITED] });
  assert.ok(candidateNotes.filter(item => item.name !== 'alpha').every(item => item.bodies.length === 0), JSON.stringify(candidateNotes));
  evidence.candidateNotes = candidateNotes;
  await page.evaluate(() => document.querySelector('[data-testid=candidate-notes]').scrollIntoView({ block: 'center' }));
  await new Promise(resolve => setTimeout(resolve, 400));
  await page.screenshot(path.join(out, '07-upgrade-candidate-notes-1280.png'));
  note('升级对照', '候选词 alpha 下显示同一条笔记');

  // 7. 390 宽：详情、编辑框不横向溢出
  await page.clickText('查词', { selector: 'button[role=tab]', exact: true });
  await page.waitFor('[data-testid=vocab-list]');
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  await openWord(page, 'alpha');
  assert.equal(await noOverflow(page), true);
  await page.evaluate(() => document.querySelector('[data-testid=notes-section]').scrollIntoView({ block: 'start' }));
  await page.screenshot(path.join(out, '08-detail-390.png'), { full: false });
  await clickInItem(page, 0, 'note-delete');
  await page.waitFor('[data-testid=note-delete-confirm]');
  assert.equal(await noOverflow(page), true);
  await page.screenshot(path.join(out, '09-delete-confirm-390.png'), { full: false });
  await page.click('[data-testid=note-delete-no]');
  await clickInItem(page, 0, 'note-edit');
  assert.equal(await noOverflow(page), true);
  await page.screenshot(path.join(out, '10-editing-390.png'), { full: false });
  await page.click('[data-testid=note-cancel]');
  evidence.checks.narrow = { width: 390, horizontalOverflow: false };
  note('窄屏', '390 宽详情、删除确认、编辑框都不横向溢出');

  // 8. 导出：同目录多一份「我的笔记.md」，原 Markdown 不变
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  const markdownPath = path.join(out, '复习库.md');
  const exported = await invoke(page, 'vocab_export', { request: { kind: 'review', path: markdownPath } });
  assert.equal(fs.readFileSync(markdownPath, 'utf8'), review, '原 Markdown 不变（表格备注列也没变）');
  assert.equal(exported.notesPath, path.join(out, '我的笔记.md'));
  assert.equal(exported.notes, 1);
  const notesMd = fs.readFileSync(exported.notesPath, 'utf8');
  assert.match(notesMd, /^# 我的笔记\n\n共 1 个词、1 条笔记。按词分组，新的在前。\n\n## alpha\n\n- \d{4}-\d{2}-\d{2} \d{2}:\d{2} · 词库 · 改于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n  第一条（改过）：和 beta 容易混，看语境。\n  The economy proved resilient after the storm.\n$/);
  await page.clickText('导出', { selector: 'button[role=tab]', exact: true });
  await new Promise(resolve => setTimeout(resolve, 600));
  await page.screenshot(path.join(out, '11-export-panel-1280.png'));
  note('导出', `${exported.notesPath} 内容正确`);

  // 9. 数据库：笔记单独一张表，原「备注」列没动
  const db = await openDb(session);
  const words = queryRows(db, 'review_word');
  const noteRows = queryRows(db, 'vocab_note');
  db.close();
  assert.equal(words.find(word => word.word === 'alpha').note, 'alpha 表格备注');
  assert.equal(noteRows.length, 1);
  assert.equal(noteRows[0].word_key, 'alpha');
  assert.equal(noteRows[0].source, '词库');
  assert.equal(noteRows[0].body, NOTE_1_EDITED);
  assert.notEqual(noteRows[0].updated_at, noteRows[0].created_at);

  const unexpectedErrors = page.errors.filter(error => error !== 'plugin http not found');
  assert.deepEqual(unexpectedErrors, []);
  Object.assign(evidence, {
    screenshots: fs.readdirSync(out).filter(name => name.endsWith('.png')).sort(),
    exported, notesMd, noteRows, pageErrors: page.errors, unexpectedErrors, log,
  });
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
  note('证据', path.join(out, 'evidence.json'));
  passed = true;
} catch (error) {
  if (page) await page.screenshot(path.join(out, 'failure.png')).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  if (session) await stop(session.runDir);
  note('隔离窗口', passed ? '全部通过后已关闭' : '失败后已关闭');
}
