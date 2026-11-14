// 真实窗口测试：进程小工具（只给 launch.mjs / dialog.mjs 用）。
// 用 PowerShell 的 Get-CimInstance 取进程表，按「父子关系 + 创建时间」认出自己启动的进程，
// 避免 PID 被系统复用后误杀别人。
import { execFileSync } from 'node:child_process';
import net from 'node:net';

// 跑一小段 PowerShell，返回 stdout 文本（脚本里只放 ASCII）。
export function ps(command, { timeout = 30000 } = {}) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
}

// 进程快照：[{ pid, ppid, name, ctime, cmd }]；ctime 是创建时间的 Ticks，用来防 PID 复用。
export function snapshot() {
  const out = ps(
    "$ErrorActionPreference='SilentlyContinue'; " +
      "$r = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; name=[string]$_.Name; ctime=[string]$_.CreationDate.Ticks; cmd=[string]$_.CommandLine } }); " +
      "ConvertTo-Json -InputObject $r -Compress -Depth 3",
    { timeout: 60000 },
  );
  const list = JSON.parse(out || '[]');
  return Array.isArray(list) ? list : [list];
}

// 创建时间早于 ref 吗（ctime 是 Ticks 字符串；缺失当作「不可信」）。
export function createdBefore(a, ref) {
  if (!a?.ctime || !ref?.ctime) return true;
  return BigInt(a.ctime) < BigInt(ref.ctime);
}

// rootPids 以及它们所有后代（递归）。
// Windows 的 ParentProcessId 在父进程退出后不会清空：csrss、wininit 等系统进程的「父 PID」指向早已退出的 smss，
// 如果我们的进程恰好复用了这个 PID，系统进程就会被误认成「子进程」（2026-11-10 复核时真的出现过）。
// 所以子进程必须比父进程晚创建才算数。
export function descendantsOf(rootPids, snap = snapshot()) {
  const wanted = new Set(rootPids);
  const result = new Map();
  for (const p of snap) if (wanted.has(p.pid)) result.set(p.pid, p);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of snap) {
      const parent = result.get(p.ppid);
      if (!result.has(p.pid) && parent && p.pid !== p.ppid && !createdBefore(p, parent)) {
        result.set(p.pid, p);
        grew = true;
      }
    }
  }
  return [...result.values()];
}

// 端口有没有程序在听：试着连 127.0.0.1 和 ::1，连得上就算被占。
export function portInUse(port) {
  const tryHost = host =>
    new Promise(resolve => {
      const socket = net.connect({ port, host });
      const done = busy => {
        socket.destroy();
        resolve(busy);
      };
      socket.setTimeout(1500, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  return Promise.all([tryHost('127.0.0.1'), tryHost('::1')]).then(r => r.some(Boolean));
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
