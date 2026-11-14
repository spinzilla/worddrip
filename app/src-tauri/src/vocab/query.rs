use super::models::{BrowseData, BrowseDefinition, BrowseDefinitionExample, BrowseExample, BrowseReviewWord, BrowseSelfCheck, BrowseUpgrade, CoachArchiveData, CoachBatch, CoachItem, CoachTodo, CoachTop};
use super::schema::SCHEMA_VERSION;
use rusqlite::{Connection, OpenFlags};
use std::collections::HashMap;
use std::path::Path;

fn err(what: &str, error: rusqlite::Error) -> String {
  format!("读取{what}失败：{error}")
}

/// 只读浏览查询：库不存在返回空数据（不建库）；版本不是 v1 明确报错；全程不写任何表。
pub fn browse_at(path: &Path) -> Result<BrowseData, String> {
  if !path.exists() {
    return Ok(BrowseData::default());
  }
  let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
    .map_err(|error| format!("只读打开词库数据库失败：{error}"))?;
  browse_from_conn(&conn)
}

pub fn browse_from_conn(conn: &Connection) -> Result<BrowseData, String> {
  let version: i32 = conn
    .query_row("PRAGMA user_version", [], |row| row.get(0))
    .map_err(|error| err("数据库版本", error))?;
  if version == 0 {
    // 文件存在但尚未建表（例如只有空文件），按空库处理。
    return Ok(BrowseData::default());
  }
  if version != SCHEMA_VERSION {
    return Err(format!(
      "词库数据库版本 {version} 与本应用支持的版本 {SCHEMA_VERSION} 不兼容，已停止读取"
    ));
  }

  // 例句按词条分组，组内按 seq 排序。
  let mut examples: HashMap<String, Vec<BrowseExample>> = HashMap::new();
  {
    let mut stmt = conn
      .prepare(
        "SELECT e.entry_id, e.seq, e.cand, e.sentence, e.ai
         FROM upgrade_example e
         JOIN upgrade_entry u ON u.id = e.entry_id AND u.deleted = 0
         ORDER BY e.entry_id, e.seq",
      )
      .map_err(|error| err("例句", error))?;
    let rows = stmt
      .query_map([], |row| {
        Ok((
          row.get::<_, String>(0)?,
          BrowseExample {
            seq: row.get(1)?,
            cand: row.get(2)?,
            sentence: row.get(3)?,
            ai: row.get::<_, i64>(4)? != 0,
          },
        ))
      })
      .map_err(|error| err("例句", error))?;
    for row in rows {
      let (id, example) = row.map_err(|error| err("例句", error))?;
      examples.entry(id).or_default().push(example);
    }
  }

  let upgrades = {
    let mut stmt = conn
      .prepare(
        "SELECT id, ord, line, raw, plain, upgrade, source, note
         FROM upgrade_entry WHERE deleted = 0 ORDER BY ord, id",
      )
      .map_err(|error| err("升级词", error))?;
    let rows = stmt
      .query_map([], |row| {
        Ok(BrowseUpgrade {
          id: row.get(0)?,
          ord: row.get(1)?,
          line: row.get(2)?,
          raw: row.get(3)?,
          plain: row.get(4)?,
          upgrade: row.get(5)?,
          source: row.get(6)?,
          note: row.get(7)?,
          examples: Vec::new(),
        })
      })
      .map_err(|error| err("升级词", error))?;
    let mut list = rows
      .collect::<rusqlite::Result<Vec<_>>>()
      .map_err(|error| err("升级词", error))?;
    for item in &mut list {
      item.examples = examples.remove(&item.id).unwrap_or_default();
    }
    list
  };

  let self_checks = {
    let mut stmt = conn
      .prepare("SELECT id, ord, line, raw, text FROM self_check WHERE deleted = 0 ORDER BY ord, id")
      .map_err(|error| err("写作自查", error))?;
    let rows = stmt
      .query_map([], |row| {
        Ok(BrowseSelfCheck {
          id: row.get(0)?,
          ord: row.get(1)?,
          line: row.get(2)?,
          raw: row.get(3)?,
          text: row.get(4)?,
        })
      })
      .map_err(|error| err("写作自查", error))?;
    rows
      .collect::<rusqlite::Result<Vec<_>>>()
      .map_err(|error| err("写作自查", error))?
  };

  let mut definition_examples: HashMap<(String, String, i64), Vec<BrowseDefinitionExample>> = HashMap::new();
  {
    let mut stmt = conn.prepare(
      "SELECT word_id, source_file, definition_line, seq, sentence, ai
       FROM review_definition_example ORDER BY word_id, source_file, definition_line, seq",
    ).map_err(|error| err("释义例句", error))?;
    let rows = stmt.query_map([], |row| {
      Ok((
        (row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?),
        BrowseDefinitionExample { seq: row.get(3)?, sentence: row.get(4)?, ai: row.get::<_, i64>(5)? != 0 },
      ))
    }).map_err(|error| err("释义例句", error))?;
    for row in rows {
      let (key, example) = row.map_err(|error| err("释义例句", error))?;
      definition_examples.entry(key).or_default().push(example);
    }
  }
  let mut definitions: HashMap<String, Vec<BrowseDefinition>> = HashMap::new();
  {
    let mut stmt = conn.prepare(
      "SELECT d.word_id, d.source_file, d.source_line, d.pos, d.english, d.chinese
       FROM review_definition d
       JOIN review_word w ON w.id = d.word_id AND w.deleted = 0
       ORDER BY d.word_id, d.source_file, d.source_line",
    ).map_err(|error| err("释义", error))?;
    let rows = stmt.query_map([], |row| {
      let key = (row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?);
      Ok((key.clone(), BrowseDefinition {
        source_file: key.1.clone(),
        source_line: key.2,
        pos: row.get(3)?,
        english: row.get(4)?,
        chinese: row.get(5)?,
        examples: definition_examples.remove(&key).unwrap_or_default(),
      }))
    }).map_err(|error| err("释义", error))?;
    for row in rows {
      let (key, definition) = row.map_err(|error| err("释义", error))?;
      definitions.entry(key.0).or_default().push(definition);
    }
  }

  let review_words = {
    let mut stmt = conn
      .prepare(
        "SELECT id, ord, line, raw, word, issue, added_at, status, level, due, note, source, verification_status
         FROM review_word WHERE deleted = 0 ORDER BY ord, id",
      )
      .map_err(|error| err("复习词", error))?;
    let rows = stmt
      .query_map([], |row| {
        let id = row.get::<_, String>(0)?;
        Ok(BrowseReviewWord {
          id: id.clone(),
          ord: row.get(1)?,
          line: row.get(2)?,
          raw: row.get(3)?,
          word: row.get(4)?,
          issue: row.get(5)?,
          added_at: row.get(6)?,
          status: row.get(7)?,
          level: row.get(8)?,
          due: row.get(9)?,
          note: row.get(10)?,
          source: row.get(11)?,
          verification_status: row.get(12)?,
          definitions: definitions.remove(&id).unwrap_or_default(),
        })
      })
      .map_err(|error| err("复习词", error))?;
    rows
      .collect::<rusqlite::Result<Vec<_>>>()
      .map_err(|error| err("复习词", error))?
  };

  Ok(BrowseData {
    upgrades,
    self_checks,
    review_words,
  })
}

/// 教练页只读查询。批次按档案原顺序倒排，每批保留自己的错误项。
pub fn coach_at(path: &Path) -> Result<CoachArchiveData, String> {
  if !path.exists() {
    return Ok(CoachArchiveData::default());
  }
  let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
    .map_err(|error| format!("只读打开错误档案失败：{error}"))?;
  coach_from_conn(&conn)
}

pub fn coach_from_conn(conn: &Connection) -> Result<CoachArchiveData, String> {
  let version: i32 = conn
    .query_row("PRAGMA user_version", [], |row| row.get(0))
    .map_err(|error| err("数据库版本", error))?;
  if version == 0 {
    return Ok(CoachArchiveData::default());
  }
  if version != SCHEMA_VERSION {
    return Err(format!(
      "词库数据库版本 {version} 与本应用支持的版本 {SCHEMA_VERSION} 不兼容，已停止读取"
    ));
  }

  let top = {
    let mut stmt = conn
      .prepare("SELECT id, ord, rank, kind, count, last_at, status FROM error_top ORDER BY ord, id")
      .map_err(|error| err("高频错误", error))?;
    let rows = stmt
      .query_map([], |row| {
        Ok(CoachTop {
          id: row.get(0)?,
          ord: row.get(1)?,
          rank: row.get(2)?,
          kind: row.get(3)?,
          count: row.get(4)?,
          last_at: row.get(5)?,
          status: row.get(6)?,
        })
      })
      .map_err(|error| err("高频错误", error))?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|error| err("高频错误", error))?
  };

  let mut items: HashMap<String, Vec<CoachItem>> = HashMap::new();
  {
    let mut stmt = conn
      .prepare("SELECT id, batch_id, ord, question, kind, written, correction, note FROM error_item ORDER BY batch_id, ord, id")
      .map_err(|error| err("错误项", error))?;
    let rows = stmt
      .query_map([], |row| {
        Ok(CoachItem {
          id: row.get(0)?,
          batch_id: row.get(1)?,
          ord: row.get(2)?,
          question: row.get(3)?,
          kind: row.get(4)?,
          written: row.get(5)?,
          correction: row.get(6)?,
          note: row.get(7)?,
        })
      })
      .map_err(|error| err("错误项", error))?;
    for row in rows {
      let item = row.map_err(|error| err("错误项", error))?;
      items.entry(item.batch_id.clone()).or_default().push(item);
    }
  }

  let batches = {
    let mut stmt = conn
      .prepare("SELECT id, ord, title, date, metadata_json FROM error_batch ORDER BY ord DESC, id DESC")
      .map_err(|error| err("错误批次", error))?;
    let rows = stmt
      .query_map([], |row| {
        let metadata: String = row.get(4)?;
        Ok(CoachBatch {
          id: row.get(0)?,
          ord: row.get(1)?,
          title: row.get(2)?,
          date: row.get(3)?,
          metadata: serde_json::from_str(&metadata).unwrap_or(serde_json::Value::Object(Default::default())),
          items: Vec::new(),
        })
      })
      .map_err(|error| err("错误批次", error))?;
    let mut list = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|error| err("错误批次", error))?;
    for batch in &mut list {
      batch.items = items.remove(&batch.id).unwrap_or_default();
    }
    list
  };

  let todos = {
    let mut stmt = conn
      .prepare("SELECT id, ord, done, text FROM error_todo ORDER BY ord, id")
      .map_err(|error| err("待巩固清单", error))?;
    let rows = stmt
      .query_map([], |row| {
        Ok(CoachTodo {
          id: row.get(0)?,
          ord: row.get(1)?,
          done: row.get::<_, i64>(2)? != 0,
          text: row.get(3)?,
        })
      })
      .map_err(|error| err("待巩固清单", error))?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|error| err("待巩固清单", error))?
  };

  Ok(CoachArchiveData { top, batches, todos })
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::vocab::schema;
  use uuid::Uuid;

  fn tmp() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("vocab-query-{}.db", Uuid::new_v4()))
  }

  fn seed(path: &Path) {
    let conn = schema::open(path).unwrap();
    let ins = |id: &str, ord: i64, deleted: i64| {
      conn
        .execute(
          "INSERT INTO upgrade_entry (id, ord, line, raw, plain, upgrade, source, note, imported_at, updated_at, deleted)
           VALUES (?1, ?2, 1, '<b>raw</b>', 'plain', 'up', 'src', '备注', 't0', 't0', ?3)",
          rusqlite::params![id, ord, deleted],
        )
        .unwrap();
    };
    // 故意乱序插入，验证按 ord 排序；up:gone 软删除。
    ins("up:b", 2, 0);
    ins("up:a", 1, 0);
    ins("up:gone", 3, 1);
    for (id, seq, ai) in [("up:a", 2, 0), ("up:a", 1, 1), ("up:gone", 1, 0)] {
      conn
        .execute(
          "INSERT INTO upgrade_example (entry_id, seq, cand, sentence, ai) VALUES (?1, ?2, 'c', 's', ?3)",
          rusqlite::params![id, seq, ai],
        )
        .unwrap();
    }
    conn
      .execute(
        "INSERT INTO self_check (id, ord, line, raw, text, imported_at, updated_at, deleted)
         VALUES ('sc:1', 1, 1, '- x', 'x', 't0', 't0', 0), ('sc:2', 2, 2, '- y', 'y', 't0', 't0', 1)",
        [],
      )
      .unwrap();
    let rv = |id: &str, ord: i64, level: Option<i64>, deleted: i64| {
      conn
        .execute(
          "INSERT INTO review_word (id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note, imported_at, updated_at, deleted)
           VALUES (?1, ?2, 1, 'r', 'dup', 'dup', '1.1', '2026-11-01', 'L2', ?3, '', '', 't0', 't0', ?4)",
          rusqlite::params![id, ord, level, deleted],
        )
        .unwrap();
    };
    rv("rv:dup@2", 2, None, 0);
    rv("rv:dup@1", 1, Some(2), 0);
    rv("rv:del", 3, None, 1);
  }

  fn dump(path: &Path) -> Vec<String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mut out = Vec::new();
    for sql in [
      "SELECT id||ord||raw||imported_at||updated_at||deleted FROM upgrade_entry ORDER BY id",
      "SELECT entry_id||seq||cand||sentence||ai FROM upgrade_example ORDER BY entry_id, seq",
      "SELECT id||ord||text||imported_at||updated_at||deleted FROM self_check ORDER BY id",
      "SELECT id||ord||status||ifnull(level,'N')||due||imported_at||updated_at||deleted FROM review_word ORDER BY id",
    ] {
      let mut stmt = conn.prepare(sql).unwrap();
      let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
      out.extend(rows.map(|r| r.unwrap()));
    }
    out
  }

  #[test]
  fn missing_db_returns_empty_without_creating_file() {
    let path = tmp();
    let data = browse_at(&path).unwrap();
    assert!(data.upgrades.is_empty() && data.self_checks.is_empty() && data.review_words.is_empty());
    assert!(!path.exists());
  }

  #[test]
  fn empty_schema_returns_empty() {
    let path = tmp();
    schema::open(&path).unwrap();
    let data = browse_at(&path).unwrap();
    assert!(data.upgrades.is_empty() && data.review_words.is_empty());
  }

  #[test]
  fn orders_filters_deleted_and_keeps_all_examples() {
    let path = tmp();
    seed(&path);
    let data = browse_at(&path).unwrap();
    let ids: Vec<_> = data.upgrades.iter().map(|u| u.id.as_str()).collect();
    assert_eq!(ids, ["up:a", "up:b"]);
    let seqs: Vec<_> = data.upgrades[0].examples.iter().map(|e| (e.seq, e.ai)).collect();
    assert_eq!(seqs, [(1, true), (2, false)]);
    assert!(data.upgrades[1].examples.is_empty());
    // raw 原样返回，不做转义。
    assert_eq!(data.upgrades[0].raw, "<b>raw</b>");
    assert_eq!(data.self_checks.len(), 1);
    // 重复词按 ord 排序、ID 不同、level 空值保留。
    let rv: Vec<_> = data.review_words.iter().map(|w| (w.id.as_str(), w.level)).collect();
    assert_eq!(rv, [("rv:dup@1", Some(2)), ("rv:dup@2", None)]);
    assert!(data.review_words.iter().all(|word| word.source == "Hermes 词库" && word.verification_status == "未查证"));
  }

  #[test]
  fn query_does_not_change_any_table() {
    let path = tmp();
    seed(&path);
    let before = dump(&path);
    browse_at(&path).unwrap();
    browse_at(&path).unwrap();
    assert_eq!(dump(&path), before);
  }

  #[test]
  fn newer_version_is_reported() {
    let path = tmp();
    {
      let conn = Connection::open(&path).unwrap();
      conn.pragma_update(None, "user_version", 99).unwrap();
    }
    let error = browse_at(&path).unwrap_err();
    assert!(error.contains("不兼容") && error.contains("99"));
  }

  #[test]
  fn broken_file_is_reported() {
    let path = tmp();
    std::fs::write(&path, b"this is not sqlite").unwrap();
    assert!(browse_at(&path).is_err());
  }

  #[test]
  fn coach_query_orders_batches_and_keeps_empty_batch() {
    let path = tmp();
    {
      let conn = schema::open(&path).unwrap();
      conn.execute("INSERT INTO error_top VALUES ('et:1', 1, 1, 'raw', 1, '主谓一致', '3', '2026-01-02', '复发', 'errors.md')", []).unwrap();
      for (id, ord, title) in [("eb:old", 1, "旧批次"), ("eb:empty", 2, "空批次"), ("eb:new", 3, "新批次")] {
        conn.execute(
          "INSERT INTO error_batch VALUES (?1, ?2, 1, 'raw', ?3, 'date', '{\"词数\":\"250\"}', 'errors.md')",
          rusqlite::params![id, ord, title],
        ).unwrap();
      }
      conn.execute("INSERT INTO error_item VALUES ('ei:1', 'eb:new', 1, 1, 'raw', 'Q1', '拼写', 'ever day', 'every day', '', 'errors.md')", []).unwrap();
      conn.execute("INSERT INTO error_item VALUES ('ei:2', 'eb:old', 2, 2, 'raw', '', '主谓一致', 'notes is', 'notes are', '复数主语', 'errors.md')", []).unwrap();
      conn.execute("INSERT INTO error_todo VALUES ('edo:1', 1, 1, 'raw', 0, '冷读', 'errors.md')", []).unwrap();
    }
    let data = coach_at(&path).unwrap();
    let titles: Vec<_> = data.batches.iter().map(|batch| batch.title.as_str()).collect();
    assert_eq!(titles, ["新批次", "空批次", "旧批次"]);
    assert_eq!(data.batches[0].items[0].question, "Q1");
    assert!(data.batches[1].items.is_empty());
    assert_eq!(data.batches[2].items[0].note, "复数主语");
    assert_eq!(data.batches[0].metadata["词数"], "250");
    assert_eq!(data.top.len(), 1);
    assert_eq!(data.todos.len(), 1);
  }
}
