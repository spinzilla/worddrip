// 083 真实窗口：填设置 → 等自动快照 → 清空 localStorage → 重启 → 弹「发现之前的设置」→ 恢复 → 设置回来。
// 另外检查启动记录、诊断信息里没有 API key。用法：node dev/e2e/restore-083.mjs
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './cdp.mjs';
import { start, stop } from './launch.mjs';

const runDir = path.join('D:/tmp/es-e2e', `restore-${Date.now()}`);
fs.mkdirSync(runDir, { recursive: true });
const KEY = 'sk-E2E-SECRET-424242';
const ok = m => console.log('PASS', m);
let s;
try {
  s = await start({ runDir });
  let page = await connect({ port: s.port, skipOnboarding: false });
  await page.waitReady('button');
  const out = f => path.join(s.out, f);
  const inv = (cmd, args = {}) => page.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  await page.evaluate(`(() => {
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({ model: 'e2e-model', apiKey: '${KEY}', baseUrl: 'https://e2e.example' }));
    localStorage.setItem('linguaclip_anki_config', JSON.stringify({ url: 'http://127.0.0.1:8765' }));
    localStorage.setItem('linguaclip_dict_sources', JSON.stringify({ en: 'x' }));
    localStorage.setItem('linguaclip_lang', 'zh');
  })()`);
  await page.waitUntil('快照写出', `window.__TAURI_INTERNALS__.invoke('diag_snapshot_read').then(t => { window.__snap = t; return !!t && t.includes('e2e-model'); })`, { timeout: 15000 });
  ok('改设置后自动留了快照');
  await page.evaluate(`localStorage.clear()`);
  await page.reload();
  await page.waitUntil('出现恢复弹窗', `!!document.querySelector('[data-testid=restore-settings]')`, { timeout: 30000 });
  await page.screenshot(out('restore-prompt.png'));
  ok('清空后重启：弹出「发现之前的设置」');
  // 手机宽度：390 宽、130% 字号下的恢复弹窗
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`document.documentElement.style.fontSize = '130%'`);
  await page.screenshot(out('restore-prompt-narrow.png'));
  if (await page.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth`)) throw new Error('恢复弹窗 390 宽 130% 字号横向溢出');
  ok('恢复弹窗 390 宽 130% 字号无横向溢出');
  await page.evaluate(`document.documentElement.style.fontSize = ''`);
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.evaluate(`document.querySelector('[data-testid=restore-settings-yes]').click()`);
  await page.waitReady('button');
  await page.waitUntil('AI 设置回来', `(() => { try { return JSON.parse(localStorage.getItem('linguaclip_ai_config')).model === 'e2e-model'; } catch { return false; } })()`, { timeout: 30000 });
  ok('点恢复后 AI 设置回来了');
  const tail = await inv('diag_log_tail', { n: 20 });
  if (!tail.length || !tail.every(l => l.includes('设置键='))) throw new Error('启动记录不对：' + JSON.stringify(tail));
  if (tail.join('\n').includes(KEY)) throw new Error('启动记录里有 API key');
  ok(`启动记录 ${tail.length} 行：${tail[tail.length - 1]}`);
  // 手机宽度：390 宽、130% 字号（用 CSS 放大根字号近似）下看引导第一步
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`document.documentElement.style.fontSize = '130%'`);
  await page.screenshot(out('onboarding-narrow.png'));
  await page.evaluate(`document.documentElement.style.fontSize = ''`);
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.evaluate(`document.querySelector('[data-testid=onboarding-close]')?.click()`);
  await page.clickText(['设置', 'Settings']);
  await page.waitUntil('关于里有复制按钮', `!!document.querySelector('[data-testid=diag-copy]')`);
  await page.screenshot(out('about-diag.png'));
  ok('设置 → 关于有「复制诊断信息」');
} catch (e) {
  console.error('FAIL', e.message);
  process.exitCode = 1;
} finally {
  if (s) await stop(runDir).catch(() => {});
}
console.log('输出在', s?.out);
