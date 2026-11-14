# 009-agent名单抽成文件

- 状态：已关闭（Claude 复核通过 2026-11-04：复跑 node --check、名单 JSON、007/004 预览均符合）
- 难度：体力
- 实现：dsh-k3
- 验收：dsh-flash
- 所属阶段：工具（为 agent-board 看板第 2 步「拖拽分派」服务）
- 依赖：无

<!-- 「实现」「验收」各只填一个名字，且不能相同。填 claude 表示不交给调度脚本。
     「允许改动的路径」里的路径必须用反引号包起来，脚本只认反引号里的内容（* 不跨目录，** 跨目录）。
     「验收标准」要写成别人照着就能复跑的命令和预期结果。 -->


## 目标（一两句话，用户能看懂）

把调度脚本里写死的执行者名单搬到一个单独的文件 `scripts/agents.json`，让调度脚本和 agent-board 看板读同一份名单；并支持给某个执行者标记「暂时不可用」，被标记的执行者脚本不派活。

## 允许改动的路径

- `scripts/agents.json`
- `scripts/dispatch.mjs`
- `docs/dispatch.md`

## 要做的

1. 新建 `scripts/agents.json`，内容照抄（键名、字段都不要改；JSON 不能写注释，说明放在 `说明` 字段）：

   ```json
   {
     "说明": "调度脚本 scripts/dispatch.mjs 和 agent-board 看板共用的执行者名单。任务卡「实现」「验收」只能填这里的名字，或 claude（不归脚本管）。down 字段非空表示暂时不可用，脚本不会派活给它。",
     "agents": {
       "codex-luna":  { "kind": "codex", "model": "gpt-6-luna",  "label": "gpt-6-luna",     "role": "体力活" },
       "codex-astra": { "kind": "codex", "model": "gpt-6-astra", "label": "gpt-6-astra",    "role": "难卡 / 交叉验收", "down": "转发接口 429/502（2026-11-04）" },
       "dsh-flash":   { "kind": "dsh",   "patch": "scripts/dsh/flash.patch.yml", "label": "deepseek-flash", "role": "体力活" },
       "dsh-k3":      { "kind": "dsh",   "patch": "scripts/dsh/k3.patch.yml",    "label": "Kimi K3.1 Pro",  "role": "体力活" }
     }
   }
   ```
2. `scripts/dispatch.mjs`：删掉代码里的 `const AGENTS = { ... }`，改成启动时读 `scripts/agents.json` 的 `agents`（用已有的 `REPO` 拼路径，`readFileSync` + `JSON.parse`）。文件不存在或 JSON 坏了 → 打印中文错误并以退出码 1 结束。其余用到 `AGENTS` 的地方行为不变。
3. 「不可用」：单张卡的前置检查里，如果实现者或验收者在名单里带非空 `down`，这张卡结果为「跳过」，原因写「执行者 X 暂时不可用：<down 的内容>」，不调用任何 agent、不改卡片。`--dry-run` 打印的计划里，带 `down` 的名字后面加「（不可用：<down>）」。`--all` 选卡时也跳过这种卡。
4. `docs/dispatch.md`：「分工」或「执行者调用方式」附近加一小段：名单在 `scripts/agents.json`，怎么标记/取消不可用（加/删 `down` 字段），看板也读这个文件。

## 验收标准（验收者照着复跑）

1. `node --check scripts/dispatch.mjs` 无输出、退出码 0；`node -e "const j=JSON.parse(require('fs').readFileSync('scripts/agents.json','utf8'));console.log(Object.keys(j.agents).join(','), j.agents['codex-astra'].down)"` 输出 `codex-luna,codex-astra,dsh-flash,dsh-k3 转发接口 429/502（2026-11-04）`。
2. `grep -n "const AGENTS = {" scripts/dispatch.mjs` 无结果（名单不再写死）。
3. `node scripts/dispatch.mjs 007 --dry-run` 正常打印计划，其中实现 `dsh-k3`、验收 `dsh-flash`，无报错。
4. `node scripts/dispatch.mjs 004 --dry-run` 的输出里，`codex-astra` 后面带「（不可用：转发接口 429/502（2026-11-04））」或该卡结果为「跳过」且原因含「暂时不可用」。（004 已关闭，若脚本先因状态跳过，请在验收记录里说明，并改用读代码确认 down 检查在前置检查里。）
5. 名单文件损坏时的行为：把 `scripts/agents.json` **复制**到系统临时目录做备份，往原文件末尾加一个字符 `x` 使其变成坏 JSON，运行 `node scripts/dispatch.mjs 007 --dry-run` → 输出中文错误、退出码 1；然后用备份**恢复原文件并确认逐字节一致**（`cmp` 无输出）。
6. `git status` 只有允许路径内的文件（本卡除外）。

## 不做什么

- 不改执行者的调用方式、提示词、流程顺序。
- 不碰 `scripts/dsh/*.patch.yml`。

---

## 结束报告（实现者填）

- 改了什么：新建 `scripts/agents.json` 并照抄四名执行者配置；`scripts/dispatch.mjs` 改为启动时读取该文件，坏 JSON 或文件缺失时打印中文错误并退出 1；预览会标注 `down`，单卡前置检查会跳过不可用的实现者/验收者，`--all` 也会过滤；`docs/dispatch.md` 补充名单位置及加/删 `down` 的说明。
- 代码审阅：确认写死的 `const AGENTS = { ... }` 已删除；不可用检查位于改状态、检查工作区和调用 agent 之前，单卡跳过不会改卡片；`--all` 的过滤同时检查实现者和验收者。未改执行者调用方式、提示词和其余流程。`git diff --check` 退出码 0（仅有 Git 的 LF/CRLF 提示）。
- 自动测试：`node --check scripts/dispatch.mjs` 通过；名单 JSON 解析输出四名执行者及 codex-astra 的 down 原因；007 预览正常，004 预览在 codex-astra 后显示不可用原因。分别临时制造坏 JSON、删除本次新建的名单文件，命令均输出中文错误且退出 1，随后按原字节恢复，SHA-256 一致。临时给实现者 dsh-k3 加 down 后跑 007，以及对验收者 codex-astra 已有 down 的 004 跑非 dry-run，均直接「跳过」、退出 1、卡片哈希不变，输出中没有调用 agent。`git status` 仅有三个允许路径和本任务卡。
- 真实环境：已在本机 Windows / Node 实际运行上述预览和前置检查；未调用外部 agent，无 UI 改动。
- 未验证：`--all --dry-run` 实跑时仓库没有「待认领」卡，按既有逻辑打印用法并退出 2，因此 down 的批量过滤仅有代码审阅证据；未验证真实派活全流程及 agent-board 看板读取名单。

## 验收记录（验收者填，不能是实现者本人；最后单独一行写「验收结论：通过」或「验收结论：不通过」）

### 第 1 轮 @dsh-flash 2026-11-04

复核方式：git status / git diff 看改动（HEAD `4a692df` 是改动前状态），逐条实跑卡片验收标准，另补做两项卡片没要求但值得确认的测试。所有命令在 Windows 11 + PowerShell 5.1 + Node v24.20.0 下执行；含中文的比对脚本先写成 UTF-8 文件再用 node 跑，结果写入 UTF-8 文件再读，避免管道把中文变成 `???`。

改动范围（`git status --porcelain -uall`）：`M docs/dispatch.md`、`M scripts/dispatch.mjs`、`?? scripts/agents.json`，加本卡。三个文件都落在「允许改动的路径」内，无越界。

**验收标准 1：通过（两项都实跑）**
- `node --check scripts/dispatch.mjs` → 无任何输出，退出码 0。
- 等价于卡片 `node -e` 的读取脚本（写成文件跑，避免命令行传中文）输出：`codex-luna,codex-astra,dsh-flash,dsh-k3 转发接口 429/502（2026-11-04）`，与卡片要求逐字一致。
- 追加核对：把卡片里的 JSON 代码块解析出来与 `scripts/agents.json` 逐字段比较 → 顶层键都是 `["说明","agents"]`，`说明` 相同，四名执行者的每个字段（kind / model / patch / label / role / down）全部一致，没有漏字段或改键名。

**验收标准 2：通过**
- `grep -n "const AGENTS = {" scripts/dispatch.mjs` → 无结果（全仓只有本卡正文里出现这串字）。名单已改成第 35-42 行启动时 `readFileSync` + `JSON.parse` 读 `scripts/agents.json`。

**验收标准 3：通过**
- `node scripts/dispatch.mjs 007 --dry-run` → 退出码 0，无报错。输出：
  ```
  docs/tasks/007-词库Markdown解析器.md
    状态：已关闭（Claude 复核通过 2026-11-04）
    实现：dsh-k3  验收：dsh-flash
    允许改动：app/utils/vocab/parse.ts  app/utils/vocab/types.ts  app/test-vocab-parse.mjs  app/dev/vocab-count.mjs  app/dev/fixtures/vocab/**
  ```
  实现 `dsh-k3`、验收 `dsh-flash` 正确。

**验收标准 4：通过**
- `node scripts/dispatch.mjs 004 --dry-run` → 退出码 0，输出里该行为 `实现：dsh-k3  验收：codex-astra（不可用：转发接口 429/502（2026-11-04））`，正好命中卡片允许的第一种情况。（004 状态是「已关闭」，但脚本对单卡不按状态拦，预览照常打印，所以不需要改用读代码。）
- 追加核对：`node scripts/dispatch.mjs 004`（**非** dry-run）→ 输出 `- 004：跳过（执行者 codex-astra 暂时不可用：转发接口 429/502（2026-11-04））`，退出码 1；卡片 004 SHA-256 运行前后都是 `9c1dd265…be081`（没被改「状态」行），`.dispatch/` 没有新增任何 agent 日志文件，说明确实没调用 agent。

**验收标准 5：通过（已按字节恢复）**
- 原文件 822 字节，SHA-256 `38c75d57…6d56f0`；备份到 `%TEMP%\es-verify-009\agents.json.bak`。
- 末尾加一个 `x`（823 字节，`JSON.parse` 报 `Unexpected non-whitespace character after JSON at position 644`）。
- `node scripts/dispatch.mjs 007 --dry-run` → 退出码 1，stdout 空，stderr：`调度脚本出错：读取执行者名单 scripts/agents.json 失败：Unexpected non-whitespace character after JSON at position 644 (line 10 column 1)`。
- 用备份写回后：822 字节，SHA-256 回到 `38c75d57…6d56f0`，`Buffer.equals` 逐字节比较为 `true`；PowerShell `Get-FileHash` 独立复核同样是 `38C75D57A51A96AE97424F2505A89E92B9888777D82A48A99563C6AEF46D56F0`。（本机没走 `cmp`，用哈希 + 字节比较代替，结论等价。）

**验收标准 6：通过**
- `git status --porcelain -uall` 只有：`M docs/dispatch.md`、`M scripts/dispatch.mjs`、`?? scripts/agents.json`、`M docs/tasks/009-agent名单抽成文件.md`（本卡）。`git diff --check` 退出码 0（仅有 Git 的 LF/CRLF 提示）。

**追加验证（卡片没要求，为补实现者「未验证」的空白）**
- `--all` 的 down 过滤：仓库里确实没有「待认领」卡，`--all` 只会打印用法并退出 2，所以我在临时目录 `D:/tmp/es-test/009-all` 做了一份副本（复制 `scripts/dispatch.mjs`、改过的 `scripts/agents.json`，另写 901/902/903 三张假卡）。给 `dsh-k3` 加 down 后 `--all --dry-run` **只列出 903**，901（实现者 dsh-k3 不可用）和 902（验收者 dsh-k3 不可用）都被过滤；把 down 去掉再跑，三张全列出。退出码都 0。→ 卡片要的「`--all` 也跳过不可用卡」有实跑证据了，不是只有代码审阅。
- 复制一份名单做结构比对前先确认仓库文件哈希不变（38C75D…），测试结束再确认一次，仍是 38C75D…；临时目录已删（两个 `Test-Path` 都为 False）。

### 问题清单（按严重程度排序）

1. **低：坏名单时错误信息是中英混排**。中文前缀后面直接接 Node 的英文原文（`Unexpected non-whitespace character after JSON at position 644`），用户看不出「该去改哪个文件」以外的具体动作。
   复现：`scripts/agents.json` 末尾加 `x` → `node scripts/dispatch.mjs 007 --dry-run`。
   影响：不阻断，退出码和信息都符合卡片要求；只是提示可以更好（例如补一句「名单文件不是合法 JSON，请检查 scripts/agents.json」）。
2. **低：名单字段没做校验，写坏要等到 spawn 才炸**。`kind` 拼错（比如写成 `openai`）会落到 `runAgent` 的 `else`（DSH）分支，`path.join(REPO, a.patch)` 因 `patch` 为 undefined 抛 TypeError；`kind: "codex"` 但缺 `model` 会拼出 `-m undefined` 传给 codex。
   复现（代码审阅推断，**未实跑**）：把 `dsh-flash` 的 `kind` 改成任意非 `codex`/`dsh` 的值，再跑任意非 dry-run 卡。
   影响：会以「调度脚本出错」退出 1，不会静默派错活，但排查成本高。卡片没要求校验，属建议项。
3. **提示：`down` 原因只报第一个**。实现者和验收者都带 `down` 时，单卡「跳过」原因只写实现者那句（预览里两个名字都会标）。
   复现：给 `dsh-k3`、`dsh-flash` 同时加 `down`，跑 `node scripts/dispatch.mjs 007 --dry-run`（预览两人都标）再跑非 dry-run（原因只提实现者）。
   影响：符合卡片「原因写执行者 X 暂时不可用」的字面要求，仅信息量略少。
4. **提示：`.dispatch/last-summary.md` 被我这次非 dry-run 测试覆盖了**（该文件在 `.gitignore` 第 27 行里，脚本每次非 dry-run 都会重写，属脚本自己的运行产物）。复现：任何一次非 dry-run 都会覆盖它。影响：不影响仓库和验收结论，仅告知。

### 未验证项
- 真实派活全流程（从头调 codex/dsh 到自动提交）：没有「待认领」卡，且真跑会调外部 agent、产生费用，本次不做。
- agent-board 看板读取 `scripts/agents.json`：仓库里目前没有 agent-board 相关代码（全仓 grep 只在文档和名单的 `说明` 里出现「agent-board」），看板侧无从验证。
- 名单文件**被删掉**（missing）的情形：只做了代码审阅（与坏 JSON 同一处 `try/catch`，`readFileSync` 抛 ENOENT 走同一分支），没实跑删除，避免把仓库里的新文件弄丢。

验收结论：通过
