// 真实窗口测试：操作系统的文件选择框（只认本次测试进程自己的框）。
// 在页面里点出「选择文件」之后马上调用：
//   await cancelDialog(s)               点「取消」
//   await chooseFile(s, 'D:\\x\\a.srt')  填路径并点「打开」
// s 是 launch.mjs 的 start()/session() 返回的会话（只用到 rootPid），也可以直接传根进程 PID。
// 找不到对话框就超时报错，不会退回到全局按键。说明见 docs/e2e.md。
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dialog.ps1');

function run(session, action, extra = [], timeoutSec = 20) {
  const rootPid = typeof session === 'number' ? session : session.rootPid;
  if (!rootPid) return Promise.reject(new Error('dialog：需要会话对象或根进程 PID'));
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action, '-RootPid', String(rootPid), '-Timeout', String(timeoutSec), ...extra];
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', args, { encoding: 'utf8', windowsHide: true, timeout: (timeoutSec + 30) * 1000 }, (err, stdout, stderr) => {
      const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop();
      let info;
      try {
        info = JSON.parse(line);
      } catch {
        return reject(new Error(`对话框脚本没有给出结果：${(stderr || stdout || (err && err.message) || '').toString().slice(0, 400)}`));
      }
      if (!info.ok) {
        const reason = String(info.error || '').startsWith('no file dialog')
          ? `等了 ${timeoutSec} 秒，本次测试进程没有弹出文件对话框`
          : `对话框操作失败：${info.error}`;
        return reject(new Error(reason));
      }
      console.log(`[dialog] ${action} 成功：窗口句柄 ${info.hwnd}，所属 PID ${info.pid}，标题「${info.title}」，${info.method || '仅查找'}，已关闭=${info.closed ?? '-'}`);
      resolve(info);
    });
  });
}

export const waitDialog = (session, { timeout = 20 } = {}) => run(session, 'find', [], timeout);
export const cancelDialog = (session, { timeout = 20 } = {}) => run(session, 'cancel', [], timeout);
export const chooseFile = (session, file, { timeout = 20 } = {}) => run(session, 'open', ['-Path', path.resolve(file)], timeout);
