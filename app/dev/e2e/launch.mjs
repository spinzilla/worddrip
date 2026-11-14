// 真实窗口测试：隔离启动 / 停止 / 重启 Tauri 开发窗口。说明见 docs/e2e.md。
//
//   node dev/e2e/launch.mjs start [--port 9337] [--run-id 名字]   启动，打印运行目录
//   node dev/e2e/launch.mjs stop <运行目录>                        只结束自己记录的进程
//   node dev/e2e/launch.mjs restart <运行目录>                     停了再用同一数据目录启动
//   node dev/e2e/launch.mjs status <运行目录>
//
// 也可以 import { start, stop, restart } 在自己的验收脚本里用。
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createdBefore, descendantsOf, portInUse, sleep, snapshot } from './proc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(here, '..', '..'); // 仓库的 app 目录
export const E2E_ROOT = process.env.ES_E2E_ROOT || 'D:\\tmp\\es-e2e';
export const DEV_PORT = 3000; // tauri.conf.json 的 devUrl
const log = (...a) => console.log('[launch]', ...a);
// 默认测试窗口不显示、不抢焦点、不进任务栏，免得验收时弹到用户面前。
// 想亲眼看窗口：设环境变量 ES_E2E_SHOW_WINDOW=1。截图和点击都走 CDP，窗口隐藏也照常工作（2026-11-10 实测）。
// 注：Tauri 会忽略屏幕外的 x/y（实测窗口仍落在默认位置），所以用隐藏而不是挪到屏幕外。
const SHOW_WINDOW = process.env.ES_E2E_SHOW_WINDOW === '1';

// 生成 tauri dev --config 用的覆盖文件。windows 是数组，合并时整段替换，所以从 tauri.conf.json 复制完整窗口对象再改。
function hiddenWindowConfig(p) {
  const conf = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const windows = (conf.app?.windows || []).map(w => ({ ...w, visible: false, focus: false, skipTaskbar: true }));
  const file = path.join(p.runDir, 'tauri-e2e-window.json');
  fs.writeFileSync(file, JSON.stringify({ app: { windows } }, null, 2));
  return file;
}

function runPaths(runDir) {
  const d = name => path.join(runDir, name);
  return {
    runDir,
    localappdata: d('localappdata'),
    appdata: d('appdata'),
    webview: d('webview'),
    logs: d('logs'),
    out: d('out'),
    tmp: d('tmp'),
    state: d('run.json'),
    // 词库数据库：app_data_dir() = %LOCALAPPDATA%\com.englishstudio.app
    appData: path.join(d('localappdata'), 'com.englishstudio.app'),
  };
}

// 从注册表补上旧进程里缺的用户环境变量（RUSTUP_HOME / CARGO_HOME / PATH）。
function registryEnv(key) {
  const vars = {};
  try {
    const text = execFileSync('reg', ['query', key], { encoding: 'utf8', windowsHide: true });
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/);
      if (m) vars[m[1]] = m[2];
    }
  } catch {
    /* 读不到就算了 */
  }
  return vars;
}
const expand = (s, env) => s.replace(/%([^%]+)%/g, (all, n) => env[n] ?? env[n.toUpperCase()] ?? all);

function buildEnv(p, port) {
  const env = { ...process.env };
  const user = registryEnv('HKCU\\Environment');
  const machine = registryEnv('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment');
  for (const k of ['RUSTUP_HOME', 'CARGO_HOME', 'CARGO_TARGET_DIR']) if (!env[k] && user[k]) env[k] = user[k];
  const have = new Set((env.Path || env.PATH || '').split(';').map(s => s.toLowerCase()));
  const extra = [];
  for (const src of [machine, user]) {
    for (const e of (src.Path || src.PATH || '').split(';')) {
      const x = expand(e, { ...env, ...user }).trim();
      if (x && !have.has(x.toLowerCase())) {
        have.add(x.toLowerCase());
        extra.push(x);
      }
    }
  }
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'Path';
  env[pathKey] = [env[pathKey], ...extra].filter(Boolean).join(';');
  // MSVC 编 ring 等依赖时遇到学 C 用的 CFLAGS 会报 D8021。
  delete env.CFLAGS;
  delete env.CXXFLAGS;
  // 隔离：应用数据、WebView 数据、日志、临时目录都放进运行目录。
  env.LOCALAPPDATA = p.localappdata;
  env.APPDATA = p.appdata;
  env.TEMP = p.tmp;
  env.TMP = p.tmp;
  env.WEBVIEW2_USER_DATA_FOLDER = p.webview;
  // 窗口隐藏时 WebView2 可能以为被遮住而停止渲染，截图变空白；这几个开关让它照常渲染。
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = [
    `--remote-debugging-port=${port}`,
    '--lang=zh-CN', // 应用按 navigator.language 选界面语言；本机系统是英文，不加这个脚本找不到中文按钮
    ...(SHOW_WINDOW ? [] : ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']),
  ].join(' ');
  env.ES_LOG_DIR = p.logs;
  env.ES_E2E_ISOLATE = '1'; // 调试版不注册 http 插件，避免它把 .cookies 写进真实目录
  return env;
}

function readState(runDir) {
  const file = runPaths(runDir).state;
  if (!fs.existsSync(file)) throw new Error(`找不到运行记录：${file}（这个运行目录不是 launch.mjs 建的？）`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeState(runDir, state) {
  fs.writeFileSync(runPaths(runDir).state, JSON.stringify(state, null, 2));
}

async function pageReady(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    const pages = await res.json();
    return pages.some(x => x.type === 'page' && String(x.url).includes(`localhost:${DEV_PORT}`));
  } catch {
    return false;
  }
}

// 启动。runDir 给了且已存在 => 沿用里面的数据（重启用）。返回会话对象。
export async function start({ port = 9337, runId, runDir, timeoutMs = Number(process.env.ES_E2E_TIMEOUT_MS) || 20 * 60 * 1000 } = {}) {
  runDir = runDir || path.join(E2E_ROOT, runId || new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + process.pid);
  const p = runPaths(runDir);
  for (const dir of [p.localappdata, p.appdata, p.webview, p.logs, p.out, p.tmp]) fs.mkdirSync(dir, { recursive: true });

  for (const [what, n] of [['前端开发服务（Vite）', DEV_PORT], ['WebView2 调试端口', port]]) {
    if (await portInUse(n)) {
      throw new Error(`端口 ${n} 已经被别的程序占用（${what}），为了不误伤别人的进程，不启动。请先自己确认并关掉占用者，或用 --port 换调试端口。`);
    }
  }

  const tauriJs = path.join(APP_DIR, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  if (!fs.existsSync(tauriJs)) throw new Error(`找不到 ${tauriJs}，请先在 app 目录运行 npm install。`);

  const logFile = path.join(p.logs, 'tauri-dev.log');
  const fd = fs.openSync(logFile, 'a');
  const devArgs = SHOW_WINDOW ? [] : ['--config', hiddenWindowConfig(p)];
  // 077：ES_E2E_EXTRA_CONFIG 指向一个 tauri 配置覆盖文件（例如把更新清单地址指到本机）；没设时和以前一样。
  if (process.env.ES_E2E_EXTRA_CONFIG) devArgs.push('--config', process.env.ES_E2E_EXTRA_CONFIG);
  const child = spawn(process.execPath, [tauriJs, 'dev', ...devArgs], {
    cwd: APP_DIR,
    env: buildEnv(p, port),
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    detached: true,
  });
  child.unref();
  const rootEntry = { pid: child.pid, ctime: null };
  log(`已启动 tauri dev（根进程 PID ${child.pid}），运行目录：${runDir}${SHOW_WINDOW ? '' : '；窗口隐藏、不抢焦点（要看窗口设 ES_E2E_SHOW_WINDOW=1）'}`);
  log(`日志：${logFile}；首次编译可能要几分钟`);

  const state = {
    runDir,
    port,
    startedAt: new Date().toISOString(),
    rootPid: child.pid,
    pids: [rootEntry],
    stoppedAt: null,
  };
  writeState(runDir, state);

  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    await sleep(2000);
    const snap = snapshot();
    const root = snap.find(x => x.pid === child.pid);
    if (!root) {
      throw new Error(`tauri dev 提前退出了，最后的日志：\n${tail(logFile)}`);
    }
    rootEntry.ctime = root.ctime;
    state.rootCtime = root.ctime;
    state.pids = descendantsOf([child.pid], snap).map(x => ({ pid: x.pid, ctime: x.ctime, name: x.name }));
    writeState(runDir, state);
    if (await pageReady(port)) {
      ready = true;
      break;
    }
  }
  if (!ready) {
    await stop(runDir).catch(() => {});
    throw new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒窗口还没起来（页面 localhost:${DEV_PORT} 没出现在调试端口 ${port}）。日志：\n${tail(logFile)}`);
  }
  log(`窗口已就绪，调试端口 ${port}`);
  return session(runDir);
}

function tail(file, n = 30) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-n).join('\n');
  } catch {
    return '(没有日志)';
  }
}

const NEVER_KILL = new Set(['system', 'idle', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe', 'svchost.exe', 'explorer.exe', 'dwm.exe', 'fontdrvhost.exe', 'memcompression']);

// 当前属于本次测试的进程：根进程的所有后代 + 记录里创建时间对得上的进程的后代，
// 再加上命令行里带着本次 WebView 数据目录的进程（孤儿 WebView2 子进程）。
export function ownProcesses(runDir, snap = snapshot()) {
  const state = readState(runDir);
  const p = runPaths(runDir);
  const roots = new Set();
  for (const r of state.pids) {
    const cur = snap.find(x => x.pid === r.pid);
    if (cur && (!r.ctime || cur.ctime === r.ctime)) roots.add(r.pid);
  }
  const result = new Map(descendantsOf([...roots], snap).map(x => [x.pid, x]));
  const marker = p.webview.toLowerCase();
  for (const x of snap) if (x.cmd && x.cmd.toLowerCase().includes(marker)) result.set(x.pid, x);
  // 兜底：比本次根进程还早创建的、或者是系统核心进程的，一律不算自己的，绝不结束。
  const root = state.rootCtime ? { ctime: state.rootCtime } : null;
  return [...result.values()].filter(x => !NEVER_KILL.has(String(x.name).toLowerCase()) && (!root || !createdBefore(x, root)));
}

export function session(runDir) {
  const state = readState(runDir);
  const p = runPaths(runDir);
  return { ...p, port: state.port, rootPid: state.rootPid, runDir, pids: () => ownProcesses(runDir).map(x => x.pid) };
}

export async function stop(runDir) {
  const state = readState(runDir);
  const mine = ownProcesses(runDir);
  if (mine.length) log(`结束本次测试的 ${mine.length} 个进程：${mine.map(x => `${x.name}(${x.pid})`).join(', ')}`);
  // 先杀最晚创建的（子孙），再杀祖先，避免祖先重启子进程。
  for (const x of [...mine].sort((a, b) => Number(BigInt(b.ctime) - BigInt(a.ctime)))) {
    try {
      execFileSync('taskkill', ['/PID', String(x.pid), '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* 已经没了 */
    }
  }
  // 等它们真的消失，且端口释放。
  const deadline = Date.now() + 20000;
  let left = [];
  while (Date.now() < deadline) {
    const alive = new Set(snapshot().map(x => x.pid + ':' + x.ctime));
    left = mine.filter(x => alive.has(x.pid + ':' + x.ctime));
    if (!left.length) break;
    await sleep(500);
  }
  if (left.length) throw new Error(`这些进程没能结束：${left.map(x => `${x.name}(${x.pid})`).join(', ')}`);
  for (const n of [DEV_PORT, state.port]) {
    for (let i = 0; i < 20 && (await portInUse(n)); i += 1) await sleep(500);
  }
  state.stoppedAt = new Date().toISOString();
  writeState(runDir, state);
  log('已全部结束');
}

export async function restart(runDir, opts = {}) {
  const state = readState(runDir);
  await stop(runDir);
  return start({ port: state.port, runDir, ...opts });
}

// ---- 命令行 ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = name => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  try {
    if (cmd === 'start') {
      const s = await start({ port: flag('--port') ? Number(flag('--port')) : undefined, runId: flag('--run-id') });
      console.log(s.runDir);
    } else if (cmd === 'stop') await stop(rest[0]);
    else if (cmd === 'restart') console.log((await restart(rest[0])).runDir);
    else if (cmd === 'status') {
      const s = session(rest[0]);
      console.log(JSON.stringify({ ...s, pids: s.pids() }, null, 2));
    } else {
      console.log('用法：node dev/e2e/launch.mjs start|stop|restart|status ...（见 docs/e2e.md）');
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('出错：' + e.message);
    process.exitCode = 1;
  }
}
