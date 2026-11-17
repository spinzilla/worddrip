//! 081 每日新词：候选池（表 `wordpack_pick`）。
//!
//! 内置词表里的词不直接进复习：先进候选池，用户每个词决定去向——
//! - `known` 认识，跳过；
//! - `taken` 收下，写进词库，状态 🌱待考察，之后走首考 → 复习；
//! - `later` 以后再说，过 7 天再出现（7 天的判断在前端 utils/vocab/dailyWords.ts）。
//!
//! 收下（[`take_with_time`]）直接复用 042 手动加词的写入（manual.rs），所以状态、原始行、查证状态都和手动加的一样；
//! 英文释义写进 078 的 `vocab_definition_en`（source = dict:ecdict）。音标没有单独的字段，跟在词性后面（如 `vt. /əˈbændən/`）。
//! 撤销（[`undo_with_time`]）把这个词恢复成操作前的样子：收下的词连同释义一起删掉。

use chrono::NaiveDate;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

use super::definition_en::{self, DefinitionEnAddRequest, DefinitionEnItem};
use super::manual::{self, ManualAddRequest};
use super::notes::note_key;
use super::schema;

/// 英英释义来源：内置词表里的英文释义来自 ECDICT。
pub const SOURCE_ECDICT: &str = "dict:ecdict";
const STATES: [&str; 3] = ["known", "taken", "later"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PickRow {
  pub word_key: String,
  pub word: String,
  pub state: String,
  pub pack: String,
  pub decided_at: String,
  pub updated_at: String,
}

/// 079 的词汇量测试、081 的「认识 / 以后再说」都用它写。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickItem {
  pub word: String,
  /// known 或 later（taken 只能走「收下」）
  pub state: String,
  #[serde(default)]
  pub pack: String,
  /// 本机日期 YYYY-MM-DD
  pub date: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeRequest {
  pub word: String,
  /// 词表标签，如「四级」；来源写成「词表·四级」
  #[serde(default)]
  pub pack: String,
  #[serde(default)]
  pub pos: String,
  #[serde(default)]
  pub phonetic: String,
  #[serde(default)]
  pub chinese: String,
  /// 英文释义，每条一项（最多存 3 条）
  #[serde(default)]
  pub english: Vec<String>,
  /// 期号（月.日）和入库日期，前端按本机日期给
  pub issue: String,
  pub date: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TakeResult {
  /// 新写进复习库的词条 id；词库里本来就有这个词时为空（没有重复写）
  pub id: Option<String>,
  pub definition_en_ids: Vec<i64>,
  pub source: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoRequest {
  pub word: String,
  /// 这个词操作前的去向；没有就是原来不在候选池里
  #[serde(default)]
  pub previous: Option<PickRow>,
  #[serde(default)]
  pub take_id: Option<String>,
  #[serde(default)]
  pub definition_en_ids: Vec<i64>,
}

fn now() -> String {
  chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn check_date(date: &str) -> Result<(), String> {
  NaiveDate::parse_from_str(date, "%Y-%m-%d").map(|_| ()).map_err(|_| "日期必须是有效的 YYYY-MM-DD".to_string())
}

fn db_err(what: &str, error: rusqlite::Error) -> String {
  format!("{what}失败：{error}")
}

fn open(path: &Path) -> Result<Connection, String> {
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent).map_err(|error| format!("创建词库数据目录失败：{error}"))?;
  }
  schema::open(path).map_err(|error| format!("打开词库数据库失败：{error}"))
}

pub fn list_at(path: &Path) -> Result<Vec<PickRow>, String> {
  list_in(&open(path)?)
}

pub fn list_in(conn: &Connection) -> Result<Vec<PickRow>, String> {
  let mut stmt = conn
    .prepare("SELECT word_key, word, state, pack, decided_at, updated_at FROM wordpack_pick ORDER BY decided_at, word_key")
    .map_err(|error| db_err("读取候选池", error))?;
  let rows = stmt
    .query_map([], |row| {
      Ok(PickRow { word_key: row.get(0)?, word: row.get(1)?, state: row.get(2)?, pack: row.get(3)?, decided_at: row.get(4)?, updated_at: row.get(5)? })
    })
    .map_err(|error| db_err("读取候选池", error))?;
  rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|error| db_err("读取候选池", error))
}

fn upsert(conn: &Connection, word: &str, key: &str, state: &str, pack: &str, date: &str, now: &str) -> Result<(), String> {
  conn
    .execute(
      "INSERT INTO wordpack_pick (word_key, word, state, pack, decided_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(word_key) DO UPDATE SET word = excluded.word, state = excluded.state, pack = excluded.pack,
         decided_at = excluded.decided_at, updated_at = excluded.updated_at",
      params![key, word, state, pack, date, now],
    )
    .map(|_| ())
    .map_err(|error| db_err("保存候选池", error))
}

pub fn set_at(path: &Path, items: Vec<PickItem>) -> Result<usize, String> {
  set_with_time(&open(path)?, items, &now())
}

/// 认识 / 以后再说（批量，一个事务）。已经「收下」的词不会被降级成认识。
pub fn set_with_time(conn: &Connection, items: Vec<PickItem>, now: &str) -> Result<usize, String> {
  for item in &items {
    if item.state != "known" && item.state != "later" {
      return Err(format!("只能记成「认识」或「以后再说」，不能是：{}", item.state));
    }
    check_date(&item.date)?;
    if note_key(&item.word).is_empty() {
      return Err("词是空的".into());
    }
  }
  let tx = conn.unchecked_transaction().map_err(|error| db_err("保存候选池", error))?;
  let mut written = 0;
  for item in &items {
    let key = note_key(&item.word);
    let taken: Option<String> = tx
      .query_row("SELECT state FROM wordpack_pick WHERE word_key = ?1 AND state = 'taken'", [&key], |row| row.get(0))
      .optional()
      .map_err(|error| db_err("读取候选池", error))?;
    if taken.is_some() {
      continue;
    }
    upsert(&tx, item.word.trim(), &key, &item.state, item.pack.trim(), &item.date, now)?;
    written += 1;
  }
  tx.commit().map_err(|error| db_err("保存候选池", error))?;
  Ok(written)
}

/// 079 重测词汇量：只清掉某个来源（pack）自动记下的「认识」。用户手动决定过的词（pack 是词表名、收下、以后再说）不会动。
pub fn clear_known_at(path: &Path, pack: &str) -> Result<usize, String> {
  clear_known_in(&open(path)?, pack)
}

pub fn clear_known_in(conn: &Connection, pack: &str) -> Result<usize, String> {
  let pack = pack.trim();
  if pack.is_empty() {
    return Err("来源是空的".into());
  }
  conn
    .execute("DELETE FROM wordpack_pick WHERE state = 'known' AND pack = ?1", [pack])
    .map_err(|error| db_err("清理候选池", error))
}

/// 词性后面跟音标：`vt. /əˈbændən/`；两样都没有就是空。
fn pos_with_phonetic(pos: &str, phonetic: &str) -> String {
  let pos = pos.split_whitespace().collect::<Vec<_>>().join(" ");
  let phonetic = phonetic.trim().trim_matches('/').trim();
  let combined = if phonetic.is_empty() { pos.clone() } else if pos.is_empty() { format!("/{phonetic}/") } else { format!("{pos} /{phonetic}/") };
  if combined.chars().count() > 60 { pos } else { combined }
}

pub fn take_at(path: &Path, request: TakeRequest) -> Result<TakeResult, String> {
  take_with_time(&open(path)?, request, &now())
}

pub fn take_with_time(conn: &Connection, request: TakeRequest, now: &str) -> Result<TakeResult, String> {
  check_date(&request.date)?;
  let key = note_key(&request.word);
  if key.is_empty() {
    return Err("词是空的".into());
  }
  let word = request.word.split_whitespace().collect::<Vec<_>>().join(" ");
  let pack = request.pack.trim().to_string();
  let source = if pack.is_empty() { "词表".to_string() } else { format!("词表·{pack}") };
  let norm = manual::normalized_word(&word);
  let existing: i64 = conn
    .query_row("SELECT COUNT(*) FROM review_word WHERE word_norm = ?1 AND deleted = 0", [&norm], |row| row.get(0))
    .map_err(|error| db_err("检查已有词条", error))?;
  let mut id = None;
  let mut definition_en_ids = Vec::new();
  if existing == 0 {
    let added = manual::add_with_time(
      conn,
      ManualAddRequest {
        word: word.clone(),
        pos: pos_with_phonetic(&request.pos, &request.phonetic),
        chinese: request.chinese.clone(),
        english: String::new(),
        example: String::new(),
        source: source.clone(),
        issue: request.issue.clone(),
        date: request.date.clone(),
        note: String::new(),
        allow_duplicate: false,
      },
      now,
    )?;
    id = Some(added.id);
    let items: Vec<DefinitionEnItem> = request
      .english
      .iter()
      .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
      .filter(|text| !text.is_empty())
      .take(3)
      .map(|text| DefinitionEnItem { pos: None, text: text.chars().take(500).collect() })
      .collect();
    if !items.is_empty() {
      // 英英释义写不进去不影响收词（词和中文释义已经在库里了）
      if let Ok(rows) = definition_en::add_with_time(conn, DefinitionEnAddRequest { word: word.clone(), source: SOURCE_ECDICT.into(), items }, now) {
        definition_en_ids = rows.into_iter().map(|row| row.id).collect();
      }
    }
  }
  upsert(conn, &word, &key, "taken", &pack, &request.date, now)?;
  Ok(TakeResult { id, definition_en_ids, source })
}

pub fn undo_at(path: &Path, request: UndoRequest) -> Result<(), String> {
  undo_with_time(&open(path)?, request, &now())
}

/// 把一个词恢复成操作前的样子；收下写进库的词条和英英释义一并删掉。
pub fn undo_with_time(conn: &Connection, request: UndoRequest, now: &str) -> Result<(), String> {
  let key = note_key(&request.word);
  if key.is_empty() {
    return Err("词是空的".into());
  }
  if let Some(previous) = &request.previous {
    if !STATES.contains(&previous.state.as_str()) {
      return Err(format!("未知的候选池状态：{}", previous.state));
    }
    check_date(&previous.decided_at)?;
  }
  let tx = conn.unchecked_transaction().map_err(|error| db_err("撤销", error))?;
  for id in &request.definition_en_ids {
    tx.execute("DELETE FROM vocab_definition_en WHERE id = ?1 AND word_key = ?2 AND source = ?3", params![id, key, SOURCE_ECDICT])
      .map_err(|error| db_err("撤销", error))?;
  }
  if let Some(id) = &request.take_id {
    // 只删「词表」来源、还没复习过（仍是待考察）的词条，避免误删别的
    tx.execute("DELETE FROM review_word WHERE id = ?1 AND source LIKE '词表%' AND status = '🌱待考察'", [id])
      .map_err(|error| db_err("撤销", error))?;
  }
  match &request.previous {
    Some(previous) => upsert(&tx, &previous.word, &key, &previous.state, &previous.pack, &previous.decided_at, now)?,
    None => {
      tx.execute("DELETE FROM wordpack_pick WHERE word_key = ?1", [&key]).map_err(|error| db_err("撤销", error))?;
    }
  }
  tx.commit().map_err(|error| db_err("撤销", error))
}

// ───────────────────────── 学习计划（表 daily_plan，单行） ─────────────────────────

/// 学习计划：选哪些词表、每天几个、词库页卡片开关。079 的首次引导也写这里。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanRow {
  pub packs: Vec<String>,
  pub per_day: i64,
  pub card_on: bool,
  #[serde(default)]
  pub updated_at: String,
}

pub fn plan_get_at(path: &Path) -> Result<Option<PlanRow>, String> {
  plan_get_in(&open(path)?)
}

pub fn plan_get_in(conn: &Connection) -> Result<Option<PlanRow>, String> {
  let row = conn
    .query_row("SELECT packs, per_day, card_on, updated_at FROM daily_plan WHERE id = 'default'", [], |row| {
      Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?))
    })
    .optional()
    .map_err(|error| db_err("读取学习计划", error))?;
  Ok(row.map(|(packs, per_day, card_on, updated_at)| PlanRow {
    // 别的设备传来的 packs 万一不是合法 JSON，当成没选，不让界面崩
    packs: serde_json::from_str(&packs).unwrap_or_default(),
    per_day,
    card_on: card_on != 0,
    updated_at,
  }))
}

pub fn plan_set_at(path: &Path, plan: PlanRow) -> Result<PlanRow, String> {
  plan_set_with_time(&open(path)?, plan, &now())
}

/// 整行覆盖写入（按 updated_at 新的为准由同步合并负责）。词表标签去重，每天个数限制在 1–100。
pub fn plan_set_with_time(conn: &Connection, plan: PlanRow, now: &str) -> Result<PlanRow, String> {
  let mut packs: Vec<String> = Vec::new();
  for tag in plan.packs {
    let tag = tag.trim().to_string();
    if !tag.is_empty() && !packs.contains(&tag) {
      packs.push(tag);
    }
  }
  let saved = PlanRow { packs, per_day: plan.per_day.clamp(1, 100), card_on: plan.card_on, updated_at: now.to_string() };
  let json = serde_json::to_string(&saved.packs).map_err(|error| format!("保存学习计划失败：{error}"))?;
  conn
    .execute(
      "INSERT INTO daily_plan (id, packs, per_day, card_on, updated_at) VALUES ('default', ?1, ?2, ?3, ?4)
       ON CONFLICT(id) DO UPDATE SET packs = excluded.packs, per_day = excluded.per_day, card_on = excluded.card_on, updated_at = excluded.updated_at",
      params![json, saved.per_day, saved.card_on as i64, now],
    )
    .map_err(|error| db_err("保存学习计划", error))?;
  Ok(saved)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn plan_is_a_single_row_saved_cleaned_and_read_back() {
    let conn = db();
    assert_eq!(plan_get_in(&conn).unwrap(), None);
    let plan = PlanRow { packs: vec!["cet4".into(), "cet4".into(), " ngsl ".into(), "".into()], per_day: 500, card_on: false, updated_at: String::new() };
    plan_set_with_time(&conn, plan, "2026-11-14T01:00:00.000Z").unwrap();
    plan_set_with_time(&conn, PlanRow { packs: vec!["gre".into()], per_day: 0, card_on: true, updated_at: String::new() }, "2026-11-14T02:00:00.000Z").unwrap();
    assert_eq!(n(&conn, "SELECT COUNT(*) FROM daily_plan"), 1);
    let got = plan_get_in(&conn).unwrap().unwrap();
    assert_eq!((got.packs, got.per_day, got.card_on, got.updated_at.as_str()), (vec!["gre".to_string()], 1, true, "2026-11-14T02:00:00.000Z"));
    plan_set_with_time(&conn, PlanRow { packs: vec!["cet4".into(), "cet4".into(), " ngsl ".into()], per_day: 500, card_on: false, updated_at: String::new() }, "t").unwrap();
    let got = plan_get_in(&conn).unwrap().unwrap();
    assert_eq!((got.packs, got.per_day, got.card_on), (vec!["cet4".to_string(), "ngsl".to_string()], 100, false));
    // 只允许 id = 'default' 一行
    assert!(conn.execute("INSERT INTO daily_plan (id, packs, per_day, card_on, updated_at) VALUES ('other', '[]', 10, 1, 't')", []).is_err());
  }

  fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    schema::migrate(&conn).unwrap();
    conn
  }

  fn take_req(word: &str) -> TakeRequest {
    TakeRequest {
      word: word.into(),
      pack: "四级".into(),
      pos: "vt.".into(),
      phonetic: "ə'bændən".into(),
      chinese: "放弃；遗弃".into(),
      english: vec!["to give up completely".into(), "to leave behind".into(), "x".into(), "dropped".into()],
      issue: "11.14".into(),
      date: "2026-11-14".into(),
    }
  }

  fn n(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
  }

  #[test]
  fn take_writes_seed_word_with_source_definitions_and_pick_row() {
    let conn = db();
    let result = take_with_time(&conn, take_req("Abandon"), "2026-11-14T01:00:00.000Z").unwrap();
    assert_eq!(result.source, "词表·四级");
    let id = result.id.unwrap();
    let (status, source, verification): (String, String, String) =
      conn.query_row("SELECT status, source, verification_status FROM review_word WHERE id = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    assert_eq!((status.as_str(), source.as_str(), verification.as_str()), ("🌱待考察", "词表·四级", "未查证"));
    let (pos, chinese): (String, String) =
      conn.query_row("SELECT pos, chinese FROM review_definition WHERE word_id = ?1", [&id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((pos.as_str(), chinese.as_str()), ("vt. /ə'bændən/", "放弃；遗弃"));
    // 英英释义最多 3 条，来源 dict:ecdict
    assert_eq!(n(&conn, "SELECT COUNT(*) FROM vocab_definition_en WHERE word_key = 'abandon' AND source = 'dict:ecdict'"), 3);
    assert_eq!(result.definition_en_ids.len(), 3);
    let rows = list_in(&conn).unwrap();
    assert_eq!((rows.len(), rows[0].state.as_str(), rows[0].pack.as_str(), rows[0].word_key.as_str()), (1, "taken", "四级", "abandon"));
  }

  #[test]
  fn take_does_not_duplicate_a_word_already_in_library() {
    let conn = db();
    take_with_time(&conn, take_req("abandon"), "2026-11-14T01:00:00.000Z").unwrap();
    let again = take_with_time(&conn, take_req("ABANDON"), "2026-11-14T02:00:00.000Z").unwrap();
    assert!(again.id.is_none());
    assert_eq!(n(&conn, "SELECT COUNT(*) FROM review_word"), 1);
    assert_eq!(n(&conn, "SELECT COUNT(*) FROM vocab_definition_en"), 3);
  }

  #[test]
  fn set_known_and_later_never_downgrades_taken() {
    let conn = db();
    take_with_time(&conn, take_req("abandon"), "2026-11-14T01:00:00.000Z").unwrap();
    let items = vec![
      PickItem { word: "abandon".into(), state: "known".into(), pack: "四级".into(), date: "2026-11-15".into() },
      PickItem { word: "Ability".into(), state: "known".into(), pack: "四级".into(), date: "2026-11-15".into() },
      PickItem { word: "able".into(), state: "later".into(), pack: "".into(), date: "2026-11-15".into() },
    ];
    assert_eq!(set_with_time(&conn, items, "2026-11-15T01:00:00.000Z").unwrap(), 2);
    let rows = list_in(&conn).unwrap();
    let state = |key: &str| rows.iter().find(|r| r.word_key == key).unwrap().state.clone();
    assert_eq!((state("abandon"), state("ability"), state("able")), ("taken".into(), "known".into(), "later".into()));
    assert!(set_with_time(&conn, vec![PickItem { word: "x".into(), state: "taken".into(), pack: "".into(), date: "2026-11-15".into() }], "t").is_err());
    assert!(set_with_time(&conn, vec![PickItem { word: "x".into(), state: "known".into(), pack: "".into(), date: "昨天".into() }], "t").is_err());
  }

  #[test]
  fn clear_known_only_removes_the_given_source() {
    let conn = db();
    let item = |word: &str, state: &str, pack: &str| PickItem { word: word.into(), state: state.into(), pack: pack.into(), date: "2026-11-15".into() };
    set_with_time(&conn, vec![item("able", "known", "test-estimate"), item("about", "known", "test-estimate"), item("act", "known", "test"), item("add", "known", "四级"), item("age", "later", "test-estimate")], "t").unwrap();
    assert_eq!(clear_known_in(&conn, "test-estimate").unwrap(), 2);
    let keys: Vec<String> = list_in(&conn).unwrap().into_iter().map(|r| r.word_key).collect();
    assert_eq!(keys, vec!["act", "add", "age"]);
    assert!(clear_known_in(&conn, " ").is_err());
  }

  #[test]
  fn undo_take_removes_word_definitions_and_pick_row() {
    let conn = db();
    let result = take_with_time(&conn, take_req("abandon"), "2026-11-14T01:00:00.000Z").unwrap();
    undo_with_time(
      &conn,
      UndoRequest { word: "abandon".into(), previous: None, take_id: result.id.clone(), definition_en_ids: result.definition_en_ids.clone() },
      "2026-11-14T01:05:00.000Z",
    )
    .unwrap();
    for table in ["review_word", "review_definition", "vocab_definition_en", "wordpack_pick"] {
      assert_eq!(n(&conn, &format!("SELECT COUNT(*) FROM {table}")), 0, "{table}");
    }
  }

  #[test]
  fn undo_restores_previous_state() {
    let conn = db();
    set_with_time(&conn, vec![PickItem { word: "able".into(), state: "later".into(), pack: "四级".into(), date: "2026-11-01".into() }], "2026-11-01T01:00:00.000Z").unwrap();
    let previous = list_in(&conn).unwrap().remove(0);
    set_with_time(&conn, vec![PickItem { word: "able".into(), state: "known".into(), pack: "四级".into(), date: "2026-11-14".into() }], "2026-11-14T01:00:00.000Z").unwrap();
    undo_with_time(&conn, UndoRequest { word: "able".into(), previous: Some(previous), take_id: None, definition_en_ids: vec![] }, "2026-11-14T01:01:00.000Z").unwrap();
    let rows = list_in(&conn).unwrap();
    assert_eq!((rows[0].state.as_str(), rows[0].decided_at.as_str()), ("later", "2026-11-01"));
  }

  #[test]
  fn undo_never_deletes_a_word_that_was_already_reviewed() {
    let conn = db();
    let result = take_with_time(&conn, take_req("abandon"), "2026-11-14T01:00:00.000Z").unwrap();
    let id = result.id.clone().unwrap();
    conn.execute("UPDATE review_word SET status = 'L1' WHERE id = ?1", [&id]).unwrap();
    undo_with_time(&conn, UndoRequest { word: "abandon".into(), previous: None, take_id: result.id, definition_en_ids: vec![] }, "t").unwrap();
    assert_eq!(n(&conn, "SELECT COUNT(*) FROM review_word"), 1);
  }

  #[test]
  fn phonetic_goes_after_pos_and_is_dropped_when_too_long() {
    assert_eq!(pos_with_phonetic("n.", "/ˈbɔːdə/"), "n. /ˈbɔːdə/");
    assert_eq!(pos_with_phonetic("", "x"), "/x/");
    assert_eq!(pos_with_phonetic("n.", ""), "n.");
    assert_eq!(pos_with_phonetic("n.", &"a".repeat(70)), "n.");
  }
}
