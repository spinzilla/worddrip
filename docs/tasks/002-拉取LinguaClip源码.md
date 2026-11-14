# 002-拉取LinguaClip源码

- 状态：已关闭（实现：@dsh 2026-11-04；验收：@claude-code 2026-11-04）
- 所属阶段：阶段 0
- 依赖：无（可与 001 并行；但装依赖、编译要等 001）

## 目标（一两句话，用户能看懂）

把 LinguaClip 的源码放进本仓库的 `app/`，记清楚来自哪个版本，并改掉会和正式版 LinguaClip 撞车的应用标识。

## 做法

1. 从 GitHub `Samuelxiaozhuofeng/LinguaClip` 的 `main` 分支取源码（直连慢就用 `github-download-cn` 技能里的镜像）。先克隆到临时目录，再**复制文件**（不带上游的 `.git`）进 `app/`。
2. 在 `app/UPSTREAM.md` 记录：上游地址、提交哈希、拉取日期、许可证 AGPL-3.0。
3. 仓库根目录放 AGPL-3.0 的 `LICENSE`（直接用上游的 LICENSE 文件），上游源码文件头的版权声明原样保留。
4. **改应用标识（重要）**：`app/src-tauri/tauri.conf.json` 的 `identifier` 从 `com.linguaclip.app` 改成 `com.englishstudio.app`，`productName` 改成 `english-studio`。原因：标识决定数据目录，不改的话开发版会读写正式版 LinguaClip 的数据（`%LOCALAPPDATA%\com.linguaclip.app\`），而那是只读来源。改完全文搜一遍 `com.linguaclip.app`，确认代码里没有别的地方写死这个路径；有的话在结束报告里列出来，先别改。
5. 检查 `.gitignore`，确保 `app/node_modules/`、`app/src-tauri/target/` 不进仓库。

## 允许改动的路径

- `app/`
- 根目录 `LICENSE`、`.gitignore`
- 本卡片

## 验收标准（验收者照着复跑）

1. `app/package.json`、`app/src-tauri/Cargo.toml`、`app/src-tauri/tauri.conf.json` 都在；`app/.git` 不存在。
2. `app/UPSTREAM.md` 里的提交哈希能在上游仓库查到。
3. 在 `app/` 下搜索 `com.linguaclip.app`：tauri.conf.json 里已经没有了；其他命中都在结束报告里列出。
4. `git status` 里看不到 node_modules、target 这类体积大的目录。

## 不做什么

- 不 `npm install`、不编译（那是 003）。
- 不改任何功能代码。

---

## 结束报告（实现者填）

- 改了什么：
  - 从 `https://github.com/Samuelxiaozhuofeng/LinguaClip` 的 `main` 克隆到 `D:\tmp\es-downloads\LinguaClip`，提交 `640b3802243e7abb75744bb34b1e17f9607d5168`（2026-11-02，0.9.2），把工作区文件**复制**进 `app/`，删除上游 `.git` 和占位 `.gitkeep`（7.6 MB）。
  - 新建 `app/UPSTREAM.md`：上游地址、提交哈希、拉取日期、AGPL-3.0、本地改动清单、仍写死旧标识的位置表。
  - `app/src-tauri/tauri.conf.json`：`identifier` `com.linguaclip.app` → `com.englishstudio.app`；`productName` `LinguaClip` → `english-studio`。窗口标题仍是 `LinguaClip`（`app.windows[0].title`），不属于本卡范围，没动。
  - 仓库根目录新增 `LICENSE`（上游 AGPL-3.0 原样复制）；上游源码文件头版权声明未改。
  - 没改任何功能代码。
- 代码审阅：在 `app/` 下全文搜 `com.linguaclip.app`，除 `tauri.conf.json` 外命中 3 处：
  | 文件 | 行 | 用途 | 结论 |
  |---|---|---|---|
  | `src-tauri/src/whisper_setup.rs` | 168、170 | whisper 部件目录，转码工具/本地词典/日语词典都由它派生 | 一旦用到 whisper/转码/词典就会写别人的数据目录。**已在 003 修复期改掉** |
  | `src-tauri/src/ja_dict.rs` | 124 | 单测断言词典目录以 `com.linguaclip.app/ja-dict` 结尾 | **本卡原报告写“该测试会失败”是错的**：`dict_dir()` 由 `parts_dir()` 派生，实现与断言同源、一起停在旧目录，测试恒绿——恰恰掩盖了隔离缺失。**已在 003 修复期改掉** |
  | `dev/browserMock.ts` | 246、290 | 纯浏览器 mock 里模拟 macOS 路径 | 桌面端不执行 |

  > **更正（2026-11-04，验收反馈）**：上面两处不是“记录在案即可”的小尾巴。`own_dir()` 指向 `Videos\LinguaClip`（只读来源），自动备份和 AI 缓存都往里写；`parts_dir()` 指向 `com.linguaclip.app`，whisper/ffmpeg/词典都往里写。已在 003 的修复里统一改成本应用自己的目录，见 003 结束报告「验收反馈修复」。
- 自动测试：无（本卡无代码）。
- 真实环境：`tauri dev` 用改后的配置成功启动，窗口标题 `LinguaClip`、界面中文无乱码；WebView2 数据目录落在 `%LOCALAPPDATA%\com.englishstudio.app`（2026-11-04 08:13 新建），证明 identifier 生效。
  - **更正**：本卡原写“`com.linguaclip.app` 修改时间未变（未被动过）”，该结论不成立——只比目录 mtime 证明不了内部文件；而且 08:27 那次启动确实往 `Videos\LinguaClip\backups` 写了一个自动备份（当时 `own_dir()` 还没改）。文件级哈希对比见 003 结束报告。
- 未验证：没和上游后续提交做 diff（提交哈希只在本地上游副本核对，未联网复核）。

## 验收记录（验收者填，不能是实现者本人）

- 日期：2026-11-04；验收人：@claude-code（独立于实现者 @dsh）。
- 结论：**通过，关闭。**
- 逐条复跑：
  1. `app/package.json`、`app/src-tauri/Cargo.toml`、`app/src-tauri/tauri.conf.json` 都在；`app/.git` 不存在。✅
  2. `app/UPSTREAM.md` 记的 `640b3802243e7abb75744bb34b1e17f9607d5168`：本地上游副本 `git log -1` 一致，GitHub API `repos/Samuelxiaozhuofeng/LinguaClip/commits/<哈希>` 也能查到（提交时间 2026-11-02T14:04:58Z）。✅
  3. `app/` 下搜 `com.linguaclip.app`（rs/ts/tsx/json/mjs/js，排除 node_modules、target）：只剩 `dev/browserMock.ts` 246、290 两处，和 UPSTREAM.md 记录一致。✅
  4. `git status --ignored`：`app/node_modules/`、`app/src-tauri/target/` 都被上游自带的 `.gitignore` 忽略；`src-tauri/gen/schemas` 也被忽略。✅
- 额外核对：`diff -rq` 比对上游副本，差异文件 = UPSTREAM.md 列出的 6 个文件 + `UPSTREAM.md` 本身 + `src-tauri/Cargo.toml`。后者 `diff --strip-trailing-cr` 无差别，只是换行符（副本 CRLF、app 里 LF），不算功能改动。
- 未验证：没有逐行审阅 6 个改动文件的代码（那属于 003 的验收范围，已由 @Codex 审过）。
