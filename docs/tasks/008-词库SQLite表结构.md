# 008-词库 SQLite 表结构与迁移（Rust 侧）

- 状态：已关闭（Claude 复核通过 2026-11-04）
- 难度：难（表结构由 Claude 在本卡定死，实现者照做）
- 实现：dsh-k3 （原定 codex-astra，其转发接口 429/502 不可用，2026-11-04 改）
- 验收：dsh-flash
- 所属阶段：阶段 1（词库模块）
- 依赖：005（已关闭）。与 007 写入范围不重叠，可先后独立跑。

## 目标（一两句话，用户能看懂）

在应用的 Rust 一侧建好「词库数据库」的表结构：打开数据库时自动建表、以后能平滑升级。本卡只建表和写测试，不导入数据、不接界面。

## 背景（先读）

- `docs/vocab-data-model.md` 第 1.4 节（导入约束）、第 5.4 节（拍板：Rust 侧 SQLite、独立数据库文件、复用现有 `rusqlite`、不用 Tauri SQL 插件）。
- 现有用法参考：`app/src-tauri/src/paths.rs` 的 `app_data_dir()`；本地词典已在用 `rusqlite`（`Cargo.toml` 里 `rusqlite = { version = "0.37", features = ["bundled"] }`）。
- 字段要和 007 卡的解析结果一一对应（见 `docs/tasks/007-词库Markdown解析器.md` 第 2 节）。

## 要做的（表结构照抄，不要自行增删字段）

新建 `app/src-tauri/src/vocab/mod.rs`（只放 `pub mod schema;` 和 `#![allow(dead_code)]`，后面的导入卡会用到这些函数）与 `app/src-tauri/src/vocab/schema.rs`，并在 `app/src-tauri/src/lib.rs` 的模块列表里加一行 `mod vocab;`。

`schema.rs` 提供：

- `pub const SCHEMA_VERSION: i32 = 1;`
- `pub fn db_path() -> PathBuf`：`crate::paths::app_data_dir().join("vocab.db")`。
- `pub fn open(path: &Path) -> rusqlite::Result<Connection>`：打开（不存在就创建）→ `PRAGMA foreign_keys = ON` → 调 `migrate`。
- `pub fn migrate(conn: &Connection) -> rusqlite::Result<()>`：读 `PRAGMA user_version`；为 0 时在**一个事务里**建下面全部表和索引，再设 `user_version = 1`；已经是 1 就什么都不做；大于 `SCHEMA_VERSION` 返回错误（不能降级打开新版数据库）。

表（时间一律存 ISO 8601 文本；布尔存 0/1）：

```sql
CREATE TABLE upgrade_entry (
  id TEXT PRIMARY KEY,          -- 007 的 up:… ID
  ord INTEGER NOT NULL,         -- 在源文件中的顺序，用于按原顺序导出
  line INTEGER NOT NULL,        -- 源文件行号
  raw TEXT NOT NULL,            -- 原始整行，无损导出用
  plain TEXT NOT NULL,
  upgrade TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
);
CREATE TABLE upgrade_example (
  entry_id TEXT NOT NULL REFERENCES upgrade_entry(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,         -- 第几段例句，从 1 起
  cand TEXT NOT NULL,
  sentence TEXT NOT NULL,
  ai INTEGER NOT NULL CHECK (ai IN (0, 1)),
  PRIMARY KEY (entry_id, seq)
);
CREATE TABLE self_check (
  id TEXT PRIMARY KEY,          -- sc:…
  ord INTEGER NOT NULL,
  line INTEGER NOT NULL,
  raw TEXT NOT NULL,
  text TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
);
CREATE TABLE review_word (
  id TEXT PRIMARY KEY,          -- rv:…
  ord INTEGER NOT NULL,
  line INTEGER NOT NULL,
  raw TEXT NOT NULL,
  word TEXT NOT NULL,
  word_norm TEXT NOT NULL,      -- 规范化后的单词，查询用；允许重复（同词多行）
  issue TEXT NOT NULL,
  added_at TEXT NOT NULL,
  status TEXT NOT NULL,
  level INTEGER CHECK (level IS NULL OR level BETWEEN 1 AND 4),
  due TEXT NOT NULL,            -- 没有到期日时为空字符串
  note TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
);
CREATE INDEX review_word_norm ON review_word(word_norm);
CREATE INDEX review_word_due ON review_word(level, due);
CREATE TABLE import_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  started_at TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL
);
```

在 `schema.rs` 底部写 `#[cfg(test)] mod tests`，全部用内存数据库（`Connection::open_in_memory()`），至少覆盖：

1. 新库 `migrate` 后 `user_version = 1`，上面 5 张表都存在。
2. 连续调用两次 `migrate` 不报错，表和数据都不变（幂等）。
3. 手动把 `user_version` 设成 99 后调 `migrate` 返回错误。
4. `review_word` 插两行不同 `id`、相同 `word_norm` 能成功（允许同词多行）；插相同 `id` 失败。
5. `level = 5` 插入失败；`level = NULL` 和 `level = 3` 成功。
6. 开了外键：删除一条 `upgrade_entry` 后，它的 `upgrade_example` 跟着被删；插入指向不存在 `entry_id` 的例句失败。
7. `db_path()` 的文件名是 `vocab.db`，父目录等于 `paths::app_data_dir()`。

## 允许改动的路径

- `app/src-tauri/src/vocab/**`（新建）
- `app/src-tauri/src/lib.rs`（只加 `mod vocab;` 这一行）
- 本卡片

## 验收标准（验收者照着复跑）

在 `app/src-tauri` 目录下运行（如果找不到 `cargo`：先设环境变量 `RUSTUP_HOME=D:\rust\rustup`、`CARGO_HOME=D:\rust\cargo`，再用 `D:\rust\cargo\bin\cargo.exe`）：

1. `cargo test --lib vocab::` 全部通过，测试数 ≥ 7，逐条对应上面 1–7。
2. `cargo test --lib` 整体通过（不能因为本卡让原有 111 个左右的测试失败）。
3. `git diff app/src-tauri/src/lib.rs` 只有新增 `mod vocab;` 一行。
4. 表结构与本卡 SQL 一致：验收者在 `D:\tmp\` 写一次性测试或用 `sqlite3`/rusqlite 打开一个由 `open()` 新建的临时库，`SELECT sql FROM sqlite_master` 的字段名、约束与本卡逐项对得上（允许空白与大小写差异）。
5. 没有新增 Cargo 依赖（`git diff app/src-tauri/Cargo.toml` 为空），没有改 `app/` 下 Rust 以外的任何文件。

## 不做什么

- 不写导入逻辑、不写 Tauri command、不改前端。
- 不改 `Cargo.toml`，不引入 `tauri-plugin-sql` 或其他新依赖。
- 不建错误档案、笔记、评论相关的表（以后另开卡，届时用 `user_version = 2` 迁移）。
- 不在真实用户数据目录里创建 `vocab.db`（测试全部用内存库或 `D:\tmp\` 下的临时文件）。

## 预估

一个模块、一段建表 SQL、7 个测试，30 分钟内可完成（首次编译可能较慢）。

---

## 结束报告（实现者填）

- 改了什么：新增 `vocab/mod.rs` 与 `vocab/schema.rs`，实现 `SCHEMA_VERSION`、`db_path()`、`open()` 和事务式 `migrate()`；按卡片原样建立 5 张表、2 个索引，打开时启用外键，拒绝高版本数据库；`lib.rs` 只新增 `mod vocab;`，并写齐 7 项内存库测试。
- 代码审阅：逐行对照卡片确认字段、主键、非空、CHECK、外键级联和索引一致；版本 0 的全部建表、索引及 `user_version = 1` 在同一事务内，版本 1 不改数据，高于 1 返回错误。`git diff app/src-tauri/src/lib.rs` 只有新增一行，`Cargo.toml` 无差异，未新增依赖或越界改动。
- 自动测试：`cargo test --lib vocab::` 通过，7 passed、0 failed；`cargo test --lib` 通过，118 passed、0 failed、18 ignored。首次编译因继承的 `CFLAGS` 含 MSVC 不支持的参数失败，仅在当前测试进程清除该变量后重跑成功；另有既有 `cloud_asr.rs` 的 `unused_mut` 警告，不影响结果。
- 真实环境：在 Windows 11 的 MSVC/bundled SQLite 环境实际执行 `open(Path::new(":memory:"))`，确认外键已开启、父记录删除会级联删除例句、孤立例句写入失败；未在真实用户数据目录创建 `vocab.db`。
- 未验证：安卓真机、界面和导入流程不在本卡范围，未验证；实现者不自行验收，留待 dsh-flash 按验收标准复跑。

## 验收记录（验收者填，不能是实现者本人；最后单独一行写「验收结论：通过」或「验收结论：不通过」）

验收者：dsh-flash　日期：2026-11-04　被验状态：HEAD `3d16ef7` + 未提交工作区改动（`git status` 显示改动未提交）

**改动范围核对（先看这个）**：`git status --porcelain -uall` 只有 4 项——`M app/src-tauri/src/lib.rs`、`M docs/tasks/008-词库SQLite表结构.md`、新增 `app/src-tauri/src/vocab/mod.rs`、新增 `app/src-tauri/src/vocab/schema.rs`。全部落在卡片「允许改动的路径」内，没有越界；`git diff --stat -- app/src-tauri/Cargo.toml` 为空，`Cargo.lock` 无变化，`app/` 下非 Rust 文件无变化；仓库内没有新增 `.db` 文件，`%LOCALAPPDATA%\com.linguaclip.app\vocab.db` 也不存在（`Test-Path` 返回 False）。

**复跑前置（与实现者的说法一致，已独立复现）**：本机进程继承了 `CFLAGS=-std=c11 -Wall -Wextra -g`，cl.exe 不认 `/Wextra`，直接跑 cargo 会失败（`libsqlite3-sys` 报 `cl: 命令行 error D8021 :无效的数值参数"/Wextra"`）。只在当前测试进程里清除该变量后复跑，未改仓库、未改系统环境。

### 验收标准 1：`cargo test --lib vocab::` 全部通过，测试数 ≥ 7，对应 1–7 —— 通过

实际命令：`cd app/src-tauri` 后 `cargo test --lib vocab::`（进程内清 CFLAGS）。实际输出：

```
running 7 tests
test vocab::schema::tests::db_path_is_vocab_db_in_app_data_dir ... ok
test vocab::schema::tests::migrate_rejects_newer_database_version ... ok
test vocab::schema::tests::open_enables_foreign_keys_and_cascades_example_deletion ... ok
test vocab::schema::tests::review_word_level_accepts_null_and_one_to_four_only ... ok
test vocab::schema::tests::review_word_allows_duplicate_norm_but_rejects_duplicate_id ... ok
test vocab::schema::tests::migrate_is_idempotent_and_preserves_schema_and_data ... ok
test vocab::schema::tests::migrate_creates_all_five_tables_and_sets_version ... ok
test result: ok. 7 passed; 0 failed; 0 ignored; 129 filtered out
```

7 个测试与卡片 1–7 逐条对得上：建表+版本号、幂等、拒绝高版本、同 `word_norm` 多行/重复 id 失败、`level` 约束、外键级联+孤立例句失败、`db_path()` 文件名与父目录。同时按代码逐条核对测试内容不是空跑（断言了具体值，例如表名集合、`level` 取值序列、例句计数）。

### 验收标准 2：`cargo test --lib` 整体通过 —— 通过

实际命令：`cargo test --lib`（进程内清 CFLAGS），退出码 0，实际输出：`running 136 tests` / `test result: ok. 118 passed; 0 failed; 18 ignored`。118 − 7 = 111，与卡片「原有 111 个左右」吻合，原有测试没有被本卡弄坏。

### 验收标准 3：`git diff app/src-tauri/src/lib.rs` 只有一行 `mod vocab;` —— 通过

实际 diff 只有 `+mod vocab;` 一行，位置在 `mod gpus;` 与 `mod whisper_setup;` 之间，无其他增删。

### 验收标准 4：表结构与本卡 SQL 一致（字段名、约束逐项对得上）—— 通过

做法：在 `D:\tmp\008-verify\` 新建一次性 crate，用 `#[path = "…/vocab/schema.rs"]` 直接包含实现者那份源码（只给 `crate::paths::app_data_dir()` 打了一个指向 `D:\tmp` 的桩，避免碰真实数据目录），真实调用 `open(Path::new("D:/tmp/008-verify/vocab-check.db"))` 生成磁盘库，再读 `sqlite_master`。实际输出关键项：

```
DB_FILE_EXISTS=true
FOREIGN_KEYS=1
USER_VERSION=1
REOPEN_USER_VERSION=1
OBJ index review_word_due  CREATE INDEX review_word_due ON review_word(level, due)
OBJ index review_word_norm CREATE INDEX review_word_norm ON review_word(word_norm)
OBJ table import_run       CREATE TABLE import_run ( id INTEGER PRIMARY KEY AUTOINCREMENT, … )
OBJ table review_word      CREATE TABLE review_word ( … level INTEGER CHECK (level IS NULL OR level BETWEEN 1 AND 4) … deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)) )
OBJ table self_check       CREATE TABLE self_check ( … )
OBJ table upgrade_entry    CREATE TABLE upgrade_entry ( … )
OBJ table upgrade_example  CREATE TABLE upgrade_example ( entry_id TEXT NOT NULL REFERENCES upgrade_entry(id) ON DELETE CASCADE, …, PRIMARY KEY (entry_id, seq) )
```

再用 node 脚本把卡片里那段 SQL（去注释、归一化空白与大小写）与 `sqlite_master` 的实际 DDL 逐条比对：卡片 7 条语句（5 表 + 2 索引）**7 条完全一致，0 条不一致**；多出的对象只有 `sqlite_sequence`（`AUTOINCREMENT` 的内置记账表，不算偏差）。

顺带验证了卡片「建表和设版本在一个事务里」：在 `D:\tmp` 造一个 `user_version=0` 但已存在同名 `self_check` 表的库，再 `migrate`，返回错误且事后库里只剩那张预先存在的 `self_check`（`upgrade_entry`/`upgrade_example` 被回滚），说明确实是原子事务。另外 `open()` 对不存在的文件确实新建（`DB_FILE_EXISTS=true`），重复 `open()` 后版本仍为 1。

### 验收标准 5：没有新增 Cargo 依赖，没有改 app/ 下 Rust 以外的文件 —— 通过

`git diff app/src-tauri/Cargo.toml` 为空、`Cargo.lock` 未变；`git status -uall` 显示 `app/` 下只多了 `src/vocab/{mod.rs,schema.rs}` 两个 Rust 文件，`lib.rs` 只多一行；`mod.rs` 内容就是 `#![allow(dead_code)]` + `pub mod schema;`，与卡片要求一致。

### 问题清单（按严重程度排序）

1. **轻微（环境坑，不是本卡代码缺陷，但会卡住任何人的复跑）**：进程继承的 `CFLAGS` 与 MSVC 冲突。
   复现：不清 `CFLAGS`，在 `app/src-tauri` 跑 `cargo test --lib vocab::` → `libsqlite3-sys` 构建失败，报 `cl: 命令行 error D8021 :无效的数值参数"/Wextra"`。
   处置：只在当前进程 `Remove-Item Env:\CFLAGS` 后即通过。建议以后在 `scripts/dispatch.mjs` 或文档里统一清掉这个变量，省得每个 agent 重踩。
2. **轻微（测试断言偏松，可接受）**：`migrate_rejects_newer_database_version` 只断言 `error.to_string().contains("99")`，没有断言错误类别。
   复现：读 `app/src-tauri/src/vocab/schema.rs:181-188`；若将来有人把错误文案里的版本号去掉、或在别处带上 "99"，测试会误判。
   影响：不影响本卡结论，属后续加固项。
3. **提示（不算偏差）**：`sqlite_master` 里多出 `sqlite_sequence`，这是 `import_run` 用 `AUTOINCREMENT` 的 SQLite 内置行为，卡片 SQL 没写它属于正常，未做处理。

验收结论：通过
