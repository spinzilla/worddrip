# 真实窗口测试：找「本次测试进程」的系统文件对话框，填路径并点打开 / 点取消。
# 只认属于 -RootPid 及其后代进程的 #32770 对话框；找不到就超时报错，绝不发全局按键。
# 输出一行 JSON（UTF-8）。由 dialog.mjs 调用，不用手动跑。
param(
  [Parameter(Mandatory = $true)][ValidateSet('find', 'open', 'cancel')][string]$Action,
  [Parameter(Mandatory = $true)][int]$RootPid,
  [string]$Path = '',
  [int]$Timeout = 20
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class EsWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW", CharSet = CharSet.Unicode)]
  static extern IntPtr SendText(IntPtr h, uint msg, IntPtr w, string l, uint flags, uint timeout, out IntPtr res);
  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW")]
  static extern IntPtr SendNum(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr res);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

  static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  static string Txt(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }

  // 属于 pids 的、可见的 #32770 顶层窗口（自己或它的拥有者窗口属于 pids）。
  public static List<string[]> FindDialogs(HashSet<uint> pids) {
    var res = new List<string[]>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || Cls(h) != "#32770") return true;
      uint p = Pid(h);
      IntPtr owner = GetWindow(h, 4); // GW_OWNER
      uint op = owner == IntPtr.Zero ? 0 : Pid(owner);
      if (pids.Contains(p) || (op != 0 && pids.Contains(op)))
        res.Add(new string[] { h.ToInt64().ToString(), p.ToString(), Txt(h) });
      return true;
    }, IntPtr.Zero);
    return res;
  }

  public static bool Alive(long h) { return IsWindow(new IntPtr(h)) && IsWindowVisible(new IntPtr(h)); }

  // 文件名输入框：优先 ComboBoxEx32 里的 Edit，找不到再退而求其次找控件 ID 1148 / 1001 的 Edit。
  public static long FindNameEdit(long dlg) {
    long viaCombo = 0, viaId = 0;
    EnumChildWindows(new IntPtr(dlg), (h, l) => {
      if (Cls(h) == "Edit") {
        int id = GetDlgCtrlID(h);
        if (viaId == 0 && (id == 1148 || id == 1001)) viaId = h.ToInt64();
      }
      return true;
    }, IntPtr.Zero);
    EnumChildWindows(new IntPtr(dlg), (box, l) => {
      if (viaCombo == 0 && Cls(box) == "ComboBoxEx32") {
        EnumChildWindows(box, (h, l2) => {
          if (viaCombo == 0 && Cls(h) == "Edit") viaCombo = h.ToInt64();
          return true;
        }, IntPtr.Zero);
      }
      return true;
    }, IntPtr.Zero);
    return viaCombo != 0 ? viaCombo : viaId;
  }

  public static bool SetText(long h, string text) {
    IntPtr res;
    // WM_SETTEXT = 0x000C
    return SendText(new IntPtr(h), 0x000C, IntPtr.Zero, text, 2, 3000, out res) != IntPtr.Zero;
  }

  // 找 ID 为 id 的按钮子窗口，返回句柄（没有返回 0）。
  public static long FindButton(long dlg, int id) {
    long found = 0;
    EnumChildWindows(new IntPtr(dlg), (h, l) => {
      if (found == 0 && Cls(h) == "Button" && GetDlgCtrlID(h) == id) found = h.ToInt64();
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static void ClickButton(long btn) {
    IntPtr res; // BM_CLICK = 0x00F5
    SendNum(new IntPtr(btn), 0x00F5, IntPtr.Zero, IntPtr.Zero, 2, 3000, out res);
  }

  // WM_COMMAND = 0x0111；IDOK = 1，IDCANCEL = 2。Post 不阻塞，避免模态循环卡住调用方。
  public static void Command(long dlg, int id) { PostMessage(new IntPtr(dlg), 0x0111, new IntPtr(id), IntPtr.Zero); }
}
'@

function Get-OwnPids([int]$root) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $set = New-Object 'System.Collections.Generic.HashSet[uint32]'
  if (-not ($all | Where-Object { $_.ProcessId -eq $root })) { return $null }
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

function Out-Json($obj) { Write-Output ($obj | ConvertTo-Json -Compress) }

$deadline = (Get-Date).AddSeconds($Timeout)
$dlg = $null
while ((Get-Date) -lt $deadline) {
  $pids = Get-OwnPids $RootPid
  if ($null -eq $pids) { Out-Json @{ ok = $false; error = "root process $RootPid is not running" }; exit 3 }
  $found = [EsWin]::FindDialogs($pids)
  if ($found.Count -gt 0) { $dlg = $found[0]; break }
  Start-Sleep -Milliseconds 250
}
if ($null -eq $dlg) { Out-Json @{ ok = $false; error = "no file dialog of the test process found within $Timeout s" }; exit 4 }

$hwnd = [int64]$dlg[0]
$info = @{ ok = $true; action = $Action; hwnd = $hwnd; pid = [int]$dlg[1]; title = $dlg[2] }
if ($Action -eq 'find') { Out-Json $info; exit 0 }

if ($Action -eq 'open') {
  $edit = [EsWin]::FindNameEdit($hwnd)
  if ($edit -eq 0) { $info.ok = $false; $info.error = 'file name edit box not found in dialog'; Out-Json $info; exit 5 }
  if (-not [EsWin]::SetText($edit, $Path)) { $info.ok = $false; $info.error = 'WM_SETTEXT failed'; Out-Json $info; exit 5 }
  $info.editHwnd = $edit
  $id = 1
} else {
  $id = 2
}
$btn = [EsWin]::FindButton($hwnd, $id)
if ($btn -ne 0) { [EsWin]::ClickButton($btn); $info.method = "BM_CLICK on button id $id (hwnd $btn)" }
else { [EsWin]::Command($hwnd, $id); $info.method = "WM_COMMAND id $id posted to dialog" }

# 等对话框真的关掉
$gone = $false
for ($i = 0; $i -lt 30; $i++) {
  if (-not [EsWin]::Alive($hwnd)) { $gone = $true; break }
  Start-Sleep -Milliseconds 200
}
$info.closed = $gone
if (-not $gone) { $info.ok = $false; $info.error = 'dialog still open after the click' }
Out-Json $info
if (-not $gone) { exit 6 }
