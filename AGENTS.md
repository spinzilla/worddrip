# AGENTS.md — 所有 agent 共用规则

适用于 Claude Code、Codex、Hermes 以及任何在本仓库干活的 agent。本文件是唯一权威；各工具的入口文件（CLAUDE.md 等）只引用这里，不另写规则。

## 用户与沟通

- 用户：编程初学者，前端/Rust 零基础。回复、文档、代码注释一律中文，大白话，先给结论。
- 在意 token 花费：不做无关探索，长任务分阶段汇报。

## 硬规则

1. **诚实**：说「完成/可用」前必须验证用户实际看到的结果（应用真的启动、页面不乱码、安卓真机/模拟器真的跑起来）。验证分四项分开报告：代码审阅 / 自动测试 / 真实环境 / 未验证项。
2. **外部源只读**：`docs/sources.md` 列出的路径（Hermes 目录、`D:\Hermes\english`、腾讯云服务器、LinguaClip 安装目录）一律只读。需要数据时复制到本仓库或走接口，绝不改原文件。
3. **写服务器 / 推 GitHub / 装软件 / 改系统设置**：先说明范围，等用户点头。
4. **密钥**：不进仓库、不打进对话。用 `.env`（已在 .gitignore），读时只列键名。
5. **许可证**：LinguaClip 是 AGPL-3.0。凡复制其代码，本仓库整体按 AGPL-3.0 处理；文件头保留原版权声明。
6. **删除**：只可删自己建的临时产物；其他删除单独征得同意。

## 多 agent 协作协议

- **派工单位 = 任务卡**：`docs/tasks/NNN-简短名.md`，按 `docs/tasks/TEMPLATE.md` 写。一张卡 = 一个 agent 可在 ≤30 分钟内做完、可独立验收的一段。
- **认领**：开工前在卡片 `状态` 写 `进行中 @agent名 日期`；已被认领的卡不碰。
- **写入范围**：不限制执行者改仓库内哪些文件（用户 2026-11-08 定）；卡片里的「允许改动的路径」只是预估，可以不写。改了什么要在「结束报告」里写清楚，调度脚本也会把实际改动的文件记进卡片。
- **交付**：完成后在卡片末尾追加「结束报告」（改了什么、怎么验证、没验证什么），再更新 `docs/ledger.md` 一行。
- **验收**：实现者不能自己验收自己。由另一个 agent（或用户）按卡片里的验收标准复跑。
- **外部 agent（Codex、opencode 等）**：只有用户明确同意后才可派活。
- **角色分工与自动调度**（用户 2026-11-04 拍板）：Claude Code 负责策划、拆卡、底层架构、前端决策和每批复核；Codex `gpt-6-astra` 做难卡与交叉验收；DSH、Codex `gpt-6-luna` 做体力活。用户只跟 Claude 对话，不在多个 agent 之间来回切换。派活统一走 `scripts/dispatch.mjs`（用户已同意长期使用，范围见同级目录 `../agent-board/docs/dispatch.md`）。被调度脚本调用的 agent：不改卡片「状态」行，不 commit/push，不改仓库外文件。

## 开发约定

- 前端 TypeScript + React，后端/本地能力 Rust（Tauri 2）。命令统一用 `npm`（Node 在 PATH 里；PowerShell 下写 `npm.cmd`）。
- 改 UI 必须截图检查；只用上游的浅色主题，不做深色（用户 2026-11-04 决定）。安卓端检查窄屏布局。
- 提交信息中文，一次提交只做一件事。

## 常用位置速查（先查这里，别现找；新装/新发现的路径核实后补进来）

**工具**（Windows 11；Bash 工具是 Git Bash，用户终端是 PowerShell 5.1）
- 2026-11-06 换到新电脑：仓库在 `C:\workspace\english-studio`，同级 `C:\workspace\agent-board` 是看板和调度脚本。旧电脑的 `D:\Hermes\english` 在本机是 `D:\english`（只读）；其他外部来源（Hermes 配置、LinguaClip 安装等）本机没有。Rust 编译产物统一放 `E:\rust\target`（用户环境变量 `CARGO_TARGET_DIR`，2026-11-12 从 D 盘搬到新加的 E 盘），Gradle 缓存放 `E:\android\gradle-home`；C、D 盘空间都紧，大文件放 E 盘
- Node v26 / npm 11：`%LOCALAPPDATA%\Programs\nodejs-lts`（已在 PATH）；npm 装包用 `--registry=https://registry.npmmirror.com`，不改全局配置
- Git 2.56；本机没有 gcc / cmake / uv / ffmpeg（需要时先问用户）
- WebView2 已装；Windows SDK：`C:\Program Files (x86)\Windows Kits\10`
- MSVC（VS 2022 生成工具，MSVC 14.44）：`D:\VS\BuildTools2022`
- Rust 1.99.1（msvc 工具链）：`RUSTUP_HOME=D:\rust\rustup`、`CARGO_HOME=D:\rust\cargo`（已写入用户环境变量），crates 镜像在 `D:\rust\cargo\config.toml`。Claude 的工具进程沿用旧环境，用前先从注册表刷新 PATH / RUSTUP_HOME / CARGO_HOME
- 用户环境变量里有 `CFLAGS=-std=c11 -Wall -Wextra -g`（学 C 用 gcc 的），跑 `cargo build/test` 前要先清掉（Git Bash：`unset CFLAGS`；PowerShell：`Remove-Item Env:CFLAGS`），否则 MSVC 编 `ring` 等依赖报 `D8021 无效数值参数 /Wextra`。调度脚本派活时已自动去掉
- rustup 镜像：临时设 `RUSTUP_DIST_SERVER=https://rsproxy.cn`、`RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup`（镜像可能落后官方一个小版本，下载的二进制要对官方 sha256）
- GitHub 慢：用 `github-download-cn` 技能；Windows 路径/乱码问题：`windows-env-gotchas` 技能
- 临时目录：`D:\tmp\`（下载物放 `D:\tmp\es-downloads\`，测试素材放 `D:\tmp\es-test\`）

**仓库**
- GitHub 私有仓库：https://github.com/spinzilla/english-studio（`origin`，分支 `main`）。推送用 git 自带凭据管理器；本机没有 `gh` 命令。用 REST API 发中文 JSON 时要先写成 UTF-8 文件再 `--data-binary @文件`，直接放命令行参数会被转码坏掉。
- 上游原版源码在提交 `29fb405`，和它 diff 就能看到我们对 LinguaClip 改了什么。

**信息类文档**
- 三个来源的路径与结构：`docs/sources.md`（Hermes 学习规则 SKILL.md、速查页台账 `english-vocab-site` SKILL.md、LinguaClip 都在里面）
- 方案与拍板结果：`docs/architecture-draft.md`；进度：`docs/ledger.md`；任务卡：`docs/tasks/`
- LinguaClip 上游调研片段（README、package.json、文件树）：`%USERPROFILE%\oss-english-research\listening\Samuelxiaozhuofeng__LinguaClip.*`
