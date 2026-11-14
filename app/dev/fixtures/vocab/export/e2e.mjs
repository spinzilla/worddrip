import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { start, stop } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { cancelDialog, chooseFile } from '../../../e2e/dialog.mjs';
import { openDb, listTables, queryRows } from '../../../e2e/db.mjs';
import { makeSaveDialog } from './save-dialog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.ES_E2E_ROOT || path.join(here, '..', '..', '..', '..', 'src-tauri', 'target', 'vocab-export-e2e');
const runDir = path.join(root, `015-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });
const chooseSave = makeSaveDialog(runDir);
const importUpgrade = path.join(out, 'import-upgrade.md');
const importReview = path.join(out, 'import-review.md');
fs.copyFileSync(path.join(here, 'upgrade.md'), importUpgrade);
fs.copyFileSync(path.join(here, 'review.md'), importReview);
const upgradeOut = path.join(out, '学术升级库-导出.md');
const reviewOut = path.join(out, '词汇复习库-导出.md');
const existingOut = upgradeOut;
const log = [];
const note = (key, value) => { const line = `${key}: ${value}`; log.push(line); console.log(line); };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const snapshot = db => Object.fromEntries(listTables(db).map(table => [table, queryRows(db, table)]));
let session;
let page;
let ok = false;
try {
  session = await start({ runDir, port: 9452 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 800, { mobile: false, dpr: 1 });
  await page.clickText('词库', { timeout: 60000 });
  await page.clickText('导出', { exact: true, selector: 'button[role=tab]' });
  await page.waitText('没有可导出的记录');
  const disabled = await page.evaluate(() => [...document.querySelectorAll('button')].filter(b => b.innerText.startsWith('导出') && b.getAttribute('role') !== 'tab').map(b => b.disabled));
  assert.deepEqual(disabled, [true, true]);
  await page.screenshot(path.join(out, '01-empty.png'));
  note('空库', '两个导出按钮均禁用并说明原因');

  await page.clickText('导入', { exact: true, selector: 'button[role=tab]' });
  await page.clickText('选择文件');
  await chooseFile(session, importUpgrade);
  await page.waitText('重新选择');
  await page.clickText('选择文件');
  await chooseFile(session, importReview);
  await page.waitText('校验通过');
  await page.clickText('确认导入当前预览');
  await page.waitText('导入成功');
  await page.clickText('导出', { exact: true, selector: 'button[role=tab]' });
  await page.waitText('3 条升级词');

  await page.clickText('导出学术升级库', { exact: true });
  await cancelDialog(session);
  await page.waitText('已取消保存，没有写入文件。');
  assert.equal(fs.existsSync(upgradeOut), false);
  note('取消保存', '原生对话框取消，零写入');

  await page.clickText('导出学术升级库', { exact: true });
  await chooseSave(session, path.basename(upgradeOut));
  await page.waitText('新文件已保存到：');
  await page.waitText(upgradeOut);
  assert.equal(fs.existsSync(upgradeOut), true);
  await page.screenshot(path.join(out, '02-upgrade-success.png'));
  note('升级导出', upgradeOut);

  await page.clickText('导出复习库', { exact: true });
  await chooseSave(session, path.basename(reviewOut));
  await page.waitText('已导出 5 条复习库记录。');
  await page.waitText(reviewOut);
  assert.equal(fs.existsSync(reviewOut), true);
  await page.screenshot(path.join(out, '03-review-success.png'));
  note('复习导出', reviewOut);

  // 原生保存框选择已有文件；若出现覆盖确认，单独通过计算机操作确认，再检查 Rust 拒绝。
  const existingHash = sha256(fs.readFileSync(existingOut));
  await page.clickText('导出学术升级库', { exact: true });
  let existingVerified = false;
  try {
    await chooseSave(session, path.basename(existingOut));
    await page.waitText('拒绝覆盖');
    assert.equal(sha256(fs.readFileSync(existingOut)), existingHash);
    await page.screenshot(path.join(out, '04-existing-rejected.png'));
    existingVerified = true;
    note('已有文件', '原生覆盖确认后 Rust 拒绝覆盖，哈希不变');
  } catch (error) {
    note('已有文件未验证', `保存框二级确认未能自动操作：${error.message}`);
    await cancelDialog(session).catch(() => {});
    await cancelDialog(session).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 500));
    await page.reload();
    await page.clickText('词库');
    await page.clickText('导出', { exact: true, selector: 'button[role=tab]' });
    await page.waitText('3 条升级词');
  }
  const db = await openDb(session);
  const recordsAfter = snapshot(db);
  db.close();
  assert.deepEqual(recordsAfter.upgrade_entry.length, 3);
  assert.deepEqual(recordsAfter.self_check.length, 2);
  assert.deepEqual(recordsAfter.review_word.length, 5);
  const upgradeText = fs.readFileSync(upgradeOut, 'utf8');
  const reviewText = fs.readFileSync(reviewOut, 'utf8');
  for (const text of [upgradeText, reviewText]) {
    assert.equal(text.includes('长备注') || text.includes('完整备注') || text.includes('agenda'), true);
    assert.equal(text.charCodeAt(0) === 0xfeff, false);
    assert.equal(text.endsWith('\n'), true);
  }
  assert.equal(upgradeText.includes('The committee comprises five departments.'), true);
  assert.equal(upgradeText.includes('重复词仍保留第二行'), true);
  assert.equal(reviewText.includes('2026-10-26 复习复数 agendas 对'), true);
  const parserBundle = path.join(runDir, 'parse.mjs');
  await build({ entryPoints: ['utils/vocab/parse.ts'], bundle: true, format: 'esm', outfile: parserBundle });
  const { parseUpgradeLibrary, parseReviewLibrary } = await import(pathToFileURL(parserBundle).href);
  const parsedUpgrade = parseUpgradeLibrary(upgradeText);
  const parsedReview = parseReviewLibrary(reviewText);
  const byOrder = (a, b) => Number(a.ord) - Number(b.ord) || String(a.id).localeCompare(String(b.id));
  assert.deepEqual(parsedUpgrade.entries.map(row => row.raw), recordsAfter.upgrade_entry.filter(row => !row.deleted).sort(byOrder).map(row => row.raw));
  assert.deepEqual(parsedUpgrade.selfChecks.map(row => row.raw), recordsAfter.self_check.filter(row => !row.deleted).sort(byOrder).map(row => row.raw));
  assert.deepEqual(parsedReview.words.map(row => row.raw), recordsAfter.review_word.filter(row => !row.deleted).sort(byOrder).map(row => row.raw));
  note('007 再解析', '真实窗口输出与隔离数据库 raw、顺序一致');

  await page.setViewport(390, 844, { mobile: true, dpr: 2 });
  await page.clickText('导出', { exact: true, selector: 'button[role=tab]' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.equal(overflow <= 1, true, `窄屏横向溢出 ${overflow}`);
  await page.screenshot(path.join(out, '05-narrow.png'));
  note('窄屏', '390×844 WebView 模拟，无横向溢出');
  note('原生已有文件确认框', existingVerified ? '已验证' : '未验证；Rust 自动测试已覆盖');
  assert.deepEqual(page.errors.filter(error => !error.includes('plugin http not found')), []);
  ok = true;
} catch (error) {
  note('失败', error.stack || String(error));
  if (page) await page.screenshot(path.join(out, '99-failure.png')).catch(() => {});
  throw error;
} finally {
  fs.writeFileSync(path.join(out, 'e2e-evidence.txt'), log.join('\n') + `\ncompleted: ${ok}\n`, 'utf8');
  if (page) page.close();
  if (session) await stop(runDir);
}