// 077 电脑真实链路：隔离启动 0.9.2 的真实窗口，把更新清单指到本机，走「提示条 → 现在更新 → 下载校验」。
// 前置：node app/dev/release.mjs build --allow-dirty 打出一个更高版本（例如 0.9.99）到 D:\tmp\es-release\<版本>。
//   node dev/e2e/update-077.mjs 0.9.99
// 到「调用安装」为止：本机 localStorage 的 worddrip.update.dryRun=1 让它下载并校验完就停（不安装、不重启）。
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './cdp.mjs';
import { start, stop } from './launch.mjs';
import { serveRelease } from '../update-server.mjs';

const version = process.argv[2] || '0.9.99';
const cur = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const srv = await serveRelease({ version });
const runDir = path.join('D:/tmp/es-e2e', `update-${Date.now()}`);
fs.mkdirSync(runDir, { recursive: true });
const extra = path.join(runDir, 'tauri-update-test.json');
fs.writeFileSync(extra, JSON.stringify({ plugins: { updater: { endpoints: [`${srv.base}/latest.json`], dangerousInsecureTransportProtocol: true } } }));
process.env.ES_E2E_EXTRA_CONFIG = extra;
let s; let failed;
const ok = m => console.log('PASS', m);
try {
  s = await start({ runDir });
  const page = await connect({ port: s.port });
  await page.waitReady('button');
  const out = f => path.join(s.out, f);
  await page.evaluate(`localStorage.setItem('worddrip.update.dryRun','1')`);
  await page.clickText(['设置', 'Settings']);
  await page.waitText(['当前版本 ' + cur, 'Version ' + cur]);
  await page.screenshot(out('about-desktop.png'));
  ok('设置 → 关于 显示 ' + cur);
  await page.clickText(['检查更新', 'Check for updates']);
  await page.waitUntil('出现更新提示条', `!!document.querySelector('[data-testid=update-banner]')`);
  await page.screenshot(out('banner-desktop.png'));
  ok(`提示条出现：${(await page.text('[data-testid=update-banner]')).replace(/\s+/g, ' ')}`);
  await page.clickText(['现在更新', 'Update now']);
  await page.waitUntil('下载完成', `!!document.querySelector('[data-testid=update-ready]') || !!document.querySelector('[data-testid=update-error]')`, { timeout: 120000 });
  await page.screenshot(out('ready-desktop.png'));
  const t1 = await page.text('[data-testid=update-banner]');
  if (!t1.includes('已下载并校验通过') && !t1.includes('Downloaded and verified')) throw new Error('第一次没走到校验通过：' + t1);
  ok('下载到 100%、签名校验通过，停在安装前（测试替身）');

  // 第二次：改一个字节，应该「校验失败」且不安装。
  srv.state.tamper = true;
  await page.reload();
  await page.waitReady('button');
  await page.evaluate(`localStorage.setItem('worddrip.update.dryRun','1')`);
  await page.clickText(['设置', 'Settings']);
  await page.clickText(['检查更新', 'Check for updates']);
  await page.waitUntil('出现更新提示条', `!!document.querySelector('[data-testid=update-banner]')`);
  await page.clickText(['现在更新', 'Update now']);
  await page.waitUntil('出现错误', `!!document.querySelector('[data-testid=update-error]') || !!document.querySelector('[data-testid=update-ready]')`, { timeout: 120000 });
  await page.screenshot(out('tampered-desktop.png'));
  const t2 = await page.text('[data-testid=update-banner]');
  if (t2.includes('已下载并校验通过') || t2.includes('Downloaded and verified')) throw new Error('被改过的包居然通过了：' + t2);
  if (!t2.includes('校验失败') && !t2.includes('Verification failed')) throw new Error('没有显示校验失败：' + t2);
  ok(`改一个字节后：${t2.replace(/\s+/g, ' ')}`);

  // 稍后：点后再查，不再弹条
  srv.state.tamper = false;
  await page.reload();
  await page.waitReady('button');
  await page.clickText(['设置', 'Settings']);
  await page.clickText(['检查更新', 'Check for updates']);
  await page.waitUntil('出现更新提示条', `!!document.querySelector('[data-testid=update-banner]')`);
  await page.clickText(['稍后', 'Later']);
  await page.waitUntil('提示条消失', `!document.querySelector('[data-testid=update-banner]')`);
  ok('点「稍后」提示条消失');

  // 清单 404：手动检查显示失败提示，不弹别的
  srv.state.missing = true;
  await page.reload();
  await page.waitReady('button');
  await page.clickText(['设置', 'Settings']);
  await page.clickText(['检查更新', 'Check for updates']);
  await page.waitText(['检查失败', 'Check failed']);
  if (await page.evaluate(`!!document.querySelector('[data-testid=update-banner]')`)) throw new Error('404 时不该有提示条');
  ok('清单 404：只在设置里显示一句，没有提示条');
  if (page.errors.length) console.log('页面报错', page.errors);
} catch (e) { failed = e; console.error('FAIL', e.message); }
finally { if (s) await stop(s.runDir); srv.close(); }
process.exit(failed ? 1 : 0);
