use std::collections::HashSet;
use std::fs;
use std::path::Path;

use chrono::{NaiveDate, SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use sha2::{Digest, Sha256};

use super::models::{
  ImportPreviewReport, ImportReport, ImportRequest, ReviewWordInput, VocabStats,
};
use super::schema;

fn sha256(text: &str) -> String {
  format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn required(value: &str, field: &str) -> Result<(), String> {
  if value.trim().is_empty() {
    Err(format!("{field} 不能为空"))
  } else {
    Ok(())
  }
}

fn date(value: &str, field: &str, empty_ok: bool) -> Result<(), String> {
  if value.is_empty() && empty_ok {
    return Ok(());
  }
  let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d")
    .map_err(|_| format!("{field} 不是合法日期：{value}"))?;
  if parsed.format("%Y-%m-%d").to_string() != value {
    return Err(format!("{field} 必须使用 YYYY-MM-DD：{value}"));
  }
  Ok(())
}

fn unique_ids<'a>(ids: impl Iterator<Item = &'a str>, table: &str) -> Result<(), String> {
  let mut seen = HashSet::new();
  for id in ids {
    required(id, &format!("{table} ID"))?;
    if !seen.insert(id) {
      return Err(format!("{table} 本批 ID 重复：{id}"));
    }
  }
  Ok(())
}

fn validate(request: &ImportRequest) -> Result<(), String> {
  required(&request.upgrade.file_name, "升级库文件名")?;
  required(&request.review.file_name, "复习库文件名")?;
  required(&request.upgrade.content, "升级库内容")?;
  required(&request.review.content, "复习库内容")?;
  if request.entries.is_empty() {
    return Err("升级库主表为空".into());
  }
  if request.review_words.is_empty() {
    return Err("复习库主表为空".into());
  }

  unique_ids(request.entries.iter().map(|entry| entry.id.as_str()), "升级库")?;
  unique_ids(
    request.self_checks.iter().map(|check| check.id.as_str()),
    "写作自查",
  )?;
  unique_ids(
    request.review_words.iter().map(|word| word.id.as_str()),
    "复习库",
  )?;

  for entry in &request.entries {
    if entry.line < 1 {
      return Err(format!("升级库 {} 的行号无效", entry.id));
    }
    required(&entry.raw, &format!("升级库 {} 的 raw", entry.id))?;
    required(&entry.plain, &format!("升级库 {} 的日常表达", entry.id))?;
    required(&entry.upgrade, &format!("升级库 {} 的学术表达", entry.id))?;
  }
  for check in &request.self_checks {
    if check.line < 1 {
      return Err(format!("写作自查 {} 的行号无效", check.id));
    }
    required(&check.raw, &format!("写作自查 {} 的 raw", check.id))?;
    required(&check.text, &format!("写作自查 {} 的内容", check.id))?;
  }

  let entry_ids: HashSet<&str> = request.entries.iter().map(|entry| entry.id.as_str()).collect();
  let mut example_keys = HashSet::new();
  for example in &request.examples {
    if !entry_ids.contains(example.entry_id.as_str()) {
      return Err(format!("例句引用了不存在的词条：{}", example.entry_id));
    }
    if example.seq < 1 {
      return Err(format!("词条 {} 的例句序号无效", example.entry_id));
    }
    if !example_keys.insert((example.entry_id.as_str(), example.seq)) {
      return Err(format!(
        "词条 {} 的例句序号重复：{}",
        example.entry_id, example.seq
      ));
    }
    required(&example.sentence, &format!("词条 {} 的例句", example.entry_id))?;
  }

  for word in &request.review_words {
    validate_word(word)?;
  }
  for warning in request
    .warnings
    .upgrade
    .iter()
    .chain(request.warnings.review.iter())
  {
    if warning.line < 0 {
      return Err("警告行号不能是负数".into());
    }
    required(&warning.kind, "警告类型")?;
    required(&warning.message, "警告内容")?;
  }
  Ok(())
}

fn validate_word(word: &ReviewWordInput) -> Result<(), String> {
  if word.line < 1 {
    return Err(format!("复习库 {} 的行号无效", word.id));
  }
  required(&word.raw, &format!("复习库 {} 的 raw", word.id))?;
  required(&word.word, &format!("复习库 {} 的单词", word.id))?;
  required(&word.issue, &format!("复习库 {} 的期号", word.id))?;
  required(&word.status, &format!("复习库 {} 的状态", word.id))?;
  date(&word.added_at, &format!("复习库 {} 的入库日期", word.id), false)?;
  date(&word.due, &format!("复习库 {} 的到期日期", word.id), true)?;

  let expected_level = match word.status.as_str() {
    "L1" => Some(1),
    "L2" => Some(2),
    "L3" => Some(3),
    "L4" => Some(4),
    "L5" => Some(5),
    "L6" => Some(6),
    "L7" => Some(7),
    "🌱待考察" | "✅已掌握" | "🧊冷库" => None,
    _ => return Err(format!("复习库 {} 的状态未知：{}", word.id, word.status)),
  };
  if word.level != expected_level {
    return Err(format!(
      "复习库 {} 的 level 与状态 {} 不一致",
      word.id, word.status
    ));
  }
  Ok(())
}

fn normalized_word(word: &str) -> String {
  word
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ")
    .to_lowercase()
}

fn next_ord(tx: &Transaction<'_>, table: &str) -> Result<i64, String> {
  // `table` 只会是下面三个写死的表名之一，不来自用户输入（防 SQL 注入）。
  let sql = match table {
    "upgrade_entry" | "self_check" | "review_word" => {
      format!("SELECT COALESCE(MAX(ord), 0) + 1 FROM {table}")
    }
    _ => return Err("内部错误：未知排序表".into()),
  };
  tx.query_row(&sql, [], |row| row.get(0))
    .map_err(|error| format!("读取 {table} 顺序失败：{error}"))
}

fn import_entries(
  tx: &Transaction<'_>,
  request: &ImportRequest,
  now: &str,
  report: &mut ImportReport,
) -> Result<(), String> {
  let mut ord = next_ord(tx, "upgrade_entry")?;
  for entry in &request.entries {
    let existing = tx
      .query_row(
        "SELECT plain, upgrade, source, note FROM upgrade_entry WHERE id = ?1",
        [&entry.id],
        |row| {
          Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
          ))
        },
      )
      .optional()
      .map_err(|error| format!("读取升级库 {} 失败：{error}", entry.id))?;

    if let Some(existing) = existing {
      let current = (
        entry.plain.clone(),
        entry.upgrade.clone(),
        entry.source.clone(),
        entry.note.clone(),
      );
      if existing != current {
        return Err(format!("升级库 ID 内容冲突：{}", entry.id));
      }
      let old_examples = tx
        .prepare("SELECT seq, cand, sentence, ai FROM upgrade_example WHERE entry_id = ?1 ORDER BY seq")
        .and_then(|mut statement| {
          statement
            .query_map([&entry.id], |row| {
              Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, bool>(3)?,
              ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|error| format!("读取词条 {} 的例句失败：{error}", entry.id))?;
      let mut new_examples = request
        .examples
        .iter()
        .filter(|example| example.entry_id == entry.id)
        .map(|example| {
          (
            example.seq,
            example.cand.clone(),
            example.sentence.clone(),
            example.ai,
          )
        })
        .collect::<Vec<_>>();
      new_examples.sort_by_key(|example| example.0);
      if old_examples != new_examples {
        return Err(format!("升级库 ID 的例句内容冲突：{}", entry.id));
      }
      report.upgrade_entries.skipped += 1;
      continue;
    }

    tx.execute(
      "INSERT INTO upgrade_entry (
        id, ord, line, raw, plain, upgrade, source, note, imported_at, updated_at, deleted
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, 0)",
      params![
        entry.id,
        ord,
        entry.line,
        entry.raw,
        entry.plain,
        entry.upgrade,
        entry.source,
        entry.note,
        now
      ],
    )
    .map_err(|error| format!("写入升级库 {} 失败：{error}", entry.id))?;
    ord += 1;
    report.upgrade_entries.added += 1;

    for example in request
      .examples
      .iter()
      .filter(|example| example.entry_id == entry.id)
    {
      tx.execute(
        "INSERT INTO upgrade_example (entry_id, seq, cand, sentence, ai) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
          example.entry_id,
          example.seq,
          example.cand,
          example.sentence,
          example.ai
        ],
      )
      .map_err(|error| format!("写入词条 {} 的例句失败：{error}", entry.id))?;
      report.upgrade_examples_added += 1;
    }
  }
  Ok(())
}

fn import_self_checks(
  tx: &Transaction<'_>,
  request: &ImportRequest,
  now: &str,
  report: &mut ImportReport,
) -> Result<(), String> {
  let mut ord = next_ord(tx, "self_check")?;
  for check in &request.self_checks {
    let existing = tx
      .query_row(
        "SELECT text FROM self_check WHERE id = ?1",
        [&check.id],
        |row| row.get::<_, String>(0),
      )
      .optional()
      .map_err(|error| format!("读取写作自查 {} 失败：{error}", check.id))?;
    if let Some(existing) = existing {
      if existing != check.text {
        return Err(format!("写作自查 ID 内容冲突：{}", check.id));
      }
      report.self_checks.skipped += 1;
      continue;
    }
    tx.execute(
      "INSERT INTO self_check (
        id, ord, line, raw, text, imported_at, updated_at, deleted
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 0)",
      params![check.id, ord, check.line, check.raw, check.text, now],
    )
    .map_err(|error| format!("写入写作自查 {} 失败：{error}", check.id))?;
    ord += 1;
    report.self_checks.added += 1;
  }
  Ok(())
}

enum ReviewImportAction {
  Add,
  Update,
  Skip,
  Conflict(String),
}

/// 预览和正式导入共用这份判定，避免两边对「更新」和「冲突」的理解不同。
fn review_import_action(
  conn: &Connection,
  word: &ReviewWordInput,
  has_review_log: bool,
) -> Result<ReviewImportAction, String> {
  let sql = if has_review_log {
    "SELECT word, issue, added_at, status, level, due, note,
            EXISTS(SELECT 1 FROM review_log WHERE word_id = review_word.id)
     FROM review_word WHERE id = ?1"
  } else {
    // v1/v2 还没有复习日志；只读预览不能为了迁移而写库。
    "SELECT word, issue, added_at, status, level, due, note, 0
     FROM review_word WHERE id = ?1"
  };
  let existing = conn
    .query_row(
      sql,
      [&word.id],
      |row| {
        Ok((
          row.get::<_, String>(0)?,
          row.get::<_, String>(1)?,
          row.get::<_, String>(2)?,
          row.get::<_, String>(3)?,
          row.get::<_, Option<i64>>(4)?,
          row.get::<_, String>(5)?,
          row.get::<_, String>(6)?,
          row.get::<_, bool>(7)?,
        ))
      },
    )
    .optional()
    .map_err(|error| format!("读取复习库 {} 失败：{error}", word.id))?;
  let Some(existing) = existing else {
    return Ok(ReviewImportAction::Add);
  };
  if existing.0 != word.word || existing.1 != word.issue || existing.2 != word.added_at {
    return Ok(ReviewImportAction::Conflict(format!(
      "复习库 ID 的单词、期号或入库日期冲突：{}",
      word.id
    )));
  }
  let state_changed = existing.3 != word.status
    || existing.4 != word.level
    || existing.5 != word.due
    || existing.6 != word.note;
  if !state_changed || existing.7 {
    Ok(ReviewImportAction::Skip)
  } else {
    Ok(ReviewImportAction::Update)
  }
}

fn import_review_words(
  tx: &Transaction<'_>,
  request: &ImportRequest,
  now: &str,
  report: &mut ImportReport,
) -> Result<(), String> {
  let mut ord = next_ord(tx, "review_word")?;
  for word in &request.review_words {
    match review_import_action(tx, word, true)? {
      ReviewImportAction::Conflict(message) => {
        report.review_words.conflicts += 1;
        return Err(message);
      }
      ReviewImportAction::Skip => {
        report.review_words.skipped += 1;
        continue;
      }
      ReviewImportAction::Update => {
        tx.execute(
          "UPDATE review_word
           SET raw = ?2, status = ?3, level = ?4, due = ?5, note = ?6, updated_at = ?7
           WHERE id = ?1",
          params![word.id, word.raw, word.status, word.level, word.due, word.note, now],
        )
        .map_err(|error| format!("更新复习库 {} 失败：{error}", word.id))?;
        report.review_words.updated += 1;
        continue;
      }
      ReviewImportAction::Add => {}
    }
    tx.execute(
      "INSERT INTO review_word (
        id, ord, line, raw, word, word_norm, issue, added_at, status,
        level, due, note, imported_at, updated_at, deleted
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, 0)",
      params![
        word.id,
        ord,
        word.line,
        word.raw,
        word.word,
        normalized_word(&word.word),
        word.issue,
        word.added_at,
        word.status,
        word.level,
        word.due,
        word.note,
        now
      ],
    )
    .map_err(|error| format!("写入复习库 {} 失败：{error}", word.id))?;
    ord += 1;
    report.review_words.added += 1;
  }
  Ok(())
}

fn count(conn: &Connection, table: &str) -> Result<i64, String> {
  let sql = match table {
    "upgrade_entry" | "upgrade_example" | "self_check" | "review_word" | "import_run" => {
      format!("SELECT COUNT(*) FROM {table}")
    }
    _ => return Err("内部错误：未知统计表".into()),
  };
  conn
    .query_row(&sql, [], |row| row.get(0))
    .map_err(|error| format!("统计 {table} 失败：{error}"))
}

pub(super) fn stats_from_conn(conn: &Connection) -> Result<VocabStats, String> {
  Ok(VocabStats {
    upgrade_entries: count(conn, "upgrade_entry")?,
    upgrade_examples: count(conn, "upgrade_example")?,
    self_checks: count(conn, "self_check")?,
    review_words: count(conn, "review_word")?,
    import_runs: count(conn, "import_run")?,
  })
}

fn insert_run(
  tx: &Transaction<'_>,
  source_file: &str,
  source_sha256: &str,
  now: &str,
  counts: serde_json::Value,
  warnings: &impl serde::Serialize,
) -> Result<(), String> {
  tx.execute(
    "INSERT INTO import_run (
      source_file, source_sha256, started_at, counts_json, warnings_json
    ) VALUES (?1, ?2, ?3, ?4, ?5)",
    params![
      source_file,
      source_sha256,
      now,
      serde_json::to_string(&counts).map_err(|error| error.to_string())?,
      serde_json::to_string(warnings).map_err(|error| error.to_string())?
    ],
  )
  .map_err(|error| format!("写入导入日志失败：{error}"))?;
  Ok(())
}

/// 生产导入入口。校验完成后才建目录/数据库，两份文件在一个事务里提交。
pub fn import_at(path: &Path, request: ImportRequest) -> Result<ImportReport, String> {
  validate(&request)?;
  let upgrade_sha256 = sha256(&request.upgrade.content);
  let review_sha256 = sha256(&request.review.content);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| format!("创建词库目录失败：{error}"))?;
  }
  let mut conn = schema::open(path).map_err(|error| format!("打开词库数据库失败：{error}"))?;
  let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
  let tx = conn
    .transaction()
    .map_err(|error| format!("开启导入事务失败：{error}"))?;
  let mut report = ImportReport {
    upgrade_sha256,
    review_sha256,
    ..ImportReport::default()
  };

  import_entries(&tx, &request, &now, &mut report)?;
  import_self_checks(&tx, &request, &now, &mut report)?;
  import_review_words(&tx, &request, &now, &mut report)?;
  insert_run(
    &tx,
    &request.upgrade.file_name,
    &report.upgrade_sha256,
    &now,
    serde_json::json!({
      "entries": report.upgrade_entries,
      "examplesAdded": report.upgrade_examples_added,
      "selfChecks": report.self_checks,
    }),
    &request.warnings.upgrade,
  )?;
  insert_run(
    &tx,
    &request.review.file_name,
    &report.review_sha256,
    &now,
    serde_json::json!({ "words": report.review_words }),
    &request.warnings.review,
  )?;
  report.totals = stats_from_conn(&tx)
    .map_err(|error| format!("导入后统计失败：{error}"))?;
  tx.commit().map_err(|error| format!("提交导入事务失败：{error}"))?;
  Ok(report)
}

/// 只读比较复习词与主库；数据库不存在时全部算新增，不创建目录或文件。
pub fn preview_at(path: &Path, request: ImportRequest) -> Result<ImportPreviewReport, String> {
  validate(&request)?;
  let mut report = ImportPreviewReport::default();
  if !path.exists() {
    report.review_words.added = request.review_words.len() as i64;
    return Ok(report);
  }
  let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
    .map_err(|error| format!("只读打开词库数据库失败：{error}"))?;
  let has_review_log = conn
    .query_row(
      "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'review_log')",
      [],
      |row| row.get(0),
    )
    .map_err(|error| format!("检查复习日志表失败：{error}"))?;
  for word in &request.review_words {
    match review_import_action(&conn, word, has_review_log)? {
      ReviewImportAction::Add => report.review_words.added += 1,
      ReviewImportAction::Update => report.review_words.updated += 1,
      ReviewImportAction::Skip => report.review_words.skipped += 1,
      ReviewImportAction::Conflict(message) => {
        report.review_words.conflicts += 1;
        report.conflicts.push(message);
      }
    }
  }
  Ok(report)
}

/// 只读统计：数据库不存在时返回全零，不创建文件，也不做迁移。
pub fn stats_at(path: &Path) -> Result<VocabStats, String> {
  if !path.exists() {
    return Ok(VocabStats::default());
  }
  let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
    .map_err(|error| format!("只读打开词库数据库失败：{error}"))?;
  stats_from_conn(&conn)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::vocab::models::{
    ImportCounts, ImportWarnings, ReviewImportCounts, ReviewWordInput, SelfCheckInput, SourceInput,
    UpgradeEntryInput, UpgradeExampleInput,
  };
  use std::path::PathBuf;
  use uuid::Uuid;

  fn path() -> PathBuf {
    std::env::temp_dir().join(format!("vocab-import-{}.db", Uuid::new_v4()))
  }

  fn request() -> ImportRequest {
    ImportRequest {
      upgrade: SourceInput {
        file_name: "upgrade.md".into(),
        content: "upgrade source\n".into(),
      },
      review: SourceInput {
        file_name: "review.md".into(),
        content: "review source\n".into(),
      },
      entries: vec![UpgradeEntryInput {
        id: "up:one".into(),
        line: 4,
        raw: "| plain | upgrade | example | source | note |".into(),
        plain: "plain".into(),
        upgrade: "upgrade".into(),
        source: "source".into(),
        note: "完整备注，不截断".into(),
      }],
      examples: vec![UpgradeExampleInput {
        entry_id: "up:one".into(),
        seq: 1,
        cand: "upgrade".into(),
        sentence: "An upgrade example.".into(),
        ai: true,
      }],
      self_checks: vec![SelfCheckInput {
        id: "sc:1".into(),
        line: 8,
        raw: "- check".into(),
        text: "check".into(),
      }],
      review_words: vec![
        ReviewWordInput {
          id: "rv:same@1#1".into(),
          line: 5,
          raw: "| Same | 1 | 2026-11-01 | L2 | 2026-11-03 | first |".into(),
          word: "Same".into(),
          issue: "1".into(),
          added_at: "2026-11-01".into(),
          status: "L2".into(),
          level: Some(2),
          due: "2026-11-03".into(),
          note: "first".into(),
        },
        ReviewWordInput {
          id: "rv:same@2#1".into(),
          line: 6,
          raw: "| same | 2 | 2026-11-02 | 🌱待考察 | — | second |".into(),
          word: "same".into(),
          issue: "2".into(),
          added_at: "2026-11-02".into(),
          status: "🌱待考察".into(),
          level: None,
          due: "".into(),
          note: "second".into(),
        },
      ],
      warnings: ImportWarnings {
        upgrade: vec![],
        review: vec![],
      },
    }
  }

  fn table_count(path: &Path, table: &str) -> i64 {
    let conn = schema::open(path).unwrap();
    conn
      .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
      .unwrap()
  }

  #[test]
  fn first_and_repeat_import_are_idempotent_and_keep_original_raw() {
    let path = path();
    let first = import_at(&path, request()).unwrap();
    assert_eq!(first.upgrade_entries, ImportCounts { added: 1, skipped: 0 });
    assert_eq!(first.upgrade_examples_added, 1);
    assert_eq!(first.self_checks.added, 1);
    assert_eq!(first.review_words.added, 2);
    assert_eq!(first.totals.review_words, 2);
    assert_eq!(first.totals.import_runs, 2);

    let mut again = request();
    again.upgrade.content = "same business data, another source hash".into();
    again.entries[0].line = 99;
    again.entries[0].raw = "formatting changed".into();
    again.self_checks[0].line = 100;
    again.self_checks[0].raw = "changed".into();
    again.review_words[0].line = 101;
    again.review_words[0].raw = "changed".into();
    let second = import_at(&path, again).unwrap();
    assert_eq!(second.upgrade_entries, ImportCounts { added: 0, skipped: 1 });
    assert_eq!(second.upgrade_examples_added, 0);
    assert_eq!(second.self_checks, ImportCounts { added: 0, skipped: 1 });
    assert_eq!(second.review_words, ReviewImportCounts { added: 0, updated: 0, skipped: 2, conflicts: 0 });
    assert_eq!(second.totals.upgrade_examples, 1);
    assert_eq!(second.totals.import_runs, 4);

    let conn = schema::open(&path).unwrap();
    let saved: (i64, String, String) = conn
      .query_row(
        "SELECT line, raw, note FROM upgrade_entry WHERE id = 'up:one'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
      )
      .unwrap();
    assert_eq!(saved.0, 4);
    assert_eq!(saved.1, "| plain | upgrade | example | source | note |");
    assert_eq!(saved.2, "完整备注，不截断");
    drop(conn);
    std::fs::remove_file(path).unwrap();
  }

  #[test]
  fn same_id_with_different_identity_rolls_back_both_files() {
    let path = path();
    import_at(&path, request()).unwrap();
    let mut conflict = request();
    conflict.entries[0].id = "up:new".into();
    conflict.examples[0].entry_id = "up:new".into();
    conflict.review_words[0].note = "would update".into();
    conflict.review_words[1].issue = "changed issue".into();

    let preview = preview_at(&path, conflict.clone()).unwrap();
    assert_eq!(preview.review_words, ReviewImportCounts { added: 0, updated: 1, skipped: 0, conflicts: 1 });
    assert_eq!(preview.conflicts.len(), 1);

    let error = import_at(&path, conflict).unwrap_err();
    assert!(error.contains("rv:same@2#1"));
    assert_eq!(table_count(&path, "upgrade_entry"), 1);
    assert_eq!(table_count(&path, "upgrade_example"), 1);
    assert_eq!(table_count(&path, "import_run"), 2);
    let conn = schema::open(&path).unwrap();
    let note: String = conn
      .query_row("SELECT note FROM review_word WHERE id = 'rv:same@1#1'", [], |row| row.get(0))
      .unwrap();
    assert_eq!(note, "first", "冲突前面的更新也必须回滚");
    drop(conn);
    std::fs::remove_file(path).unwrap();
  }

  #[test]
  fn unreviewed_state_updates_and_preview_matches_import_without_writes() {
    let path = path();
    import_at(&path, request()).unwrap();
    let mut changed = request();
    changed.review_words[0].raw = "| Same | 1 | 2026-11-01 | L4 | 2026-12-01 | file update |".into();
    changed.review_words[0].status = "L4".into();
    changed.review_words[0].level = Some(4);
    changed.review_words[0].due = "2026-12-01".into();
    changed.review_words[0].note = "file update".into();
    let mut added = changed.review_words[1].clone();
    added.id = "rv:new@3#1".into();
    changed.review_words.push(added);

    let preview = preview_at(&path, changed.clone()).unwrap();
    assert_eq!(preview.review_words, ReviewImportCounts { added: 1, updated: 1, skipped: 1, conflicts: 0 });
    assert!(preview.conflicts.is_empty());
    assert_eq!(table_count(&path, "import_run"), 2, "预览不能新增导入日志");

    let report = import_at(&path, changed).unwrap();
    assert_eq!(report.review_words, preview.review_words);
    let conn = schema::open(&path).unwrap();
    let saved: (String, String, Option<i64>, String, String, i64, i64) = conn
      .query_row(
        "SELECT raw, status, level, due, note, line, ord FROM review_word WHERE id = 'rv:same@1#1'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
      )
      .unwrap();
    assert_eq!(saved, (
      "| Same | 1 | 2026-11-01 | L4 | 2026-12-01 | file update |".into(),
      "L4".into(), Some(4), "2026-12-01".into(), "file update".into(), 5, 1,
    ));
    assert_eq!(table_count(&path, "review_word"), 3);
    drop(conn);
    std::fs::remove_file(path).unwrap();
  }

  #[test]
  fn reviewed_word_keeps_software_state_while_unreviewed_word_updates() {
    let path = path();
    import_at(&path, request()).unwrap();
    let submitted = crate::vocab::review::submit_at(&path, crate::vocab::review::ReviewSubmitRequest {
      id: "rv:same@1#1".into(),
      kind: crate::vocab::review::ReviewKind::Recall,
      correct: true,
      previewed: false,
    }).unwrap();
    let mut changed = request();
    changed.review_words[0].raw = "| Same | 1 | 2026-11-01 | L1 | 2020-01-01 | stale file |".into();
    changed.review_words[0].status = "L1".into();
    changed.review_words[0].level = Some(1);
    changed.review_words[0].due = "2020-01-01".into();
    changed.review_words[0].note = "stale file".into();
    changed.review_words[1].raw = "| same | 2 | 2026-11-02 | L3 | 2026-11-20 | unreviewed update |".into();
    changed.review_words[1].status = "L3".into();
    changed.review_words[1].level = Some(3);
    changed.review_words[1].due = "2026-11-20".into();
    changed.review_words[1].note = "unreviewed update".into();

    let preview = preview_at(&path, changed.clone()).unwrap();
    assert_eq!(preview.review_words, ReviewImportCounts { added: 0, updated: 1, skipped: 1, conflicts: 0 });
    let report = import_at(&path, changed).unwrap();
    assert_eq!(report.review_words, preview.review_words);

    let conn = schema::open(&path).unwrap();
    let protected: (String, Option<i64>, String, String, String) = conn
      .query_row(
        "SELECT status, level, due, note, raw FROM review_word WHERE id = 'rv:same@1#1'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
      )
      .unwrap();
    assert_eq!(protected, (
      submitted.status, submitted.level, submitted.due, "first".into(),
      "| Same | 1 | 2026-11-01 | L2 | 2026-11-03 | first |".into(),
    ));
    let updated: (String, Option<i64>, String, String) = conn
      .query_row(
        "SELECT status, level, due, note FROM review_word WHERE id = 'rv:same@2#1'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
      )
      .unwrap();
    assert_eq!(updated, ("L3".into(), Some(3), "2026-11-20".into(), "unreviewed update".into()));
    assert_eq!(table_count(&path, "review_log"), 1);
    drop(conn);
    std::fs::remove_file(path).unwrap();
  }

  #[test]
  fn missing_source_rows_are_not_deleted_and_empty_db_preview_creates_nothing() {
    let path = path();
    let preview = preview_at(&path, request()).unwrap();
    assert_eq!(preview.review_words, ReviewImportCounts { added: 2, updated: 0, skipped: 0, conflicts: 0 });
    assert!(!path.exists());

    import_at(&path, request()).unwrap();
    let mut fewer = request();
    fewer.review_words.pop();
    let report = import_at(&path, fewer).unwrap();
    assert_eq!(report.review_words, ReviewImportCounts { added: 0, updated: 0, skipped: 1, conflicts: 0 });
    assert_eq!(report.totals.review_words, 2);
    std::fs::remove_file(path).unwrap();
  }

  #[test]
  fn same_business_content_with_new_ids_is_appended_in_batch_order() {
    let path = path();
    import_at(&path, request()).unwrap();
    let mut more = request();
    more.entries[0].id = "up:two".into();
    more.examples[0].entry_id = "up:two".into();
    more.self_checks[0].id = "sc:2".into();
    more.review_words[0].id = "rv:same@1#2".into();
    more.review_words[1].id = "rv:same@2#2".into();
    let report = import_at(&path, more).unwrap();
    assert_eq!(report.totals.upgrade_entries, 2);
    assert_eq!(report.totals.upgrade_examples, 2);
    assert_eq!(report.totals.self_checks, 2);
    assert_eq!(report.totals.review_words, 4);

    let conn = schema::open(&path).unwrap();
    let order: Vec<String> = conn
      .prepare("SELECT id FROM review_word ORDER BY ord")
      .unwrap()
      .query_map([], |row| row.get(0))
      .unwrap()
      .collect::<rusqlite::Result<Vec<_>>>()
      .unwrap();
    assert_eq!(order, ["rv:same@1#1", "rv:same@2#1", "rv:same@1#2", "rv:same@2#2"]);
    drop(conn);
    std::fs::remove_file(path).unwrap();
  }

  /// 040：笔记按词挂。重新导入（同 ID 重复导入、换了行号和 ID 的新一批）后笔记不丢、不错位、不重复。
  #[test]
  fn notes_survive_reimport_and_stay_on_the_same_word() {
    use crate::vocab::notes::{self, NoteAddRequest};
    let path = path();
    import_at(&path, request()).unwrap();
    let note = notes::add_at(&path, NoteAddRequest { word: " SAME ".into(), body: "两期共用的笔记".into(), source: "词库".into() }).unwrap();
    let phrase = notes::add_at(&path, NoteAddRequest { word: "Upgrade".into(), body: "升级库候选词的笔记".into(), source: "词库".into() }).unwrap();

    import_at(&path, request()).unwrap();
    let mut moved = request();
    moved.entries[0].id = "up:moved".into();
    moved.examples[0].entry_id = "up:moved".into();
    moved.self_checks[0].id = "sc:moved".into();
    for (index, word) in moved.review_words.iter_mut().enumerate() {
      word.id = format!("rv:moved{index}");
      word.line += 40;
    }
    import_at(&path, moved).unwrap();

    let all = notes::list_at(&path).unwrap();
    // 按键排序："same" 在 "upgrade" 前；内容、时间、ID 都和刚记下时一样。
    assert_eq!(all, vec![note.clone(), phrase]);
    // 复习库里 "Same"、"same" 两期、以及重新导入后的新行，归一化后都是同一个键。
    let conn = schema::open(&path).unwrap();
    let words: Vec<String> = conn.prepare("SELECT word FROM review_word ORDER BY ord").unwrap()
      .query_map([], |row| row.get(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    assert_eq!(words.len(), 4);
    assert!(words.iter().all(|word| notes::note_key(word) == note.word_key));
    // 导入不会碰笔记表的任何一列。
    let raw: (String, String, String) = conn.query_row(
      "SELECT body, created_at, updated_at FROM vocab_note WHERE id = ?1", [note.id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap();
    assert_eq!(raw, (note.body.clone(), note.created_at.clone(), note.updated_at.clone()));
    drop(conn);
    std::fs::remove_file(path).unwrap();
  }

  /// 043：例句也按词挂。重新导入（同 ID、换了 ID 和行号的新一批）后例句不丢、不重复，内容和时间不变。
  #[test]
  fn examples_survive_reimport_and_stay_on_the_same_word() {
    use crate::vocab::examples::{self, ExampleAddRequest, ExampleItem};
    let path = path();
    import_at(&path, request()).unwrap();
    let item = |sentence: &str, source: &str| ExampleItem { sentence: sentence.into(), source: source.into(), explanation: Some("说明".into()), sense: Some("义项".into()), original: None };
    let saved = examples::add_at(&path, ExampleAddRequest { word: " SAME ".into(), items: vec![item("The same idea came up twice.", "AI生成"), item("It is the same as before.", "自己写")] }).unwrap();
    let before = examples::list_at(&path).unwrap();
    assert_eq!(before.len(), 2);

    import_at(&path, request()).unwrap();
    let mut moved = request();
    moved.entries[0].id = "up:moved".into();
    moved.examples[0].entry_id = "up:moved".into();
    moved.self_checks[0].id = "sc:moved".into();
    for (index, word) in moved.review_words.iter_mut().enumerate() {
      word.id = format!("rv:moved{index}");
      word.line += 40;
    }
    import_at(&path, moved).unwrap();

    assert_eq!(examples::list_at(&path).unwrap(), before);
    let conn = schema::open(&path).unwrap();
    let words: Vec<String> = conn.prepare("SELECT word FROM review_word ORDER BY ord").unwrap()
      .query_map([], |row| row.get(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    assert!(words.iter().all(|word| crate::vocab::notes::note_key(word) == saved[0].word_key));
    drop(conn);
    std::fs::remove_file(path).unwrap();
  }

  /// 048：场景标签按句子文字存，重新导入（同 ID、换了 ID 和行号的新一批）后标签原样还在。
  #[test]
  fn scenes_survive_reimport() {
    use crate::vocab::scenes::{self, SceneItem, SceneSetRequest};
    let path = path();
    import_at(&path, request()).unwrap();
    let item = |s: &str, c: &str| SceneItem { sentence: s.into(), scene: c.into() };
    scenes::set_at(&path, SceneSetRequest { source: "AI".into(), items: vec![item("The same idea came up twice.", "statement")] }).unwrap();
    scenes::set_at(&path, SceneSetRequest { source: "手动".into(), items: vec![item("It is the same as before.", "comparison")] }).unwrap();
    let before = scenes::list_at(&path).unwrap();
    assert_eq!(before.len(), 2);

    import_at(&path, request()).unwrap();
    let mut moved = request();
    moved.entries[0].id = "up:moved".into();
    moved.examples[0].entry_id = "up:moved".into();
    moved.self_checks[0].id = "sc:moved".into();
    for (index, word) in moved.review_words.iter_mut().enumerate() {
      word.id = format!("rv:moved{index}");
      word.line += 40;
    }
    import_at(&path, moved).unwrap();

    assert_eq!(scenes::list_at(&path).unwrap(), before);
    std::fs::remove_file(path).unwrap();
  }

  #[test]
  fn preview_reads_v2_without_migrating_it() {
    let path = path();
    import_at(&path, request()).unwrap();
    let conn = schema::open(&path).unwrap();
    conn.execute("DROP TABLE review_log", []).unwrap();
    conn.pragma_update(None, "user_version", 2).unwrap();
    drop(conn);

    let mut changed = request();
    changed.review_words[0].note = "v2 file update".into();
    let preview = preview_at(&path, changed).unwrap();
    assert_eq!(preview.review_words, ReviewImportCounts { added: 0, updated: 1, skipped: 1, conflicts: 0 });
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i32>(0)).unwrap(), 2);
    drop(conn);
    std::fs::remove_file(path).unwrap();
  }

  #[test]
  fn rejects_orphan_examples_duplicate_ids_dates_status_and_level() {
    let path = path();
    let mut orphan = request();
    orphan.examples[0].entry_id = "up:missing".into();
    assert!(import_at(&path, orphan).unwrap_err().contains("不存在的词条"));

    let mut duplicate = request();
    duplicate.entries.push(duplicate.entries[0].clone());
    assert!(import_at(&path, duplicate).unwrap_err().contains("ID 重复"));

    let mut bad_date = request();
    bad_date.review_words[0].added_at = "2026-02-30".into();
    assert!(import_at(&path, bad_date).unwrap_err().contains("合法日期"));

    let mut bad_status = request();
    bad_status.review_words[0].status = "L9".into();
    bad_status.review_words[0].level = None;
    assert!(import_at(&path, bad_status).unwrap_err().contains("状态未知"));

    let mut bad_level = request();
    bad_level.review_words[0].level = Some(3);
    assert!(import_at(&path, bad_level).unwrap_err().contains("不一致"));
    assert!(!path.exists(), "校验失败连数据库文件都不应创建");
  }

  #[test]
  fn mid_transaction_failure_rolls_back_rows_and_runs() {
    let path = path();
    let conn = schema::open(&path).unwrap();
    conn
      .execute_batch(
        "CREATE TRIGGER stop_import_run BEFORE INSERT ON import_run
         BEGIN SELECT RAISE(ABORT, 'deliberate failure'); END;",
      )
      .unwrap();
    drop(conn);

    let error = import_at(&path, request()).unwrap_err();
    assert!(error.contains("deliberate failure"));
    assert_eq!(table_count(&path, "upgrade_entry"), 0);
    assert_eq!(table_count(&path, "upgrade_example"), 0);
    assert_eq!(table_count(&path, "review_word"), 0);
    assert_eq!(table_count(&path, "import_run"), 0);
    std::fs::remove_file(path).unwrap();
  }

  #[test]
  fn reopen_stats_and_source_hashes_match_saved_originals() {
    let path = path();
    let expected_upgrade_hash = sha256(&request().upgrade.content);
    let expected_review_hash = sha256(&request().review.content);
    let report = import_at(&path, request()).unwrap();
    assert_eq!(report.upgrade_sha256, expected_upgrade_hash);
    assert_eq!(report.review_sha256, expected_review_hash);

    let stats = stats_at(&path).unwrap();
    assert_eq!(stats, report.totals);
    let conn = schema::open(&path).unwrap();
    let saved: (String, String, String, String) = conn
      .query_row(
        "SELECT source_file, source_sha256, counts_json, warnings_json FROM import_run ORDER BY id LIMIT 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
      )
      .unwrap();
    assert_eq!(saved.0, "upgrade.md");
    assert_eq!(saved.1, expected_upgrade_hash);
    assert!(saved.2.contains("\"added\":1"));
    assert_eq!(saved.3, "[]");
    let raw: String = conn
      .query_row("SELECT raw FROM review_word WHERE id = 'rv:same@2#1'", [], |row| row.get(0))
      .unwrap();
    assert_eq!(raw, "| same | 2 | 2026-11-02 | 🌱待考察 | — | second |");
    drop(conn);
    std::fs::remove_file(path).unwrap();
  }

  #[test]
  fn missing_stats_db_is_not_created_and_parent_is_created_on_import() {
    let path = std::env::temp_dir()
      .join(format!("vocab-import-dir-{}", Uuid::new_v4()))
      .join("nested")
      .join("vocab.db");
    assert_eq!(stats_at(&path).unwrap(), VocabStats::default());
    assert!(!path.exists());
    import_at(&path, request()).unwrap();
    assert!(path.is_file());
    std::fs::remove_file(&path).unwrap();
  }
}
