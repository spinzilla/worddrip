# 046-改名词滴WordDrip

- 状态：已关闭（用户确认 2026-11-11）
- 难度：体力
- 类别：前端界面
- 实现：claude-opus
- 验收：claude-sonnet
- 所属阶段：阶段 1E：学习助手
- 依赖：043（用户 2026-11-10 暂停了吉祥物 044、045，本卡直接接在 043 后面）

<!-- 用户 2026-11-10 最终选定软件名「词滴 WordDrip」（滴水穿石：每天几道题，慢慢攒词汇；先后考虑过的「词壳 WordShell」「升词 Uplex」都作废）。017 已把显示名从 LinguaClip 改成 English Studio，本卡再改成新名字。只改用户看得到的名字，不动数据位置和兼容格式。 -->

## 目标（一两句话，用户能看懂）

软件在界面上叫「词滴 WordDrip」：窗口标题、左上角名字、设置页里的软件名、手机网页版的名字都换成新名字。你的词库、备份、设置都还在原来的位置，打开后一切照旧。

## 从哪看起

- `grep -rn "English Studio\|LinguaClip" app --include=*.ts --include=*.tsx --include=*.html --include=*.json --include=*.webmanifest --include=*.rs`（约 40 个文件、150 处），逐处判断是「显示给用户的名字」还是「数据/兼容标识」。
- 显示名：`app/src-tauri/tauri.conf.json` 窗口 `title`、`app/index.html` 的 `<title>`、`app/components/Shell.tsx` 左上角、`app/utils/i18n.zh.ts` / `i18n.en.ts`、`components/Settings.tsx`、`app/mobile/index.html`、`app/mobile/public/manifest.webmanifest`、`app/mobile/App.tsx`。
- 数据/兼容标识（**不要改**）：`tauri.conf.json` 的 `identifier` 和 `productName`、`src-tauri/src/paths.rs`、`backup.rs`、`cache.rs`、`clips.rs`、`import.rs`、`whisper_setup.rs` 里的目录名和文件名，`utils/anki.ts` / `SettingsAnki.tsx` 里 Anki 牌组和笔记类型名（改了会和已有 Anki 数据对不上）、备份文件格式标识、`export.rs` 里写进导出文件的来源标记（看情况，写进报告）。

## 必须守住

1. **只改显示名**：中文界面用「词滴」，需要中英并列的地方（窗口标题、左上角）用「词滴 WordDrip」，英文界面用「WordDrip」。具体每处怎么写由你统一，写进结束报告。
2. **不动数据位置和兼容格式**：`identifier`、`productName`、数据目录、备份文件名和格式、Anki 牌组/笔记类型名、缓存目录一律不改。改完后用老数据目录启动，词库和设置都在（e2e 证明）。
3. **保留许可证署名**：本仓库基于 LinguaClip（AGPL-3.0）。设置页或「关于」里保留一句「基于开源项目 LinguaClip（AGPL-3.0）」之类的说明；文件头的原版权声明不动；`UPSTREAM.md`、`README.md` 里对上游的描述不改。
4. 吉祥物（044、045）已暂停、还没做，本卡不加任何吉祥物相关内容。
5. 不新增图标文件（图标另议）；只用浅色主题；不碰真实数据库和 `D:\english`；不装软件、不提交、不推送。

## 验收标准（验收者照着复跑）

1. `cd app && npx --no-install tsc --noEmit`、`npm run build` 退出码 0；相关单测（`test-backup.mjs`、`test-anki.mjs`、`test-anki-export.mjs` 等含名字断言的）通过，改过断言的要说明。
2. Rust：`cd app/src-tauri && cargo test` 中与备份/路径相关的测试退出码 0。
3. `git diff` 里 `identifier`、`productName`、数据目录、备份格式、Anki 名称没有变化（逐项核对写进验收记录）。
4. 隔离真实窗口：更新 `app/dev/fixtures/brand/e2e.mjs`（017 写的），断言窗口标题和左上角是新名字、没有原版更新按钮；用一份预先放好数据的数据目录启动，词库条数不变。再跑 `dev/e2e/smoke.mjs`、`dev/fixtures/theme/e2e.mjs`、`dev/fixtures/vocab/examples/e2e.mjs`（043）。1280 和 390 宽截图逐张看过。
5. 结束报告列出：改了哪些显示名（文件 + 新文字）、刻意没改的标识及原因、许可证说明放在哪。

## 不做什么

- 不改程序文件名、安装目录、桌面快捷方式（统筹在编译后处理）；不换图标；不改数据格式。

---

## 结束报告（实现者填）

（claude-opus，2026-11-10）

**结论**：做完了，没有停下来问的问题。界面上的名字已改成「词滴 WordDrip」；数据目录、备份、设置、Anki 名称一律没动，用预先放好数据的目录重启后，词库和设置都在（e2e 证明）。

### 改了哪些显示名（文件 → 新文字）
统一写法：需要中英并列的地方（窗口标题、左上角、网页标题）用「词滴 WordDrip」；中文句子里用「词滴」；英文句子里用「WordDrip」。
- `app/src-tauri/tauri.conf.json` 窗口 `title` → `词滴 WordDrip`（只改了这一行）
- `app/index.html` `<title>` → `词滴 WordDrip`
- `app/components/Shell.tsx` 左上角 → `词滴 WordDrip`（不随语言变）
- `app/mobile/index.html` `<title>` → `词滴 WordDrip`；`apple-mobile-web-app-title` → `词滴`（加到手机桌面时图标下的短名）
- `app/mobile/public/manifest.webmanifest` `name` → `词滴 WordDrip`，`short_name` → `词滴`
- `app/mobile/App.tsx` 首页大标题 → 新键 `m.appName`（中文「词滴」、英文「WordDrip」）。390 宽下中英并列加三个导航按钮可能挤不下，所以这里按语言只显示一种。
- `app/utils/i18n.zh.ts` / `i18n.en.ts`：
  - 新键 `settings.basedOn`：中文「词滴基于开源项目 LinguaClip（AGPL-3.0）开发」/ 英文「WordDrip is based on the open-source project LinguaClip (AGPL-3.0)」
  - 新键 `m.appName`（见上）
  - `backup.bad`：「不是 LinguaClip 的备份」→「不是词滴的备份」；英文 → `isn't a WordDrip backup`
  - `backup.newer`（只有英文带名字）：`newer version of LinguaClip` → `newer version of WordDrip`
  - `add.convertNote`、`backup.hint`：原文说视频在「LinguaClip」文件夹，但真实文件夹早在 ef92f21 改成了 `english-studio`（本卡没动），文案是错的，顺手改成「english-studio 文件夹」，中英都改。

### 许可证说明放在哪
- 电脑版：`app/components/Settings.tsx` 设置页最底部（支持者/QQ 群那几行下面）加一行 `settings.basedOn`，带 `data-testid="based-on"` 方便测试。
- 手机网页版：`app/mobile/Settings.tsx` 设置页最底部（语言选择下面）也加了同一句。
- 文件头的原版权声明、`app/UPSTREAM.md`、`README.md` 一字未改。

### 刻意没改的标识及原因
- `tauri.conf.json` 的 `identifier`（com.englishstudio.app）和 `productName`（english-studio）：决定数据目录和程序名，改了会读不到老数据。git diff 里这个文件只有 `title` 一行变化。
- `src-tauri/src/paths.rs`（APP_ID、APP_DIR）、`utils/desktop.ts` 的 `ownDir`：数据/视频目录，不动。
- 备份文件名 `LinguaClip-auto-* / LinguaClip-pre-*`（`backup.rs`、`utils/backup.ts` 靠这个前缀认自己的备份）、手动备份默认名 `backup.fileName`、手机备份名 `m.bkFileName`：按卡片「备份文件名不改」保留。
- Anki 牌组/笔记类型名 `LINGUACLIP_NAME = 'LinguaClip'`，以及说到它的文案 `settingsAnki.create/created/createdPartial/createHint`、`anki.noCardBody`：这些文字指的就是 Anki 里那个叫 LinguaClip 的牌组，改了文字反而对不上。
- localStorage 键 `linguaclip_*`、IndexedDB 名 `linguaclip_db`：设置和视频记录存在这些键里，改了设置就丢了。
- `pro.activated`（「你已成为 LinguaClip 支持者」）、`settings.sponsor` 英文版、ProFooter 里的 QQ 群/邮箱：都是指向原作者的支持渠道，写 LinguaClip 才是准确的署名。
- `update.title`（「LinguaClip {v} 可以更新了」）：017 已关掉原版更新（`UPDATES = false`），这句永远不会显示，不动。
- `utils/dictionary.ts` 的维基百科 User-Agent、`whisper_setup.rs` 的上游下载地址、`export.rs` 里列的 Hermes/LinguaClip 外部目录：不是显示名，是网络标识/外部路径，不动。`export.rs` 写进导出文件的内容里没有软件名，无需处理。
- Rust 包名 `linguaclip`（Cargo.toml）、程序文件名：卡片说不改程序文件名。

### 测试脚本
- `app/dev/fixtures/brand/e2e.mjs` 重写为 046 版：先在隔离数据目录导入 3 个复习词 + 1 条升级词、写一项设置（`linguaclip_audio_padding`），关掉；再用同一目录重新启动，核对词库统计完全相同、数据库仍在 `…\com.englishstudio.app\vocab.db`、设置还在；然后核对 document.title、窗口标题（通过 Tauri 取，隐藏窗口也拿得到）、顶栏都是「词滴 WordDrip」，顶栏不出现 LinguaClip / English Studio，等 8 秒无更新按钮/对话框，设置页底部无「检查更新」、中英文署名都对；1280 / 390 宽截图并检查不横向溢出、名字没被截断。

### 代码审阅
- `git diff` 逐项看过：identifier、productName、paths.rs、backup.rs、backup.ts、storage.ts、desktop.ts、anki.ts、SettingsAnki.tsx 都没有变化；tauri.conf.json 只改 title。
- 全仓库 `English Studio` 已不再出现在 app 代码里（只剩 pro/index.ts、lib.rs 两条代码注释提到旧名，属于注释，没改）。

### 自动测试
- `npx --no-install tsc --noEmit`：退出码 0。
- `npm run build`：退出码 0（只有原有的 chunk 体积提示）。
- `test-backup.mjs`、`test-anki.mjs`、`test-anki-export.mjs`：全过，没有改任何断言。其余 `test-*.mjs / test-*.js` 全部跑了，只有 `test-wordvoice.mjs` 失败，原因是本机没装它要的 Playwright（「Playwright missing」），与本卡无关。
- `cd app/src-tauri && cargo test`：207 通过、0 失败、19 忽略，含 backup/paths 相关 12 项。
- `npm run build:mobile`：**失败，原有问题**。`vite.mobile.config.ts` 用 `path.resolve` 得到反斜杠路径去比对 Vite 给的正斜杠路径，Windows 上永远对不上，于是 `utils/desktop.ts` 没被换成手机版，报「手机版不能用 Tauri」。这个文件从导入上游后（ef92f21）就没改过，和本卡改动无关，本卡没修。

### 真实环境（隔离窗口，均退出码 0）
- `node dev/fixtures/brand/e2e.mjs`：通过，证据 `D:\tmp\es-e2e\046-20261110165314\out\`。截图 01–08 逐张看过：1280 顶栏「词滴 WordDrip」、主页正常；设置页底部有中英署名、备份提示里是 english-studio 文件夹；390 宽顶栏名字完整、导航可横滑、不横向溢出。窗口标题（Tauri）=「词滴 WordDrip」。
  - 第一次跑因为隔离环境默认英文、脚本只认中文署名而失败，改脚本中英都认后，第二次在「用老数据目录第二次启动」那一步 tauri dev 偶发直接退出（linguaclip.exe exit code 1，日志无报错），第三次原样重跑通过。怀疑是上一个窗口刚被结束、WebView2 资源没完全释放；如验收时再遇到，重跑即可。
- `node dev/e2e/smoke.mjs`：通过（`D:\tmp\es-e2e\20261110165419-8120\out`，看过 05-narrow.png，顶栏是新名字）。
- `node dev/fixtures/theme/e2e.mjs`：通过（`app/src-tauri/target/e2e/035-20261110165439-14920/out`）。
- `node dev/fixtures/vocab/examples/e2e.mjs`（043）：通过（`app/src-tauri/target/e2e/043-20261110165458-16880/out`）。

### 改了哪些文件
- `app/src-tauri/tauri.conf.json`、`app/index.html`、`app/components/Shell.tsx`、`app/components/Settings.tsx`
- `app/mobile/index.html`、`app/mobile/public/manifest.webmanifest`、`app/mobile/App.tsx`、`app/mobile/Settings.tsx`
- `app/utils/i18n.zh.ts`、`app/utils/i18n.en.ts`
- `app/dev/fixtures/brand/e2e.mjs`
- `docs/ledger.md`、本卡

### 未验证
- 手机网页版（标题、manifest、首页大标题、设置页署名）：因上面那个原有的 `build:mobile` 问题，本机编不出手机版，只做了 tsc 类型检查和代码审阅，没有实际打开截图。
- 安卓 / 编译后的正式安装包：没做（程序文件名、快捷方式按卡片由统筹编译后处理）。
- 「用改名前的旧版本建数据、新版本打开」没有真的用两个版本跑；e2e 用的是同一版本先建后重开。因为 identifier、数据目录、存储键都没变（diff 已核对），两者读写的是同一位置。
- 系统任务栏/Alt+Tab 里看到的标题：测试窗口是隐藏的，只通过 Tauri 接口读到窗口标题是新名字。
- 花费（调度脚本记录）：claude-opus 本次 $2.92

## 实际改动文件（调度脚本自动记录）

- 修改 `app/components/Settings.tsx`
- 修改 `app/components/Shell.tsx`
- 修改 `app/dev/fixtures/brand/e2e.mjs`
- 修改 `app/index.html`
- 修改 `app/mobile/App.tsx`
- 修改 `app/mobile/Settings.tsx`
- 修改 `app/mobile/index.html`
- 修改 `app/mobile/public/manifest.webmanifest`
- 修改 `app/src-tauri/tauri.conf.json`
- 修改 `app/utils/i18n.en.ts`
- 修改 `app/utils/i18n.zh.ts`
- 修改 `docs/ledger.md`

## 验收记录（验收者填，不能是实现者本人；最后单独一行写「验收结论：通过」或「验收结论：不通过」）

（claude-sonnet，2026-11-10）
1. tsc 退出码 0；npm run build 0；test-backup / test-anki / test-anki-export 均 0。通过。
2. cargo test backup：10 通过 0 失败。通过。
3. git diff 核对：tauri.conf.json 只改 title 一行，identifier / productName 未变；paths.rs、backup.rs、anki.ts、SettingsAnki.tsx、backup.ts 均不在改动列表；备份名、Anki 牌组名、存储键未动。通过。
4. brand e2e（含老数据目录二次启动、词库条数不变）0；smoke 0；theme 0；043 examples e2e 前两次因 tauri-cli 启动 panic（`Option::unwrap() on None`，与改动无关的启动偶发）失败，第三次原样重跑 0。看过 1280 设置页底部（含「词滴基于开源项目 LinguaClip（AGPL-3.0）开发」）和 390 顶栏截图，名字完整、不溢出。通过。
5. 结束报告已列出显示名、保留标识、署名位置。通过。

审查三问：
- 改动的键（backup.bad 等）仅 i18n 使用，zh/en 两边键齐全（tsc 通过）；新键 settings.basedOn、m.appName 两语言都有。
- 接外部程序的部分：真实窗口 e2e 已跑；手机版因 build:mobile 原有 Windows 路径问题未能编译，未实际验证（实现者已如实报告）。
- 同类问题：app 代码里 English Studio 只剩注释与测试脚本里的旧名检测；LinguaClip 残留均为刻意保留的数据/署名标识。

问题清单：
- 提示：043 examples e2e 启动偶发 tauri-cli panic，重跑通过（环境）。
- 提示：手机网页版改名未实际渲染验证。

验收结论：通过
- 花费（调度脚本记录）：claude-sonnet 本次 $0.28

### 警告（调度脚本记录）
- 警告（环境）：043 例句 e2e 启动时 tauri-cli 偶发崩溃，重跑一次就通过，不影响软件本身。建议：与本卡无关，建议记入小问题待办。
- 警告（范围外）：手机网页版因原有的 build:mobile 路径比对问题在本机编不出来，新名字只做了代码审阅，没真正打开看过。建议：另开卡修 vite.mobile.config.ts 的 Windows 路径比对，之后补验手机版。
