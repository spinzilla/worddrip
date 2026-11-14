# 词滴 WordDrip

> 一个给中文学习者用的英语学习客户端：精听、词库复习、作文批改、手写笔记录词，Windows 和安卓双端，词库可以在两端同步。
>
> *An English-learning app for Chinese speakers — dictation/shadowing, spaced-repetition vocabulary, AI essay feedback and handwritten-note capture — for Windows and Android, with optional sync. Built on [LinguaClip](https://github.com/Samuelxiaozhuofeng/LinguaClip), AGPL-3.0.*

这个项目最初只是作者给自己做的学习工具：把平时散落在 AI 对话、Markdown 笔记、手写本和一个速查网页里的英语学习流程，收进一个应用里。它也是一次实验：**几乎全部代码由多个 AI 编程 agent 按任务卡协作写成**，作者负责提需求、试用和拍板（见下文「这个项目是怎么做出来的」）。

## 能做什么

**精听**（来自 LinguaClip 底座）
- 导入本地视频/音频或播客，配字幕后逐句听写、模糊练、完形填空。
- 没有字幕时可以自动转写：本地 whisper 模型，或填自己的 API key 用云端识别（Groq、阿里云百炼）。
- 听写中听错、不认识的词可以一键并入词库。

**词库与复习**
- 每个词有释义、例句、用法、场景标签、自己的笔记和来源；全应用任何英文都能点词查词，内置本地词典并支持发音。
- 到期复习：闪卡之外有「产出题」——回忆、改写、造句，按答题情况自动安排下次复习；新词先做首考和逐词预习。
- 词库可以导入、导出成 Markdown，导出再导入不丢信息。

**录入笔记**
- 拍照、选多张图片或 PDF，让视觉模型识别手写/打印笔记里的生词，逐页列出候选，确认后入库；点页码可以看原图核对。识别在后台进行，切页面不中断。
- 「随手记」：随时记一个词或一句话，之后再统一整理入库；也可以从 Notion 表格拉取待入库的词。

**作文批改（教练）**
- 按学术英语（EAP）标准批改作文：先给自查问题，再逐句改错、改写示范，结果归档进错误档案，和词库联动。

**双端与同步**
- Windows 桌面版 + 安卓手机版（手机版界面专门为窄屏重排过）。
- 手机和电脑之间可以同步词库和复习记录，也支持整库打包「搬家」。
- 应用内检查更新：有新版本时提示，点一下自动下载、校验签名后安装。

所有 AI 功能都用**你自己的 API key**（在设置里填，只保存在本机），应用本身不收集任何数据。

## 下载

当前版本 **0.10.0**：

| 平台 | 下载 | 说明 |
|---|---|---|
| Windows 10/11（64 位） | [WordDrip_0.10.0_x64-setup.exe](https://vocab.uestceee.art/worddrip-updates/0.10.0/WordDrip_0.10.0_x64-setup.exe) | 按当前用户安装，不需要管理员。安装包没有微软代码签名，第一次运行 SmartScreen 可能拦一下，点「更多信息 → 仍要运行」。 |
| 安卓 7.0+（arm64） | [worddrip-0.10.0.apk](https://vocab.uestceee.art/worddrip-updates/0.10.0/worddrip-0.10.0.apk) | 需要允许「安装未知应用」。 |

装好以后，新版本会在应用里自动提示。

> 同步功能默认连作者自己的小服务器，容量有限，只适合少量试用；想长期用请按 [`server/sync/README.md`](server/sync/README.md) 自己部署一份，再在设置里把同步地址改成你的。

## 从源码构建

需要：Node.js 20+、Rust（stable，MSVC 工具链）、WebView2；打安卓包另需 Android SDK/NDK 和 JDK 17。

```bash
cd app
npm install
npx tauri dev          # 开发版（Windows）
npm run build          # 只构建前端
node dev/build-android.mjs   # 安卓 debug 包
```

同步功能在构建时读取 `app/.env.local` 里的 `VITE_SYNC_APP_KEY`（格式见 [`app/.env.example`](app/.env.example)），要和你自己部署的同步服务器配置一致；不填则同步功能不可用，其他功能不受影响。

正式发版（签名、安装包、更新清单、上传）见 [`docs/release.md`](docs/release.md)。签名材料不在仓库里，自己发版需要生成自己的密钥。

## 这个项目是怎么做出来的

作者是电子信息工程专业的学生，前端和 Rust 都是零基础。开发方式是：

1. 作者和 Claude 对话提需求、拍板方案；
2. Claude 把工作拆成一张张**任务卡**（[`docs/tasks/`](docs/tasks/)），每张卡写清目标、要做成什么样、验收标准；
3. 调度脚本把卡派给不同的编程 agent（Claude、Codex、Kimi、DeepSeek 等），**实现者和验收者必须是不同的 agent**，验收者照着验收标准复跑、截图，不通过就返工；
4. 每张卡的结束报告、验收记录、返工原因都留在卡片里，进度记在 [`docs/ledger.md`](docs/ledger.md)。

所有 agent 共用的规则在 [`AGENTS.md`](AGENTS.md)，技术方案和每次拍板记录在 [`docs/architecture-draft.md`](docs/architecture-draft.md)。如果你对「多 agent 协作写一个真实应用」感兴趣，任务卡里的验收记录大概是最有意思的部分——包括 agent 们犯过的各种错。

## 目录

```
app/                  客户端（Tauri 2 + React + TypeScript；Rust 在 app/src-tauri，安卓工程在 app/src-tauri/gen/android）
app/mobile/           手机端专用界面
server/sync/          同步服务（FastAPI + SQLite），可以自己部署
docs/tasks/           任务卡：每一项功能的需求、实现报告和验收记录
docs/ledger.md        进度台账
docs/release.md       发版和应用内更新说明
AGENTS.md             给所有编程 agent 的共同规则
scripts/dispatch.mjs  调度脚本入口（真正的调度器在另一个仓库，这里只是入口）
```

## 许可证与致谢

- 本项目基于 [LinguaClip](https://github.com/Samuelxiaozhuofeng/LinguaClip)（AGPL-3.0）改造，整体同样以 **[AGPL-3.0](LICENSE)** 发布。对上游做了哪些改动见 [`app/UPSTREAM.md`](app/UPSTREAM.md)。
- 词典样例数据来自 [Wiktionary](https://www.wiktionary.org/)，经 [kaikki.org](https://kaikki.org/) 提取（CC BY-SA）。
- 学术词汇统计使用 Coxhead (2000) 的 Academic Word List。
