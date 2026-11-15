use rusqlite::{Connection, Error, ffi};
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: i32 = 14;

const CREATE_V1_SCHEMA: &str = r#"
CREATE TABLE upgrade_entry (
  id TEXT PRIMARY KEY,
  ord INTEGER NOT NULL,
  line INTEGER NOT NULL,
  raw TEXT NOT NULL,
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
  seq INTEGER NOT NULL,
  cand TEXT NOT NULL,
  sentence TEXT NOT NULL,
  ai INTEGER NOT NULL CHECK (ai IN (0, 1)),
  PRIMARY KEY (entry_id, seq)
);
CREATE TABLE self_check (
  id TEXT PRIMARY KEY,
  ord INTEGER NOT NULL,
  line INTEGER NOT NULL,
  raw TEXT NOT NULL,
  text TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
);
CREATE TABLE review_word (
  id TEXT PRIMARY KEY,
  ord INTEGER NOT NULL,
  line INTEGER NOT NULL,
  raw TEXT NOT NULL,
  word TEXT NOT NULL,
  word_norm TEXT NOT NULL,
  issue TEXT NOT NULL,
  added_at TEXT NOT NULL,
  status TEXT NOT NULL,
  level INTEGER CHECK (level IS NULL OR level BETWEEN 1 AND 4),
  due TEXT NOT NULL,
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
"#;

const CREATE_ERROR_SCHEMA: &str = r#"
CREATE TABLE error_top (
  id TEXT PRIMARY KEY,
  ord INTEGER NOT NULL,
  line INTEGER NOT NULL,
  raw TEXT NOT NULL,
  rank INTEGER NOT NULL,
  kind TEXT NOT NULL,
  count TEXT NOT NULL,
  last_at TEXT NOT NULL,
  status TEXT NOT NULL,
  source_file TEXT NOT NULL
);
CREATE TABLE error_batch (
  id TEXT PRIMARY KEY,
  ord INTEGER NOT NULL,
  line INTEGER NOT NULL,
  raw TEXT NOT NULL,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  source_file TEXT NOT NULL
);
CREATE TABLE error_item (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES error_batch(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  line INTEGER NOT NULL,
  raw TEXT NOT NULL,
  question TEXT NOT NULL,
  kind TEXT NOT NULL,
  written TEXT NOT NULL,
  correction TEXT NOT NULL,
  note TEXT NOT NULL,
  source_file TEXT NOT NULL
);
CREATE INDEX error_item_batch ON error_item(batch_id, ord);
CREATE TABLE error_todo (
  id TEXT PRIMARY KEY,
  ord INTEGER NOT NULL,
  line INTEGER NOT NULL,
  raw TEXT NOT NULL,
  done INTEGER NOT NULL CHECK (done IN (0, 1)),
  text TEXT NOT NULL,
  source_file TEXT NOT NULL
);
CREATE TABLE error_essay (
  id TEXT PRIMARY KEY,
  ord INTEGER NOT NULL,
  line INTEGER NOT NULL,
  raw TEXT NOT NULL,
  date TEXT NOT NULL,
  standard TEXT NOT NULL,
  topic TEXT NOT NULL,
  word_count TEXT NOT NULL,
  original_file TEXT NOT NULL,
  result TEXT NOT NULL,
  source_file TEXT NOT NULL
);
"#;

const CREATE_V3_SCHEMA: &str = r#"
CREATE TABLE review_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id TEXT NOT NULL REFERENCES review_word(id) ON DELETE CASCADE,
  review_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('recall', 'rewrite', 'sentence', 'choice')),
  correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
  before_status TEXT NOT NULL,
  after_status TEXT NOT NULL,
  before_due TEXT NOT NULL,
  after_due TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX review_log_word_date ON review_log(word_id, review_date);
"#;

const CREATE_V4_SCHEMA: &str = r#"
ALTER TABLE review_word ADD COLUMN source TEXT NOT NULL DEFAULT 'Hermes 词库';
ALTER TABLE review_word ADD COLUMN verification_status TEXT NOT NULL DEFAULT '未查证'
  CHECK (verification_status IN ('未查证', '词典或ACL已查', '老师确认'));
"#;

const CREATE_V5_SCHEMA: &str = r#"
CREATE TABLE coach_essay (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL UNIQUE REFERENCES error_batch(id) ON DELETE CASCADE,
  original TEXT NOT NULL,
  result_json TEXT NOT NULL,
  paper_type TEXT NOT NULL,
  word_count INTEGER NOT NULL CHECK (word_count >= 0),
  created_at TEXT NOT NULL
);
CREATE TABLE coach_top_progress (
  top_id TEXT PRIMARY KEY REFERENCES error_top(id) ON DELETE CASCADE,
  consecutive_clean INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_clean >= 0)
);
"#;

const CREATE_V6_SCHEMA: &str = r#"
CREATE TABLE review_definition (
  word_id TEXT NOT NULL REFERENCES review_word(id) ON DELETE CASCADE,
  source_file TEXT NOT NULL,
  source_line INTEGER NOT NULL CHECK (source_line >= 1),
  pos TEXT NOT NULL,
  english TEXT NOT NULL,
  chinese TEXT NOT NULL,
  PRIMARY KEY (word_id, source_file, source_line)
);
CREATE INDEX review_definition_word ON review_definition(word_id);
CREATE TABLE review_definition_example (
  word_id TEXT NOT NULL,
  source_file TEXT NOT NULL,
  definition_line INTEGER NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  sentence TEXT NOT NULL,
  ai INTEGER NOT NULL CHECK (ai IN (0, 1)),
  FOREIGN KEY (word_id, source_file, definition_line)
    REFERENCES review_definition(word_id, source_file, source_line) ON DELETE CASCADE,
  PRIMARY KEY (word_id, source_file, definition_line, seq)
);
"#;

/// 031：只写日志、绝不改复习状态的事件（同日复检、题目出错、笔误申诉）。
const CREATE_V7_SCHEMA: &str = r#"
CREATE TABLE review_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id TEXT NOT NULL REFERENCES review_word(id) ON DELETE CASCADE,
  review_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('recheck', 'question_error', 'typo')),
  correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX review_event_word_kind ON review_event(word_id, kind);
"#;

/// 040：用户自己记的词条笔记。按词挂（word_key 是归一化后的词），不引用 review_word 的行，
/// 所以重新导入、同一个词出现在多期或升级库里，看到的都是同一组笔记；也不碰原来的「备注」列。
const CREATE_V8_SCHEMA: &str = r#"
CREATE TABLE vocab_note (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_key TEXT NOT NULL CHECK (length(word_key) > 0),
  word TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  source TEXT NOT NULL CHECK (source IN ('词库', '复习', '首考', '闪卡')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX vocab_note_word ON vocab_note(word_key, created_at);
"#;

/// 043：我的例句。和笔记一样按词挂（word_key 是归一化后的词），不引用 review_word 的行，
/// 也不写 Hermes 原表格的例句列。source：AI生成 = AI 按义项给的；自己写 = 用户原句；AI改过 = AI 改后的句子。
/// explanation 是 AI 的中文说明，sense 是生成/判断时选的义项，original 是改句前用户的原句（只有 AI改过 才有）。
const CREATE_V9_SCHEMA: &str = r#"
CREATE TABLE vocab_example (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_key TEXT NOT NULL CHECK (length(word_key) > 0),
  word TEXT NOT NULL,
  sentence TEXT NOT NULL CHECK (length(trim(sentence)) > 0),
  source TEXT NOT NULL CHECK (source IN ('AI生成', '自己写', 'AI改过')),
  explanation TEXT,
  sense TEXT,
  original TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX vocab_example_word ON vocab_example(word_key, created_at);
"#;

/// 048：例句场景标签。按「规范化后的句子文字」存（key），不引用任何行 ID，重新导入词库不丢。
/// source：AI = 模型标的；手动 = 用户选的（之后 AI 不再覆盖）。
const CREATE_V10_SCHEMA: &str = r#"
CREATE TABLE example_scene (
  key TEXT PRIMARY KEY CHECK (length(key) > 0),
  sentence TEXT NOT NULL,
  scene TEXT NOT NULL CHECK (scene IN ('definition', 'statement', 'evidence', 'explanation', 'cause-effect', 'comparison', 'concession', 'evaluation', 'recommendation', 'summary')),
  source TEXT NOT NULL CHECK (source IN ('AI', '手动')),
  updated_at TEXT NOT NULL
);
"#;

/// 055：随手记。一条 = 一句话 + 记下时「在看什么」（视频/听写的字幕句和时间点、词库里的词条，或什么都没有）。
/// status：待整理 / 已整理；destination 先留空，056 整理时填「去向」。device_id 给以后同步用，本卡固定写本机的值。
const CREATE_V11_SCHEMA: &str = r#"
CREATE TABLE quick_note (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ctx_kind TEXT NOT NULL DEFAULT 'none' CHECK (ctx_kind IN ('none', 'video', 'dictation', 'entry')),
  ctx_text TEXT,
  ctx_video_id TEXT,
  ctx_video_name TEXT,
  ctx_time REAL,
  ctx_entry_id TEXT,
  ctx_word TEXT,
  status TEXT NOT NULL DEFAULT '待整理' CHECK (status IN ('待整理', '已整理')),
  destination TEXT,
  device_id TEXT NOT NULL
);
CREATE INDEX quick_note_status_time ON quick_note(status, created_at);
"#;

/// 078：英英释义。按词挂（word_key 同笔记）；source：mine = 自己写的，dict:xxx = 词典查来的。
/// 用 IF NOT EXISTS，因为 v11 → v12 的同步迁移要先有这张表才能给它加 sync_uid 和触发器。
const CREATE_V13_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS vocab_definition_en (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_key TEXT NOT NULL CHECK (length(word_key) > 0),
  word TEXT NOT NULL,
  pos TEXT,
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  source TEXT NOT NULL CHECK (source = 'mine' OR source LIKE 'dict:%'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vocab_definition_en_word ON vocab_definition_en(word_key, id);
"#;

/// 081：每日新词的候选池。每个词一行，记它的去向：known 认识 / taken 收下 / later 以后再说。
/// decided_at 是本机日期 YYYY-MM-DD（later 过 7 天再出现）。主键是 word_key，所以同一个词只有一个去向，两台机器互相覆盖时按 updated_at 新的为准。
const CREATE_V14_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS wordpack_pick (
  word_key TEXT PRIMARY KEY CHECK (length(word_key) > 0),
  word TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('known', 'taken', 'later')),
  pack TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 学习计划：单行表，id 固定 'default'；packs 是词表标签的 JSON 数组，如 ["cet4","ngsl"]。
-- 本机 localStorage 只当缓存，这张表才是准的（会同步、会跟整库搬家）。
CREATE TABLE IF NOT EXISTS daily_plan (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  packs TEXT NOT NULL DEFAULT '[]',
  per_day INTEGER NOT NULL DEFAULT 10 CHECK (per_day BETWEEN 1 AND 100),
  card_on INTEGER NOT NULL DEFAULT 1 CHECK (card_on IN (0, 1)),
  updated_at TEXT NOT NULL
);
"#;

pub fn db_path() -> PathBuf {
  crate::paths::app_data_dir().join("vocab.db")
}

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
  let conn = Connection::open(path)?;
  conn.pragma_update(None, "foreign_keys", "ON")?;
  migrate(&conn)?;
  Ok(conn)
}

/// 应用启动时升级已有词库；没有词库时不创建文件。
pub fn migrate_existing(path: &Path) -> rusqlite::Result<()> {
  if path.exists() {
    open(path)?;
  }
  Ok(())
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
  let version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
  if version > SCHEMA_VERSION {
    return Err(Error::SqliteFailure(
      ffi::Error::new(ffi::SQLITE_ERROR),
      Some(format!(
        "database schema version {version} is newer than supported version {SCHEMA_VERSION}"
      )),
    ));
  }
  if version == 0 {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(CREATE_V1_SCHEMA)?;
    tx.pragma_update(None, "user_version", 1)?;
    tx.commit()?;
  }
  if version <= 1 {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(CREATE_ERROR_SCHEMA)?;
    tx.pragma_update(None, "user_version", 2)?;
    tx.commit()?;
  }
  if version <= 2 {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(CREATE_V3_SCHEMA)?;
    tx.pragma_update(None, "user_version", 3)?;
    tx.commit()?;
  }
  if version <= 3 {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(CREATE_V4_SCHEMA)?;
    tx.pragma_update(None, "user_version", 4)?;
    tx.commit()?;
  }
  if version <= 4 {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(CREATE_V5_SCHEMA)?;
    tx.pragma_update(None, "user_version", 5)?;
    tx.commit()?;
  }
  if version <= 5 {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(CREATE_V6_SCHEMA)?;
    tx.pragma_update(None, "user_version", 6)?;
    tx.commit()?;
  }
  if version <= 6 {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(CREATE_V7_SCHEMA)?;
    tx.pragma_update(None, "user_version", 7)?;
    tx.commit()?;
  }
  if version <= 7 {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(CREATE_V8_SCHEMA)?;
    tx.pragma_update(None, "user_version", 8)?;
    tx.commit()?;
  }
  if version <= 8 {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(CREATE_V9_SCHEMA)?;
    tx.pragma_update(None, "user_version", 9)?;
    tx.commit()?;
  }
  if version <= 9 {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(CREATE_V10_SCHEMA)?;
    tx.pragma_update(None, "user_version", 10)?;
    tx.commit()?;
  }
  if version <= 10 {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(CREATE_V11_SCHEMA)?;
    tx.pragma_update(None, "user_version", 11)?;
    tx.commit()?;
  }
  if version <= 11 {
    // 071 同步：sync_uid、改动记录表和触发器（见 sync.rs）
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(CREATE_V13_SCHEMA)?;
    tx.execute_batch(CREATE_V14_SCHEMA)?; // migrate_v12 给全部白名单表建触发器，表必须先在
    super::sync::migrate_v12(&tx)?;
    tx.pragma_update(None, "user_version", 12)?;
    tx.commit()?;
  }
  if version <= 12 {
    // 078 英英释义：新表 + 同步账本（migrate_v12 可重复执行，只补缺的）
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(CREATE_V13_SCHEMA)?;
    tx.execute_batch(CREATE_V14_SCHEMA)?; // migrate_v12 给全部白名单表建触发器，表必须先在
    super::sync::migrate_v12(&tx)?;
    tx.pragma_update(None, "user_version", 13)?;
    tx.commit()?;
  }
  if version <= 13 {
    // 081 每日新词：候选池表 + 同步触发器（migrate_v12 可重复执行，只补缺的）
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(CREATE_V14_SCHEMA)?;
    super::sync::migrate_v12(&tx)?;
    tx.pragma_update(None, "user_version", 14)?;
    tx.commit()?;
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use rusqlite::params;

  fn memory_db() -> Connection {
    Connection::open_in_memory().unwrap()
  }

  fn insert_review_word(conn: &Connection, id: &str, level: Option<i32>) -> rusqlite::Result<()> {
    conn.execute(
      "INSERT INTO review_word (
        id, ord, line, raw, word, word_norm, issue, added_at, status,
        level, due, note, imported_at, updated_at, deleted
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
      params![
        id,
        1,
        1,
        "| raw |",
        "word",
        "shared",
        "1.1",
        "2026-11-04",
        "L3",
        level,
        "",
        "",
        "2026-11-04T00:00:00Z",
        "2026-11-04T00:00:00Z",
        0
      ],
    )?;
    Ok(())
  }

  /// 快照比较用：列出除 071 新增的 sync_uid 以外的全部列，比较「原有数据」是否原样保留。
  fn plain_select(conn: &Connection, table: &str) -> String {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})")).unwrap();
    let cols: Vec<String> = stmt.query_map([], |r| r.get::<_, String>(1)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap().into_iter().filter(|c| c != "sync_uid").collect();
    format!("SELECT {} FROM {table} ORDER BY rowid", cols.join(", "))
  }

  fn make_v11(path: &std::path::Path) {
    let conn = Connection::open(path).unwrap();
    for sql in [CREATE_V1_SCHEMA, CREATE_ERROR_SCHEMA, CREATE_V3_SCHEMA, CREATE_V4_SCHEMA, CREATE_V5_SCHEMA, CREATE_V6_SCHEMA, CREATE_V7_SCHEMA, CREATE_V8_SCHEMA, CREATE_V9_SCHEMA, CREATE_V10_SCHEMA, CREATE_V11_SCHEMA] {
      conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 11).unwrap();
    insert_review_word(&conn, "rv:1", Some(2)).unwrap();
    conn.execute_batch(r#"
      INSERT INTO vocab_note (word_key, word, body, source, created_at, updated_at) VALUES ('k', 'k', 'n1', '词库', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT INTO quick_note (body, created_at, updated_at, device_id) VALUES ('q1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'dev');
      INSERT INTO review_log (word_id, review_date, kind, correct, before_status, after_status, before_due, after_due, created_at) VALUES ('rv:1', '2026-01-01', 'recall', 1, 'L1', 'L2', '', '', '2026-01-01T00:00:00Z');
    "#).unwrap();
  }

  fn uids(conn: &Connection, table: &str) -> Vec<(i64, String)> {
    let mut stmt = conn.prepare(&format!("SELECT id, sync_uid FROM {table} ORDER BY id")).unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
  }

  /// 071：同一份 v11 库复制成两台设备，各自升级后老行的 sync_uid 一样；
  /// 复制之后各自新增、撞了整数 id 的行不一样。升级后新增的行是随机 uid。
  #[test]
  fn migrate_v12_backfills_sync_uid_deterministically() {
    let dir = std::env::temp_dir().join(format!("es-sync-uid-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let (a, b) = (dir.join("a.db"), dir.join("b.db"));
    make_v11(&a);
    std::fs::copy(&a, &b).unwrap();
    for (path, body, at) in [(&a, "只在A", "2026-02-01T00:00:00Z"), (&b, "只在B", "2026-02-02T00:00:00Z")] {
      let conn = Connection::open(path).unwrap();
      conn.execute("INSERT INTO vocab_note (word_key, word, body, source, created_at, updated_at) VALUES ('k', 'k', ?1, '词库', ?2, ?2)", params![body, at]).unwrap();
    }
    let ca = open(&a).unwrap();
    let cb = open(&b).unwrap();
    for t in ["vocab_note", "quick_note", "review_log"] {
      let (ua, ub) = (uids(&ca, t), uids(&cb, t));
      assert!(ua[0].1.starts_with(&format!("legacy:{t}:1:")), "{t} {:?}", ua);
      assert_eq!(ua[0], ub[0], "同一份库复制出的老行必须一致：{t}");
      if ua.len() > 1 {
        assert_ne!(ua[1].1, ub[1].1, "各自新增且撞号的行必须不同：{t}");
      }
    }
    assert_eq!(uids(&ca, "vocab_note"), uids(&open(&a).unwrap(), "vocab_note"));
    ca.execute("INSERT INTO quick_note (body, created_at, updated_at, device_id) VALUES ('新', 'c', 'c', 'd')", []).unwrap();
    assert!(uids(&ca, "quick_note").last().unwrap().1.starts_with("u:"));
    drop((ca, cb));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn migrate_creates_all_tables_and_sets_version() {
    let conn = memory_db();
    migrate(&conn).unwrap();

    let version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap();
    assert_eq!(version, SCHEMA_VERSION);
    let mut stmt = conn
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .unwrap();
    let tables = stmt
      .query_map([], |row| row.get::<_, String>(0))
      .unwrap()
      .collect::<rusqlite::Result<Vec<_>>>()
      .unwrap();
    assert_eq!(tables, ["coach_essay", "coach_top_progress", "daily_plan", "error_batch", "error_essay", "error_item", "error_todo", "error_top", "example_scene", "import_run", "quick_note", "review_definition", "review_definition_example", "review_event", "review_log", "review_word", "self_check", "sync_change", "sync_meta", "upgrade_entry", "upgrade_example", "vocab_definition_en", "vocab_example", "vocab_note", "wordpack_pick"]);
  }

  #[test]
  fn migrate_from_v1_creates_error_tables_and_preserves_vocab_data() {
    let conn = memory_db();
    conn.execute_batch(CREATE_V1_SCHEMA).unwrap();
    conn.pragma_update(None, "user_version", 1).unwrap();
    insert_review_word(&conn, "rv:v1", Some(2)).unwrap();

    migrate(&conn).unwrap();

    let version: i32 = conn
      .query_row("PRAGMA user_version", [], |row| row.get(0))
      .unwrap();
    assert_eq!(version, SCHEMA_VERSION);
    let word: String = conn
      .query_row(
        "SELECT word FROM review_word WHERE id = 'rv:v1'",
        [],
        |row| row.get(0),
      )
      .unwrap();
    assert_eq!(word, "word");
    let defaults: (String, String) = conn
      .query_row(
        "SELECT source, verification_status FROM review_word WHERE id = 'rv:v1'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
      )
      .unwrap();
    assert_eq!(defaults, ("Hermes 词库".into(), "未查证".into()));
    for table in [
      "error_top",
      "error_batch",
      "error_item",
      "error_todo",
      "error_essay",
    ] {
      let count: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
          row.get(0)
        })
        .unwrap();
      assert_eq!(count, 0);
    }
  }

  #[test]
  fn migrate_from_v2_preserves_every_original_table() {
    let conn = memory_db();
    conn.execute_batch(CREATE_V1_SCHEMA).unwrap();
    conn.execute_batch(CREATE_ERROR_SCHEMA).unwrap();
    conn.pragma_update(None, "user_version", 2).unwrap();
    conn.execute_batch(r#"
      INSERT INTO upgrade_entry VALUES ('up:1', 1, 1, '| a |', 'a', 'A', 's', 'n', 't1', 't1', 0);
      INSERT INTO upgrade_example VALUES ('up:1', 1, 'a', 'A.', 1);
      INSERT INTO self_check VALUES ('sc:1', 1, 1, '- check', 'check', 't1', 't1', 0);
      INSERT INTO review_word VALUES ('rv:1', 1, 1, '| a | 1 | d | L2 | 2026-11-09 | n |', 'a', 'a', '1', 'd', 'L2', 2, '2026-11-09', 'n', 't1', 't1', 0);
      INSERT INTO import_run (source_file, source_sha256, started_at, counts_json, warnings_json) VALUES ('a.md', 'hash', 't1', '{}', '[]');
      INSERT INTO error_top VALUES ('et:1', 1, 1, 'raw', 1, 'kind', '2', 't1', 'status', 'source');
      INSERT INTO error_batch VALUES ('eb:1', 1, 1, 'raw', 'title', 'date', '{}', 'source');
      INSERT INTO error_item VALUES ('ei:1', 'eb:1', 1, 1, 'raw', 'question', 'kind', 'written', 'correction', 'note', 'source');
      INSERT INTO error_todo VALUES ('edo:1', 1, 1, 'raw', 0, 'text', 'source');
      INSERT INTO error_essay VALUES ('ee:1', 1, 1, 'raw', 'date', 'standard', 'topic', '1', 'file', 'result', 'source');
    "#).unwrap();
    let tables = ["upgrade_entry", "upgrade_example", "self_check", "review_word", "import_run", "error_top", "error_batch", "error_item", "error_todo", "error_essay"];
    let snapshot = || {
      tables.map(|table| {
        let select = if table == "review_word" {
          "SELECT id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note, imported_at, updated_at, deleted FROM review_word ORDER BY rowid".to_string()
        } else {
          format!("SELECT * FROM {table} ORDER BY rowid")
        };
        let mut stmt = conn.prepare(&select).unwrap();
        let count = stmt.column_count();
        stmt.query_map([], |row| {
          Ok((0..count).map(|i| row.get::<_, rusqlite::types::Value>(i).map(|v| format!("{v:?}"))).collect::<rusqlite::Result<Vec<_>>>()?.join("|"))
        }).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
      })
    };
    let before = snapshot();

    migrate(&conn).unwrap();

    assert_eq!(snapshot(), before);
    assert_eq!(conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i32>(0)).unwrap(), SCHEMA_VERSION);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM review_log", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
  }

  #[test]
  fn migrate_from_v3_preserves_word_and_log_and_adds_defaults() {
    let conn = memory_db();
    conn.execute_batch(CREATE_V1_SCHEMA).unwrap();
    conn.execute_batch(CREATE_ERROR_SCHEMA).unwrap();
    conn.execute_batch(CREATE_V3_SCHEMA).unwrap();
    conn.pragma_update(None, "user_version", 3).unwrap();
    insert_review_word(&conn, "rv:v3", Some(4)).unwrap();
    conn.execute(
      "INSERT INTO review_log (
        word_id, review_date, kind, correct, before_status, after_status,
        before_due, after_due, created_at
      ) VALUES ('rv:v3', '2026-11-09', 'recall', 1, 'L3', 'L4', '2026-11-08', '2026-11-25', 't1')",
      [],
    ).unwrap();

    migrate(&conn).unwrap();

    let original: (String, String, i64, String, String) = conn.query_row(
      "SELECT raw, status, level, note, updated_at FROM review_word WHERE id = 'rv:v3'",
      [],
      |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).unwrap();
    assert_eq!(original, ("| raw |".into(), "L3".into(), 4, "".into(), "2026-11-04T00:00:00Z".into()));
    let defaults: (String, String) = conn.query_row(
      "SELECT source, verification_status FROM review_word WHERE id = 'rv:v3'",
      [],
      |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!(defaults, ("Hermes 词库".into(), "未查证".into()));
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM review_log", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    assert_eq!(conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i32>(0)).unwrap(), SCHEMA_VERSION);
  }

  #[test]
  fn migrate_from_v4_adds_definitions_without_changing_review_data() {
    let conn = memory_db();
    conn.execute_batch(CREATE_V1_SCHEMA).unwrap();
    conn.execute_batch(CREATE_ERROR_SCHEMA).unwrap();
    conn.execute_batch(CREATE_V3_SCHEMA).unwrap();
    conn.execute_batch(CREATE_V4_SCHEMA).unwrap();
    conn.pragma_update(None, "user_version", 4).unwrap();
    insert_review_word(&conn, "rv:v4", Some(2)).unwrap();
    conn.execute("UPDATE review_word SET due = '2026-11-12', note = 'keep me' WHERE id = 'rv:v4'", []).unwrap();
    let before: (String, String, Option<i32>, String, String, String, String) = conn.query_row(
      "SELECT raw, status, level, due, note, source, verification_status FROM review_word WHERE id = 'rv:v4'",
      [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
    ).unwrap();

    migrate(&conn).unwrap();

    let after: (String, String, Option<i32>, String, String, String, String) = conn.query_row(
      "SELECT raw, status, level, due, note, source, verification_status FROM review_word WHERE id = 'rv:v4'",
      [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
    ).unwrap();
    assert_eq!(after, before);
    assert_eq!(conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i32>(0)).unwrap(), SCHEMA_VERSION);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM review_definition", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM review_definition_example", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
  }

  /// 040：v7 老库升到 v8 只多一张笔记表，原有各表一行不变，原「备注」列也不动。
  #[test]
  fn migrate_from_v7_adds_note_table_without_changing_existing_data() {
    let conn = memory_db();
    for batch in [CREATE_V1_SCHEMA, CREATE_ERROR_SCHEMA, CREATE_V3_SCHEMA, CREATE_V4_SCHEMA, CREATE_V5_SCHEMA, CREATE_V6_SCHEMA, CREATE_V7_SCHEMA] {
      conn.execute_batch(batch).unwrap();
    }
    conn.pragma_update(None, "user_version", 7).unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    insert_review_word(&conn, "rv:v7", Some(2)).unwrap();
    conn.execute_batch(r#"
      UPDATE review_word SET note = '旧备注；2026-11-09 首考过', source = '课堂', verification_status = '老师确认' WHERE id = 'rv:v7';
      INSERT INTO upgrade_entry VALUES ('up:1', 1, 1, '| a |', 'a', 'A', 's', '升级备注', 't1', 't1', 0);
      INSERT INTO upgrade_example VALUES ('up:1', 1, 'a', 'A.', 0);
      INSERT INTO self_check VALUES ('sc:1', 1, 1, '- check', 'check', 't1', 't1', 0);
      INSERT INTO review_log (word_id, review_date, kind, correct, before_status, after_status, before_due, after_due, created_at)
        VALUES ('rv:v7', '2026-11-09', 'recall', 1, 'L1', 'L2', '2026-11-08', '2026-11-12', 't1');
      INSERT INTO review_definition VALUES ('rv:v7', 'a.md', 3, 'adj.', 'able to recover', '有韧性的');
      INSERT INTO review_definition_example VALUES ('rv:v7', 'a.md', 3, 1, 'It is resilient.', 0);
      INSERT INTO review_event (word_id, review_date, kind, correct, detail, created_at) VALUES ('rv:v7', '2026-11-09', 'recheck', 1, '{}', 't1');
    "#).unwrap();
    let tables = ["review_word", "upgrade_entry", "upgrade_example", "self_check", "review_log", "review_definition", "review_definition_example", "review_event"];
    let snapshot = || {
      tables.map(|table| {
        let mut stmt = conn.prepare(&plain_select(&conn, table)).unwrap();
        let count = stmt.column_count();
        stmt.query_map([], |row| {
          Ok((0..count).map(|i| row.get::<_, rusqlite::types::Value>(i).map(|v| format!("{v:?}"))).collect::<rusqlite::Result<Vec<_>>>()?.join("|"))
        }).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
      })
    };
    let before = snapshot();

    migrate(&conn).unwrap();

    assert_eq!(snapshot(), before);
    assert_eq!(conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i32>(0)).unwrap(), SCHEMA_VERSION);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM vocab_note", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    // 笔记表可用：四种来源都能写，其他来源、空正文、空键被拒。
    for source in ["词库", "复习", "首考", "闪卡"] {
      conn.execute(
        "INSERT INTO vocab_note (word_key, word, body, source, created_at, updated_at) VALUES ('word', 'word', 'x', ?1, 't', 't')",
        params![source],
      ).unwrap();
    }
    for (key, body, source) in [("word", "x", "模型"), ("word", "  ", "词库"), ("", "x", "词库")] {
      assert!(conn.execute(
        "INSERT INTO vocab_note (word_key, word, body, source, created_at, updated_at) VALUES (?1, 'w', ?2, ?3, 't', 't')",
        params![key, body, source],
      ).is_err(), "{key:?} {body:?} {source:?} 应被拒绝");
    }
    // 笔记不挂在 review_word 上：删掉复习行，笔记还在。
    conn.execute("DELETE FROM review_word WHERE id = 'rv:v7'", []).unwrap();
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM vocab_note", [], |row| row.get::<_, i64>(0)).unwrap(), 4);
  }

  /// 043：v8 老库升到 v9 只多一张例句表；原有各表（含笔记）一行不变。
  #[test]
  fn migrate_from_v8_adds_example_table_without_changing_existing_data() {
    let conn = memory_db();
    for batch in [CREATE_V1_SCHEMA, CREATE_ERROR_SCHEMA, CREATE_V3_SCHEMA, CREATE_V4_SCHEMA, CREATE_V5_SCHEMA, CREATE_V6_SCHEMA, CREATE_V7_SCHEMA, CREATE_V8_SCHEMA] {
      conn.execute_batch(batch).unwrap();
    }
    conn.pragma_update(None, "user_version", 8).unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    insert_review_word(&conn, "rv:v8", Some(2)).unwrap();
    conn.execute_batch(r#"
      UPDATE review_word SET note = '旧备注' WHERE id = 'rv:v8';
      INSERT INTO upgrade_entry VALUES ('up:1', 1, 1, '| a |', 'a', 'A', 's', '升级备注', 't1', 't1', 0);
      INSERT INTO upgrade_example VALUES ('up:1', 1, 'a', 'A.', 0);
      INSERT INTO review_definition VALUES ('rv:v8', 'a.md', 3, 'adj.', 'able to recover', '有韧性的');
      INSERT INTO review_definition_example VALUES ('rv:v8', 'a.md', 3, 1, 'It is resilient.', 0);
      INSERT INTO vocab_note (word_key, word, body, source, created_at, updated_at) VALUES ('word', 'word', '我的笔记', '词库', 't', 't');
    "#).unwrap();
    let tables = ["review_word", "upgrade_entry", "upgrade_example", "review_definition", "review_definition_example", "vocab_note"];
    let snapshot = || {
      tables.map(|table| {
        let mut stmt = conn.prepare(&plain_select(&conn, table)).unwrap();
        let count = stmt.column_count();
        stmt.query_map([], |row| {
          Ok((0..count).map(|i| row.get::<_, rusqlite::types::Value>(i).map(|v| format!("{v:?}"))).collect::<rusqlite::Result<Vec<_>>>()?.join("|"))
        }).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
      })
    };
    let before = snapshot();

    migrate(&conn).unwrap();

    assert_eq!(snapshot(), before);
    assert_eq!(conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i32>(0)).unwrap(), SCHEMA_VERSION);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM vocab_example", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    // 三种来源能写，说明、义项、原句可空；其他来源、空句子、空键被拒。
    for source in ["AI生成", "自己写", "AI改过"] {
      conn.execute(
        "INSERT INTO vocab_example (word_key, word, sentence, source, created_at) VALUES ('word', 'word', 'A word.', ?1, 't')",
        params![source],
      ).unwrap();
    }
    for (key, sentence, source) in [("word", "x", "模型"), ("word", "  ", "自己写"), ("", "x", "自己写")] {
      assert!(conn.execute(
        "INSERT INTO vocab_example (word_key, word, sentence, source, created_at) VALUES (?1, 'w', ?2, ?3, 't')",
        params![key, sentence, source],
      ).is_err(), "{key:?} {sentence:?} {source:?} 应被拒绝");
    }
    // 例句不挂在 review_word 上：删掉复习行，例句还在；Hermes 原例句表不受影响。
    conn.execute("DELETE FROM review_word WHERE id = 'rv:v8'", []).unwrap();
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM vocab_example", [], |row| row.get::<_, i64>(0)).unwrap(), 3);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM upgrade_example", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
  }

  /// 048：v9 老库升到 v10 只多一张场景标签表；原有各表（含笔记、例句）一行不变，版本号为 10。
  #[test]
  fn migrate_from_v9_adds_scene_table_without_changing_existing_data() {
    let conn = memory_db();
    for batch in [CREATE_V1_SCHEMA, CREATE_ERROR_SCHEMA, CREATE_V3_SCHEMA, CREATE_V4_SCHEMA, CREATE_V5_SCHEMA, CREATE_V6_SCHEMA, CREATE_V7_SCHEMA, CREATE_V8_SCHEMA, CREATE_V9_SCHEMA] {
      conn.execute_batch(batch).unwrap();
    }
    conn.pragma_update(None, "user_version", 9).unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    insert_review_word(&conn, "rv:v9", Some(2)).unwrap();
    conn.execute_batch(r#"
      UPDATE review_word SET note = '旧备注' WHERE id = 'rv:v9';
      INSERT INTO upgrade_entry VALUES ('up:1', 1, 1, '| a |', 'a', 'A', 's', '升级备注', 't1', 't1', 0);
      INSERT INTO upgrade_example VALUES ('up:1', 1, 'a', 'A.', 0);
      INSERT INTO review_definition VALUES ('rv:v9', 'a.md', 3, 'adj.', 'able to recover', '有韧性的');
      INSERT INTO review_definition_example VALUES ('rv:v9', 'a.md', 3, 1, 'It is resilient.', 0);
      INSERT INTO vocab_note (word_key, word, body, source, created_at, updated_at) VALUES ('word', 'word', '我的笔记', '词库', 't', 't');
      INSERT INTO vocab_example (word_key, word, sentence, source, created_at) VALUES ('word', 'word', 'A word.', '自己写', 't');
    "#).unwrap();
    let tables = ["review_word", "upgrade_entry", "upgrade_example", "review_definition", "review_definition_example", "vocab_note", "vocab_example"];
    let snapshot = || {
      tables.map(|table| {
        let mut stmt = conn.prepare(&plain_select(&conn, table)).unwrap();
        let count = stmt.column_count();
        stmt.query_map([], |row| {
          Ok((0..count).map(|i| row.get::<_, rusqlite::types::Value>(i).map(|v| format!("{v:?}"))).collect::<rusqlite::Result<Vec<_>>>()?.join("|"))
        }).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
      })
    };
    let before = snapshot();

    migrate(&conn).unwrap();

    assert_eq!(snapshot(), before);
    assert_eq!(conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i32>(0)).unwrap(), SCHEMA_VERSION);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM example_scene", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    conn.execute("INSERT INTO example_scene VALUES ('a sentence.', 'A sentence.', 'summary', 'AI', 't')", []).unwrap();
    for (key, scene, source) in [("k1", "other", "AI"), ("k2", "summary", "模型"), ("", "summary", "AI"), ("a sentence.", "summary", "AI")] {
      assert!(conn.execute("INSERT INTO example_scene VALUES (?1, 's', ?2, ?3, 't')", params![key, scene, source]).is_err(), "{key:?} {scene:?} {source:?} 应被拒绝");
    }
  }

  /// 055：v10 老库升到 v11 只多一张随手记表；原有各表一行不变。
  #[test]
  fn migrate_from_v10_adds_quick_note_table_without_changing_existing_data() {
    let conn = memory_db();
    for batch in [CREATE_V1_SCHEMA, CREATE_ERROR_SCHEMA, CREATE_V3_SCHEMA, CREATE_V4_SCHEMA, CREATE_V5_SCHEMA, CREATE_V6_SCHEMA, CREATE_V7_SCHEMA, CREATE_V8_SCHEMA, CREATE_V9_SCHEMA, CREATE_V10_SCHEMA] {
      conn.execute_batch(batch).unwrap();
    }
    conn.pragma_update(None, "user_version", 10).unwrap();
    insert_review_word(&conn, "rv:v10", Some(2)).unwrap();
    conn.execute_batch(r#"
      UPDATE review_word SET note = '旧备注' WHERE id = 'rv:v10';
      INSERT INTO vocab_note (word_key, word, body, source, created_at, updated_at) VALUES ('word', 'word', '我的笔记', '词库', 't', 't');
      INSERT INTO example_scene VALUES ('a sentence.', 'A sentence.', 'summary', 'AI', 't');
    "#).unwrap();
    let tables = ["review_word", "vocab_note", "example_scene"];
    let snapshot = || {
      tables.map(|table| {
        let mut stmt = conn.prepare(&plain_select(&conn, table)).unwrap();
        let count = stmt.column_count();
        stmt.query_map([], |row| {
          Ok((0..count).map(|i| row.get::<_, rusqlite::types::Value>(i).map(|v| format!("{v:?}"))).collect::<rusqlite::Result<Vec<_>>>()?.join("|"))
        }).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
      })
    };
    let before = snapshot();

    migrate(&conn).unwrap();

    assert_eq!(snapshot(), before);
    assert_eq!(conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i32>(0)).unwrap(), SCHEMA_VERSION);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM quick_note", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    conn.execute("INSERT INTO quick_note (body, created_at, updated_at, device_id) VALUES ('一句话', 't', 't', 'local')", []).unwrap();
    let (kind, status): (String, String) = conn.query_row("SELECT ctx_kind, status FROM quick_note", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    assert_eq!((kind.as_str(), status.as_str()), ("none", "待整理"));
    for (body, kind, status) in [("  ", "none", "待整理"), ("x", "other", "待整理"), ("x", "none", "完成")] {
      assert!(conn.execute("INSERT INTO quick_note (body, created_at, updated_at, ctx_kind, status, device_id) VALUES (?1, 't', 't', ?2, ?3, 'local')", params![body, kind, status]).is_err(), "{body:?} {kind:?} {status:?} 应被拒绝");
    }
  }

  #[test]
  fn migrate_is_idempotent_and_preserves_schema_and_data() {
    let conn = memory_db();
    migrate(&conn).unwrap();
    insert_review_word(&conn, "rv:one", Some(3)).unwrap();

    let snapshot = || {
      let mut stmt = conn
        .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
        .unwrap();
      stmt
        .query_map([], |row| {
          Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
    };
    let before = snapshot();
    migrate(&conn).unwrap();

    assert_eq!(snapshot(), before);
    let row: (String, String, String, Option<i32>) = conn
      .query_row("SELECT id, raw, word_norm, level FROM review_word", [], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
      })
      .unwrap();
    assert_eq!(row, ("rv:one".into(), "| raw |".into(), "shared".into(), Some(3)));
  }

  #[test]
  fn migrate_rejects_newer_database_version() {
    let conn = memory_db();
    conn.pragma_update(None, "user_version", 99).unwrap();

    let error = migrate(&conn).unwrap_err();
    assert!(error.to_string().contains("99"));
  }

  #[test]
  fn migrate_existing_upgrades_old_db_before_read_only_browse() {
    let path = std::env::temp_dir().join(format!("vocab-startup-migrate-{}.db", uuid::Uuid::new_v4()));
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(CREATE_V1_SCHEMA).unwrap();
    conn.execute_batch(CREATE_ERROR_SCHEMA).unwrap();
    conn.execute_batch(CREATE_V3_SCHEMA).unwrap();
    conn.execute_batch(CREATE_V4_SCHEMA).unwrap();
    conn.execute_batch(CREATE_V5_SCHEMA).unwrap();
    conn.pragma_update(None, "user_version", 5).unwrap();
    insert_review_word(&conn, "rv:v5", Some(2)).unwrap();
    drop(conn);

    migrate_existing(&path).unwrap();

    crate::vocab::query::browse_at(&path).unwrap();
    let conn = Connection::open(&path).unwrap();
    assert_eq!(conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i32>(0)).unwrap(), SCHEMA_VERSION);
    drop(conn);
    std::fs::remove_file(&path).unwrap();

    migrate_existing(&path).unwrap();
    assert!(!path.exists());
  }

  #[test]
  fn review_word_allows_duplicate_norm_but_rejects_duplicate_id() {
    let conn = memory_db();
    migrate(&conn).unwrap();

    insert_review_word(&conn, "rv:one", Some(1)).unwrap();
    insert_review_word(&conn, "rv:two", Some(2)).unwrap();
    assert!(insert_review_word(&conn, "rv:one", Some(3)).is_err());
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM review_word", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 2);
  }

  #[test]
  fn review_word_level_accepts_null_and_one_to_four_only() {
    let conn = memory_db();
    migrate(&conn).unwrap();

    assert!(insert_review_word(&conn, "rv:too-high", Some(5)).is_err());
    insert_review_word(&conn, "rv:null", None).unwrap();
    insert_review_word(&conn, "rv:three", Some(3)).unwrap();
    let levels: Vec<Option<i32>> = {
      let mut stmt = conn.prepare("SELECT level FROM review_word ORDER BY id").unwrap();
      stmt
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
    };
    assert_eq!(levels, [None, Some(3)]);
  }

  #[test]
  fn open_enables_foreign_keys_and_cascades_example_deletion() {
    let conn = open(Path::new(":memory:")).unwrap();
    let enabled: i32 = conn.query_row("PRAGMA foreign_keys", [], |row| row.get(0)).unwrap();
    assert_eq!(enabled, 1);
    conn
      .execute(
        "INSERT INTO upgrade_entry (
          id, ord, line, raw, plain, upgrade, source, note, imported_at, updated_at, deleted
        ) VALUES ('up:one', 1, 1, '| raw |', 'plain', 'upgrade', 'source', '', 'now', 'now', 0)",
        [],
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO upgrade_example (entry_id, seq, cand, sentence, ai) VALUES ('up:one', 1, 'cand', 'sentence', 0)",
        [],
      )
      .unwrap();

    conn.execute("DELETE FROM upgrade_entry WHERE id = 'up:one'", []).unwrap();
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM upgrade_example", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 0);
    assert!(
      conn
        .execute(
          "INSERT INTO upgrade_example (entry_id, seq, cand, sentence, ai) VALUES ('up:missing', 1, 'cand', 'sentence', 0)",
          [],
        )
        .is_err()
    );
  }

  #[test]
  fn db_path_is_vocab_db_in_app_data_dir() {
    let path = db_path();
    assert_eq!(path.file_name().and_then(|name| name.to_str()), Some("vocab.db"));
    assert_eq!(path.parent(), Some(crate::paths::app_data_dir().as_path()));
  }
}
