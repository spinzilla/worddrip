# 030-按 Hermes 规则出题

- 状态：已关闭（claude-sonnet 复核通过 2026-11-10：复跑出题单测、假模型测试、tsc 通过，真实窗口由 033 复跑通过；6 个小问题记入交接待办）
- 难度：架构
- 类别：功能 + 前端界面
- 实现：claude-opus
- 验收：opencode-ds-flash
- 所属阶段：阶段 1D：查词与出题改版（第 3 张）
- 依赖：028

<!-- 用户 2026-11-10：交给 Opus 的设计卡少给设计限制，旧网站和 Hermes 流程都只作参考。本卡只写安全和范围要求以及验收证据；出题策略、数据怎么用、提示词、界面流程都由实现者设计。031 判分、032 新词首考会建在本卡之上，请把接口设计得能复用。 -->

## 目标（一两句话，用户能看懂）

重新设计复习出题，让软件里的题和用户在 Hermes 里做的题一样有效：看英文释义和语境写出目标词，而不是看遮了词的中文备注。具体怎么做由你决定。

## 背景

- 学习规则全文：`docs/coach-rules/handoff-20261110/04_QUESTIONING_AND_ASSESSMENT.md`（出题与批改）、`03_TEACHING_PROTOCOL.md`（教学流程）、`05_REVIEW_AND_ARCHIVE_RULES.md`（状态机）；真实题目样例见 `docs/coach-rules/handoff-20261110/06_CURRENT_STATUS.md` 引用的 11 月 9 日那期。
- 现状：`app/utils/vocab/recall.ts` 用备注遮词当题面，没有英文释义和语境，备注里还混着复习历史。
- 统筹的观察（供参考）：Hermes 每道题都靠 AI 现写，质量会波动，出现过题面说明写错和泄题；028 之后很多词有现成的英文释义和例句，可以少依赖 AI。

## 可参考：Hermes 的出题规则（用户说明只是参照，你可以评价、改进或替换）

- 只出产出题（回忆填空、改写、造句）；四选一只作不计分的再认。
- 每题有英文释义或 paraphrase 和足够限定答案的语境；中文只作补充。
- 回忆题的标题、题号、题面不泄露目标词及其变形。
- 一轮复习最多 8 个到期词，最逾期优先；每屏最多 5 题。
- 不用 AI 臆造的搭配当标准答案。

如果你的方案偏离这些规则，在结束报告里说明理由。

## 必须遵守（安全和范围）

- 不改状态规则（022），不做判分和复检（031），不做新词首考（032）。
- 测试全程不调用真实模型；真实 API key 不进日志、报错和截图。
- 不碰真实用户数据库和 `D:\english`；真实窗口测试前如果 3000 端口被占用，不要结束别人的进程，写「待你决定」后结束。不装依赖、不提交、不推送。

## 验收标准（验收者照着复跑）

1. 实现者自己设计自动测试，至少覆盖：你的防泄题做法、本机假模型返回正常与格式错误、没配模型时的行为、每轮和每屏的题量规则。在结束报告里写清复跑命令和预期输出，验收者照着复跑，全部退出码 0。
2. 在 `app` 下运行 `npx --no-install tsc --noEmit` 和 `npm run build`，退出码 0；`node test-vocab-recall.mjs` 若保留则需通过，若被替换请在结束报告说明。
3. 隔离真实窗口接本机假模型做一轮复习，截图至少包括：用现成例句出的题、模型生成的题、缺数据时给用户的说明、390 CSS 像素宽度下的题面。
4. 结束报告用三五句话说明出题策略：什么时候用现成数据、什么时候调模型、怎么防泄题、给 031 和 032 留了什么接口。

---

## 结束报告（实现者填）

- 改了什么：
  - `app/utils/vocab/recall.ts`（重写）：不再用遮词备注当题面，改成纯函数出题模块：词形/同族词识别（`inflections`、`findTargetForms`、`isTargetForm`、`findLeaks`、`maskLeaks`）、首字母提示、现成例句题 `exampleQuestion`、释义兜底题 `definitionQuestion`、模型草稿校验 `questionFromDraft`、整轮准备 `prepareRecallRound`、分屏 `splitScreens`、临时判定 `judgeRecall`、泄题自检 `questionLeaks`。保留 `recallKind`、`normalizeRecallAnswer`、`recallAnswerMatches`；删掉 `createRecallSession`、`maskRecallAnswer`（全仓库已无引用）。
  - `app/utils/vocab/recallModel.ts`（新）：模型客户端，沿用收件箱/作文批改的 OpenAI 兼容写法和开发窗口假 fetch 钩子；`hasQuestionModel`、`buildQuestionPrompt`、`parseModelQuestions`（只认完整 JSON 或代码块）、`requestModelQuestions`（报错不带响应正文和密钥）。
  - `app/components/vocab/RecallReview.tsx`（重写）：每屏最多 5 题；每题显示 Meaning（英文释义）、挖空语境句（空格里就是首字母提示）、字母数/词数、可折叠中文提示；「提交这一屏」后单词/短语自动判定并逐题写回复习库，句型仍自评；结果页列出缺数据跳过的词及原因、没轮到的到期词数。输入框关掉拼写检查（红线会泄露拼写对错）。
  - `app/components/vocab/DuePanel.tsx`：点「开始产出题复习」时调用 `prepareRecallRound`（配了模型才传模型生成器），准备期间弹层显示「正在准备题目」，退出后迟到的结果丢弃。
  - `app/components/vocab/vocab.css`：去掉旧的备注题面样式，加空格下划线样式。
  - `app/test-vocab-recall.mjs`（替换为 030 版）、`app/test-vocab-recall-model.mjs`（新）、`app/dev/fixtures/vocab/recall/e2e.mjs`（由 023 版改写为 030 版，原来的精听快捷键回归段落一并去掉）。
  - `docs/ledger.md` 加一行；本卡结束报告。未提交、未推送。
- 出题策略：
  1. **现成数据优先**：词条有英文释义、且某条例句里目标词（含 -s/-ed/-ing 等屈折变形）恰好出现一次，就直接挖空这句出题，人工例句优先于 AI 例句；答案是句中实际词形（allocated 写成 allocate 判错，结果里提示原形）。
  2. **缺语境才调模型**：其余单词/短语一轮只批量请求一次模型，只发词、词性、词库释义和中文，不发复习备注；模型要在句中用 `[[ ]]` 标出目标词。有词库释义时题面用词库释义，没有才用模型写的释义并标「AI 释义」；模型句一律标「AI 语境句」。答案永远是目标词本身，不会把 AI 编的搭配当标准答案。句型（含 X/… 或超过 4 个词）不交给模型。
  3. **防泄题全在本地**：语境句里目标词挖空；释义、中文、句子其余部分里的目标词变形和同词根派生词（evaluate → evaluation，6 个字母以上的词按词根）遮成 `___`；模型句必须恰好一个标记、标记里是目标词的变形、标记外没有同族词、至少 4 个其他词，否则拒用；最后整题再跑一次 `questionLeaks`，还能看到目标词就不出这题。提示由程序按答案生成（e_________、t___ p___ i_），字母数/词数不会写错。
  4. **缺数据**：没配模型或模型失败/不合格时，有英文释义的退回「仅释义 + 首字母提示」题，并在题卡上说明为什么没有语境句；连英文释义都没有的词跳过，结果页写原因（去导入释义或配置模型）。
  5. **题量**：按最逾期优先的队列依次挑能出题的词，凑满 8 题为止（缺数据的词不占名额，但列在结果页；与 Hermes「先取 8 个再跳过」略有不同，理由是少出题对用户没好处）；每屏不超过 5 题且尽量平均（8 题 = 4 + 4，7 题 = 4 + 3）。四选一再认题本卡没做。
  6. **给 031 / 032 的接口**：`QuestionWord`（只要 id、词、释义，新词也能传）、`RecallQuestion`（含 `answers`、`kind`、`source`、`selfCheck`、语境前后半句）、`prepareRecallRound(queue, { generate, limit })`（032 新词首考可传 `limit: 7`）、可注入的 `ModelQuestionGenerator`、`splitScreens`、`questionLeaks`；判分集中在 `judgeRecall` 一个函数，031 换判分或加复检只需替换它和界面里的写回调用。
- 代码审阅：没改 Rust、数据库结构和状态规则（写回仍走原 `vocab_review_submit`，题型仍按 `recallKind`）；没做判分/复检/新词首考。题面不再读 `note`，测试断言复习备注既不上题面也不发给模型。模型报错只给固定中文提示 + HTTP 状态码，不带响应正文；假密钥不出现在报错和证据文件里。`git diff --check` 通过。已知限制：不规则变形（took、ran）认不出，这类例句会被当成没有目标词而退回模型或释义题；5 个字母以下的词不做词根匹配；6 个字母以上的词根匹配偶有误伤（如 candid 会连 candidate 一起遮/拒）。
- 自动测试（都在 `app` 目录跑，均退出码 0）：
  - `node test-vocab-recall.mjs` → 输出「复习出题纯函数测试通过：词形、防泄题、现成例句、模型草稿校验、没配模型/模型失败兜底、每轮 8 题、每屏 ≤5 题、判定。」覆盖：防泄题（变形/同族词识别、释义和中文遮词、7 种模型草稿拒用情形、每道生成题 `questionLeaks` 为空且原形不出现）、本地假生成器正常/抛错/部分不合格、没配模型（`generate: null`）、每轮 8 题与 `limit`、分屏 0/1/5/6/7/8/11 及 1–30 题全部 ≤5。
  - `node test-vocab-recall-model.mjs` → 输出「复习出题假模型测试通过：没配模型、正常 JSON、代码块、格式错误退回释义题、HTTP 错误、超时、断网，报错不带密钥。」用本机 HTTP 假服务跑真实请求代码，断言没配模型时 0 次请求、正常时整轮 1 次请求、提示词不含备注。
  - `npx --no-install tsc --noEmit` 退出码 0；`npm run build` 退出码 0（只有原有 chunk 大小提示）。
- 真实环境：`node dev/fixtures/vocab/recall/e2e.mjs` 退出码 0（隔离数据目录，开跑前确认 3000 端口空闲；不碰真实数据库和 `D:\english`）。导入 8 个到期词 + 1 份期文件释义（6 条释义、5 条例句）。第 1 轮没配模型：6 题分 3 + 3，resilient 显示「仅释义」及说明，提示 2 个词缺数据，Esc 退出后数据库不变。第 2 轮接本机假模型：只请求 1 次且只请求 resilient/candid/nodata 三个缺语境的词；7 题分 4 + 3；故意泄题的 nodata 草稿被拒并在结果页说明；两屏作答后 SQLite 中 4 词 L2/+4 天、3 词 L1/+2 天、nodata 不变，复习日志 7 条；弹层作答前不含任何目标词；390 CSS 像素无横向溢出；无意外页面错误；窗口已关闭。截图 8 张已人工查看，中文正常：`01-no-model-missing-data.png`（缺数据说明）、`02-example-question.png`（现成例句题）、`03-model-question.png`（模型题，含 AI 释义）、`04-narrow-390.png`、`04b-narrow-390-model.png`、`05-screen1-judged.png`、`06-screen2-judged.png`、`07-summary.png`；证据 `app/src-tauri/target/e2e/030-20261110023230-15968/out/evidence.json`。
- 未验证：没接真实模型（按要求全程假模型），真实模型出题质量和不合格率未知；没用 11 月 9 日那期真实题目对照（`examples/vocabulary/20261109.md` 不在本仓库）；没用真实释义原料跑一轮看「现成例句」覆盖率（028 报告只有 17 条例句，预计大多数词要靠模型或仅释义题）；安卓真机/模拟器未验证，只做了 390 宽隔离窗口；旧 023 e2e 里的精听快捷键回归不再在本脚本里跑（Esc 监听代码没改）；实现者未自行验收。
- 花费（调度脚本记录）：claude-opus 本次 $4.05，【超过提醒线 $3】

## 实际改动文件（调度脚本自动记录）

- 修改 `app/components/vocab/DuePanel.tsx`
- 修改 `app/components/vocab/RecallReview.tsx`
- 修改 `app/components/vocab/vocab.css`
- 修改 `app/dev/fixtures/vocab/recall/e2e.mjs`
- 修改 `app/test-vocab-recall.mjs`
- 修改 `app/utils/vocab/recall.ts`
- 修改 `docs/ledger.md`
- 新增 `app/test-vocab-recall-model.mjs`
- 新增 `app/utils/vocab/recallModel.ts`

## 验收记录（验收者填，不能是实现者本人；最后单独一行写「验收结论：通过」或「验收结论：不通过」）

验收者：opencode-ds-flash，2026-11-10。HEAD `021b67b`，改动未提交；以下结果全部由验收者本轮亲自复跑，未改任何代码文件。

### 逐条复跑

1. **自动测试（验收标准 1）**：通过。
   - `cd app && node test-vocab-recall.mjs` → 退出码 0，输出「复习出题纯函数测试通过：词形、防泄题、现成例句、模型草稿校验、没配模型/模型失败兜底、每轮 8 题、每屏 ≤5 题、判定。」
   - `cd app && node test-vocab-recall-model.mjs` → 退出码 0，输出「复习出题假模型测试通过：没配模型、正常 JSON、代码块、格式错误退回释义题、HTTP 错误、超时、断网，报错不带密钥。」
   - 另读了两个测试源文件核对覆盖面：防泄题（变形/同族词、释义与中文遮词、7 种模型草稿拒用、每题 `questionLeaks` 为空）、假模型正常/抛错/部分不合格、没配模型（`generate: null` 与 `hasQuestionModel=false`，且 0 次请求）、每轮 8 题与 `limit`、分屏 0/1/5/6/7/8/11 及 1–30 题全部 ≤5。测试断言了复习备注既不上题面也不进提示词，假密钥不出现在报错里。
2. **类型检查与构建（验收标准 2）**：通过。
   - `cd app && npx --no-install tsc --noEmit` → 退出码 0，无输出。
   - `cd app && npm run build` → 退出码 0，只有原有的 `index-*.js 1,090.45 kB` chunk 大小提示。
   - `node test-vocab-recall.mjs` 保留且通过（见上）。
3. **隔离真实窗口（验收标准 3）**：通过。本轮新跑目录 `app/src-tauri/target/e2e/030-20261110024015-15948`。
   - 开跑前确认 3000 端口空闲；`cd app && node dev/fixtures/vocab/recall/e2e.mjs` → 退出码 0。
   - 第 1 轮（没配模型）：导入 8 个到期词 + 1 份期文件（6 条释义、5 条例句）；6 题分 3 + 3，第 2 题显示「仅释义」及缺语境说明，通知写 1 题没现成例句、2 个词缺数据；模型调用 0 次；Esc 退出后 `review_word` 快照不变、`review_log` 0 条。
   - 第 2 轮（本机假模型）：只发 1 次请求，请求 id 恰为 `resilient/candid/nodata`，提示词不含复习备注；7 题分 4 + 3；故意泄题的 `nodata` 草稿被拒并在结果页写明原因；作答后 SQLite 为 4 词 L2/+4 天、3 词 L1/+2 天、`nodata` 不变，日志 7 条且 kind 均为 `recall`；两屏作答前弹层文本都不含任何目标词；390 CSS 像素无横向溢出；除隔离模式刻意未注册 http 插件外无页面错误；窗口和 17 个进程已结束。
   - 本轮 8 张截图逐张看过，中文正常、无乱码：`01-no-model-missing-data.png`（缺数据说明）、`02-example-question.png`（现成例句题）、`03-model-question.png`（模型题，含 AI 释义）、`04-narrow-390.png`、`04b-narrow-390-model.png`（390 宽题面）、`05-screen1-judged.png`、`06-screen2-judged.png`（判错并提示原形）、`07-summary.png`。证据 `out/evidence.json` 已核对不含假密钥。
4. **出题策略说明（验收标准 4）**：通过。结束报告覆盖了「现成例句优先、缺语境才批量调模型、本地防泄题、031/032 接口」，四个必答点齐全；篇幅比「三五句话」长，但内容完整，不影响验收。

### 实际改动文件核对

- 代码改动与卡片记录一致：`recall.ts`、`recallModel.ts`、`RecallReview.tsx`、`DuePanel.tsx`、`vocab.css`、两个测试和 recall e2e；另有 `docs/ledger.md` 加两行、本卡结束报告。没有改 Rust、`package.json`/锁文件、真实数据库或 `D:\english`。
- `git status` 里没有任务外的源码改动。`git diff --check` 通过。
- 需要记录的范围变化：recall e2e 由 023 版整体改写，原文件里与 023 精听快捷键有关的回归段被删；实现者在「未验证」里已说明。另一个脚本 `app/dev/fixtures/vocab/review-session/e2e.mjs` 仍在覆盖键盘隔离、Esc 退出和真实媒体听写快捷键，所以这项覆盖没有完全消失。

### 审查三问

- **改动的函数还有谁在用？** `prepareRecallRound` / `RecallRound` 只被 `DuePanel` 使用；`judgeRecall` / `splitScreens` 只被 `RecallReview` 使用；`hasQuestionModel` / `requestModelQuestions` 只被 `DuePanel` 使用；`parseModelQuestions` / `buildQuestionPrompt` 目前只有测试在用。`recallKind`、`normalizeRecallAnswer`、`recallAnswerMatches` 现在只在 `recall.ts` 内部和单测里用。删掉的 `createRecallSession`、`maskRecallAnswer`、`RecallSession` 全仓库已无引用（只剩 `.dispatch` 历史日志）。Rust 侧没有改动，写回仍走原 `vocab_review_submit`。
- **接外部程序的部分有没有真实跑过？** 请求代码、SQLite 写回和界面流程都在隔离窗口里真实跑过；但模型请求走的是开发窗口专用的 `window.__ES_E2E_HTTP_FETCH__`（浏览器 fetch），单测又把 `@tauri-apps/plugin-http` stub 成 `globalThis.fetch`。也就是说，生产环境真正使用的 Tauri http 插件传输层没有在本轮被执行。它和收件箱、作文批改的写法相同，风险不高，但属于验证缺口。按要求没有调用真实模型。
- **同类问题别处还有没有？** 产出题这条线已经没有用备注遮词的代码；`Flashcards` 仍把 `note` 原样显示，但那是认词闪卡模式，不属于产出题。`EntryDetail`/搜索显示备注是原有功能。没有发现别处仍在「备注遮词出题」。不规则变形、5 个字母以下不做词根匹配、6 个字母以上词根偶尔误伤这三点实现者已写明，属于已知限制。

### 问题清单（按严重程度）

1. **中：生产传输层未验证。** 复现：在隔离窗口配好模型开始复习，实际走 `window.__ES_E2E_HTTP_FETCH__`；跑单测时 `plugin-http` 被替换成 `globalThis.fetch`。影响：如果 Tauri http 插件对 `AbortSignal.timeout`、请求头或响应体处理和浏览器 fetch 有差异，只有真实窗口才会暴露。建议 031 前用真实配置手动点一次（地址可以填不通的，重点看报错路径）。
2. **低：通知文案把「模型漏给某词」算成「没通过格式或防泄题检查」。** 复现：让模型返回缺一个 id 的数组，`prepareRecallRound` 的 `rejected` 也加 1，通知就成了「模型给 N 个词出的题没通过格式或防泄题检查」，实际其中一个是模型根本没给。功能不受影响。
3. **低：词库现成例句没有最小语境长度。** 复现：给 `resilient` 配英文释义和例句「A resilient system.」，`exampleQuestion` 会直接用它出题；单测只覆盖了「例句里没有目标词」返回 null。这类短句主要靠释义才能答，和 Hermes「语境要足够限定答案」有差距。模型草稿有至少 4 个其他词的门槛，现成例句没有。建议补一个最小词数或人工抽查 028 的 17 条例句。
4. **低：同词根匹配会误杀可用句子。** 复现：`questionFromDraft` 收到「The candidate gave a [[candid]] answer...」会按同族词拒用；词库例句含 `candidate` 也会被遮成 `___`，句子可能读起来不顺。不会泄题，只会少用句子；实现者已在结束报告里写明。
5. **低：023 e2e 的精听快捷键回归段被删。** 复现：`git diff -- app/dev/fixtures/vocab/recall/e2e.mjs` 可看到整段删除。`review-session/e2e.mjs` 仍覆盖相关工作，但建议确认这是有意为之、以后也不需要在 recall 脚本里保留。

验收结论：通过
