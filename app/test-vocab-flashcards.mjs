// 014 翻面闪卡测试：node test-vocab-flashcards.mjs（在 app 目录下）。
// 覆盖：空队列、单卡、多卡、首尾边界、切卡回正面、键盘映射、退出后键盘无效、重新进入只挂一份监听。
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const out = join(tmpdir(), `vocab-flash-${process.pid}.mjs`);
await build({ entryPoints: ['utils/vocab/flashcards.ts'], bundle: true, format: 'esm', outfile: out, logLevel: 'silent' });
const f = await import(pathToFileURL(out).href);
rmSync(out, { force: true });

const card = (id, ord) => ({
  id, ord, line: ord, raw: '', word: id, issue: '9.1', addedAt: '', status: 'L1', level: 1,
  due: '2026-11-05', note: '', overdueDays: 0,
});

// ---- 空队列：不开始，没有空闪卡 ----
assert.equal(f.startSession([]), null);

// ---- 单卡：首尾都是它，前后都禁用，进度 1 / 1 ----
let s = f.startSession([card('only', 1)]);
assert.equal(f.canPrev(s), false);
assert.equal(f.canNext(s), false);
assert.equal(f.isLast(s), true);
assert.deepEqual(f.progress(s), { label: '1 / 1', percent: 100 });
assert.equal(f.next(s), s, '尾部下一张不动');
assert.equal(f.prev(s), s, '头部上一张不动');
s = f.flip(s);
assert.equal(s.flipped, true);
s = f.flip(s);
assert.equal(s.flipped, false, '再翻回正面');

// ---- 多卡：前后切换、边界、切卡回正面 ----
const source = [card('a', 1), card('b', 2), card('c', 3)];
s = f.startSession(source);
assert.equal(f.currentCard(s).id, 'a');
assert.equal(s.flipped, false, '开始在正面');
assert.equal(f.canPrev(s), false);
assert.equal(f.canNext(s), true);
assert.equal(f.prev(s), s, '第一张上一张不动');
s = f.flip(s);
s = f.next(s);
assert.equal(f.currentCard(s).id, 'b');
assert.equal(s.flipped, false, '下一张回到正面');
assert.deepEqual(f.progress(s), { label: '2 / 3', percent: 67 });
s = f.flip(s);
s = f.prev(s);
assert.equal(f.currentCard(s).id, 'a');
assert.equal(s.flipped, false, '上一张回到正面');
s = f.next(f.next(s));
assert.equal(f.currentCard(s).id, 'c');
assert.equal(f.isLast(s), true);
assert.equal(f.canNext(s), false);
assert.equal(f.next(s), s, '最后一张下一张不动');
assert.deepEqual(f.progress(s), { label: '3 / 3', percent: 100 });
for (const st of [f.startSession(source), s]) assert.ok(Number.isFinite(f.progress(st).percent), '进度不出现 NaN');

// ---- 队列固定：开始后改原数组，不影响本次会话 ----
const live = [card('x', 1), card('y', 2)];
const fixed = f.startSession(live);
live.push(card('z', 3));
live.splice(0, 1);
assert.deepEqual(fixed.queue.map(c => c.id), ['x', 'y']);
assert.ok(Object.isFrozen(fixed.queue));

// ---- 键盘映射 ----
const k = (key, extra = {}) => ({ key, target: { tagName: 'BUTTON' }, ...extra });
assert.equal(f.keyAction(k('Escape'), true), 'exit');
assert.equal(f.keyAction(k('ArrowLeft'), true), 'prev');
assert.equal(f.keyAction(k('ArrowRight'), true), 'next');
assert.equal(f.keyAction(k(' '), true), 'flip');
assert.equal(f.keyAction(k('Enter'), true), null);
assert.equal(f.keyAction(k('a'), true), null);
// 闪卡没打开：一个都不处理。
for (const key of ['Escape', 'ArrowLeft', 'ArrowRight', ' ']) assert.equal(f.keyAction(k(key), false), null, key);
// 焦点在输入控件里：不处理。
for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input'])
  assert.equal(f.keyAction(k(' ', { target: { tagName } }), true), null, tagName);
assert.equal(f.keyAction(k('ArrowRight', { target: { tagName: 'DIV', isContentEditable: true } }), true), null);
// 输入法组字、组合键：不处理。
assert.equal(f.keyAction(k('Escape', { isComposing: true }), true), null);
assert.equal(f.keyAction(k('Escape', { keyCode: 229 }), true), null);
assert.equal(f.keyAction(k('ArrowRight', { ctrlKey: true }), true), null);
assert.equal(f.keyAction(k('ArrowLeft', { metaKey: true }), true), null);
assert.equal(f.keyAction(k(' ', { altKey: true }), true), null);
assert.equal(f.isEditableTarget(null), false);
assert.equal(f.isEditableTarget(undefined), false);

// ---- 监听：挂上/解除、退出后无效、重新进入只有一份 ----
class CountingTarget extends EventTarget {
  listeners = 0;
  addEventListener(type, listener, capture) { this.listeners += 1; super.addEventListener(type, listener, capture); }
  removeEventListener(type, listener, capture) { this.listeners -= 1; super.removeEventListener(type, listener, capture); }
}
const keyEvent = (key, extra = {}) => {
  const event = new Event('keydown', { cancelable: true });
  Object.assign(event, { key, ...extra });
  return event;
};
// 用一个「下游」监听模拟听写等其他快捷键：闪卡认出的键不能传下去。
const target = new CountingTarget();
const downstream = [];
target.addEventListener('keydown', e => downstream.push(e.key), false);
target.listeners = 0; // 只数闪卡自己的监听

const actions = [];
let detach = f.attachFlashKeys(target, a => actions.push(a));
assert.equal(target.listeners, 1);
const space = keyEvent(' ');
target.dispatchEvent(space);
assert.equal(space.defaultPrevented, true, '空格不再滚动页面');
target.dispatchEvent(keyEvent('ArrowRight'));
target.dispatchEvent(keyEvent('Escape'));
target.dispatchEvent(keyEvent('q'));
assert.deepEqual(actions, ['flip', 'next', 'exit']);
// stopPropagation 只阻止「传播到下一个节点」；同一个 EventTarget 上的下游监听在 Node 里仍会收到，
// 所以这里检查默认行为被阻止 + 非闪卡键原样放行。浏览器里的真实串键情况由真实窗口验收核对。
assert.ok(downstream.includes('q'), '非闪卡键放行');

// 退出（解除）后：键盘无效；重复解除不会多减。
detach();
detach();
assert.equal(target.listeners, 0);
actions.length = 0;
target.dispatchEvent(keyEvent('ArrowRight'));
target.dispatchEvent(keyEvent('Escape'));
assert.deepEqual(actions, [], '退出后按键不再触发闪卡');

// 重新进入：只有一份监听，一次按键只触发一次。
detach = f.attachFlashKeys(target, a => actions.push(a));
assert.equal(target.listeners, 1);
target.dispatchEvent(keyEvent('ArrowLeft'));
assert.deepEqual(actions, ['prev']);
detach();
assert.equal(target.listeners, 0);

// isActive 返回 false 时不处理（例如闪卡已关闭但组件还没卸载的瞬间）。
let active = false;
actions.length = 0;
detach = f.attachFlashKeys(target, a => actions.push(a), () => active);
const ignored = keyEvent(' ');
target.dispatchEvent(ignored);
assert.equal(ignored.defaultPrevented, false);
active = true;
target.dispatchEvent(keyEvent(' '));
assert.deepEqual(actions, ['flip']);
detach();

console.log('test-vocab-flashcards: 全部通过');
