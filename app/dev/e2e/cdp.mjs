// 真实窗口测试：页面操作库（Chrome DevTools Protocol，连 WebView2 的调试端口）。
// 用法：const page = await connect({ port: 9337 });  之后 page.click(...) / page.screenshot(...)
// 所有等待都有超时，超时抛中文错误。说明见 docs/e2e.md。
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './proc.mjs';

const DEFAULT_TIMEOUT = 15000;

export async function connect({ port = 9337, urlIncludes = 'localhost:3000', timeout = 60000 } = {}) {
  const deadline = Date.now() + timeout;
  let target;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
      target = pages.find(x => x.type === 'page' && String(x.url).includes(urlIncludes));
      if (target) break;
      lastErr = `调试端口上有 ${pages.length} 个页面，但没有网址含「${urlIncludes}」的`;
    } catch (e) {
      lastErr = `连不上调试端口 ${port}：${e.message}`;
    }
    await sleep(500);
  }
  if (!target) throw new Error(`等了 ${Math.round(timeout / 1000)} 秒还没连上应用页面。${lastErr}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('页面调试连接失败（WebSocket）')), { once: true });
  });
  return new Page(ws);
}

class Page {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.errors = []; // 页面里的未捕获异常和 console.error，验收时可以看
    this.closed = false;
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const w = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) w.reject(new Error(`浏览器协议报错：${msg.error.message}`));
        else w.resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || '未知异常');
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.errors.push(msg.params.args.map(a => a.value ?? a.description ?? '').join(' '));
      }
      for (const l of this.listeners) l(msg);
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const w of this.pending.values()) w.reject(new Error('页面调试连接已断开（窗口可能被关闭或重启了）'));
      this.pending.clear();
    });
    this.send('Runtime.enable').catch(() => {});
    this.send('Page.enable').catch(() => {});
  }

  send(method, params = {}, timeout = 30000) {
    if (this.closed) return Promise.reject(new Error('页面调试连接已断开'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`浏览器协议超时（${method}，${timeout / 1000} 秒）。窗口可能被系统对话框卡住了`));
      }, timeout);
      this.pending.set(id, {
        resolve: v => (clearTimeout(timer), resolve(v)),
        reject: e => (clearTimeout(timer), reject(e)),
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // 执行脚本。expr 可以是字符串表达式，或函数（可带 JSON 能表示的参数）。会等 Promise。
  async evaluate(expr, ...args) {
    const expression = typeof expr === 'function' ? `(${expr})(...${JSON.stringify(args)})` : expr;
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(`页面脚本出错：${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    }
    return r.result.value;
  }

  // 反复执行 fn（页面里的函数或表达式），返回真值就结束；超时抛错。
  async waitUntil(what, expr, { timeout = DEFAULT_TIMEOUT, interval = 200 } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(expr);
        if (last) return last;
      } catch (e) {
        if (this.closed) throw e;
      }
      await sleep(interval);
    }
    throw new Error(`等待超时（${Math.round(timeout / 1000)} 秒）：${what}`);
  }

  waitFor(selector, { timeout = DEFAULT_TIMEOUT, visible = true } = {}) {
    const s = JSON.stringify(selector);
    return this.waitUntil(
      `元素出现：${selector}`,
      `(() => { const e = document.querySelector(${s}); if (!e) return false; if (!${visible}) return true; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`,
      { timeout },
    );
  }

  // 冷启动时 Vite 还在预构建依赖，页面可能先是空白。等不到元素就刷新页面再等，最多 attempts 次。
  async waitReady(selector = 'button', { attempts = 4, timeout = 20000 } = {}) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await this.waitFor(selector, { timeout });
      } catch (e) {
        lastErr = e;
        if (this.closed) throw e;
        console.log(`提示：第 ${i}/${attempts} 次没等到「${selector}」（页面可能还空白），刷新重试`);
        if (i < attempts) await this.reload().catch(() => {});
      }
    }
    throw new Error(`刷新了 ${attempts} 次页面仍是空白：${lastErr.message}`);
  }

  // text 可以是字符串，或「几种说法任一个」的数组（界面可能是中文或英文）。
  async waitText(text, { timeout = DEFAULT_TIMEOUT } = {}) {
    const list = JSON.stringify([].concat(text));
    return this.waitUntil(`页面出现文字「${[].concat(text).join('」或「')}」`, `(() => { const t = document.body.innerText; return ${list}.some(x => t.includes(x)) && t; })()`, { timeout });
  }

  async waitTextGone(text, { timeout = DEFAULT_TIMEOUT } = {}) {
    await this.waitUntil(`页面上「${text}」消失`, `!document.body.innerText.includes(${JSON.stringify(text)})`, { timeout });
  }

  text(selector = 'body') {
    return this.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('找不到元素：' + ${JSON.stringify(selector)}); return e.innerText; })()`);
  }

  // 用真实鼠标事件点元素中心（会先滚动到可见处）。
  async click(selector, { timeout = DEFAULT_TIMEOUT } = {}) {
    await this.waitFor(selector, { timeout });
    const box = await this.evaluate(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      e.scrollIntoView({ block: 'center', inline: 'center' });
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await this.mouseClick(box.x, box.y);
  }

  // 按文字点：在 selector（默认按钮类）里找文字完全等于 text 的元素；exact:false 为包含。
  async clickText(text, { selector = 'button, [role=button], a, [role=tab], label', exact = true, timeout = DEFAULT_TIMEOUT } = {}) {
    const mark = 'data-es-e2e-target';
    await this.waitUntil(
      `可点击的「${[].concat(text).join('」或「')}」（${selector}）`,
      `(() => {
        document.querySelectorAll('[${mark}]').forEach(e => e.removeAttribute('${mark}'));
        const wants = ${JSON.stringify([].concat(text))};
        const hit = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => {
          const t = (e.innerText || e.textContent || '').trim();
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && wants.some(want => (${exact} ? t === want : t.includes(want)));
        });
        if (!hit) return false;
        hit.setAttribute('${mark}', '1');
        return true;
      })()`,
      { timeout },
    );
    try {
      await this.click(`[${mark}]`, { timeout: 3000 });
    } finally {
      await this.evaluate(`document.querySelectorAll('[${mark}]').forEach(e => e.removeAttribute('${mark}'))`).catch(() => {});
    }
  }

  async mouseClick(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  // 清空输入框并输入文字（真实的输入事件，React 能收到）。
  async type(selector, text, { timeout = DEFAULT_TIMEOUT } = {}) {
    await this.waitFor(selector, { timeout });
    await this.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); e.select && e.select(); })()`);
    if (text === '') await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    else await this.send('Input.insertText', { text });
  }

  // 整页截图（默认含滚动区域）。返回文件路径。
  async screenshot(file, { full = true } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, fromSurface: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(`[cdp] 截图 ${file}`);
    return file;
  }

  // 改视口大小，比如窄屏 390×844；setViewport() 不带参数则恢复。
  async setViewport(width, height, { mobile = true, dpr = 2 } = {}) {
    if (!width) {
      await this.send('Emulation.clearDeviceMetricsOverride');
      return;
    }
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
    await sleep(400);
  }

  // 刷新页面并等加载完、<body> 里有内容。
  async reload({ timeout = 30000 } = {}) {
    const loaded = this.once('Page.loadEventFired', timeout, '页面重新加载完成');
    await this.send('Page.reload', { ignoreCache: true });
    await loaded;
    await this.waitUntil('刷新后页面有内容', `document.readyState === 'complete' && document.body && document.body.innerText.trim().length > 0`, { timeout });
  }

  // 等一个协议事件。先调用 once() 拿到 promise，再触发动作，最后 await。
  once(method, timeout = DEFAULT_TIMEOUT, what = method) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(fn);
        reject(new Error(`等待超时（${Math.round(timeout / 1000)} 秒）：${what}`));
      }, timeout);
      const fn = msg => {
        if (msg.method !== method) return;
        clearTimeout(timer);
        this.listeners.delete(fn);
        resolve(msg.params);
      };
      this.listeners.add(fn);
    });
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}
