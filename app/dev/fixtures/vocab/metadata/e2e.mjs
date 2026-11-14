// 025 真实窗口验证：隔离数据库中修改来源与查证状态、筛选、重启和 CSV 导出。
// 用法（在 app 目录）：node dev/fixtures/vocab/metadata/e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { start, stop, restart } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { openDb, queryRows } from '../../../e2e/db.mjs';

const root = path.resolve('src-tauri/target/e2e');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.join(root, `025-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });

const upgrade = `## 词汇升级
| 日常/口语 | 学术升级 | 例句 | 出处 | 备注 |
|---|---|---|---|---|
| dummy | **dummy** | dummy: This is a dummy example. | 测试 | 保留 |

## 写作自查对照
- dummy check
`;
const review = `# 词汇总词库
## 总词库
| 单词 | 期号 | 入库日期 | 状态 | 下次到期 | 备注 |
|---|---|---|---|---|---|
| alpha | 1 | 2026-11-01 | L1 | 2026-11-09 | alpha note |
| beta | 1 | 2026-11-01 | L1 | 2026-11-09 | beta note |
| gamma | 1 | 2026-11-01 | L1 | 2026-11-09 | gamma note |
`;
const bundled = path.join(runDir, 'import-preview.mjs');
await build({ entryPoints: ['utils/vocab/import.ts'], bundle: true, format: 'esm', outfile: bundled });
const { buildImportPreview } = await import(pathToFileURL(bundled).href);
const preview = buildImportPreview(
  { fileName: 'upgrade.md', content: upgrade },
  { fileName: 'review.md', content: review },
);
assert.deepEqual(preview.errors, []);

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
  // 029 改版后复习词在「查词」视图里（空搜索时按 A–Z 列出）。
  await page.clickText('查词', { selector: 'button[role=tab]', exact: true });
  await page.waitFor('[data-testid=vocab-list]');
};
const rowTexts = page => page.evaluate(() =>
  [...document.querySelectorAll('[data-testid=vocab-list] > button')].map(element => element.innerText));
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

let session;
let page;
let passed = false;
try {
  session = await start({ runDir, port: 9460 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.clickText('词库');
  const imported = await invoke(page, 'vocab_import', { request: preview.input });
  assert.equal(imported.reviewWords.added, 3);
  await page.reload();
  await openReviews(page);
  assert.equal((await rowTexts(page)).length, 3);

  await page.click('[data-testid=vocab-list] > button:first-child');
  await page.waitFor('[data-testid=review-metadata-form]');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=review-source]').value), 'Hermes 词库');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=review-verification-status]').value), '未查证');
  // updated_at 精确到秒：等过一秒再保存，后面「保存会更新时间」的断言才不受操作快慢影响。
  await new Promise(resolve => setTimeout(resolve, 1100));
  await page.type('[data-testid=review-source]', '课堂，ACL 词典');
  await select(page, '[data-testid=review-verification-status]', '词典或ACL已查');
  await page.click('[data-testid=review-metadata-save]');
  await page.waitFor('[data-testid=review-metadata-notice]');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=review-metadata-save]').disabled), true);
  await page.screenshot(path.join(out, '01-detail-saved.png'));
  note('详情保存', 'alpha 来源与查证状态已保存，按钮恢复为无改动状态');

  await select(page, '[data-testid=verification-filter]', '未查证');
  const unverifiedRows = await rowTexts(page);
  assert.equal(unverifiedRows.length, 2);
  assert.equal(unverifiedRows.every(text => !text.startsWith('alpha')), true);
  assert.match(await page.text('[data-testid=vocab-count]'), /匹配 2 \/ 共 3 条/);
  await page.screenshot(path.join(out, '02-filter-unverified.png'));

  await select(page, '[data-testid=verification-filter]', '词典或ACL已查');
  const checkedRows = await rowTexts(page);
  assert.equal(checkedRows.length, 1);
  assert.match(checkedRows[0], /alpha/);
  await page.click('[data-testid=vocab-list] > button:first-child');
  // 029 起列表行不再显示来源，改为在详情表单里核对。
  await page.waitFor('[data-testid=review-metadata-form]');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=review-source]').value), '课堂，ACL 词典');
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  assert.equal(await noOverflow(page), true);
  await page.evaluate(() => document.querySelector('[data-testid=review-metadata-form]').scrollIntoView({ block: 'center' }));
  await page.screenshot(path.join(out, '03-detail-390.png'), { full: false });
  note('窄屏', '390 CSS 像素宽度无横向溢出');

  session = await restart(runDir);
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await openReviews(page);
  await select(page, '[data-testid=verification-filter]', '词典或ACL已查');
  assert.equal((await rowTexts(page)).length, 1);
  await page.click('[data-testid=vocab-list] > button:first-child');
  await page.waitFor('[data-testid=review-metadata-form]');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=review-source]').value), '课堂，ACL 词典');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=review-verification-status]').value), '词典或ACL已查');
  await page.screenshot(path.join(out, '04-after-restart.png'));

  const markdownPath = path.join(out, '复习库.md');
  const exported = await invoke(page, 'vocab_export', { request: { kind: 'review', path: markdownPath } });
  assert.equal(exported.sourceCsvPath, path.join(out, '词条来源与查证.csv'));
  assert.equal(fs.readFileSync(markdownPath, 'utf8'), review);
  const csv = fs.readFileSync(exported.sourceCsvPath, 'utf8');
  // 037 起 CSV 开头带 UTF-8 BOM，Excel 双击打开中文才不乱码。
  assert.match(csv, /^﻿词条 ID,词目,来源,查证状态\n/);
  assert.match(csv, /课堂，ACL 词典,词典或ACL已查/);
  assert.equal(csv.trim().split('\n').length, 4);

  const db = await openDb(session);
  const words = queryRows(db, 'review_word').sort((a, b) => Number(a.ord) - Number(b.ord));
  db.close();
  const alpha = words.find(word => word.word === 'alpha');
  assert.equal(alpha.source, '课堂，ACL 词典');
  assert.equal(alpha.verification_status, '词典或ACL已查');
  assert.notEqual(alpha.updated_at, words.find(word => word.word === 'beta').updated_at);
  assert.equal(alpha.raw, '| alpha | 1 | 2026-11-01 | L1 | 2026-11-09 | alpha note |');
  assert.equal(words.filter(word => word.verification_status === '未查证').length, 2);

  const unexpectedErrors = page.errors.filter(error => error !== 'plugin http not found');
  assert.deepEqual(unexpectedErrors, []);
  const evidence = {
    runDir,
    screenshots: fs.readdirSync(out).filter(name => name.endsWith('.png')).sort(),
    exported: { markdownPath, csvPath: exported.sourceCsvPath, csv },
    alpha,
    unverifiedCount: 2,
    checkedCount: 1,
    narrowViewport: { width: 390, horizontalOverflow: false },
    restartedAndPersisted: true,
    pageErrors: page.errors,
    unexpectedErrors,
    log,
  };
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
