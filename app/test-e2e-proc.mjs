// 真实窗口测试工具：进程树识别的单元测试（不启动任何进程）。
// 复现 2026-11-10 的问题：系统进程的「父 PID」指向早已退出的进程，被我们的进程复用后，系统进程被误认成子进程。
import assert from 'node:assert/strict';
import { createdBefore, descendantsOf } from './dev/e2e/proc.mjs';

const snap = [
  { pid: 100, ppid: 4, name: 'wininit.exe', ctime: '1000' },   // 开机时创建，父 PID 500 早已退出
  { pid: 101, ppid: 500, name: 'csrss.exe', ctime: '1001' },
  { pid: 500, ppid: 9, name: 'node.exe', ctime: '9000' },      // 我们的根进程，复用了 PID 500
  { pid: 501, ppid: 500, name: 'cmd.exe', ctime: '9001' },
  { pid: 502, ppid: 501, name: 'linguaclip.exe', ctime: '9050' },
  { pid: 503, ppid: 502, name: 'msedgewebview2.exe', ctime: '9060' },
];

const got = descendantsOf([500], snap).map(x => x.pid).sort();
assert.deepEqual(got, [500, 501, 502, 503], '只认比父进程晚创建的子进程，csrss 不算');

assert.equal(createdBefore({ ctime: '1' }, { ctime: '2' }), true);
assert.equal(createdBefore({ ctime: '2' }, { ctime: '2' }), false);
assert.equal(createdBefore({ ctime: null }, { ctime: '2' }), true, '没有创建时间的进程当作不可信');

console.log('进程树识别测试通过：PID 被复用时系统进程不会被当成测试进程。');
