// 084 真实窗口：到期复习、新词首考退出后复用待做题，并检查单题消耗不影响其余缓存。
//   在 app 目录：node dev/e2e/recall-cache-084.mjs
// 隔离词库、WebView 数据和截图写在 D:\tmp\es-e2e\084-recall-cache-*；模型由页面内假接口替代。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connect } from './cdp.mjs';
import { start, stop } from './launch.mjs';

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.join('D:\\tmp\\es-e2e', `084-recall-cache-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
const port = 9478;
const words = ['resilient', 'coherent', 'durable', 'precise', 'flexible', 'reliable', 'adaptive'];
const localDate = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const issue = `${new Date().getMonth() + 1}.${new Date().getDate()}`;

function seedWords(session) {
  const db = new DatabaseSync(path.join(session.appData, 'vocab.db'));
  try {
    const insertWord = db.prepare(`
      INSERT INTO review_word
        (id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note,
         imported_at, updated_at, deleted, source, verification_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, 0, '084 隔离回归', '未查证')
    `);
    const insertDefinition = db.prepare(`
      INSERT INTO review_definition (word_id, source_file, source_line, pos, english, chinese)
      VALUES (?, '084-isolated-test.md', ?, 'adj.', 'able to recover after difficulty', '经受打击后能够恢复的')
    `);
    const today = localDate();
    db.exec('BEGIN IMMEDIATE');
    try {
      words.forEach((word, index) => {
        const id = `rv:084-${session.seedMode}-${index + 1}`;
        const status = session.seedMode === 'first' ? '待考察' : 'L1';
        const level = status === 'L1' ? 1 : null;
        const due = status === 'L1' ? today : '';
        const raw = `| ${word} | adj. | able to recover after difficulty | ${status} | ${due} | |`;
        insertWord.run(id, index + 1, index + 1, raw, word, word, issue, today, status, level, due, today, today);
        insertDefinition.run(id, index + 1);
      });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

function setQueueSize(session, kind, keepOnlyFirst) {
  const db = new DatabaseSync(path.join(session.appData, 'vocab.db'));
  const prefix = `rv:084-${kind}-%`;
  const today = localDate();
  try {
    if (kind === 'first') {
      db.prepare(`UPDATE review_word SET status = ?, level = NULL, due = ? WHERE id LIKE ? AND ord > 1`)
        .run(keepOnlyFirst ? '已掌握' : '待考察', '', prefix);
    } else {
      db.prepare(`UPDATE review_word SET status = ?, level = ?, due = ? WHERE id LIKE ? AND ord > 1`)
        .run(keepOnlyFirst ? '已掌握' : 'L1', keepOnlyFirst ? null : 1, keepOnlyFirst ? '' : today, prefix);
    }
  } finally { db.close(); }
}

async function setFakeModel(page) {
  await page.evaluate(() => {
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({
      apiKey: '084-local-test-key', model: '084-fake-model', baseUrl: 'https://fake.invalid/v1',
    }));
    window.__ES_E2E_FILL_ONLY__ = true;
    window.__ES_E2E_MODEL_CALLS__ = 0;
    window.__ES_E2E_HTTP_FETCH__ = async (_url, init) => {
      window.__ES_E2E_MODEL_CALLS__ += 1;
      const epochKey = '084_fake_model_epoch';
      const suffix = Number(localStorage.getItem(epochKey) || '0') + 1;
      localStorage.setItem(epochKey, String(suffix));
      const prompt = JSON.parse(init.body).messages[0].content;
      const marker = 'Items:\n';
      const start = prompt.lastIndexOf(marker);
      if (start < 0) throw new Error('假模型读不到题目请求');
      const items = JSON.parse(prompt.slice(start + marker.length));
      const content = JSON.stringify({ questions: items.map(({ id, target }) => ({
        id,
        meaning: 'able to recover after difficulty',
        sentence: `After ${suffix} trials, the team found the approach [[${target}]] enough to continue the study.`,
      })) });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
  });
}

const cacheKeys = (page, kind) => page.evaluate(prefix => {
  const cache = JSON.parse(localStorage.getItem('english-studio.vocab.recall-pending.v1') || '{}');
  return Object.keys(cache).filter(key => key.startsWith(prefix));
}, `rv:084-${kind}-`);
const clickNth = (page, selector, position) => page.evaluate(({ target, index }) => {
  const element = document.querySelectorAll(target)[index];
  if (!(element instanceof HTMLButtonElement) || element.disabled) {
    throw new Error(`按钮不可点：${target}[${index}]；元素=${element?.outerHTML ?? '不存在'}`);
  }
  element.click();
}, { target: selector, index: position });
const callCount = page => page.evaluate(() => window.__ES_E2E_MODEL_CALLS__);
const questionTexts = page => page.evaluate(() =>
  [...document.querySelectorAll('[data-testid="recall-question"]')].map(element => element.innerText));
const firstQuestion = page => page.evaluate(() =>
  document.querySelector('[data-testid="recall-question"]')?.innerText ?? '');
const pendingCacheSize = (page, kind) => page.evaluate(prefix => {
  const cache = JSON.parse(localStorage.getItem('english-studio.vocab.recall-pending.v1') || '{}');
  return Object.keys(cache).filter(key => key.startsWith(prefix)).length;
}, `rv:084-${kind}-`);
const clickControl = (page, selector) => page.evaluate(target => {
  const element = document.querySelector(target);
  if (!(element instanceof HTMLElement) || element instanceof HTMLButtonElement && element.disabled) {
    throw new Error(`按钮不可点：${target}；元素=${element?.outerHTML ?? '不存在'}`);
  }
  element.click();
}, selector);

async function openRound(page, kind) {
  if (kind === 'due') await clickControl(page, '[data-testid=due-recall-start]');
  else {
    await clickControl(page, '[data-testid=first-test-start]');
    await page.waitFor('[data-testid=first-test-preview]');
    await clickControl(page, '[data-testid=first-preview-skip]');
  }
  await page.waitFor('[data-testid=recall]', { timeout: 10_000 }).catch(async error => {
    console.error(`${kind} 点击后没有打开复习弹层`, await page.evaluate(() => ({
      buttonDisabled: document.querySelector('[data-testid="due-recall-start"]')?.disabled,
      pageErrors: window.__ES_E2E_MODEL_CALLS__,
      body: document.body.innerText.slice(-800),
    })));
    throw error;
  });
  await page.waitFor('[data-testid=recall-question]', { timeout: 90_000 });
  await page.waitUntil('待做题准备完成', "!document.querySelector('[data-testid=recall-preparing]') && !!document.querySelector('[data-testid=recall-question]')", { timeout: 90_000 });
}

async function exitRound(page) {
  await clickControl(page, '[data-testid=recall] header button');
  await page.waitUntil('复习弹层退出', "!document.querySelector('[data-testid=recall]')", { timeout: 15_000 });
}

async function relaunchWithQueue(session, page, kind, keepOnlyFirst) {
  page.close();
  await stop(session.runDir);
  setQueueSize(session, kind, keepOnlyFirst);
  const nextSession = await start({ runDir: session.runDir, port });
  const nextPage = await connect({ port: nextSession.port });
  await nextPage.waitReady();
  await setFakeModel(nextPage);
  await nextPage.clickText(['词库', 'Vocabulary'], { selector: 'header nav button', exact: false });
  await nextPage.waitFor(kind === 'due' ? '[data-testid=due-panel]' : '[data-testid=first-test-panel]');
  const startSelector = kind === 'due' ? '[data-testid=due-recall-start]' : '[data-testid=first-test-start]';
  await nextPage.waitUntil(`${kind} 的开始按钮可用`, `(() => { const button = document.querySelector(${JSON.stringify(startSelector)}); return !!button && !button.disabled; })()`, { timeout: 30_000 });
  return { session: nextSession, page: nextPage };
}

async function runFlow(page, session, kind) {
  await page.waitFor(kind === 'due' ? '[data-testid=due-panel]' : '[data-testid=first-test-panel]');
  const startSelector = kind === 'due' ? '[data-testid=due-recall-start]' : '[data-testid=first-test-start]';
  await page.waitUntil(`${kind} 的开始按钮可用`, `(() => { const button = document.querySelector(${JSON.stringify(startSelector)}); return !!button && !button.disabled; })()`, { timeout: 30_000 });

  await openRound(page, kind);
  const first = await firstQuestion(page);
  assert.ok(first, `${kind}: 首题有题面`);
  assert.equal(await callCount(page), 1, `${kind}: 初次需要模型时只请求一次`);
  await page.screenshot(path.join(out, `${kind}-01-first.png`));
  const firstPage = await questionTexts(page);
  await exitRound(page);

  await openRound(page, kind);
  const resumed = await firstQuestion(page);
  assert.equal(resumed, first, `${kind}: 不作答退出后首题完全相同`);
  assert.deepEqual(await questionTexts(page), firstPage, `${kind}: 重新进入时本屏题目都与上次一致`);
  assert.equal(await callCount(page), 1, `${kind}: 缓存命中没有再次调用假模型`);
  await page.screenshot(path.join(out, `${kind}-02-resumed.png`));

  // 点第二道题的「这题出错了」：不计分，缓存里应只少这一道，其余题照旧。
  const keysBeforeFlag = await cacheKeys(page, kind);
  assert.equal(keysBeforeFlag.length, 7, `${kind}: 点「这题出错了」前缓存有 7 道题`);
  await clickNth(page, '[data-testid=recall-flag]', 1);
  await page.waitUntil(`${kind} 第二题已标出错`, "document.querySelectorAll('[data-testid=recall-flag]')[1]?.getAttribute('aria-pressed') === 'true'", { timeout: 10_000 });
  const keysAfterFlag = await cacheKeys(page, kind);
  const flaggedKeys = keysBeforeFlag.filter(key => !keysAfterFlag.includes(key));
  assert.equal(flaggedKeys.length, 1, `${kind}: 点「这题出错了」只删除一道缓存`);
  assert.equal(keysAfterFlag.length, 6, `${kind}: 点「这题出错了」后缓存剩 6 道`);
  await page.screenshot(path.join(out, `${kind}-02b-flagged.png`));
  console.log(`PASS ${kind}: 点「这题出错了」后，缓存里少了这一道（${flaggedKeys[0]}），其余题保留`);

  // 临时把隔离词库队列缩到一道题，模拟用户只答一题后退出；结束后恢复整批词条。
  await exitRound(page);
  ({ session, page } = await relaunchWithQueue(session, page, kind, true));
  await openRound(page, kind);
  assert.equal(await firstQuestion(page), first, `${kind}: 缩到一道题后仍先复用待做缓存`);
  assert.equal(await callCount(page), 0, `${kind}: 单题缓存命中没有调用假模型`);
  await page.type('[data-testid=recall-input]', words[0]);
  await clickControl(page, '[data-testid=recall-submit]');
  await page.waitFor('[data-testid=recall-result]', { timeout: 20_000 });
  assert.equal(await pendingCacheSize(page, kind), 5, `${kind}: 判完这一题只删除这一道缓存（已标出错的那道也已删，剩 5 道）`);
  await page.screenshot(path.join(out, `${kind}-03-one-graded.png`));
  await exitRound(page);

  ({ session, page } = await relaunchWithQueue(session, page, kind, false));
  await openRound(page, kind);
  const afterOneAnswer = await questionTexts(page);
  assert.notEqual(afterOneAnswer[0], firstPage[0], `${kind}: 判完分的旧题面不再出现`);
  assert.equal(await callCount(page), 1, `${kind}: 只为已作答词重新调用假模型`);
  // 第 1 道（已判分）和第 2 道（已标出错）的题面重新出了，其余题仍来自原缓存。
  assert.ok(firstPage.slice(2).every(text => afterOneAnswer.includes(text)), `${kind}: 其余未做题仍来自原缓存`);
  assert.equal(await pendingCacheSize(page, kind), 7, `${kind}: 其余题命中缓存，重出的题另存回缓存`);
  await page.screenshot(path.join(out, `${kind}-04-after-one-answered.png`));
  console.log(`PASS ${kind}: 退出恢复、模型调用次数、判完一道题后其余缓存保留 ${out}`);
  await exitRound(page);
}

fs.mkdirSync(out, { recursive: true });
let session;
let page;
let failed;
try {
  session = await start({ runDir, port });
  page = await connect({ port: session.port });
  await page.waitReady();
  page.close();
  page = null;
  await stop(session.runDir);
  session.seedMode = 'due';
  seedWords(session);
  session = await start({ runDir, port });
  page = await connect({ port: session.port });
  await page.waitReady();
  await setFakeModel(page);
  await page.clickText(['词库', 'Vocabulary'], { selector: 'header nav button', exact: false });
  await page.waitFor('[data-testid=due-panel]');
  await runFlow(page, session, 'due');

  // 首考使用另一组 ID，避免共用刚测过的到期题缓存。
  page.close();
  page = null;
  await stop(session.runDir);
  const db = new DatabaseSync(path.join(session.appData, 'vocab.db'));
  try {
    db.exec("DELETE FROM review_definition_example WHERE word_id LIKE 'rv:084-due-%'; DELETE FROM review_definition WHERE word_id LIKE 'rv:084-due-%'; DELETE FROM review_word WHERE id LIKE 'rv:084-due-%';");
  } finally { db.close(); }
  session.seedMode = 'first';
  seedWords(session);
  session = await start({ runDir, port });
  page = await connect({ port: session.port });
  await page.waitReady();
  await setFakeModel(page);
  await page.clickText(['词库', 'Vocabulary'], { selector: 'header nav button', exact: false });
  await runFlow(page, session, 'first');
} catch (error) {
  failed = error;
  console.error('FAIL', error);
  if (page) await page.screenshot(path.join(out, '99-failure.png')).catch(() => {});
  process.exitCode = 1;
} finally {
  page?.close();
  if (session) await stop(session.runDir).catch(error => {
    console.error('停止隔离窗口失败：', error.message);
    failed ||= error;
    process.exitCode = 1;
  });
  fs.writeFileSync(path.join(out, 'recall-cache-result.json'), JSON.stringify({
    passed: !failed,
    failure: failed?.message ?? null,
    screenshots: ['due-01-first.png', 'due-02-resumed.png', 'due-02b-flagged.png', 'due-03-one-graded.png', 'due-04-after-one-answered.png', 'first-01-first.png', 'first-02-resumed.png', 'first-02b-flagged.png', 'first-03-one-graded.png', 'first-04-after-one-answered.png'],
  }, null, 2));
  console.log(failed ? '084 真实窗口回归失败' : `084 真实窗口回归通过，截图在 ${out}`);
}
