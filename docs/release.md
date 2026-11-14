# WordDrip 发版

## 正式签名材料

签名文件放在仓库外的 `%USERPROFILE%\.worddrip-release`，也可以用环境变量 `WORDDRIP_RELEASE_DIR` 指定其他目录。目录中有安卓签名文件、Tauri 更新签名私钥和口令。私钥、口令和 keystore 不要复制进仓库或发给他人。

发版前应把整个目录做至少两份离线加密备份，并确认备份能读取。安卓签名 keystore 丢失后，已安装的安卓应用不能再由同一应用身份覆盖更新，只能卸载后重装（用户数据可能随卸载丢失）。Tauri 更新私钥丢失后，无法给新安装包生成能通过现有公钥校验的更新签名；需安排重新分发安装包。

## 发版步骤

1. 确认工作区干净，签名材料和 Windows / Android 构建工具链齐全。
2. 只改 `app/src-tauri/tauri.conf.json` 中的版本号，并运行 `node app/dev/release.mjs bump <版本>`，将 Tauri、npm、Cargo 三处版本同步。Android `versionCode` 规则为 `major * 1,000,000 + minor * 1,000 + patch`。
3. 在仓库根目录运行 `node app/dev/release.mjs build --notes "更新说明"`。脚本先检查工作区、版本号和签名材料，再构建 Windows NSIS 更新安装包及 arm64 安卓正式 APK。
   Windows 上手动运行 `npx tauri build` 也需要先设置 `TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`；建议直接用 `release.mjs`，它会从签名材料目录读取并只传给构建子进程。
4. 产物及 `latest.json` / `android.json` 写入 `D:\tmp\es-release\<版本>\`。先检查文件、版本、签名和摘要，再按发布流程上传。
5. 上传命令为 `node app/dev/release.mjs upload <版本>`；`--dry-run` 只打印命令。安装包、`.sig`、APK 传到 `tencent:/var/www/worddrip-updates/<版本>/`；两个清单传到**根目录** `/var/www/worddrip-updates/`（应用读的是根目录的 `latest.json` / `android.json`），在安装包和 APK 之后以临时文件传输，先存档一份到 `<版本>/`，最后改成正式名称。
   这台电脑到服务器的连接传大文件时常被掐断（2026-11-14 发 0.10.0 时 APK 两次断在约 12.8 MB）。断了就把 APK 切成 4 MB 小块逐块 `scp`、在服务器上 `cat` 拼回并核对 sha256，再手动传清单。

`--allow-dirty` 仅用于本地测试构建；正式发版不要使用。`bump` 会同步 Cargo.lock 中应用自身的版本。安卓 release 目前关闭 R8/资源压缩，待确认 Tauri 和插件需要的类都保留后再考虑开启。

## 应用内更新（077）

- **电脑**：Tauri 官方更新器读 `tauri.conf.json` 的 `plugins.updater.endpoints`（`https://vocab.uestceee.art/worddrip-updates/latest.json`），公钥已写在同一处，Windows 用 passive 安装（有进度条）。下载后由插件校验 `.sig`，签名不对就拒绝安装，界面显示「校验失败」。
- **手机**：读同目录下的 `android.json`（字段 `version / versionCode / url / sha256 / size / notes`，格式没改），按 versionCode 比较；应用内下载 APK、核对大小和 sha256，通过后才写到应用缓存目录并调 `MainActivity.kt` 里的 `WorddripUpdater.installApk`（FileProvider + 系统安装确认）；需要 `REQUEST_INSTALL_PACKAGES`，第一次会跳到系统「允许安装未知应用」页。
- **提示规则**：启动约 10 秒后查一次，之后每 6 小时一次；「稍后」后同一版本 24 小时内不再弹条；设置 → 关于 可手动检查、关闭自动检查。断网或清单 404 自动检查时安静跳过。
- **测试用地址**：
  - 手机（含浏览器里的手机窗口）：`localStorage['worddrip.update.base'] = 'http://127.0.0.1:8099'`（目录，下面放 `android.json`）。
  - 电脑：`tauri dev --config 覆盖文件`，覆盖里写 `plugins.updater.endpoints` 和 `dangerousInsecureTransportProtocol: true`（`dev/e2e/launch.mjs` 认环境变量 `ES_E2E_EXTRA_CONFIG`）。
  - `localStorage['worddrip.update.dryRun'] = '1'`：电脑下载并校验完就停在「安装前」，不安装不重启。注意：电脑端这只证明「下载+验签通过」，`update.install()` 本身没有被替身记录；手机端没有原生桥时安装调用会记到 `window.__wdInstallCalls`。
- **手机取消安装**：系统安装确认点「取消」回到应用后，提示条从「正在安装」退回「安装失败」并带重试（不重新下载）。已发现新版后，每 6 小时的检查只刷新界面，让「稍后」到期的提示条回来。
- **复跑脚本**：`node app/dev/release.mjs bump 0.9.99` → `build --allow-dirty` 打出测试版 → `bump 0.9.2` 还原；然后 `cd app && node dev/e2e/update-077.mjs 0.9.99`（电脑真实窗口）、`node dev/e2e/update-077-mobile.mjs 0.9.99`（390×844 手机 UA，需要已装好的 Playwright 缓存 `~/.cache/linguaclip-e2e`）。静态服务器是 `app/dev/update-server.mjs`。
