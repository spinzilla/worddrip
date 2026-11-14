//! 055 随手记：任何页面按 Ctrl+J 记一句话，存的时候带上「当时在看什么」。
//!
//! - 单独一张表 `quick_note`，不碰别的表。
//! - 上下文类型 `ctx_kind`：none（没有）/ video（看视频）/ dictation（听写）/ entry（词库词条）。
//! - 状态：待整理（默认）/ 已整理；去向 `destination` 本卡先留空，056 整理时填。
//! - `device_id` 给以后同步用，本卡固定写本机的值 [`DEVICE_ID`]。

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::path::Path;

use super::schema;

pub const KINDS: [&str; 4] = ["none", "video", "dictation", "entry"];
pub const STATUSES: [&str; 2] = ["待整理", "已整理"];
pub const DEVICE_ID: &str = "local";
pub const MAX_BODY_CHARS: usize = 4000;
const MAX_CTX_CHARS: usize = 600;
const MAX_DEST_CHARS: usize = 200;

/// 记下时的上下文。kind = none 时其余字段都会被丢掉。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct QuickNoteContext {
  pub kind: String,
  pub text: Option<String>,
  pub video_id: Option<String>,
  pub video_name: Option<String>,
  pub time: Option<f64>,
  pub entry_id: Option<String>,
  pub word: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuickNote {
  pub id: i64,
  pub body: String,
  pub created_at: String,
  pub updated_at: String,
  pub context: QuickNoteContext,
  pub status: String,
  pub destination: Option<String>,
  pub device_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickNoteAddRequest {
  pub body: String,
  pub context: Option<QuickNoteContext>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickNoteUpdateRequest {
  pub id: i64,
  pub body: String,
}

/// 标记状态；destination 为 None 表示不改去向，Some("") 表示清空去向。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickNoteMarkRequest {
  pub id: i64,
  pub status: String,
  pub destination: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickNoteDeleteRequest {
  pub id: i64,
}

fn now() -> String {
  Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn clean_body(body: &str) -> Result<String, String> {
  let body = body.replace("\r\n", "\n").replace('\r', "\n");
  let body = body.trim();
  if body.is_empty() {
    return Err("随手记内容是空的，没有保存".into());
  }
  if body.chars().count() > MAX_BODY_CHARS {
    return Err(format!("随手记太长了（超过 {MAX_BODY_CHARS} 字），请分成几条记"));
  }
  Ok(body.to_string())
}

/// 文字类上下文：去首尾空白，空的当没有，太长的截断（不报错：上下文是附带的，不该挡住用户的正文）。
fn clean_ctx(value: &Option<String>, max: usize) -> Option<String> {
  let text = value.as_deref()?.split_whitespace().collect::<Vec<_>>().join(" ");
  if text.is_empty() {
    return None;
  }
  Some(text.chars().take(max).collect())
}

fn clean_context(context: &Option<QuickNoteContext>) -> Result<QuickNoteContext, String> {
  let Some(ctx) = context else { return Ok(QuickNoteContext { kind: "none".into(), ..Default::default() }) };
  if !KINDS.contains(&ctx.kind.as_str()) {
    return Err(format!("未知的上下文类型：{}；只能是 {}", ctx.kind, KINDS.join("、")));
  }
  if ctx.kind == "none" {
    return Ok(QuickNoteContext { kind: "none".into(), ..Default::default() });
  }
  let time = ctx.time.filter(|t| t.is_finite() && *t >= 0.0);
  Ok(QuickNoteContext {
    kind: ctx.kind.clone(),
    text: clean_ctx(&ctx.text, MAX_CTX_CHARS),
    video_id: clean_ctx(&ctx.video_id, 200),
    video_name: clean_ctx(&ctx.video_name, 300),
    time,
    entry_id: clean_ctx(&ctx.entry_id, 300),
    word: clean_ctx(&ctx.word, 300),
  })
}

const SELECT: &str = "SELECT id, body, created_at, updated_at, ctx_kind, ctx_text, ctx_video_id, ctx_video_name, ctx_time, ctx_entry_id, ctx_word, status, destination, device_id FROM quick_note";

fn row_to_note(row: &rusqlite::Row<'_>) -> rusqlite::Result<QuickNote> {
  Ok(QuickNote {
    id: row.get(0)?,
    body: row.get(1)?,
    created_at: row.get(2)?,
    updated_at: row.get(3)?,
    context: QuickNoteContext {
      kind: row.get(4)?,
      text: row.get(5)?,
      video_id: row.get(6)?,
      video_name: row.get(7)?,
      time: row.get(8)?,
      entry_id: row.get(9)?,
      word: row.get(10)?,
    },
    status: row.get(11)?,
    destination: row.get(12)?,
    device_id: row.get(13)?,
  })
}

fn get(conn: &Connection, id: i64) -> Result<QuickNote, String> {
  conn.query_row(&format!("{SELECT} WHERE id = ?1"), params![id], row_to_note).map_err(|error| match error {
    rusqlite::Error::QueryReturnedNoRows => "这条随手记不存在（可能已经删掉了）".to_string(),
    other => format!("读取随手记失败：{other}"),
  })
}

fn open_rw(path: &Path) -> Result<Connection, String> {
  schema::open(path).map_err(|error| format!("打开词库数据库失败：{error}"))
}

/// 只读列出：按时间倒序（新的在前），可按状态筛选。库不存在返回空（不建库）。
pub fn list_at(path: &Path, status: Option<&str>) -> Result<Vec<QuickNote>, String> {
  if !path.exists() {
    return Ok(Vec::new());
  }
  let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
    .map_err(|error| format!("只读打开词库数据库失败：{error}"))?;
  list_from_conn(&conn, status)
}

pub fn list_from_conn(conn: &Connection, status: Option<&str>) -> Result<Vec<QuickNote>, String> {
  let version: i32 = conn
    .query_row("PRAGMA user_version", [], |row| row.get(0))
    .map_err(|error| format!("读取数据库版本失败：{error}"))?;
  if version == 0 {
    return Ok(Vec::new());
  }
  if version != schema::SCHEMA_VERSION {
    return Err(format!("词库数据库版本 {version} 与本应用支持的版本 {} 不兼容，已停止读取", schema::SCHEMA_VERSION));
  }
  if let Some(status) = status {
    if !STATUSES.contains(&status) {
      return Err(format!("未知的状态：{status}；只能是 {}", STATUSES.join("、")));
    }
  }
  let mut stmt = conn
    .prepare(&format!("{SELECT} WHERE (?1 IS NULL OR status = ?1) ORDER BY created_at DESC, id DESC"))
    .map_err(|error| format!("读取随手记失败：{error}"))?;
  let rows = stmt.query_map(params![status], row_to_note).map_err(|error| format!("读取随手记失败：{error}"))?;
  rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|error| format!("读取随手记失败：{error}"))
}

pub fn add_at(path: &Path, request: QuickNoteAddRequest) -> Result<QuickNote, String> {
  let conn = open_rw(path)?;
  add_with_time(&conn, request, &now())
}

pub fn add_with_time(conn: &Connection, request: QuickNoteAddRequest, now: &str) -> Result<QuickNote, String> {
  let body = clean_body(&request.body)?;
  let ctx = clean_context(&request.context)?;
  conn
    .execute(
      "INSERT INTO quick_note (body, created_at, updated_at, ctx_kind, ctx_text, ctx_video_id, ctx_video_name, ctx_time, ctx_entry_id, ctx_word, status, device_id)
       VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '待整理', ?10)",
      params![body, now, ctx.kind, ctx.text, ctx.video_id, ctx.video_name, ctx.time, ctx.entry_id, ctx.word, DEVICE_ID],
    )
    .map_err(|error| format!("保存随手记失败：{error}"))?;
  get(conn, conn.last_insert_rowid())
}

pub fn update_at(path: &Path, request: QuickNoteUpdateRequest) -> Result<QuickNote, String> {
  let conn = open_rw(path)?;
  update_with_time(&conn, request, &now())
}

/// 只改正文和更新时间。
pub fn update_with_time(conn: &Connection, request: QuickNoteUpdateRequest, now: &str) -> Result<QuickNote, String> {
  let body = clean_body(&request.body)?;
  let changed = conn
    .execute("UPDATE quick_note SET body = ?2, updated_at = ?3 WHERE id = ?1", params![request.id, body, now])
    .map_err(|error| format!("保存随手记失败：{error}"))?;
  if changed == 0 {
    return Err("这条随手记不存在（可能已经删掉了），没有保存".into());
  }
  get(conn, request.id)
}

pub fn mark_at(path: &Path, request: QuickNoteMarkRequest) -> Result<QuickNote, String> {
  let conn = open_rw(path)?;
  mark_with_time(&conn, request, &now())
}

pub fn mark_with_time(conn: &Connection, request: QuickNoteMarkRequest, now: &str) -> Result<QuickNote, String> {
  if !STATUSES.contains(&request.status.as_str()) {
    return Err(format!("未知的状态：{}；只能是 {}", request.status, STATUSES.join("、")));
  }
  let changed = match request.destination.as_deref() {
    None => conn.execute("UPDATE quick_note SET status = ?2, updated_at = ?3 WHERE id = ?1", params![request.id, request.status, now]),
    Some(dest) => {
      let dest = dest.split_whitespace().collect::<Vec<_>>().join(" ");
      if dest.chars().count() > MAX_DEST_CHARS {
        return Err(format!("去向太长了（超过 {MAX_DEST_CHARS} 字）"));
      }
      let dest = if dest.is_empty() { None } else { Some(dest) };
      conn.execute("UPDATE quick_note SET status = ?2, destination = ?3, updated_at = ?4 WHERE id = ?1", params![request.id, request.status, dest, now])
    }
  }
  .map_err(|error| format!("保存随手记失败：{error}"))?;
  if changed == 0 {
    return Err("这条随手记不存在（可能已经删掉了），没有保存".into());
  }
  get(conn, request.id)
}

pub fn delete_at(path: &Path, request: QuickNoteDeleteRequest) -> Result<i64, String> {
  let conn = open_rw(path)?;
  delete_in(&conn, request)
}

pub fn delete_in(conn: &Connection, request: QuickNoteDeleteRequest) -> Result<i64, String> {
  let changed = conn
    .execute("DELETE FROM quick_note WHERE id = ?1", params![request.id])
    .map_err(|error| format!("删除随手记失败：{error}"))?;
  if changed == 0 {
    return Err("这条随手记不存在（可能已经删掉了）".into());
  }
  Ok(request.id)
}

#[cfg(test)]
mod tests {
  use super::*;
  use uuid::Uuid;

  fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    schema::migrate(&conn).unwrap();
    conn
  }

  fn add(conn: &Connection, body: &str, ctx: Option<QuickNoteContext>, at: &str) -> QuickNote {
    add_with_time(conn, QuickNoteAddRequest { body: body.into(), context: ctx }, at).unwrap()
  }

  fn video_ctx() -> QuickNoteContext {
    QuickNoteContext { kind: "video".into(), text: Some("  It was  a   good day. ".into()), video_id: Some("v1".into()), video_name: Some("Demo".into()), time: Some(192.5), ..Default::default() }
  }

  #[test]
  fn add_without_context_defaults_to_none_pending_and_local_device() {
    let conn = db();
    let note = add(&conn, "  记一句\r\n第二行  ", None, "t1");
    assert_eq!(note.body, "记一句\n第二行");
    assert_eq!(note.context.kind, "none");
    assert_eq!((note.status.as_str(), note.destination.clone(), note.device_id.as_str()), ("待整理", None, DEVICE_ID));
    assert_eq!((note.created_at.as_str(), note.updated_at.as_str()), ("t1", "t1"));
  }

  #[test]
  fn add_keeps_context_cleaned_and_drops_it_for_none() {
    let conn = db();
    let note = add(&conn, "看视频时记的", Some(video_ctx()), "t1");
    assert_eq!(note.context.kind, "video");
    assert_eq!(note.context.text.as_deref(), Some("It was a good day."));
    assert_eq!(note.context.time, Some(192.5));
    assert_eq!(note.context.video_name.as_deref(), Some("Demo"));
    let entry = add(&conn, "词条", Some(QuickNoteContext { kind: "entry".into(), entry_id: Some("mitigate".into()), word: Some("mitigate".into()), ..Default::default() }), "t2");
    assert_eq!((entry.context.entry_id.as_deref(), entry.context.word.as_deref()), (Some("mitigate"), Some("mitigate")));
    let none = add(&conn, "无", Some(QuickNoteContext { kind: "none".into(), text: Some("不该存".into()), time: Some(3.0), ..Default::default() }), "t3");
    assert_eq!(none.context, QuickNoteContext { kind: "none".into(), ..Default::default() });
  }

  #[test]
  fn rejects_blank_too_long_and_bad_input_without_writing() {
    let conn = db();
    let bad = |body: &str, ctx: Option<QuickNoteContext>| add_with_time(&conn, QuickNoteAddRequest { body: body.into(), context: ctx }, "t").unwrap_err();
    assert!(bad(" \n\t ", None).contains("空"));
    assert!(bad(&"a".repeat(MAX_BODY_CHARS + 1), None).contains("太长"));
    assert!(bad("x", Some(QuickNoteContext { kind: "audio".into(), ..Default::default() })).contains("未知的上下文类型"));
    assert!(list_from_conn(&conn, None).unwrap().is_empty());
  }

  #[test]
  fn list_is_newest_first_and_filters_by_status() {
    let conn = db();
    let a = add(&conn, "最早", None, "2026-11-01T00:00:00.000Z");
    let b = add(&conn, "中间", Some(video_ctx()), "2026-11-02T00:00:00.000Z");
    let c = add(&conn, "最新", None, "2026-11-03T00:00:00.000Z");
    mark_with_time(&conn, QuickNoteMarkRequest { id: b.id, status: "已整理".into(), destination: Some("笔记 · mitigate".into()) }, "t").unwrap();
    let all: Vec<_> = list_from_conn(&conn, None).unwrap().into_iter().map(|n| n.id).collect();
    assert_eq!(all, [c.id, b.id, a.id]);
    let pending: Vec<_> = list_from_conn(&conn, Some("待整理")).unwrap().into_iter().map(|n| n.id).collect();
    assert_eq!(pending, [c.id, a.id]);
    let done = list_from_conn(&conn, Some("已整理")).unwrap();
    assert_eq!((done.len(), done[0].id), (1, b.id));
    assert!(list_from_conn(&conn, Some("随便")).unwrap_err().contains("未知的状态"));
  }

  #[test]
  fn update_changes_only_body_and_time() {
    let conn = db();
    let note = add(&conn, "旧", Some(video_ctx()), "t1");
    let updated = update_with_time(&conn, QuickNoteUpdateRequest { id: note.id, body: " 新正文 ".into() }, "t2").unwrap();
    assert_eq!((updated.body.as_str(), updated.created_at.as_str(), updated.updated_at.as_str()), ("新正文", "t1", "t2"));
    assert_eq!(updated.context, note.context);
    assert!(update_with_time(&conn, QuickNoteUpdateRequest { id: note.id, body: "  ".into() }, "t3").unwrap_err().contains("空"));
    assert!(update_with_time(&conn, QuickNoteUpdateRequest { id: 9999, body: "x".into() }, "t3").unwrap_err().contains("不存在"));
    assert_eq!(list_from_conn(&conn, None).unwrap()[0].body, "新正文");
  }

  #[test]
  fn mark_sets_status_and_optional_destination() {
    let conn = db();
    let note = add(&conn, "x", None, "t1");
    // 不传 destination：只改状态。
    let done = mark_with_time(&conn, QuickNoteMarkRequest { id: note.id, status: "已整理".into(), destination: None }, "t2").unwrap();
    assert_eq!((done.status.as_str(), done.destination.clone()), ("已整理", None));
    let routed = mark_with_time(&conn, QuickNoteMarkRequest { id: note.id, status: "已整理".into(), destination: Some(" 例句  mitigate ".into()) }, "t3").unwrap();
    assert_eq!(routed.destination.as_deref(), Some("例句 mitigate"));
    // 不传 destination 不会清掉已有去向；传空串才清。
    let keep = mark_with_time(&conn, QuickNoteMarkRequest { id: note.id, status: "待整理".into(), destination: None }, "t4").unwrap();
    assert_eq!((keep.status.as_str(), keep.destination.as_deref()), ("待整理", Some("例句 mitigate")));
    let cleared = mark_with_time(&conn, QuickNoteMarkRequest { id: note.id, status: "待整理".into(), destination: Some("".into()) }, "t5").unwrap();
    assert_eq!(cleared.destination, None);
    assert!(mark_with_time(&conn, QuickNoteMarkRequest { id: note.id, status: "完成".into(), destination: None }, "t6").unwrap_err().contains("未知的状态"));
    assert!(mark_with_time(&conn, QuickNoteMarkRequest { id: 9999, status: "已整理".into(), destination: None }, "t6").unwrap_err().contains("不存在"));
  }

  #[test]
  fn delete_removes_one_and_reports_missing() {
    let conn = db();
    let a = add(&conn, "a", None, "t1");
    let b = add(&conn, "b", None, "t2");
    assert_eq!(delete_in(&conn, QuickNoteDeleteRequest { id: a.id }).unwrap(), a.id);
    assert_eq!(list_from_conn(&conn, None).unwrap().iter().map(|n| n.id).collect::<Vec<_>>(), [b.id]);
    assert!(delete_in(&conn, QuickNoteDeleteRequest { id: a.id }).unwrap_err().contains("不存在"));
  }

  #[test]
  fn does_not_touch_other_tables_and_survives_reopen() {
    let path = std::env::temp_dir().join(format!("vocab-quicknote-{}.db", Uuid::new_v4()));
    assert!(list_at(&path, None).unwrap().is_empty());
    assert!(!path.exists());
    let saved = add_at(&path, QuickNoteAddRequest { body: "存一条".into(), context: Some(video_ctx()) }).unwrap();
    assert!(chrono::DateTime::parse_from_rfc3339(&saved.created_at).is_ok());
    let before = std::fs::read(&path).unwrap();
    assert_eq!(list_at(&path, None).unwrap(), vec![saved.clone()]);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    let conn = Connection::open(&path).unwrap();
    for table in ["review_word", "vocab_note", "vocab_example", "example_scene"] {
      assert_eq!(conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get::<_, i64>(0)).unwrap(), 0, "{table}");
    }
    drop(conn);
    std::fs::remove_file(&path).unwrap();
  }
}
