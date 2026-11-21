// 097 真实窗口：v14 已掌握词迁移进保温、L4 答对升 L5、保温筛选和词条说明。
// 在 app 目录：node dev/e2e/review-097.mjs
// 仅使用 D:\tmp\es-e2e 下的隔离数据、WebView 和截图。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connect } from './cdp.mjs';
import { start, stop } from './launch.mjs';

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.join('D:\\tmp\\es-e2e', `097-review-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
const port = 9497;
const WORD = 'resilient';
const OLD_WORD = 'persistent';
const localDate = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const plusDays = days => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

function seedV14Rows(session) {
  const db = new DatabaseSync(path.join(session.appData, 'vocab.db'));
  const today = localDate();
  const issue = `${new Date().getMonth() + 1}.${new Date().getDate()}`;
  try {
    const insert = db.prepare(`
      INSERT INTO review_word
        (id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note,
         imported_at, updated_at, deleted, source, verification_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '097 隔离回归', '未查证')
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      insert.run('rv:097-old', 1, 5, `| ${OLD_WORD} | ${issue} | ${today} | ✅已掌握 | — | 旧备注 |`, OLD_WORD, OLD_WORD, issue, today, '✅已掌握', null, '', '旧备注', today, today);
      insert.run('rv:097-l4', 2, 6, `| ${WORD} | ${issue} | ${today} | L4 | ${today} | L4 词 |`, WORD, WORD, issue, today, 'L4', 4, today, 'L4 词', today, today);
      db.prepare(`
        INSERT INTO review_definition (word_id, source_file, source_line, pos, english, chinese)
        VALUES ('rv:097-l4', '097-isolated-test.md', 1, 'adj.', 'able to recover after difficulty', '经受打击后能够恢复的')
      `).run();
      // 模拟仍在 v14 上的库：现有表结构安全可重建，版本号促使启动时执行一次真实迁移。
      db.exec('PRAGMA user_version = 14; COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally { db.close(); }
}

async function setFakeModel(page) {
  await page.evaluate(() => {
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({
      apiKey: '097-local-test-key', model: '097-fake-model', baseUrl: 'https://fake.invalid/v1',
    }));
    window.__ES_E2E_FILL_ONLY__ = true;
    window.__ES_E2E_HTTP_FETCH__ = async (_url, init) => {
      const prompt = JSON.parse(init.body).messages[0].content;
      const marker = 'Items:\n';
      const start = prompt.lastIndexOf(marker);
      if (start < 0) throw new Error('假模型读不到题目请求');
      const items = JSON.parse(prompt.slice(start + marker.length));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        questions: items.map(({ id, target }) => ({
          id, meaning: 'able to recover after difficulty',
          sentence: `After repeated setbacks, the team proved [[${target}]] enough to continue.`,
        })),
      }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  });
}

function readMigratedRows(session) {
  const db = new DatabaseSync(path.join(session.appData, 'vocab.db'), { readOnly: true });
  try {
    return {
      old: db.prepare("SELECT status, level, due, note FROM review_word WHERE id = 'rv:097-old'").get(),
      l4: db.prepare("SELECT status, level, due FROM review_word WHERE id = 'rv:097-l4'").get(),
      version: db.prepare('PRAGMA user_version').get().user_version,
    };
  } finally { db.close(); }
}

const setFilter = (page, value) => page.evaluate(next => {
  const select = document.querySelector('[data-testid=status-filter]');
  if (!(select instanceof HTMLSelectElement)) throw new Error('找不到状态筛选');
  select.value = next;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}, value);
const wordRows = page => page.evaluate(() => [...document.querySelectorAll('[data-testid=vocab-list] .vocab-row')].map(row => row.innerText));

fs.mkdirSync(out, { recursive: true });
let session;
let page;
let failure;
const screenshots = [];
const shot = async name => { await page.screenshot(path.join(out, name)); screenshots.push(name); };

try {
  // 先由当前应用建隔离库，再把两条测试数据写入，并标成旧版本，验证启动迁移。
  session = await start({ runDir, port });
  page = await connect({ port: session.port });
  await page.waitReady();
  page.close(); page = null;
  await stop(session.runDir);
  seedV14Rows(session);

  session = await start({ runDir, port });
  page = await connect({ port: session.port });
  await page.waitReady();
  const migrated = readMigratedRows(session);
  assert.equal(migrated.version, 15);
  assert.deepEqual([migrated.old.status, migrated.old.level], ['L5', 5]);
  assert.ok(migrated.old.due >= plusDays(7) && migrated.old.due <= plusDays(66), `旧词到期日未摊入 7–66 天：${migrated.old.due}`);
  assert.match(migrated.old.note, /已掌握转入保温复习/);
  assert.deepEqual([migrated.l4.status, migrated.l4.level], ['L4', 4]);
  await setFakeModel(page);

  await page.clickText(['词库', 'Vocabulary'], { selector: 'header nav button', exact: false });
  await page.waitFor('[data-testid=due-panel]');
  await page.waitUntil('到期复习按钮可用', "(() => { const e = document.querySelector('[data-testid=due-recall-start]'); return e && !e.disabled; })()", { timeout: 30_000 });
  await page.click('[data-testid=due-recall-start]');
  await page.waitFor('[data-testid=recall-question]', { timeout: 90_000 });
  await page.waitUntil('待做题准备结束', "!document.querySelector('[data-testid=recall-preparing]')", { timeout: 90_000 });
  await page.type('[data-testid=recall-input]', WORD);
  await page.click('[data-testid=recall-submit]');
  await page.waitFor('[data-testid=recall-result]', { timeout: 30_000 });
  await page.click('[data-testid=recall-next]');
  await page.waitFor('[data-testid=recall-summary]', { timeout: 30_000 });
  await page.waitUntil('复习总结显示保温级', "document.querySelector('[data-testid=recall-summary]')?.innerText.includes('保温 1')", { timeout: 10_000 });
  await page.click('[data-testid=recall-finish]');
  await page.waitUntil('复习弹层退出', "!document.querySelector('[data-testid=recall]')", { timeout: 15_000 });

  const db = new DatabaseSync(path.join(session.appData, 'vocab.db'), { readOnly: true });
  let reviewed;
  try { reviewed = db.prepare("SELECT status, level, due FROM review_word WHERE id = 'rv:097-l4'").get(); }
  finally { db.close(); }
  assert.deepEqual([reviewed.status, reviewed.level, reviewed.due], ['L5', 5, plusDays(45)]);

  await page.clickText('浏览', { selector: '[data-testid=vocab-segments] button', exact: true });
  await page.waitFor('[data-testid=vocab-browse]');
  await setFilter(page, 'warming');
  await page.waitUntil('保温筛选显示两条词', "document.querySelectorAll('[data-testid=vocab-list] .vocab-row').length === 2");
  const warmingRows = await wordRows(page);
  assert.ok(warmingRows.some(text => text.includes(WORD)) && warmingRows.some(text => text.includes(OLD_WORD)), JSON.stringify(warmingRows));
  await page.setViewport(1440, 900, { mobile: false, dpr: 1 });
  await shot('01-browse-warming-1440.png');

  await page.setViewport(390, 844, { mobile: true, dpr: 2 });
  await page.evaluate(word => {
    const row = [...document.querySelectorAll('[data-testid=vocab-list] .vocab-row')].find(item => item.innerText.includes(word));
    if (!(row instanceof HTMLButtonElement)) throw new Error('找不到刚进入保温的词条');
    row.click();
  }, WORD);
  await page.waitFor('[data-testid=word-detail]');
  await page.waitUntil('词条页显示保温状态和说明', "document.querySelector('[data-testid=status-chip]')?.innerText.includes('保温 1') && !!document.querySelector('[data-testid=warming-hint]')");
  assert.match(await page.evaluate(() => document.querySelector('[data-testid=warming-hint]').innerText), /45\/90\/180/);
  await page.evaluate(() => document.querySelector('[data-testid=warming-hint]').scrollIntoView({ block: 'center' }));
  await shot('02-warming-detail-390.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, '窄屏词条页不能横向溢出');
  console.log(`097 真实窗口回归通过：迁移、L4→L5、保温筛选、窄屏截图；截图：${out}`);
} catch (error) {
  failure = error;
  console.error('097 真实窗口回归失败：', error);
  if (page) await page.screenshot(path.join(out, '99-failure.png')).catch(() => {});
  process.exitCode = 1;
} finally {
  page?.close();
  if (session) await stop(session.runDir).catch(error => {
    failure ||= error;
    process.exitCode = 1;
    console.error('停止隔离窗口失败：', error.message);
  });
  fs.writeFileSync(path.join(out, 'review-097-result.json'), JSON.stringify({
    passed: !failure,
    failure: failure?.message ?? null,
    screenshots,
  }, null, 2));
}
