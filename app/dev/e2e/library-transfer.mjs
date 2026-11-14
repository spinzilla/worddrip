// 060 真实窗口往返：A 库导出 -> B 空库先看摘要、取消 -> 再导入覆盖。
// 测试数据用 node:sqlite 放进隔离 A 库（不碰用户库）；界面、文件对话框和导入导出全走真实 Tauri。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connect } from './cdp.mjs';
import { chooseFile } from './dialog.mjs';
import { start, stop } from './launch.mjs';
import { openDb, countRows } from './db.mjs';

const steps = [];
const ok = (name, detail = '') => { steps.push({ name, ok: true, detail }); console.log(`PASS ${name} ${detail}`); };
const nav = async (page, text) => { await page.clickText(text); await new Promise(r => setTimeout(r, 250)); };
let a; let b; let page; let failure; let result = {};
try {
  a = await start({ port: 9360 });
  page = await connect({ port: a.port });
  await page.waitReady('button');
  await nav(page, '词库');
  await page.waitFor('[data-testid="vocab-empty"]');
  await page.click('[data-testid="vocab-add"]');
  await page.type('[data-testid="manual-word"]', 'serendipity');
  await page.click('[data-testid="manual-save"]');
  await page.waitFor('[data-testid="manual-toast"]');
  page.close(); page = null;
  await stop(a.runDir);

  // 两个词、一次复习日志、笔记、我的例句、词典例句和随手记。
  const db = new DatabaseSync(path.join(a.appData, 'vocab.db'));
  const addWord = db.prepare(`INSERT INTO review_word (id, ord, line, raw, word, word_norm, issue, added_at, status,
    level, due, note, imported_at, updated_at, deleted, source, verification_status)
    VALUES (?, ?, 1, ?, ?, ?, '060 测试', '2026-01-01', ?, ?, ?, '原备注', '2026-01-01', '2026-01-02', 0, '测试', '老师确认')`);
  const firstId = db.prepare("SELECT id FROM review_word WHERE word = 'serendipity'").get().id;
  db.prepare("UPDATE review_word SET status = 'L2', level = 2, due = '2020-01-01', note = '原备注', verification_status = '老师确认' WHERE id = ?").run(firstId);
  addWord.run('060-word-2', 2, 'resilient', 'resilient', 'resilient', '🌱待考察', null, '');
  db.prepare(`INSERT INTO review_log (word_id, review_date, kind, correct, before_status, after_status,
    before_due, after_due, created_at) VALUES ('${firstId}', '2026-01-02', 'recall', 1, 'L1', 'L2', '', '2020-01-01', '2026-01-02')`).run();
  db.prepare(`INSERT INTO vocab_note (word_key, word, body, source, created_at, updated_at)
    VALUES ('serendipity', 'serendipity', '060 搬家笔记', '词库', '2026-01-02', '2026-01-02')`).run();
  db.prepare(`INSERT INTO vocab_example (word_key, word, sentence, source, explanation, created_at)
    VALUES ('serendipity', 'serendipity', 'Meeting her was pure serendipity.', '自己写', '060 我的例句', '2026-01-02')`).run();
  db.prepare(`INSERT INTO quick_note (body, created_at, updated_at, device_id)
    VALUES ('060 搬家随手记', '2026-01-02', '2026-01-02', 'e2e')`).run();
  const definition = db.prepare(`INSERT INTO review_definition (word_id, source_file, source_line, pos, english, chinese)
    VALUES (?, '060.md', 1, 'n.', ?, ?)`);
  definition.run(firstId, 'a pleasant surprise', '意外发现美好事物');
  definition.run('060-word-2', 'able to recover quickly', '有韧性的');
  db.prepare(`INSERT INTO review_definition_example (word_id, source_file, definition_line, seq, sentence, ai)
    VALUES ('${firstId}', '060.md', 1, 1, 'What a happy serendipity!', 0)`).run();
  db.close();
  ok('A 隔离库准备数据', '2 词 / 1 复习记录 / 1 笔记 / 1 随手记');

  a = await start({ runDir: a.runDir, port: 9360 });
  page = await connect({ port: a.port });
  await page.waitReady('button');
  await nav(page, '词库');
  await page.waitText('serendipity');
  await nav(page, '设置');
  await page.clickText('同步与搬家');
  await page.waitFor('[data-testid="library-transfer"]');
  await page.click('[data-testid="library-export"]');
  await chooseFile(a, path.join(a.out, 'roundtrip.wdlib'));
  await page.waitFor('[data-testid="library-export-result"]');
  const exportStatus = await page.text('[data-testid="library-export-result"]');
  const actual = exportStatus.match(/^已导出 (.+)（/)?.[1];
  if (!actual || !fs.existsSync(actual)) throw new Error('找不到真实导出文件：' + exportStatus);
  const exported = 'D:\\tmp\\es-e2e\\060-roundtrip.wdlib';
  fs.copyFileSync(actual, exported);
  fs.unlinkSync(actual);
  result.exportBytes = fs.statSync(exported).size;
  if (!result.exportBytes) throw new Error('导出文件是空的');
  await page.screenshot(path.join(a.out, '01-exported.png'));
  ok('真实窗口导出', `${exported}，${result.exportBytes} 字节`);
  page.close(); page = null;
  await stop(a.runDir); a = null;

  b = await start({ port: 9360 });
  page = await connect({ port: b.port });
  await page.waitReady('button');
  await nav(page, '词库');
  await page.waitFor('[data-testid="vocab-empty"]');
  // 留一个本机标记词：取消必须保住它，覆盖前也必须有旧库可自动备份。
  await page.click('[data-testid="vocab-add"]');
  await page.type('[data-testid="manual-word"]', 'local-before');
  await page.click('[data-testid="manual-save"]');
  await page.waitFor('[data-testid="manual-toast"]');
  await nav(page, '设置');
  await page.clickText('同步与搬家');
  await page.click('[data-testid="library-pick"]');
  await chooseFile(b, exported);
  await page.waitFor('[data-testid="library-confirm"]');
  await page.waitText('会覆盖本机现在的词库。');
  await page.screenshot(path.join(b.out, '02-import-summary.png'));
  ok('摘要确认框截图', path.join(b.out, '02-import-summary.png'));
  await page.click('[data-testid="library-cancel"]');
  await nav(page, '词库');
  await page.waitText('local-before');
  if (await page.evaluate(() => document.body.innerText.includes('serendipity'))) throw new Error('取消后却出现了导入词');
  ok('取消后本机标记词不变');

  await nav(page, '设置');
  await page.clickText('同步与搬家');
  await page.click('[data-testid="library-pick"]');
  await chooseFile(b, exported);
  await page.waitFor('[data-testid="library-confirm"]');
  await page.click('[data-testid="library-confirm-import"]');
  await page.waitFor('[data-testid="library-import-result"]');
  await nav(page, '词库');
  await page.waitText('serendipity');
  await page.waitText('resilient');
  await page.waitFor('[data-kind="word"][data-word-key="w:serendipity"]');
  await page.screenshot(path.join(b.out, '03-imported-library.png'));
  await page.click('[data-kind="word"][data-word-key="w:serendipity"]');
  await page.waitText('060 搬家笔记');
  await page.waitText('Meeting her was pure serendipity.');
  await page.screenshot(path.join(b.out, '04-imported-detail.png'));
  ok('导入后词库与详情截图', '笔记、我的例句、释义都在');

  const imported = await openDb(b);
  for (const table of ['review_word', 'review_log', 'vocab_note', 'vocab_example', 'quick_note']) {
    const expected = table === 'review_word' ? 2 : 1;
    if (countRows(imported, table) !== expected) throw new Error(`${table} 行数不对`);
  }
  const progress = imported.prepare("SELECT status, level, due FROM review_word WHERE id = (SELECT id FROM review_word WHERE word = 'serendipity')").get();
  if (progress.status !== 'L2' || Number(progress.level) !== 2 || progress.due !== '2020-01-01') throw new Error('复习进度不一致');
  imported.close();
  const backups = fs.readdirSync(path.join(b.appData, 'library-backups')).filter(x => x.endsWith('.wdlib'));
  if (!backups.length) throw new Error('没有导入前自动备份');
  result.backups = backups;
  ok('数据库与自动备份核对', backups.join(', '));

  await page.click('[data-testid="quicknotes-tab"]');
  await page.waitText('060 搬家随手记');
  await page.click('[data-testid="quicknotes-export"]');
  await chooseFile(b, path.join(b.out, 'quicknotes.md'));
  await page.waitFor('[data-testid="quicknotes-export-notice"]');
  const quickStatus = await page.text('[data-testid="quicknotes-export-notice"]');
  const quickPath = quickStatus.match(/已导出 1 条随手记：(.+)$/)?.[1];
  if (!quickPath || !fs.readFileSync(quickPath, 'utf8').includes('060 搬家随手记')) throw new Error('随手记导出内容不对');
  fs.unlinkSync(quickPath);
  ok('随手记真实导出', '共用 writePickedFile 路径写出且内容一致');

  // 同一真实 WebView2 强制安卓 UA，检查手机设置页窄屏排版（不是安卓真机）。
  await nav(page, '设置');
  await page.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36' });
  await page.setViewport(390, 844);
  await page.reload();
  await page.waitReady('button');
  await nav(page, '设置');
  await page.clickText('同步与搬家');
  await page.waitFor('[data-testid="library-transfer"]');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (overflow) throw new Error('390px 手机设置页横向溢出');
  await page.screenshot(path.join(b.out, '05-mobile-transfer.png'));
  ok('390×844 手机布局截图', path.join(b.out, '05-mobile-transfer.png'));
} catch (e) {
  failure = e;
  console.error(e.stack || e);
  if (page && b) await page.screenshot(path.join(b.out, '99-failure.png')).catch(() => {});
} finally {
  page?.close();
  if (a) await stop(a.runDir).catch(() => {});
  if (b) await stop(b.runDir).catch(() => {});
  const out = b?.out || a?.out;
  if (out) fs.writeFileSync(path.join(out, 'library-transfer-result.json'), JSON.stringify({ steps, result, failure: failure?.message ?? null }, null, 2));
}
if (failure) process.exit(1);
console.log('060 真实窗口往返通过');


