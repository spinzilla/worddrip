import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const out = join(mkdtempSync(join(tmpdir(), 'worddrip-platform-')), 'platform.mjs');
await build({ entryPoints: ['utils/platform.ts'], bundle: true, format: 'esm', outfile: out });
const moduleUrl = pathToFileURL(out).href;
const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36';
const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';

// IS_MOBILE 是模块加载时算出的常量；换 UA 后用不同 URL 重新加载，测的就是界面导入的那个值。
async function loadPlatform(userAgent, name) {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent }, configurable: true });
  return import(`${moduleUrl}?${name}`);
}
const mobilePlatform = await loadPlatform(android, 'android');
const desktopPlatform = await loadPlatform(windows, 'windows');
assert.equal(mobilePlatform.isMobilePlatform(android), true);
assert.equal(desktopPlatform.isMobilePlatform(windows), false);
assert.equal(desktopPlatform.isMobilePlatform(''), false);
assert.equal(mobilePlatform.IS_MOBILE, true, '安卓 UA 必须让界面实际使用的 IS_MOBILE 为 true');
assert.equal(desktopPlatform.IS_MOBILE, false, 'Windows UA 必须让界面实际使用的 IS_MOBILE 为 false');

const mobile = mobilePlatform.navStates(mobilePlatform.IS_MOBILE, true);
const desktop = desktopPlatform.navStates(desktopPlatform.IS_MOBILE, true);
assert.equal(mobile.length, 2);
assert.equal(desktop.length, 6);
for (const forbidden of ['UPLOAD', 'PODCASTS', 'LIBRARY', 'COACH']) {
  assert.equal(mobile.some(v => String(v) === forbidden), false, `手机导航不应出现 ${forbidden}`);
}
for (const required of ['VOCAB', 'SETTINGS']) {
  assert.equal(mobile.some(v => String(v) === required), true, `手机导航应保留 ${required}`);
}
assert.equal(desktopPlatform.navStates(desktopPlatform.IS_MOBILE, false).length, 5, '电脑无播客包时仍维持原导航');
assert.equal(desktop.some(v => String(v) === 'COACH'), true, '电脑导航仍有教练');
assert.deepEqual(mobilePlatform.settingsTabs(mobilePlatform.IS_MOBILE), ['lookup', 'cards', 'transfer', 'ai'], '手机设置分页有查词/卡片与复习/整库搬家/AI');
assert.deepEqual(desktopPlatform.settingsTabs(desktopPlatform.IS_MOBILE), ['practice', 'lookup', 'cards', 'import', 'transfer', 'ai', 'shortcuts'], '电脑设置分页加入整库搬家，其他入口不变');

// 入口不做另一套布尔函数：直接核对 JSX 使用上面验证过的 IS_MOBILE。
// 这样手机为 true 时这些分支不渲染，电脑为 false 时原分支保留。
const sources = Object.fromEntries(['App.tsx', 'components/Shell.tsx', 'components/Settings.tsx', 'components/SettingsCards.tsx', 'components/SettingsAI.tsx', 'components/vocab/VocabPage.tsx']
  .map(file => [file, readFileSync(file, 'utf8')]));
function gated(file, snippet, label) {
  assert.ok(sources[file].includes(snippet), `${file}：${label} 必须直接使用 IS_MOBILE 门控`);
}
gated('components/Shell.tsx', '!hideAdd && !IS_MOBILE && (', '添加视频按钮');
gated('components/Shell.tsx', '<UpdateBanner />', '更新提示条（手机和电脑都显示，077）');
gated('App.tsx', 'useEffect(() => startAutoCheck(), []);', '自动检查更新（手机电脑都查，077）');
gated('App.tsx', 'useEffect(() => { if (!IS_MOBILE) return startClips(); }, []);', '切片监听');
gated('App.tsx', '{!IS_MOBILE && <QuickNoteHost />}', '全局随手记');
gated('components/Settings.tsx', 'settingsTabs(IS_MOBILE).map(', '设置分页（练习/导入/快捷键）');
gated('components/SettingsAI.tsx', "{!IS_MOBILE && <Group title={t('settings.group.aiSpeed')}>", 'AI 同时请求数');
gated('components/SettingsAI.tsx', "{!IS_MOBILE && <Group title={t('settings.group.aiUsedBy')}>", '哪些功能用 AI');
gated('components/vocab/VocabPage.tsx', '{IS_MOBILE ? (', '词库页手机/电脑两套布局');
gated('components/vocab/VocabPage.tsx', "{!IS_MOBILE && view === 'listening' && <ReviewPage", '听力单词复习');
gated('components/vocab/VocabPage.tsx', "{!IS_MOBILE && <div hidden={view !== 'import'}>", 'Markdown 导入');
gated('components/vocab/VocabPage.tsx', "{!IS_MOBILE && <div hidden={view !== 'export'}>", '导出');
gated('components/Settings.tsx', '{!IS_MOBILE && <SettingsAnki', 'Anki 表单');
gated('components/Settings.tsx', '{!IS_MOBILE && <BackupRow />}', '备份');
gated('components/Settings.tsx', '<AboutSection />', '设置里的关于（手机电脑都有，077）');
gated('components/SettingsCards.tsx', '...(!IS_MOBILE ? [{ value: \'clip\' as const,', '单词发音的视频原声');
gated('components/SettingsCards.tsx', '{!IS_MOBILE && <ClipsRow onSaved={onSaved} />}', '复习卡另存片段');
gated('components/SettingsCards.tsx', '{!IS_MOBILE && <Group title="Anki">{children}</Group>}', 'Anki 分组');
assert.equal(sources['App.tsx'].includes('desktopEntriesVisible'), false);
assert.equal(Object.hasOwn(mobilePlatform, 'desktopEntriesVisible'), false, '无人使用的空断言辅助函数应删除');

console.log('platform tests passed: 安卓/Windows 实际 IS_MOBILE、双方导航，以及 JSX 电脑专用入口门控');
