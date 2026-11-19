# 092-随手记问AI与让AI看看接入小窗

- 状态：已关闭（2026-11-17 统筹复核：看了 1440 词条页 + 小窗同一任务、手机半屏追问截图，两处修好；本卡 4 条提示和 090 结果不持久化转进 093；cdp 点击、plugin http not found 记入小问题待办）
- 难度：中
- 类别：AI 接入
- 实现：claude-haiku
- 验收：opencode-ds-flash
- 所属阶段：AI 小窗
- 依赖：091

<!-- 2026-11-17 统筹 claude：AI 常驻小窗第一期最后一张。底层在 090（`app/utils/aiTasks/`），界面在 091（`app/components/ai/`）。
     这张卡把用户最在意的两个功能接进去：
     - 随手记「问 AI」：`components/vocab/QuickNotesPanel.tsx` 约 78 行 `ask` → `utils/quicknote/ask.ts` 的 `askAboutQuickNote`，现在在组件里 await，切页面就断。
     - 例句「让 AI 看看」：`components/vocab/ExamplesSection.tsx` 约 199–210 行 → `utils/vocab/examples.ts` 约 251 行 `checkOwnSentence`，回来的是结构化结果（判定、改好的句子、更地道的说法），界面上给「存原句 / 存改后 / 存更地道的 / 都不存」。
     用户 2026-11-17 定：结果按钮小窗和原处都有。重复存不怕，后端会拒绝同一句（「这句已经存过了」）。
     第二期再接「AI 给例句」「AI 帮我看看（英英释义）」，这张卡不碰。 -->

## 目标（一两句话，用户能看懂）

随手记的「问 AI」和例句的「让 AI 看看」改成交给 AI 小窗在后台跑：切页面不中断，小窗里看得到进度和回复；「让 AI 看看」的结果在小窗里能直接存，回到原来的词条页也还在、也能存。

## 允许改动的路径

<!-- 只是预估，不限制执行者；调度脚本用它判断几张卡能不能并行。 -->
- `app/components/vocab/QuickNotesPanel.tsx`
- `app/utils/quicknote/ask.ts`
- `app/components/vocab/ExamplesSection.tsx`
- `app/utils/vocab/examples.ts`
- `app/components/ai/*`
- `app/test-quicknote.mjs`
- `app/test-vocab-examples.mjs`
- `app/dev/e2e/ai-wire-092.mjs`

## 从哪看起

- `app/utils/aiTasks/`（090：建任务、订阅、按来源找任务、结构化结果）。
- `app/components/ai/`（091：小窗里怎么显示一条任务）。
- `app/components/vocab/QuickNotesPanel.tsx`、`app/utils/quicknote/ask.ts`。
- `app/components/vocab/ExamplesSection.tsx`、`app/utils/vocab/examples.ts` 的 `checkOwnSentence`。

## 要做成什么样

1. **随手记「问 AI」**：
   - 点了建一个 AI 任务（标题如「问 AI：随手记 <前 20 字>」，来源记随手记 id），小窗自动展开到这条（电脑侧栏 / 手机抽屉）。
   - 回复走流式，在小窗里边写边显示；随手记卡片上原来显示答案的地方，也从同一个任务读，回来能看到。
   - 切到别的页面再回来：任务还在跑或已完成，随手记卡片上显示对应状态和答案。
2. **例句「让 AI 看看」**：
   - 点了建一个 AI 任务（标题如「让 AI 看：agenda 的例句」，来源记词和这句原文），按钮显示「AI 正在看…（在小窗里看进度）」。
   - 模型有思考内容时，小窗里能看到思考在增长；结构化结果解析好后存进任务。
   - **两处都有按钮**：小窗这条任务下面，和词条页的例句区，都显示判定、改好的句子、更地道的说法和「存原句 / 存改后 / 存更地道的 / 都不存」，两处存的内容和现在一样（来源、原句、说明、义项都不变）。
   - 一处存了，另一处变成「已存」；点「都不存」两处都收起。
   - 离开词条页再回来，结果和按钮还在（从任务中心按来源找回）。
3. 原来的报错文案、没配模型时的禁用提示保持不变。
4. 判句提示词、解析规则不改，只改「谁来跑请求、结果放哪」。
5. **顺手修 091 留下的两处小窗毛病**（`app/components/ai/`）：
   - 手机抽屉半屏时，任务下面的「接着追问」输入框被底部「直接问 AI」区挡住下半截。改成半屏时也能完整看到、点到（比如展开的任务滚到可见区，或底部区域让出位置）。
   - 「直接问」时，用户自己那条气泡前面多了「（关于单词 xxx）」。气泡里只显示用户打的字；发给模型的内容照旧带上当前词，「关于」由上面的标签显示。
   - 真实窗口脚本里各补一条断言，并补一张手机半屏截图。

## 允许写的仓库外路径

- `D:\tmp\es-e2e\**`
- `E:\rust\target\**`

## 验收标准（验收者照着复跑）

1. 不坏老功能（在 `app` 目录）：
   - `npx --no-install tsc --noEmit`、`npm run build` 退出码 0；
   - `node test-quicknote.mjs`、`node test-quicknote-triage.mjs`、`node test-vocab-examples.mjs`、`node test-ai-tasks.mjs` 退出码 0；
   - `node dev/fixtures/quicknote/e2e.mjs`、`node dev/fixtures/vocab/examples/e2e.mjs` 退出码 0（旧脚本如果因为按钮文案或位置变了而失败，改脚本并在结束报告里写明改了哪几处断言）；
   - `node dev/e2e/smoke.mjs` 退出码 0。
2. 真实窗口：`node dev/e2e/ai-wire-092.mjs` 退出码 0（假模型服务，慢速吐字），覆盖：
   - 随手记点「问 AI」→ 小窗展开到这条，回复逐步出现 → 中途切到词库页再切回 → 随手记卡片上答案完整；
   - 词条页「自己写一句」→「让 AI 看看」→ 立刻切到别的页面 → 回到这个词条：结果和四个按钮都在；
   - 在小窗里点「存改后」→ 词条页例句列表出现改好的句子，下方「原句：」是自己写的；词条页那组按钮变成「已存」；
   - 查库：`vocab_example` 这条 `source` 是 `AI改过`，`original` 是原句。
3. 截图（验收者看过）：随手记答案 + 小窗、词条页结果按钮 + 小窗同一任务、手机 390 宽抽屉里的结果按钮。

## 不做什么

- 不接「AI 给例句」「AI 帮我看看（英英释义）」（第二期）。
- 不改判句提示词和解析。
- 不改 090、091 的结构；缺小功能可以补，写清原因。

---

## 结束报告（实现者填）

- 改了什么（实现者 claude-haiku，2026-11-17）：
  - 随手记「问 AI」改成后台任务：`utils/quicknote/ask.ts` 的 `askAboutQuickNote` 改为同步建任务（来源 kind=quicknote、noteId，标题「问 AI：随手记 前 20 字」，气泡只显示随手记原文，发给模型的提示词没动）；`components/vocab/QuickNotesPanel.tsx` 的 `QuickNoteItem` 从任务读答案/忙碌状态/失败原因，点了后调 `aiPanelState.reveal` 让小窗展开到这条。
  - 「让 AI 看看」改成后台任务：`utils/vocab/ownCheckTask.ts`（新）建任务（来源 kind=example-own、word、ref=原句，标题「让 AI 看：词 的例句」）、存、都不存；`utils/vocab/examples.ts` 新增 `sentenceCheckFromText`（解析 + 判定，提示词和解析规则没改）、`ownCheckItem`（存原句/存改后/存更地道的各自的内容，和原来一样）；`checkOwnSentence` 保留（老单测在用）。
  - 结果和「已存 / 都不存」状态记在任务的 `result` 里（`OwnCheckRecord`：saved / dismissed），所以词条页和小窗两处都从同一任务读，一处存了另一处变「已存」。
  - 新组件 `components/ai/OwnCheckResult.tsx`（判定 + 四个按钮，两处共用）、`components/ai/useAiTasksBy.ts`（按来源订阅任务）。`components/vocab/ExamplesSection.tsx` 的自己写部分改用上面这些，离开再回来仍能找回（非紧凑模式下有结果就默认展开「自己写」）。
  - 小窗（`components/ai/AiPanel.tsx`）：判句任务不显示模型原始 JSON，改为思考 + 进度 + 结果块（带四个按钮），不接追问；直接问的气泡只显示用户打的字（`AiMessage.shown`）；半屏抽屉里展开的任务和追问框自动滚到可见区，判句结果的按钮也滚到可见区；任务列表的展开 / 滚动由 `panelState.ts` 的 `reveal` 驱动。
  - 090 小补（为了上面功能，结构没动）：`utils/aiTasks/center.ts` 加可选 `shown`（用户气泡显示字）和 `updateResult(id, result)`（改结果、存盘）。
  - 清单外改动：`app/dev/sse-fake-model.mjs` 新增 `fake-grade`（先慢慢想、再慢慢吐判句 JSON，导出 GRADE_* 常量）；`app/dev/fixtures/vocab/examples/e2e.mjs` 改了 1 处断言（见下）；新增 `app/dev/e2e/ai-wire-092.mjs`。
  - 脚本断言改动：`dev/fixtures/vocab/examples/e2e.mjs`「存完收起结果」改为「存完 own-saved 显示『已存』、存改后按钮消失」（结果现在存在任务里，存完是「已存」不是收起）。
- 代码审阅：自己过了一遍：任务 `result` 写入都走 `updateResult`（会存盘）；两处同时存同一句时后端拒绝重复，第二处会显示「保存失败：这句已经存过了」；判句任务不接追问（否则回复不再是 JSON）；`checkOwnSentence` 没删，只是界面不再用。
- 自动测试（app 目录，退出码均为 0）：`npx --no-install tsc --noEmit`；`npm run build`；`node test-quicknote.mjs`；`node test-quicknote-triage.mjs`；`node test-vocab-examples.mjs`；`node test-ai-tasks.mjs`。
- 真实环境（真实 Tauri 窗口，`tauri dev`，假模型）：`node dev/e2e/ai-wire-092.mjs` 退出码 0；`node dev/fixtures/quicknote/e2e.mjs` 退出码 0；`node dev/fixtures/vocab/examples/e2e.mjs` 退出码 0；`node dev/e2e/smoke.mjs` 退出码 0；额外 `node dev/e2e/ai-panel-091.mjs`（091 回归）退出码 0。截图：`D:\tmp\es-e2e\092-ai-wire-20261117115814-14644\out\`（01 随手记答案+小窗、02 词条页结果+小窗、03 手机 390 抽屉结果按钮（未存前）、04 手机半屏追问框），实现者已逐张看过。
- 未验证：
  - 「都不存」「改了草稿就收起」「存更地道的」在真实窗口里没点过（代码走查过，和存改后共用同一套函数）。
  - 随手记在窗口收起时点「问 AI」后展开（收起→展开那支）没在 092 脚本里跑；091 脚本覆盖了收起/展开本身。
  - 「中途切到词库页」实际切的是设置页再切回词库页。
  - 真实模型的流式（只用了假模型）；Mac、安卓真机 / 模拟器没测；手机词库页右下「＋」叠放没测。
  - 091 留下的追问框被挡问题：修完后 092 脚本断言通过，但没有拿修复前的代码跑一遍证明它之前会失败。
  - 随手记 fixture 和 smoke 的 `pageErrors` 里各有两条 `plugin http not found`，没查是不是修改前就有（我的改动不走 http 插件的启动路径，但没对照旧代码确认）。
- 花费（调度脚本记录）：claude-haiku 本次 $1.39

## 交接摘要（实现者填；返工的新会话会带上最近一段，总长不超过约 40 行）

- 改了哪些文件及要点：`utils/aiTasks/center.ts`（+`shown`、+`updateResult`）；`utils/quicknote/ask.ts`（建任务，不再 await）；`utils/vocab/examples.ts`（+解析/存内容的纯函数，`checkOwnSentence` 保留）；`utils/vocab/ownCheckTask.ts`（新：建/存/收起/找任务）；`components/ai/{AiPanel.tsx,panelState.ts,OwnCheckResult.tsx,useAiTasksBy.ts}`；`components/vocab/{QuickNotesPanel.tsx,ExamplesSection.tsx}`；`dev/sse-fake-model.mjs`（fake-grade）；`dev/fixtures/vocab/examples/e2e.mjs`（1 处断言）；`dev/e2e/ai-wire-092.mjs`（新）。
- 关键函数 / 位置：`askAboutQuickNote`（ask.ts）；`startOwnSentenceCheck` / `saveOwnCheck` / `dismissOwnCheck` / `visibleOwnCheck`（ownCheckTask.ts）；`ownCheckItem` / `sentenceCheckFromText`（examples.ts）；`aiTasks.updateResult`（center.ts）；`aiPanelState.reveal` / `useAiFocus`（panelState.ts）；`TaskDetail` 的判句分支和追问隐藏（AiPanel.tsx）；`OwnCheckResult`（ai/OwnCheckResult.tsx）；`QuickNoteItem` 的 `askTask`（QuickNotesPanel.tsx）；`ExamplesSection` 的 `ownTask` / `ownLive` / `check` / `onDraftChange`。
- 试过但放弃的做法及原因：(1) 判句结果不放进任务结果、而是各自存 React 状态——会丢「已存 / 都不存」两处同步，且切页面就没了，放弃；(2) 给 `parseResult` 的错误让任务直接失败——会改 090 的语义（它明确写着「抛错不影响完成」），改为把解析错误记进结果里（`record.error`）显示；(3) 让判句任务也显示原始对话 + 追问——模型回复是 JSON，追问会破坏它，改为隐藏对话和追问框。
- 没验证的事：见结束报告「未验证」（都不存 / 存更地道的 / 草稿改动收起没在真实窗口点过；真实模型、安卓、Mac 没测；两条 plugin http 报错没对照旧代码确认；091 修复前没跑过对照）。

## 实际改动文件（调度脚本自动记录）

- 修改 `app/components/ai/AiPanel.tsx`
- 修改 `app/components/ai/panelState.ts`
- 修改 `app/components/vocab/ExamplesSection.tsx`
- 修改 `app/components/vocab/QuickNotesPanel.tsx`
- 修改 `app/dev/fixtures/vocab/examples/e2e.mjs`
- 修改 `app/dev/sse-fake-model.mjs`
- 修改 `app/utils/aiTasks/center.ts`
- 修改 `app/utils/quicknote/ask.ts`
- 修改 `app/utils/vocab/examples.ts`
- 修改 `docs/ledger.md`
- 新增 `app/components/ai/OwnCheckResult.tsx`
- 新增 `app/components/ai/useAiTasksBy.ts`
- 新增 `app/dev/e2e/ai-wire-092.mjs`
- 新增 `app/utils/vocab/ownCheckTask.ts`

## 验收记录（验收者填，不能是实现者本人；最后单独一行写「验收结论：通过」或「验收结论：不通过」）

- 验收者 opencode-ds-flash，2026-11-17。改动还没提交（HEAD 是改动前），按工作区实际代码复跑；我没有改任何代码文件。
- 改动范围核对：`git status` / `git diff` 与卡片「实际改动文件」一致（9 个改、4 个新、外加 ledger 一行和卡片本身）；没有删除、没有越界改到仓库外；e2e 里只有假 key（`092-local-test-key`），仓库里没有真密钥。
- 环境：Windows 11 真实 Tauri 窗口（`tauri dev`，窗口隐藏），本机假模型服务；每条命令都在前台跑完看退出码。

### 逐条验收标准结果

1. **通过**（`app` 目录，全部退出码 0）：
   - `npx --no-install tsc --noEmit` → 0；`npm run build` → 0（只有 >500 kB chunk 的旧警告）。
   - `node test-quicknote.mjs` → ok；`node test-quicknote-triage.mjs` → ok；`node test-vocab-examples.mjs` → 全部通过（7 次假模型请求）；`node test-ai-tasks.mjs` → 全部通过。
   - `node dev/fixtures/quicknote/e2e.mjs` → 0（result「通过」；`pageErrors` 仍有两条 `plugin http not found`，见问题 6）；`node dev/fixtures/vocab/examples/e2e.mjs` → 0（改过的「存完变成已存」那条断言实跑通过）。
   - `node dev/e2e/smoke.mjs` → 0（冒烟通过）。
2. **通过**：`node dev/e2e/ai-wire-092.mjs` → 0，实际输出：
   - PASS 随手记点「问 AI」：小窗展开到这条任务；
   - PASS 随手记：中途切走再回来，卡片上答案完整（离开时状态 running）；回复确实是逐步出现（脚本断言中途读到的长度 >0 且小于完整的 23 个字符）；
   - PASS 小窗：思考内容在增长（9 → 24 字）；
   - PASS 词条页：离开再回来，判句结果和四个按钮都在（离开时切的是「设置」再切回词条，不是卡片写的「词库页」，效果等价：页面组件都卸载重挂；记在这里备查）；
   - PASS 小窗里同一任务：同样的判定和按钮；
   - PASS 小窗存改后：词条页列表出现改好的句子，原句是自己写的，两处变成「已存」；
   - PASS 查库：`vocab_example` 的 `source` 是「AI改过」，`original` 是原句（脚本直接读 `vocab.db`，只 1 条）；
   - 另：实现者没在真实窗口点过的「都不存」「存更地道的」，我用临时脚本 `D:\tmp\es-e2e\review-092-dismiss.mjs`（仓库外，允许路径）在同一个真实窗口补跑：点「都不存」→ 词条页和小窗两处结果都收起（localStorage 里这条任务 `result.dismissed=true`）；再判一句点「存更地道的」→ 两处「已存」，库里 `source=AI改过`、`original` 是刚写的那句、`explanation` 是模型给的中文说明、`sense` 是「adj. able to recover after difficulty（经受打击后能够恢复的）」。
3. **通过**（截图我看过）：`D:\tmp\es-e2e\092-ai-wire-20261117120726-8172\out\`
   - `01-quicknote-answer-1440.png`：随手记卡片上显示答案，右侧小窗展开到「问 AI：随手记…」这条，气泡只有随手记原文，回复和思考都在；
   - `02-entry-and-panel-1440.png`：词条页例句区有判定 + 改好的句子 + 更地道的说法 + 四个按钮，小窗里是同一条任务的同一组按钮；
   - `03-mobile-own-result-390.png`：390 宽抽屉里判句结果和四个按钮都完整可见，不横向溢出；
   - `04-mobile-followup-390.png`：半屏抽屉里「接着追问」输入框完整可见，没有被底部「直接问」区挡住。
   - 另外看了 `dev/fixtures/vocab/examples` 的 `04-saved-three-1280.png`：存完词条页是「已存」、小窗里也是「已存」，例句列表里来源「AI改过」、「原句：」是自己写的那句。

### 审查三问

- **改动的函数还有谁在用？** `askAboutQuickNote` 只有 `QuickNotesPanel.tsx` 一处调用（返回类型从 `Promise<string>` 变 `CreateTaskOutcome`，grep 过没有别的调用点，旧单测也没调它）；`checkOwnSentence` 界面已不用，只剩 `test-vocab-examples.mjs`，保留后该测试通过；`aiTasks.updateResult` 只被 `ownCheckTask.ts` 的存 / 都不存调用；`AiMessage.shown` 只有 `AiPanel.TaskDetail` 读（旧数据没这个字段 → 回退显示 `content`）；`aiPanelState.reveal` / `useAiFocus` 用于 `QuickNotesPanel` 和 `PanelBody`；`EXAMPLE_CHECK_KIND` 被 `ownCheckTask`、`ExamplesSection`、`AiPanel` 共用。tsc 全过，没有漏改的调用点。
- **接外部程序的部分有没有真实跑过？** 真实 Tauri 窗口 + 本机假模型（WebView 自己 fetch）实跑过随手记问答、判句、思考流式、切页面；SQLite 真实查过库。没跑的是发布路径（Tauri http 插件 `tauriFetch`）对真实模型——本机没有密钥，这条和 090 共用同一通道、提示词没改；Mac / 安卓真机也没跑。
- **同类问题别处还有没有？** 「问 AI」那类「组件里 await、切页面丢结果」的写法在「AI 给例句」等处还在（本卡明确留到第二期，不算问题）；直接问气泡前缀只有 `PanelBody.ask` 一处，已修；半屏被挡的处理覆盖了追问框和判句结果块，普通任务也走同一个滚动逻辑。另一个同类隐患：小窗「自动展开新任务」靠 `newestId` + `userChose`，和这次新加的 `reveal` 有功能重叠（见问题 3）。

### 问题清单（按严重程度，没有「一般 / 严重」）

1. **提示（本卡）** 小窗里的判句任务只显示判定、改后句子和按钮，不显示用户提交的原句；点「存原句」时看不到原文对照。复现：例 resilient 写一句 → 让 AI 看看 → 小窗里展开这条，找不到自己写的那句。建议：结果块上方加一行「原句：…」（第二期顺手）。
2. **提示（本卡）** 存完 / 都不存后，「自己写一句」的草稿不再清空（老代码存完会 `resetOwn`），同一句还留在输入框里；再点「让 AI 看看」会又建一个任务。复现：写一句 → 让 AI 看看 → 存改后，看输入框里还是那句。建议：存成功后清空草稿。
3. **提示（本卡）** `reveal` 的 focus 在小窗原本是关着 / 收起的场景下不生效：`PanelBody` 挂载时 `seenFocus` 已经初始化成新的 epoch，effect 直接跳过；现在能用是因为新任务恰好是最新一条，被「自动展开最新一条」兜住了。复现：把侧栏收成窄条，再点随手记「问 AI」，能展开（靠 newest 逻辑），但把 `tasks` 排序或默认展开策略一改就会失效。建议：挂载时读一次 focus，或把「已处理」标记放到模块里。
4. **提示（范围外）** e2e 的 `page.click` 先 `scrollIntoView` 再立刻量坐标，长页面上量完坐标会变，真实鼠标点会落空。复现：`node D:\tmp\es-e2e\review-092-dismiss.mjs` 里用 `page.click` 点「都不存」，按钮上收不到任何鼠标事件（我加了事件日志，为空）；手动「滚动 → 等 500ms → 重新量坐标再点」就正常，`element.click()` 也正常。这不是产品问题，是脚本工具的坑。建议：改 `dev/e2e/cdp.mjs` 的 `click`，滚动后等一帧再量（与本卡无关，记小问题待办）。
5. **提示（范围外）** 判句任务「解析失败 → 重启应用 → 点重试」会得到没有结果的完成态：090 的 `parseResult` 只存在内存里，重启后丢了；重试完成 `result` 为空，小窗里只有「完成」、没有判定和按钮，也没有重试按钮了。复现：让模型回一段坏 JSON 触发 `record.error`，关掉应用重开，点这条的「重试」。建议：记入 090 / 小问题待办（解析函数随任务一起存，或重启后判句任务不给重试）。
6. **提示（范围外）** 冒烟和随手记 fixture 的 `pageErrors` 里各有两条 `plugin http not found`；代码看是 `utils/update.ts` 启动约 10 秒后自动查更新（走 `tauri-plugin-http`），和本卡路径无关，但我没做「旧代码也报」的对照实验。建议：不用本卡处理，可记小问题。
7. **提示（本卡）** 英文界面下小窗里这块判句结果仍是中文（`OwnCheckResult` 写死中文，和例句区现状一致）。建议：接第二期时补 i18n。

### 没覆盖的（不是验收标准，供复核参考）

- 「改了草稿就收起」只做了代码走查（`onDraftChange → dismissOwnCheck`，和上面实测的「都不存」同一个函数），没在真实窗口点。
- 真实模型（非假模型）的流式和判句、Mac、安卓真机 / 模拟器没测。
- 第 091 条毛病（追问框被挡）只验证了修好后通过，没拿修复前代码做对照。

验收结论：通过

### 警告（调度脚本记录）
- 警告（本卡·提示）：小窗里的判句任务只显示判定、改后句子和按钮，不显示用户提交的原句；点「存原句」时看不到原文对照。建议：结果块上方加一行「原句：…」，第二期顺手补。
- 警告（本卡·提示）：存完或都不存后，「自己写一句」的草稿不再清空（老代码存完会清空），同一句留在输入框里，再点「让 AI 看看」会重复建任务。建议：存成功后清空草稿，或写明保留是有意的。
- 警告（本卡·提示）：小窗从关闭/收起状态打开时，panelState.reveal 的 focus 被 PanelBody 挂载时的 seenFocus 初始化吞掉；现在能用是靠「自动展开最新一条」兜底，任务排序或默认展开策略一改就会失效。建议：挂载时读一次 focus，或把「已处理」标记放到模块里。
- 警告（范围外）：dev/e2e/cdp.mjs 的 page.click 先 scrollIntoView 再立刻量坐标，长页面上坐标会变导致真实鼠标点落空；我用它点「都不存」时按钮收不到任何事件，滚完等 500ms 重测就正常。只影响测试工具，不是产品问题。建议：与本卡无关，建议记入小问题待办：click 滚动后等一帧再量。
- 警告（范围外）：090 的 parseResult 只存在内存：判句任务解析失败后重启应用再点「重试」，会完成但没有结果块和按钮，也没有重试入口。建议：与本卡无关，建议记入 090/小问题待办（解析函数随任务持久化，或重启后判句任务不给重试）。
- 警告（范围外）：冒烟和随手记 fixture 的 pageErrors 各有两条 plugin http not found，代码看来自 utils/update.ts 的启动自动查更新，和本卡路径无关，但没做旧代码对照实验。建议：无需本卡处理，可记小问题。
- 警告（本卡·提示）：英文界面下小窗里的判句结果块仍是中文（OwnCheckResult 写死中文，和例句区现状一致）。建议：接第二期时补 i18n。
