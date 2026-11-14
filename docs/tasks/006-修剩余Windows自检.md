# 006-修剩余 3 个在 Windows 上失败的自检脚本

- 状态：已关闭（Claude 复核通过 2026-11-04：复跑 npm run check 27/28，仅 wordvoice 失败）
- 难度：体力
- 实现：dsh-k3
- 验收：dsh-flash
- 所属阶段：阶段 0（技术债）
- 依赖：004（已关闭）

## 目标（一两句话，用户能看懂）

004 之后 `npm run check` 在 Windows 上能跑了，但还有 3 个自检因为「测试代码本身不认 Windows / 中文系统」而失败。把这 3 个修到通过，**不改它们检查的内容**。

## 现状与证据（2026-11-04，Claude 复跑 004 时实测）

`cd app && npm run check` → 28 个跑到，4 个失败。本卡处理其中 3 个（第 4 个 `test-wordvoice.mjs` 需要装 Playwright + Chrome，等用户决定，不在本卡）。004 实现者给出的原因（**未经核实，先复现再动手**）：

- `test-dictionary.mjs`：中文 Windows 下 Node 的 `navigator.language` 是 `zh-CN`，被测代码走了中文界面，断言按英文写的。
- `pro/test-license.mjs`：esbuild 插件 `onLoad` 的路径正则只认 `/`，Windows 路径是 `\`。
- `test-shortcuts.mjs`：生成临时入口文件时把 Windows 路径原样拼进 JS 字符串，反斜杠没转义。

## 做法

1. 逐个单跑 `node test-xxx.mjs`，看真实报错，确认原因。
2. 只修「测试脚手架」：环境变量/语言设置、路径正则、路径转义。例如在测试开头把 `navigator.language` 固定成测试预期的语言，正则写成同时认 `/` 和 `\`，拼路径用 `JSON.stringify(p)` 或先转成正斜杠。
3. 如果发现失败原因其实在被测的业务代码（`app/utils/**` 等）里，**不要改业务代码**，在结束报告写「需要策划决定：……」。

## 允许改动的路径

- `app/test-dictionary.mjs`
- `app/test-shortcuts.mjs`
- `app/pro/test-license.mjs`
- 本卡片

## 验收标准（验收者照着复跑）

1. `cd app && npm run check`：28 个都跑到；失败的只剩 `test-wordvoice.mjs` 一个（输出含 `自检未过：1/28`，且唯一的「没过」是 wordvoice）。
2. 单跑 `node test-dictionary.mjs`、`node test-shortcuts.mjs`、`node pro/test-license.mjs`，三个退出码都是 0。
3. 断言零改动：`git diff -U0 -- app | grep -E '^[-+]' | grep -vE '^(\+\+\+|---)' | grep -E 'assert'` 输出为空（不许改、删、加任何 assert 行）。
4. 改动只在上面 3 个测试文件里，没有动 `app/utils/**`、`app/components/**`、`app/src-tauri/**`。

## 不做什么

- 不改任何业务代码；不改断言；不删测试、不加「跳过」。
- 不处理 `test-wordvoice.mjs`，不安装 Playwright / Chrome / 任何软件。
- 不改 `app/scripts/check.mjs` 和 `package.json`。

## 预估

3 个文件，每个一两处脚手架改动，30 分钟内可完成并自测。

---

## 结束报告（实现者填）

- 改了什么：`test-dictionary.mjs` 在加载被测模块前把 `navigator.language` 固定为 `en-US`；`test-shortcuts.mjs` 用 `JSON.stringify` 生成临时入口里的模块路径；`pro/test-license.mjs` 的 `onLoad` 路径正则同时接受 `/` 和 `\`。未改业务代码、断言或测试数量。
- 代码审阅：逐文件核对差异，只有上述 3 处测试脚手架改动；`git diff --check` 通过；对 `git diff -U0 -- app` 的变更行检查 `assert`，结果为空。
- 自动测试：在 `app` 下单跑 `node test-dictionary.mjs`、`node test-shortcuts.mjs`、`node pro/test-license.mjs`，退出码均为 0；`npm run check` 跑到 28 个，27 个通过，唯一失败为 `test-wordvoice.mjs`，输出 `自检未过：1/28 个脚本失败`，符合本卡预期。
- 真实环境：在 Windows 本机用 `D:\nodejs\node.exe`（Node.js v24.20.0）及 `D:\nodejs\npm.cmd` 实际执行上述命令；修复前的 3 个原始失败均已复现，修复后对应脚本均通过。未改 UI，无需截图。
- 未验证：`test-wordvoice.mjs` 仍因本机缺 Playwright 而失败，本卡未安装依赖、未处理该脚本；Linux/macOS 未运行；最终验收留待 dsh-flash 独立复跑。

## 验收记录（验收者填，不能是实现者本人；最后单独一行写「验收结论：通过」或「验收结论：不通过」）

验收人：dsh-flash；环境：Windows 11 本机、`D:\nodejs\node.exe`（Node v24.20.0）；时间：2026-11-04。以下每条都是本轮实际复跑的输出，不引用实现者报告。

- 标准 1（`cd app && npm run check`）：**通过**。实测输出「类型检查通过，开始跑 28 个自检脚本」，`[1/28]`～`[28/28]` 全部出现；除 `test-wordvoice.mjs` 外全部「通过」；`test-wordvoice.mjs` 报 `AssertionError: Playwright missing: run node dev/e2e/run.mjs once`，末行「自检未过：1/28 个脚本失败」。整体退出码 1（由 wordvoice 一项引起，符合卡片预期）。
- 标准 2（单跑三个脚本）：**通过**。`node test-dictionary.mjs` → `test-dictionary: all passed` / `japanese dictionary ok`，退出码 0；`node test-shortcuts.mjs` → `shortcuts ok`，退出码 0；`node pro/test-license.mjs` → `test-license ok`，退出码 0（均在 `app` 目录下执行）。
- 标准 3（断言零改动）：**通过**。按卡片原命令用 Git 自带 `grep.exe` 执行 `git diff -U0 -- app | grep -E '^[-+]' | grep -vE '^(\+\+\+|---)' | grep -E 'assert'`，输出为空（末段 grep 退出码 1 = 无匹配）。变更行共 10 行，全是脚手架：license 的 onLoad 正则、dictionary 加的一行 navigator 固定、shortcuts 的临时入口路径拼装。
- 标准 4（改动范围）：**通过**。`git status --porcelain` 只有 4 条：本卡片 + `app/test-dictionary.mjs`、`app/test-shortcuts.mjs`、`app/pro/test-license.mjs`，无未跟踪文件；`git diff --name-only -- app/utils app/components app/src-tauri app/scripts app/package.json` 为空，业务代码、`check.mjs`、`package.json` 均未动。`git diff --check` 通过。
- 额外抽查（不在卡片四条内，供参考）：确认测试不是被「架空」才通过。做法是临时把 `test-dictionary.mjs` 里那行语言固定改成 `zh-CN` 后单跑，得到 `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal`、退出码 1，说明断言确实依赖语言结果。改回后按字节核验：SHA256 与改动前一致（`8092F712…E61803`），文件内容与实现交付状态逐字节相同。

问题清单（按严重程度排序，均为不阻塞项）：

1. 中｜语言分支自检覆盖缺口：`test-dictionary.mjs` 用一行把 `navigator.language` 固定成 `en-US`，中文界面分支从此在自检里完全没有覆盖，将来中文文案/逻辑回归自检查不出来。复现：`cd app`，把 `{ value: { language: 'en-US' } }` 改成 `'zh-CN'`，`node test-dictionary.mjs` → 报 `AssertionError: Expected values to be strictly deep-equal`（退出码 1）；说明原断言只写死了英文结果。这是卡片「做法 2」明确允许的做法，故不判不通过，但建议后续另开卡补一组 zh-CN 断言。
2. 低｜输出可读性：`npm run check` 失败项那行经 PowerShell 包装成 `NativeCommandError`，日志里「没过：node test-wordvoice.mjs」夹杂堆栈；判定要以末尾汇总行「自检未过：1/28 个脚本失败」为准。复现：`cd app && npm run check`，看 stderr 段。
3. 低｜平台未复跑：Linux/macOS 上这三处改动的效果（路径正则、JSON.stringify 转义）未验证；路径正则 `[\\/]` 与 `JSON.stringify` 在 POSIX 下理论上同样成立，但本轮只有 Windows 实测。

验收结论：通过
