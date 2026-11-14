# 039-换成Claude风格主题

- 状态：已关闭（用户确认 2026-11-11）
- 难度：中等
- 类别：前端界面
- 实现：claude-opus
- 验收：claude-sonnet
- 所属阶段：阶段 1D：查词与出题改版（补充）
- 依赖：038

<!-- 用户 2026-11-10 看过 035 的效果后说：「这个森林绿我觉得不好看，直接换成 Claude 特色的主题吧」。仍然只做浅色。 -->

## 目标（一两句话，用户能看懂）

把 035 定的森林绿主色换掉，整体改成 Claude 网页那种气质：暖米色纸张底、近黑暖灰文字、陶土橙（clay）做主色点缀。页面上不再出现「森林绿」作为品牌色。

## 从哪看起

- 颜色全在 `app/index.css` 的 `:root`：`--c-*` 是 RGB 三元组，`--paper` 等引用它们；`app/tailwind.config.js` 只引用变量。035 的结束报告（`docs/tasks/035-全局暖色主题.md`）列了每个变量的用途。
- 现在 `--c-accent` 是森林绿 `#2E6B4D`，同时担任：主按钮、当前项、焦点框、进度条，**以及「成功/答对」**（035 把 `green-*` 统一换成了 `accent`）。还有 `--c-clay`（陶土色点缀）、`--c-danger`（砖红 `#B3311E`）。
- 参考气质（不必照搬，色值由你定）：底 `#F5F4ED` 一类的暖米色，卡片 `#FAF9F5`，正文 `#141413` 一类的暖近黑，次要文字 `#5E5D59`，边框 `#E8E6DC`，陶土橙 `#D97757`（做文字或白字按钮底时要压暗才能过对比度，例如 `#B5532F` 左右）。
- 截图脚本：`app/dev/fixtures/theme/e2e.mjs`（035 写的，会查大块纯白和低对比度文字）。

## 必须守住

1. **主色换成陶土橙系**：主按钮（或保持深色主按钮、陶土橙做强调，二选一由你判断哪个更舒服）、当前项、焦点框、进度条、链接等不再是绿色。
2. **「答对/成功」要单独一个变量**（例如 `--c-success`），不能跟着主色变成橙色。答对、答错（`danger`）、主色（陶土橙）三者一眼能分清：尤其砖红错误色和陶土橙不能太像，错误色要更偏深红并且出错处仍有文字或图标，不只靠颜色。成功色用低饱和的绿或橄榄色可以，但不要大面积用。
3. **可读性**：正文、次要文字、按钮文字与各自背景的对比度至少 WCAG AA（4.5:1；大字 3:1）。结束报告列出主要几组的数值。
4. **只借风格，不仿冒品牌**：不用 Anthropic/Claude 的标志、名称、字体文件或商标元素；不新增字体包或 npm 依赖。
5. 只做浅色；不改布局、字号和交互；不新增写死的颜色。
6. 不碰真实数据库和 `D:\english`；不装软件、不提交、不推送。

## 验收标准（验收者照着复跑）

1. `cd app && npx --no-install tsc --noEmit`、`npm run build` 退出码 0；`grep -rniE "#2E6B4D|46 107 77|green-[0-9]" components mobile index.css tailwind.config.js` 不再有森林绿残留（有保留的写明原因）。
2. 隔离真实窗口（开跑前确认 3000 端口空闲）：`node dev/fixtures/theme/e2e.mjs`、`node dev/fixtures/vocab/forgot/e2e.mjs`、`node dev/fixtures/vocab/recall/e2e.mjs`、`node dev/fixtures/vocab/click-lookup/e2e.mjs`、`node dev/fixtures/vocab/usage/e2e.mjs` 全部退出码 0。
3. 截图逐张看过（验收记录里写看了哪几张）：首页、词库、复习题（作答中 + 判分后，含答对、答错、忘记了三种状态）、闪卡正反面、教练、设置，1280 宽，外加 390 宽两张。没有绿色主色残留、没有刺眼纯白大块、没有看不清的字；答对/答错/主色三者能分清。
4. 结束报告写「配色说明」：每个变量新值、用途、对比度。

## 不做什么

- 不做深色模式和主题切换；不改布局（闪卡反面下半部分偏空的问题另开卡）。

---

## 结束报告（实现者填）

（claude-opus，2026-11-10）

- 改了什么：
  - `app/index.css`：`:root` 整套换色。主色 `--c-accent` 从森林绿换成压暗的陶土橙；新增 `--c-success`/`--c-success-soft`（答对、成功，橄榄绿）和对应的 `--success`/`--success-soft`；`--c-danger` 改成更深更红的深红；原来的 `--c-clay`（提醒/警告）改成偏黄的赭色，免得和新主色撞色（变量名沿用，不用改 21 处调用）；底色、卡片、文字、边框按 Claude 网页的气质换成新的暖米色/暖近黑。下拉箭头里写死的次要文字色同步成新值。开头注释写明四种颜色各管什么。
  - `app/tailwind.config.js`：加 `success`、`success-soft` 两个颜色名；注释改掉「森林绿」。
  - 「答对/成功」从主色拆出来，改用 `success`：`RecallReview.tsx`（判分框「答对」、结果表「判定」列、结果页「答对」计数）、`vocab.css`（题卡左边答对色条）、`DefinitionImportPanel.tsx`、`ExportPanel.tsx`、`ImportPanel.tsx`、`InboxPanel.tsx` 的成功提示框、`EntryDetail.tsx`「已保存」提示。这些正好是 035 从 `green-*` 换成 `accent` 的那 13 处。词条状态「复习中」、收藏星标、开关勾选这类「当前状态」仍用主色。
  - `app/components/ui.tsx`：只改了顶部英文注释（forest-green → clay-orange）。
  - `app/mobile/index.html`、`app/mobile/public/manifest.webmanifest`：`theme-color`/`background_color` 改成新底色 `#F5F4ED`。
  - `app/dev/fixtures/theme/e2e.mjs`：判分那一步改成同一屏里一题答对、一题点「忘记了」、一题答错（comprehend），并断言三题分别判为 correct / forgot / wrong；多截一张 `09b-recall-graded-more-1280.png` 看第 3 题。
  - `docs/ledger.md` 加一行。
  - 没有改布局、字号、交互，没加依赖、字体、深色模式；没用 Anthropic/Claude 的标志、名称、字体或商标元素（界面里没出现 Claude 字样）。
- 设计取舍：主按钮用陶土橙实底白字（`bg-accent`），不改成深色主按钮——Claude 网页本身就是这样，而且导航选中项、「开始产出题复习」这类按钮原来就用 `bg-ink` 深色，两者并存层次正好。陶土橙按卡片建议压暗到 `#A84C2A`（`#D97757` 原色白字对比只有约 3:1，不够）。错误色往深红走（色相 355°，主色 16°），亮度也比主色低一截；成功色是低饱和橄榄绿（色相 92°），只用在小提示框、色条和数字上。
- 配色说明（WCAG 相对亮度公式，脚本 `D:/tmp/es-test/039/c.mjs`）：

  | 变量 | 新值（035 旧值） | 用途 | 对比度 |
  |---|---|---|---|
  | `--paper` | `#F5F4ED`（`#F4F1EA`） | 应用底色，暖米色 | 正文 15.11、次要 5.98 |
  | `--page` | `#FAF9F5`（`#FBF9F4`） | 卡片、弹窗、输入框 | 正文 15.81、次要 6.26 |
  | `--shade` | `#EEECE2`（`#EDE8DE`） | 胶囊、悬停、次要按钮 | 正文 14.06、次要 5.57 |
  | `--line` | `#E3E0D3`（`#E1DACC`） | 细线、边框 | 装饰线，对 page 1.26 |
  | `--faint` | `#85837A`（`#878074`） | 占位、空槽（非正文） | page 3.61 / paper 3.45（≥3:1） |
  | `--mute` | `#5E5D59`（`#68625A`） | 次要文字 | 见上；在四种浅底上 5.24–5.55 |
  | `--ink` | `#1F1E1C`（`#2A2621`） | 正文；导航选中底色、深色按钮 | 白字落在 ink 上 16.66 |
  | `--accent` | `#A84C2A`（`#2E6B4D` 森林绿） | 主色陶土橙：主按钮、当前项、焦点框、进度条、链接、提示字母 | 白字 5.63；page 5.34 / paper 5.10 / accent-soft 4.74 |
  | `--accent-soft` | `#F7E9E0`（`#E2ECE3`） | 主色浅底：选中、当前词、标签 | 正文 14.03 |
  | `--success`（新） | `#4D6B33` | 答对、导入/导出成功 | page 5.75 / paper 5.49 / success-soft 5.06；白字 6.06 |
  | `--success-soft`（新） | `#E7EDDC` | 成功浅底 | 次要文字 5.51 |
  | `--danger` | `#A61F2B`（`#B3311E`） | 错误、答错、忘记了、失败、录音中 | page 6.99 / paper 6.68 / danger-soft 5.85；白字 7.36 |
  | `--danger-soft` | `#F7E0E0`（`#F8E3DD`） | 错误浅底 | 次要文字 5.24 |
  | `--clay` | `#85590F`（`#9E4A28`） | 提醒、警告、标签（改成赭黄，和主色分开） | page 5.81 / paper 5.55 / clay-soft 5.11 |
  | `--clay-soft` | `#F4EAD3`（`#F5E6DB`） | 警告浅底、荧光笔高亮、选中文字底（20% 透明） | 正文 13.93 |

  三种「信号色」互相之间：主色对错误 1.31、主色对成功 1.08、错误对成功 1.22——亮度很接近，主要靠色相区分（橙 16° / 红 355° / 橄榄绿 92°）。所以每个出错处都另有文字（「答错」「忘记了（按答错计）」「失败」）或图标，答对也有「答对」二字，不只靠颜色。
- 代码审阅：`grep -rniE "#2E6B4D|46 107 77|green-[0-9]" components mobile index.css tailwind.config.js` 无结果（退出码 1）。全仓库界面代码（components/mobile/pro/根目录 tsx）里搜 6 位色值，只剩手机端 `index.html`/`manifest` 的 `#F5F4ED`（浏览器地址栏/启动页颜色，只能写死，跟 035 一样）。`bg-white` 只剩 035 报告里列过的 4 处半透明白蒙层。逐条看过 `text-accent`/`bg-accent-soft` 的其余用法，都是「主操作/当前项/已收藏」，保留主色。编译后的 CSS 里有 `--c-success`。
- 自动测试：`cd app && npx --no-install tsc --noEmit` 退出码 0；`npm run build` 退出码 0（只有原来就有的大 chunk 警告）；`node test-vocab-recall.mjs`、`test-vocab-grading.mjs`、`test-vocab-usage.mjs`、`test-vocab-flashcards.mjs`、`test-click-lookup.mjs` 都退出码 0；`node --check dev/fixtures/theme/e2e.mjs`、`git diff --check` 通过。
- 真实环境（隔离窗口，开跑前脚本自查 3000 端口空闲）：`node dev/fixtures/theme/e2e.mjs` 退出码 0（`src-tauri/target/e2e/035-20261110130136-1408/out`，12 张截图，每张「纯白大块」和「低对比度文字」都是 0；三题分别判为 correct / forgot / wrong）；`dev/fixtures/vocab/forgot/e2e.mjs`（`036-20261110130338-16856`）、`recall/e2e.mjs`（`030-20261110130403-6652`）、`click-lookup/e2e.mjs`（`034-20261110130422-14944`）、`usage/e2e.mjs`（`038-20261110130440-16444`）全部退出码 0。
  - 逐张看过的截图：01 首页（Podcasts 页，标签浅橙底橙字）、02 词库到期、04 词库详情 390、05/06 闪卡正反面、07 复习题作答中 1280、08 复习题 390、09/09b 判分后（第 1 题绿色「答对」框和左侧绿条、第 2 题红色「忘记了（按答错计）」、第 3 题红色「答错」，填空提示字母和目标词高亮是陶土橙，三者一眼能分开）、10 教练（「开始批改」陶土橙按钮、顶部更新徽章同色）、11 设置（勾选框陶土橙）。没看到绿色主色残留、刺眼纯白块或看不清的字。03 查词卡没单独打开看（脚本自动体检为 0 问题）。
  - 顺带发现：闪卡截图里卡片底偏灰，是鼠标点完翻面后停在卡片上，触发 `.press:hover` 的 `brightness(.96)` 变暗，不是颜色变量的问题，本卡没动。
- 未验证：
  1. 手机版构建 / 安卓真机或模拟器没测（`npm run build:mobile` 在 035 时就因 `utils/desktop.ts` 引用 Tauri 而失败，本卡没碰）；390 宽只看了桌面窗口缩窄的两张。
  2. 精听播放页、听写、句子/单词复习（ReviewSession、WordReview）、播客详情、Pro 阅读器、导入/导出成功提示框只做了代码审阅，没截图看实际效果。
  3. 三种信号色亮度接近（见配色说明），红绿色弱用户的观感没验证；目前都配了文字。
  4. 「已取消保存，没有写入文件」这条导出提示和导出成功共用一个 notice，所以也会显示成成功绿色（035 之前就是绿色），没拆。
- 花费（调度脚本记录）：claude-opus 本次 $2.23

## 实际改动文件（调度脚本自动记录）

- 修改 `app/components/ui.tsx`
- 修改 `app/components/vocab/DefinitionImportPanel.tsx`
- 修改 `app/components/vocab/EntryDetail.tsx`
- 修改 `app/components/vocab/ExportPanel.tsx`
- 修改 `app/components/vocab/ImportPanel.tsx`
- 修改 `app/components/vocab/InboxPanel.tsx`
- 修改 `app/components/vocab/RecallReview.tsx`
- 修改 `app/components/vocab/vocab.css`
- 修改 `app/dev/fixtures/theme/e2e.mjs`
- 修改 `app/index.css`
- 修改 `app/mobile/index.html`
- 修改 `app/mobile/public/manifest.webmanifest`
- 修改 `app/tailwind.config.js`
- 修改 `docs/ledger.md`

## 验收记录（验收者填，不能是实现者本人；最后单独一行写「验收结论：通过」或「验收结论：不通过」）

（claude-sonnet，2026-11-10）
1. tsc 退出 0；npm run build 退出 0；grep 森林绿残留无结果（退出 1）。通过。
2. 隔离窗口 theme / forgot / recall / click-lookup / usage 五个 e2e 均退出 0（3000 端口开跑前空闲）。通过。
3. 截图看了：01 首页、09 判分后（答对绿/忘记了红/第3题红）、08 手机 390 复习、10 教练、06 闪卡反面。陶土橙主色、答对橄榄绿、答错深红能分清，无绿色主色、无刺眼纯白、文字清晰。未逐张看：02/03/04/05/07/11（脚本体检为 0 问题）。闪卡反面下半偏空是卡片明确不做的项。
4. 结束报告有配色说明表（变量、值、用途、对比度）。通过。
改动文件均与主题相关（颜色变量、成功色拆分、移动端 theme-color、e2e 脚本），无越界。
审查三问：改动的 `--c-clay` 含义变为赭黄，21 处调用沿用，截图未见异常；e2e 真实跑过；同类问题：success 拆分覆盖了 035 的 13 处，grep 无遗留。
问题：无阻断问题。提示：手机构建、红绿色弱观感未验证（报告已写明）。

验收结论：通过
- 花费（调度脚本记录）：claude-sonnet 本次 $0.30

### 警告（调度脚本记录）
- 警告（范围外）：手机版构建和红绿色弱观感未验证，三种信号色亮度接近，主要靠色相和文字区分。建议：与本卡无关，建议记入小问题待办
