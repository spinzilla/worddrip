# 003-跑通Windows开发版

- 状态：已关闭（实现：@dsh；独立复核：@Codex；最终听写确认：用户；2026-11-04）
- 所属阶段：阶段 0
- 依赖：001、002 已关闭

## 目标（一两句话，用户能看懂）

在本机用 `npx tauri dev` 把 app 启动起来，导入一段带字幕的视频，完整做一次听写。

## 做法

1. `cd app`，`npm install --registry=https://registry.npmmirror.com`（只在这条命令里指定镜像，不改全局 npm 配置）。
2. `npx tauri dev`。第一次编译 Rust 依赖会比较慢（10–20 分钟），用后台运行，不要反复重启。
3. 测试素材：从 `%USERPROFILE%\Videos\LinguaClip\` 里**复制**一段短视频和它的 `.srt` 到 `D:\tmp\es-test\`（原文件只读），在 app 里导入复制件。不走 whisper 转写（避免下载 580MB）。
4. 完成至少 3 句听写，截图：启动界面、听写进行中、听写结果，浅色、深色各一张。
5. 确认数据写进了 `%LOCALAPPDATA%\com.englishstudio.app\`，而且 `%LOCALAPPDATA%\com.linguaclip.app\` 的修改时间没变。

## 允许改动的路径

- `app/package-lock.json`（npm 生成）
- `D:\tmp\es-test\`（临时，用完可删）
- `%LOCALAPPDATA%\com.englishstudio.app\`（app 运行时自己写入）
- 本卡片
- 如果编译报错要改代码：**先回报**，不要自己改

## 验收标准（验收者照着复跑）

1. 新开终端，`cd app; npx tauri dev`，窗口能打开、界面没有乱码。
2. 导入测试视频和 srt，能逐句听写，错词有标记。
3. `%LOCALAPPDATA%\com.linguaclip.app\` 的修改时间在测试前后没有变化。
4. **用户本人**亲手做一次听写并确认可以用（最终验收）。

## 不做什么

- 不打安装包（`tauri build`），不做安卓，不改功能。

---

## 结束报告（实现者填）

- 改了什么：`npm install --registry=https://registry.npmmirror.com`（155 包，`package-lock.json` 无变更）。**用户 2026-11-04 批准后的两处环境修复**：①删除用户环境变量 `CFLAGS`（原值 `-std=c11 -Wall -Wextra -g`，备份在 `D:\tmp\es-test\cflags-backup.txt`）；②`app/vite.config.ts` 的 `server` 加 `watch: { ignored: ['**/src-tauri/**'] }`（超出本卡「允许改动路径」，已经用户确认，同步记进 `app/UPSTREAM.md`）。测试素材与自动化脚本都在 `D:\tmp\es-test\`。
- 代码审阅：读了一遍导入与听写的关键路径（`AddVideo.tsx`、`DictationLine.tsx`、`shortcutActions.ts`、`paths.rs`、`vite.config.ts`），确认三件事：①视频 + 自带 srt 走 `practiceWithSubtitles` 直接进练习，不触发 whisper；②每个单词一个输入框，粘整句到剪贴板 Ctrl+V 可一次填满所有空，Enter 在最后一格才是提交、在中间格是跳下一格；③`paths.rs` 的媒体目录是 `%USERPROFILE%\Videos\LinguaClip`，不是 `%LOCALAPPDATA%`。
- 自动测试：`npm install` 后 `node_modules/.bin/{esbuild,tauri,vite}` 均能报版本（0.25.12 / tauri-cli 2.11.5 / vite 6.4.1）。Rust 侧未跑 `cargo test`（不在本卡范围）。
- 真实环境（本机 Windows 11，全部实跑）：
  1. **编译**：`cargo` 519 个 crate，dev profile 1 分 06 秒完成，无 error（`linguaclip (lib)` 1 条 warning）。
  2. **启动 + 导入**：从「视频」页 → 添加视频 → 选 `es-test-4-lines.mp4` → 选 `es-test-4-lines.srt` → 开始练习。列表显示 `0/4 句`，进入「这次怎么练」选「按段从头练」。
  3. **听写 4 句全走完**：第 1 句故意打错一个词 → 红下划线 + 「应为: nine」+「6 个词对了 4 个」；第 2 句 5/6（句末句号算进输入导致 yesterday 判错）；第 3、4 句 6/6、7/7 全对；结束页显示「完 — 你练完了 "es-test-4-lines.mp4" 的每一句。4 句 / 0 收藏」。
  4. **数据落盘**：`%LOCALAPPDATA%\com.englishstudio.app\` 新建（23 MB，含 `EBWebView`、`logs`）；IndexedDB 文件里能 `strings` 出 `es-test-4-lines.mp4` / `.srt` 和两句字幕原文。`%LOCALAPPDATA%\com.linguaclip.app` 修改时间仍是 **2026-10-26 20:40:39**（测试前记录的基线一致）→ 验收标准 3 通过。
  5. **测试素材**：`%USERPROFILE%\Videos\LinguaClip\` 里只有 srt/json 没有视频，所以用 SAPI（Zira en-US）合成 4 句语音 + ffmpeg（`D:\oopz\ffmpeg.exe`，现成二进制，没装东西）拼成 16.5 秒 mp4，srt 时间轴按下式对齐，**没有碰那个只读目录**。
  6. **截图**：`D:\tmp\es-test\shot-13-dictation.png`（进行中/空格）、`shot-23-feedback.png`（错词标记）、`shot-31.png`（全对）、`shot-34-result.png`（完成页）、`shot-05-add.png`（导入对话框）。
  7. **踩到的两个坑**（都是环境问题，已绕开）：
     - `ring v0.17.14` 编译失败，cl.exe 报 `D8021 无效的数值参数 "/Wextra"`。根因：**用户环境变量 `CFLAGS=-std=c11 -Wall -Wextra -g`**（001 之后留下的），被 cc-rs 原样传给 MSVC。处理：构建命令里 `unset CFLAGS`，没动系统设置。
     - `npx tauri dev` 崩在 vite：`EBUSY ... src-tauri/target/debug/build/...exe`，vite 默认监视整个项目根，Windows 上 target 里的 exe 被占用。处理：`CARGO_TARGET_DIR=D:\tmp\es-test\target` 把产物挪出项目目录，**没改 `vite.config.ts`**。
- 未验证 / 做不了：
  1. **深色截图做不了**：上游只有一套浅色「Cinema」配色（`tailwind.config.js` 无 `darkMode`，`index.css` 里 `dark` 命中 0 次），不存在深色主题。
  2. **卡里第 4 条（用户本人亲手听写）未做**，等用户验收。
  3. **用户按卡里原命令 `cd app; npx tauri dev` 会复现上面两个坑**（CFLAGS + EBUSY）。→ **已解决并复验**（2026-11-04，用户批准后）：删掉 `CFLAGS` 用户变量 + `vite.config.ts` 加 `watch.ignored`，然后用「新开终端等效环境」（PATH 从注册表重建、`CFLAGS`/`CARGO_TARGET_DIR` 均不存在）跑 `npx tauri dev`：编译通过、窗口打开、vite 监听 3000（PID 25716）、**没有 EBUSY**；列表自动恢复上次记录「es-test-4-lines.mp4 · 4/4 句 · 已练完」「最近 7 天练了 1 天 · 今天 4 分钟」，证明数据是持久化的、不是内存态。截图 `D:\tmp\es-test\shot-40-cleanstart.png`。
  4. 没打安装包（`tauri build`），没做安卓，没跑 whisper 转写。
  5. 干净复跑用的是 `app/src-tauri/target`（4.8 GB）；`D:\tmp\es-test\target` 那次 4.8 GB 是绕 EBUSY 时的产物，两处都可删。

---

## 验收反馈修复（2026-11-04 第二轮，实现者：@dsh）

验收结论：**暂不通过**，列了三条。逐条处理如下，代码改动均经用户 2026-11-04 确认。

### 一、数据隔离不完整 —— 已修

**问题成立，而且已经真实发生过**：修复前那次启动（08:27）在 `%USERPROFILE%\Videos\LinguaClip\backups\` 里写下了 `LinguaClip-auto-2026-11-04.zip`（1197 B），这正是「写只读来源」。

改动（4 个文件）：

| 文件 | 改动 |
|---|---|
| `src-tauri/src/paths.rs` | 新增 `APP_ID = "com.englishstudio.app"`、`APP_DIR = "english-studio"`、`app_data_dir()`；`own_dir()` 由 `Videos\LinguaClip` 改为 `Videos\english-studio` |
| `src-tauri/src/whisper_setup.rs` | `parts_dir()` 改为 `app_data_dir().join("whisper")`；`convert` / `dicts` / `ja-dict` 三个目录都由它 `with_file_name` 派生，**一处改、四处生效** |
| `src-tauri/src/ja_dict.rs` | 测试断言不再写死 `com.linguaclip.app`，改为断言目录**位于 `app_data_dir()` 之下**且末级名是 `ja-dict`——旧路径回来就会红 |
| `utils/desktop.ts` | `ownDir()` 同步改成 `english-studio`（缓存、片段、备份、导入下载都跟着走） |

新增两道防止回退的守卫测试（`paths.rs`）：`own_dir_is_this_apps_folder`、`app_data_dir_follows_the_identifier`，都断言路径里不含 `linguaclip`。

### 二、验收报告有错误 —— 已更正

`ja_dict` 那条你说对了：`dict_dir()` 由 `parts_dir()` 派生，实现和断言同源，**测试恒绿而不是必红**，我原报告「跑该单测会失败，属预期」是错的。002 与 003 的报告都已就地标注更正，断言本身也改成能真正抓到回归的写法。

### 三、mtime 不能证明文件未变 —— 改为文件级哈希

不再用目录时间戳。从修复后的构建开始，对两个只读来源做**全量 SHA-256 基线**，跑完一整套 4 句听写后再比：

| 目录 | 文件数 | 前后 diff |
|---|---|---|
| `%LOCALAPPDATA%\com.linguaclip.app` | 349 | **完全一致** |
| `%USERPROFILE%\Videos\LinguaClip` | 9 | **完全一致** |

同时确认写入落到了新位置：`Videos\english-studio\backups\LinguaClip-auto-2026-11-04.zip`（08:36 自动备份）。

### 复跑证据

- `cargo test --lib`：**111 passed / 0 failed / 18 ignored**（含两条新守卫 + 改写后的 `ja_dict` 断言）
- `npx tsc --noEmit`：退出码 0
- tauri dev 自动重建（08:37 新二进制），完整听写 4 句：6/6、6/6、6/6、7/7，结束页「4 句 / 0 收藏」
- 截图：`D:\tmp\es-test\shot-44.png`（进入练习）、`shot-45-l1.png`、`shot-46-l2.png`、`shot-47-l4.png`、`shot-48-result.png`
- 哈希基线：`hash-linguaclip-before/after.txt`、`hash-videos-before/after.txt`

### 仍未做 / 需要决定

1. **只读目录里那个备份文件**（`Videos\LinguaClip\backups\LinguaClip-auto-2026-11-04.zip`，1197 B，我造成的）——**用户 2026-11-04 批准后已删除**。删除前记录 SHA-256 `a8c365ad…0b29d6a5d0be4bc83898a0acb8bf07bbfc011a`（存 `D:\tmp\es-test\deleted-backup-sha.txt`）；删除后重算该目录：只剩原有的 3 个备份，其余 8 个文件哈希与基线完全一致（diff 只少这一行）。
2. 用户亲手听写（卡里第 4 条）：2026-11-04 用户反馈「听写没有问题」，最终确认已补齐，见下方验收记录。
3. 深色截图仍然做不了（上游无深色主题）。
4. 未跑 whisper / 转码 / 词典的真实下载流程，因此「新目录下这四个文件夹确实能建起来」只有单测与路径推导支撑，没有实机下载证据。


## 验收记录（验收者填，不能是实现者本人）

- 日期：2026-11-04。
- 验收人：@Codex（独立于实现者 @dsh），用户完成最终听写确认。
- 结论：**本卡通过并关闭，范围仅为 Windows 开发版的本地视频 + SRT 听写。** 用户在本聊天明确反馈「听写没有问题，你写任务卡吧」。本结论结合 Codex 的代码、定向测试、文件哈希复核与用户最终确认；不表述为 Codex 独立复跑过完整图形界面流程，也不自动关闭 002 或宣称其他模块可用。

### 对象版本

上游提交 `640b3802243e7abb75744bb34b1e17f9607d5168` 加当前未提交修复。写入本记录前再次计算以下 SHA-256，与复验时一致：

| 文件（相对 `app/`） | SHA-256 |
|---|---|
| `src-tauri/src/paths.rs` | `A10806D824CC577D17CBC1CDD07F5575961C0F56A16844343C965FFB6D3BFEB1` |
| `src-tauri/src/whisper_setup.rs` | `9D86AB0536A1FBDDEDFB4CAD4465502BDD71576478DE1514E76036963E534254` |
| `src-tauri/src/ja_dict.rs` | `B881EF5D82E1F89002CFF8473E1AF749CD17F5BE6D37B8610796DE4C4D770F12` |
| `utils/desktop.ts` | `C255D4721CE10C5ABDEF1C8DC14C56FE6790DF685C9AD08D4A6FE99C983BFC05` |

### 分项证据与边界

1. **代码审阅**：默认媒体目录为 `Videos/english-studio`；Whisper 部件目录为 `com.englishstudio.app/whisper`，转码、本地词典、日语词典目录由其派生；前端 `ownDir()` 与 Rust 一致。核对了 `paths.rs`、`whisper_setup.rs`、`ja_dict.rs`、`utils/desktop.ts` 及 `tauri.conf.json`。此前的默认目录串用问题已修复；不据此保证任意用户选择的文件路径均受只读保护。
2. **自动测试 / 受控行为**：Codex 独立执行 `tsc --noEmit`，退出码 0；在 `app/src-tauri` 执行 `cargo test --offline --locked --lib paths::tests -- --nocapture`（2 passed）及 `cargo test --offline --locked --lib ja_dict::tests::dict_sits_beside_the_whisper_parts -- --exact --nocapture`（1 passed）。证据为本聊天复验工具输出，未另存测试日志。未独立复跑全量测试；上文 111 passed 是实现者报告。复跑先遇沙箱锁文件拒绝访问，再遇 Codex 进程残留 `CFLAGS`；授权后刷新测试进程环境完成测试，未修改用户级或系统级设置。
3. **真实环境 / 文件核验**：Codex 独立重算 `%LOCALAPPDATA%/com.linguaclip.app` 的 349 个文件，与 `D:/tmp/es-test/hash-linguaclip-after.txt` 零差异；重算 `%USERPROFILE%/Videos/LinguaClip` 的 8 个文件，与 `D:/tmp/es-test/hash-videos-after-delete.txt` 零差异。另核对实现者保存的两组 before/after 清单，均零差异。误写的旧目录备份已不存在，新目录备份存在。结论限于这些快照和本次读取时的文件内容，不证明期间从未发生写入；此前误写事实仍保留。
4. **真实环境 / 用户界面**：Codex 查看修复后的 `D:/tmp/es-test/shot-45-l1.png`、`shot-48-result.png`，可见正确答案反馈及 4 句完成页；这些是实现者截图，不是 Codex 本轮操作截图。完整启动、导入和听写由实现者报告，最终听写由用户在本聊天确认。用户未逐项说明错词、重启等操作，不能扩写为用户逐条复跑了全部技术检查。
5. **授权状态**：用户授权复验、批准沙箱外离线定向测试，并在确认听写后授权写本任务卡。本次记录只修改本卡，不改源码、不提交或推送、不改系统设置、不写外部来源。复验外部请求及付费端点调用均为 0。
6. **未验证项**：Whisper、转码及词典真实下载流程；安装包、安卓；Codex 独立完整界面复跑；深色界面（当前上游无深色主题）。这些不纳入本卡本地视频 + SRT 听写的通过结论。

上方结束报告为历史过程记录，其中旧目录时间戳推断、旧测试误判及「用户确认未做」等表述，以「验收反馈修复」与本验收记录为准。后续如扩展到下载、转写或发布，应另行验证对应流程。
