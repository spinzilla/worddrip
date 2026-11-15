# 真实窗口测试工具（e2e）

一句话：一条命令在**隔离的数据目录**里启动真实的 Windows Tauri 开发窗口，脚本能点页面、操作系统文件选择框（选文件 / 取消）、截图、切窄屏、重启、只读查数据库，最后**只关掉自己启动的进程**。以后改界面的卡（012～015 等）都用它验收。

工具都在 `app/dev/e2e/`（和旧的浏览器回归 `run.mjs` 等放在同一目录，互不影响）。

真实窗口回归中，`cdp.mjs` 默认替脚本跳过新手引导；`smoke.mjs` 特意关闭这个默认行为，并断言隔离空库启动时引导会出现。要测引导本身的脚本也必须传 `skipOnboarding: false`。

## 怎么跑冒烟脚本

```powershell
cd C:\workspace\english-studio\app
node dev/e2e/smoke.mjs
```

- 第一次要编译 Rust，可能几分钟（编译产物在 `D:\rust\target`，之后很快）；一次只开一个 tauri 构建，内存 8 GB 别同时开别的。
- 过程：隔离启动 → 主页截图 → 「添加视频」里点「选择本机视频」→ 在**真实系统对话框**点取消 → 再点一次、选 `tone.mp4` → 选字幕 `TEST_SUBTITLES.srt` → 切 390×844 窄屏截图 → 重启（同一数据目录）再截图 → 停止。
- 退出码 0 = 通过。截图和记录在 `D:\tmp\es-e2e\<运行编号>\out\`（`01-home.png` … `06-after-restart.png`，`smoke-result.json`）。失败时有 `99-failure.png`。
- 启动前 3000 端口（Vite）和调试端口（默认 9337）必须空闲，被占就直接报错退出，**不会去关别人的进程**。

## 隔离了哪些目录

运行目录 `D:\tmp\es-e2e\<运行编号>\`（可用环境变量 `ES_E2E_ROOT` 换根目录）：

| 子目录 | 作用 | 怎么隔离的 |
|---|---|---|
| `localappdata` | 应用数据（`com.englishstudio.app\vocab.db`、词典、组件） | 子进程的 `LOCALAPPDATA` |
| `appdata` | Roaming 数据 | 子进程的 `APPDATA` |
| `webview` | WebView2 数据（localStorage、IndexedDB） | `WEBVIEW2_USER_DATA_FOLDER` |
| `logs` | 应用日志 + `tauri-dev.log`（编译和运行输出） | `ES_LOG_DIR`（见下） |
| `tmp` | 临时文件 | 子进程的 `TEMP` / `TMP` |
| `out` | 截图和测试记录 | 脚本自己写 |
| `run.json` | 本次启动的进程记录（PID + 创建时间） | — |

**日志为什么要单独处理**：调试版的日志插件走系统 Known Folder，不读 `LOCALAPPDATA`。所以 `app/src-tauri/src/lib.rs` 里加了：调试版如果设了环境变量 `ES_LOG_DIR`，日志就写进那个目录；**没设时和以前完全一样**，发布版不受影响。

**http 插件为什么关掉**：`tauri-plugin-http` 启动时会把 `.cookies` 写到系统 Known Folder（改环境变量拦不住）。所以 `lib.rs` 里：调试版且设了 `ES_E2E_ISOLATE`（launch.mjs 自动设）时**不注册 http 插件**，没设时和以前完全一样，发布版永远注册。代价：测试窗口里前端的联网请求（词典、AI 等）会失败，测试不要依赖联网功能。

没隔离的（已知）：`~\Videos\english-studio`（应用存下载/字幕的目录，由 `USERPROFILE` 决定，没改）、Rust 编译产物之外的 npm 缓存其实**已隔离**（落在运行目录 `localappdata\npm-cache`）、Rust 编译产物 `D:\rust\target`（故意共用，省编译时间）。

## 在自己的卡里写验收脚本（最小例子）

把脚本放在 `app/dev/e2e/` 以外的地方也行（比如卡片的 scratch 目录），import 用绝对路径。例：

```js
import path from 'node:path';
import { start, restart, stop } from 'C:/workspace/english-studio/app/dev/e2e/launch.mjs';
import { connect } from 'C:/workspace/english-studio/app/dev/e2e/cdp.mjs';
import { chooseFile, cancelDialog } from 'C:/workspace/english-studio/app/dev/e2e/dialog.mjs';
import { openDb, countRows } from 'C:/workspace/english-studio/app/dev/e2e/db.mjs';

const s = await start();                       // 隔离启动，返回会话 s（s.out 是截图目录）
try {
  const page = await connect({ port: s.port });
  await page.clickText('词库');                  // 按文字点
  await page.clickText('选择文件');              // 这一下会弹系统文件对话框
  await chooseFile(s, 'D:\\tmp\\es-test\\a.md'); // 填路径并点「打开」；换成 cancelDialog(s) 就是点取消
  await page.waitText('校验通过');
  await page.screenshot(path.join(s.out, 'preview.png'));

  await page.setViewport(390, 844);              // 窄屏；setViewport() 恢复
  await page.screenshot(path.join(s.out, 'narrow.png'));
  await page.setViewport();

  const db = await openDb(s);                    // 只读打开隔离目录里的 vocab.db
  console.log('升级词条行数', countRows(db, 'upgrade_entry'));
  db.close();
} finally {
  await stop(s.runDir);                          // 一定要停；只会结束自己记录的进程
}
```

重启验证「数据还在」：`const s2 = await restart(s.runDir)`，再 `connect` 一次。

### 各模块可用的函数

- `launch.mjs`：`start({port, runId})`、`stop(runDir)`、`restart(runDir)`、`session(runDir)`、`ownProcesses(runDir)`；命令行 `node dev/e2e/launch.mjs start|stop|restart|status`（中途挂了可以手动 `stop <运行目录>` 清理）。
- `cdp.mjs`（`connect()` 返回的 page）：`waitFor(选择器)`、`waitText(文字)`、`waitTextGone`、`click(选择器)`、`clickText(文字, {exact, selector})`、`type(选择器, 文字)`、`text(选择器)`、`evaluate(函数或表达式, ...参数)`、`screenshot(文件)`、`setViewport(宽, 高)`、`reload()`、`errors`（页面里的报错）。点击用真实鼠标事件。所有等待默认 15 秒超时，报中文错误，可用 `{timeout: 毫秒}` 改。
- `dialog.mjs`：`waitDialog(s)`、`chooseFile(s, 文件)`、`cancelDialog(s)`。控制台会打印找到的对话框窗口句柄和所属 PID。
- `db.mjs`：`openDb(s)`、`countRows(db, 表)`、`queryRows(db, 表, 条件, 参数)`、`listTables(db)`；只读。

## 原理（出问题时看这里）

- 启动：`node_modules/@tauri-apps/cli/tauri.js dev`（`app` 目录，不复制仓库）。环境变量里去掉了 `CFLAGS`，并从注册表补齐 `RUSTUP_HOME` / `CARGO_HOME` / PATH。`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<端口>` 打开调试口，脚本用 Chrome DevTools Protocol 连。
- 停止：只结束 `run.json` 里记录的根进程及其后代（按「PID + 创建时间」确认，PID 被复用也不会误杀），再加命令行里带着本次 `webview` 目录的残留 WebView2 进程；结束后确认进程和端口都释放了。
- 窗口默认隐藏（2026-11-10 起）：launch.mjs 生成 `<运行目录>	auri-e2e-window.json`，用 `tauri dev --config` 把窗口设成 `visible: false`、`focus: false`、`skipTaskbar: true`，并给 WebView2 加 `--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding`，验收时不再弹窗打扰用户。截图、点击、窄屏、重启、文件对话框实测都正常（lookup、recall、grading、definition 四个脚本）。文件选择框仍会在屏幕上闪一下。想亲眼看窗口：设 `ES_E2E_SHOW_WINDOW=1`。Tauri 会忽略屏幕外的 x/y，所以不用「挪到屏幕外」的办法。
- 认进程：子进程必须比父进程晚创建才算（Windows 的父 PID 会被复用，曾把 csrss、wininit 误认成测试进程）；结束前再排除比根进程早创建的进程和系统核心进程。单测：`node test-e2e-proc.mjs`。
- 对话框：`dialog.ps1`（PowerShell + Win32）按**根进程的后代 PID** 找 `#32770` 对话框，填文件名框后给「打开」按钮发 `BM_CLICK`（取消同理）；找不到按钮才退回向这个对话框窗口发 `WM_COMMAND`。**永远不发全局按键**，所以前台焦点在哪都不影响。

## 已知限制

- 只做 Windows 桌面（Tauri 开发窗口），不做安卓、不做发布版安装包、没接 CI。
- 冒烟里「选字幕」一步依赖界面上有「选字幕文件」按钮，界面改名了这一步会被跳过（只打提示，不算失败）；其余步骤界面文字变了要改脚本。
- 对话框脚本假设系统「打开文件」对话框是标准的 Windows 通用对话框（Tauri 的 dialog 插件在 Windows 上就是）。
- 开着自己的 `npm run dev`（占 3000）时不能跑，需要先关掉。
- 单窗口、单页面：`connect` 取第一个网址含 `localhost:3000` 的页面。
