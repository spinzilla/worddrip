# 三个来源盘点（2026-11-03 只读调查）

> 给 agent 读的参考。全部路径只读，不要改原文件。

## 1. Hermes english profile 学习模式

- 入口：`english.bat` → `hermes -p english`；profile 目录 `%LOCALAPPDATA%\hermes\profiles\english\`
- 人设：`SOUL.md`——英语教练，主用英文回复、难点切中文；学术英语标准（七特征 + AWL）；只用本地真实语料；归档只追加不重写；成本敏感，每轮批改/练习后建议开新会话。
- 核心规则：`skills\english-learning\SKILL.md`（403 行），结构：
  - 〇 分流（先判任务类型）／通用铁律
  - A 作文批改：卷面类型分流 → 硬指标 + 学术英语主轴 → 逐句改错 + 改写示范 + 错误归档 → 诚实标注 → 归档流程
  - B 词汇闭环：L1–L4 状态机，晋级在这里做（速查页不动状态机）
  - D 听力闭环：BBC 6 Minute English 精听四步 + 复检；生词收割 → 接入 B；雅思听力支
  - C 共享层：归档地图、A↔B 织入检查、学术升级库、速查页、手写图片输入（vision）
  - 参考资料：`references/awl-570.md`、`acl-collocations.md`、`phrasebank-frames.md`
- 数据（全在 `D:\Hermes\english\`）：`词汇复习库.md`（总词库 L1–L4）、`词汇\学术升级库.md`（主库）、`错误档案.md`、`daily-expressions\pool.json`（句型池）、`作文\`、`听力\`、BBC 6 Minute 音频+字幕、雅思听力/阅读材料。
- **对新客户端的含义**：学习模式本质 = 一套提示词规则 + Markdown 数据文件。迁移方式是把 SKILL.md 拆成若干 AI 角色的系统提示，把 Markdown 数据解析进结构化存储（保留导出回 Markdown 的能力）。

## 2. 学术升级库速查页（用户说的「英语复习网站」）

- 权威台账：`%LOCALAPPDATA%\hermes\skills\english-vocab-site\SKILL.md`（动之前必读）
- 页面：`D:\Hermes\english\学术升级库-速查体验版.html`，**生成物**，唯一生成器 `D:\Hermes\english\scripts\build_vocab_page.py`
- 线上：`https://vocab.uestceee.art`、`http://193.112.27.134:8080/vocab/`（腾讯云轻量，nginx）
- 后端：服务器 FastAPI `vocab-notes.service`（`/opt/vocab-notes/app/main.py`，127.0.0.1:8700，nginx 反代 `/vocab-api/`），访问码 HMAC Cookie；数据 `notes.json`（✏️批注）、`comments.json`（💬评论楼，可送 AI 批改多轮）、`state.json`（AI 日配额）、`ai_context.md`。本地副本 `D:\Hermes\vocab-notes\`。
- 已有功能：词条速查/搜索、每日替换推荐、到期复习横幅、沉浸复习（闪卡+批注上滑面板）、评论楼标签（笔记/联想/应用/疑问/易错点）、file:// 降级只读。
- 设计约束（用户定过的）：评论楼与批注是两套系统，不要融合；沉浸复习不动 L 级状态机。
- 注意：桌面「Study Review」快捷方式指向 `D:\codex\codex-test`（日程/学习记录复习工具，localStorage + node server.js），**不是**这个速查页，默认不纳入。

## 3. LinguaClip

- 第三方开源：GitHub `Samuelxiaozhuofeng/LinguaClip`，**AGPL-3.0**；官网 linguaclipapp.com
- 技术栈：Tauri 2（`@tauri-apps/api ^2.11.1`）+ React 19 + Vite 6；本机装在 `D:\Apps\LinguaClip\linguaclip.exe`，数据 `%LOCALAPPDATA%\com.linguaclip.app\`（含 whisper 模型）
- 功能：拖入视频 → 本地 whisper 生成字幕（约 580MB 模型，离线）或导入 .srt → 逐句听写，只标错词，可重放/减速/循环
- 用户相关产物：`%USERPROFILE%\Videos\LinguaClip\`（`*.words.json`、`*.trans.json`、`.srt`）、`%USERPROFILE%\Documents\linguaclip-srt\make_srt.py`
- 已有调研片段：`%USERPROFILE%\oss-english-research\listening\Samuelxiaozhuofeng__LinguaClip.*`（README、package.json、LICENSE、useVideoPlayer.ts）
- 官方只支持 Mac + Windows，**没有安卓版**。

## 相关但未纳入

- `D:\Hermes\english-listening`：用户自研精听软件（PySide6 + mpv + faster-whisper，私有仓库 `spinzilla/english-listening`，v0-3 已受控验收）。功能与 LinguaClip 重叠，PySide6 上不了安卓。其设计文档（句子切分、整听打点→专项攻克、暂存区接口）可借鉴。台账：`%LOCALAPPDATA%\hermes\skills\english-listening-project\SKILL.md`。
- `%USERPROFILE%\oss-english-research\`：开源英语学习软件调研素材。
