//! 040 词条笔记：用户自己给词或短语记的笔记。
//!
//! - 单独一张表 `vocab_note`，不写、不改复习库/升级库原有的「备注」列。
//! - 按词挂：`word_key` = 归一化后的词（规则见 [`note_key`]），不引用任何行 ID，
//!   所以同一个词在复习库多期、升级库候选里出现，看到的都是同一组；重新导入后也不丢、不错位。
//! - 只在用户的电脑上存着，出题、判分、批改都不读这张表（不发给模型）。

use chrono::{DateTime, Local, SecondsFormat, Utc};
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

use super::schema;

/// 笔记从哪里记的。本卡界面只产生「词库」；后三种留给 041（复习、首考、闪卡里的按钮）。
pub const NOTE_SOURCES: [&str; 4] = ["词库", "复习", "首考", "闪卡"];

/// 一条笔记最多多少字（防误粘贴整本书进来）。
pub const MAX_NOTE_CHARS: usize = 4000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VocabNote {
  pub id: i64,
  pub word_key: String,
  pub word: String,
  pub body: String,
  pub source: String,
  pub created_at: String,
  pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteAddRequest {
  pub word: String,
  pub body: String,
  pub source: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpdateRequest {
  pub id: i64,
  pub body: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDeleteRequest {
  pub id: i64,
}

/// 归一化规则（和前端 `utils/vocab/library.ts` 的 `normalizeText` 一致）：
/// 去掉 Markdown 加粗记号 `**`，弯撇号 ’‘ 换成直撇号 '，连续空白（含换行、全角空格）合成一个空格，
/// 去首尾空白，转小写。短语按整段算（`In the light of` 和 `in  the light of` 是同一个键）。
pub fn note_key(word: &str) -> String {
  word
    .replace("**", "")
    .replace(['’', '‘'], "'")
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ")
    .to_lowercase()
}

fn clean_body(body: &str) -> Result<String, String> {
  // 保留中间的换行和缩进，只去掉首尾空行/空白；统一成 \n 换行。
  let body = body.replace("\r\n", "\n").replace('\r', "\n");
  let body = body.trim();
  if body.is_empty() {
    return Err("笔记内容是空的，没有保存".into());
  }
  if body.chars().count() > MAX_NOTE_CHARS {
    return Err(format!("笔记太长了（超过 {MAX_NOTE_CHARS} 字），请分成几条记"));
  }
  Ok(body.to_string())
}

fn now() -> String {
  Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn open_rw(path: &Path) -> Result<Connection, String> {
  schema::open(path).map_err(|error| format!("打开词库数据库失败：{error}"))
}

const SELECT: &str = "SELECT id, word_key, word, body, source, created_at, updated_at FROM vocab_note";

fn row_to_note(row: &rusqlite::Row<'_>) -> rusqlite::Result<VocabNote> {
  Ok(VocabNote {
    id: row.get(0)?,
    word_key: row.get(1)?,
    word: row.get(2)?,
    body: row.get(3)?,
    source: row.get(4)?,
    created_at: row.get(5)?,
    updated_at: row.get(6)?,
  })
}

fn get(conn: &Connection, id: i64) -> Result<VocabNote, String> {
  conn
    .query_row(&format!("{SELECT} WHERE id = ?1"), params![id], row_to_note)
    .map_err(|error| match error {
      rusqlite::Error::QueryReturnedNoRows => "这条笔记不存在（可能已经删掉了）".to_string(),
      other => format!("读取笔记失败：{other}"),
    })
}

/// 只读列出全部笔记：同一个词的放一起，新的在前。库不存在返回空（不建库）。
pub fn list_at(path: &Path) -> Result<Vec<VocabNote>, String> {
  if !path.exists() {
    return Ok(Vec::new());
  }
  let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
    .map_err(|error| format!("只读打开词库数据库失败：{error}"))?;
  list_from_conn(&conn)
}

pub fn list_from_conn(conn: &Connection) -> Result<Vec<VocabNote>, String> {
  let version: i32 = conn
    .query_row("PRAGMA user_version", [], |row| row.get(0))
    .map_err(|error| format!("读取数据库版本失败：{error}"))?;
  if version == 0 {
    return Ok(Vec::new());
  }
  if version != schema::SCHEMA_VERSION {
    return Err(format!(
      "词库数据库版本 {version} 与本应用支持的版本 {} 不兼容，已停止读取",
      schema::SCHEMA_VERSION
    ));
  }
  let mut stmt = conn
    .prepare(&format!("{SELECT} ORDER BY word_key, created_at DESC, id DESC"))
    .map_err(|error| format!("读取笔记失败：{error}"))?;
  let rows = stmt.query_map([], row_to_note).map_err(|error| format!("读取笔记失败：{error}"))?;
  rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|error| format!("读取笔记失败：{error}"))
}

pub fn add_at(path: &Path, request: NoteAddRequest) -> Result<VocabNote, String> {
  let conn = open_rw(path)?;
  add_with_time(&conn, request, &now())
}

pub fn add_with_time(conn: &Connection, request: NoteAddRequest, now: &str) -> Result<VocabNote, String> {
  if !NOTE_SOURCES.contains(&request.source.as_str()) {
    return Err(format!("未知的笔记来源：{}；只能是 {}", request.source, NOTE_SOURCES.join("、")));
  }
  let key = note_key(&request.word);
  if key.is_empty() {
    return Err("没有指定给哪个词记笔记".into());
  }
  let body = clean_body(&request.body)?;
  let word = request.word.split_whitespace().collect::<Vec<_>>().join(" ").replace("**", "");
  conn
    .execute(
      "INSERT INTO vocab_note (word_key, word, body, source, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
      params![key, word, body, request.source, now],
    )
    .map_err(|error| format!("保存笔记失败：{error}"))?;
  get(conn, conn.last_insert_rowid())
}

pub fn update_at(path: &Path, request: NoteUpdateRequest) -> Result<VocabNote, String> {
  let conn = open_rw(path)?;
  update_with_time(&conn, request, &now())
}

/// 只改正文和修改时间；词、来源、创建时间不变。
pub fn update_with_time(conn: &Connection, request: NoteUpdateRequest, now: &str) -> Result<VocabNote, String> {
  let body = clean_body(&request.body)?;
  let changed = conn
    .execute(
      "UPDATE vocab_note SET body = ?2, updated_at = ?3 WHERE id = ?1",
      params![request.id, body, now],
    )
    .map_err(|error| format!("保存笔记失败：{error}"))?;
  if changed == 0 {
    return Err("这条笔记不存在（可能已经删掉了），没有保存".into());
  }
  get(conn, request.id)
}

pub fn delete_at(path: &Path, request: NoteDeleteRequest) -> Result<i64, String> {
  let conn = open_rw(path)?;
  delete_in(&conn, request)
}

pub fn delete_in(conn: &Connection, request: NoteDeleteRequest) -> Result<i64, String> {
  let changed = conn
    .execute("DELETE FROM vocab_note WHERE id = ?1", params![request.id])
    .map_err(|error| format!("删除笔记失败：{error}"))?;
  if changed == 0 {
    return Err("这条笔记不存在（可能已经删掉了）".into());
  }
  Ok(request.id)
}

/// 导出用的本地时间（精确到分钟）；解析不了就原样给出。
pub(crate) fn display_time(stamp: &str) -> String {
  DateTime::parse_from_rfc3339(stamp)
    .map(|time| time.with_timezone(&Local).format("%Y-%m-%d %H:%M").to_string())
    .unwrap_or_else(|_| stamp.to_string())
}

/// 导出成 `我的笔记.md`：按词分组（词按字母序），组内新的在前，每条带日期和来源。
/// 没有笔记返回 None（不写文件）。正文多行时，续行缩进两格，留在同一个列表项里。
pub fn render_markdown(notes: &[VocabNote]) -> Option<String> {
  if notes.is_empty() {
    return None;
  }
  let mut groups: BTreeMap<&str, Vec<&VocabNote>> = BTreeMap::new();
  for note in notes {
    groups.entry(note.word_key.as_str()).or_default().push(note);
  }
  let mut lines = vec![
    "# 我的笔记".to_string(),
    String::new(),
    format!("共 {} 个词、{} 条笔记。按词分组，新的在前。", groups.len(), notes.len()),
  ];
  for list in groups.values_mut() {
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    // 标题用最早那条记下时的写法（保留大小写），比全小写的键好读。
    let title = list.iter().min_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id))).map(|n| n.word.as_str()).unwrap_or("");
    lines.push(String::new());
    lines.push(format!("## {title}"));
    lines.push(String::new());
    for note in list.iter() {
      let mut meta = format!("{} · {}", display_time(&note.created_at), note.source);
      if note.updated_at != note.created_at {
        meta.push_str(&format!(" · 改于 {}", display_time(&note.updated_at)));
      }
      lines.push(format!("- {meta}"));
      for line in note.body.lines() {
        lines.push(if line.is_empty() { String::new() } else { format!("  {line}") });
      }
    }
  }
  lines.push(String::new());
  Some(lines.join("\n"))
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

  fn add(conn: &Connection, word: &str, body: &str, time: &str) -> VocabNote {
    add_with_time(conn, NoteAddRequest { word: word.into(), body: body.into(), source: "词库".into() }, time).unwrap()
  }

  /// 前端 test-vocab-notes.mjs 用同一张表核对 normalizeText，两边规则必须一致。
  const KEY_CASES: [(&str, &str); 7] = [
    ("Resilient", "resilient"),
    ("  resilient \n", "resilient"),
    ("In  the Light\tof", "in the light of"),
    ("**exacerbate**", "exacerbate"),
    ("students’ work", "students' work"),
    ("It is X that …", "it is x that …"),
    ("\u{3000}take part\u{3000}in ", "take part in"),
  ];

  #[test]
  fn key_ignores_case_outer_space_and_collapses_inner_space() {
    for (input, expected) in KEY_CASES {
      assert_eq!(note_key(input), expected, "{input:?}");
    }
  }

  #[test]
  fn add_list_update_delete_round_trip() {
    let conn = db();
    let first = add(&conn, " Resilient ", "第一条\n\n  第二行缩进 resilient economy", "2026-11-10T01:00:00.000Z");
    assert_eq!(first.word_key, "resilient");
    assert_eq!(first.word, "Resilient");
    assert_eq!(first.body, "第一条\n\n  第二行缩进 resilient economy");
    assert_eq!(first.source, "词库");
    assert_eq!(first.created_at, first.updated_at);
    // 不同写法的同一个词进同一组
    let second = add(&conn, "RESILIENT", "第二条", "2026-11-10T02:00:00.000Z");
    let other = add(&conn, "in the light of", "短语笔记", "2026-11-10T03:00:00.000Z");

    let all = list_from_conn(&conn).unwrap();
    let ids: Vec<_> = all.iter().map(|n| n.id).collect();
    // 先按键排，同键新的在前
    assert_eq!(ids, [other.id, second.id, first.id]);

    let updated = update_with_time(&conn, NoteUpdateRequest { id: first.id, body: "  改过的\r\n第二行  ".into() }, "2026-11-10T05:00:00.000Z").unwrap();
    assert_eq!(updated.body, "改过的\n第二行");
    assert_eq!(updated.created_at, first.created_at);
    assert_eq!(updated.updated_at, "2026-11-10T05:00:00.000Z");
    assert_eq!(updated.word_key, first.word_key);
    assert_eq!(updated.source, first.source);

    assert_eq!(delete_in(&conn, NoteDeleteRequest { id: second.id }).unwrap(), second.id);
    assert!(delete_in(&conn, NoteDeleteRequest { id: second.id }).unwrap_err().contains("不存在"));
    assert!(update_with_time(&conn, NoteUpdateRequest { id: second.id, body: "x".into() }, "t").unwrap_err().contains("不存在"));
    assert_eq!(list_from_conn(&conn).unwrap().len(), 2);
  }

  #[test]
  fn rejects_empty_body_unknown_source_and_missing_word() {
    let conn = db();
    let bad = |word: &str, body: &str, source: &str| {
      add_with_time(&conn, NoteAddRequest { word: word.into(), body: body.into(), source: source.into() }, "t").unwrap_err()
    };
    assert!(bad("word", " \n ", "词库").contains("空"));
    assert!(bad("word", "x", "模型").contains("未知的笔记来源"));
    assert!(bad("  ", "x", "词库").contains("哪个词"));
    assert!(bad("word", &"长".repeat(MAX_NOTE_CHARS + 1), "词库").contains("太长"));
    for source in NOTE_SOURCES {
      add_with_time(&conn, NoteAddRequest { word: "word".into(), body: "ok".into(), source: source.into() }, "t").unwrap();
    }
    let note = add(&conn, "word", "keep", "t2");
    assert!(update_with_time(&conn, NoteUpdateRequest { id: note.id, body: "   ".into() }, "t3").unwrap_err().contains("空"));
    assert_eq!(get(&conn, note.id).unwrap().body, "keep");
  }

  #[test]
  fn notes_do_not_touch_review_or_upgrade_note_columns() {
    let conn = db();
    conn.execute_batch(
      "INSERT INTO review_word (id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note, imported_at, updated_at, deleted)
         VALUES ('rv:1', 1, 1, '| word | 1 | d | L1 | 2026-11-12 | 原备注 |', 'word', 'word', '1', 'd', 'L1', 1, '2026-11-12', '原备注', 't', 't', 0);
       INSERT INTO upgrade_entry VALUES ('up:1', 1, 1, '| a |', 'a', '**word**', 's', '升级备注', 't', 't', 0);",
    ).unwrap();
    let note = add(&conn, "word", "我的笔记", "t1");
    update_with_time(&conn, NoteUpdateRequest { id: note.id, body: "改".into() }, "t2").unwrap();
    let review: (String, String, String) = conn.query_row("SELECT note, raw, updated_at FROM review_word", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    assert_eq!(review, ("原备注".into(), "| word | 1 | d | L1 | 2026-11-12 | 原备注 |".into(), "t".into()));
    let upgrade: (String, String) = conn.query_row("SELECT note, updated_at FROM upgrade_entry", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!(upgrade, ("升级备注".into(), "t".into()));
  }

  #[test]
  fn missing_db_lists_empty_without_creating_file_and_list_is_read_only() {
    let path = std::env::temp_dir().join(format!("vocab-notes-{}.db", Uuid::new_v4()));
    assert!(list_at(&path).unwrap().is_empty());
    assert!(!path.exists());
    let note = add_at(&path, NoteAddRequest { word: "word".into(), body: "x".into(), source: "词库".into() }).unwrap();
    assert!(DateTime::parse_from_rfc3339(&note.created_at).is_ok());
    let before = std::fs::read(&path).unwrap();
    assert_eq!(list_at(&path).unwrap(), vec![note]);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    std::fs::remove_file(&path).unwrap();
  }

  #[test]
  fn markdown_groups_by_word_newest_first_with_date_and_source() {
    assert_eq!(render_markdown(&[]), None);
    let conn = db();
    add(&conn, "Resilient", "旧的一条", "2026-11-09T01:00:00.000Z");
    let newer = add(&conn, "resilient", "新的一条\n第二行\n\n空行后", "2026-11-10T01:00:00.000Z");
    update_with_time(&conn, NoteUpdateRequest { id: newer.id, body: "新的一条\n第二行\n\n空行后".into() }, "2026-11-10T02:00:00.000Z").unwrap();
    add_with_time(&conn, NoteAddRequest { word: "Exacerbate".into(), body: "别和 aggravate 混".into(), source: "闪卡".into() }, "2026-11-08T01:00:00.000Z").unwrap();
    let text = render_markdown(&list_from_conn(&conn).unwrap()).unwrap();
    let t = |s: &str| display_time(s);
    let expected = [
      "# 我的笔记".to_string(),
      String::new(),
      "共 2 个词、3 条笔记。按词分组，新的在前。".into(),
      String::new(),
      "## Exacerbate".into(),
      String::new(),
      format!("- {} · 闪卡", t("2026-11-08T01:00:00.000Z")),
      "  别和 aggravate 混".into(),
      String::new(),
      "## Resilient".into(),
      String::new(),
      format!("- {} · 词库 · 改于 {}", t("2026-11-10T01:00:00.000Z"), t("2026-11-10T02:00:00.000Z")),
      "  新的一条".into(),
      "  第二行".into(),
      String::new(),
      "  空行后".into(),
      format!("- {} · 词库", t("2026-11-09T01:00:00.000Z")),
      "  旧的一条".into(),
      String::new(),
    ].join("\n");
    assert_eq!(text, expected);
    assert!(t("2026-11-10T01:00:00.000Z").starts_with("2026-11-10") || t("2026-11-10T01:00:00.000Z").starts_with("2026-11-09"));
  }
}
