//! 060 整库搬家：文件只含 vocab.db，不碰设置、视频和本地词典。
//! 前端负责文件对话框和 content:// 字节读写；这里只处理真正的 SQLite 文件。

use super::schema;
use chrono::Local;
use rusqlite::{backup::Backup, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

const BASE_TABLES: &[&str] = &["upgrade_entry", "upgrade_example", "self_check", "review_word", "import_run"];
const REQUIRED_TABLES: &[&str] = &[
  "upgrade_entry", "upgrade_example", "self_check", "review_word", "import_run",
  "error_top", "error_batch", "error_item", "error_todo", "error_essay", "review_log",
  "coach_essay", "coach_top_progress", "review_definition", "review_definition_example",
  "review_event", "vocab_note", "vocab_example", "example_scene", "quick_note", "vocab_definition_en",
];
const BACKUP_PREFIX: &str = "vocab-before-import-";
static TRANSFER_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySummary {
  pub words: i64,
  pub due: i64,
  pub notes: i64,
  pub quick_notes: i64,
  pub exported_at: Option<String>,
  pub schema_version: i32,
  /// 083：文件里带了设置（JSON 文本）；老文件没有。只在导入前预览时带给前端，让用户决定要不要恢复。
  pub settings: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryImportRequest {
  pub data: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryImportResult {
  pub summary: LibrarySummary,
  pub backup_path: Option<String>,
}

fn transfer_dir(db_path: &Path) -> PathBuf {
  db_path.parent().unwrap_or_else(|| Path::new(".")).join("library-transfer")
}
fn backup_dir(db_path: &Path) -> PathBuf {
  db_path.parent().unwrap_or_else(|| Path::new(".")).join("library-backups")
}
fn unique_file(dir: &Path, prefix: &str) -> PathBuf {
  dir.join(format!("{prefix}{}.wdlib", uuid::Uuid::new_v4().simple()))
}

fn backup_to(conn: &Connection, path: &Path) -> Result<(), String> {
  let mut dest = Connection::open(path).map_err(|e| format!("创建词库副本失败：{e}"))?;
  let backup = Backup::new(conn, &mut dest).map_err(|e| format!("准备词库副本失败：{e}"))?;
  backup.run_to_completion(128, Duration::from_millis(20), None)
    .map_err(|e| format!("复制词库失败：{e}"))?;
  Ok(())
}

/// 在线备份期间 SQLite 自己处理读写一致性；导出时间只写进副本，不改正在使用的库。
pub fn export_at(db_path: &Path) -> Result<Vec<u8>, String> { export_with_settings_at(db_path, None) }

/// 083：`settings` 是前端拼好的设置 JSON，只写进导出副本里的 english_studio_settings 表，本机库不留。
pub fn export_with_settings_at(db_path: &Path, settings: Option<&str>) -> Result<Vec<u8>, String> {
  let _guard = TRANSFER_LOCK.lock().map_err(|_| "整库搬家的锁已损坏，请重启应用。")?;
  if !db_path.is_file() { return Err("本机还没有词库，先添加或导入词条再导出。".into()); }
  let dir = transfer_dir(db_path);
  fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
  let snapshot = unique_file(&dir, "export-");
  let result = (|| {
    let source = schema::open(db_path).map_err(|e| format!("打开本机词库失败：{e}"))?;
    backup_to(&source, &snapshot)?;
    drop(source);
    let copy = Connection::open(&snapshot).map_err(|e| format!("检查词库副本失败：{e}"))?;
    copy.execute_batch("CREATE TABLE IF NOT EXISTS english_studio_export (exported_at TEXT NOT NULL);
      DELETE FROM english_studio_export;").map_err(|e| format!("写入导出时间失败：{e}"))?;
    copy.execute("INSERT INTO english_studio_export (exported_at) VALUES (?1)", [Local::now().to_rfc3339()])
      .map_err(|e| format!("写入导出时间失败：{e}"))?;
    if let Some(json) = settings {
      copy.execute_batch("CREATE TABLE IF NOT EXISTS english_studio_settings (json TEXT NOT NULL); DELETE FROM english_studio_settings;")
        .map_err(|e| format!("写入设置失败：{e}"))?;
      copy.execute("INSERT INTO english_studio_settings (json) VALUES (?1)", [json])
        .map_err(|e| format!("写入设置失败：{e}"))?;
    }
    drop(copy);
    fs::read(&snapshot).map_err(|e| format!("读取词库副本失败：{e}"))
  })();
  let _ = fs::remove_file(&snapshot);
  result
}

fn has_table(conn: &Connection, name: &str) -> Result<bool, String> {
  conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
    [name], |row| row.get(0)).map_err(|e| format!("检查词库表格失败：{e}"))
}
fn require_tables(conn: &Connection, tables: &[&str]) -> Result<(), String> {
  for table in tables {
    if !has_table(conn, table)? {
      return Err(format!("这不是完整的词滴词库：缺少必需的 {table} 表，本机数据没有改动。"));
    }
  }
  Ok(())
}

fn prepare_incoming(db_path: &Path, bytes: &[u8]) -> Result<(PathBuf, LibrarySummary), String> {
  if bytes.len() < 16 || &bytes[..16] != b"SQLite format 3\0" {
    return Err("这个文件不是 SQLite 词库文件，本机数据没有改动。".into());
  }
  let dir = transfer_dir(db_path);
  fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
  let path = unique_file(&dir, "incoming-");
  fs::write(&path, bytes).map_err(|e| format!("保存待导入文件失败：{e}"))?;
  let result = (|| {
    let conn = Connection::open(&path).map_err(|e| format!("打不开待导入词库：{e}，本机数据没有改动。"))?;
    conn.busy_timeout(Duration::from_secs(3)).map_err(|e| e.to_string())?;
    let version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))
      .map_err(|e| format!("读取词库版本失败：{e}"))?;
    if version > schema::SCHEMA_VERSION {
      return Err(format!("文件由更新版本导出（词库版本 {version}），本机只支持到 {}。请先升级本机应用，本机数据没有改动。", schema::SCHEMA_VERSION));
    }
    require_tables(&conn, BASE_TABLES)?;
    // 老版本先只迁移临时副本；任何一步失败都不会碰本机库。
    schema::migrate(&conn).map_err(|e| format!("升级待导入词库失败：{e}，本机数据没有改动。"))?;
    require_tables(&conn, REQUIRED_TABLES)?;
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))
      .map_err(|e| format!("检查待导入词库失败：{e}"))?;
    if integrity != "ok" { return Err(format!("待导入词库已损坏（{integrity}），本机数据没有改动。")); }
    let today = Local::now().format("%Y-%m-%d").to_string();
    let count = |sql: &str| conn.query_row(sql, [], |row| row.get::<_, i64>(0))
      .map_err(|e| format!("读取待导入词库摘要失败：{e}"));
    let summary = LibrarySummary {
      words: count("SELECT COUNT(*) FROM review_word WHERE deleted = 0")?,
      due: conn.query_row("SELECT COUNT(*) FROM review_word
        WHERE deleted = 0 AND level BETWEEN 1 AND 4 AND status = 'L' || level AND due <> '' AND due <= ?1",
        [today], |row| row.get(0)).map_err(|e| format!("读取到期数失败：{e}"))?,
      notes: count("SELECT COUNT(*) FROM vocab_note")?,
      quick_notes: count("SELECT COUNT(*) FROM quick_note")?,
      exported_at: if has_table(&conn, "english_studio_export")? {
        conn.query_row("SELECT exported_at FROM english_studio_export LIMIT 1", [], |row| row.get(0)).optional()
          .map_err(|e| format!("读取导出时间失败：{e}"))?
      } else { None },
      schema_version: schema::SCHEMA_VERSION,
      settings: if has_table(&conn, "english_studio_settings")? {
        conn.query_row("SELECT json FROM english_studio_settings LIMIT 1", [], |row| row.get(0)).optional()
          .map_err(|e| format!("读取设置失败：{e}"))?
      } else { None },
    };
    drop(conn);
    Ok(summary)
  })();
  match result {
    Ok(summary) => Ok((path, summary)),
    Err(error) => { let _ = fs::remove_file(&path); Err(error) }
  }
}

pub fn preview_at(db_path: &Path, bytes: &[u8]) -> Result<LibrarySummary, String> {
  let _guard = TRANSFER_LOCK.lock().map_err(|_| "整库搬家的锁已损坏，请重启应用。")?;
  let (path, summary) = prepare_incoming(db_path, bytes)?;
  let _ = fs::remove_file(path);
  Ok(summary)
}

fn prune_backups(dir: &Path) -> Result<(), String> {
  let mut files = fs::read_dir(dir).map_err(|e| format!("读取自动备份目录失败：{e}"))?
    .filter_map(Result::ok).map(|entry| entry.path())
    .filter(|path| path.file_name().and_then(|s| s.to_str()).map_or(false, |name| {
      name.starts_with(BACKUP_PREFIX) && name.ends_with(".wdlib")
    })).collect::<Vec<_>>();
  files.sort();
  let remove_count = files.len().saturating_sub(3);
  for path in files.into_iter().take(remove_count) {
    fs::remove_file(&path).map_err(|e| format!("清理旧自动备份失败：{e}"))?;
  }
  Ok(())
}

fn backup_current(db_path: &Path) -> Result<Option<PathBuf>, String> {
  if !db_path.is_file() { return Ok(None); }
  let dir = backup_dir(db_path);
  fs::create_dir_all(&dir).map_err(|e| format!("创建自动备份目录失败：{e}"))?;
  let stamp = Local::now().format("%Y%m%d-%H%M%S%.3f");
  let path = dir.join(format!("{BACKUP_PREFIX}{stamp}-{}.wdlib", uuid::Uuid::new_v4().simple()));
  let conn = schema::open(db_path).map_err(|e| format!("导入前打开本机词库失败：{e}"))?;
  backup_to(&conn, &path)?;
  drop(conn);
  prune_backups(&dir)?;
  Ok(Some(path))
}

#[cfg(not(windows))]
fn replace_file(staged: &Path, current: &Path) -> io::Result<()> { fs::rename(staged, current) }

/// Windows 的 std::fs::rename 不覆盖已有文件；ReplaceFileW 失败时旧文件仍在原处。
#[cfg(windows)]
fn replace_file(staged: &Path, current: &Path) -> io::Result<()> {
  use std::os::windows::ffi::OsStrExt;
  unsafe extern "system" {
    fn ReplaceFileW(replaced: *const u16, replacement: *const u16, backup: *const u16,
      flags: u32, exclude: *mut core::ffi::c_void, reserved: *mut core::ffi::c_void) -> i32;
  }
  let to = current.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
  let from = staged.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
  let ok = unsafe { ReplaceFileW(to.as_ptr(), from.as_ptr(), std::ptr::null(), 1, std::ptr::null_mut(), std::ptr::null_mut()) };
  if ok == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
}

fn import_with_replace<F>(db_path: &Path, bytes: &[u8], replace: F) -> Result<LibraryImportResult, String>
where F: FnOnce(&Path, &Path) -> io::Result<()> {
  let _guard = TRANSFER_LOCK.lock().map_err(|_| "整库搬家的锁已损坏，请重启应用。")?;
  let (staged, summary) = prepare_incoming(db_path, bytes)?;
  let result = (|| {
    let backup = backup_current(db_path)?;
    if db_path.exists() {
      replace(&staged, db_path).map_err(|e| format!("替换词库失败：{e}。本机原词库仍在，自动备份也已保留，请关闭正在复习或查词的页面后重试。"))?;
    } else {
      fs::rename(&staged, db_path).map_err(|e| format!("放入新词库失败：{e}，本机数据没有改动。"))?;
    }
    let opened = schema::open(db_path).map_err(|e| format!("新词库已放入，但重新打开失败：{e}；可用自动备份恢复。"))?;
    // 071：换了一份库，同步状态（cursor、别的设备留下的账本）全部作废，所有行重新记成待推送。
    super::sync::reset_all(&opened).map_err(|e| format!("新词库已放入，但重置同步状态失败：{e}；可用自动备份恢复。"))?;
    // 083：文件里带的设置（含密钥）不留在本机词库里；前端预览时已经拿走，用户选了才恢复。
    opened.execute_batch("DROP TABLE IF EXISTS english_studio_settings;").map_err(|e| format!("清理导入文件里的设置失败：{e}"))?;
    drop(opened);
    let summary = LibrarySummary { settings: None, ..summary };
    Ok(LibraryImportResult { summary, backup_path: backup.map(|p| p.to_string_lossy().into_owned()) })
  })();
  if result.is_err() { let _ = fs::remove_file(&staged); }
  result
}

pub fn import_at(db_path: &Path, bytes: &[u8]) -> Result<LibraryImportResult, String> {
  import_with_replace(db_path, bytes, replace_file)
}

#[cfg(test)]
mod tests {
  use super::*;

  struct Dir(PathBuf);
  impl Dir {
    fn new(name: &str) -> Self {
      let path = std::env::temp_dir().join(format!("es-library-{name}-{}", uuid::Uuid::new_v4()));
      fs::create_dir_all(&path).unwrap();
      Self(path)
    }
  }
  impl Drop for Dir { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

  fn seed_source(path: &Path) {
    let conn = schema::open(path).unwrap();
    conn.execute("INSERT INTO review_word (id, ord, line, raw, word, word_norm, issue, added_at, status,
      level, due, note, imported_at, updated_at, deleted, source, verification_status)
      VALUES ('word-1', 1, 1, 'serendipity', 'serendipity', 'serendipity', '测试期', '2026-01-01',
      'L2', 2, '2020-01-01', '进度备注', '2026-01-01', '2026-01-02', 0, '测试', '老师确认')", []).unwrap();
    conn.execute("INSERT INTO review_log (word_id, review_date, kind, correct, before_status,
      after_status, before_due, after_due, created_at) VALUES ('word-1', '2026-01-02', 'recall', 1,
      'L1', 'L2', '2026-01-01', '2020-01-01', '2026-01-02')", []).unwrap();
    conn.execute("INSERT INTO vocab_note (word_key, word, body, source, created_at, updated_at)
      VALUES ('serendipity', 'serendipity', '一条笔记', '词库', '2026-01-02', '2026-01-02')", []).unwrap();
    conn.execute("INSERT INTO vocab_example (word_key, word, sentence, source, created_at)
      VALUES ('serendipity', 'serendipity', 'A lucky discovery.', '自己写', '2026-01-02')", []).unwrap();
    conn.execute("INSERT INTO vocab_definition_en (word_key, word, pos, text, source, created_at, updated_at)
      VALUES ('serendipity', 'serendipity', 'n.', 'a lucky discovery', 'mine', '2026-01-02', '2026-01-02')", []).unwrap();
    conn.execute("INSERT INTO wordpack_pick (word_key, word, state, pack, decided_at, updated_at)
      VALUES ('able', 'able', 'known', '四级', '2026-01-02', '2026-01-02')", []).unwrap();
    conn.execute("INSERT INTO daily_plan (id, packs, per_day, card_on, updated_at)
      VALUES ('default', '[\"cet4\"]', 5, 1, '2026-01-02')", []).unwrap();
    conn.execute("INSERT INTO quick_note (body, created_at, updated_at, device_id)
      VALUES ('一条随手记', '2026-01-02', '2026-01-02', 'test')", []).unwrap();
    conn.execute("INSERT INTO review_definition (word_id, source_file, source_line, pos, english, chinese)
      VALUES ('word-1', 'test.md', 1, 'n.', 'a lucky discovery', '意外发现')", []).unwrap();
    conn.execute("INSERT INTO review_definition_example (word_id, source_file, definition_line, seq, sentence, ai)
      VALUES ('word-1', 'test.md', 1, 1, 'What serendipity!', 0)", []).unwrap();
    conn.execute("INSERT INTO upgrade_entry (id, ord, line, raw, plain, upgrade, source, note,
      imported_at, updated_at, deleted) VALUES ('up-1', 1, 1, 'good', 'good', 'excellent', 'test', '',
      '2026-01-01', '2026-01-01', 0)", []).unwrap();
    conn.execute("INSERT INTO upgrade_example (entry_id, seq, cand, sentence, ai)
      VALUES ('up-1', 1, 'excellent', 'An excellent example.', 0)", []).unwrap();
  }

  #[test]
  fn round_trip_keeps_words_progress_notes_examples_quicknotes_and_logs() {
    let dir = Dir::new("round-trip");
    let source = dir.0.join("source.db");
    let target = dir.0.join("target.db");
    seed_source(&source);
    schema::open(&target).unwrap();
    let bytes = export_at(&source).unwrap();
    assert!(bytes.len() > 16_000, "实测导出文件应有 SQLite 页面，而不只是词表");
    let preview = preview_at(&target, &bytes).unwrap();
    assert_eq!((preview.words, preview.due, preview.notes, preview.quick_notes), (1, 1, 1, 1));
    assert!(preview.exported_at.is_some());
    let result = import_at(&target, &bytes).unwrap();
    assert!(result.backup_path.is_some());
    let conn = schema::open(&target).unwrap();
    assert_eq!(conn.query_row("SELECT status || '|' || level || '|' || due || '|' || note FROM review_word", [], |r| r.get::<_, String>(0)).unwrap(), "L2|2|2020-01-01|进度备注");
    for table in ["review_word", "review_log", "vocab_note", "vocab_example", "vocab_definition_en", "wordpack_pick", "daily_plan", "quick_note", "upgrade_example", "review_definition_example"] {
      assert_eq!(conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get::<_, i64>(0)).unwrap(), 1, "{table}");
    }
  }

  /// 083：带设置导出 → 预览能读到；老文件（不带）预览 settings 为空；导入后本机库里不留设置表。
  #[test]
  fn settings_ride_along_and_are_not_kept_in_the_live_db() {
    let dir = Dir::new("settings");
    let source = dir.0.join("source.db");
    let target = dir.0.join("target.db");
    seed_source(&source);
    schema::open(&target).unwrap();
    let plain = export_at(&source).unwrap();
    assert_eq!(preview_at(&target, &plain).unwrap().settings, None, "旧格式没有设置，照常能导入");
    let with = export_with_settings_at(&source, Some("{\"k\":\"v\"}")).unwrap();
    assert_eq!(preview_at(&target, &with).unwrap().settings.as_deref(), Some("{\"k\":\"v\"}"));
    let result = import_at(&target, &with).unwrap();
    assert_eq!(result.summary.settings, None);
    let conn = schema::open(&target).unwrap();
    let left: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = 'english_studio_settings'", [], |r| r.get(0)).unwrap();
    assert_eq!(left, 0);
    drop(conn);
    import_at(&target, &plain).unwrap();
  }

  /// 071：整库导入后，同步状态作废（cursor、首次标记、别人的账本），所有行重新记成待推送。
  #[test]
  fn import_resets_sync_state_and_marks_every_row_dirty() {
    let dir = Dir::new("sync-reset");
    let source = dir.0.join("source.db");
    let target = dir.0.join("target.db");
    seed_source(&source);
    {
      let conn = schema::open(&target).unwrap();
      conn.execute("INSERT INTO sync_meta (k, v) VALUES ('cursor:s#1', '99'), ('init:s#1', '1')", []).unwrap();
      conn.execute("INSERT INTO sync_change (tbl, sid, updated_at, deleted, dirty) VALUES ('review_word', 'old-ghost', 1, 1, 0)", []).unwrap();
    }
    import_at(&target, &export_at(&source).unwrap()).unwrap();
    let conn = schema::open(&target).unwrap();
    let n = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
    assert_eq!(n("SELECT COUNT(*) FROM sync_meta WHERE k LIKE 'cursor:%' OR k LIKE 'init:%'"), 0);
    assert_eq!(n("SELECT COUNT(*) FROM sync_change WHERE sid = 'old-ghost'"), 0);
    // 种子数据：12 张表各 1 行（词、日志、笔记、例句、英英释义、候选池、学习计划、随手记、义项、义项例句、升级词、升级例句）
    assert_eq!(n("SELECT COUNT(*) FROM sync_change WHERE dirty = 1"), 12);
    assert_eq!(n("SELECT COUNT(*) FROM sync_change WHERE dirty = 0"), 0);
  }

  #[test]
  fn invalid_files_are_rejected_without_touching_current_db() {
    let dir = Dir::new("invalid");
    let target = dir.0.join("vocab.db");
    seed_source(&target);
    let before = fs::read(&target).unwrap();
    assert!(preview_at(&target, b"definitely not sqlite").unwrap_err().contains("不是 SQLite"));
    assert!(import_at(&target, b"definitely not sqlite").is_err());
    assert_eq!(fs::read(&target).unwrap(), before);
    let missing = dir.0.join("missing.db");
    let conn = Connection::open(&missing).unwrap();
    conn.execute_batch("PRAGMA user_version = 11; CREATE TABLE review_word(id TEXT);").unwrap();
    drop(conn);
    let missing_bytes = fs::read(&missing).unwrap();
    assert!(preview_at(&target, &missing_bytes).unwrap_err().contains("缺少必需"));
    assert!(import_at(&target, &missing_bytes).is_err());
    assert_eq!(fs::read(&target).unwrap(), before);
    let newer = dir.0.join("newer.db");
    seed_source(&newer);
    Connection::open(&newer).unwrap().pragma_update(None, "user_version", schema::SCHEMA_VERSION + 1).unwrap();
    let newer_bytes = fs::read(&newer).unwrap();
    assert!(preview_at(&target, &newer_bytes).unwrap_err().contains("更新版本"));
    assert!(import_at(&target, &newer_bytes).is_err());
    assert_eq!(fs::read(&target).unwrap(), before);
  }

  #[test]
  fn failed_replace_leaves_current_db_unchanged() {
    let dir = Dir::new("failed-replace");
    let source = dir.0.join("source.db");
    let target = dir.0.join("vocab.db");
    seed_source(&source);
    schema::open(&target).unwrap().execute("INSERT INTO quick_note (body, created_at, updated_at, device_id)
      VALUES ('本机原文', '2026-01-01', '2026-01-01', 'local')", []).unwrap();
    let bytes = export_at(&source).unwrap();
    let before = fs::read(&target).unwrap();
    let error = import_with_replace(&target, &bytes, |_, _| Err(io::Error::new(io::ErrorKind::Other, "模拟替换失败"))).unwrap_err();
    assert!(error.contains("模拟替换失败"));
    assert_eq!(fs::read(&target).unwrap(), before);
    assert_eq!(schema::open(&target).unwrap().query_row("SELECT body FROM quick_note", [], |r| r.get::<_, String>(0)).unwrap(), "本机原文");
  }

  #[test]
  fn automatic_backup_keeps_only_latest_three() {
    let dir = Dir::new("backup-retention");
    let db = dir.0.join("vocab.db");
    seed_source(&db);
    for _ in 0..5 { backup_current(&db).unwrap(); }
    assert_eq!(fs::read_dir(backup_dir(&db)).unwrap().filter_map(Result::ok).count(), 3);
  }

  #[test]
  fn older_schema_is_migrated_on_temporary_copy() {
    let dir = Dir::new("old-schema");
    let old = dir.0.join("old.db");
    let conn = Connection::open(&old).unwrap();
    conn.execute_batch("PRAGMA user_version = 1;
      CREATE TABLE upgrade_entry(id TEXT PRIMARY KEY, ord INTEGER, line INTEGER, raw TEXT, plain TEXT, upgrade TEXT, source TEXT, note TEXT, imported_at TEXT, updated_at TEXT, deleted INTEGER DEFAULT 0);
      CREATE TABLE upgrade_example(entry_id TEXT, seq INTEGER, cand TEXT, sentence TEXT, ai INTEGER);
      CREATE TABLE self_check(id TEXT PRIMARY KEY, ord INTEGER, line INTEGER, raw TEXT, text TEXT, imported_at TEXT, updated_at TEXT, deleted INTEGER DEFAULT 0);
      CREATE TABLE review_word(id TEXT PRIMARY KEY, ord INTEGER, line INTEGER, raw TEXT, word TEXT, word_norm TEXT, issue TEXT, added_at TEXT, status TEXT, level INTEGER, due TEXT, note TEXT, imported_at TEXT, updated_at TEXT, deleted INTEGER DEFAULT 0);
      CREATE TABLE import_run(id INTEGER PRIMARY KEY, source_file TEXT, source_sha256 TEXT, started_at TEXT, counts_json TEXT, warnings_json TEXT);").unwrap();
    drop(conn);
    let target = dir.0.join("target.db");
    let summary = preview_at(&target, &fs::read(&old).unwrap()).unwrap();
    assert_eq!(summary.schema_version, schema::SCHEMA_VERSION);
    assert!(summary.exported_at.is_none());
    assert!(!target.exists());
  }
}
