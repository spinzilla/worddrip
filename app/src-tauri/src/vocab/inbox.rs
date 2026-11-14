use chrono::{NaiveDate, SecondsFormat, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

use super::schema;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxWordInput {
  pub word: String,
  pub note: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxConfirmRequest {
  pub date: String,
  /// 老调用不带来源时仍按手写处理，只允许两种固定来源。
  pub source: Option<String>,
  pub words: Vec<InboxWordInput>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InboxConfirmResult {
  pub added: i64,
  pub words: Vec<String>,
}

fn normalized_word(word: &str) -> String {
  word.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn source_kind(request: &InboxConfirmRequest) -> Result<&str, String> {
  match request.source.as_deref() {
    None | Some("手写") => Ok("手写"),
    Some("Notion") => Ok("Notion"),
    _ => Err("收件箱来源只支持手写或 Notion".into()),
  }
}

fn validate(request: &InboxConfirmRequest) -> Result<Vec<(String, String)>, String> {
  source_kind(request)?;
  if NaiveDate::parse_from_str(&request.date, "%Y-%m-%d").is_err() {
    return Err("收件箱日期必须是有效的 YYYY-MM-DD".into());
  }
  if request.words.is_empty() || request.words.len() > 200 {
    return Err("每次确认入库需要 1～200 条词条".into());
  }
  let mut seen = HashSet::new();
  let mut words = Vec::new();
  for item in &request.words {
    let word = item.word.trim();
    let note = item.note.trim();
    if word.is_empty() || word.chars().count() > 200 {
      return Err("词目不能为空，且不能超过 200 个字符".into());
    }
    if note.chars().count() > 2000 {
      return Err(format!("词条 {word} 的备注不能超过 2000 个字符"));
    }
    if word.contains(['\r', '\n', '|']) || note.contains(['\r', '\n', '|']) {
      return Err(format!("词条 {word} 的词目和备注不能包含换行或竖线"));
    }
    if !seen.insert(normalized_word(word)) {
      return Err(format!("所选候选中有重复词目：{word}"));
    }
    words.push((word.to_string(), note.to_string()));
  }
  Ok(words)
}

pub fn confirm_at(path: &Path, request: InboxConfirmRequest) -> Result<InboxConfirmResult, String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| format!("创建词库数据目录失败：{error}"))?;
  }
  let conn = schema::open(path).map_err(|error| format!("打开词库数据库失败：{error}"))?;
  let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
  confirm_with_time(&conn, request, &now)
}

fn confirm_with_time(
  conn: &Connection,
  request: InboxConfirmRequest,
  now: &str,
) -> Result<InboxConfirmResult, String> {
  let source_kind = source_kind(&request)?;
  let words = validate(&request)?;
  let tx = conn.unchecked_transaction().map_err(|error| format!("开启手写收件箱事务失败：{error}"))?;
  let mut ord: i64 = tx.query_row("SELECT COALESCE(MAX(ord), 0) + 1 FROM review_word", [], |row| row.get(0))
    .map_err(|error| format!("读取复习库顺序失败：{error}"))?;
  let source = format!("{} {}", source_kind, request.date);
  let mut saved = Vec::new();
  for (word, note) in words {
    let norm = normalized_word(&word);
    let exists: bool = tx.query_row(
      "SELECT EXISTS(SELECT 1 FROM review_word WHERE word_norm = ?1 AND deleted = 0)",
      [&norm], |row| row.get(0),
    ).map_err(|error| format!("检查已有词条失败：{error}"))?;
    if exists {
      return Err(format!("词库已存在「{word}」，本次没有写入任何词条"));
    }
    let raw = format!("| {word} | {source_kind} | {} | 🌱待考察 | — | {note} |", request.date);
    tx.execute(
      "INSERT INTO review_word (
        id, ord, line, raw, word, word_norm, issue, added_at, status,
        level, due, note, imported_at, updated_at, deleted, source, verification_status
      ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, '🌱待考察',
        NULL, '', ?8, ?9, ?9, 0, ?10, '未查证')",
      params![format!("inbox:{}", uuid::Uuid::new_v4()), ord, raw, word, norm, source_kind, request.date, note, now, source],
    ).map_err(|error| format!("写入{source_kind}词条失败：{error}"))?;
    saved.push(word);
    ord += 1;
  }
  tx.commit().map_err(|error| format!("提交手写收件箱失败：{error}"))?;
  Ok(InboxConfirmResult { added: saved.len() as i64, words: saved })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    schema::migrate(&conn).unwrap();
    conn
  }

  fn request(words: &[(&str, &str)]) -> InboxConfirmRequest {
    InboxConfirmRequest {
      date: "2026-11-09".into(),
      source: None,
      words: words.iter().map(|(word, note)| InboxWordInput { word: (*word).into(), note: (*note).into() }).collect(),
    }
  }

  #[test]
  fn confirms_only_new_words_with_handwriting_metadata() {
    let conn = db();
    let result = confirm_with_time(&conn, request(&[(" resilient ", "有韧性"), ("candid", "坦率的")]), "now").unwrap();
    assert_eq!(result, InboxConfirmResult { added: 2, words: vec!["resilient".into(), "candid".into()] });
    let saved: (String, String, String, String, String, Option<i64>, String, String, String, String) = conn.query_row(
      "SELECT raw, word, issue, added_at, status, level, due, note, source, verification_status
       FROM review_word WHERE word = 'resilient'", [],
      |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?)),
    ).unwrap();
    assert_eq!(saved, (
      "| resilient | 手写 | 2026-11-09 | 🌱待考察 | — | 有韧性 |".into(),
      "resilient".into(), "手写".into(), "2026-11-09".into(), "🌱待考察".into(), None,
      "".into(), "有韧性".into(), "手写 2026-11-09".into(), "未查证".into(),
    ));
  }

  #[test]
  fn existing_word_rolls_back_the_whole_confirmation() {
    let conn = db();
    conn.execute(
      "INSERT INTO review_word (id, ord, line, raw, word, word_norm, issue, added_at, status,
        level, due, note, imported_at, updated_at, deleted)
       VALUES ('rv:old', 1, 1, '| Alpha |', 'Alpha', 'alpha', '1', '2026-01-01', 'L1', 1, '', '', 'old', 'old', 0)", [],
    ).unwrap();
    let error = confirm_with_time(&conn, request(&[("new", ""), (" alpha ", "重复")]), "now").unwrap_err();
    assert!(error.contains("词库已存在"));
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM review_word", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
  }

  #[test]
  fn confirms_notion_source_and_rejects_unknown_source() {
    let conn = db();
    let mut notion = request(&[("resilient", "有韧性")]);
    notion.source = Some("Notion".into());
    confirm_with_time(&conn, notion, "now").unwrap();
    let saved: (String, String, String, String) = conn.query_row(
      "SELECT issue, source, raw, verification_status FROM review_word WHERE word = 'resilient'", [], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
      },
    ).unwrap();
    assert_eq!(saved.0, "Notion");
    assert_eq!(saved.1, "Notion 2026-11-09");
    assert!(saved.2.contains("| resilient | Notion | 2026-11-09 |"));
    assert_eq!(saved.3, "未查证");

    let mut invalid = request(&[("other", "")]);
    invalid.source = Some("其他".into());
    assert!(confirm_with_time(&conn, invalid, "now").is_err());
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM review_word", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
  }
  #[test]
  fn invalid_or_duplicate_input_writes_nothing() {
    let conn = db();
    for request in [request(&[("same", ""), (" SAME ", "")]), request(&[("", "")]), request(&[("bad|word", "")])] {
      assert!(confirm_with_time(&conn, request, "now").is_err());
      assert_eq!(conn.query_row("SELECT COUNT(*) FROM review_word", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }
    let mut bad_date = request(&[("word", "")]);
    bad_date.date = "2026-02-30".into();
    assert!(confirm_with_time(&conn, bad_date, "now").is_err());
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM review_word", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
  }
}
