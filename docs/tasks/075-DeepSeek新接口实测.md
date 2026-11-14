# 075-DeepSeek新接口实测

- 状态：已关闭（用户确认 2026-11-14）
- 难度：难
- 类别：调研实测
- 实现：opencode-luna
- 验收：opencode-ds-flash
- 所属阶段：听力 / 录入笔记
- 依赖：（无）

<!-- 2026-11-13 统筹 claude：DeepSeek 2026-11-13 开放了独立的 OCR、ASR、TTS 接口（官方公告 https://api-docs.deepseek.com/news/news261113）。
     用户问「听力识别能不能加一个用 API Key 模型识别的选项」「deepseek 新开放的语音合成、OCR 有没有用」，同意先开一张实测卡，用真实素材量一量再决定做不做成正式功能。
     统筹已读官方文档（https://api-docs.deepseek.com/guides/asr 、/guides/ocr 、/guides/tts），要点：
     - ASR：POST https://api.deepseek.com/v1/tools/asr，multipart 只有一个 file 字段；单次 ≤120 秒、≤8 MiB；只收 16-bit PCM WAV 或 Ogg Opus（不收 mp3/m4a）；
       返回只有 request_id / text / duration_ms，**没有时间戳**；自动识别语言（含 en）；不支持流式、不支持传链接；限时 0.39 元/小时，按秒计。
     - OCR：POST https://api.deepseek.com/v1/tools/ocr，multipart 字段 file + purpose（text_recognition 或 rich_layout_recognition），其他字段报 400；
       收 PDF、Word、PPT、PNG/JPEG/WebP 等；返回 pages[].text；限时 1.5 元/千页，失败不收费。
     - TTS：POST https://api.deepseek.com/v1/tools/tts，JSON：text、voice_id（stella 女 / tide 男）、format（wav/pcm）；不能调语速；支持英文。
     - 都用 Authorization: Bearer <DeepSeek API Key>，base 是 https://api.deepseek.com。
     电脑端现在的转录有「本机 whisper / Groq / 阿里云百炼」三种（app/utils/transcribeConfig.ts），听力逐句跟读需要每句的开始时间；
     录入笔记现在是看图模型逐页直接认词（app/utils/vocab/inbox.ts 的 recognizeInboxImage，073 加了流式）。
     本机没有装 whisper 模型（app_data_dir/whisper 不存在），也没有 ffmpeg；本卡不装它们。 -->

## 目标（一两句话，用户能看懂）

用真实素材实测 DeepSeek 新开放的语音识别和文字识别：语音识别能不能当听力的「用 API Key 识别」选项（准不准、每句时间能不能定准、多快、多少钱），文字识别配合挑词会不会比现在的录入笔记更快更准；顺带试听一下语音合成。只出实测报告和推荐，不改应用功能。

## 从哪看起

- 官方文档：上面注释里的三个链接。
- 现在的转录：`app/utils/transcribeConfig.ts`、`app/src-tauri/src/import.rs`、`app/src-tauri/src/decode.rs`（应用自己解码音频的代码，不用 ffmpeg）、`app/src-tauri/src/groq.rs` / `bailian.rs`（云端转录结果怎么变成逐句字幕，可以看出听力需要什么样的时间信息）。
- 现在的录入笔记识别：`app/utils/vocab/inbox.ts`（提示词和请求）、`app/utils/vocab/noteImport.ts`、`app/utils/vocab/noteMedia.ts`。
- 内置播客列表：`app/pro/podcastShows.ts`（6 Minute English 的 RSS）。

## 准备（用户提供，执行者只读）

- DeepSeek API Key：`D:\tmp\es-keys\deepseek.env`，一行 `DEEPSEEK_API_KEY=...`。脚本从这个文件读；**Key 不能打印、不能写进日志、报告、仓库和 e2e 记录**。
- 用户的真实笔记 2–3 页（照片或 PDF）：`D:\tmp\es-test\deepseek\notes\`。只读，不复制进仓库。
- 测试音频（用户已同意下载）：从 6 Minute English 的 RSS（`app/pro/podcastShows.ts` 里的地址）下载**最近一期**的 mp3，和 BBC Learning English 网站上这一期的官方文字稿，放 `D:\tmp\es-test\deepseek\audio\`。只下这一期。
- 花费：整张卡（含验收复跑）预计几毛钱以内；报告里按官方价格算出实际花了多少。

## 要做成什么样

1. **实测脚本**放 `app/dev/deepseek-trial/`（Node 或 Rust 测试都行，你定），一条命令能复跑；产出放 `D:\tmp\es-test\deepseek\out\`。
2. **语音识别（ASR）**：
   - 音频转成 16kHz 单声道 16-bit WAV：优先复用应用自己的解码代码（`decode.rs`），不装 ffmpeg；写清楚用的方法。
   - 方案 A「固定切块」：按 ≤110 秒切块逐块识别，拼成全文。
   - 方案 B「按停顿切句」：按静音（简单的能量阈值即可，参数写清楚）切成 ≤20 秒左右的段，每段单独识别，每段的开始/结束时间就是这段字幕的时间。统计：段数、平均段长、有多少段在句子中间被切断（段尾文字不以句末标点结束的比例）、抽 10 段把「时间 + 文字」列出来。
   - 准确率：两种方案的全文都和官方文字稿比，算词错误率 WER（统一小写、去标点，主持人姓名等写法差异单独列出），各列 10 处典型错误。
   - 速度和稳定性：总耗时、请求次数；并发 1 和并发 3 各跑一次，记录有没有 429 或其他报错。
   - 花费：按音频秒数和官方价格算。
   - 手机可行性（只做代码审阅，不用跑）：手机 WebView 里能不能把音频解码成 WAV（例如 `decodeAudioData` 再编码 WAV），大致要多少代码。
3. **文字识别（OCR）+ 挑词，对比现在的录入笔记**：
   - 现在的做法：用 `inbox.ts` 里同样的提示词和看图请求（模型用 DeepSeek 的看图模型，名字从 `GET https://api.deepseek.com/models` 里找，写进报告），逐页识别，记下认出的词、每页耗时。
   - 新做法：每页先 OCR（`text_recognition`；再对 1 页试一次 `rich_layout_recognition`，看手写/排版是否更好），再把 OCR 文字交给同一个 DeepSeek 文本模型，用和现在等价的挑词要求（提示词改成「从这段文字里挑词」，其他规则不变），记下认出的词、每页耗时（OCR + 挑词分开记）。PDF 再试一次直接整份交给 OCR。
   - 报告把两种做法每页认出的词**并排列表**（两边都有 / 只有旧做法有 / 只有新做法有），给用户自己判断哪边准；再附 OCR 原文前 30 行。
   - 花费：两种做法各自的金额。
4. **语音合成（TTS）**：用两个声音各合成两句英文例句（从用户词库里随便挑两句例句也行，自己写也行），存成 wav 放 `out\tts\`，报告写耗时和花费；只给用户试听，不做功能。
5. **报告**：`docs/research/deepseek-trial-075.md`（中文、先给结论）：
   - 一张总表：ASR 方案 A/B 与「需要什么才能当听力选项」的差距；OCR+挑词 与 现在看图识别 的对比；TTS 能用在哪。
   - 明确推荐：每项「值得做成正式功能 / 不值得 / 再观察」，以及如果做，大概要改哪些文件。
   - 报告和脚本输出里不出现 Key 原文。

## 允许改动的路径

- `app/dev/deepseek-trial/**`
- `docs/research/**`
- `docs/ledger.md`

## 允许写的仓库外路径

- `D:\tmp\es-test\deepseek\audio\**`
- `D:\tmp\es-test\deepseek\out\**`
- `E:\rust\target\**`

## 验收标准（验收者照着复跑）

1. 按报告里的命令复跑 ASR 的方案 B（至少前 3 分钟音频）和 1 页笔记的 OCR+挑词，得到的数字和报告同量级（WER 差在 5 个百分点内，段数接近），退出码 0。
2. 抽查报告里列的 10 段「时间 + 文字」中的 3 段：用任意播放器跳到报告写的开始时间，听到的开头和文字对得上（写下抽查结果）。
3. 搜一遍 `D:\tmp\es-test\deepseek\out\`、`app/dev/deepseek-trial/`、`docs/research/`、`.dispatch` 下本卡日志：没有 Key 原文（用 Key 文件里的值做 `Select-String -SimpleMatch`，只报「有/没有」，不打印 Key）。
4. 没有改应用功能代码：`git diff --stat` 只涉及允许的路径。
5. 报告里每条推荐都有对应的实测数字支撑；花费有合计。

## 不做什么

- 不改应用的任何功能代码和界面，不加依赖。
- 不装 ffmpeg、不下载 whisper 模型。
- 不把用户的笔记或音频复制进仓库；Key 不进任何文件（除用户自己放的 `deepseek.env`）。
- 只下载上面说的一期音频和文字稿。

---

## 结束报告（实现者填）

- 改了什么：新增 `app/dev/deepseek-trial/` 实测脚本和 Rust 小工具，复用应用 `decode.rs`；本轮给 `trial.mjs` 增加 `verify-starts`，对报告样本 #3/#4/#6 自动截 4 秒并复送 ASR；新增 `docs/research/deepseek-trial-075.md`；更新本卡与 `docs/ledger.md`；生成 `.dispatch/075-1794630929417-r1-impl-selfcheck.json`。原笔记只读；音频、transcript、临时 WAV/JPEG/JSON、TTS WAV 和起点核对结果均写在任务允许的 `D:\tmp\es-test\deepseek\audio\`、`out\`。
- 代码审阅：`verify-starts` 只选择既有报告中的三个正文段，从解码 WAV 的报告起点截取最多 4 秒；用两组开头词的最长公共子序列计数，至少 2 个顺序匹配词才通过。结果仅写识别文本、耗时及计费时长，不写请求头或密钥。复用应用 `decode.rs::to_wav`；未改应用功能代码、未加依赖。
- 自动测试：`node --check app/dev/deepseek-trial/trial.mjs` 通过；旧 `verify-results.json` 记录 35/35 段成功、正文 WER 5.2254%、第 2 页 OCR+挑词完成。新 `node app/dev/deepseek-trial/trial.mjs verify-starts` 退出码 0，样本 #3/#4/#6 分别匹配 12/12/9 词，均通过、计费 12 秒；Key 扫描四个目标目录均无匹配；`git diff --check` 通过。
- 真实环境：本轮实际调用 DeepSeek ASR 核对三段，每段 4 秒，响应分别约 2.80/2.19/1.95 秒；既有结果记录 DeepSeek `/models`、ASR、OCR、chat completions、TTS 实测，以及 BBC 最近一期节目和用户笔记第 2、3 页测试。未启动应用 UI（本卡不改 UI）。
- 未验证：自动起点核对只有三个样本，不能代替人工听证或证明全片每句边界正确；TTS 声音自然度待用户试听。连接重置后服务端是否计费无法从客户端核实，实际账单以 DeepSeek 账户为准；手机端仅代码审阅，未在手机运行。
- 返工说明：新增 ASR 失败段最多自动重试 2 次；`verify` / `full` 仍有失败时保存检查点并非零退出，resume 命令只补跑失败段；新增纯 Node 重试测试。报告更正并发 1 的 4 次重置都在 0–65.5 秒广告段，并把整份 PDF OCR 耗时改为结果文件记录的 15.316 秒。验证：`node --check`、2 项重试单测、`git diff --check` 通过；真实 `verify` 跑完 35/35 段（正文 WER 5.2254%），第 2 页挑词遇 ECONNRESET 后正确退出 1；随后 `verify-resume` 补完 OCR+挑词并退出 0，旧/新流程各 12 词；`verify-starts` 3/3 通过。未验证真实 ASR 连续失败后再恢复的端到端重试，只由单测覆盖。

## 交接摘要（实现者填；返工的新会话会带上最近一段，总长不超过约 40 行）

- 改了哪些文件及要点：新增 `app/dev/deepseek-trial/asrReliability.mjs` 与单测；更新 `trial.mjs`，失败 ASR 自动补跑、持续失败时保存检查点并退出非零；更正研究报告、更新本卡结束报告及 `docs/ledger.md`；新增 `.dispatch/075-1794632135951-r1-impl-selfcheck.json`。
- 关键函数 / 位置：`asrReliability.mjs::retryFailedAsrSegments`；`trial.mjs::ensureAsrRun`、`saveAsrRun`、`main` 的 verify/full 分支。
- 试过但放弃的做法及原因：没有人为制造真实 ASR 网络连续失败；避免构造外部服务故障，用注入请求函数的单元测试覆盖瞬时恢复和持续失败两条路径。
- 没验证的事：真实网络连续失败后再 `verify-resume` 的 ASR 端到端恢复未实测；上一轮的全片人工听证、TTS 自然度及手机端运行仍未验证。

## 待你决定

### 第 1 问（2026-11-14，opencode-luna）
任务要求人工播放报告中的 3 段音频核对起点，并试听两种声音各两句。当前执行环境没有可用的播放/听觉验证能力；我不能把 ASR 文本再识别一次冒充人工试听。请选后续验收方式：
- 选项：你来试听报告列出的 3 段和 4 个 WAV，并把结果补进卡片
- 选项：由独立验收者在可播放音频的环境里试听并记录；本卡保留“未验证”

答：两项都不要人工试听，本卡继续收尾交验收。①验收标准 2「跳到开始时间听」改成自动核对：验收者从 episode-16k-mono.wav 按报告里 3 段正文段（不选广告段）的开始时间各截 4 秒，单独送一次 ASR，开头能和该段文字对上 ≥2 个词即算时间准，写出 3 段结果——这是核对「这个时间点的声音是不是这段话」，不算冒充试听；②TTS 的 4 个 WAV 由用户自己试听，「未验证」里写「声音自然度待用户试听」即可，不影响通过。（统筹 claude 代用户，2026-11-13）

## 复核意见

### 第 1 次返工（2026-11-14，调度脚本）——已返工，2026-11-14 通过

验收不通过（验收者 opencode-ds-flash），按「验收记录」最后一轮的问题清单返工。

## 实际改动文件（调度脚本自动记录）

- 修改 `docs/ledger.md`
- 新增 `app/dev/deepseek-trial/Cargo.lock`
- 新增 `app/dev/deepseek-trial/Cargo.toml`
- 新增 `app/dev/deepseek-trial/asrReliability.mjs`
- 新增 `app/dev/deepseek-trial/asrReliability.test.mjs`
- 新增 `app/dev/deepseek-trial/src/main.rs`
- 新增 `app/dev/deepseek-trial/trial.mjs`
- 新增 `docs/research/deepseek-trial-075.md`

## 验收记录（验收者填，不能是实现者本人；最后单独一行写「验收结论：通过」或「验收结论：不通过」）

### 复跑环境

- 2026-11-14（UTC），Windows 11、Node 26.13.0；工作区改动未提交，HEAD 仍是改动前。`CARGO_HOME=D:\rust\cargo` 已在环境变量里，`CFLAGS` 为空，没有改任何环境设置。
- 本轮真实调用 DeepSeek ASR / OCR / chat completions（模型 `deepseek-flash`），复跑花费约 $0.03。

### 验收标准逐条结果

1. **通过（复跑数字与报告同量级，但第一次遇到网络抖动）**。第一次按报告命令 `node app/dev/deepseek-trial/trial.mjs verify`：35 段、6 段 `UND_ERR_SOCKET`/`ECONNRESET` 失败、正文 WER 28.69%，仍打印「完成」且退出码 0（这就是问题 1 的现场）。第二次 `verify`：ASR 35/35 成功（wall 54.8 秒），随后第 2 页挑词 `ECONNRESET`、退出码 1；按报告写的 `node ... verify-resume` 补完，退出码 0。最终 `verify-results.json`：35 段、平均 16.89 秒、正文 WER 5.2254%（报告 5.23%）；第 2 页旧做法 12 词、新做法 12 词，只旧 `be capped at`、`sympathise`，只新 `be capped`、`sympathize`，与报告一致。
2. **通过（按用户答复改为自动核对）**。重跑 `node app/dev/deepseek-trial/trial.mjs verify-starts`，退出码 0：样本 #3 @135.14 秒匹配 12 词、#4 @187.62 秒匹配 12 词、#6 @329.68 秒匹配 9 词，3/3 通过；识别开头与 `start-check-results.json` 一致。
3. **通过**。用 `D:\tmp\es-keys\deepseek.env` 里的值，对 `D:\tmp\es-test\deepseek\out\`、`app/dev/deepseek-trial/`、`docs/research/`、`.dispatch/` 递归做 `Select-String -SimpleMatch`：0 命中（只报有/没有，未打印 Key）。
4. **通过**。`git diff --stat` 只涉及 `docs/ledger.md` 和本卡（状态/结束报告，协议要求）；未跟踪文件只有 `app/dev/deepseek-trial/**`、`docs/research/deepseek-trial-075.md`；`app/` 功能代码零改动。
5. **通过**。逐项对照报告和 `trial-results.json`：A 5.64%、A 并发 3 36.07%、B 5.23%、35 段/平均 16.89/最长 20、两页耗时 77.9+35.4 秒与 3.3+61.7 / 3.3+39.7、旧 $0.01196 / 新 $0.01186、单批合计 $0.0653 / $0.1056 均一致；累计 ≥$0.17 是估算口径并已注明。TTS 4 个 WAV 本地校验为 24kHz/单声道/16-bit、时长 3.04/3.92/2.76/3.44 秒、RIFF 长度正确；声音自然度按用户要求留给用户试听。

### 审查三问

- **改动的函数还有谁在用**：`trial.mjs` 只被自己使用，仓库里没有其他文件引用 `deepseek-trial`；`decode.rs` 通过 `#[path]` 只读引用、没有改动，应用的转录/导入路径不受影响。
- **接外部程序的部分有没有真实跑过**：ASR（35 段 + 3 段 4 秒）、OCR、chat completions 本轮真实调用；TTS 本轮没有重新合成，但 4 个 WAV 是真实接口产物且本地头部校验通过；`cargo run` 解码 MP3 真实跑过。
- **同类问题别处还有没有**：`runAsrSet` 把单段失败记进 `failures`，但整体仍标成功；`verify-resume` 看到 `asrB` 存在就整段跳过、不补失败段；`runNotes`/`pickWords` 遇网络错误会直接退出 1（这种是安全的失败）。

### 问题清单（按严重程度）

1. **一般（本卡）**：复验脚本会把「有段失败的 ASR」写成成功。复现：网络抖动时运行 `node app/dev/deepseek-trial/trial.mjs verify`，本轮第一次实测 6 段失败、正文 WER 28.69%，仍打印「完成」并退出码 0；按报告建议接着跑 `verify-resume` 也不会补跑失败段（我改检查点模拟 1 段正文失败后跑 `verify-resume`：退出码 0，WER 从 5.23% 变 10.25%，`status` 仍是「复验命令成功」；模拟后已按字节恢复）。影响：后来的人复跑时可能把坏数据当成结论，验收标准 1 的「数字同量级」不可靠。建议：`failures` 非空时退出码非 0 并重试失败段，或 `verify-resume` 补跑失败段后再算 WER。
2. **提示（本卡）**：报告把 B 并发 1 的 WER 与并发 3 相同写成「巧合」。实际是那 4 次重置都落在片头广告段（0–65.5 秒，裁掉正文后不计入），所以正文 WER 不受影响；建议把原因写清楚，别让人以为数据可疑。
3. **提示（本卡）**：报告「整份 PDF OCR 约 16.5 秒」与 `trial-results.json` 的 15316 ms 不一致（可能取自另一轮），建议统一或注明轮次。

验收结论：不通过

### 第 1 次返工复验（2026-11-14，opencode-ds-flash）

#### 复跑环境

- 2026-11-14（UTC），Windows 11、Node 26.13.0；HEAD 仍是 `ee45f58`，改动未提交。`CFLAGS` 为空；仓库外只写了卡片允许的 `D:\tmp\es-test\deepseek\audio\`、`out\`。
- 真实调用 DeepSeek ASR / OCR / chat completions（`deepseek-flash`），本轮复验花费约 $0.02。`node --check app/dev/deepseek-trial/trial.mjs` 退出 0；`node --test app/dev/deepseek-trial/asrReliability.test.mjs` 2/2 通过。

#### 本轮改动影响到的标准

`trial.mjs` 的 ASR 执行/退出路径和 `asrReliability.mjs` 正是标准 1 的复跑命令，标准 1 重跑；`verify-starts` 与改动同在 `trial.mjs`，标准 2 重跑；标准 3、4 每次当场扫；标准 5 只复核报告改动的两处数字和新增的重试说明，其余沿用上一轮。没有全量重跑 `full`（四轮 ASR 各约 590 秒音频，费钱且与本次改动无关），改用检查点续跑验证 `resume` 分支。

#### 验收标准逐条结果

1. **通过**。`node app/dev/deepseek-trial/trial.mjs verify` 退出码 0：35 段、0 失败、平均 16.89 秒、正文 WER 5.2254%（报告 5.23%），覆盖整段音频（含前 3 分钟）；第 2 页 OCR 3.3 秒 + 挑词 21.2 秒（旧看图 39.2 秒），新流程 13 词 / 旧流程 12 词。上一轮问题 1 另做三组验证：① 把检查点第 10 段（170.31–187.62 秒）改成失败后跑 `verify-resume`：退出 0，`requests` 36、`retryAttempts` 1、`failures` 0、WER 仍 5.2254%；② 用 `.dispatch` 里临时探针让 ASR 请求全部立即失败（不发请求、不花钱）再跑 `verify-resume`：退出 1，`status`「复验未完成：仍有 1 段 ASR 失败」，`asrB.wer` 已删除，探针跑完已删；③ 真实 `full` 检查点里原有 A3 1 段、B1 4 段失败：先让 ASR 全失败跑 `resume`（退出 1、写入 status、删掉 wer），再联网 `resume` 退出 0，A3 `retryAttempts` 3、B1 `retryAttempts` 4，B1 补完后正文 WER 仍是 5.2254%、与 B3 一致。所有模拟的检查点已按字节恢复（trial 文件哈希 `B3198975…`，verify 文件哈希 `3CECE18F…`）。
2. **通过（本轮重跑）**。`node app/dev/deepseek-trial/trial.mjs verify-starts` 退出码 0：样本 #3 @135.14 秒匹配 12 词、#4 @187.62 秒匹配 12 词、#6 @329.68 秒匹配 9 词，3/3 通过，与上一轮和 `start-check-results.json` 一致。
3. **通过**。用 `D:\tmp\es-keys\deepseek.env` 里的 35 字符真实值（`Select-String -SimpleMatch`，只报数量、不打印 Key）扫四个目标：`out` 15 个文件 0 命中、`app/dev/deepseek-trial` 6 个文件 0 命中、`docs/research` 1 个文件 0 命中、`.dispatch` 5782 个文件 0 命中。（我第一次取值时 PowerShell 的 `-match` 返回布尔值，把 `True` 当成了 Key，重扫已改正。）
4. **通过**。`git diff --stat` 只有 `docs/ledger.md`（+1 行）和本卡（状态/结束报告，协议要求）；未跟踪文件只有 `app/dev/deepseek-trial/**`、`docs/research/deepseek-trial-075.md`；`app/` 功能代码零改动；`git diff --check` 退出 0。
5. **通过（复核报告改动的两处）**。`trial-results.json` 的 `directPdfOcr.elapsedMs` 是 15316，报告写 **15.316 秒**，一致（上一轮问题 3 已改对）；B 并发 1 的失败行是第 0–3 段、第 5 段起点 65.53 秒，与报告「4 次重置都在片头广告段（0–65.5 秒）」一致，而且上一项里真实补完这 4 段后正文 WER 仍是 5.2254%，说明「WER 与并发 3 相同」确实是裁掉广告后的结果、不是巧合（上一轮问题 2 已解释清楚）。报告新增的重试/非零退出说明与实测行为一致。其余推荐与费用数字（A 5.64%、A3 36.07%、两页耗时与词表、旧 $0.01196 / 新 $0.01186、单批 $0.0653 / $0.1056、TTS 四个 WAV）本轮未改动，沿用上一轮已核对结论。

#### 审查三问

- **改动的函数还有谁在用**：`retryFailedAsrSegments` 只被 `trial.mjs::ensureAsrRun` 和本次新增单测引用；`ensureAsrRun`/`saveAsrRun` 只在本脚本内用；全仓库搜 `deepseek-trial`、`asrReliability`、`retryFailedAsrSegments`，除本卡、报告和该目录外没有别的代码引用；`decode.rs` 仍是 `#[path]` 只读引用，未改动。
- **接外部程序的部分有没有真实跑过**：本轮真实跑过 ASR（35 段一次、1 段补跑、3 段 4 秒抽查、`full` 续跑补 5 段）、OCR 单页、chat completions 挑词、`cargo run` 解码 MP3。未真实跑的是「ASR 持续失败后恢复」的完整链路：失败分支用临时探针拦截请求模拟（HTTP 未发出），成功补跑用真实接口，两段各自真实、拼在一起不是一次真实网络故障。
- **同类问题别处还有没有**：挑词/OCR/TTS 遇错会直接抛错、退出 1，`resume` 会补跑（上一轮已验证一次）；`verify-starts` 只要有样本不达标就退出 1；`runTts` 按文件名跳过已生成文件，中断后续跑不会重复计费。剩下的同类小问题见下面第 2、3 条。

#### 问题清单（按严重程度）

1. **提示（本卡）**：报告里第 2 页的词表和耗时是单次运行结果，模型输出有随机性。复现：`node app/dev/deepseek-trial/trial.mjs verify`，本轮得到新流程 13 词（多一个 `cap`）、挑词 21.2 秒，报告写 12 词、61.7 秒。不影响「交集高、差距小」的结论，但读者可能误以为能逐字复现；建议给这类数字注明「单次结果」或轮次。
2. **提示（本卡）**：`verify` 判定失败时删了 `asrB.wer`、`rawWholeFileWer`、`cost`、`clipMarkers`，却留下 `asrB.werScope` 和上一轮的 `notes` 数据，结果文件里看起来像「有 WER 说明却没有 WER」。复现：本轮探针跑 `verify-resume` 后看 `verify-results.json` 的 `asrB` 键（`segmentation,run,werScope`）。不影响退出码和验收，建议把 `werScope` 一起清掉或在 `status` 里写明。
3. **提示（本卡）**：`full` 失败后用 `resume` 补跑成功，`result.status` 仍停留在「实测未完成：…仍有 N 段 ASR 失败」。复现：真实 `full` 检查点（A3 1 段、B1 4 段失败）先探针跑 `resume`（退出 1），再联网 `resume`（退出 0、WER 齐全），`trial-results.json` 的 `status` 仍是上一句失败文案。只影响读结果文件的人，建议成功收尾时清除或改写 status。

验收结论：通过

### 警告（调度脚本记录）
- 警告（本卡·提示）：报告第 2 页的词表和耗时是单次运行结果：本轮复跑同一命令得到新流程 13 词（多一个 cap）、挑词 21.2 秒，报告写 12 词、61.7 秒，读者可能误以为能逐字复现。建议：给这类数字注明「单次结果，模型输出会有出入」或标注轮次。
- 警告（本卡·提示）：verify 判定失败时删了 asrB.wer、rawWholeFileWer、cost、clipMarkers，却留下 asrB.werScope 和上一轮的 notes 数据，结果文件看起来像「有 WER 说明却没有 WER」。建议：失败时把 werScope 一并清掉，或在 status 字段里写明原因。
- 警告（本卡·提示）：full 失败后用 resume 补跑成功，result.status 仍停留在「实测未完成：…仍有 N 段 ASR 失败」，读结果文件的人会以为还没跑完。建议：成功收尾时清除 status 或改写成「实测完成」。
