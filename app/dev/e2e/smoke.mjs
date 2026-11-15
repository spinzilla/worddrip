// 真实窗口冒烟：隔离启动 → 主页 → 文件对话框（先取消、再选文件）→ 窄屏 → 重启 → 停止。
//   在 app 目录：node dev/e2e/smoke.mjs        （说明见 docs/e2e.md）
// 截图和记录都在运行目录的 out 里（D:\tmp\es-e2e\<运行编号>\out）。退出码 0 = 全部通过。
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './cdp.mjs';
import { cancelDialog, chooseFile } from './dialog.mjs';
import { APP_DIR, restart, start, stop } from './launch.mjs';

const VIDEO = path.join(APP_DIR, 'src-tauri', 'tests', 'fixtures', 'tone.mp4');
const SUBTITLE = path.join(APP_DIR, 'TEST_SUBTITLES.srt');
const steps = [];
const ok = (name, detail = '') => {
  steps.push({ name, ok: true, detail });
  console.log(`PASS ${name} ${detail}`);
};

let s;
let page;
let failure;
try {
  for (const f of [VIDEO, SUBTITLE]) if (!fs.existsSync(f)) throw new Error(`缺测试文件：${f}`);
  s = await start();
  ok('隔离启动', s.runDir);
  page = await connect({ port: s.port, skipOnboarding: false });
  await page.waitReady('button');
  await page.waitFor('[data-testid=onboarding]');
  ok('隔离空库启动时引导出现');
  await page.click('[data-testid=onboarding-close]');
  await page.screenshot(path.join(s.out, '01-home.png'));
  ok('主页截图');

  // 「添加视频」弹窗里的「选择本机视频」会弹系统文件对话框。
  // 全新数据目录默认是英文界面，所以文字写「中文或英文」两种说法。
  const PICK_VIDEO = ['选择本机视频', 'Choose a video on this Mac'];
  const PICK_SUB = ['选字幕文件', 'Choose subtitles'];
  await page.clickText(['视频', 'Videos']); // 顶栏标签
  await page.clickText(['添加视频', 'Add video']);
  await page.waitText(PICK_VIDEO);
  await page.clickText(PICK_VIDEO);
  await cancelDialog(s);
  await page.waitText(PICK_VIDEO); // 取消后还停在弹窗里
  await page.screenshot(path.join(s.out, '02-after-cancel.png'));
  ok('对话框点取消');

  await page.clickText(PICK_VIDEO);
  await chooseFile(s, VIDEO);
  await page.waitText('tone.mp4');
  await page.screenshot(path.join(s.out, '03-after-pick.png'));
  ok('对话框选文件', 'tone.mp4');

  // 有「选字幕文件」就再选一次字幕（没有也不算失败，界面可能随版本变）。
  try {
    await page.clickText(PICK_SUB, { timeout: 5000 });
    await chooseFile(s, SUBTITLE);
    await page.waitText('TEST_SUBTITLES.srt');
    await page.screenshot(path.join(s.out, '04-after-subtitle.png'));
    ok('对话框选字幕', 'TEST_SUBTITLES.srt');
  } catch (e) {
    console.log('提示：字幕那一步没走通（不影响通过）：' + e.message);
  }

  await page.setViewport(390, 844);
  await page.screenshot(path.join(s.out, '05-narrow.png'));
  await page.setViewport();
  ok('窄屏 390×844 截图');
  page.close();

  s = await restart(s.runDir);
  page = await connect({ port: s.port });
  await page.waitReady('button');
  await page.screenshot(path.join(s.out, '06-after-restart.png'));
  ok('重启后截图（同一数据目录）');
  if (page.errors.length) console.log('页面里出现过的报错：', page.errors.slice(0, 5));
} catch (e) {
  failure = e;
  console.error('FAIL ' + e.message);
  if (page && s) await page.screenshot(path.join(s.out, '99-failure.png')).catch(() => {});
} finally {
  try {
    page?.close();
    if (s) await stop(s.runDir);
  } catch (e) {
    console.error('停止时出错：' + e.message);
    failure ||= e;
  }
  if (s) fs.writeFileSync(path.join(s.out, 'smoke-result.json'), JSON.stringify({ steps, failure: failure?.message ?? null }, null, 2));
}
console.log(failure ? '冒烟失败' : `冒烟通过，输出在 ${s.out}`);
process.exit(failure ? 1 : 0);
