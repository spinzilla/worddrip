// 内置词表真实窗口检查：Tauri command、词形查找和 390×844 设置页许可证。
import assert from 'node:assert/strict';
import path from 'node:path';
import { connect } from './cdp.mjs';
import { start, stop } from './launch.mjs';

let session;
let page;
let failure;
try {
  session = await start({ port: 9358, runId: '080-wordpack' });
  page = await connect({ port: session.port });
  await page.waitReady('nav button');
  await page.setViewport(390, 844, { mobile: true, dpr: 2 });

  const check = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__?.invoke?.bind(window.__TAURI_INTERNALS__);
    if (!invoke) throw new Error('当前页面没有 Tauri invoke 接口');
    const call = (name, args) => invoke(name, args).catch(error => { throw new Error(`${name} 调用失败：${String(error)}`); });
    const info = await call('wordpack_info');
    const abandon = await call('wordpack_lookup', { word: 'abandon' });
    const form = await call('wordpack_lookup', { word: 'running' });
    const randomFive = entries => {
      if (entries.length < 5) throw new Error('标签词数不足 5 个');
      const pool = [...entries];
      for (let i = 0; i < 5; i++) {
        const j = i + Math.floor(Math.random() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      return pool.slice(0, 5);
    };
    const ngsl = randomFive(await call('wordpack_list', { tags: ['ngsl'] }));
    const nawl = randomFive(await call('wordpack_list', { tags: ['nawl'] }));
    const first = await call('wordpack_band', { rankFrom: 1, rankTo: 500, n: 10, seed: 42 });
    const second = await call('wordpack_band', { rankFrom: 1, rankTo: 500, n: 10, seed: 42 });
    return { info, abandon, form, ngsl, nawl, first, second };
  });
  assert.equal(check.info.wordCount, 15124);
  assert.ok(check.abandon.phonetic && check.abandon.zh && check.abandon.tags.includes('cet4'));
  assert.equal(check.form.word, 'run');
  assert.equal(check.ngsl.length, 5);
  assert.ok(check.ngsl.every(entry => entry.tags.includes('ngsl')));
  assert.equal(check.nawl.length, 5);
  assert.ok(check.nawl.every(entry => entry.tags.includes('nawl')));
  assert.deepEqual(check.first.map(entry => entry.word), check.second.map(entry => entry.word));
  console.log(`PASS Tauri 词表接口：${check.info.wordCount} 词；abandon / running→run / NGSL / NAWL / 固定种子`);

  await page.send('Network.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36',
  });
  await page.reload();
  await page.waitReady('nav button');
  await page.click('nav button:last-child');
  await page.waitFor('[data-testid=wordpack-license-toggle]');
  await page.click('[data-testid=wordpack-license-toggle]');
  await page.waitText('Copyright (c) 2025 Linwei');
  const widths = await page.evaluate(() => {
    const main = document.querySelector('main');
    return { viewport: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth,
      main: main && { scrollWidth: main.scrollWidth, clientWidth: main.clientWidth } };
  });
  assert.ok(widths.main && widths.main.scrollWidth <= widths.main.clientWidth,
    `390px 设置页 main 滚动容器横向溢出：${JSON.stringify(widths)}`);
  assert.ok(widths.html <= 390 && widths.body <= 390, `390px 设置页横向溢出：${JSON.stringify(widths)}`);
  await page.screenshot(path.join(session.out, 'wordpack-settings-390.png'));
  console.log(`PASS 390×844 设置页许可证展开，无横向溢出；截图：${path.join(session.out, 'wordpack-settings-390.png')}`);
  const unexpected = page.errors.filter(error => !error.includes('plugin http not found'));
  if (unexpected.length) throw new Error(`页面出现异常：${unexpected.slice(0, 3).join(' | ')}`);
} catch (error) {
  failure = error;
  console.error(`FAIL ${error.message}`);
} finally {
  page?.close();
  if (session) await stop(session.runDir);
}
process.exit(failure ? 1 : 0);
