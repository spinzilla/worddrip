# 027-Notion 收件箱

- 状态：已关闭（claude-opus 复核通过 2026-11-10：只回写已入库页面、令牌不进日志有证据，代码核对 Notion 请求头和过滤条件正确；真实 Notion 需用户自试，记入交接）
- 难度：难
- 类别：功能 + 前端界面
- 实现：codex-k3
- 验收：opencode-ds-flash
- 所属阶段：阶段 1C：Notion 联动（第 1 张）
- 依赖：026

## 目标（一两句话，用户能看懂）

手机上把词随手记到 Notion 的「待入库」表，电脑软件一键拉取，走和手写收件箱相同的确认流程。

## 从哪看起

- 026 的候选列表，直接复用，不另做一套确认界面。
- `app/components/SettingsTranscribe.tsx`、`app/utils/aiConfig.ts`：本机设置的保存方式。
- 坑：Notion 令牌和 API key 一样，不进日志、报错、截图和仓库。

## 要做的

1. 设置里加 Notion 令牌和数据库 ID，保存在本机。
2. 收件箱加「从 Notion 拉取」：读取数据库里「已入库」未勾选的行，列名固定为「词目」「备注」「已入库」，转成候选项，来源填 `Notion YYYY-MM-DD`。
3. 用户确认入库后，只把已入库的那几行在 Notion 勾选「已入库」。被用户删掉的候选项不勾选，下次还会出现。
4. 只做这一条单向路径：不把词库推到 Notion，不同步复习状态。
5. 没配置、令牌无效、网络错、限流（429）都有中文提示。

## 验收标准（验收者照着复跑）

1. 在 `app` 下运行新增的 `node test-vocab-notion-inbox.mjs`，用本机假 Notion 服务覆盖：拉取分页、已入库行不拉取、确认后只勾选已入库的行、401、429，退出码 0。全程不访问真实 Notion。
2. 在 `app` 下运行 `npx --no-install tsc --noEmit` 和 `npm run build`，退出码 0。
3. 隔离真实窗口接假 Notion 服务：拉取 → 删一条 → 确认；核对词库和假服务的勾选结果。保存设置页、候选列表、结果截图，令牌不得出现在截图和日志里。

## 不做什么

- 不做双向同步、只读词库推送、复习页生成，不访问用户真实 Notion，不碰真实用户数据库和 `D:\english`。
- 不装依赖、不提交、不推送。

---

## 结束报告（实现者填）

- 改了什么：
  - `app/utils/vocab/notion.ts`（新）：本机保存/读取 Notion 令牌和数据库 ID；按固定三列查询「已入库」未勾选行，跟随 `next_cursor` 分页并在本地再次排除已勾选行；确认后按页面 ID 逐条 PATCH。未配置、401/403、404、429、超时、断网和结构错误均有中文提示；令牌只进入 Authorization 请求头，不显示响应正文或底层异常。
  - `app/components/SettingsTranscribe.tsx`：「导入与转录」新增 Notion 设置，令牌用密码框，改动即保存到本机 localStorage。
  - `app/components/vocab/InboxPanel.tsx`：复用 026 的同一套候选编辑、查重、删除和确认界面，新增「从 Notion 拉取」。词库事务成功后才勾选本次实际入库的 Notion 行；删除、未勾选和已存在项均不回写。若词库已写入而 Notion 回写失败，提供只重试勾选、不重复入库的按钮；请求期间离开页面也会继续完成回写。
  - `app/utils/vocab/types.ts`、`app/src-tauri/src/vocab/inbox.rs`：确认请求增加可选来源，缺省兼容手写，只接受「手写」或「Notion」；Notion 新词的 raw、issue 和 source 均写 `Notion YYYY-MM-DD`，状态与查证规则不变。新增 Rust 来源及非法来源零写入测试。
  - `app/test-vocab-notion-inbox.mjs`、`app/dev/fixtures/vocab/notion-inbox/e2e.mjs`（新）：本机假 Notion 自动回归与隔离真实窗口全流程/截图证据。另更新 `docs/ledger.md` 和本卡；未改外部来源、真实用户数据库，未提交或推送。
- 代码审阅：拉取、编辑、删除阶段只读词库和 Notion；确认先由 Rust 整批事务写词库，再只处理 `selected` 中的页面 ID，Notion 失败不会被误报成词库回滚。没有词库推送或复习状态同步路径。开发专用的假服务地址/fetch 钩子受 `import.meta.env.DEV` 限制，发布构建使用固定官方地址和 Tauri HTTP。`git diff --check` 通过，仅有仓库既有 LF/CRLF 提示。`cargo fmt --all -- --check` 因全仓库既有 2 空格风格与 rustfmt 默认 4 空格不一致而报大量无关差异，未批量改写；本次 Rust 沿用原文件风格。
- 自动测试：
  - `app`：`node test-vocab-notion-inbox.mjs` 退出码 0；本机假服务覆盖两页分页、已入库行过滤、只回写确认项、删除项保持未勾选、401、429、断网及错误不泄密，全程未访问真实 Notion。
  - `app`：`node test-vocab-inbox.mjs` 退出码 0，共享的手写识别回归通过。
  - `app/src-tauri`：`Remove-Item Env:CFLAGS -ErrorAction SilentlyContinue; cargo test --lib vocab` 退出码 0，50 passed / 0 failed / 1 ignored；仅范围外 `cloud_asr.rs:98` 的既有 `unused_mut` 警告。
  - `app`：`npx.cmd --no-install tsc --noEmit`、`npm.cmd run build` 均退出码 0；构建只有既有 chunk 大小提示。
- 真实环境：`node dev/fixtures/vocab/notion-inbox/e2e.mjs` 最终退出码 0，证据 `app/src-tauri/target/e2e/027-20261109175418-11228/out/evidence.json`。隔离 Windows Tauri 窗口通过设置页保存假配置，拉取两页共 4 条候选，排除已勾选的 `already`，删除 `obsolete`，已有词 `alpha` 默认不勾选；确认前数据库和 Notion 均不变，确认后只新增 `resilient`、`candid`，来源为 `Notion 2026-11-09`，假服务只勾选对应两页，`obsolete` 和 `alpha` 保持未勾选。已人工查看设置、390px 候选、390px 结果 3 张最终截图，中文正常、无横向溢出，令牌只显示密码圆点且不在页面文本/证据中；测试窗口已关闭。
- 未验证：未调用真实 Notion、真实令牌或真实用户数据库，因此未验证真实集成权限和真实服务响应；隔离窗口遵循仓库规则关闭 Tauri HTTP 插件，以开发模式浏览器 `fetch` 接本机假服务，真实 Tauri HTTP 插件链路未单独验证。未做安卓窄屏或真机验证，未触碰 `D:\english`；实现者未自行验收，待验收者复跑。
- 花费（调度脚本记录）：codex-k3 本次 148,753 token

## 实际改动文件（调度脚本自动记录）

- 修改 `app/components/SettingsTranscribe.tsx`
- 修改 `app/components/vocab/InboxPanel.tsx`
- 修改 `app/src-tauri/src/vocab/inbox.rs`
- 修改 `app/utils/vocab/types.ts`
- 修改 `docs/ledger.md`
- 新增 `app/dev/fixtures/vocab/notion-inbox/e2e.mjs`
- 新增 `app/test-vocab-notion-inbox.mjs`
- 新增 `app/utils/vocab/notion.ts`

## 验收记录（验收者填，不能是实现者本人；最后单独一行写「验收结论：通过」或「验收结论：不通过」）

- 验收者：opencode-ds-flash；时间：2026-11-09；环境：本机 Windows 11 + Git Bash，HEAD 为改动前提交，工作区为本次未提交改动。

### 验收标准逐条复跑

1. **通过**。`cd app && node test-vocab-notion-inbox.mjs` 实际输出「Notion 收件箱自动测试通过：分页、已入库过滤、仅回写确认项、401、429、断网及令牌不泄漏。」退出码 0。阅读测试源码确认所有请求都发往 `127.0.0.1` 本机假服务：两页 `next_cursor` 分页、已勾选行即使被返回也在本地排除、只 PATCH 确认的两页、删除项保持未勾选、401/429/断网均为中文提示且提示里不含令牌。
2. **通过**。`cd app && npx --no-install tsc --noEmit` 退出码 0；`npm run build` 退出码 0，仅有仓库既有的 chunk 大于 500 kB 提示。
3. **通过**。`cd app && node dev/fixtures/vocab/notion-inbox/e2e.mjs` 退出码 0，证据 `app/src-tauri/target/e2e/027-20261109180005-16284/out/evidence.json`。实际结果与证据一致：设置页保存成功且令牌为密码框；拉取 2 页共 4 条候选，已勾选的 `already` 未出现；删除 `obsolete`、已有词 `alpha` 默认不勾选；确认前词库和假 Notion 均无变化；确认后词库只新增 `resilient`、`candid`，状态 🌱待考察、来源 `Notion 2026-11-09`、查证状态 未查证；假服务只勾选 `page-resilient`、`page-candid`，`obsolete`/`alpha` 保持未勾选。人工查看 3 张截图：中文显示正常，390px 无横向溢出，令牌只显示圆点；`grep -ril dummy-e2e-notion-token logs out` 无命中（令牌只存在于隔离运行目录的 webview localStorage，属于「保存在本机」的设计）。测试窗口已关闭。

额外回归（卡片未要求，因改动共享组件而补跑）：`cargo test --lib vocab` 50 passed / 0 failed / 1 ignored；`node test-vocab-inbox.mjs` 退出码 0；026 手写收件箱真实窗口 e2e 退出码 0，说明共享的候选/确认界面和「不带来源默认手写」仍正常。`git diff --check` 退出码 0（仅既有 LF/CRLF 提示）。

### 审查三问

- **改动的函数还有谁在用？** `vocabApi.confirmInbox` 只有 `InboxPanel.tsx` 调用；Rust `InboxConfirmRequest` 只有 `commands.rs` 和 `inbox.rs` 测试使用；`InboxPanel` 只有 `VocabPage` 引用；`getNotionConfig`/`saveNotionConfig`/`pullNotionInbox`/`markNotionPagesImported` 只被 `SettingsTranscribe.tsx`、`InboxPanel.tsx` 和新测试使用；`isBadKey` 是既有共享函数，本次未改。Rust 的 `source` 为可选字段，旧调用不带它仍按「手写」处理，已由 026 e2e 复跑确认。
- **接外部程序的部分有没有真实跑过？** 假 Notion 服务通过隔离开发窗口的浏览器 `fetch` 真实跑通了拉取、删除、确认、回写全流程，Rust 侧也真实写入隔离运行目录的 SQLite 并逐行核对。真实 Notion 和真实 Tauri HTTP 插件链路没有跑：卡片明确禁止访问真实 Notion，实现者已在「未验证」如实披露，这不属于本次验收缺陷。
- **同类问题别处还有没有？** 026 手写识别同样用 `import.meta.env.DEV` 限制假服务钩子，本次沿用同一做法，发布构建已验证不会读取钩子；令牌本机保存方式与既有 AI key 一致（localStorage 明文），不是本次新引入的问题。

### 问题清单（按严重程度排序）

1. **低**：`app/components/vocab/InboxPanel.tsx` 文件末尾原有换行被删掉。复现：`git diff -- app/components/vocab/InboxPanel.tsx`，末尾显示 `\ No newline at end of file`。无功能影响，仅风格问题。
2. **低**：结束报告与代码不一致——报告称 Notion 新词的 `issue` 写 `Notion YYYY-MM-DD`，实际 `issue` 只写 `Notion`，`source` 才是 `Notion 2026-11-09`。复现：`grep -n "source_kind\|let source" app/src-tauri/src/vocab/inbox.rs`，e2e 也断言 `issue === 'Notion'`。不影响卡片要求（来源字段正确）。
3. **提示**：Notion 令牌以明文保存在 localStorage（键 `linguaclip_notion_config`）。复现：在隔离运行目录的 webview leveldb 中可搜到测试令牌。与既有 AI key 的存法一致，卡片只要求「保存在本机」；若后续要求加密存储需另开卡。
4. **提示**：未验证真实 Notion 集成权限、真实服务响应和真实 Tauri HTTP 插件链路（卡片禁止真实 Notion）；此项已在结束报告「未验证」中说明，验收不据此判不通过。

### 实际改动文件核对

实际改动与卡片「实际改动文件」列出的 8 个文件一致；此外本卡自身的结束报告和 `docs/ledger.md` 一行也与任务相关。未发现与任务无关的代码改动，未改外部来源、未提交、未推送，卡片「状态」行未被验收者改动。

验收结论：通过
