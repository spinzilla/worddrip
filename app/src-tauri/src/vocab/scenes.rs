//! 048 例句场景标注：闪卡背面每个例句后面标一个场景标签（comparison、summary 等 10 个固定标签）。
//!
//! - 单独一张表 `example_scene`，按「规范化后的句子文字」存，不引用任何行 ID，所以词库重新导入不丢标签。
//! - 规范化规则 [`scene_key`]：统一弯引号/弯撇号、去首尾空白、合并连续空白、转小写。前端有一份同样的规则（`utils/vocab/scenes.ts`）。
//! - 手动优先：来源是「手动」的标签，AI 再写同一句时被忽略（SQL 里 `WHERE source <> '手动'`）；手动可以覆盖任何标签。
//! - 不改现有表，不进导出的 Markdown。

use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::path::Path;

use super::schema;

/// 10 个固定标签。
pub const SCENES: [&str; 10] = [
  "definition", "statement", "evidence", "explanation", "cause-effect",
  "comparison", "concession", "evaluation", "recommendation", "summary",
];
/// 来源：AI 标的 / 用户手动选的。
pub const SCENE_SOURCES: [&str; 2] = ["AI", "手动"];
const MAX_SENTENCE_CHARS: usize = 600;
const MAX_BATCH: usize = 50;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExampleScene {
  pub key: String,
  pub sentence: String,
  pub scene: String,
  pub source: String,
  pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneItem {
  pub sentence: String,
  pub scene: String,
}

/// 写入一批标签。source = "AI" 时不会覆盖已有的「手动」标签。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSetRequest {
  pub items: Vec<SceneItem>,
  pub source: String,
}

/// 句子的规范化键：弯引号统一成直引号，合并空白，去首尾空白，转小写。
pub fn scene_key(sentence: &str) -> String {
  sentence
    .replace(['’', '‘'], "'")
    .replace(['“', '”'], "\"")
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ")
    .to_lowercase()
}

fn now() -> String {
  chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

const SELECT: &str = "SELECT key, sentence, scene, source, updated_at FROM example_scene";

fn row_to_scene(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExampleScene> {
  Ok(ExampleScene { key: row.get(0)?, sentence: row.get(1)?, scene: row.get(2)?, source: row.get(3)?, updated_at: row.get(4)? })
}

/// 只读列出全部标签。库不存在返回空（不建库）。
pub fn list_at(path: &Path) -> Result<Vec<ExampleScene>, String> {
  if !path.exists() {
    return Ok(Vec::new());
  }
  let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
    .map_err(|error| format!("只读打开词库数据库失败：{error}"))?;
  list_from_conn(&conn)
}

pub fn list_from_conn(conn: &Connection) -> Result<Vec<ExampleScene>, String> {
  let version: i32 = conn
    .query_row("PRAGMA user_version", [], |row| row.get(0))
    .map_err(|error| format!("读取数据库版本失败：{error}"))?;
  if version == 0 {
    return Ok(Vec::new());
  }
  if version != schema::SCHEMA_VERSION {
    return Err(format!("词库数据库版本 {version} 与本应用支持的版本 {} 不兼容，已停止读取", schema::SCHEMA_VERSION));
  }
  let mut stmt = conn.prepare(&format!("{SELECT} ORDER BY key")).map_err(|error| format!("读取场景标签失败：{error}"))?;
  let rows = stmt.query_map([], row_to_scene).map_err(|error| format!("读取场景标签失败：{error}"))?;
  rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|error| format!("读取场景标签失败：{error}"))
}

pub fn set_at(path: &Path, request: SceneSetRequest) -> Result<Vec<ExampleScene>, String> {
  let conn = schema::open(path).map_err(|error| format!("打开词库数据库失败：{error}"))?;
  set_with_time(&conn, request, &now())
}

/// 整批一个事务。返回这批句子写完后库里的最终状态（被「手动」挡住的 AI 句子返回已有的手动标签）。
pub fn set_with_time(conn: &Connection, request: SceneSetRequest, now: &str) -> Result<Vec<ExampleScene>, String> {
  if !SCENE_SOURCES.contains(&request.source.as_str()) {
    return Err(format!("未知的标签来源：{}；只能是 {}", request.source, SCENE_SOURCES.join("、")));
  }
  if request.items.is_empty() {
    return Err("没有要保存的场景标签".into());
  }
  if request.items.len() > MAX_BATCH {
    return Err(format!("一次最多存 {MAX_BATCH} 个场景标签"));
  }
  let mut prepared: Vec<(String, String, &str)> = Vec::with_capacity(request.items.len());
  for item in &request.items {
    if !SCENES.contains(&item.scene.as_str()) {
      return Err(format!("未知的场景标签：{}", item.scene));
    }
    let sentence = item.sentence.split_whitespace().collect::<Vec<_>>().join(" ");
    if sentence.is_empty() {
      return Err("例句是空的，没有保存标签".into());
    }
    if sentence.chars().count() > MAX_SENTENCE_CHARS {
      return Err(format!("例句太长了（超过 {MAX_SENTENCE_CHARS} 字）"));
    }
    prepared.push((scene_key(&sentence), sentence, item.scene.as_str()));
  }
  let tx = conn.unchecked_transaction().map_err(|error| format!("保存场景标签失败：{error}"))?;
  for (key, sentence, scene) in &prepared {
    // 手动：直接覆盖。AI：只在没有记录、或已有记录不是「手动」时写入。
    tx.execute(
      "INSERT INTO example_scene (key, sentence, scene, source, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(key) DO UPDATE SET sentence = excluded.sentence, scene = excluded.scene, source = excluded.source, updated_at = excluded.updated_at
       WHERE example_scene.source <> '手动' OR excluded.source = '手动'",
      params![key, sentence, scene, request.source, now],
    )
    .map_err(|error| format!("保存场景标签失败：{error}"))?;
  }
  tx.commit().map_err(|error| format!("保存场景标签失败：{error}"))?;
  prepared
    .iter()
    .map(|(key, ..)| conn.query_row(&format!("{SELECT} WHERE key = ?1"), params![key], row_to_scene).map_err(|error| format!("读取场景标签失败：{error}")))
    .collect()
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

  fn req(source: &str, items: &[(&str, &str)]) -> SceneSetRequest {
    SceneSetRequest { source: source.into(), items: items.iter().map(|(s, c)| SceneItem { sentence: (*s).into(), scene: (*c).into() }).collect() }
  }

  #[test]
  fn key_normalizes_whitespace_quotes_and_case() {
    assert_eq!(scene_key("  The  Students’ work\n was “good”. "), "the students' work was \"good\".");
    assert_eq!(scene_key("It’s fine."), scene_key("it's   FINE."));
    assert_ne!(scene_key("It is fine."), scene_key("It is fine"));
  }

  #[test]
  fn same_sentence_in_different_form_is_one_row() {
    let conn = db();
    set_with_time(&conn, req("AI", &[("The  data show a trend.", "evidence")]), "t1").unwrap();
    let saved = set_with_time(&conn, req("AI", &[("the data SHOW a trend.", "statement")]), "t2").unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(list_from_conn(&conn).unwrap().len(), 1);
    assert_eq!(saved[0].scene, "statement");
    assert_eq!(saved[0].updated_at, "t2");
  }

  #[test]
  fn manual_is_never_overwritten_by_ai_but_manual_overwrites_all() {
    let conn = db();
    set_with_time(&conn, req("AI", &[("A cat sat.", "statement")]), "t1").unwrap();
    let manual = set_with_time(&conn, req("手动", &[("a cat  sat.", "summary")]), "t2").unwrap();
    assert_eq!((manual[0].scene.as_str(), manual[0].source.as_str()), ("summary", "手动"));
    // AI 再写同一句：被忽略，返回的仍是手动那条。
    let ai = set_with_time(&conn, req("AI", &[("A cat sat.", "comparison"), ("Another one.", "definition")]), "t3").unwrap();
    assert_eq!((ai[0].scene.as_str(), ai[0].source.as_str(), ai[0].updated_at.as_str()), ("summary", "手动", "t2"));
    assert_eq!(ai[1].scene, "definition");
    // 手动可以再改。
    let again = set_with_time(&conn, req("手动", &[("A cat sat.", "concession")]), "t4").unwrap();
    assert_eq!(again[0].scene, "concession");
  }

  #[test]
  fn rejects_bad_input_and_writes_nothing_from_a_bad_batch() {
    let conn = db();
    let bad = |r: SceneSetRequest| set_with_time(&conn, r, "t").unwrap_err();
    assert!(bad(req("机器", &[("x", "summary")])).contains("未知的标签来源"));
    assert!(bad(req("AI", &[])).contains("没有要保存"));
    assert!(bad(req("AI", &[("x", "Summary")])).contains("未知的场景标签"));
    assert!(bad(req("AI", &[(" \n ", "summary")])).contains("空"));
    assert!(bad(req("AI", &[(&"a".repeat(MAX_SENTENCE_CHARS + 1), "summary")])).contains("太长"));
    assert!(bad(req("AI", &[("Good one.", "summary"), ("Bad one.", "nope")])).contains("未知的场景标签"));
    assert!(list_from_conn(&conn).unwrap().is_empty());
  }

  #[test]
  fn scenes_survive_review_word_deletion_and_do_not_touch_other_tables() {
    let conn = db();
    conn.execute_batch(
      "INSERT INTO review_word (id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note, imported_at, updated_at, deleted)
         VALUES ('rv:1', 1, 1, '| word | 1 |', 'word', 'word', '1', 'd', 'L1', 1, '2026-11-12', '原备注', 't', 't', 0);
       INSERT INTO review_definition VALUES ('rv:1', 'a.md', 3, 'n.', 'a unit', '词');
       INSERT INTO review_definition_example VALUES ('rv:1', 'a.md', 3, 1, 'Definition example.', 0);",
    ).unwrap();
    let dump = |sql: &str| -> Vec<String> {
      let mut stmt = conn.prepare(sql).unwrap();
      let count = stmt.column_count();
      stmt.query_map([], |row| Ok((0..count).map(|i| format!("{:?}", row.get::<_, rusqlite::types::Value>(i).unwrap())).collect::<Vec<_>>().join("|"))).unwrap().map(|r| r.unwrap()).collect()
    };
    let tables = ["SELECT * FROM review_word", "SELECT * FROM review_definition_example", "SELECT * FROM vocab_note", "SELECT * FROM vocab_example"];
    let before: Vec<_> = tables.map(dump).concat();
    set_with_time(&conn, req("手动", &[("Definition example.", "definition")]), "t").unwrap();
    assert_eq!(tables.map(dump).concat(), before);
    // 词库行没了（比如重新导入换了一批），标签还在。
    conn.execute("DELETE FROM review_word WHERE id = 'rv:1'", []).unwrap();
    assert_eq!(list_from_conn(&conn).unwrap().len(), 1);
  }

  #[test]
  fn missing_db_lists_empty_without_creating_file() {
    let path = std::env::temp_dir().join(format!("vocab-scenes-{}.db", Uuid::new_v4()));
    assert!(list_at(&path).unwrap().is_empty());
    assert!(!path.exists());
    let saved = set_at(&path, req("AI", &[("A word.", "definition")])).unwrap();
    assert!(chrono::DateTime::parse_from_rfc3339(&saved[0].updated_at).is_ok());
    let before = std::fs::read(&path).unwrap();
    assert_eq!(list_at(&path).unwrap(), saved);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    std::fs::remove_file(&path).unwrap();
  }
}
