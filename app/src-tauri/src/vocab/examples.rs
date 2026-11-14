//! 043 我的例句：用户给词或短语存的例句（AI 按义项给的、自己写的、AI 改过的）。
//!
//! - 单独一张表 `vocab_example`，不写、不改 Hermes 原表格的例句列（`upgrade_example`、`review_definition_example`）。
//! - 按词挂：`word_key` 和 040 笔记用同一个归一化规则（[`super::notes::note_key`]），不引用任何行 ID，
//!   所以同一个词多期、升级库候选里看到的是同一组，重新导入后也不丢、不错位。
//! - 只在本机存着；出题、判分的请求不读这张表。

use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

use super::notes::{display_time, note_key};
use super::schema;

/// 例句来源：AI生成 = AI 按义项给的；自己写 = 用户原句；AI改过 = AI 改后的句子。
pub const EXAMPLE_SOURCES: [&str; 3] = ["AI生成", "自己写", "AI改过"];

/// 一句最多多少字（防误粘贴一整段）。
pub const MAX_SENTENCE_CHARS: usize = 600;
/// 说明、义项、原句最多多少字。
pub const MAX_EXTRA_CHARS: usize = 1000;
/// 一次最多存几句（AI 一次给 2–3 句，留点余量）。
pub const MAX_BATCH: usize = 10;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VocabExample {
  pub id: i64,
  pub word_key: String,
  pub word: String,
  pub sentence: String,
  pub source: String,
  pub explanation: Option<String>,
  pub sense: Option<String>,
  pub original: Option<String>,
  pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExampleItem {
  pub sentence: String,
  pub source: String,
  #[serde(default)]
  pub explanation: Option<String>,
  #[serde(default)]
  pub sense: Option<String>,
  #[serde(default)]
  pub original: Option<String>,
}

/// 给一个词存一句或几句（AI 给的例句用户勾了几句就几句），整批一个事务：有一句不合格就一句都不存。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExampleAddRequest {
  pub word: String,
  pub items: Vec<ExampleItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExampleDeleteRequest {
  pub id: i64,
}

/// 句子是单行的：换行、连续空白合成一个空格，去首尾空白。
fn clean_sentence(sentence: &str) -> Result<String, String> {
  let sentence = sentence.split_whitespace().collect::<Vec<_>>().join(" ");
  if sentence.is_empty() {
    return Err("例句是空的，没有保存".into());
  }
  if sentence.chars().count() > MAX_SENTENCE_CHARS {
    return Err(format!("例句太长了（超过 {MAX_SENTENCE_CHARS} 字），请只存一句"));
  }
  Ok(sentence)
}

/// 可空的附加信息：去首尾空白，空的存 NULL。
fn clean_extra(value: &Option<String>, label: &str) -> Result<Option<String>, String> {
  let Some(text) = value else { return Ok(None) };
  let text = text.replace("\r\n", "\n").replace('\r', "\n");
  let text = text.trim();
  if text.is_empty() {
    return Ok(None);
  }
  if text.chars().count() > MAX_EXTRA_CHARS {
    return Err(format!("{label}太长了（超过 {MAX_EXTRA_CHARS} 字）"));
  }
  Ok(Some(text.to_string()))
}

/// 判重用：不分大小写、空白合一。
fn same_sentence(a: &str, b: &str) -> bool {
  note_key(a) == note_key(b)
}

fn now() -> String {
  chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

const SELECT: &str = "SELECT id, word_key, word, sentence, source, explanation, sense, original, created_at FROM vocab_example";

fn row_to_example(row: &rusqlite::Row<'_>) -> rusqlite::Result<VocabExample> {
  Ok(VocabExample {
    id: row.get(0)?,
    word_key: row.get(1)?,
    word: row.get(2)?,
    sentence: row.get(3)?,
    source: row.get(4)?,
    explanation: row.get(5)?,
    sense: row.get(6)?,
    original: row.get(7)?,
    created_at: row.get(8)?,
  })
}

/// 只读列出全部例句：同一个词的放一起，新的在前。库不存在返回空（不建库）。
pub fn list_at(path: &Path) -> Result<Vec<VocabExample>, String> {
  if !path.exists() {
    return Ok(Vec::new());
  }
  let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
    .map_err(|error| format!("只读打开词库数据库失败：{error}"))?;
  list_from_conn(&conn)
}

pub fn list_from_conn(conn: &Connection) -> Result<Vec<VocabExample>, String> {
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
    .map_err(|error| format!("读取例句失败：{error}"))?;
  let rows = stmt.query_map([], row_to_example).map_err(|error| format!("读取例句失败：{error}"))?;
  rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|error| format!("读取例句失败：{error}"))
}

pub fn add_at(path: &Path, request: ExampleAddRequest) -> Result<Vec<VocabExample>, String> {
  let conn = schema::open(path).map_err(|error| format!("打开词库数据库失败：{error}"))?;
  add_with_time(&conn, request, &now())
}

pub fn add_with_time(conn: &Connection, request: ExampleAddRequest, now: &str) -> Result<Vec<VocabExample>, String> {
  let key = note_key(&request.word);
  if key.is_empty() {
    return Err("没有指定给哪个词存例句".into());
  }
  if request.items.is_empty() {
    return Err("没有选要存的例句".into());
  }
  if request.items.len() > MAX_BATCH {
    return Err(format!("一次最多存 {MAX_BATCH} 句"));
  }
  let word = request.word.split_whitespace().collect::<Vec<_>>().join(" ").replace("**", "");
  // 先把整批都检查一遍，再写。
  let existing: Vec<String> = {
    let mut stmt = conn
      .prepare("SELECT sentence FROM vocab_example WHERE word_key = ?1")
      .map_err(|error| format!("读取例句失败：{error}"))?;
    let rows = stmt.query_map(params![key], |row| row.get(0)).map_err(|error| format!("读取例句失败：{error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|error| format!("读取例句失败：{error}"))?
  };
  let mut rows: Vec<(String, String, Option<String>, Option<String>, Option<String>)> = Vec::with_capacity(request.items.len());
  for item in &request.items {
    if !EXAMPLE_SOURCES.contains(&item.source.as_str()) {
      return Err(format!("未知的例句来源：{}；只能是 {}", item.source, EXAMPLE_SOURCES.join("、")));
    }
    let sentence = clean_sentence(&item.sentence)?;
    if existing.iter().chain(rows.iter().map(|(s, ..)| s)).any(|old| same_sentence(old, &sentence)) {
      return Err(format!("这句已经存过了：{sentence}"));
    }
    let explanation = clean_extra(&item.explanation, "说明")?;
    let sense = clean_extra(&item.sense, "义项")?;
    // 原句只对「AI改过」有意义；其他来源一律不存，免得导出时误标。
    let original = if item.source == "AI改过" { clean_extra(&item.original, "原句")? } else { None };
    rows.push((sentence, item.source.clone(), explanation, sense, original));
  }
  let tx = conn.unchecked_transaction().map_err(|error| format!("保存例句失败：{error}"))?;
  let mut ids = Vec::with_capacity(rows.len());
  for (sentence, source, explanation, sense, original) in &rows {
    tx.execute(
      "INSERT INTO vocab_example (word_key, word, sentence, source, explanation, sense, original, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      params![key, word, sentence, source, explanation, sense, original, now],
    )
    .map_err(|error| format!("保存例句失败：{error}"))?;
    ids.push(tx.last_insert_rowid());
  }
  tx.commit().map_err(|error| format!("保存例句失败：{error}"))?;
  ids
    .into_iter()
    .map(|id| conn.query_row(&format!("{SELECT} WHERE id = ?1"), params![id], row_to_example).map_err(|error| format!("读取例句失败：{error}")))
    .collect()
}

pub fn delete_at(path: &Path, request: ExampleDeleteRequest) -> Result<i64, String> {
  let conn = schema::open(path).map_err(|error| format!("打开词库数据库失败：{error}"))?;
  delete_in(&conn, request)
}

pub fn delete_in(conn: &Connection, request: ExampleDeleteRequest) -> Result<i64, String> {
  let changed = conn
    .execute("DELETE FROM vocab_example WHERE id = ?1", params![request.id])
    .map_err(|error| format!("删除例句失败：{error}"))?;
  if changed == 0 {
    return Err("这条例句不存在（可能已经删掉了）".into());
  }
  Ok(request.id)
}

/// 导出成 `我的例句.md`：按词分组（按键的字母序），组内新的在前，每句标来源和日期。
/// 没有例句返回 None（不写文件）。
pub fn render_markdown(examples: &[VocabExample]) -> Option<String> {
  if examples.is_empty() {
    return None;
  }
  let mut groups: BTreeMap<&str, Vec<&VocabExample>> = BTreeMap::new();
  for example in examples {
    groups.entry(example.word_key.as_str()).or_default().push(example);
  }
  let mut lines = vec![
    "# 我的例句".to_string(),
    String::new(),
    format!("共 {} 个词、{} 句。按词分组，新的在前；「AI生成」是 AI 按义项给的，「自己写」是自己的原句，「AI改过」是 AI 改后的句子。", groups.len(), examples.len()),
  ];
  for list in groups.values_mut() {
    list.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    let title = list.iter().min_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id))).map(|e| e.word.as_str()).unwrap_or("");
    lines.push(String::new());
    lines.push(format!("## {title}"));
    lines.push(String::new());
    for example in list.iter() {
      lines.push(format!("- {}", example.sentence));
      lines.push(format!("  - 来源：{} · {}", example.source, display_time(&example.created_at)));
      if let Some(sense) = &example.sense {
        lines.push(format!("  - 义项：{}", sense.replace('\n', " ")));
      }
      if let Some(original) = &example.original {
        lines.push(format!("  - 原句：{}", original.replace('\n', " ")));
      }
      if let Some(explanation) = &example.explanation {
        lines.push(format!("  - 说明：{}", explanation.replace('\n', " ")));
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

  fn item(sentence: &str, source: &str) -> ExampleItem {
    ExampleItem { sentence: sentence.into(), source: source.into(), explanation: None, sense: None, original: None }
  }

  fn add(conn: &Connection, word: &str, items: Vec<ExampleItem>, time: &str) -> Vec<VocabExample> {
    add_with_time(conn, ExampleAddRequest { word: word.into(), items }, time).unwrap()
  }

  #[test]
  fn key_follows_note_normalization() {
    let conn = db();
    let a = add(&conn, "  In the Light\tof ", vec![item("In the light of the new data, we changed the plan.", "自己写")], "t1");
    let b = add(&conn, "**in  the light of**", vec![item("In the light of recent events, the trip was cancelled.", "AI生成")], "t2");
    assert_eq!(a[0].word_key, "in the light of");
    assert_eq!(b[0].word_key, a[0].word_key);
    assert_eq!(a[0].word, "In the Light of");
    let c = add(&conn, "students’ work", vec![item("We marked the students’ work.", "自己写")], "t3");
    assert_eq!(c[0].word_key, "students' work");
  }

  #[test]
  fn batch_add_list_and_delete() {
    let conn = db();
    let saved = add(&conn, "Resilient", vec![
      ExampleItem { sentence: " The local economy proved\n resilient after the flood. ".into(), source: "AI生成".into(), explanation: Some("搭配：prove resilient".into()), sense: Some("adj. able to recover quickly".into()), original: Some("不该存".into()) },
      ExampleItem { sentence: "Resilient students recover quickly from a bad exam.".into(), source: "AI生成".into(), explanation: Some("  ".into()), sense: None, original: None },
    ], "2026-11-10T01:00:00.000Z");
    assert_eq!(saved.len(), 2);
    assert_eq!(saved[0].sentence, "The local economy proved resilient after the flood.");
    assert_eq!(saved[0].explanation.as_deref(), Some("搭配：prove resilient"));
    assert_eq!(saved[0].sense.as_deref(), Some("adj. able to recover quickly"));
    assert_eq!(saved[0].original, None, "只有 AI改过 才存原句");
    assert_eq!(saved[1].explanation, None, "空说明存 NULL");
    let fixed = add(&conn, "resilient", vec![ExampleItem {
      sentence: "Our team remained resilient despite the setback.".into(), source: "AI改过".into(),
      explanation: Some("resilient 是形容词，前面要有系动词。".into()), sense: None, original: Some("Our team resilient despite the setback.".into()),
    }], "2026-11-10T02:00:00.000Z");
    assert_eq!(fixed[0].original.as_deref(), Some("Our team resilient despite the setback."));
    let other = add(&conn, "allocate", vec![item("The council will allocate more funds to libraries.", "自己写")], "2026-11-10T03:00:00.000Z");

    let all = list_from_conn(&conn).unwrap();
    let ids: Vec<_> = all.iter().map(|e| e.id).collect();
    // 先按键排；同键新的在前，同一时刻 ID 大的在前。
    assert_eq!(ids, [other[0].id, fixed[0].id, saved[1].id, saved[0].id]);

    assert_eq!(delete_in(&conn, ExampleDeleteRequest { id: saved[0].id }).unwrap(), saved[0].id);
    assert!(delete_in(&conn, ExampleDeleteRequest { id: saved[0].id }).unwrap_err().contains("不存在"));
    assert_eq!(list_from_conn(&conn).unwrap().len(), 3);
  }

  #[test]
  fn rejects_bad_input_and_writes_nothing_from_a_bad_batch() {
    let conn = db();
    let bad = |word: &str, items: Vec<ExampleItem>| add_with_time(&conn, ExampleAddRequest { word: word.into(), items }, "t").unwrap_err();
    assert!(bad("  ", vec![item("x", "自己写")]).contains("哪个词"));
    assert!(bad("word", vec![]).contains("没有选"));
    assert!(bad("word", vec![item(" \n ", "自己写")]).contains("空"));
    assert!(bad("word", vec![item("x", "模型")]).contains("未知的例句来源"));
    assert!(bad("word", vec![item(&"a".repeat(MAX_SENTENCE_CHARS + 1), "自己写")]).contains("太长"));
    assert!(bad("word", (0..=MAX_BATCH).map(|i| item(&format!("Word {i}."), "AI生成")).collect()).contains("最多"));
    // 第二句不合格：第一句也不存。
    assert!(bad("word", vec![item("A good word.", "AI生成"), item("x", "猜的")]).contains("未知"));
    // 同一批里重复、和已存的重复（不分大小写、空白）都拒绝。
    assert!(bad("word", vec![item("A good word.", "AI生成"), item("a  GOOD word.", "AI生成")]).contains("存过"));
    assert_eq!(list_from_conn(&conn).unwrap().len(), 0);
    add(&conn, "Word", vec![item("A good word.", "自己写")], "t");
    assert!(bad("word", vec![item("A  good word.", "AI改过")]).contains("存过"));
    assert_eq!(list_from_conn(&conn).unwrap().len(), 1);
  }

  #[test]
  fn examples_do_not_touch_hermes_example_tables_or_notes() {
    let conn = db();
    conn.execute_batch(
      "INSERT INTO review_word (id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note, imported_at, updated_at, deleted)
         VALUES ('rv:1', 1, 1, '| word | 1 |', 'word', 'word', '1', 'd', 'L1', 1, '2026-11-12', '原备注', 't', 't', 0);
       INSERT INTO upgrade_entry VALUES ('up:1', 1, 1, '| a |', 'a', '**word**', 's', '升级备注', 't', 't', 0);
       INSERT INTO upgrade_example VALUES ('up:1', 1, 'word', 'Hermes 原例句.', 0);
       INSERT INTO review_definition VALUES ('rv:1', 'a.md', 3, 'n.', 'a unit', '词');
       INSERT INTO review_definition_example VALUES ('rv:1', 'a.md', 3, 1, 'Definition example.', 0);",
    ).unwrap();
    let dump = |sql: &str| -> Vec<String> {
      let mut stmt = conn.prepare(sql).unwrap();
      let count = stmt.column_count();
      stmt.query_map([], |row| Ok((0..count).map(|i| format!("{:?}", row.get::<_, rusqlite::types::Value>(i).unwrap())).collect::<Vec<_>>().join("|"))).unwrap().map(|r| r.unwrap()).collect()
    };
    let before: Vec<_> = ["SELECT * FROM review_word", "SELECT * FROM upgrade_example", "SELECT * FROM review_definition_example", "SELECT * FROM vocab_note"].map(dump).concat();
    let saved = add(&conn, "word", vec![item("My own word sentence.", "自己写")], "t1");
    delete_in(&conn, ExampleDeleteRequest { id: saved[0].id }).unwrap();
    let after: Vec<_> = ["SELECT * FROM review_word", "SELECT * FROM upgrade_example", "SELECT * FROM review_definition_example", "SELECT * FROM vocab_note"].map(dump).concat();
    assert_eq!(after, before);
  }

  #[test]
  fn missing_db_lists_empty_without_creating_file_and_list_is_read_only() {
    let path = std::env::temp_dir().join(format!("vocab-examples-{}.db", Uuid::new_v4()));
    assert!(list_at(&path).unwrap().is_empty());
    assert!(!path.exists());
    let saved = add_at(&path, ExampleAddRequest { word: "word".into(), items: vec![item("A word.", "自己写")] }).unwrap();
    assert!(chrono::DateTime::parse_from_rfc3339(&saved[0].created_at).is_ok());
    let before = std::fs::read(&path).unwrap();
    assert_eq!(list_at(&path).unwrap(), saved);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    std::fs::remove_file(&path).unwrap();
  }

  #[test]
  fn markdown_groups_by_word_newest_first_with_source() {
    assert_eq!(render_markdown(&[]), None);
    let conn = db();
    add(&conn, "Resilient", vec![ExampleItem {
      sentence: "Cities must become more resilient to floods.".into(), source: "AI生成".into(),
      explanation: Some("搭配：resilient to sth".into()), sense: Some("adj. able to recover quickly".into()), original: None,
    }], "2026-11-09T01:00:00.000Z");
    add(&conn, "resilient", vec![ExampleItem {
      sentence: "Our team remained resilient despite the setback.".into(), source: "AI改过".into(),
      explanation: Some("前面要有系动词。".into()), sense: None, original: Some("Our team resilient despite the setback.".into()),
    }], "2026-11-10T01:00:00.000Z");
    add(&conn, "Allocate", vec![item("We allocate an hour to reading every day.", "自己写")], "2026-11-08T01:00:00.000Z");
    let text = render_markdown(&list_from_conn(&conn).unwrap()).unwrap();
    let t = |s: &str| display_time(s);
    let expected = [
      "# 我的例句".to_string(),
      String::new(),
      "共 2 个词、3 句。按词分组，新的在前；「AI生成」是 AI 按义项给的，「自己写」是自己的原句，「AI改过」是 AI 改后的句子。".into(),
      String::new(),
      "## Allocate".into(),
      String::new(),
      "- We allocate an hour to reading every day.".into(),
      format!("  - 来源：自己写 · {}", t("2026-11-08T01:00:00.000Z")),
      String::new(),
      "## Resilient".into(),
      String::new(),
      "- Our team remained resilient despite the setback.".into(),
      format!("  - 来源：AI改过 · {}", t("2026-11-10T01:00:00.000Z")),
      "  - 原句：Our team resilient despite the setback.".into(),
      "  - 说明：前面要有系动词。".into(),
      "- Cities must become more resilient to floods.".into(),
      format!("  - 来源：AI生成 · {}", t("2026-11-09T01:00:00.000Z")),
      "  - 义项：adj. able to recover quickly".into(),
      "  - 说明：搭配：resilient to sth".into(),
      String::new(),
    ].join("\n");
    assert_eq!(text, expected);
  }
}
