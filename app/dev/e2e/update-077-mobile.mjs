// 077 手机界面链路（浏览器里用安卓 UA、390×844 模拟）：用本机清单走到「下载完成、sha256 通过」，
// 安装调用由测试替身（window.__wdInstallCalls）记录。再改一个字节验证「校验失败」，并截 设置 → 关于（含 130% 字号）。
//   node dev/e2e/update-077-mobile.mjs 0.11.99
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { serveRelease } from '../update-server.mjs';

const version = process.argv[2] || '0.11.99';
const srv = await serveRelease({ version, port: 8098 });
// lib.mjs 的 open() 在 Windows 上起不了 npm，这里自己起 vite（node 直接跑）和系统 Chrome。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(path.join(os.homedir(), '.cache/linguaclip-e2e/package.json'))('playwright');
const outDir = 'D:/tmp/es-e2e/update-mobile-' + Date.now();
fs.mkdirSync(outDir, { recursive: true });
const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', '3000', '--strictPort'], { cwd: ROOT, stdio: ['ignore', fs.openSync(path.join(outDir, 'vite.log'), 'w'), fs.openSync(path.join(outDir, 'vite.log'), 'a')] });
for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:3000/dev/browserMock.ts')).ok) break; } catch {} await new Promise(r => setTimeout(r, 300)); }
const rawBrowser = await chromium.launch({ channel: 'chrome' });
const t = { url: 'http://127.0.0.1:3000/', out: outDir, errors: [], page: { context: () => ({ browser: () => rawBrowser }), close: async () => {} }, close: async () => { await rawBrowser.close().catch(() => {}); vite.kill(); } };
const UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';
let failed;
const ok = m => console.log('PASS', m);
try {
  const browser = t.page.context().browser();
  await t.page.close();
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 390, height: 844 }, userAgent: UA, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const out = f => path.join(t.out, f);
  const flags = `localStorage.setItem('worddrip_onboarding','done'); localStorage.setItem('worddrip.update.base','${srv.base}'); localStorage.setItem('worddrip.update.dryRun','1');`;
  await page.goto(t.url);
  await page.evaluate(flags);
  await page.reload();
  await page.getByRole('navigation').getByRole('button', { name: /^设置/ }).click();
  await page.getByTestId('about').waitFor();
  await page.screenshot({ path: out('about-mobile.png'), fullPage: true });
  ok('手机 设置 → 关于：' + (await page.getByTestId('about').innerText()).replace(/\s+/g, ' '));

  await page.getByTestId('update-check').click();
  await page.getByTestId('update-banner').waitFor();
  await page.screenshot({ path: out('banner-mobile.png') });
  ok('手机提示条：' + (await page.getByTestId('update-banner').innerText()).replace(/\s+/g, ' '));
  // 测试版清单可能没有更新说明（按钮就不显示），有才点
  if (await page.getByRole('button', { name: '更新内容' }).count()) {
    await page.getByRole('button', { name: '更新内容' }).click();
    await page.getByTestId('update-notes').waitFor();
  }
  await page.screenshot({ path: out('banner-mobile-notes.png') });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (await overflow()) throw new Error('390 宽横向溢出');
  ok('390 宽无横向溢出');

  await page.getByTestId('update-now').click();
  await page.getByTestId('update-ready').waitFor({ timeout: 60000 });
  await page.screenshot({ path: out('ready-mobile.png') });
  const calls = await page.evaluate(() => window.__wdInstallCalls);
  if (!calls || calls.length !== 1) throw new Error('安装替身应被调用 1 次，实际：' + JSON.stringify(calls));
  ok(`下载完成、sha256 通过，安装替身被调用：${calls[0]}`);

  // 130% 字号
  await page.evaluate(() => { document.documentElement.style.fontSize = '130%'; });
  await page.screenshot({ path: out('banner-mobile-130.png') });
  await page.getByTestId('about').scrollIntoViewIfNeeded();
  await page.screenshot({ path: out('about-mobile-130.png'), fullPage: true });
  if (await overflow()) throw new Error('130% 字号横向溢出');
  ok('130% 字号无横向溢出');

  // 改一个字节
  srv.state.tamper = true;
  await page.reload();
  await page.getByRole('navigation').getByRole('button', { name: /^设置/ }).click();
  await page.getByTestId('update-check').click();
  await page.getByTestId('update-banner').waitFor();
  await page.getByTestId('update-now').click();
  await page.getByTestId('update-error').waitFor({ timeout: 60000 });
  await page.screenshot({ path: out('tampered-mobile.png') });
  const txt = await page.getByTestId('update-error').innerText();
  const calls2 = await page.evaluate(() => window.__wdInstallCalls || []);
  if (!txt.includes('校验失败') || calls2.length) throw new Error('改字节后：' + txt + JSON.stringify(calls2));
  ok('改一个字节：' + txt + '（未调安装）');

  // 稍后 24 小时
  srv.state.tamper = false;
  await page.reload();
  await page.getByRole('navigation').getByRole('button', { name: /^设置/ }).click();
  await page.getByTestId('update-check').click();
  await page.getByTestId('update-banner').waitFor();
  await page.getByTestId('update-later').click();
  await page.getByTestId('update-banner').waitFor({ state: 'hidden' });
  ok('点「稍后」提示条消失');

  // 404 安静
  srv.state.missing = true;
  await page.reload();
  await page.getByRole('navigation').getByRole('button', { name: /^设置/ }).click();
  await page.getByTestId('update-check').click();
  await page.getByText('检查失败').waitFor();
  if (await page.getByTestId('update-banner').count()) throw new Error('404 不该有提示条');
  ok('清单 404：' + await page.getByTestId('update-status').innerText());
  if (t.errors.length) console.log('页面报错', t.errors);
} catch (e) { failed = e; console.error('FAIL', e.message); }
finally { await t.close(); srv.close(); }
process.exit(failed ? 1 : 0);
