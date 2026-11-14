//! 042 手动加词：词库页的「添加词条」和查词卡上的「加入词库」都走这里。
//!
//! 写入规则跟手写收件箱（inbox.rs）一致：状态 `🌱待考察`、查证 `未查证`、
//! 原始行按复习库六列拼 `| 词 | 期号 | 入库日期 | 🌱待考察 | — | 备注 |`，导出时逐字带出去。
//! 不同的只有三点：期号由用户填（默认今天，如 `11.10`）、来源由调用方写（默认「手动添加」），
//! 以及可以顺手带一条释义和例句（写进 review_definition，出题时能用）。
//!
//! 查重：同一个词（忽略大小写、首尾空白、中间多余空白）已在复习库里，默认拒绝；
//! 用户在界面上明确选了「作为新义项/新一期添加」才带 allow_duplicate 再写一行。

use chrono::{NaiveDate, SecondsFormat, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

use super::schema;

/// 释义来源文件名：词条详情里能看出这条释义是手动加的，不会和期笔记导入的混在一起。
pub const MANUAL_DEFINITION_SOURCE: &str = "手动添加";

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ManualAddRequest {
  pub word: String,
  #[serde(default)]
  pub pos: String,
  #[serde(default)]
  pub chinese: String,
  #[serde(default)]
  pub english: String,
  #[serde(default)]
  pub example: String,
  #[serde(default)]
  pub source: String,
  pub issue: String,
  /// 入库日期 YYYY-MM-DD（前端按本机日期给，和收件箱一样）。
  pub date: String,
  #[serde(default)]
  pub note: String,
  /// 已有同名词时仍要再加一行（新义项 / 新一期）。
  #[serde(default)]
  pub allow_duplicate: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManualAddResult {
  pub id: String,
  pub word: String,
  pub issue: String,
  pub source: String,
  /// 写入前库里已有几条同名词（允许重复时才可能大于 0）。
  pub existing: i64,
}

/// 和收件箱同一套：去首尾空白、中间空白合一、转小写。
pub fn normalized_word(word: &str) -> String {
  word.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// 释义、例句这类只进数据库的字段：换行变空格，多余空白合一。
fn one_line(text: &str) -> String {
  text.split_whitespace().collect::<Vec<_>>().join(" ")
}

struct Clean {
  word: String,
  norm: String,
  pos: String,
  chinese: String,
  english: String,
  example: String,
  source: String,
  issue: String,
  date: String,
  note: String,
}

fn check_len(label: &str, text: &str, max: usize) -> Result<(), String> {
  if text.chars().count() > max { Err(format!("{label}不能超过 {max} 个字符")) } else { Ok(()) }
}

fn validate(request: &ManualAddRequest) -> Result<Clean, String> {
  // 短语按整段保留，只把中间多余的空白合成一个。
  let word = one_line(&request.word);
  if word.is_empty() { return Err("词或短语不能为空".into()); }
  check_len("词或短语", &word, 200)?;
  let issue = request.issue.trim().to_string();
  if issue.is_empty() { return Err("期号不能为空".into()); }
  check_len("期号", &issue, 40)?;
  let source = match request.source.trim() { "" => MANUAL_DEFINITION_SOURCE.to_string(), text => text.to_string() };
  check_len("来源", &source, 100)?;
  let note = request.note.trim().to_string();
  check_len("复习备注", &note, 2000)?;
  // 词、期号、备注会拼进 Markdown 表格的一行：不能有竖线和换行（词里的换行已合成空格）。
  if word.contains('|') { return Err("词或短语不能包含竖线「|」".into()); }
  for (label, text) in [("期号", &issue), ("复习备注", &note)] {
    if text.contains(['|', '\r', '\n']) {
      return Err(format!("{label}不能包含换行或竖线「|」"));
    }
  }
  if source.contains(['\r', '\n']) { return Err("来源不能包含换行".into()); }
  if NaiveDate::parse_from_str(&request.date, "%Y-%m-%d").is_err() {
    return Err("入库日期必须是有效的 YYYY-MM-DD".into());
  }
  let pos = one_line(&request.pos);
  let chinese = one_line(&request.chinese);
  let english = one_line(&request.english);
  let example = one_line(&request.example);
  check_len("词性", &pos, 60)?;
  check_len("中文意思", &chinese, 1000)?;
  check_len("英文释义", &english, 1000)?;
  check_len("例句", &example, 1000)?;
  Ok(Clean {
    norm: normalized_word(&word),
    word, pos, chinese, english, example, source, issue,
    date: request.date.clone(), note,
  })
}

/// 复习库原始行：和收件箱、Hermes 总词库同样的六列。
pub fn raw_line(word: &str, issue: &str, date: &str, note: &str) -> String {
  format!("| {word} | {issue} | {date} | 🌱待考察 | — | {note} |")
}

pub fn add_at(path: &Path, request: ManualAddRequest) -> Result<ManualAddResult, String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| format!("创建词库数据目录失败：{error}"))?;
  }
  let conn = schema::open(path).map_err(|error| format!("打开词库数据库失败：{error}"))?;
  let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
  add_with_time(&conn, request, &now)
}

pub fn add_with_time(conn: &Connection, request: ManualAddRequest, now: &str) -> Result<ManualAddResult, String> {
  let clean = validate(&request)?;
  let tx = conn.unchecked_transaction().map_err(|error| format!("开启手动加词事务失败：{error}"))?;
  let existing: i64 = tx.query_row(
    "SELECT COUNT(*) FROM review_word WHERE word_norm = ?1 AND deleted = 0",
    [&clean.norm], |row| row.get(0),
  ).map_err(|error| format!("检查已有词条失败：{error}"))?;
  if existing > 0 && !request.allow_duplicate {
    return Err(format!("词库已有「{}」，没有写入。可以打开已有词条，或选择作为新义项/新一期添加。", clean.word));
  }
  let ord: i64 = tx.query_row("SELECT COALESCE(MAX(ord), 0) + 1 FROM review_word", [], |row| row.get(0))
    .map_err(|error| format!("读取复习库顺序失败：{error}"))?;
  let id = format!("manual:{}", uuid::Uuid::new_v4());
  let raw = raw_line(&clean.word, &clean.issue, &clean.date, &clean.note);
  tx.execute(
    "INSERT INTO review_word (
      id, ord, line, raw, word, word_norm, issue, added_at, status,
      level, due, note, imported_at, updated_at, deleted, source, verification_status
    ) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, '🌱待考察',
      NULL, '', ?8, ?9, ?9, 0, ?10, '未查证')",
    params![id, ord, raw, clean.word, clean.norm, clean.issue, clean.date, clean.note, now, clean.source],
  ).map_err(|error| format!("写入词条失败：{error}"))?;
  // 释义、词性、中文、例句有一项就写一条释义（例句要挂在释义下面）。
  if !(clean.pos.is_empty() && clean.english.is_empty() && clean.chinese.is_empty() && clean.example.is_empty()) {
    tx.execute(
      "INSERT INTO review_definition (word_id, source_file, source_line, pos, english, chinese)
       VALUES (?1, ?2, 1, ?3, ?4, ?5)",
      params![id, MANUAL_DEFINITION_SOURCE, clean.pos, clean.english, clean.chinese],
    ).map_err(|error| format!("写入释义失败：{error}"))?;
    if !clean.example.is_empty() {
      tx.execute(
        "INSERT INTO review_definition_example (word_id, source_file, definition_line, seq, sentence, ai)
         VALUES (?1, ?2, 1, 1, ?3, 0)",
        params![id, MANUAL_DEFINITION_SOURCE, clean.example],
      ).map_err(|error| format!("写入例句失败：{error}"))?;
    }
  }
  tx.commit().map_err(|error| format!("提交手动加词失败：{error}"))?;
  Ok(ManualAddResult { id, word: clean.word, issue: clean.issue, source: clean.source, existing })
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::vocab::export::{export_at, ExportKind};
  use crate::vocab::query;

  fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    schema::migrate(&conn).unwrap();
    conn
  }

  fn request(word: &str) -> ManualAddRequest {
    ManualAddRequest { word: word.into(), issue: "11.10".into(), date: "2026-11-10".into(), ..Default::default() }
  }

  fn count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM review_word", [], |row| row.get(0)).unwrap()
  }

  #[test]
  fn writes_seed_status_source_issue_and_raw_line() {
    let conn = db();
    let mut req = request("  resilient ");
    req.note = "有韧性".into();
    let result = add_with_time(&conn, req, "now").unwrap();
    assert!(result.id.starts_with("manual:"));
    assert_eq!((result.word.as_str(), result.issue.as_str(), result.source.as_str(), result.existing), ("resilient", "11.10", "手动添加", 0));
    let saved: (String, String, String, String, String, Option<i64>, String, String, String, String, String) = conn.query_row(
      "SELECT raw, word, word_norm, issue, added_at, level, due, status, note, source, verification_status
       FROM review_word WHERE id = ?1", [&result.id],
      |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?)),
    ).unwrap();
    assert_eq!(saved, (
      "| resilient | 11.10 | 2026-11-10 | 🌱待考察 | — | 有韧性 |".into(),
      "resilient".into(), "resilient".into(), "11.10".into(), "2026-11-10".into(), None, "".into(),
      "🌱待考察".into(), "有韧性".into(), "手动添加".into(), "未查证".into(),
    ));
    // 只填词：不写空释义。
    let defs: i64 = conn.query_row("SELECT COUNT(*) FROM review_definition", [], |row| row.get(0)).unwrap();
    assert_eq!(defs, 0);
  }

  #[test]
  fn phrase_keeps_whole_text_and_writes_definition_with_example() {
    let conn = db();
    let mut req = request("  take   into\naccount ");
    req.pos = "phr.".into();
    req.english = "to consider something\nwhen judging".into();
    req.chinese = "考虑到".into();
    req.example = "We must take into account the cost of living.".into();
    req.source = "精听".into();
    let result = add_with_time(&conn, req, "now").unwrap();
    assert_eq!(result.word, "take into account");
    assert_eq!(result.source, "精听");
    let data = query::browse_from_conn(&conn).unwrap();
    let word = data.review_words.iter().find(|item| item.id == result.id).unwrap();
    assert_eq!(word.source, "精听");
    assert_eq!(word.raw, "| take into account | 11.10 | 2026-11-10 | 🌱待考察 | — |  |");
    assert_eq!(word.definitions.len(), 1);
    let def = &word.definitions[0];
    assert_eq!((def.source_file.as_str(), def.pos.as_str(), def.english.as_str(), def.chinese.as_str()),
      ("手动添加", "phr.", "to consider something when judging", "考虑到"));
    assert_eq!(def.examples.len(), 1);
    assert_eq!(def.examples[0].sentence, "We must take into account the cost of living.");
    assert!(!def.examples[0].ai);
  }

  #[test]
  fn duplicate_is_rejected_unless_allowed_and_ignores_case_and_spaces() {
    let conn = db();
    add_with_time(&conn, request("Take Into Account"), "now").unwrap();
    let error = add_with_time(&conn, request("  take  into ACCOUNT "), "now").unwrap_err();
    assert!(error.contains("词库已有"), "{error}");
    assert_eq!(count(&conn), 1, "查重失败不能悄悄写入");
    let mut again = request("take into account");
    again.issue = "11.12".into();
    again.allow_duplicate = true;
    let result = add_with_time(&conn, again, "now").unwrap();
    assert_eq!(result.existing, 1);
    assert_eq!(count(&conn), 2);
    let ords: Vec<i64> = conn.prepare("SELECT ord FROM review_word ORDER BY ord").unwrap()
      .query_map([], |row| row.get(0)).unwrap().map(Result::unwrap).collect();
    assert_eq!(ords, vec![1, 2]);
  }

  #[test]
  fn duplicate_check_sees_imported_and_inbox_words_but_not_deleted_rows() {
    let conn = db();
    conn.execute(
      "INSERT INTO review_word (id, ord, line, raw, word, word_norm, issue, added_at, status,
        level, due, note, imported_at, updated_at, deleted)
       VALUES ('rv:alpha', 5, 3, '| Alpha |', 'Alpha', 'alpha', '9.1', '2026-09-01', 'L2', 2, '', '', 'old', 'old', 0),
              ('rv:gone', 6, 4, '| gone |', 'gone', 'gone', '9.1', '2026-09-01', 'L2', 2, '', '', 'old', 'old', 1)", [],
    ).unwrap();
    assert!(add_with_time(&conn, request("ALPHA"), "now").unwrap_err().contains("词库已有"));
    let result = add_with_time(&conn, request("gone"), "now").unwrap();
    assert_eq!(result.existing, 0);
    let ord: i64 = conn.query_row("SELECT ord FROM review_word WHERE id = ?1", [&result.id], |row| row.get(0)).unwrap();
    assert_eq!(ord, 7, "新词排在最后");
  }

  #[test]
  fn invalid_input_writes_nothing() {
    let conn = db();
    let mut cases = vec![request(""), request("   "), request("bad|word"), request(&"x".repeat(201))];
    let mut bad_date = request("ok"); bad_date.date = "2026-02-30".into(); cases.push(bad_date);
    let mut empty_issue = request("ok"); empty_issue.issue = " ".into(); cases.push(empty_issue);
    let mut pipe_issue = request("ok"); pipe_issue.issue = "11|10".into(); cases.push(pipe_issue);
    let mut pipe_note = request("ok"); pipe_note.note = "a | b".into(); cases.push(pipe_note);
    let mut line_note = request("ok"); line_note.note = "a\nb".into(); cases.push(line_note);
    let mut line_source = request("ok"); line_source.source = "a\nb".into(); cases.push(line_source);
    for case in cases {
      assert!(add_with_time(&conn, case, "now").is_err());
    }
    assert_eq!(count(&conn), 0);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM review_definition", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
  }

  #[test]
  fn manual_words_are_exported_in_the_review_markdown() {
    let dir = std::env::temp_dir().join(format!("vocab-manual-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("vocab.sqlite");
    let mut word = request("candid");
    word.note = "坦率的".into();
    add_at(&db_path, word).unwrap();
    let mut phrase = request("take into account");
    phrase.english = "to consider".into();
    phrase.source = "教练".into();
    add_at(&db_path, phrase).unwrap();
    let output = dir.join("总词库.md");
    let result = export_at(&db_path, ExportKind::Review, &output).unwrap();
    assert_eq!(result.records, 2);
    let markdown = fs::read_to_string(&output).unwrap();
    assert!(markdown.contains("\n| candid | 11.10 | 2026-11-10 | 🌱待考察 | — | 坦率的 |\n"), "{markdown}");
    assert!(markdown.contains("\n| take into account | 11.10 | 2026-11-10 | 🌱待考察 | — |  |\n"), "{markdown}");
    let csv = fs::read_to_string(dir.join("词条来源与查证.csv")).unwrap();
    assert!(csv.contains("candid,手动添加,未查证"), "{csv}");
    assert!(csv.contains("take into account,教练,未查证"), "{csv}");
    let _ = fs::remove_dir_all(&dir);
  }
}
