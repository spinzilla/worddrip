// 091 真实窗口：AI 小窗界面。起 090 的假模型，在真实 Tauri 窗口里走：
//   1440 宽侧栏（直接问、边收边显示、思考折叠、追问带前文、切页面不丢、词条/闪卡带词）
//   → 收起并重启仍收起 → 1100 宽浮层（Esc 关）→ 复习作答中锁定变灰、判完分恢复 → 390 宽 130% 字号手机抽屉。
//   在 app 目录：node dev/e2e/ai-panel-091.mjs
// 隔离词库、WebView 数据和截图写在 D:\tmp\es-e2e\091-ai-panel-*\out；出题的模型请求由页面内假接口替代，
// 聊天请求走本机假模型（dev/sse-fake-model.mjs），用 WebView 自带 fetch（隔离窗口不注册 http 插件）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connect } from './cdp.mjs';
import { restart, start, stop } from './launch.mjs';
import { startFakeModel } from '../sse-fake-model.mjs';

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.join('D:\\tmp\\es-e2e', `091-ai-panel-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
const port = 9491;
const WORD = 'resilient';
fs.mkdirSync(out, { recursive: true });

const localDate = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

function seedWord(session) {
  const db = new DatabaseSync(path.join(session.appData, 'vocab.db'));
  try {
    const today = localDate();
    const issue = `${new Date().getMonth() + 1}.${new Date().getDate()}`;
    const id = 'rv:091-1';
    const raw = `| ${WORD} | adj. | able to recover after difficulty | L1 | ${today} | |`;
    db.prepare(`
      INSERT INTO review_word
        (id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note,
         imported_at, updated_at, deleted, source, verification_status)
      VALUES (?, 1, 1, ?, ?, ?, ?, ?, 'L1', 1, ?, '', ?, ?, 0, '091 隔离回归', '未查证')
    `).run(id, raw, WORD, WORD, issue, today, today, today, today);
    db.prepare(`
      INSERT INTO review_definition (word_id, source_file, source_line, pos, english, chinese)
      VALUES (?, '091-isolated-test.md', 1, 'adj.', 'able to recover after difficulty', '经受打击后能够恢复的')
    `).run(id);
  } finally { db.close(); }
}

const nav = (page, names) => page.clickText(names, { selector: 'header nav button', exact: false });
const key = async (page, name, code) => {
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code, windowsVirtualKeyCode: code === 'Escape' ? 27 : 0 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: code === 'Escape' ? 27 : 0 });
};
const exists = (page, selector) => page.evaluate(sel => !!document.querySelector(sel), selector);
const waitGone = (page, selector, what) => page.waitUntil(what, `!document.querySelector(${JSON.stringify(selector)})`, { timeout: 10_000 });
const textOf = (page, selector) => page.evaluate(sel => document.querySelector(sel)?.innerText ?? '', selector);

/** 每次启动 / 重启后：配假模型；出题请求用页面内假接口，聊天请求走真实 fetch 到本机假模型。 */
async function prep(page, fakePort, model = 'fake-stream') {
  await page.evaluate((portNumber, modelName) => {
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({ apiKey: '091-local-test-key', model: modelName, baseUrl: `http://127.0.0.1:${portNumber}/v1` }));
    window.__ES_E2E_FILL_ONLY__ = true;
    window.__ES_E2E_HTTP_FETCH__ = async (url, init) => {
      const prompt = init?.body ? JSON.parse(init.body).messages?.[0]?.content ?? '' : '';
      const marker = 'Items:\n';
      const at = typeof prompt === 'string' ? prompt.lastIndexOf(marker) : -1;
      if (at >= 0) {
        const items = JSON.parse(prompt.slice(at + marker.length));
        const content = JSON.stringify({ questions: items.map(({ id, target }) => ({
          id, meaning: 'able to recover after difficulty', sentence: `The team found the approach [[${target}]] enough to continue the study.`,
        })) });
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return fetch(url, init);
    };
  }, fakePort, model);
}
const setModel = (page, model) => page.evaluate(name => {
  const cfg = JSON.parse(localStorage.getItem('linguaclip_ai_config'));
  localStorage.setItem('linguaclip_ai_config', JSON.stringify({ ...cfg, model: name }));
}, model);

const setSize = async (page, width, height, mobile = false) => {
  await page.setViewport(width, height, { mobile, dpr: mobile ? 2 : 1 });
  await page.waitUntil(`窗口宽度 ${width}`, `window.innerWidth === ${width}`, { timeout: 10_000 });
};

const overflowing = page => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
const rect = (page, selector) => page.evaluate(sel => {
  const element = document.querySelector(sel);
  if (!element) return null;
  const r = element.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
}, selector);

let fake;
let session;
let page;
let failed;
const report = { screenshots: [] };
// 隐藏窗口里 CSS 动画不走帧，截图会落在动画中途（半透明、位置不对）：截图前关掉动画（只影响测试页面）。
const noAnim = () => page.evaluate(() => { if (document.getElementById('e2e-no-anim')) return; const s = document.createElement('style'); s.id = 'e2e-no-anim'; s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}'; document.head.appendChild(s); });
const shot = async (name) => { await noAnim(); await page.screenshot(path.join(out, name)); report.screenshots.push(name); };
const pass = text => console.log(`PASS ${text}`);

async function ask(question) {
  await page.type('[data-testid=ai-ask-input]', question);
  await page.click('[data-testid=ai-ask-send]');
}

try {
  fake = await startFakeModel({ thinkDelayMs: 150, textDelayMs: 300 });
  // 先起一次建库，关掉后塞一个今日到期的词，再起。
  session = await start({ runDir, port });
  page = await connect({ port: session.port });
  await page.waitReady();
  page.close(); page = null;
  await stop(session.runDir);
  seedWord(session);
  session = await start({ runDir, port });
  page = await connect({ port: session.port });
  await page.waitReady();
  await prep(page, fake.port);
  await page.evaluate(() => { localStorage.removeItem('english-studio.ai-panel.collapsed'); localStorage.removeItem('english-studio.ai-tasks.v1'); });
  await setSize(page, 1440, 900);
  await nav(page, ['词库', 'Vocabulary']);
  await page.waitFor('[data-testid=due-panel]');

  // ---------- 1) 1440：侧栏，直接问、边收边显示 ----------
  await page.waitFor('[data-testid=ai-panel][data-mode=dock]');
  await page.waitUntil('页面往左让出 360px', "getComputedStyle(document.getElementById('root')).paddingRight === '360px'", { timeout: 5000 });
  const dockBox = await rect(page, '[data-testid=ai-panel]');
  assert.ok(dockBox.width >= 355 && dockBox.width <= 365, `侧栏宽约 360，实际 ${dockBox.width}`);
  assert.equal(await overflowing(page), false, '1440 宽无横向溢出');
  pass('1440 宽：右侧出现侧栏并把页面往左让');

  await page.evaluate(() => {
    window.__lens = [];
    const t0 = performance.now();
    window.__lensTimer = setInterval(() => {
      const len = (document.querySelector('[data-testid=ai-task-text]')?.innerText ?? '').length;
      const last = window.__lens.at(-1);
      if (!last || last.len !== len) window.__lens.push({ at: Math.round(performance.now() - t0), len });
    }, 40);
  });
  await ask('说句话');
  await page.waitFor('[data-testid=ai-task]');
  await page.waitUntil('回复完成', "!!document.querySelector('[data-testid=ai-task][data-status=done]')", { timeout: 30_000 });
  const lens = await page.evaluate(() => { clearInterval(window.__lensTimer); return window.__lens; });
  const growing = lens.filter(x => x.len > 0);
  console.log('回复长度随时间：', JSON.stringify(growing));
  assert.ok(growing.length >= 2 && new Set(growing.map(x => x.len)).size >= 2, '回复长度在至少两个不同时刻不同（边收边显示）');
  assert.ok(growing.at(-1).at - growing[0].at >= 300, '第一次和最后一次看到回复相隔够久');
  assert.equal((await textOf(page, '[data-testid=ai-task-text]')).trim(), 'Hello, streaming world!');
  report.lens = growing;
  pass('直接问：回复逐步出现');
  await shot('01-1440-stream-done.png');

  // 思考折叠 → 展开
  const thinkToggle = await textOf(page, '[data-testid=ai-think-toggle]');
  assert.match(thinkToggle, /(思考|Thinking).*\d+/, `思考折叠行：${thinkToggle}`);
  assert.equal(await exists(page, '[data-testid=ai-think-body]'), false, '思考默认折叠');
  await page.click('[data-testid=ai-think-toggle]');
  await page.waitFor('[data-testid=ai-think-body]');
  assert.match(await textOf(page, '[data-testid=ai-think-body]'), /先想一想/, '展开后看到思考内容');
  assert.doesNotMatch(await textOf(page, '[data-testid=ai-task-text]'), /先想一想/, '思考没有混进回复');
  pass('思考默认折叠，可展开');

  // 追问：用回显模型，回复里的条数 = 用户 + 助手 + 追问 = 3
  await setModel(page, 'fake-echo');
  await page.type('[data-testid=ai-followup-input]', '再说一遍');
  await page.click('[data-testid=ai-followup-send]');
  await page.waitUntil('追问完成', "document.querySelector('[data-testid=ai-task]')?.getAttribute('data-status') === 'done' && [...document.querySelectorAll('[data-testid=ai-task-text]')].some(e => e.innerText.includes('收到'))", { timeout: 30_000 });
  const echoed = await page.evaluate(() => [...document.querySelectorAll('[data-testid=ai-task-text]')].map(e => e.innerText).join('|'));
  assert.match(echoed, /收到 3 条消息/, `追问带上了前文：${echoed}`);
  pass('追问：假模型收到 3 条消息（带上了前文）');
  await setModel(page, 'fake-stream');

  // 切页面再回来：任务还在、回复完整
  await nav(page, ['设置', 'Settings']);
  await page.waitFor('[data-testid=ai-panel]');
  await nav(page, ['词库', 'Vocabulary']);
  await page.waitFor('[data-testid=due-panel]');
  await page.waitFor('[data-testid=ai-task]');
  const afterNav = await textOf(page, '[data-testid=ai-task-detail]');
  assert.match(afterNav, /Hello, streaming world!/, '切页面回来第一条回复仍完整');
  assert.match(afterNav, /收到 3 条消息/, '追问回复仍在');
  pass('切页面再回来：任务和回复都在');

  // ---------- 2) 词条详情、闪卡：自动带上当前词 ----------
  await page.click('[data-testid=vocab-list] button[data-kind=word], [data-testid=vocab-list] [data-kind=word]');
  await page.waitFor('[data-testid=ai-context-chip]');
  assert.match(await textOf(page, '[data-testid=ai-context-chip]'), new RegExp(WORD), '词条详情：输入框上方带上当前词');
  await page.waitUntil('详情渲染完', 'document.body.innerText.includes("able to recover")', { timeout: 10_000 });
  await shot('02-1440-entry-detail.png');
  await page.click('[data-testid=ai-context-clear]');
  await waitGone(page, '[data-testid=ai-context-chip]', '点 × 后「关于」消失');
  pass('词条详情带词，点 × 能去掉');

  // 直接问时带上词：改回有词的状态再问，请求里应有该词（先换到闪卡页确认）
  await nav(page, ['词库', 'Vocabulary']);
  await page.click('[data-testid=due-start]');
  await page.waitFor('.vocab-flash-overlay');
  await page.waitFor('[data-testid=ai-context-chip]');
  assert.match(await textOf(page, '[data-testid=ai-context-chip]'), new RegExp(WORD), '闪卡页：带上当前词');
  const overlay = await rect(page, '.vocab-flash-overlay');
  const panelBox = await rect(page, '[data-testid=ai-panel]');
  assert.ok(overlay.right <= panelBox.left + 1, `闪卡遮罩不盖住侧栏（遮罩右 ${overlay.right}，侧栏左 ${panelBox.left}）`);
  const before = fake.requests.length;
  await ask('这个词怎么用');
  await page.waitUntil('带词提问完成', "document.querySelector('[data-testid=ai-task]')?.getAttribute('data-status') === 'done'", { timeout: 30_000 });
  const sent = fake.requests.slice(before).at(-1).body.messages.map(m => m.content).join('\n');
  assert.ok(sent.includes(WORD), '提问里带上了当前词');
  await shot('03-1440-flashcards.png');
  pass('闪卡页带词，闪卡不被侧栏挤坏');
  await key(page, 'Escape', 'Escape');
  await waitGone(page, '.vocab-flash-overlay', '退出闪卡');

  // ---------- 3) 收起 → 重启 → 仍收起 ----------
  await page.click('[data-testid=ai-collapse]');
  await page.waitFor('[data-testid=ai-toggle][data-mode=dock]');
  assert.equal(await exists(page, '[data-testid=ai-panel]'), false);
  await page.waitUntil('收起后页面只让出窄边（40px）', "getComputedStyle(document.getElementById('root')).paddingRight === '40px'", { timeout: 5000 });
  await shot('04-1440-collapsed.png');
  page.close(); page = null;
  session = await restart(session.runDir);
  page = await connect({ port: session.port });
  await page.waitReady();
  await prep(page, fake.port);
  await setSize(page, 1440, 900);
  await nav(page, ['词库', 'Vocabulary']);
  await page.waitFor('[data-testid=ai-toggle][data-mode=dock]');
  assert.equal(await exists(page, '[data-testid=ai-panel]'), false, '重启后仍是收起');
  pass('收起成窄边，重启后仍收起');
  await page.click('[data-testid=ai-toggle]');
  await page.waitFor('[data-testid=ai-panel][data-mode=dock]');
  assert.ok(await exists(page, '[data-testid=ai-task]'), '重启后历史任务还在');

  // ---------- 4) 1100：浮层 ----------
  await setSize(page, 1100, 800);
  await page.waitFor('[data-testid=ai-toggle][data-mode=float]');
  assert.equal(await exists(page, '[data-testid=ai-panel]'), false, '1100 宽不占位置');
  await page.waitUntil('浮层不占位置（0px）', "getComputedStyle(document.getElementById('root')).paddingRight === '0px'", { timeout: 5000 });
  await page.click('[data-testid=ai-toggle]');
  await page.waitFor('[data-testid=ai-panel][data-mode=float]');
  await shot('05-1100-float.png');
  await key(page, 'Escape', 'Escape');
  await waitGone(page, '[data-testid=ai-panel]', 'Esc 关掉浮层');
  await page.click('[data-testid=ai-toggle]');
  await page.waitFor('[data-testid=ai-panel][data-mode=float]');
  await page.mouseClick(200, 400); // 点外面
  await waitGone(page, '[data-testid=ai-panel]', '点外面关掉浮层');
  pass('1100 宽：右下角按钮开浮层，Esc 和点外面都能关');

  // ---------- 5) 复习作答中：锁定、变灰；判完分恢复 ----------
  await setSize(page, 1440, 900);
  await page.waitFor('[data-testid=ai-panel][data-mode=dock]'); // 之前展开过，回到宽屏就是侧栏
  await nav(page, ['词库', 'Vocabulary']);
  await page.waitFor('[data-testid=due-recall-start]');
  await page.waitUntil('开始按钮可用', "!document.querySelector('[data-testid=due-recall-start]').disabled", { timeout: 30_000 });
  await page.click('[data-testid=due-recall-start]');
  await page.waitFor('[data-testid=recall-question]', { timeout: 90_000 });
  await page.waitFor('[data-testid=ai-toggle][data-locked="1"]');
  assert.equal(await exists(page, '[data-testid=ai-panel]'), false, '作答中小窗收起');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=ai-toggle]').getAttribute('aria-disabled')), 'true');
  await page.click('[data-testid=ai-toggle]');
  await page.waitFor('[data-testid=ai-lock-tip]');
  assert.match(await textOf(page, '[data-testid=ai-lock-tip]'), /作答中不能用 AI|No AI while you are answering/, '点灰按钮有提示');
  await shot('06-1440-review-locked.png');
  // 判分前，直接建「直接问」任务会被中心拒绝（作答锁）
  const refused = await page.evaluate(async () => {
    const { aiTasks } = await import('/utils/aiTasks/index.ts');
    return aiTasks.create({ title: 'x', source: { kind: 'e2e' }, prompt: 'x', mode: 'direct' });
  });
  assert.equal(refused.ok, false, '作答中直接问被作答锁拒绝');
  await page.type('[data-testid=recall-input]', WORD);
  await page.click('[data-testid=recall-submit]');
  await page.waitFor('[data-testid=recall-result]', { timeout: 20_000 });
  await page.waitFor('[data-testid=ai-panel][data-mode=dock]');
  assert.equal(await exists(page, '[data-testid=ai-toggle][data-locked="1"]'), false, '判完分后恢复');
  await shot('07-1440-review-graded.png');
  pass('复习作答中小窗收起、按钮变灰；判完分后恢复');
  await page.click('[data-testid=recall] header button');
  await waitGone(page, '[data-testid=recall]', '退出复习');

  // 1100 浮层下作答中的灰圆按钮
  await setSize(page, 1100, 800);
  await nav(page, ['词库', 'Vocabulary']);
  await page.waitUntil('开始按钮可用', "!!document.querySelector('[data-testid=due-recall-start]') && !document.querySelector('[data-testid=due-recall-start]').disabled", { timeout: 30_000 });
  await page.click('[data-testid=due-recall-start]');
  await page.waitFor('[data-testid=recall-question]', { timeout: 90_000 });
  await page.waitFor('[data-testid=ai-toggle][data-locked="1"]');
  await shot('08-1100-review-locked-fab.png');
  await page.click('[data-testid=recall] header button');
  await waitGone(page, '[data-testid=recall]', '退出复习');
  await page.waitFor('[data-testid=ai-toggle][data-locked="0"]');

  // ---------- 6) 手机 390 宽、130% 字号 ----------
  await setSize(page, 390, 844, true);
  await page.evaluate(() => { document.documentElement.style.fontSize = '130%'; });
  await page.waitFor('[data-testid=ai-toggle][data-mode=mobile]');
  assert.equal(await overflowing(page), false, '手机 390 宽 130% 字号：页面不横向溢出');
  // 先让一个任务在跑，收着时按钮上应有小圆点
  await page.evaluate(async () => {
    const { aiTasks } = await import('/utils/aiTasks/index.ts');
    aiTasks.create({ title: 'dot', source: { kind: 'e2e' }, prompt: '慢' });
  });
  await page.waitFor('[data-testid=ai-dot]');
  pass('任务在跑而小窗收着：按钮上有小圆点');
  await page.waitUntil('任务结束', "!document.querySelector('[data-testid=ai-dot]')", { timeout: 20_000 });
  // 闪卡页：圆按钮不挡 上一张 / 下一张
  await page.click('[data-testid=due-start]');
  await page.waitFor('.vocab-flash-controls');
  const fab = await rect(page, '[data-testid=ai-toggle]');
  const ctrl = await page.evaluate(() => [...document.querySelectorAll('.vocab-flash-controls button')].map(b => {
    const r = b.getBoundingClientRect();
    return { text: b.innerText, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }));
  const hit = ctrl.filter(b => !(fab.right <= b.left || fab.left >= b.right || fab.bottom <= b.top || fab.top >= b.bottom));
  assert.deepEqual(hit, [], `圆按钮不挡闪卡的按钮；按钮 ${JSON.stringify(fab)}，控件 ${JSON.stringify(ctrl)}`);
  await shot('09-mobile-flashcards-130.png');
  // 隐藏窗口里 CSS 动画不走帧，测量位置会落在动画中途：测抽屉前把动画关掉（只影响测试页面）。
  await noAnim();
  // 打开抽屉
  await page.click('[data-testid=ai-toggle]');
  await page.waitFor('[data-testid=ai-panel][data-mode=mobile][data-size=half]');
  const half = await rect(page, '[data-testid=ai-panel]');
  assert.ok(half.height > 844 * 0.45 && half.height < 844 * 0.7, `半屏抽屉高度 ${half.height}`);
  assert.equal(await overflowing(page), false, '抽屉打开不横向溢出');
  const sheetInside = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid=ai-panel]').getBoundingClientRect();
    return [...document.querySelectorAll('[data-testid=ai-panel] *')].filter(e => e.getBoundingClientRect().right > panel.right + 1).length;
  });
  assert.equal(sheetInside, 0, '抽屉里没有内容伸出右边');
  await shot('10-mobile-drawer-half-130.png');
  // 手指拖手柄：上拖变全屏，下拖全屏 → 半屏 → 关闭（用触摸事件，和真手机一样）
  const dragHandle = async dy => {
    const h = await rect(page, '[data-testid=ai-sheet-handle]');
    const x = h.left + h.width / 2; const y = h.top + h.height / 2;
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 6; step += 1) await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (dy * step) / 6 }] });
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await dragHandle(-160);
  await page.waitFor('[data-testid=ai-panel][data-size=full]');
  assert.equal(await overflowing(page), false, '全屏抽屉不横向溢出');
  await shot('11-mobile-drawer-full-130.png');
  const full = await rect(page, '[data-testid=ai-panel]');
  assert.ok(full.height > half.height, '全屏比半屏高');
  await dragHandle(160);
  await page.waitFor('[data-testid=ai-panel][data-size=half]');
  await dragHandle(160);
  await waitGone(page, '[data-testid=ai-panel]', '下拉关闭抽屉');  pass('手机抽屉：半屏 → 拖大到全屏 → 下拉回半屏 → 下拉关闭；不横向溢出');

  // 没配模型：输入框禁用并提示
  await page.evaluate(() => {
    const cfg = JSON.parse(localStorage.getItem('linguaclip_ai_config'));
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({ ...cfg, apiKey: '' }));
  });
  await page.click('[data-testid=ai-toggle]');
  await page.waitFor('[data-testid=ai-no-model]');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=ai-ask-input]').disabled), true, '没配模型输入框禁用');
  assert.match(await textOf(page, '[data-testid=ai-no-model]'), /设置 → AI|Settings → AI/);
  pass('没配模型：输入框禁用并提示去设置');

  assert.deepEqual(page.errors.filter(e => /ai\/|aiTasks|AiPanel/i.test(e)), [], '页面没有和小窗相关的未捕获错误');
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed: true, ...report }, null, 2));
  console.log(`091 真实窗口测试通过，截图在 ${out}`);
} catch (error) {
  failed = error;
  console.error('FAIL', error);
  if (page) await page.screenshot(path.join(out, '99-failure.png')).catch(() => {});
  process.exitCode = 1;
} finally {
  page?.close();
  if (session) await stop(session.runDir).catch(error => { console.error('停止隔离窗口失败：', error.message); process.exitCode = 1; });
  await fake?.close();
  if (failed) fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed: false, failure: failed.message, ...report }, null, 2));
}
