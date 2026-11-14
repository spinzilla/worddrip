import { connect } from './cdp.mjs';
import { start, stop } from './launch.mjs';

const checks = [];
let session;
let page;
try {
  session = await start({ port: 9352, runId: '052-settings' });
  page = await connect({ port: session.port });
  await page.waitReady('nav button');
  await page.click('nav button:last-child');
  await page.waitFor('[data-testid=based-on]');
  await page.evaluate('document.querySelector("[data-testid=based-on]").scrollIntoView({block:"end"})');

  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.screenshot('D:/tmp/es-e2e/052-settings-1280.png');
  checks.push({ width: 1280, text: await page.evaluate('document.body.innerText') });

  await page.setViewport(390, 844, { mobile: true, dpr: 2 });
  await page.evaluate('document.querySelector("main").scrollTop = document.querySelector("main").scrollHeight');
  await page.screenshot('D:/tmp/es-e2e/052-settings-390.png');
  checks.push({ width: 390, text: await page.evaluate('document.body.innerText') });

  const prohibited = [
    /\u8d5e\u52a9/,
    /\u5ba2\u670d/,
    /\u652f\u6301\u8005/,
    /sponsor/i,
    /supporter/i,
    /support@/i,
    /afdian/i,
    /QQ/,
  ];
  for (const check of checks) {
    if (!check.text.includes('AGPL-3.0') || prohibited.some(pattern => pattern.test(check.text))) {
      throw new Error(`设置页底部检查失败：${check.width}px`);
    }
    console.log(`PASS ${check.width}px：${check.text.slice(-450).replace(/\n/g, ' | ')}`);
  }
} finally {
  page?.close();
  if (session) await stop(session.runDir);
}
