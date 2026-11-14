// 073 真实窗口：设置 → AI 的 DeepSeek 教程链接、「按 DeepSeek 填好」、默认随机度 1。电脑 1280×900 和手机 390×844 各一张截图。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { start, stop } from './launch.mjs';
import { connect } from './cdp.mjs';

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.resolve('src-tauri/target/e2e', `073ai-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });
let session; let page; let passed = false;
try {
  session = await start({ runDir, port: 9474 });
  page = await connect({ port: session.port });
  await page.waitReady();
  const run = async (label, w, h, mobile) => {
    await page.setViewport(w, h, { mobile, dpr: mobile ? 2 : 1 });
    await page.evaluate(() => localStorage.setItem('linguaclip_ai_config', JSON.stringify({ apiKey: 'dummy-keep', model: 'keep-model', baseUrl: 'https://old.example/v1' })));
    await page.reload(); await page.waitReady();
    await page.clickText('设置', { selector: 'header nav button', exact: false });
    await page.clickText('AI', { selector: 'button, [role=tab]', exact: true });
    await page.waitFor('[data-testid=settings-ai-nokey]');
    assert.match(await page.text('[data-testid=settings-ai-nokey]'), /没有 API Key？.*DeepSeek 官方入门教程.*去 DeepSeek 创建 API Key/s);
    const order = await page.evaluate(() => {
      const key = document.querySelector('input[type=password]').getBoundingClientRect().bottom;
      return document.querySelector('[data-testid=settings-ai-nokey]').getBoundingClientRect().top >= key;
    });
    assert.equal(order, true, '链接在 Key 输入框下面');
    await page.screenshot(path.join(out, `${label}-ai-before.png`));
    await page.click('[data-testid=deepseek-fill]');
    await page.waitFor('[data-testid=deepseek-filled-tip]');
    const cfg = await page.evaluate(() => JSON.parse(localStorage.getItem('linguaclip_ai_config')));
    assert.equal(cfg.baseUrl, 'https://api.deepseek.com');
    assert.equal(cfg.apiKey, 'dummy-keep'); assert.equal(cfg.model, 'keep-model');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.screenshot(path.join(out, `${label}-ai-after.png`));
    return cfg.temperature;
  };
  await run('desktop', 1280, 900, false);
  await page.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', platform: 'Linux armv8l' });
  await run('mobile', 390, 844, true);
  console.log('通过，截图：' + out);
  passed = true;
} catch (e) {
  if (page) await page.screenshot(path.join(out, 'failure.png')).catch(() => {});
  console.error(e); process.exitCode = 1;
} finally {
  if (session) await stop(session.runDir);
  console.log(passed ? '已关闭' : '失败后已关闭');
}
