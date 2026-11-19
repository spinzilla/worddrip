// 094 真实窗口：启动 2 秒左右自动检查；关闭后重启不查；回前台按 1 小时间隔检查。
// 前置：node app/dev/release.mjs build --allow-dirty 打出更高版本（默认 0.11.99）到 D:\tmp\es-release\<版本>。
//   node dev/e2e/update-094.mjs 0.11.99
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './cdp.mjs';
import { start, stop, restart } from './launch.mjs';
import { serveRelease } from '../update-server.mjs';

const version = process.argv[2] || '0.11.99';
const srv = await serveRelease({ version });
const runDir = path.join('D:/tmp/es-e2e', `update-094-${Date.now()}`);
fs.mkdirSync(runDir, { recursive: true });
const extra = path.join(runDir, 'tauri-update-test.json');
fs.writeFileSync(extra, JSON.stringify({ plugins: { updater: { endpoints: [`${srv.base}/latest.json`], dangerousInsecureTransportProtocol: true } } }));
process.env.ES_E2E_EXTRA_CONFIG = extra;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const manifestHits = () => srv.state.hits.filter(x => x.startsWith('/latest.json')).length;
const waitHits = async (want, timeout = 10000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (manifestHits() >= want) return;
    await sleep(100);
  }
  throw new Error(`等待清单请求超时：想要 ${want} 次，实际 ${manifestHits()} 次`);
};
const hideThenShow = `(() => {
  window.__wd094Visibility = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  window.__wd094Visibility = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
})()`;
const installVisibilityStub = `(() => {
  window.__wd094Visibility = document.visibilityState;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__wd094Visibility });
})()`;
const ok = m => console.log('PASS', m);
let s; let page; let failed;
try {
  s = await start({ runDir });
  page = await connect({ port: s.port });
  await page.waitReady('button');
  // 首次连接时页面已经启动，直接读 performance.now() 会把连接耗时算进去。
  // 注入观察器后刷新，记录提示条实际插入 DOM 时的页面运行时间。
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__wd094BannerAt = null;
    document.addEventListener('DOMContentLoaded', () => {
      const mark = () => {
        if (window.__wd094BannerAt === null && document.querySelector('[data-testid=update-banner]')) window.__wd094BannerAt = performance.now();
      };
      mark();
      new MutationObserver(mark).observe(document, { subtree: true, childList: true });
    });
  ` });
  await page.reload();
  await page.waitReady('button');
  await page.waitUntil('启动后自动出现更新提示条', `window.__wd094BannerAt !== null`, { timeout: 5000 });
  const elapsed = await page.evaluate('window.__wd094BannerAt');
  if (elapsed > 5000) throw new Error(`提示条出现时页面已运行 ${Math.round(elapsed)}ms，超过 5 秒`);
  if (manifestHits() < 1) throw new Error('出现了提示条，但假服务器没收到清单请求');
  const shot = await page.screenshot(path.join(s.out, 'startup-banner.png'));
  ok(`启动后 ${Math.round(elapsed)}ms 内自动出现提示条（未点检查按钮）；截图 ${shot}`);

  // 通过真实设置开关关闭自动检查，保留同一数据目录重启。
  await page.clickText(['设置', 'Settings']);
  await page.waitFor('[data-testid=update-auto]');
  await page.click('[data-testid=update-auto]');
  if (await page.evaluate(`localStorage.getItem('worddrip.update.auto')`) !== '0') throw new Error('自动检查开关没有存成关闭');
  srv.state.hits.length = 0;
  page.close();
  s = await restart(s.runDir);
  page = await connect({ port: s.port });
  await page.waitReady('button');
  await page.evaluate(installVisibilityStub);
  await page.evaluate(`localStorage.setItem('worddrip.update.lastCheck', String(Date.now() - 2 * 60 * 60 * 1000))`);
  await page.evaluate(hideThenShow);
  await sleep(10000);
  if (manifestHits() !== 0) throw new Error(`关闭自动检查后重启 10 秒内仍请求了 ${manifestHits()} 次清单`);
  ok('关闭自动检查后重启：10 秒内及回前台都没有清单请求');

  // 回到前台：距上次检查 2 小时要查；404 也属于已发起请求，自动失败保持安静。
  srv.state.missing = true;
  await page.evaluate(`(() => {
    localStorage.setItem('worddrip.update.auto', '1');
    localStorage.setItem('worddrip.update.lastCheck', String(Date.now() - 2 * 60 * 60 * 1000));
  })()`);
  await page.evaluate(hideThenShow);
  await waitHits(1);
  // 等 404 完整走完失败分支，避免第二次事件只是被 checking 状态去重。
  await sleep(1500);
  await page.waitUntil('404 自动检查失败并记录检查尝试', `Number(localStorage.getItem('worddrip.update.lastCheck')) > Date.now() - 60 * 1000`);
  ok('距上次检查 2 小时：隐藏再可见后发了 1 次清单请求，404 失败也记录了检查时间');

  // 上次请求已经 404 失败，立即再次回前台也不能绕过 1 小时节流。
  await page.evaluate(hideThenShow);
  await sleep(1500);
  if (manifestHits() !== 1) throw new Error(`自动检查失败后立即回前台不该重复请求，实际清单请求总数 ${manifestHits()}`);
  ok('自动检查 404 失败后立即再次回前台：没有重复请求');

  await page.evaluate(`localStorage.setItem('worddrip.update.lastCheck', String(Date.now() - 10 * 60 * 1000))`);
  await page.evaluate(hideThenShow);
  await sleep(1500);
  if (manifestHits() !== 1) throw new Error(`距上次检查 10 分钟不该再查，实际清单请求总数 ${manifestHits()}`);
  ok('距上次检查 10 分钟：隐藏再可见后没有新增清单请求');
  if (page.errors.length) console.log('页面报错', page.errors);
} catch (e) {
  failed = e;
  console.error('FAIL', e && e.stack || e);
} finally {
  if (page) page.close();
  if (s) await stop(s.runDir).catch(() => {});
  srv.close();
}
process.exit(failed ? 1 : 0);