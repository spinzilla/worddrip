//! 078 英英释义：词典查来的、自己写的英英释义。
//!
//! - 单独一张表 `vocab_definition_en`，不写、不改 `review_definition.english`（导入期笔记写进去的那份）。
//! - 按词挂：`word_key` 和 040 笔记用同一个归一化规则（[`super::notes::note_key`]）。
//! - `source`：`mine` = 自己写的；`dict:cambridge`、`dict:wiktionary`、`dict:local-wiktionary` 等 = 词典查来的。
//! - 同一个词可以有多条。自己写的重复会报错；词典来的重复（例如两处同时打开同一个词）静默跳过。
//!   判重只在同类里比（我写的 vs 我写的、词典的 vs 词典的），所以「改成我的」能把词典那条原样复制成自己的。

use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

use super::notes::{display_time, note_key};
use super::schema;

pub const SOURCE_MINE: &str = "mine";
/// 一条释义最多多少字。
pub const MAX_TEXT_CHARS: usize = 1000;
/// 词性最多多少字。
pub const MAX_POS_CHARS: usize = 30;
/// 一次最多存几条（词典取前 1–3 个义项，留点余量）。
pub const MAX_BATCH: usize = 6;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VocabDefinitionEn {
  pub id: i64,
  pub word_key: String,
  pub word: String,
  pub pos: Option<String>,
  pub text: String,
  pub source: String,
  pub created_at: String,
  pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionEnItem {
  #[serde(default)]
  pub pos: Option<String>,
  pub text: String,
}

/// 给一个词存一条或几条（同一个来源），整批一个事务。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionEnAddRequest {
  pub word: String,
  pub source: String,
  pub items: Vec<DefinitionEnItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionEnUpdateRequest {
  pub id: i64,
  #[serde(default)]
  pub pos: Option<String>,
  pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionEnDeleteRequest {
  pub id: i64,
}

fn valid_source(source: &str) -> bool {
  source == SOURCE_MINE || (source.starts_with("dict:") && source.len() > 5 && source.len() <= 40 && source[5..].chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
}

/// 释义是单段文字：连续空白合成一个空格。
fn clean_text(text: &str) -> Result<String, String> {
  let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
  if text.is_empty() {
    return Err("英英释义是空的，没有保存".into());
  }
  if text.chars().count() > MAX_TEXT_CHARS {
    return Err(format!("英英释义太长了（超过 {MAX_TEXT_CHARS} 字）"));
  }
  Ok(text)
}

fn clean_pos(pos: &Option<String>) -> Result<Option<String>, String> {
  let Some(pos) = pos else { return Ok(None) };
  let pos = pos.split_whitespace().collect::<Vec<_>>().join(" ");
  if pos.is_empty() {
    return Ok(None);
  }
  if pos.chars().count() > MAX_POS_CHARS {
    return Err(format!("词性太长了（超过 {MAX_POS_CHARS} 字）"));
  }
  Ok(Some(pos))
}

fn now() -> String {
  chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

const SELECT: &str = "SELECT id, word_key, word, pos, text, source, created_at, updated_at FROM vocab_definition_en";

fn row_to_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<VocabDefinitionEn> {
  Ok(VocabDefinitionEn {
    id: row.get(0)?,
    word_key: row.get(1)?,
    word: row.get(2)?,
    pos: row.get(3)?,
    text: row.get(4)?,
    source: row.get(5)?,
    created_at: row.get(6)?,
    updated_at: row.get(7)?,
  })
}

/// 只读列出全部。库不存在返回空（不建库）。同一个词的放一起，旧的在前（词典的义项顺序保持）。
pub fn list_at(path: &Path) -> Result<Vec<VocabDefinitionEn>, String> {
  if !path.exists() {
    return Ok(Vec::new());
  }
  let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
    .map_err(|error| format!("只读打开词库数据库失败：{error}"))?;
  list_from_conn(&conn)
}

pub fn list_from_conn(conn: &Connection) -> Result<Vec<VocabDefinitionEn>, String> {
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
    .prepare(&format!("{SELECT} ORDER BY word_key, id"))
    .map_err(|error| format!("读取英英释义失败：{error}"))?;
  let rows = stmt.query_map([], row_to_item).map_err(|error| format!("读取英英释义失败：{error}"))?;
  rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|error| format!("读取英英释义失败：{error}"))
}

pub fn add_at(path: &Path, request: DefinitionEnAddRequest) -> Result<Vec<VocabDefinitionEn>, String> {
  let conn = schema::open(path).map_err(|error| format!("打开词库数据库失败：{error}"))?;
  add_with_time(&conn, request, &now())
}

/// 返回真正新存的那几条（词典来的重复会被跳过，所以可能比请求少，甚至为空）。
pub fn add_with_time(conn: &Connection, request: DefinitionEnAddRequest, now: &str) -> Result<Vec<VocabDefinitionEn>, String> {
  let key = note_key(&request.word);
  if key.is_empty() {
    return Err("没有指定给哪个词存英英释义".into());
  }
  if !valid_source(&request.source) {
    return Err(format!("未知的英英释义来源：{}", request.source));
  }
  if request.items.is_empty() {
    return Err("没有要存的英英释义".into());
  }
  if request.items.len() > MAX_BATCH {
    return Err(format!("一次最多存 {MAX_BATCH} 条"));
  }
  let mine = request.source == SOURCE_MINE;
  let word = request.word.split_whitespace().collect::<Vec<_>>().join(" ").replace("**", "");
  let mut existing: Vec<String> = {
    let mut stmt = conn
      .prepare("SELECT text FROM vocab_definition_en WHERE word_key = ?1 AND (source = 'mine') = ?2")
      .map_err(|error| format!("读取英英释义失败：{error}"))?;
    let rows = stmt.query_map(params![key, mine], |row| row.get(0)).map_err(|error| format!("读取英英释义失败：{error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|error| format!("读取英英释义失败：{error}"))?
  };
  let mut rows: Vec<(Option<String>, String)> = Vec::new();
  for item in &request.items {
    let text = clean_text(&item.text)?;
    let pos = clean_pos(&item.pos)?;
    if existing.iter().any(|old| note_key(old) == note_key(&text)) {
      if mine {
        return Err(format!("这条已经存过了：{text}"));
      }
      continue;
    }
    existing.push(text.clone());
    rows.push((pos, text));
  }
  let tx = conn.unchecked_transaction().map_err(|error| format!("保存英英释义失败：{error}"))?;
  let mut ids = Vec::with_capacity(rows.len());
  for (pos, text) in &rows {
    tx.execute(
      "INSERT INTO vocab_definition_en (word_key, word, pos, text, source, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
      params![key, word, pos, text, request.source, now],
    )
    .map_err(|error| format!("保存英英释义失败：{error}"))?;
    ids.push(tx.last_insert_rowid());
  }
  tx.commit().map_err(|error| format!("保存英英释义失败：{error}"))?;
  ids
    .into_iter()
    .map(|id| conn.query_row(&format!("{SELECT} WHERE id = ?1"), params![id], row_to_item).map_err(|error| format!("读取英英释义失败：{error}")))
    .collect()
}

pub fn update_at(path: &Path, request: DefinitionEnUpdateRequest) -> Result<VocabDefinitionEn, String> {
  let conn = schema::open(path).map_err(|error| format!("打开词库数据库失败：{error}"))?;
  update_with_time(&conn, request, &now())
}

/// 只能改自己写的（词典来的要先「改成我的」）。
pub fn update_with_time(conn: &Connection, request: DefinitionEnUpdateRequest, now: &str) -> Result<VocabDefinitionEn, String> {
  let text = clean_text(&request.text)?;
  let pos = clean_pos(&request.pos)?;
  let (key, source): (String, String) = conn
    .query_row("SELECT word_key, source FROM vocab_definition_en WHERE id = ?1", params![request.id], |row| Ok((row.get(0)?, row.get(1)?)))
    .map_err(|_| "这条英英释义不存在（可能已经删掉了）".to_string())?;
  if source != SOURCE_MINE {
    return Err("词典查来的释义不能直接改，请先点「改成我的」".into());
  }
  let others: Vec<String> = {
    let mut stmt = conn
      .prepare("SELECT text FROM vocab_definition_en WHERE word_key = ?1 AND id <> ?2 AND source = 'mine'")
      .map_err(|error| format!("读取英英释义失败：{error}"))?;
    let rows = stmt.query_map(params![key, request.id], |row| row.get(0)).map_err(|error| format!("读取英英释义失败：{error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|error| format!("读取英英释义失败：{error}"))?
  };
  if others.iter().any(|old| note_key(old) == note_key(&text)) {
    return Err(format!("这条已经存过了：{text}"));
  }
  conn
    .execute("UPDATE vocab_definition_en SET pos = ?1, text = ?2, updated_at = ?3 WHERE id = ?4", params![pos, text, now, request.id])
    .map_err(|error| format!("保存英英释义失败：{error}"))?;
  conn.query_row(&format!("{SELECT} WHERE id = ?1"), params![request.id], row_to_item).map_err(|error| format!("读取英英释义失败：{error}"))
}

pub fn delete_at(path: &Path, request: DefinitionEnDeleteRequest) -> Result<i64, String> {
  let conn = schema::open(path).map_err(|error| format!("打开词库数据库失败：{error}"))?;
  delete_in(&conn, request)
}

pub fn delete_in(conn: &Connection, request: DefinitionEnDeleteRequest) -> Result<i64, String> {
  let changed = conn
    .execute("DELETE FROM vocab_definition_en WHERE id = ?1", params![request.id])
    .map_err(|error| format!("删除英英释义失败：{error}"))?;
  if changed == 0 {
    return Err("这条英英释义不存在（可能已经删掉了）".into());
  }
  Ok(request.id)
}

fn source_label(source: &str) -> String {
  match source {
    "mine" => "我写的".into(),
    "dict:cambridge" => "来自 剑桥英英".into(),
    "dict:wiktionary" => "来自 Wiktionary".into(),
    "dict:local-wiktionary" => "来自 本地 Wiktionary".into(),
    "dict:local" => "来自 本地词典".into(),
    other => format!("来自 {}", other.trim_start_matches("dict:")),
  }
}

/// 导出成 `我的英英释义.md`：按词分组（按键的字母序），组内自己写的在前，再按存入顺序。没有返回 None。
pub fn render_markdown(items: &[VocabDefinitionEn]) -> Option<String> {
  if items.is_empty() {
    return None;
  }
  let mut groups: BTreeMap<&str, Vec<&VocabDefinitionEn>> = BTreeMap::new();
  for item in items {
    groups.entry(item.word_key.as_str()).or_default().push(item);
  }
  let mut lines = vec![
    "# 我的英英释义".to_string(),
    String::new(),
    format!("共 {} 个词、{} 条。按词分组，「我写的」排在前面；其余是从英英词典查来后存下的。", groups.len(), items.len()),
  ];
  for list in groups.values_mut() {
    list.sort_by(|a, b| (a.source != SOURCE_MINE).cmp(&(b.source != SOURCE_MINE)).then(a.id.cmp(&b.id)));
    let title = list.iter().min_by_key(|e| e.id).map(|e| e.word.as_str()).unwrap_or("");
    lines.push(String::new());
    lines.push(format!("## {title}"));
    lines.push(String::new());
    for item in list.iter() {
      let pos = item.pos.as_deref().map(|p| format!("{p} ")).unwrap_or_default();
      lines.push(format!("- {pos}{}", item.text));
      lines.push(format!("  - 来源：{} · {}", source_label(&item.source), display_time(&item.updated_at)));
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

  fn item(pos: Option<&str>, text: &str) -> DefinitionEnItem {
    DefinitionEnItem { pos: pos.map(str::to_string), text: text.into() }
  }

  fn add(conn: &Connection, word: &str, source: &str, items: Vec<DefinitionEnItem>, time: &str) -> Vec<VocabDefinitionEn> {
    add_with_time(conn, DefinitionEnAddRequest { word: word.into(), source: source.into(), items }, time).unwrap()
  }

  #[test]
  fn add_list_update_delete() {
    let conn = db();
    let a = add(&conn, " Resilient ", "mine", vec![item(Some(" adj. "), " able to  recover\nquickly ")], "2026-11-14T01:00:00.000Z");
    assert_eq!((a[0].word_key.as_str(), a[0].word.as_str()), ("resilient", "Resilient"));
    assert_eq!(a[0].pos.as_deref(), Some("adj."));
    assert_eq!(a[0].text, "able to recover quickly");
    let d = add(&conn, "resilient", "dict:cambridge", vec![item(None, "able to be happy again"), item(Some("  "), "flexible")], "t2");
    assert_eq!(d.len(), 2);
    assert_eq!(d[0].pos, None);
    assert_eq!(list_from_conn(&conn).unwrap().len(), 3);

    let u = update_with_time(&conn, DefinitionEnUpdateRequest { id: a[0].id, pos: None, text: "able to recover fast".into() }, "t3").unwrap();
    assert_eq!((u.text.as_str(), u.pos.clone(), u.updated_at.as_str()), ("able to recover fast", None, "t3"));
    assert_eq!(u.created_at, "2026-11-14T01:00:00.000Z");
    assert!(update_with_time(&conn, DefinitionEnUpdateRequest { id: d[0].id, pos: None, text: "x".into() }, "t").unwrap_err().contains("改成我的"));
    assert!(update_with_time(&conn, DefinitionEnUpdateRequest { id: 999, pos: None, text: "x".into() }, "t").unwrap_err().contains("不存在"));

    assert_eq!(delete_in(&conn, DefinitionEnDeleteRequest { id: a[0].id }).unwrap(), a[0].id);
    assert!(delete_in(&conn, DefinitionEnDeleteRequest { id: a[0].id }).unwrap_err().contains("不存在"));
    assert_eq!(list_from_conn(&conn).unwrap().len(), 2);
  }

  #[test]
  fn rejects_bad_input_and_dedups() {
    let conn = db();
    let bad = |word: &str, source: &str, items: Vec<DefinitionEnItem>| add_with_time(&conn, DefinitionEnAddRequest { word: word.into(), source: source.into(), items }, "t").unwrap_err();
    assert!(bad("  ", "mine", vec![item(None, "x")]).contains("哪个词"));
    assert!(bad("w", "mine", vec![]).contains("没有要存"));
    assert!(bad("w", "mine", vec![item(None, " \n ")]).contains("空"));
    assert!(bad("w", "ai", vec![item(None, "x")]).contains("未知"));
    assert!(bad("w", "dict:", vec![item(None, "x")]).contains("未知"));
    assert!(bad("w", "mine", vec![item(None, &"a".repeat(MAX_TEXT_CHARS + 1))]).contains("太长"));
    assert!(bad("w", "mine", (0..=MAX_BATCH).map(|i| item(None, &format!("d{i}"))).collect()).contains("最多"));
    // 第二条不合格：第一条也不存。
    assert!(bad("w", "mine", vec![item(None, "ok"), item(None, " ")]).contains("空"));
    assert_eq!(list_from_conn(&conn).unwrap().len(), 0);
    add(&conn, "w", "mine", vec![item(None, "A thing.")], "t");
    assert!(bad("W", "mine", vec![item(None, "a  THING.")]).contains("存过"));
    // 词典来的重复静默跳过（不写空记录、不报错）。
    let again = add(&conn, "w", "dict:wiktionary", vec![item(None, "a thing."), item(None, "another")], "t");
    // 判重只在同类里比：词典的和「我写的」文字一样也各存各的（所以才能「改成我的」）。
    assert_eq!(again.len(), 2);
    assert_eq!(list_from_conn(&conn).unwrap().len(), 3);
    assert!(add(&conn, "w", "dict:wiktionary", vec![item(None, "a thing.")], "t").is_empty());
    assert!(add(&conn, "w", "dict:wiktionary", vec![item(None, "another")], "t").is_empty());
  }

  #[test]
  fn missing_db_lists_empty_without_creating_file() {
    let path = std::env::temp_dir().join(format!("vocab-defen-{}.db", Uuid::new_v4()));
    assert!(list_at(&path).unwrap().is_empty());
    assert!(!path.exists());
    let saved = add_at(&path, DefinitionEnAddRequest { word: "word".into(), source: "mine".into(), items: vec![item(None, "a unit of language")] }).unwrap();
    assert!(chrono::DateTime::parse_from_rfc3339(&saved[0].created_at).is_ok());
    assert_eq!(list_at(&path).unwrap(), saved);
    std::fs::remove_file(&path).unwrap();
  }

  #[test]
  fn does_not_touch_review_definition() {
    let conn = db();
    conn.execute_batch(
      "INSERT INTO review_word (id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note, imported_at, updated_at, deleted)
         VALUES ('rv:1', 1, 1, '| word | 1 |', 'word', 'word', '1', 'd', 'L1', 1, '2026-11-12', '原备注', 't', 't', 0);
       INSERT INTO review_definition VALUES ('rv:1', 'a.md', 3, 'n.', 'a unit', '词');",
    ).unwrap();
    add(&conn, "word", "mine", vec![item(None, "mine")], "t");
    let english: String = conn.query_row("SELECT english FROM review_definition", [], |r| r.get(0)).unwrap();
    assert_eq!(english, "a unit");
  }

  #[test]
  fn markdown_puts_mine_first() {
    assert_eq!(render_markdown(&[]), None);
    let conn = db();
    add(&conn, "Resilient", "dict:cambridge", vec![item(Some("adj."), "able to recover")], "2026-11-09T01:00:00.000Z");
    add(&conn, "resilient", "mine", vec![item(None, "bounces back")], "2026-11-10T01:00:00.000Z");
    add(&conn, "Allocate", "dict:local-wiktionary", vec![item(Some("verb"), "to assign")], "2026-11-08T01:00:00.000Z");
    let text = render_markdown(&list_from_conn(&conn).unwrap()).unwrap();
    let t = |s: &str| display_time(s);
    let expected = [
      "# 我的英英释义".to_string(),
      String::new(),
      "共 2 个词、3 条。按词分组，「我写的」排在前面；其余是从英英词典查来后存下的。".into(),
      String::new(),
      "## Allocate".into(),
      String::new(),
      "- verb to assign".into(),
      format!("  - 来源：来自 本地 Wiktionary · {}", t("2026-11-08T01:00:00.000Z")),
      String::new(),
      "## Resilient".into(),
      String::new(),
      "- bounces back".into(),
      format!("  - 来源：我写的 · {}", t("2026-11-10T01:00:00.000Z")),
      "- adj. able to recover".into(),
      format!("  - 来源：来自 剑桥英英 · {}", t("2026-11-09T01:00:00.000Z")),
      String::new(),
    ].join("\n");
    assert_eq!(text, expected);
  }
}

#[cfg(test)]
mod upgrade_tests {
  use super::*;

  /// v12 的库（没有英英释义表）升级到 13：原有数据数量不变，新表可用，新行进同步账本。
  #[test]
  fn v12_library_upgrades_to_13_keeping_existing_rows() {
    let conn = Connection::open_in_memory().unwrap();
    schema::migrate(&conn).unwrap();
    conn.execute_batch(
      "INSERT INTO vocab_note (word_key, word, body, source, created_at, updated_at) VALUES ('k', 'k', 'n', '词库', 't', 't');
       INSERT INTO vocab_example (word_key, word, sentence, source, created_at) VALUES ('k', 'k', 'A k.', '自己写', 't');
       DROP TABLE vocab_definition_en; PRAGMA user_version = 12;",
    ).unwrap();
    schema::migrate(&conn).unwrap();
    let n = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
    assert_eq!(n("PRAGMA user_version"), schema::SCHEMA_VERSION as i64);
    assert_eq!((n("SELECT COUNT(*) FROM vocab_note"), n("SELECT COUNT(*) FROM vocab_example")), (1, 1));
    assert_eq!(n("SELECT COUNT(*) FROM vocab_definition_en"), 0);
    add_with_time(&conn, DefinitionEnAddRequest { word: "k".into(), source: "mine".into(), items: vec![DefinitionEnItem { pos: None, text: "t".into() }] }, "t").unwrap();
    assert_eq!(n("SELECT COUNT(*) FROM sync_change WHERE tbl = 'vocab_definition_en' AND dirty = 1"), 1);
  }
}

#[cfg(test)]
mod adopt_tests {
  use super::*;

  /// 「改成我的」：词典那条的文字原样存成一条「我写的」，两条并存。
  #[test]
  fn mine_may_copy_a_dictionary_definition_text() {
    let conn = Connection::open_in_memory().unwrap();
    schema::migrate(&conn).unwrap();
    let item = || DefinitionEnItem { pos: Some("adj.".into()), text: "able to recover".into() };
    add_with_time(&conn, DefinitionEnAddRequest { word: "resilient".into(), source: "dict:cambridge".into(), items: vec![item()] }, "t1").unwrap();
    let mine = add_with_time(&conn, DefinitionEnAddRequest { word: "resilient".into(), source: "mine".into(), items: vec![item()] }, "t2").unwrap();
    assert_eq!(mine.len(), 1);
    assert_eq!(list_from_conn(&conn).unwrap().len(), 2);
    assert!(add_with_time(&conn, DefinitionEnAddRequest { word: "resilient".into(), source: "mine".into(), items: vec![item()] }, "t3").unwrap_err().contains("存过"));
  }
}
