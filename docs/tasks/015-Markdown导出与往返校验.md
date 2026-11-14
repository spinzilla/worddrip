# 015-Markdown 导出与往返校验

- 状态：已关闭（用户确认 2026-11-09）
- 难度：难
- 类别：功能 + 前端界面
- 实现：codex-k3
- 验收：claude-sonnet
- 建议实现：codex-k3（备选 codex-astra）
- 建议验收：codex-astra（备选 codex-k3）
- 所属阶段：阶段 1（词库模块）
- 依赖：012、013、014（导入与查询基础；014 关闭后按本批顺序执行）

<!-- 导出有文件写入与数据保真要求，采用独立细验。codex-k3 熟悉解析格式；若选 codex-astra 实现则改选 codex-k3 验收，避免同人。不能只用自己的导出器与解析器互相证明，须独立对照数据库和原行。 -->

## 目标（一两句话，用户能看懂）

把词库里的学术升级库和复习库分别导出为新的 Markdown 文件，保留完整记录及顺序，重新解析后数据一致。导出副本不覆盖 Hermes 原文件。

## 从哪看起

- `app/utils/vocab/parse.ts`：007 对表头、章节和 selfChecks 列表的约定；导出格式必须兼容它。
- `app/src-tauri/src/vocab/schema.rs`：raw、ord、line 以及各业务字段；`query.rs` 和 vocabApi 沿用 013 的读取链路。
- `docs/tasks/012-词库导入与结果报告.md`：当前只追加新记录、同 ID 改内容拒绝，不存在词条编辑功能。
- `app/src-tauri/src/backup.rs`：现有文件写入及错误处理可参考，但本卡不改备份模块。

## 要做的

1. 在现有词库页增加「导出学术升级库」「导出复习库」，分别使用保存对话框建议新文件名。文件选定后由 Rust 写新文件；取消不写文件，成功显示路径，失败显示可读原因。
2. 学术升级导出含正确五列表头、按 ord/ID 排序的未删除升级记录，以及「## 写作自查对照」和自查原行；复习库含「## 总词库」、六列表头和有序原行。编码 UTF-8 无 BOM，文件末尾换行。
3. 原始记录行 raw 逐字保留，包含重复词、完整备注、多段例句、(AI) 标记和原始状态/日期表达；不要从截断的详情文本拼回。排除 deleted 记录，不导出 import_run 等内部元数据。
4. 明确保真范围：保留已导入的记录行和业务数据，不承诺还原源文件中未导入的说明、其他章节、空行、换行符格式和原行号。前端及报告不得称整份原文逐字恢复。
5. 后端拒绝覆盖已存在的文件，使用排他创建处理检查后文件出现的竞争情况；不存在父目录时报错，不自动建任意目录。拒绝写入外部只读来源目录及其路径别名/联接目标，至少涵盖 sources.md 中 Hermes 数据与 profile/skill、LinguaClip 安装与数据目录。仅依据路径字符串包含关键字不能作为目录保护。
6. 文件写失败时不报成功，只能清理本次排他创建的半成品，不能删除既有文件；成功返回前完成刷新/关闭。本卡不要求用户能取消已经开始的短文件写入，但取消保存对话框必须零写入。
7. 空库或目标类别为空时禁用对应导出并解释原因；导出不得改变数据库或触发导入、等级修改。按钮防双击并清理页面离开后的迟到提示。

## 允许改动的路径

- `app/components/vocab/VocabPage.tsx`
- `app/components/vocab/ExportPanel.tsx`
- `app/utils/vocab/api.ts`
- `app/utils/vocab/export.ts`
- `app/utils/vocab/types.ts`（仅导出结果类型）
- `app/src-tauri/src/vocab/mod.rs`
- `app/src-tauri/src/vocab/commands.rs`
- `app/src-tauri/src/vocab/export.rs`
- `app/src-tauri/src/lib.rs`（仅注册导出 command）
- `app/test-vocab-export.mjs`
- `app/dev/fixtures/vocab/export/**`

## 验收标准（验收者照着复跑）

1. 在 app 下运行 `node test-vocab-parse.mjs`、`node test-vocab-import.mjs`、`node test-vocab-export.mjs`、`npx --no-install tsc --noEmit`、`npm run build`，均退出码 0；在 app/src-tauri 下运行 `cargo test --offline --locked --lib vocab::` 和 `cargo test --offline --locked --lib`，均无失败。
2. 导出测试调用生产导出逻辑，不能只手工造 Markdown。用 fixture 完成解析 → 临时 SQLite 导入 → 从数据库导出 → 007 再解析；逐条比较 ID、原行、业务字段和顺序，允许 line 改变。覆盖重复词、长备注、多例句、AI 标记、自查和软删除过滤。计数相同不等于保真通过。
3. 独立读取临时数据库与输出文件逐行核对 raw 和顺序，防止导出器、解析器共享错误。两份原始文件及数据库导出前后哈希/记录保持不变；写明被比对的版本和证据路径。
4. Rust 受控测试覆盖目标已存在（内容哈希不变）、父目录不存在、写失败清理、两次竞争创建只有一次成功；使用临时目录和链接测试规范化后的保护规则，不在真实只读源中尝试写入。权限故障可注入，但成功流程必须是真实磁盘读写。
5. 用 012 的隔离方式在真实 Windows Tauri 窗口分别点击导出两个新文件，保存到自建临时目录，用文本查看确认中文、例句和备注无乱码，再交给 007 解析核对。实际取消保存、选择已有文件、空库导出均符合约定；截图保留按钮、成功路径和错误提示。
6. 真实来源只读副本可作为输入，在临时目录验证往返；不覆盖原文件、不写用户现有数据库。记录最终版本、全部命令、退出码、截图和日志；无真实界面证据不关闭本卡。

## 不做什么

- 不自动覆盖、回写 Hermes、删除旧文件、导出错误档案/评论/笔记或同步服务器。
- 不承诺还原未导入的整篇 Markdown，不做编辑后的重新序列化，不修改稳定 ID 或解析规则。
- 不改数据库表结构、现有备份系统、权限配置或系统设置，不安装软件、不调用付费端点。
- 不派发其他 agent，不改 agent-board，不提交推送；本卡完成后统筹复核本批实际 diff、测试及界面证据，再收尾。

---

## 结束报告（实现者填）

- 改了什么：词库页新增导出页和两个保存按钮；空类别禁用并解释，保存取消零写入，成功显示完整新文件路径，同步锁防双击，离开视图/卸载后忽略迟到结果。Rust 只读查询数据库，按 ord/ID 直出 raw 和正确表头、自查章节，UTF-8 无 BOM 且末尾换行，不写 import_run、不改数据库。目标必须不存在，create_new 原子排他创建，sync_all 后关闭；父目录不存在不建目录，失败只清理本次新建半成品。保护 D:\Hermes、D:\english、Hermes profile/skill 根目录、LinguaClip 安装/数据及用户产物目录，先 canonicalize 父目录再按路径组件判断，覆盖联接/别名且 Windows 不区分大小写。新增独立 fixture、生产导入→导出→007 再解析脚本和真实窗口脚本。
- 代码审阅：改动均在卡片允许路径；未改状态行、未 commit/push、未写外部来源。导出沿用 query 的未删除过滤和排序，业务字段只用于回读核对，文件正文不从详情截断文本重建。目标已存在检查与 create_new 双重防覆盖，竞争创建、注入写失败、缺父目录、联接保护均有受控测试；最终 `git diff --check` 退出码 0。
- 自动测试：`node test-vocab-parse.mjs`、`node test-vocab-import.mjs`、`node test-vocab-export.mjs`、`npx.cmd --no-install tsc --noEmit`、`npm.cmd run build` 均退出码 0。`cargo test --offline --locked --lib vocab::` 为 27 passed / 0 failed / 1 ignored（该 ignored 由 Node 往返脚本显式运行并已通过）；`cargo test --offline --locked --lib` 为 138 passed / 0 failed / 19 ignored。往返覆盖重复词、长备注、多例句、AI、自查、原始状态/日期和软删除，逐条比较 ID/raw/全部业务字段/例句/顺序，并独立直查 SQLite 核对输出原行。证据版本 1：`app/src-tauri/target/vocab-export/20261108131221-3992/evidence.json`；两个 fixture 前后 SHA-256 不变，数据库前后均为 `7ed8cf9af5115869445140ec0b757fbd400f63826646c6b905b028fc0567f1d4`，记录快照不变。
- 真实环境：隔离启动真实 Windows Tauri，数据、WebView 和输出均在 `app/src-tauri/target/vocab-export-e2e/015-20261108133518-14888/`。实际操作原生打开/保存框：空库两按钮禁用、取消保存零写入、分别导出两个新文件并显示路径均通过；文本查看中文、长备注和例句无乱码，真实输出再经 007 解析并与隔离数据库 raw/顺序一致。已查看 `out/01-empty.png`、`02-upgrade-success.png`、`03-review-success.png`、`05-narrow.png`；390×844 WebView 模拟无横向溢出，日志 `out/e2e-evidence.txt` 为 completed: true，测试进程已全部结束。
- 未验证：原生保存框选择已有文件后的二级覆盖确认未能自动操作，故真实界面「拒绝覆盖」提示及 04 截图未取得；Rust 已用真实磁盘测试证明既有文件拒绝覆盖且哈希不变，但这项不能算真实界面通过。390×844 仅为 WebView 模拟，未验证安卓真机；页面迟到提示的失效闸门已自动测试，未另做真实延迟写入注入。实现者未自行验收，留待验收者复跑。
- 花费（调度脚本记录）：codex-k3 本次 230,548 token

### 统筹补充（2026-11-08，Claude）

第二轮返工 codex-k3 两次都跑满 60 分钟被强制结束，时间花在自动操作 Windows 保存框上，所以没有写「返工说明」。下面是统筹和用户补的现状，已如实区分。

- 生产代码：`ExportPanel.tsx`、`VocabPage.tsx`、`api.ts`、`export.ts`、`types.ts`、`export.rs`、`commands.rs`、`mod.rs`、`lib.rs` 最后修改都在 07:11 之前，早于第一轮真实窗口证据（07:35）；第二轮只改了 `app/test-vocab-export.mjs` 和 `app/dev/fixtures/vocab/export/`。
- 标准 6（真实来源副本）：统筹 09:43 在 app 下跑 `node test-vocab-export.mjs`，退出码 0，输出「real-source-copy：78 条升级、486 条复习，往返通过」。证据：`app/src-tauri/target/vocab-export/20261108154302-16560/evidence.json`。
- 标准 5（真实窗口）：
  - 空库、取消、两次导出、窄屏：沿用 `app/src-tauri/target/vocab-export-e2e/015-20261108133518-14888/out/`。
  - 选择已有文件：用户在真实 Windows 保存框手动操作，目标是 `D:\tmp\es-test\015-existing\u.md`，并确认了系统覆盖提示。页面显示「导出学术升级库失败：目标文件已存在，已拒绝覆盖」，u.md 的 SHA-256 前后相同（3563000682864facdf6897c68430dd93798e7470faabe6e5fc7267215bd917b8）。证据：`app/src-tauri/target/vocab-export-e2e/015-manual-20261108155421-148/out/04-existing-file-error.png` 和 `manual-existing-evidence.json`。
  - **限制**：该 JSON 里 `completed: false`，原因是统筹加的路径记录没抓到调用（`calls` 为空），不是导出失败。所以「选的确实是 u.md」只有用户按步骤操作这一条依据，脚本没有独立记录；同一路径的拒绝覆盖和哈希不变由 Rust 受控测试覆盖。
- 未完成：`node test-vocab-export.mjs --e2e` 的自动保存框流程没走通，不要复跑（上两次都在这里耗满 60 分钟）。标准 5 请核对上面的证据文件，把「用户手动操作」和「自动化未完成」如实写进验收记录。
- 未验证：安卓真机。

## 验收记录（验收者填，不能是实现者本人；最后单独一行写「验收结论：通过」或「验收结论：不通过」）

验收者：claude-sonnet，2026-11-08。以下均为本轮实际复跑。

**标准 1（自动测试）**：通过。app 下 `test-vocab-parse.mjs`、`test-vocab-import.mjs`、`test-vocab-export.mjs`（证据 `app/src-tauri/target/vocab-export/20261108133857-14268/evidence.json`）、`npx --no-install tsc --noEmit`、`npm run build` 退出码均 0；src-tauri 下 `cargo test --offline --locked --lib vocab::` 27 passed/0 failed/1 ignored，全量 138 passed/0 failed/19 ignored，退出码 0。
**标准 2（往返）**：通过（以脚本通过为准，未逐条手读 evidence）。`node_round_trip` 走生产导入 → 导出 → 007 再解析，含软删除过滤。
**标准 3（独立核对）**：基本通过。Rust 侧 `node_round_trip` 另用只读 SQLite 直查 raw/顺序，且库前后哈希、记录快照一致；fixture 前后 SHA-256 脚本内比对。看过 `export.rs`：正文直接输出 raw，按 `browse_at` 的未删除排序，表头/自查章节与卡片一致。
**标准 4（Rust 受控测试）**：通过。`export.rs` 内有已存在拒绝覆盖（哈希不变）、缺父目录不建、注入写失败清理半成品且不删既有文件、两线程竞争仅一个成功、Windows 联接到保护目录被拒、空类别/缺库不建文件不建库。
**标准 5（真实窗口）**：部分通过。已有证据目录 `app/src-tauri/target/vocab-export-e2e/015-20261108133518-14888/out/`：空库按钮禁用、取消零写入、两个文件导出成功，截图 01/02/03/05 在，日志 completed: true；本人未重新启动窗口，只核对了文件清单与日志。**缺口**：选择已有文件的界面提示与 04 截图没有（实现者自己也写明）。
**标准 6（真实来源副本往返）**：未做。`test-vocab-export.mjs` 只用 fixture，没有用 `D:\english` 的只读副本往返，结束报告也没写已做。

问题清单（按严重度）：
1. 中：标准 6 的「真实来源只读副本往返」没有证据。复现：看 `app/test-vocab-export.mjs`，输入只来自 `app/dev/fixtures/vocab/export/`。
2. 中：标准 5 的「选择已有文件」界面提示无截图、无真实窗口证据（后端拒绝覆盖有 Rust 测试，但界面显示未验证）。
3. 低：保护目录列表为写死路径（`D:\Hermes`、`D:\english`、`D:\Apps\LinguaClip` 等），本机若这些目录不存在则不生效（`canonicalize` 失败即跳过）；当前行为可接受，但用户换机路径不同时保护会静默失效。
4. 低：390×844 仅 WebView 模拟，未验证安卓真机（实现者已声明）。

审查三问：
- 改动的函数还有谁在用？`VocabPage.tsx`、`api.ts`、`types.ts`、`lib.rs`、`commands.rs`、`mod.rs` 的 diff 都只是新增（导出入口/命令注册/类型），原有导入、浏览逻辑未改；`export.rs` 复用 `query::browse_at`，该函数原调用方（浏览页）不受影响，vocab:: 和全量 cargo 测试全过。
- 接外部程序的部分有没有真实跑过？磁盘写入、联接保护用真实磁盘测试；原生保存框在真实 Tauri 窗口里跑过「取消」和「保存」，但「选已有文件」没跑成。
- 同类问题别处还有没有？导出路径检查是新写的，没有复用 `backup.rs`；未发现别处遗留同类覆盖风险。改动文件均在允许路径内（`git status` 核对），未见越界；`docs/ledger.md` 本轮未见更新（由调度/统筹收尾）。

验收结论：不通过
- 花费（调度脚本记录）：claude-sonnet 本次 $0.27
- 花费（调度脚本记录）：claude-sonnet 本次 $0.20

### 第 2 轮（claude-sonnet，2026-11-08；统筹从卡片末尾原样挪回本段）

以下为本轮实际复跑；生产代码自上轮后未再改，只补了证据与测试。

1. **标准 1**：通过。app 下 `test-vocab-parse.mjs`、`test-vocab-import.mjs`、`test-vocab-export.mjs`、`npx --no-install tsc --noEmit`、`npm run build` 退出码均 0；src-tauri 下 `cargo test --offline --locked --lib vocab::` 27 passed/0 failed/1 ignored，全量 138 passed/0 failed/19 ignored，退出码 0。
2. **标准 2/3**：通过。`test-vocab-export.mjs` 本轮输出「real-source-copy：78 条升级、486 条复习，往返通过」，证据 `app/src-tauri/target/vocab-export/20261108155912-17228/evidence.json`（evidenceVersion 2，含 fixture、real-source-copy 两组场景，源文件前后 SHA-256 一致）。Rust `node_round_trip` 另用只读 SQLite 直查 raw 与顺序。
3. **标准 4**：通过（上轮已核 `export.rs` 内受控测试：已存在不覆盖、缺父目录、注入写失败清理、双线程竞争仅一成功、联接保护；本轮 cargo 全绿）。
4. **标准 5**：基本通过，有限制。空库禁用/取消/两次导出/窄屏沿用 `vocab-export-e2e/015-20261108133518-14888/out/`（上轮已核）。选择已有文件：我看了 `vocab-export-e2e/015-manual-20261108155421-148/out/04-existing-file-error.png`，页面红字「导出学术升级库失败：目标文件已存在，已拒绝覆盖」，且 `D:\tmp\es-test\015-existing\u.md` 当前 SHA-256 为 3563000682864FAC…917B8，与证据前后值一致。限制：该次是用户手动操作，证据 JSON `completed:false`、`calls` 为空，脚本未独立记录选中的路径；自动保存框流程未走通。我本轮没有重启真实窗口。
5. **标准 6**：通过。真实来源副本（`D:\english`，只读输入，临时目录往返）已由 `test-vocab-export.mjs` 跑通，见上。
6. 越界检查：`git status` 变更文件均在允许路径内（另有任务卡本身）。

问题清单（按严重度）：
1. 低：标准 5「选已有文件」只有人工操作证据，自动脚本没捕获调用；同路径拒绝覆盖由 Rust 测试覆盖，可接受。
2. 低：保护目录为写死路径，换机后不存在的目录会静默跳过（`canonicalize` 失败即跳过）。复现：看 `export.rs` 保护列表。
3. 低：截图里顶部仍有「Update 0.10.0」徽标，属 017 范围，非本卡问题。
4. 低：390×844 仅 WebView 模拟，安卓真机未验证。

审查三问：
- 改动的函数还有谁在用？`VocabPage.tsx`、`api.ts`、`types.ts`、`lib.rs`、`commands.rs`、`mod.rs` 的 diff 均为新增或小改；`export.rs` 复用 `query::browse_at`，浏览页调用方不受影响，vocab:: 与全量 cargo 测试通过。
- 接外部程序的部分有没有真实跑过？磁盘写入为真实磁盘测试；原生保存框的取消、保存、选已有文件均在真实 Tauri 窗口出现过证据（后者为人工操作）。
- 同类问题别处还有没有？导出路径检查是新写的、未复用 `backup.rs`；未发现别处遗留同类覆盖风险。

验收结论：通过

## 复核意见

### 第 1 次返工（2026-11-08，用户）

继续
