# 上游来源记录

- 上游仓库：https://github.com/Samuelxiaozhuofeng/LinguaClip
- 分支：`main`
- 提交哈希：`640b3802243e7abb75744bb34b1e17f9607d5168`
- 提交时间：2026-11-02 07:04:58 -0700
- 提交标题：`0.9.2：模糊练 ⌘D 一键亮出整句；新默认快捷键撞上已改的键时让位`
- 拉取日期：2026-11-04
- 许可证：AGPL-3.0（上游 `LICENSE` 已原样复制到仓库根目录 `LICENSE`）

## 本地做过的改动

1. `src-tauri/tauri.conf.json`
   - `identifier`: `com.linguaclip.app` → `com.englishstudio.app`
   - `productName`: `LinguaClip` → `english-studio`
   - 原因：Tauri 用 identifier 决定 WebView2 数据目录（`%LOCALAPPDATA%\<identifier>`）。不改的话开发版会读写正式版 LinguaClip 的数据，而那部分属于只读来源。
2. 删掉上游 `.git` 目录（只复制工作区文件）。
3. `vite.config.ts`：`server` 里加 `watch: { ignored: ['**/src-tauri/**'] }`（2026-11-04，用户批准）。
   - 原因：vite 默认监视整个项目根，Windows 上 cargo 正在写的 `src-tauri/target/**/*.exe` 被 chokidar 监视时报 `EBUSY`，`beforeDevCommand` 崩掉，`tauri dev` 直接退出。
   - 影响：`src-tauri` 下的改动不再触发前端热更新；Rust 改动本来就由 tauri 自己重启，行为等价。
4. 数据目录全改成本应用自己的（2026-11-04，用户批准；验收反馈「数据隔离不完整」）：
   - `src-tauri/src/paths.rs`：新增 `APP_ID` / `APP_DIR` / `app_data_dir()`；`own_dir()` 由 `~/Videos/LinguaClip` 改为 `~/Videos/english-studio`（macOS 为 `~/Movies/english-studio`）；另加两条守卫测试，路径里出现 `linguaclip` 即失败。
   - `src-tauri/src/whisper_setup.rs`：`parts_dir()` 改为 `<LOCALAPPDATA>/com.englishstudio.app/whisper`；转码工具（`convert`）、本地词典（`dicts`）、日语词典（`ja-dict`）都是它的同级目录，一处改、四处生效。
   - `src-tauri/src/ja_dict.rs`：断言改为「目录在 `app_data_dir()` 之下」，不再写死旧标识（原写法让测试恒绿，掩盖了泄漏）。
   - `utils/desktop.ts`：`ownDir()` 同步改为 `english-studio`。
   - 影响：`%LOCALAPPDATA%\com.linguaclip.app` 与 `~/Videos/LinguaClip` 从此不再被写；已有记录按绝对路径照常播放，新缓存/新备份/新下载落到新目录。

## 仍然写死 `com.linguaclip.app` 的位置

2026-11-04 起只剩 `dev/browserMock.ts`（246、290，纯浏览器 mock 里模拟 macOS 路径，桌面端不执行）。Rust 侧已全部改为从 `paths.rs` 的 `APP_ID`/`APP_DIR` 派生——要改应用身份，只改 `tauri.conf.json` 的 `identifier` 和 `paths.rs` 两个常量。

## 同步上游

```bash
git clone --depth 1 https://github.com/Samuelxiaozhuofeng/LinguaClip.git /d/tmp/es-downloads/LinguaClip
```
比对 `git log` 与上面哈希，有差异说明上游已更新。
