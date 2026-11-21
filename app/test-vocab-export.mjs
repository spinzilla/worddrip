import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const appDir = dirname(fileURLToPath(import.meta.url));
const runDir = join(appDir, 'src-tauri', 'target', 'vocab-export', `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${process.pid}`);
const bundleDir = join(runDir, 'bundle');
mkdirSync(bundleDir, { recursive: true });
await build({
  entryPoints: ['utils/vocab/import.ts', 'utils/vocab/parse.ts', 'utils/vocab/export.ts'],
  bundle: true,
  format: 'esm',
  outdir: bundleDir,
  outbase: 'utils/vocab',
  absWorkingDir: appDir,
});
const { buildImportPreview } = await import(pathToFileURL(join(bundleDir, 'import.js')).href);
const { parseUpgradeLibrary, parseReviewLibrary } = await import(pathToFileURL(join(bundleDir, 'parse.js')).href);
const { createExportGate, exportAvailability, exportFileName } = await import(pathToFileURL(join(bundleDir, 'export.js')).href);

// 前端空库判断、建议文件名和同步防双击锁。
const emptyStats = { upgradeEntries: 0, upgradeExamples: 0, selfChecks: 0, reviewWords: 0, importRuns: 0 };
assert.equal(exportAvailability('upgrade', emptyStats, false).disabled, true);
assert.equal(exportAvailability('review', emptyStats, false).reason.includes('为空'), true);
assert.equal(exportAvailability('upgrade', emptyStats, true).reason, '正在读取词库统计');
assert.equal(exportAvailability('review', { ...emptyStats, reviewWords: 1 }, false).disabled, false);
assert.equal(exportFileName('upgrade'), '学术升级库-导出.md');
assert.equal(exportFileName('review'), '词汇复习库-导出.md');
const gate = createExportGate();
const first = gate.begin();
assert.notEqual(first, null);
assert.equal(gate.begin(), null);
gate.invalidate();
assert.equal(gate.isCurrent(first), false);
const second = gate.begin();
assert.notEqual(second, null);
gate.finish(first);
assert.equal(gate.begin(), null, '旧操作结束不能解开新操作的锁');
gate.finish(second);
assert.notEqual(gate.begin(), null);

const sha256 = value => createHash('sha256').update(value).digest('hex');
const withoutLine = ({ line, ...item }) => item;
const idRaw = rows => rows.map(({ id, raw }) => ({ id, raw }));
const fileVersion = file => ({ path: file, sha256: sha256(readFileSync(file)) });

function runRoundTrip(label, originalUpgrade, originalReview) {
  const scenarioDir = join(runDir, label);
  const sourceDir = join(scenarioDir, 'source');
  mkdirSync(sourceDir, { recursive: true });
  const upgradeCopy = join(sourceDir, basename(originalUpgrade));
  const reviewCopy = join(sourceDir, basename(originalReview));
  copyFileSync(originalUpgrade, upgradeCopy);
  copyFileSync(originalReview, reviewCopy);

  // 真实来源只读；Rust 和解析器只使用临时目录里的副本。
  const before = {
    originalUpgrade: fileVersion(originalUpgrade),
    originalReview: fileVersion(originalReview),
    upgradeCopy: fileVersion(upgradeCopy),
    reviewCopy: fileVersion(reviewCopy),
  };
  assert.equal(before.upgradeCopy.sha256, before.originalUpgrade.sha256);
  assert.equal(before.reviewCopy.sha256, before.originalReview.sha256);
  const preview = buildImportPreview(
    { fileName: basename(upgradeCopy), content: readFileSync(upgradeCopy, 'utf8') },
    { fileName: basename(reviewCopy), content: readFileSync(reviewCopy, 'utf8') },
  );
  assert.deepEqual(preview.errors, [], `${label} 来源校验失败`);
  writeFileSync(join(scenarioDir, 'request.json'), JSON.stringify(preview.input, null, 2));

  // 这个受控 Rust 测试调用生产 import_at / export_at；不使用 Node 手工拼一份假导出。
  const env = { ...process.env, ES_VOCAB_EXPORT_ROUNDTRIP_DIR: scenarioDir };
  delete env.CFLAGS;
  delete env.CXXFLAGS;
  const args = ['test', '--offline', '--locked', '--lib', 'vocab::export::tests::node_round_trip', '--', '--ignored', '--nocapture'];
  const rust = spawnSync('cargo', args, { cwd: join(appDir, 'src-tauri'), env, stdio: 'inherit' });
  if (rust.error) throw rust.error;
  assert.equal(rust.status, 0, `${label} Rust 生产导入/导出往返失败`);

  const upgradeText = readFileSync(join(scenarioDir, 'upgrade-export.md'), 'utf8');
  const reviewText = readFileSync(join(scenarioDir, 'review-export.md'), 'utf8');
  const upgraded = parseUpgradeLibrary(upgradeText);
  const reviewed = parseReviewLibrary(reviewText);
  const expectedEntries = preview.input.entries.map(entry => ({
    ...entry,
    examples: preview.input.examples.filter(example => example.entryId === entry.id)
      .sort((a, b) => a.seq - b.seq)
      .map(({ cand, sentence, ai }) => ({ cand, sentence, ai })),
  }));
  assert.deepEqual(upgraded.entries.map(withoutLine), expectedEntries.map(withoutLine), `${label} 升级 ID/raw/业务字段/例句/顺序不一致`);
  assert.deepEqual(upgraded.selfChecks.map(withoutLine), preview.input.selfChecks.map(withoutLine), `${label} 写作自查不一致`);
  assert.deepEqual(reviewed.words.map(withoutLine), preview.input.reviewWords.map(withoutLine), `${label} 复习 ID/raw/业务字段/顺序不一致`);

  // 独立证据：Rust 直查 SQLite，而不是复用 query::browse 的返回对象。
  const db = JSON.parse(readFileSync(join(scenarioDir, 'db-evidence.json'), 'utf8'));
  assert.deepEqual(idRaw(upgraded.entries), db.upgrade);
  assert.deepEqual(idRaw(upgraded.selfChecks), db.selfChecks);
  assert.deepEqual(idRaw(reviewed.words), db.review);
  const expectedUpgrade = [
    '## 词汇升级',
    '| 日常/口语 | 学术升级 | 例句 | 出处 | 备注 |',
    '|---|---|---|---|---|',
    ...db.upgrade.map(row => row.raw),
    '## 写作自查对照',
    ...db.selfChecks.map(row => row.raw),
    '',
  ].join('\n');
  const expectedReview = [
    '# 词汇总词库',
    '## 总词库',
    '| 单词 | 期号 | 入库日期 | 状态 | 下次到期 | 备注 |',
    '|---|---|---|---|---|---|',
    ...db.review.map(row => row.raw),
    '',
  ].join('\n');
  assert.equal(upgradeText, expectedUpgrade, `${label} 输出文件与独立数据库 raw 逐行不一致`);
  assert.equal(reviewText, expectedReview, `${label} 复习输出与独立数据库 raw 逐行不一致`);
  for (const text of [upgradeText, reviewText]) {
    assert.equal(text.charCodeAt(0) === 0xfeff, false, 'UTF-8 不应带 BOM');
    assert.equal(text.endsWith('\n'), true, '文件末尾必须换行');
    assert.equal(text.includes('deleted-'), false, '软删除记录不得导出');
  }
  assert.equal(db.dbSha256Before, db.dbSha256After);
  assert.equal(db.recordSnapshotUnchanged, true);

  const after = {
    originalUpgrade: fileVersion(originalUpgrade),
    originalReview: fileVersion(originalReview),
    upgradeCopy: fileVersion(upgradeCopy),
    reviewCopy: fileVersion(reviewCopy),
  };
  for (const key of Object.keys(before)) assert.equal(after[key].sha256, before[key].sha256, `${label} 的 ${key} 被改动`);
  const evidence = {
    label,
    sourcesBefore: before,
    sourcesAfter: after,
    database: {
      path: join(scenarioDir, 'vocab.db'),
      sha256Before: db.dbSha256Before,
      sha256After: db.dbSha256After,
      recordSnapshotUnchanged: db.recordSnapshotUnchanged,
    },
    outputs: {
      upgrade: { path: join(scenarioDir, 'upgrade-export.md'), sha256: sha256(upgradeText) },
      review: { path: join(scenarioDir, 'review-export.md'), sha256: sha256(reviewText) },
    },
    compared: ['ID', 'raw 原行', '全部业务字段', '例句及 AI 标记', '记录顺序', '软删除过滤', 'UTF-8 无 BOM', '末尾换行'],
    counts: preview.counts,
    warnings: {
      upgrade: preview.warnings.upgrade.length,
      review: preview.warnings.review.length,
    },
    command: `cargo ${args.join(' ')}`,
    exitCode: rust.status,
  };
  writeFileSync(join(scenarioDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`vocab export ${label}: ${preview.counts.upgradeEntries} 条升级、${preview.counts.reviewWords} 条复习，往返通过`);
  return evidence;
}

const fixturePath = name => join(appDir, 'dev', 'fixtures', 'vocab', 'export', name);
const scenarios = [];
scenarios.push(runRoundTrip('fixture', fixturePath('upgrade.md'), fixturePath('review.md')));

const longTermReview = join(runDir, 'long-term-review-source.md');
writeFileSync(longTermReview, [
  '# 词汇总词库', '## 总词库',
  '| 单词 | 期号 | 入库日期 | 状态 | 下次到期 | 备注 |', '|---|---|---|---|---|---|',
  '| long-one | 11.20 | 2026-11-20 | L5 | 2027-01-04 | 保温 1 |',
  '| long-two | 11.20 | 2026-11-20 | L6 | 2027-02-18 | 保温 2 |',
  '| long-three | 11.20 | 2026-11-20 | L7 | 2027-05-19 | 保温 3 |',
  '',
].join('\n'), 'utf8');
const longTerm = runRoundTrip('long-term-roundtrip', fixturePath('upgrade.md'), longTermReview);
const longTermOutput = readFileSync(join(longTerm.runDir ?? runDir, 'long-term-roundtrip', 'review-export.md'), 'utf8');
const longTermParsed = parseReviewLibrary(longTermOutput);
assert.deepEqual(longTermParsed.words.map(word => [word.status, word.level, word.due]), [
  ['L5', 5, '2027-01-04'], ['L6', 6, '2027-02-18'], ['L7', 7, '2027-05-19'],
], 'Markdown 往返必须保留 L5–L7 状态和到期日');

// 标准 6：D:\english 是真实来源，只读复制到临时目录；可用环境变量指定换机后的来源根目录。
const realSourceDir = process.env.ES_VOCAB_REAL_SOURCE_DIR || 'D:\\english';
scenarios.push(runRoundTrip(
  'real-source-copy',
  join(realSourceDir, '词汇', '学术升级库.md'),
  join(realSourceDir, '词汇复习库.md'),
));
const evidence = {
  evidenceVersion: 2,
  runDir,
  realSourceDir,
  scenarios,
};
writeFileSync(join(runDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(`vocab export: fixture 与真实来源只读副本均通过；证据：${join(runDir, 'evidence.json')}`);


// 原生保存框选择已有文件时，Windows 还会弹「是否覆盖」确认框。
// 这个辅助进程只找本次 Tauri 进程后代的确认框，并点击「是」(ID 6)，不发全局按键。
async function confirmOverwrite(session) {
  const script = String.raw`
param([Parameter(Mandatory=$true)][int]$RootPid)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class EsOverwrite {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW")] static extern IntPtr SendNum(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
  static string Cls(IntPtr h) { var s = new StringBuilder(64); GetClassName(h, s, 64); return s.ToString(); }
  static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static long FindYes(HashSet<uint> pids) {
    long found = 0;
    EnumWindows((h, l) => {
      if (found != 0 || !IsWindowVisible(h) || Cls(h) != "#32770") return true;
      uint p = Pid(h); IntPtr owner = GetWindow(h, 4); uint op = owner == IntPtr.Zero ? 0 : Pid(owner);
      if (!pids.Contains(p) && (op == 0 || !pids.Contains(op))) return true;
      EnumChildWindows(h, (c, x) => {
        if (found == 0 && Cls(c) == "Button" && GetDlgCtrlID(c) == 6) found = c.ToInt64();
        return true;
      }, IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static void Click(long h) { IntPtr r; SendNum(new IntPtr(h), 0x00F5, IntPtr.Zero, IntPtr.Zero, 2, 3000, out r); }
}
'@
function Get-OwnPids([int]$root) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $set = New-Object 'System.Collections.Generic.HashSet[uint32]'
  [void]$set.Add([uint32]$root)
  do {
    $grew = $false
    foreach ($p in $all) {
      if ($set.Contains([uint32]$p.ParentProcessId) -and -not $set.Contains([uint32]$p.ProcessId)) {
        [void]$set.Add([uint32]$p.ProcessId); $grew = $true
      }
    }
  } while ($grew)
  return , $set
}
$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline) {
  $yes = [EsOverwrite]::FindYes((Get-OwnPids $RootPid))
  if ($yes -ne 0) {
    [EsOverwrite]::Click($yes)
    Write-Output ('{"ok":true,"buttonHwnd":' + $yes + '}')
    exit 0
  }
  Start-Sleep -Milliseconds 100
}
Write-Output '{"ok":false,"error":"overwrite confirmation not found"}'
exit 4
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await promisify(execFile)('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded, '-RootPid', String(session.rootPid),
  ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).pop());
  assert.equal(result.ok, true, '没有操作到本次窗口的原生覆盖确认框');
  return result;
}

async function chooseSaveFile(session, file) {
  // 现代 Windows 保存框的文件名是 Pane/Edit；用 UIA 定向设置并调用保存，不发全局输入。
  const source = readFileSync(join(appDir, 'dev', 'e2e', 'dialog.ps1'), 'utf8');
  const openBlock = "if ($Action -eq 'open') {\n  Add-Type -AssemblyName UIAutomationClient\n  Add-Type -AssemblyName UIAutomationTypes\n  $auto = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)\n  $all = $auto.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)\n  $fileControl = $all | Where-Object { $_.Current.AutomationId -eq '1001' -and $_.Current.ClassName -eq 'Edit' } | Select-Object -First 1\n  $info.filePatterns = @($fileControl.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })\n  $info.fileName = $fileControl.Current.Name\n  $saveControl = $all | Where-Object { $_.Current.AutomationId -eq '1' -and $_.Current.ClassName -eq 'Button' } | Select-Object -First 1\n  $info.savePatterns = @($saveControl.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })\n  $info.error = 'pattern diagnostic only'\n  $info.ok = $false\n  Out-Json $info\n  exit 5\n  $id = 1";
  const openStart = source.indexOf("if ($Action -eq 'open') {");
  const openElse = source.indexOf('} else {', openStart);
  if (openStart < 0 || openElse < 0) throw new Error('保存框脚本结构发生变化');
  const finalScript = (source.slice(0, openStart) + openBlock + source.slice(openElse))
    .replace('if ($btn -ne 0) { [EsWin]::ClickButton($btn); $info.method = "BM_CLICK on button id $id (hwnd $btn)" }', 'if ($Action -eq \'open\') { [EsWin]::ClickButton($btn) } elseif ($btn -ne 0) { [EsWin]::ClickButton($btn); $info.method = "BM_CLICK on button id $id (hwnd $btn)" }');
  const scriptPath = join(session.runDir, 'save-dialog-uia.ps1');
  writeFileSync(scriptPath, finalScript.startsWith('\ufeff') ? finalScript : '\ufeff' + finalScript);
  const info = await new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
      '-Action', 'open', '-RootPid', String(session.rootPid), '-Timeout', '30', '-Path', file,
    ], { encoding: 'utf8', windowsHide: true, timeout: 60000 }, (error, stdout, stderr) => {
      const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop();
      let result;
      try { result = JSON.parse(line); } catch {
        reject(new Error('保存框脚本无结果：' + (stderr || stdout || error?.message || '')));
        return;
      }
      if (!result.ok || error) reject(new Error('保存框操作失败：' + JSON.stringify(result)));
      else resolve(result);
    });
  });
  return info;
}

async function chooseExistingFile(session, file) {
  const results = await Promise.allSettled([chooseSaveFile(session, file), confirmOverwrite(session)]);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results.map(result => result.value);
}

async function runRealWindow() {
  // 不碰用户数据库和仓库外目录；启动模块必须在设置 ES_E2E_ROOT 后动态载入。
  process.env.ES_E2E_ROOT = join(appDir, 'src-tauri', 'target', 'vocab-export-e2e');
  const { start, stop } = await import(pathToFileURL(join(appDir, 'dev', 'e2e', 'launch.mjs')).href);
  const { connect } = await import(pathToFileURL(join(appDir, 'dev', 'e2e', 'cdp.mjs')).href);
  const { cancelDialog } = await import(pathToFileURL(join(appDir, 'dev', 'e2e', 'dialog.mjs')).href);
  const { openDb } = await import(pathToFileURL(join(appDir, 'dev', 'e2e', 'db.mjs')).href);
  const runId = `015-rework-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${process.pid}`;
  const session = await start({ runId });
  let page;
  let failure = null;
  const steps = [];
  // Windows 保存框的文件名输入限制为 64 字符；用本次 PID 的短路径，证据仍在 session.out。
  const dialogOut = join(appDir, 'src-tauri', 'target', String(process.pid));
  mkdirSync(dialogOut, { recursive: true });
  const upgradeOutput = join(dialogOut, 'u.md');
  const reviewOutput = join(dialogOut, 'r.md');
  assert.ok(upgradeOutput.length < 64 && reviewOutput.length < 64, '原生保存框测试路径必须短于 64 字符');
  try {
    page = await connect({ port: session.port });
    await page.waitReady('button');
    await page.clickText('词库');
    await page.clickText('导出', { selector: '[role=tab]' });
    await page.waitText('导出为新的 Markdown');
    const emptyButtons = await page.evaluate(`[...document.querySelectorAll('button')].filter(b => b.textContent.includes('导出学术升级库') || b.textContent.includes('导出复习库')).map(b => ({ text: b.textContent.trim(), disabled: b.disabled }))`);
    assert.equal(emptyButtons.length, 2);
    assert.equal(emptyButtons.every(button => button.disabled), true, '空库时两个按钮都必须禁用');
    await page.screenshot(join(session.out, '01-empty.png'));
    steps.push('空库：两个导出按钮禁用并显示原因');

    // 用生产前端 API 和真实 Rust/SQLite 隔离导入 fixture，只把导出原生对话框作为本段 UI 验收重点。
    const preview = buildImportPreview(
      { fileName: 'upgrade.md', content: readFileSync(fixturePath('upgrade.md'), 'utf8') },
      { fileName: 'review.md', content: readFileSync(fixturePath('review.md'), 'utf8') },
    );
    const report = await page.evaluate(async input => {
      const { vocabApi } = await import('/utils/vocab/api.ts');
      return vocabApi.import(input);
    }, preview.input);
    assert.equal(report.totals.upgradeEntries, 3);
    assert.equal(report.totals.reviewWords, 5);
    await page.clickText('浏览', { selector: '[role=tab]' });
    await page.clickText('导出', { selector: '[role=tab]' });
    await page.waitText('3 条升级词');

    await page.clickText('导出学术升级库');
    await cancelDialog(session);
    await page.waitText('已取消保存，没有写入文件。');
    const { readdirSync } = await import('node:fs');
    assert.equal(readdirSync(dialogOut).filter(name => name.endsWith('.md')).length, 0, '取消保存不能写文件');
    steps.push('取消原生保存框：零写入');

    await page.clickText('导出学术升级库');
    await chooseSaveFile(session, upgradeOutput);
    await page.waitText('新文件已保存到：');
    await page.waitText(upgradeOutput);
    await page.screenshot(join(session.out, '02-upgrade-success.png'));
    steps.push('学术升级库：原生保存成功并显示完整路径');

    await page.clickText('导出复习库');
    await chooseSaveFile(session, reviewOutput);
    await page.waitText('新文件已保存到：');
    await page.waitText(reviewOutput);
    await page.screenshot(join(session.out, '03-review-success.png'));
    steps.push('复习库：原生保存成功并显示完整路径');

    const existingBefore = sha256(readFileSync(upgradeOutput));
    await page.clickText('导出学术升级库');
    const dialogEvidence = await chooseExistingFile(session, upgradeOutput);
    await page.waitText('导出学术升级库失败：目标文件已存在，已拒绝覆盖');
    await page.screenshot(join(session.out, '04-existing-file-error.png'));
    assert.equal(sha256(readFileSync(upgradeOutput)), existingBefore, '拒绝覆盖后已有文件哈希必须不变');
    steps.push('选择已有文件并确认系统覆盖提示：页面显示拒绝覆盖，原文件哈希不变');

    const db = await openDb(session);
    const upgradeRows = db.prepare('SELECT id, raw FROM upgrade_entry WHERE deleted = 0 ORDER BY ord, id').all();
    const selfRows = db.prepare('SELECT id, raw FROM self_check WHERE deleted = 0 ORDER BY ord, id').all();
    const reviewRows = db.prepare('SELECT id, raw FROM review_word WHERE deleted = 0 ORDER BY ord, id').all();
    db.close();
    const upgraded = parseUpgradeLibrary(readFileSync(upgradeOutput, 'utf8'));
    const reviewed = parseReviewLibrary(readFileSync(reviewOutput, 'utf8'));
    assert.deepEqual(idRaw(upgraded.entries), upgradeRows);
    assert.deepEqual(idRaw(upgraded.selfChecks), selfRows);
    assert.deepEqual(idRaw(reviewed.words), reviewRows);
    assert.equal(readFileSync(upgradeOutput, 'utf8').includes('保留完整备注'), true);
    assert.equal(readFileSync(upgradeOutput, 'utf8').includes('(AI)'), true);
    steps.push('真实窗口输出：007 再解析与隔离数据库 raw/顺序一致，中文、长备注和 AI 标记可读');

    await page.setViewport(390, 844);
    const overflow = await page.evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth');
    assert.equal(overflow, false, '390×844 不应横向溢出');
    await page.screenshot(join(session.out, '05-narrow.png'));
    await page.setViewport();
    steps.push('390×844 WebView 模拟：无横向溢出（不是安卓真机）');

    const evidence = {
      completed: true,
      runDir: session.runDir,
      command: 'node test-vocab-export.mjs --e2e',
      exitCode: 0,
      steps,
      outputs: { upgrade: upgradeOutput, review: reviewOutput },
      existingFile: { path: upgradeOutput, sha256Before: existingBefore, sha256After: sha256(readFileSync(upgradeOutput)), dialogEvidence },
      screenshots: ['01-empty.png', '02-upgrade-success.png', '03-review-success.png', '04-existing-file-error.png', '05-narrow.png'],
      pageErrors: page.errors,
      androidDeviceVerified: false,
    };
    writeFileSync(join(session.out, 'e2e-evidence.json'), JSON.stringify(evidence, null, 2));
    writeFileSync(join(session.out, 'e2e-evidence.txt'), [...steps, 'completed: true', '安卓真机: 未验证'].join('\n') + '\n');
    console.log(`真实窗口导出验收通过；证据：${join(session.out, 'e2e-evidence.json')}`);
  } catch (error) {
    failure = error;
    if (page) await page.screenshot(join(session.out, '99-failure.png')).catch(() => {});
    throw error;
  } finally {
    page?.close();
    await stop(session.runDir);
    if (failure) {
      writeFileSync(join(session.out, 'e2e-failure.txt'), String(failure.stack || failure));
    }
  }
}

if (process.argv.includes('--e2e')) await runRealWindow();
