// 真实保存框控制：复用仓库受控脚本，另补 ComboBoxEx32 文本和覆盖确认。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function makeSaveDialog(runDir) {
  const source = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'e2e', 'dialog.ps1');
  let text = fs.readFileSync(source, 'utf8');
  const combo = `
+  public static long FindNameCombo(long dlg) {
+    long found = 0;
+    EnumChildWindows(new IntPtr(dlg), (h, l) => {
+      if (found == 0 && Cls(h) == "ComboBoxEx32") found = h.ToInt64();
+      return true;
+    }, IntPtr.Zero);
+    return found;
+  }
+
`.split('\n').map(line => line.startsWith('+') ? line.slice(1) : line).join('\n');
  text = text.replace('  // 找 ID 为 id 的按钮子窗口', `${combo}  // 找 ID 为 id 的按钮子窗口`);
  text = text.replace("  $info.editHwnd = $edit", `  $combo = [EsWin]::FindNameCombo($hwnd)
+  if ($combo -ne 0) { [void][EsWin]::SetText($combo, $Path) }
+  $info.editHwnd = $edit`.split('\n').map(line => line.startsWith('+') ? line.slice(1) : line).join('\n'));
  const confirmation = `
+if ($Action -eq 'open') {
+  for ($i = 0; $i -lt 20 -and [EsWin]::Alive($hwnd); $i++) {
+    Start-Sleep -Milliseconds 250
+    $others = @([EsWin]::FindDialogs($pids) | Where-Object { $_[0] -ne $dlg[0] })
+    if ($others.Count -gt 0) {
+      $yes = [EsWin]::FindButton([int64]$others[0][0], 6)
+      if ($yes -ne 0) {
+        [EsWin]::ClickButton($yes)
+        $info.overwriteConfirmed = $true
+      }
+    } else {
+      $yesHere = [EsWin]::FindButton($hwnd, 6)
+      if ($yesHere -ne 0) {
+        [EsWin]::ClickButton($yesHere)
+        $info.overwriteConfirmed = $true
+      }
+      if ($i -eq 3 -or $i -eq 8) {
+        $again = [EsWin]::FindButton($hwnd, 1)
+        if ($again -ne 0) { [EsWin]::ClickButton($again) }
+      }
+    }
+  }
+}
+
`.split('\n').map(line => line.startsWith('+') ? line.slice(1) : line).join('\n');  text = text.replace('# 等对话框真的关掉', `${confirmation}# 等对话框真的关掉`);
  const generated = path.join(runDir, 'save-dialog.ps1');
  fs.writeFileSync(generated, text, 'utf8');
  return (session, file, timeoutSec = 20) => new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', generated,
      '-Action', 'open', '-RootPid', String(session.rootPid), '-Timeout', String(timeoutSec), '-Path', file];
    execFile('powershell.exe', args, { encoding: 'utf8', windowsHide: true, timeout: (timeoutSec + 30) * 1000 }, (error, stdout, stderr) => {
      const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop();
      let info;
      try { info = JSON.parse(line); } catch {
        return reject(new Error(`保存框脚本没有结果：${stderr || stdout || error?.message}`));
      }
      if (!info.ok) return reject(new Error(`保存框操作失败：${info.error}`));
      console.log(`[save-dialog] 已选择 ${file}；覆盖确认=${info.overwriteConfirmed ?? false}`);
      resolve(info);
    });
  });
}