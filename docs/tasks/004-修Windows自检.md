# 004-修复 Windows 上跑不了的自检脚本

- 状态：已关闭（有条件通过 @claude 2026-11-04，遗留 4 个失败转 006）
- 难度：体力
- 实现：dsh-k3
- 验收：codex-astra
- 所属阶段：阶段 0（技术债，建议排在阶段 1 之前）
- 依赖：无（003 的代码改动不影响本卡）

## 目标（一两句话，用户能看懂）

把上游那套 `npm run check`（类型检查 + 28 个自检脚本）在 Windows 上跑通，让以后每次改代码都有自动回归可跑。

## 现状与证据（2026-11-04 实测）

- 在 `app/` 下执行 `npm run check`，`tsc --noEmit` 通过，随后立刻失败：`此时不应有 f。`
  原因：脚本里是 bash 语法 `for f in test-*.mjs ...; do ... done`，npm 在 Windows 用 `cmd.exe` 跑，不认。
- 绕过 shell 直接 `node test-xxx.mjs`，28 个文件**全部**失败，报：
  `ERR_UNSUPPORTED_ESM_URL_SCHEME: Only URLs with a scheme in: file, data, and node are supported… Received protocol 'c:'`
  原因：每个脚本都用 `esbuild` 把 `.ts` 打包到 `os.tmpdir()`，再 `await import(out)`。macOS 下 `out` 是 `/var/folders/...`，Node 当路径处理；Windows 下是 `C:\Users\...`，被当成协议 `c:`。
- 已确认与 003 的改动无关：`cmp` 比对上游副本 `D:\tmp\es-downloads\LinguaClip\test-sections.mjs` 与本地文件**逐字节一致**。
- 规模：28 个文件（`test-*.mjs` 23 个、`pro/test-*.mjs` 3 个、`mobile/test-*.mjs` 4 个），全部用到 `tmpdir()`；动态 import 调用点 **33 处**（`test-dictionary.mjs` 最多，4 处）。

## 做法

1. **每个脚本加一个本地 helper**，把那 33 处 `await import(x)` 换成 `await loadFile(x)`：
   ```js
   import { pathToFileURL } from 'node:url';
   const loadFile = (p) => import(pathToFileURL(p).href);
   ```
   只替换"参数是变量"的调用；`import('node:fs')` 这类字面量保持原样。
2. **换掉 npm 脚本的 shell 依赖**：新增 `app/scripts/check.mjs`，用 Node 先跑 `tsc --noEmit`，再按 `test-*.mjs` / `pro/test-*.mjs` / `mobile/test-*.mjs` 逐个 `spawnSync(process.execPath, [file])` 收集结果，任一失败即非 0 退出并打印文件名。`package.json` 的 `check` 改为 `node scripts/check.mjs`。
3. 跑一遍，确认 28 个全绿。

## 允许改动的路径

- `app/test-*.mjs`、`app/pro/test-*.mjs`、`app/mobile/test-*.mjs`
- `app/package.json`（只改 `scripts.check` 这一行）
- `app/scripts/check.mjs`（新建）
- 本卡片

## 验收标准（验收者照着复跑）

1. 在 `app/` 下 `npm run check`，Windows 上退出码 0，最后打印自检通过。
2. 统计输出：跑到的脚本数 = 28（不是 0，也不是中途退出）。
3. 故意让一个断言失败（例如临时改 `test-sections.mjs` 的一个 `assert.equal`），`npm run check` 必须非 0 退出并指名那个文件；改回来再跑一次恢复绿。
4. `git diff` 里每处改动只有 import 方式与 helper，**断言内容零改动**（用 `git diff -U0 | grep '^[-+]' | grep -v 'import\|loadFile\|pathToFileURL'` 应该只剩 package.json 那一行）。

## 不做什么

- 不改任何 `app/utils/**`、`components/**`、`src-tauri/**` 里的业务代码。
- 不调整断言逻辑、不删测试、不改测试覆盖范围。
- 不引入 jest/vitest 这类测试框架（现有脚本自带 assert，够用）。
- 不动上游的 `esbuild` 打包方式（只改产物怎么被 import 进来）。

## 预估

28 个文件、33 处替换都是机械操作 + 1 个新脚本，一个 agent 30 分钟内可完成并自测。

---

## 结束报告（实现者填）

- 改了什么：28 个测试脚本都加入 `pathToFileURL` / `loadFile`，替换 33 处 `await import(变量)`；另修正 `test-shortcuts.mjs` 带查询串的动态导入，保留缓存绕过语义。新增 `app/scripts/check.mjs`，先跑类型检查，再逐个运行并统计根目录、`pro/`、`mobile/` 的 28 个脚本；`package.json` 只改 `scripts.check`。断言内容零改动。
- 代码审阅：确认字面量 `import('node:fs')` 未改，临时改坏的 `test-sections.mjs` 断言已恢复；`git diff --check` 通过，过滤 import/helper 后只剩 `package.json` 的 check 行。新 runner 会跑完收集失败、指名文件并非 0 退出。
- 自动测试：在 Windows 11、Node v24.20.0 下运行 `npm run check`：类型检查通过，实际跑到 28 个，24 个通过，`test-dictionary.mjs`、`test-shortcuts.mjs`、`test-wordvoice.mjs`、`pro/test-license.mjs` 失败，整体退出码 1。故意把 sections 的 `1` 改成 `2` 后复跑，输出明确包含 `没过：node test-sections.mjs`，统计 5/28 失败并非 0 退出；恢复后复跑回到上述 4 个失败，sections 恢复通过。
- 真实环境：已验证 Windows 的 `cmd.exe` 不再执行 bash for 循环，24 个脚本能通过 file URL 正常加载临时产物；但整体验收尚未通过，不能称为全部跑通。
- 未验证：`test-wordvoice.mjs` 的 Chrome 页面解析部分未跑，本机没有 `~/.cache/linguaclip-e2e` 的 Playwright，也未发现已装 Chrome；遵守禁止安装软件，没有执行其安装命令。另外三项已定位但未越界修改：dictionary 在中文 Windows 的 Node `navigator.language=zh-CN` 下走了中文界面，license 的 `onLoad` 路径正则不匹配 Windows 反斜杠，shortcuts 生成临时入口时未转义 Windows 路径。需要策划决定：是否放宽本卡「只改 import/helper」限制以修这三处测试环境代码，以及是否允许安装 Playwright/Chrome（或另卡处理浏览器子测试）。

## 验收记录（验收者填，不能是实现者本人）

### 第 1 轮（自动调度）@codex-astra 2026-11-04 —— 无效

Codex 沙箱在本机无法启动子进程（`spawnSync git EPERM`），PowerShell 5.1 管道把中文转成 `???`，写本卡也失败（`Failed to write file`），没有写出结论。脚本据此判「验收无结论」并停下。属于验收环境问题，与实现无关。

### 第 2 轮 @claude 2026-11-04（Claude 不是本卡实现者）

1. `cd app && npm run check`：退出码 **1**。28 个脚本全部跑到，24 通过，4 失败：`test-dictionary.mjs`、`test-shortcuts.mjs`、`test-wordvoice.mjs`、`pro/test-license.mjs`。—— **未达标**，但失败原因不是本卡改动（见下）。
2. 跑到的脚本数 = 28。—— 通过。
3. 把 `test-sections.mjs` 第 26 行断言临时弄坏：退出码 1，输出 `没过：node test-sections.mjs`、`自检未过：5/28`；恢复后 sha1 与弄坏前一致。—— 通过。
4. `git diff -U0` 过滤 import/loadFile/pathToFileURL 后只剩 `package.json` 的 `check` 一行，断言零改动；改动全部在允许路径内。`test-shortcuts.mjs` 多改了一处带查询串的 `import(\`${out2}?${n++}\`)`，同属「改 import 方式」，接受。—— 通过。

问题清单：
- （中）4 个脚本仍失败。实现者给出的原因：dictionary 在中文 Windows 下 `navigator.language=zh-CN` 走了中文界面；license 的 `onLoad` 路径正则不认 Windows 反斜杠；shortcuts 生成临时入口时没转义 Windows 路径；wordvoice 需要 Playwright/Chrome，本机没有。这些都超出本卡「只改 import」的范围，原因由下一张卡核实，转 `006-修剩余4个Windows自检`。

结论：本卡目标（让 `npm run check` 在 Windows 上能跑、能指名失败文件）已达成，「28 个全绿」未达成并转卡处理。**有条件通过**，关闭。

验收结论：通过
