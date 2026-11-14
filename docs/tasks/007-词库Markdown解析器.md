# 007-词库 Markdown 解析器（学术升级库 + 复习库）

- 状态：已关闭（Claude 复核通过 2026-11-04）
- 难度：体力（解析规则已由 005 调研写清；ID 规则由 Claude 在本卡定死）
- 实现：dsh-k3
- 验收：dsh-flash （原定 codex-astra，其转发接口 429/502 不可用，2026-11-04 改）
- 所属阶段：阶段 1（词库模块）
- 依赖：005（已关闭）

## 目标（一两句话，用户能看懂）

写一个只读不写的解析器：把 Hermes 的「学术升级库.md」「词汇复习库.md」读成结构化数据，并报告解析中发现的问题。它是后面「导入数据库」的第一步，本身不碰数据库、不碰界面。

## 背景（先读）

- `docs/vocab-data-model.md` 第 1 节（字段、计数、样例）、第 2.1–2.2 节（Hermes 生成器的解析规则）、第 2.4 节（容易解析错的地方）、第 5.4 节（拍板）。
- 测试写法照抄 `app/test-sections.mjs`：用 esbuild 把 `.ts` 打包到临时目录再 `loadFile` 加载。

## 要做的

1. 新建 `app/utils/vocab/parse.ts`，导出两个**纯函数**（输入 Markdown 字符串，不读文件、不访问网络、不依赖浏览器 API）：
   - `parseUpgradeLibrary(md: string)` → `{ entries, selfChecks, warnings }`
   - `parseReviewLibrary(md: string)` → `{ words, warnings }`
2. 新建 `app/utils/vocab/types.ts` 放类型。字段（全部必填，缺就给空字符串）：
   - `UpgradeEntry`：`id`、`line`（源文件行号，从 1 起）、`raw`（原始整行，原样）、`plain`（日常/口语）、`upgrade`（学术升级，去掉 `**`）、`examples: { cand, sentence, ai }[]`、`source`（出处）、`note`（备注）
     - `examples`：例句列按 `⧉` 分段，每段用「第一个**半角**冒号加空格」切成候选词和句子；句尾 `(AI)` → `ai: true`，并从 `sentence` 里去掉这个标记。切不开的段落保留为 `{ cand: '', sentence: 原文, ai }` 并记一条 warning。
   - `SelfCheck`：`id`、`line`、`raw`、`text`（「写作自查对照」下的无序列表项，去掉开头的 `- `）
   - `ReviewWord`：`id`、`line`、`raw`、`word`、`issue`（期号）、`addedAt`（入库日期）、`status`（原样，如 `🌱待考察`、`L2`）、`level`（状态是 `L1`–`L4` 时为 1–4，否则 `null`）、`due`（下次到期；`—` 转成空字符串）、`note`
3. **稳定 ID 规则（必须照做）**：
   - 升级库：`up:` + 规范化的「日常/口语」+ `#` + 同名出现序号（从 1 起）。
   - 自查：`sc:` + 在列表中的序号（从 1 起）。
   - 复习库：`rv:` + 规范化的单词 + `@` + 期号 + `#` + 同「单词+期号」出现序号（从 1 起）。
   - 「规范化」= 去掉首尾空白、转小写、连续空白压成一个空格。
   - 理由：改备注、挪行不会改变 ID；同词多行（复习库有 6 组）也不会撞。
4. warnings：每条是 `{ line, kind, message }`。至少覆盖：列数不对的行（`kind: 'columns'`，该行跳过不收）、复习库里的未知状态（`'status'`）、例句段切不开（`'example'`）、复习库同词多行（`'duplicate'`，**不跳过，照收**）。
5. 新建 `app/dev/fixtures/vocab/` 下的两个小样本文件（从真实文件里各摘 6–10 行，必须包含：一条多段例句、一条 `(AI)` 例句、一行列数不对的坏行、一组重复单词、一个 L 级状态和一个 `—` 到期日），以及 `app/test-vocab-parse.mjs` 用 `node:assert/strict` 测上面每一条规则。
6. 新建 `app/dev/vocab-count.mjs`：参数是两个 Markdown 路径，**只读**，用解析器解析后打印计数（见验收标准 3）。

## 允许改动的路径

- `app/utils/vocab/parse.ts`（新建）
- `app/utils/vocab/types.ts`（新建）
- `app/test-vocab-parse.mjs`（新建）
- `app/dev/vocab-count.mjs`（新建）
- `app/dev/fixtures/vocab/**`（新建）
- 本卡片

**只读**：`D:\Hermes\english\` 下的所有文件（只能读，绝对不能写、不能运行其中的脚本）。

## 验收标准（验收者照着复跑）

1. `cd app && node test-vocab-parse.mjs` 退出码 0。
2. `cd app && npm run check`：自检脚本数变成 29，新增的 `test-vocab-parse.mjs` 通过；失败的只能是 `test-wordvoice.mjs` 一个（缺 Playwright，已知问题）。
3. 用真实数据核对计数：`cd app && node dev/vocab-count.mjs "D:\Hermes\english\词汇\学术升级库.md" "D:\Hermes\english\词汇复习库.md"`，输出必须包含：升级库 78 条、自查 6 条、复习库 486 行、不同单词（规范化后）480 个、L1–L4 合计 32 行、`duplicate` 警告覆盖 6 组词（shrink、shatter、decline、surpass、fault、extend）、所有 ID 互不重复。数字与 `docs/vocab-data-model.md` 第 1 节一致。
4. 抽 3 条真实记录核对：`docs/vocab-data-model.md` 第 1.1、1.2 节里的 `comprise`、`hook`、`agenda` 三条样例，解析出的各字段与原文一致（`raw` 逐字相同）。验收者自己写一次性脚本核对即可，脚本放 `D:\tmp\`，不进仓库。
5. `parse.ts` 里没有任何 I/O 或浏览器依赖：`grep -nE "from 'node:|require\(|fetch\(|window\.|document\.|localStorage" app/utils/vocab/parse.ts` 输出为空。
6. 改动只在允许路径内；`D:\Hermes\english\` 下文件未被修改。

## 不做什么

- 不解析错误档案、口语栏、每日表达、GD（以后另开卡）。
- 不建数据库、不写 Rust、不做界面、不改 `package.json`。
- 不复用或运行 `build_vocab_page.py`，不复刻它的 `INHERIT` / `NEW_TK` / `F_ALIAS` 分类映射（那些属于页面展示，以后另议）。

## 预估

两个纯函数 + 类型 + 一个测试 + 一个计数脚本，30 分钟内可完成。

---

## 结束报告（实现者填）

- 改了什么：新增 `app/utils/vocab/types.ts` 与 `parse.ts`，实现升级库、自查、复习库纯解析，保留行号和 raw，生成稳定 ID，并报告列数、未知状态、坏例句和重复词警告；新增两个真实摘录 fixture、`app/test-vocab-parse.mjs` 及只读计数脚本 `app/dev/vocab-count.mjs`。
- 代码审阅：两个解析函数仅接收 Markdown 字符串，无文件、网络或浏览器 API；规定依赖扫描无匹配。表格严格核对 5/6 列，坏行跳过，重复词保留；例句按 `⧉` 和第一个 `: ` 拆分并移除句尾 `(AI)`。改动均在卡片允许路径内，未改状态行、外部来源或其他仓库文件。
- 自动测试：`cd app && node test-vocab-parse.mjs` 退出码 0；`npm run check` 类型检查通过并发现 29 个自检脚本，其中 28 个通过（含新增脚本），仅既知 `test-wordvoice.mjs` 因缺 Playwright 失败，未安装依赖绕过。
- 真实环境：只读运行计数脚本核对真实文件，得到升级库 78 条、自查 6 条、复习库 486 行、规范化不同单词 480 个、L1–L4 共 32 行；6 条 duplicate 警告覆盖 shatter、fault、surpass、shrink、decline、extend，570 个 ID 全部唯一。另抽取 comprise、hook、agenda，逐字段及 raw 对照源文件第 11、21、191 行一致。
- 未验证：实现者未自行验收，留待 codex-astra 复跑；`test-wordvoice.mjs` 的 Playwright 环境仍未验证。数据库、界面和外部源写入均不在本卡范围，未做。

## 验收记录（验收者填，不能是实现者本人；最后单独一行写「验收结论：通过」或「验收结论：不通过」）

### 第 1 轮 @dsh-flash 2026-11-04

环境：Windows 11，Node v24.20.0；工作区 HEAD = 05ffd73（本次改动未提交）。所有命令都在 `D:\english-studio\app` 下跑。

**验收标准 1：通过。**
命令 `node test-vocab-parse.mjs`，实际输出 `vocab parse: all checks passed`，退出码 0。
强度抽查：把 `parse.ts` 第 154 行的 `[1-4]` 临时改成 `[1-5]`，测试在第 117 行报 `AssertionError: 5 !== null`、退出码 1，说明断言不是空转；随后用改动前的备份还原，SHA256 与改动前一致（`B472B8EF…DCD0A46`），再跑退出码 0。

**验收标准 2：通过。**
命令 `npm run check`，实际输出：`类型检查通过，开始跑 29 个自检脚本`、`[19/29] 通过 test-vocab-parse.mjs`，失败只有 `test-wordvoice.mjs`（`Playwright missing: run node dev/e2e/run.mjs once`），结尾 `自检未过：1/29 个脚本失败`。脚本总数 29 与卡片一致。

**验收标准 3：通过。**
命令 `node dev/vocab-count.mjs "D:\Hermes\english\词汇\学术升级库.md" "D:\Hermes\english\词汇复习库.md"`，实际输出逐字：

```text
升级库 78 条
自查 6 条
复习库 486 行
不同单词（规范化后）480 个
L1–L4 合计 32 行
duplicate 警告 6 条，覆盖 6 组词：shatter、fault、surpass、shrink、decline、extend
所有 ID 互不重复：是（共 570 个）
升级库警告 0 条；复习库警告 6 条
```

为防脚本自己数错，另写一次性脚本（`D:\tmp\verify-007.mjs`、`verify-007b.mjs`，不进仓库）绕开解析器手数原始文件：升级库表头在第 9 行、数据行 78（无列数异常行）、`- ` 列表项 6；复习库数据行 486（无列数异常行）、不同词目 480、L1–L4 32，状态分布 374/42/38/14/7/7/4 与 `docs/vocab-data-model.md` 第 1.2 节完全一致；重复词目恰是 shrink、shatter、decline、surpass、fault、extend 各 2 次；570 个 ID 全唯一。补查：真实升级库 151 个 `⧉` 段全部解析成例句（151 条，段数零丢失，句子都能在原文原样找到），`upgrade` 字段无残留 `**`；复习库 486 行 `raw` 与源文件对应行逐字相同，`—` 到期日 454 行全转成空字符串。

**验收标准 4：通过。**
用 `D:\tmp\verify-007.mjs` 解析真实文件后抽三条（脚本不进仓库）：
- `comprise`（源文件第 11 行）：`plain` = `be made up of`，id `up:be made up of#1`，line 11，`raw` 与源行逐字相同；`upgrade` = `comprise（不接 of）/ consist of / be composed of`，`source` = `AWL SL7`，`note` = `9.18 期`；例句 3 段，cand 为 comprise / consist of / be composed of，句尾 `(AI)` 已去掉且 `ai: true`。与 1.1 节样例一致。
- `hook`（源文件第 21 行）：id `rv:hook@8.25#1`，line 21，`raw` 逐字相同；`issue` `8.25`、`addedAt` `2026-10-14`、`status` `🌱待考察`、`level` `null`、`due` `''`（原文 `—`）、`note` 原样。与 1.2 节样例一致。
- `agenda`（源文件第 191 行）：id `rv:agenda@9.18#1`，line 191，`raw` 逐字相同；`status` `L4`、`level` 4、`due` `2026-11-11`、`note` 原样。与 1.2 节样例一致。

**验收标准 5：通过。**
命令 `grep -nE "from 'node:|require\(|fetch\(|window\.|document\.|localStorage" app/utils/vocab/parse.ts`（用 Git 自带 `C:\Program Files\Git\usr\bin\grep.exe`），实际无输出、退出码 1（无匹配）。文件里唯一的导入是 `import type … from './types'`。

**验收标准 6：通过。**
`git status --porcelain -uall` 只有：`docs/tasks/007-词库Markdown解析器.md`（M）+ `app/dev/fixtures/vocab/review.md`、`app/dev/fixtures/vocab/upgrade.md`、`app/dev/vocab-count.mjs`、`app/test-vocab-parse.mjs`、`app/utils/vocab/parse.ts`、`app/utils/vocab/types.ts`，全在允许路径内。
外部只读源未被改动：`D:\Hermes\english\词汇\学术升级库.md` 最后修改 2026/10/23 20:43、`词汇复习库.md` 2026/10/27 09:02，均早于本次改动；`词汇` 目录里没有今天新增或改动的文件。今天 12:49–12:51 被写的只有本仓库这几个新文件。卡片「状态」行改由调度脚本 `scripts/dispatch.mjs` 的 `setStatus` 写成「待验收 @dsh-flash」，「验收」栏改成 dsh-flash（卡片本身允许改），不算越界。

**问题清单（按严重程度）：**

没有阻断性问题，以下 4 条都是低优先，不影响本卡通过。

1. （低）`docs/ledger.md` 里没有 007 这一行。复现：`git diff -- docs/ledger.md` 为空。原因：本卡允许路径不含 ledger，按派工规则由调度脚本在通过后补写，不需要实现者改。
2. （低）自查小节只认 `## ` 结束，`### ` 子标题不会结束小节。复现：输入 `## 写作自查对照` → `- 第一条` → `### 用法` → `- 子标题下的项`，`selfChecks` 返回 `sc:1`、`sc:2`（实测，见 `D:\tmp\verify-007c.mjs`）。真实文件第 89–96 行只有平级列表，当前无影响。
3. （低）章节标题被改动时静默返回空结果且不报警告。复现：把输入里的 `## 总词库` 改成 `## 总词库（新）`，`parseReviewLibrary` 返回 `{"words":[],"warnings":[]}`（实测）。卡片要求的 warning 种类里没有「章节缺失」，不算违约，但导入前建议补一条。
4. （提示）升级库某行多出一列（6 列）时整行丢弃、只留 `columns` 警告。复现：`| a | **b** | x: y | s | n | extra |` → `entries: []` + `columns` 警告（实测）。卡片写的是「列数不对该行跳过」，实现符合卡片；只是与生成器「只取前 5 列」的口径不同，以后若真实表加列，数据会少一条而不是截断。

验收结论：通过
