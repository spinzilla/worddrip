// 软件名真实窗口验收脚本（017 写，046 改成「词滴 WordDrip」）：隔离启动 Windows Tauri 开发窗口，核对
//   0. 先在隔离数据目录里放好词库和一项设置，关掉窗口；再用同一个数据目录重新启动（模拟「改名后打开老数据」）；
//      重启后词库条数不变、设置还在、数据库仍在 com.englishstudio.app 目录下；
//   1. document.title 和窗口标题都是「词滴 WordDrip」；
//   2. 顶栏左上角文字是「词滴 WordDrip」，顶栏里没有 LinguaClip，也没有旧名 English Studio；
//   3. 页面上找不到原版的更新按钮 / 更新对话框（等 8 秒，覆盖原来 5 秒后自动检查的行为）；
//   4. 设置页底部没有「检查更新」入口，有「基于开源项目 LinguaClip（AGPL-3.0）」署名；
//   5. 1280 和 390 宽各截主页、设置页底部，窄屏不横向溢出。
// 用法（在 app 目录）：node dev/fixtures/brand/e2e.mjs
// 证据：D:\tmp\es-e2e\046-<时间>\out\（可用 ES_E2E_ROOT 换根目录），退出码 0 = 通过。
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { start, stop, ownProcesses } from '../../e2e/launch.mjs';
import { connect } from '../../e2e/cdp.mjs';
import { openDb, countRows } from '../../e2e/db.mjs';

const NAME = '词滴 WordDrip';
const OLD_NAMES = ['LinguaClip', 'English Studio'];
const root = process.env.ES_E2E_ROOT || 'D:\\tmp\\es-e2e';
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.join(root, `046-${stamp}`);
const out = path.join(runDir, 'out');

const log = [];
const note = (k, v) => { const line = `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`; log.push(line); console.log(line); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const invoke = async (page, command, args = {}) => {
  const r = await page.evaluate(async (cmd, payload) => {
    try { return { value: await window.__TAURI_INTERNALS__.invoke(cmd, payload) }; }
    catch (error) { return { error: typeof error === 'string' ? error : String(error) }; }
  }, command, args);
  if (r.error) throw new Error(`${command} 失败：${r.error}`);
  return r.value;
};

// 预先放进去的数据：3 个复习词 + 1 条升级词；一项真实设置（音频前后留白，键名沿用原版的 linguaclip_audio_padding）。
const reviewWords = ['exacerbate', 'mitigate', 'allocate'].map((word, i) => ({
  id: `${word}@10.20`, word, status: 'L2', level: 2, note: '', line: i + 2, raw: `| ${word} | 10.20 |`, issue: '10.20', addedAt: '2026-10-20', due: '2026-12-01',
}));
const importRequest = {
  upgrade: { fileName: 'upgrade-046.md', content: '# 学术升级库\n' },
  review: { fileName: 'review-046.md', content: '# 词汇总词库\n' },
  entries: [{ id: 'show@1.1', line: 2, raw: '| show | demonstrate |', plain: 'show', upgrade: 'demonstrate', source: '测试', note: '' }],
  examples: [], selfChecks: [], reviewWords, warnings: { upgrade: [], review: [] },
};
const SETTING_KEY = 'linguaclip_audio_padding';
const SETTING_VALUE = JSON.stringify({ startPadding: 321, endPadding: 654 });

// 只截顶栏那一条：先量 header 的位置，再让 CDP 按这个矩形截图。
async function shotTopBar(page, file) {
  const rect = await page.evaluate(() => {
    const h = document.querySelector('header');
    if (!h) throw new Error('找不到顶栏 header');
    const r = h.getBoundingClientRect();
    return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: r.width, height: r.height };
  });
  const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { ...rect, scale: 1 } });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(`[e2e] 截图 ${file}`);
  return file;
}

// 系统层的窗口标题：先问 Tauri（隐藏窗口也拿得到），再退回看进程的 MainWindowTitle。
async function windowTitle(page, s) {
  try {
    const t = await invoke(page, 'plugin:window|title', { label: 'main' });
    if (typeof t === 'string') return { from: 'Tauri', titles: [t] };
  } catch (e) {
    note('Tauri 取窗口标题失败，改看进程', e.message);
  }
  const pids = ownProcesses(s.runDir).map(p => p.pid);
  if (!pids.length) return { from: '进程', titles: [] };
  const cmd = `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.MainWindowTitle)" }`;
  try {
    const titles = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      .map(l => l.split('|').slice(1).join('|')).filter(Boolean);
    return { from: '进程', titles };
  } catch {
    return { from: '进程', titles: [] };
  }
}

// 原版更新在页面上可能出现的样子：顶栏红色小胶囊（Update 0.10.0 / 有新版本 0.10.0）
// 和设置页的「Version x · Check for updates」，以及更新对话框。
const updateUI = page => page.evaluate(() => {
  const pill = /^(Update\s+\S+|有新版本\s+\S+|Downloading\s+\d+%|正在下载\s+\d+%|Restart to update|重启以更新)$/;
  const pills = [];
  document.querySelectorAll('button').forEach(b => {
    const t = (b.innerText || '').trim();
    if (pill.test(t)) pills.push(t);
  });
  const dialogs = [...document.querySelectorAll('[role=dialog]')]
    .map(d => d.innerText || '')
    .filter(t => /可以更新了|is available/.test(t));
  const body = document.body.innerText;
  const rows = /检查更新|Check for updates|当前版本 \d|Version \d+\.\d+\.\d+/.test(body);
  return { pills, dialogs, rows };
});

const headerInfo = (page, name, oldNames) => page.evaluate((name, oldNames) => {
  const h = document.querySelector('header');
  if (!h) throw new Error('找不到顶栏 header');
  const leaf = [...h.querySelectorAll('*')].filter(e => e.children.length === 0).map(e => (e.textContent || '').trim());
  const wordmark = [...h.querySelectorAll('*')].find(e => e.children.length === 0 && (e.textContent || '').trim() === name);
  const r = wordmark?.getBoundingClientRect();
  return {
    text: h.innerText,
    hasWordmark: leaf.includes(name),
    // 名字完整显示：没被截断、没跑出窗口
    wordmarkFits: !!wordmark && wordmark.scrollWidth <= wordmark.clientWidth + 1 && r.right <= document.documentElement.clientWidth + 1,
    oldNames: oldNames.filter(n => h.innerText.includes(n)),
  };
}, name, oldNames);

const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const scrollMainToBottom = page => page.evaluate(() => { const m = document.querySelector('main'); if (m) m.scrollTop = m.scrollHeight; });

let s;
let page;
let ok = false;
const evidence = { runDir, checks: {} };
try {
  // ---- 0a. 先放好数据，然后关掉 ----
  s = await start({ runDir, port: 9453 });
  page = await connect({ port: s.port });
  await page.waitReady();
  const added = await invoke(page, 'vocab_import', { request: importRequest });
  assert.equal(added.reviewWords.added, reviewWords.length, '预置复习词条数不对');
  await page.evaluate((k, v) => localStorage.setItem(k, v), SETTING_KEY, SETTING_VALUE);
  const before = await invoke(page, 'vocab_stats');
  note('预置后词库统计', before);
  evidence.checks.before = before;
  await sleep(5000); // 让 WebView 把 localStorage 落盘再关
  page.close?.();
  await stop(s.runDir);

  // ---- 0b. 用同一个数据目录重新启动 ----
  s = await start({ runDir, port: 9453 }); // runDir 已存在 => 沿用里面的数据
  page = await connect({ port: s.port });
  await page.waitReady();
  await page.setViewport(1280, 800, { mobile: false, dpr: 1 });
  await sleep(1000); // 让顶栏和导航渲染完

  assert.ok(s.appData.endsWith('com.englishstudio.app'), `数据目录名变了：${s.appData}`);
  const dbFile = path.join(s.appData, 'vocab.db');
  assert.ok(fs.existsSync(dbFile), `重启后数据库不在原位置：${dbFile}`);
  const after = await invoke(page, 'vocab_stats');
  note('重启后词库统计', after);
  assert.deepEqual(after, before, '重启后词库统计和预置时不一样');
  const db = await openDb(s);
  const reviewRows = countRows(db, 'review_word');
  db.close();
  assert.equal(reviewRows, reviewWords.length, '数据库里的复习词条数不对');
  const setting = await page.evaluate(k => localStorage.getItem(k), SETTING_KEY);
  assert.equal(setting, SETTING_VALUE, `重启后设置 ${SETTING_KEY} 不在了`);
  note('老数据', `数据库 ${dbFile}；复习词 ${reviewRows} 条（预置 ${reviewWords.length}）；设置 ${SETTING_KEY} = ${setting}`);
  evidence.checks.after = { after, reviewRows, setting, dbFile };

  // ---- 1. 标题 ----
  const title = await page.evaluate(() => document.title);
  note('document.title', title);
  assert.equal(title, NAME, `document.title 应为 ${NAME}`);
  const win = await windowTitle(page, s);
  note(`窗口标题（${win.from}）`, win.titles.length ? win.titles.join(' / ') : '（没取到，跳过）');
  if (win.titles.length) assert.ok(win.titles.includes(NAME), `窗口标题应为 ${NAME}：${win.titles.join(' / ')}`);
  evidence.checks.titles = { title, window: win };

  // ---- 2. 顶栏 ----
  let head = await headerInfo(page, NAME, OLD_NAMES);
  note('顶栏文字（1280）', head.text.replace(/\n/g, ' | '));
  assert.equal(head.hasWordmark, true, `顶栏左上角应有 ${NAME}`);
  assert.equal(head.wordmarkFits, true, '顶栏名字显示不全');
  assert.deepEqual(head.oldNames, [], `顶栏不应再出现旧名：${head.oldNames.join(' / ')}`);
  await shotTopBar(page, path.join(out, '01-topbar-1280.png'));
  await page.screenshot(path.join(out, '02-home-1280.png'), { full: false });

  // ---- 3. 等过原来启动 5 秒后的自动检查点，确认没有任何更新 UI ----
  await sleep(8000);
  let u = await updateUI(page);
  assert.deepEqual(u.pills, [], `顶栏出现更新按钮：${u.pills.join(' / ')}`);
  assert.deepEqual(u.dialogs, [], '出现了更新对话框');
  assert.equal(u.rows, false, '页面上出现了「检查更新 / 当前版本」字样');
  note('更新入口（主页，等待 8 秒后）', '无更新按钮、无对话框、无检查更新字样');

  // ---- 4. 设置页 ----
  await page.clickText(['设置', 'Settings']);
  await page.waitUntil('进入设置页', `/(卡片与复习|Cards & review)/.test(document.body.innerText)`);
  await sleep(500);
  u = await updateUI(page);
  assert.deepEqual(u.pills, [], `设置页出现更新按钮：${u.pills.join(' / ')}`);
  assert.equal(u.rows, false, '设置页出现了「检查更新 / 当前版本」字样');
  await page.screenshot(path.join(out, '03-settings-1280.png'), { full: false });
  await scrollMainToBottom(page);
  await sleep(400);
  const bottom = await page.text('main');
  assert.match(bottom, /数据备份|Data backup/, '没有滚到设置页底部（看不到数据备份）');
  assert.doesNotMatch(bottom, /检查更新|Check for updates|当前版本 \d|Version \d+\.\d+\.\d+/, '设置页底部出现了更新入口');
  // 隔离环境的界面语言跟系统走（本机是英文），中英两种都核对：先看当前语言，再切到另一种。
  const BASED_ON = {
    en: 'WordDrip is based on the open-source project LinguaClip (AGPL-3.0)',
    zh: '词滴基于开源项目 LinguaClip（AGPL-3.0）开发',
  };
  const lang = await page.evaluate(() => document.documentElement.lang || '');
  const first = (await page.text('[data-testid=based-on]')).trim();
  note('许可证署名（当前语言）', first);
  assert.ok(Object.values(BASED_ON).includes(first), `设置页底部缺少 LinguaClip（AGPL-3.0）署名：${first}`);
  await page.screenshot(path.join(out, '04-settings-bottom-1280.png'), { full: false });
  const firstLang = first === BASED_ON.en ? 'en' : 'zh';
  const otherLang = firstLang === 'en' ? 'zh' : 'en';
  await page.clickText(otherLang === 'zh' ? '中文' : 'English');
  await page.waitUntil(`切到${otherLang}`, `(document.querySelector('[data-testid=based-on]')?.innerText || '').trim() === ${JSON.stringify(BASED_ON[otherLang])}`);
  await scrollMainToBottom(page);
  await sleep(400);
  note('许可证署名（切换后）', (await page.text('[data-testid=based-on]')).trim());
  await page.screenshot(path.join(out, `04b-settings-bottom-1280-${otherLang}.png`), { full: false });
  head = await headerInfo(page, NAME, OLD_NAMES);
  assert.equal(head.hasWordmark, true, `切换语言后顶栏应仍是 ${NAME}`);
  // 后面 390 宽截图用中文界面
  if (otherLang !== 'zh') {
    await page.clickText('中文');
    await page.waitUntil('切回中文', `(document.querySelector('[data-testid=based-on]')?.innerText || '').trim() === ${JSON.stringify(BASED_ON.zh)}`);
  }
  note('设置页', `底部无「检查更新」，中英文署名都在（html lang=${lang}）；截图 03、04、04b`);

  // ---- 5. 390 窄屏 ----
  await page.setViewport(390, 844, { mobile: true, dpr: 2 });
  await sleep(600);
  await scrollMainToBottom(page);
  await sleep(400);
  assert.equal(await noOverflow(page), true, '390 宽设置页横向溢出');
  await page.screenshot(path.join(out, '05-settings-bottom-390.png'), { full: false });
  await page.clickText(['词库', 'Vocab']);
  await sleep(1200);
  head = await headerInfo(page, NAME, OLD_NAMES);
  note('顶栏文字（390）', head.text.replace(/\n/g, ' | '));
  assert.equal(head.hasWordmark, true, `390 宽顶栏应有 ${NAME}`);
  assert.equal(head.wordmarkFits, true, '390 宽顶栏名字显示不全');
  assert.deepEqual(head.oldNames, [], `390 宽顶栏出现旧名：${head.oldNames.join(' / ')}`);
  assert.equal(await noOverflow(page), true, '390 宽词库页横向溢出');
  await shotTopBar(page, path.join(out, '06-topbar-390.png'));
  await page.screenshot(path.join(out, '07-vocab-390.png'), { full: false });
  await page.setViewport(1280, 800, { mobile: false, dpr: 1 });
  await sleep(800);
  await page.screenshot(path.join(out, '08-vocab-1280.png'), { full: false });

  // 只有更新相关的报错才算失败；隔离测试里 http 插件本来就没注册，其他报错与本次无关。
  const updateErrors = page.errors.filter(e => /update|linguaclipapp/i.test(String(e)));
  assert.deepEqual(updateErrors, [], `页面出现更新相关报错：${updateErrors.join(' | ')}`);
  note('页面错误', JSON.stringify(page.errors));
  ok = true;
} catch (e) {
  note('失败', e.stack || e);
  fs.mkdirSync(out, { recursive: true });
  if (page) await page.screenshot(path.join(out, '99-failure.png')).catch(() => {});
  if (page) note('失败时页面文字', (await page.text('body').catch(() => '')).slice(0, 400).split('\n').join(' | '));
} finally {
  fs.mkdirSync(out, { recursive: true });
  evidence.ok = ok;
  fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
  fs.writeFileSync(path.join(out, 'e2e-046-log.txt'), log.join('\n'), 'utf8');
  if (s?.runDir) await stop(s.runDir).catch(e => note('停止失败', e.stack || e));
  note('证据目录', out);
}
process.exit(ok ? 0 : 1);
