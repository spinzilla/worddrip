use super::schema;
use chrono::{Local, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

const RED: &str = "🔴 在犯";
const YELLOW: &str = "🟡 已改善";
const GREEN: &str = "🟢 已掌握";
const SOURCE: &str = "作文批改";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoachArchiveItemInput {
  pub kind: String,
  pub written: String,
  pub correction: String,
  pub note: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoachArchiveRequest {
  pub review_id: String,
  pub essay: String,
  pub result_json: String,
  pub title: String,
  pub date: String,
  pub paper_type: String,
  pub word_count: i64,
  pub items: Vec<CoachArchiveItemInput>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoachTopChange {
  pub top_id: String,
  pub kind: String,
  pub is_new: bool,
  pub occurrences: i64,
  pub before_count: i64,
  pub after_count: i64,
  pub before_last_at: String,
  pub after_last_at: String,
  pub before_status: String,
  pub after_status: String,
  pub before_clean: i64,
  pub after_clean: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoachArchivePlan {
  pub review_id: String,
  pub batch_id: String,
  pub duplicate: bool,
  pub items_added: usize,
  pub top_changes: Vec<CoachTopChange>,
}

#[derive(Debug)]
struct TopRow {
  id: String,
  ord: i64,
  rank: i64,
  kind: String,
  count: i64,
  last_at: String,
  status: String,
  clean: i64,
}

fn validate(request: &CoachArchiveRequest) -> Result<(), String> {
  if request.review_id.trim().is_empty() || request.title.trim().is_empty() {
    return Err("归档编号和标题不能为空。".into());
  }
  if request.essay.trim().is_empty() {
    return Err("作文原文不能为空，未写入任何归档。".into());
  }
  if request.word_count < 0 {
    return Err("词数不能是负数。".into());
  }
  NaiveDate::parse_from_str(&request.date, "%Y-%m-%d")
    .map_err(|_| "归档日期必须是 YYYY-MM-DD。".to_string())?;
  let result: serde_json::Value = serde_json::from_str(&request.result_json)
    .map_err(|_| "批改结果不是有效 JSON，未写入任何归档。".to_string())?;
  if !result.is_object() {
    return Err("批改结果必须是 JSON 对象。".into());
  }
  if request.items.iter().any(|item| item.kind.trim().is_empty()) {
    return Err("每条错误都要选择或填写一个高频类别。".into());
  }
  Ok(())
}

fn batch_id(review_id: &str) -> String {
  format!("coach-batch:{review_id}")
}

fn read_existing_batch(conn: &Connection, review_id: &str) -> Result<Option<String>, String> {
  conn.query_row(
    "SELECT batch_id FROM coach_essay WHERE id = ?1",
    [review_id],
    |row| row.get(0),
  )
  .optional()
  .map_err(|error| format!("检查作文归档是否重复失败：{error}"))
}

fn occurrences(request: &CoachArchiveRequest) -> BTreeMap<String, i64> {
  let mut result = BTreeMap::new();
  for item in &request.items {
    *result.entry(item.kind.trim().to_string()).or_insert(0) += 1;
  }
  result
}

fn missed_status(status: &str, clean: i64) -> String {
  if clean < 3 || status.contains("已掌握") {
    return status.to_string();
  }
  if status.contains("已改善") { GREEN.into() } else { YELLOW.into() }
}

fn plan(conn: &Connection, request: &CoachArchiveRequest) -> Result<CoachArchivePlan, String> {
  validate(request)?;
  let id = batch_id(&request.review_id);
  if read_existing_batch(conn, &request.review_id)?.is_some() {
    return Ok(CoachArchivePlan {
      review_id: request.review_id.clone(),
      batch_id: id,
      duplicate: true,
      items_added: 0,
      top_changes: Vec::new(),
    });
  }

  let hits = occurrences(request);
  let mut stmt = conn.prepare(
    "SELECT t.id, t.ord, t.rank, t.kind, t.count, t.last_at, t.status,
            COALESCE(p.consecutive_clean, 0)
     FROM error_top t
     LEFT JOIN coach_top_progress p ON p.top_id = t.id
     ORDER BY t.ord, t.id",
  ).map_err(|error| format!("读取高频错误失败：{error}"))?;
  let rows = stmt.query_map([], |row| {
    let count_text: String = row.get(4)?;
    let count = count_text.parse::<i64>().map_err(|_| rusqlite::Error::FromSqlConversionFailure(
      4, rusqlite::types::Type::Text, Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, "count is not an integer")),
    ))?;
    Ok(TopRow {
      id: row.get(0)?, ord: row.get(1)?, rank: row.get(2)?, kind: row.get(3)?,
      count, last_at: row.get(5)?, status: row.get(6)?, clean: row.get(7)?,
    })
  }).map_err(|error| format!("读取高频错误失败：{error}"))?;
  let mut tops = Vec::new();
  for row in rows {
    let top = row.map_err(|error| format!("高频错误次数必须是非负整数：{error}"))?;
    if top.count < 0 || top.clean < 0 {
      return Err(format!("高频错误“{}”的计数或连续未犯次数无效。", top.kind));
    }
    tops.push(top);
  }

  let mut changes = Vec::new();
  for top in &tops {
    let occurred = hits.get(&top.kind).copied().unwrap_or(0);
    let after_clean = if occurred > 0 { 0 } else { top.clean + 1 };
    let after_status = if occurred > 0 { RED.into() } else { missed_status(&top.status, after_clean) };
    changes.push(CoachTopChange {
      top_id: top.id.clone(), kind: top.kind.clone(), is_new: false, occurrences: occurred,
      before_count: top.count, after_count: top.count + occurred,
      before_last_at: top.last_at.clone(),
      after_last_at: if occurred > 0 { request.date.clone() } else { top.last_at.clone() },
      before_status: top.status.clone(), after_status,
      before_clean: top.clean, after_clean,
    });
  }

  let existing_kinds: std::collections::BTreeSet<_> = tops.iter().map(|top| top.kind.as_str()).collect();
  for (index, (kind, occurred)) in hits.iter().filter(|(kind, _)| !existing_kinds.contains(kind.as_str())).enumerate() {
    changes.push(CoachTopChange {
      top_id: format!("coach-top:{}:{index}", request.review_id), kind: kind.clone(), is_new: true,
      occurrences: *occurred, before_count: 0, after_count: *occurred,
      before_last_at: String::new(), after_last_at: request.date.clone(),
      before_status: String::new(), after_status: RED.into(), before_clean: 0, after_clean: 0,
    });
  }
  Ok(CoachArchivePlan {
    review_id: request.review_id.clone(), batch_id: id, duplicate: false,
    items_added: request.items.len(), top_changes: changes,
  })
}

pub fn preview_at(path: &Path, request: CoachArchiveRequest) -> Result<CoachArchivePlan, String> {
  let conn = schema::open(path).map_err(|error| format!("打开词库数据库失败：{error}"))?;
  plan(&conn, &request)
}

pub fn archive_at(path: &Path, request: CoachArchiveRequest) -> Result<CoachArchivePlan, String> {
  let conn = schema::open(path).map_err(|error| format!("打开词库数据库失败：{error}"))?;
  let tx = conn.unchecked_transaction().map_err(|error| format!("开启作文归档事务失败：{error}"))?;
  let current = plan(&tx, &request)?;
  if current.duplicate {
    tx.commit().map_err(|error| format!("结束重复归档检查失败：{error}"))?;
    return Ok(current);
  }

  let batch_ord: i64 = tx.query_row("SELECT COALESCE(MAX(ord), 0) + 1 FROM error_batch", [], |row| row.get(0))
    .map_err(|error| format!("生成错误批次序号失败：{error}"))?;
  let metadata = serde_json::json!({"词数": request.word_count.to_string(), "卷面": request.paper_type, "来源": SOURCE});
  tx.execute(
    "INSERT INTO error_batch (id, ord, line, raw, title, date, metadata_json, source_file)
     VALUES (?1, ?2, 0, ?3, ?3, ?4, ?5, ?6)",
    params![current.batch_id, batch_ord, request.title, request.date, metadata.to_string(), SOURCE],
  ).map_err(|error| format!("写入错误批次失败，已全部回滚：{error}"))?;
  tx.execute(
    "INSERT INTO coach_essay (id, batch_id, original, result_json, paper_type, word_count, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    params![request.review_id, current.batch_id, request.essay, request.result_json, request.paper_type, request.word_count, Local::now().to_rfc3339()],
  ).map_err(|error| format!("保存作文和批改结果失败，已全部回滚：{error}"))?;

  for (index, item) in request.items.iter().enumerate() {
    let raw = format!("{} -> {}", item.written, item.correction);
    tx.execute(
      "INSERT INTO error_item (id, batch_id, ord, line, raw, question, kind, written, correction, note, source_file)
       VALUES (?1, ?2, ?3, 0, ?4, '', ?5, ?6, ?7, ?8, ?9)",
      params![format!("coach-item:{}:{index}", request.review_id), current.batch_id, index as i64 + 1,
        raw, item.kind.trim(), item.written, item.correction, item.note, SOURCE],
    ).map_err(|error| format!("写入第 {} 条错误失败，已全部回滚：{error}", index + 1))?;
  }
  for change in &current.top_changes {
    if change.is_new {
      let ord: i64 = tx.query_row("SELECT COALESCE(MAX(ord), 0) + 1 FROM error_top", [], |row| row.get(0))
        .map_err(|error| format!("生成高频错误序号失败：{error}"))?;
      let rank: i64 = tx.query_row("SELECT COALESCE(MAX(rank), 0) + 1 FROM error_top", [], |row| row.get(0))
        .map_err(|error| format!("生成高频错误排名失败：{error}"))?;
      let raw = format!("作文批改自动新增：{}", change.kind);
      tx.execute(
        "INSERT INTO error_top (id, ord, line, raw, rank, kind, count, last_at, status, source_file)
         VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![change.top_id, ord, raw, rank, change.kind, change.after_count.to_string(), change.after_last_at, change.after_status, SOURCE],
      ).map_err(|error| format!("新增高频错误“{}”失败，已全部回滚：{error}", change.kind))?;
    } else {
      // 铁律：只允许更新高频 Top 的计数、最近一次和状态；原始行等字段不动。
      tx.execute(
        "UPDATE error_top SET count = ?2, last_at = ?3, status = ?4 WHERE id = ?1",
        params![change.top_id, change.after_count.to_string(), change.after_last_at, change.after_status],
      ).map_err(|error| format!("更新高频错误“{}”失败，已全部回滚：{error}", change.kind))?;
    }
    tx.execute(
      "INSERT INTO coach_top_progress (top_id, consecutive_clean) VALUES (?1, ?2)
       ON CONFLICT(top_id) DO UPDATE SET consecutive_clean = excluded.consecutive_clean",
      params![change.top_id, change.after_clean],
    ).map_err(|error| format!("保存连续未犯计数失败，已全部回滚：{error}"))?;
  }
  tx.commit().map_err(|error| format!("提交作文归档失败，已全部回滚：{error}"))?;
  Ok(current)
}

#[cfg(test)]
mod tests {
  use super::*;
  use uuid::Uuid;

  fn path() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("vocab-coach-archive-{}.db", Uuid::new_v4()))
  }

  fn request(id: &str, kinds: &[&str]) -> CoachArchiveRequest {
    CoachArchiveRequest {
      review_id: id.into(), essay: "The original essay.".into(),
      result_json: serde_json::json!({"corrections": kinds}).to_string(),
      title: "2026-11-09 · 作文批改".into(), date: "2026-11-09".into(),
      paper_type: "通用学术写作".into(), word_count: 3,
      items: kinds.iter().enumerate().map(|(index, kind)| CoachArchiveItemInput {
        kind: (*kind).into(), written: format!("old {index}"), correction: format!("new {index}"), note: "说明".into(),
      }).collect(),
    }
  }

  fn seed_old(conn: &Connection) {
    conn.execute_batch(r#"
      INSERT INTO error_top (id, ord, line, raw, rank, kind, count, last_at, status, source_file)
      VALUES ('et:old', 7, 11, '旧 Top 原始行', 1, '主谓一致', '2', '2026-01-01', '🔴 反复犯', '旧来源');
      INSERT INTO error_batch (id, ord, line, raw, title, date, metadata_json, source_file)
      VALUES ('eb:old', 4, 22, '旧批次原始行', '旧批次', '2026-01-01', '{"保留":"逐字"}', '旧来源');
      INSERT INTO error_item (id, batch_id, ord, line, raw, question, kind, written, correction, note, source_file)
      VALUES ('ei:old', 'eb:old', 3, 33, '旧错误原始行', '旧题号', '主谓一致', '旧原文', '旧改法', '旧说明', '旧来源');
    "#).unwrap();
  }

  fn top_state(conn: &Connection) -> (String, String, String) {
    conn.query_row("SELECT count, last_at, status FROM error_top WHERE id = 'et:old'", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap()
  }
  fn old_rows(conn: &Connection) -> Vec<Vec<String>> {
    let mut result = Vec::new();
    for (sql, columns) in [
      ("SELECT CAST(ord AS TEXT), CAST(line AS TEXT), raw, CAST(rank AS TEXT), kind, source_file FROM error_top WHERE id = 'et:old'", 6),
      ("SELECT CAST(ord AS TEXT), CAST(line AS TEXT), raw, title, date, metadata_json, source_file FROM error_batch WHERE id = 'eb:old'", 7),
      ("SELECT CAST(ord AS TEXT), CAST(line AS TEXT), raw, question, kind, written, correction, note, source_file FROM error_item WHERE id = 'ei:old'", 9),
    ] {
      result.push(conn.query_row(sql, [], |row| Ok((0..columns).map(|i| row.get::<_, String>(i)).collect::<rusqlite::Result<Vec<_>>>())).unwrap().unwrap());
    }
    result
  }

  #[test]
  fn archive_appends_without_changing_old_rows_and_is_idempotent() {
    let path = path();
    let conn = schema::open(&path).unwrap();
    seed_old(&conn);
    let before = old_rows(&conn);
    drop(conn);
    let first = archive_at(&path, request("review-1", &["主谓一致", "拼写", "拼写"])).unwrap();
    assert_eq!(first.items_added, 3);
    let preview_change = first.top_changes.iter().find(|change| change.kind == "主谓一致").unwrap();
    assert_eq!((preview_change.before_count, preview_change.after_count), (2, 3));
    let second = archive_at(&path, request("review-1", &["主谓一致", "拼写", "拼写"])).unwrap();
    assert!(second.duplicate);
    assert_eq!(second.items_added, 0);
    let conn = schema::open(&path).unwrap();
    assert_eq!(old_rows(&conn), before, "旧批次和旧错误项以及旧 Top 原始字段必须逐字不变");
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM coach_essay", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM error_batch", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM error_item", [], |row| row.get::<_, i64>(0)).unwrap(), 4);
    let essay: (String, String) = conn.query_row("SELECT original, result_json FROM coach_essay", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    assert_eq!(essay.0, "The original essay.");
    assert!(essay.1.contains("主谓一致"));
    drop(conn);
    std::fs::remove_file(path).unwrap();
  }

  #[test]
  fn mid_archive_failure_rolls_back_essay_batch_items_and_top() {
    let path = path();
    let conn = schema::open(&path).unwrap();
    seed_old(&conn);
    conn.execute_batch("CREATE TRIGGER stop_coach_progress BEFORE INSERT ON coach_top_progress BEGIN SELECT RAISE(ABORT, 'deliberate archive failure'); END;").unwrap();
    let before = old_rows(&conn);
    let before_state = top_state(&conn);
    drop(conn);
    let error = archive_at(&path, request("review-rollback", &["主谓一致", "拼写"])).unwrap_err();
    assert!(error.contains("deliberate archive failure"));
    let conn = schema::open(&path).unwrap();
    assert_eq!(old_rows(&conn), before);
    assert_eq!(top_state(&conn), before_state);
    for table in ["coach_essay", "coach_top_progress"] {
      assert_eq!(conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM error_batch", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM error_top", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    drop(conn);
    std::fs::remove_file(path).unwrap();
  }

  #[test]
  fn a91_three_clean_reviews_move_red_to_yellow_then_yellow_to_green() {
    let path = path();
    let conn = schema::open(&path).unwrap();
    seed_old(&conn);
    drop(conn);
    for index in 0..2 {
      let result = archive_at(&path, request(&format!("clean-{index}"), &[])).unwrap();
      let change = &result.top_changes[0];
      assert_eq!(change.after_clean, index + 1);
      assert_eq!(change.after_status, "🔴 反复犯");
      assert_eq!(change.after_count, 2);
      assert_eq!(change.after_last_at, "2026-01-01");
    }
    let third = archive_at(&path, request("clean-2", &[])).unwrap();
    assert_eq!(third.top_changes[0].after_clean, 3);
    assert_eq!(third.top_changes[0].after_status, YELLOW);
    for index in 3..5 {
      archive_at(&path, request(&format!("clean-{index}"), &[])).unwrap();
    }
    let sixth = archive_at(&path, request("clean-5", &[])).unwrap();
    assert_eq!(sixth.top_changes[0].after_clean, 6);
    assert_eq!(sixth.top_changes[0].after_status, GREEN);
    let recurrence = archive_at(&path, request("again", &["主谓一致"])).unwrap();
    assert_eq!(recurrence.top_changes[0].after_clean, 0);
    assert_eq!(recurrence.top_changes[0].after_status, RED);
    assert_eq!(recurrence.top_changes[0].after_count, 3);
    assert_eq!(recurrence.top_changes[0].after_last_at, "2026-11-09");
    std::fs::remove_file(path).unwrap();
  }

  #[test]
  fn preview_matches_write_and_new_category_is_marked() {
    let path = path();
    let preview = preview_at(&path, request("same", &["搭配", "搭配"])).unwrap();
    assert!(preview.top_changes[0].is_new);
    assert_eq!((preview.top_changes[0].before_count, preview.top_changes[0].after_count), (0, 2));
    let actual = archive_at(&path, request("same", &["搭配", "搭配"])).unwrap();
    assert_eq!(preview, actual);
    std::fs::remove_file(path).unwrap();
  }

  #[test]
  fn migrating_v4_preserves_old_archive_data() {
    let path = path();
    let conn = schema::open(&path).unwrap();
    seed_old(&conn);
    // 回到 v4 的表结构，再让正式入口升级；旧行内容必须原样保留。
    conn.execute_batch("DROP TABLE quick_note; DROP TABLE example_scene; DROP TABLE vocab_example; DROP TABLE vocab_note; DROP TABLE review_event; DROP TABLE review_definition_example; DROP TABLE review_definition; DROP TABLE coach_essay; DROP TABLE coach_top_progress; PRAGMA user_version = 4;").unwrap();
    let before = old_rows(&conn);
    let before_state = top_state(&conn);
    drop(conn);
    let conn = schema::open(&path).unwrap();
    assert_eq!(conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i32>(0)).unwrap(), schema::SCHEMA_VERSION);
    assert_eq!(old_rows(&conn), before);
    assert_eq!(top_state(&conn), before_state);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM coach_essay", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    drop(conn);
    std::fs::remove_file(path).unwrap();
  }
}