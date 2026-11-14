# DeepSeek 新接口实测（075）

## 结论先说

**目前四项都建议“再观察”，不建议这轮直接做成正式功能。** ASR 正文识别不错；新增的三处 4 秒片段自动起点核对均通过，但接口本身没有时间戳，静音切段仍只是近似时间，三处抽查也不能代替完整听证。OCR 两种做法挑出的词大多相同，速度和单价差距很小，错字/漏词仍需用户判断。TTS 文件已合成，但没有人工试听，暂时不能评价声音是否自然。

有一件影响很大的素材问题：RSS 标注音频长 **411 秒**，实际下载的 MP3 经应用解码后是 **591.07 秒**。ASR 在开头和结尾识别出约 3 分钟插播广告（Whole Foods、Claude 等）。所以“整份音频对逐字稿”的原始 WER 会被广告严重拉高；本文另按节目开场/收尾短语裁掉广告，只用节目正文算 WER，并同时保留整份文件 WER。

## 总表与建议

| 项目 | 实测结果 | 能否直接满足应用需求 | 建议 | 若以后做，主要涉及文件 |
|---|---|---|---|---|
| ASR A：固定切块 | 正文 WER 5.64%（并发 1 完整）；110 秒切块、6 次请求，66.9 秒。并发 3 有 1 次连接重置，WER 36.07% 是缺一块后的不完整值。 | 不行。接口只回全文，没有时间戳；固定块的时间不能当逐句时间。 | 再观察 | `app/utils/transcribeConfig.ts`、`app/components/SettingsTranscribe.tsx`、`app/utils/importJob.ts`、`app/src-tauri/src/cloud_asr.rs`、`app/src-tauri/src/import.rs`、`app/src-tauri/src/lib.rs`；新增 DeepSeek provider 请求模块并同步 `app/mobile/transcribe.ts`。 |
| ASR B：停顿切句 | 35 段，平均 16.89 秒、最长 20 秒；并发 3 全部成功，正文 WER 5.23%、53.3 秒。并发 1 有 4 次网络重置，112.8 秒；另对正文 3 段起点各截 4 秒复送 ASR，3/3 达到至少 2 个顺序匹配词。 | 自动抽查支持这 3 个起点与对应文字相符；时间仍是本地静音切段边界，不是 DeepSeek 返回的句子时间戳，也不是完整听证。 | 再观察 | 与 A 相同；另需把 `app/src-tauri/src/decode.rs` 的解码和本地 VAD/分句接入现有云转录拼接逻辑。 |
| 录入笔记：看图挑词（旧） | 两页共识别 21 个输出项（第 3 页有重复 `flick`）；看图模型为 `deepseek-flash`。两页共约 113.3 秒。 | 可继续作为对照基线；模型会自行补全/判断字迹。 | 再观察 | 现有 `app/utils/vocab/inbox.ts`、`app/utils/vocab/noteJob.ts`、`app/utils/vocab/noteMedia.ts`。 |
| OCR + 文本挑词（新） | 第 2 页两边交集 10 个词；第 3 页交集 7 个词。OCR 各约 3.3 秒，文本挑词约 39.7–61.7 秒；两页 OCR+挑词约 108.0 秒，和旧做法相近。 | 不能证明更准；图像模型与 OCR 文本模型在第 2 页拼写、备注和不确定标记上有差异，第 3 页还出现 `cumple`。 | 再观察 | `app/utils/vocab/inbox.ts`（OCR 接口、挑词提示词）、`app/utils/vocab/noteJob.ts`（每页阶段与错误/重试）、`app/utils/vocab/noteMedia.ts`（逐页图片）。 |
| TTS | `stella`、`tide` 各合成两句，4 个 WAV 均为 24kHz、单声道、16-bit，时长 2.76–3.92 秒。请求耗时 1.7–2.7 秒。 | 文件格式有效；声音自然度、发音与两种声音差异**未试听**。接口不能调语速。 | 再观察 | 可能复用 `app/utils/speech.ts`、`app/components/vocab/VoiceButton.tsx`；若给用户选声音，再补设置项和配置存储。 |

## 素材、方法与价格

- **音频**：BBC 6 Minute English，*Learning from different generations*，2026-11-12，RSS GUID `p0pmkr5c`。音频来自 `app/pro/podcastShows.ts` 的 BBC RSS：<https://podcasts.files.bbci.co.uk/p02pc9tn.rss>。节目页：<https://www.bbc.co.uk/learningenglish/english/features/6-minute-english_2026/ep-261112>。
- **官方逐字稿**：<https://downloads.bbc.co.uk/learningenglish/features/6min/261112_6_minute_english_learning_from_different_generations_transcript.pdf>。PDF 自己注明“不是逐字稿”，所以 WER 也会受 BBC 文稿与实际播音差异影响。
- **解码**：没有装 ffmpeg。实测小工具直接调用应用的 `app/src-tauri/src/decode.rs::to_wav`，输出 16kHz、单声道、16-bit PCM WAV；输入 MP3 实际解码时长 591.07 秒。
- **ASR**：A 以 110 秒切块；B 每 20ms 算一次 RMS，阈值 −38dBFS，连续 240ms 以下视为静音，目标段长 18 秒、上限 20 秒。每段上传 `/v1/tools/asr`，再按段拼接；接口没有时间戳。
- **逐字稿对照**：小写化、去标点后按词计算编辑距离 WER。节目正文使用共同开场短语 `So Georgie, do you often spend time with people...` 和结尾短语 `Thanks for joining us and goodbye` 对齐，裁掉头尾广告；未把人名异写自动归一（例如 ASR 的 `Myra Nuby` 与官方写法 `Myra Anubi`）。完整音频未裁切 WER 另列，不能拿它代表 ASR 正文准确率。
- **OCR 输入**：用户 PDF 只读，共 4 页；第 2、3 页有笔记，第 1、4 页基本空白。为贴近应用，PDF 页按长边 2000px、JPEG 质量 85 渲染，生成图只写在任务允许的临时输出目录。OCR 对比仅用第 2、3 页；另外按要求把整份 PDF 直接送 OCR，并对第 2 页再试 `rich_layout_recognition`。
- **模型**：`GET https://api.deepseek.com/models` 返回 `deepseek-flash`、`deepseek-v4-pro`；采用其中支持看图的 `deepseek-flash`。图像挑词沿用 `app/utils/vocab/inbox.ts` 提示词；OCR 后文本挑词只把开头改成“请从这段 OCR 文字里挑词”，其他规则相同。
- **价格来源**：DeepSeek 官方 [ASR 文档](https://api-docs.deepseek.com/guides/asr)、[OCR 文档](https://api-docs.deepseek.com/guides/ocr)、[TTS 文档](https://api-docs.deepseek.com/guides/tts)、[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)，实测日 2026-11-14。ASR 限时价 $0.058/小时、标准价 $0.116/小时；OCR $0.225/千页；TTS 限时价 $0.225/万字符、标准价 $0.45/万字符。`deepseek-flash` 当时是 UTC 非高峰，输入未命中缓存 $0.15/百万 token、缓存命中 $0.003、输出 $0.60；输出费用包含模型推理 token。

## ASR 结果

正文 WER 和请求情况：

| 方案 | 并发 | 请求 / 失败 | 总耗时 | 正文 WER | 说明 |
|---|---:|---:|---:|---:|---|
| A 固定 110 秒 | 1 | 6 / 0 | 66.9 秒 | 5.64% | 完整结果 |
| A 固定 110 秒 | 3 | 6 / 1 | 52.3 秒 | 36.07%† | 1 次 `UND_ERR_SOCKET`，少了一块；WER 不可与完整结果等同 |
| B 停顿切句 | 1 | 35 / 4 | 112.8 秒 | 5.23%† | 4 次 `UND_ERR_SOCKET` / `ECONNRESET` 都落在片头广告段（0–65.5 秒）；裁去广告后正文 WER 与并发 3 相同，但这轮请求不完整 |
| B 停顿切句 | 3 | 35 / 0 | 53.3 秒 | 5.23% | 完整结果 |

并发 3 的 B 单次完整测试计费音频秒数 2,227 秒（A/B 各并发 1/3 共四轮，失败请求未计入成功音频秒），ASR 限时价约 **$0.03588**，标准价约 **$0.07176**。B 的末尾标点机械检查是 0/35 段没有句末标点；这只说明每段 ASR 输出都带句末标点，不证明切段一定落在真实句子边界。

**抽取 10 段“开始时间—结束时间—ASR 文字”**（时间单位秒；3 段广告识别也保留，因为音频确实包含它们）：

1. `0.00–17.75` — This BBC podcast is supported by ads outside the UK. Host Thanksgiving with industry-leading quality standards from Whole Foods Market…
2. `65.53–83.86` — Describe the website or prototype you're picturing. Attach your design system, and it comes back in your own design language…
3. `135.14–154.37` — People, lots of younger people. We can call an age group of people a generation…
4. `187.62–204.37` — Okay. Well, we will find out the answer at the end of the program. Okay, Phil. So you said we're going to look at a project…
5. `258.44–275.30` — Doing such and such a thing, why don't you come and join us? And that's what I've been doing…
6. `329.68–342.33` — Well, the charity Ready Generations, which runs the nursery, says it works with universities to study the effects of mixing generations…
7. `396.06–414.11` — For example, a stereotype about generations is that younger people are lively…
8. `447.64–464.74` — Just like you, ah. Okay, let's recap the vocabulary we learned in this program…
9. `519.54–535.64` — Sometimes we all need an extra helping hand… Claude is an AI for just that…
10. `581.31–591.07` — And check out Claude Pro, which includes access to all of the features mentioned in today's episode…

**报告样本起点自动核对（按用户选择，不做人工试听）**：从 `episode-16k-mono.wav` 按报告开始时间各截 4 秒，逐段调用 ASR；将识别开头前 12 词与原段前 20 词作最长公共子序列比较，至少 2 个顺序匹配词算通过。样本 #3（135.14 秒）识别 “People, lots of younger people. We can call an age group of.”，匹配 12 词，2.80 秒；样本 #4（187.62 秒）识别 “Okay. Well, we will find out the answer at the end of the program.”，匹配 12 词，2.19 秒；样本 #6（329.68 秒）识别 “Well, the charity ready generations which runs the nursery.”，匹配 9 词，1.95 秒。**3/3 通过**，共计费音频 12 秒，限时价约 **$0.00019**（标准价约 $0.00039）。这是自动抽查，不冒充人工听证，也不能证明未抽查位置都准确。

**10 个分散抽样的 WER 差异例子**（`∅` 表示插入/漏掉；不是人工听证结果）：

- A 并发 1：插入 `six`、`be`、`that`、`old`；`phoned → throw`；漏掉 `rumour`、`there`；`ok → okay`；插入 `on`、`com`。
- B 并发 3：插入 `six`、`be`、`project`；`ok → okay`、`the → in`；漏掉 `rumour`；`wellbeing → being`、`ok → okay`；插入 `on`、`com`。

人名异写不做自动归一。完整文件（含广告）B 并发 3 的 WER 是 **64.22%**；按节目边界裁切后的正文 WER 是 **5.23%**。差距主要来自插播广告，不应解读为模型正文准确率突然变化。

## OCR + 挑词结果

| 页 | 旧：看图直接挑词 | 新：OCR 后文本挑词 | 词目对比 | 旧耗时 | 新 OCR + 挑词 |
|---|---:|---:|---|---:|---:|
| 2 | 12 项，77.9 秒 | 12 项，3.3 + 61.7 = 65.1 秒 | 两边都有 10；只旧：`be capped at`、`sympathise`；只新：`be capped`、`sympathize` | 77.9 秒 | 65.1 秒 |
| 3 | 9 项（`flick` 重复），35.4 秒 | 9 项，3.3 + 39.7 = 43.0 秒 | 两边都有 7；只旧：`ample`；只新：`mandate`、`cumple` | 35.4 秒 | 43.0 秒 |

词目并排结论：第 2 页共有 `indispensable`、`chronological`、`authorize`、`penalty`、`counsel`、`council`、`emphasize`、`empathize`、`distribute`、`allocate` 等 10 项；第 3 页共有 `hook`、`way too much`、`impose`、`register`、`flavor`、`flick`、`annotate` 等 7 项。OCR 原文能读到 `ample`，但文本挑词结果给出 `cumple`；这是新流程需留意的实际差异。结果只供用户对照原笔记判断，不自动宣布哪边正确。

整份 4 页 PDF 直接 `text_recognition` 返回 4 页，记录耗时 **15.316 秒**；第 4 页空白页输出大量重复的页码“1”，并以 `finish_reason=length` 截断。第 2 页单独 `rich_layout_recognition` 返回 1 页、约 3.3 秒，带坐标框标记，文字可定位，但没有证明对挑词更准。

两页的已返回模型 usage 计价：旧看图挑词约 **$0.01196**；新 OCR + 挑词约 **$0.01186**（其中两页 OCR 约 $0.00045）。新流程总耗时约少 5.3 秒，但差距很小；单页挑词模型输出 token 费用远大于 OCR 本身，目前看不出值得为此增加正式流程的差距。

### OCR 原文（跳过空白页后，前 30 行）

```text
# 好东西
indispensable necessary
Cars have become an indispensable part of our lives
chronological
authorize mandate $^{9.13}$ to give official permission for
e.g. authorize payments up to 5000¥
authorize <sup>sth.</sup> sb. to do
penalty — a punishment for breaking a rule (also used in sports)
(for doing) to impose a penalty
disadvantage e.g. one of the penalties of fame is loss of privacy
be capped <sup>cap</sup> be limited to
<sup>cap</sup>
counsel advice, especially given by experts
council 委员会
emphasize give special importance to
empathize resonate 共情
sympathize understand the feelings of 同情
distribute 强调平分,分散
allocate give sth. officially to sb/sth for a particular purpos
# 口语 hook 钩 $\rightarrow$ 钩住 $\rightarrow$ 吸住
way too much
impose — introduce a new law, rule, tax, etc; 推行
mandate order sth to be used 强制执行
e.g. impose a penalty
a new tax was imposed on fuel
$\downarrow$
to force sth. to deal with sth difficult/unpleasant 强加于
e.g. the limitation imposed by disease
impose sth. upon sb. e.g. impose additional financial burdens on many people
register
```

## TTS 与移动端可行性

- 两个 voice ID 都支持英文：`stella`（女声）和 `tide`（男声）。例句为 “Intergenerational projects can help fill a void.”、 “Clear notes make it easier to learn new vocabulary.” 各生成两份。
- 文件：`D:\tmp\es-test\deepseek\out\tts\stella-1.wav`、`stella-2.wav`、`tide-1.wav`、`tide-2.wav`。实测 24kHz、单声道、16-bit PCM；播放时长依次约 3.04、3.92、2.76、3.44 秒。接口流式 WAV 原头部的长度是 `0xffffffff`，脚本已按实际字节修正 RIFF/data 长度，并检查四份头部与文件长度一致。**未试听，不对音质作结论。**
- 198 个计费字符，TTS 限时价约 **$0.00446**，标准价约 **$0.00891**。官方接口不能调语速；若做正式功能，适用面可能是词条/例句朗读，需与现在的 Edge Neural / 系统语音（`app/utils/speech.ts`）比较后再决定。
- 手机 WebView 可考虑 `decodeAudioData` 解 MP3，再混成单声道、重采样、转 PCM16 并写 WAV 头，大约 40–80 行 TypeScript。但 591 秒、44.1kHz、立体声的 32-bit float 解码缓冲可能约 199MiB（还不含复制和 canvas/上传开销）；应用已有 Rust 解码 `decode.rs`，手机上优先评估复用 Rust/流式处理。这里只审代码，未在手机运行。

## 费用汇总与建议

一个完整对照批次（A/B 各并发 1、3；两页 OCR 对照；整份 PDF OCR；一页 rich OCR；四条 TTS）按已记录 usage 估算，限时价约 **$0.0653**，标准价约 **$0.1056**。ASR 约 $0.03588 / $0.07176，旧看图模型 $0.01196，新 OCR+挑词 $0.01186，整份 PDF OCR $0.00090，rich OCR $0.000225，TTS $0.00446 / $0.00891。新增三段起点核对另约 $0.00019 / $0.00039。模型输出计费包含大量 reasoning tokens，所以短短 12 个词的挑词调用仍花约 40–78 秒。

本卡为了处理连接重置、提高图片分辨率到应用实际使用的 2000px，并做最终复验，重复执行了完整 ASR 或 OCR 子流程。按成功返回的 usage、重复完整 ASR 轮次和官方限时价格估算（含本次 12 秒起点核对），**本卡累计至少约 $0.17**；连接重置后服务端是否已完成并计费、但客户端没有拿到 usage 的请求无法从本机日志核实，因此实际账单可能略高。单次完整批次与任务累计费用分开列，避免把重复试验误当成一次功能成本。

**推荐：**

1. **ASR A：再观察。** 正文 WER 看起来不错，但固定 110 秒块不提供逐句时间，不能直接满足精听字幕需求；并发 3 还丢过一块。
2. **ASR B：再观察。** 5.23% 正文 WER、并发 3 35/35 请求成功；三处正文段首的 4 秒自动 ASR 抽查为 3/3 通过。不过接口仍无时间戳，35 段平均 16.9 秒只是静音边界，并不等于逐句字幕；仅三点抽查不足以支撑正式接入，还需评估重试、插播广告和取消任务。本轮不做人工试听。
3. **OCR + 挑词：再观察。** 两法词目交集高、耗时差距小；新方案有拼写/补词差异，整份 PDF OCR 对空白页的输出也不理想。暂时不值得增加两段式请求和 UI 复杂度。
4. **TTS：再观察。** 合成快、单价低，WAV 已可播放；但本次无人试听，且没有语速选项。听证并和现有语音比较后再决定。

## 复跑命令与输出

从仓库根目录执行（密钥只从 `D:\tmp\es-keys\deepseek.env` 读取；报告、日志、WAV 均不写密钥）：

```powershell
node --test app/dev/deepseek-trial/asrReliability.test.mjs
node app/dev/deepseek-trial/trial.mjs full
node app/dev/deepseek-trial/trial.mjs verify
node app/dev/deepseek-trial/trial.mjs verify-starts
```

`verify` 会跑整段 B（覆盖卡片要求的前 3 分钟以上）和第 2 页 OCR+挑词；ASR 失败段会自动重试最多 2 次。重试后仍有失败时会保存检查点、以非零退出码结束，不计算/保留该轮 WER 作为有效结果；网络恢复后执行下面命令，只补跑失败段：

```powershell
node app/dev/deepseek-trial/trial.mjs verify-resume
```

`full` 若仍有 ASR 失败，也会以非零退出码结束；网络恢复后用 `node app/dev/deepseek-trial/trial.mjs resume` 从检查点续跑并补试失败段。

此前一次完整复验跑完 35 段，正文 WER 5.23%，第 2 页 OCR+挑词完成并退出码 0；旧轮次遇到的连接重置已在上表说明。本次脚本新增失败重试和非零失败门控，`verify-resume` 会重试检查点里仍失败的段。`verify-starts` 对报告样本 #3/#4/#6 各取 4 秒再送 ASR，3/3 通过。

结果位于 `D:\tmp\es-test\deepseek\out\`：`trial-results.json`、`verify-results.json`、`trial-partial.json`、`verify-partial.json`、`start-check-results.json`、16k WAV、逐页 JPEG、TTS WAV。下载的 MP3、BBC 原始 transcript PDF 和提取文本放在 `D:\tmp\es-test\deepseek\audio\`。用户原笔记 PDF 只读，没有复制进仓库。
