//! 071 同步核心的单测（触发器记账、合并规则、外键顺序、首次同步、重置）。
use super::schema;
use super::sync::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value as Json;

fn db() -> Connection {
  let conn = Connection::open_in_memory().unwrap();
  conn.pragma_update(None, "foreign_keys", "ON").unwrap();
  schema::migrate(&conn).unwrap();
  conn
}

fn word(conn: &Connection, id: &str, note: &str) {
  conn.execute(
    "INSERT INTO review_word (id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note, imported_at, updated_at, deleted)
     VALUES (?1, 1, 1, 'raw', 'w', 'w', '1', '2026-01-01', 'L1', 1, '2026-01-02', ?2, '2026-01-01T00:00:00Z', '2026-01-02', 0)",
    params![id, note],
  )
  .unwrap();
}
fn note(conn: &Connection, body: &str, created: &str) {
  conn
    .execute("INSERT INTO vocab_note (word_key, word, body, source, created_at, updated_at) VALUES ('k', 'k', ?1, '词库', ?2, ?2)", params![body, created])
    .unwrap();
}
fn log(conn: &Connection, word_id: &str, created: &str) {
  conn
    .execute(
      "INSERT INTO review_log (word_id, review_date, kind, correct, before_status, after_status, before_due, after_due, created_at)
       VALUES (?1, '2026-01-02', 'recall', 1, 'L1', 'L2', '', '', ?2)",
      params![word_id, created],
    )
    .unwrap();
}
fn definition(conn: &Connection, word_id: &str) {
  conn
    .execute("INSERT INTO review_definition (word_id, source_file, source_line, pos, english, chinese) VALUES (?1, 'a.md', 3, 'n.', 'e', 'c')", [word_id])
    .unwrap();
}
fn change(conn: &Connection, table: &str, sid: &str) -> Option<(i64, i64, i64)> {
  conn
    .query_row("SELECT updated_at, deleted, dirty FROM sync_change WHERE tbl = ?1 AND sid = ?2", params![table, sid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
    .optional()
    .unwrap()
}
fn count(conn: &Connection, sql: &str) -> i64 {
  conn.query_row(sql, [], |r| r.get(0)).unwrap()
}
fn remote(table: &str, id: &str, at: i64, dev: &str, data: Json) -> RemoteChange {
  RemoteChange { table: table.into(), id: id.into(), updated_at: at, deleted: false, device_id: dev.into(), data: Some(data) }
}
fn gone(table: &str, id: &str, at: i64, dev: &str) -> RemoteChange {
  RemoteChange { table: table.into(), id: id.into(), updated_at: at, deleted: true, device_id: dev.into(), data: None }
}
fn clear_dirty(conn: &Connection) {
  conn.execute("UPDATE sync_change SET dirty = 0", []).unwrap();
}
fn word_data(note: &str) -> Json {
  serde_json::json!({"ord":1,"line":1,"raw":"r","word":"w","word_norm":"w","issue":"1","added_at":"a","status":"L1","level":1,"due":"","note":note,
    "imported_at":"i","updated_at":"u","deleted":0,"source":"s","verification_status":"未查证"})
}
fn note_data(body: &str) -> Json {
  serde_json::json!({"word_key":"k","word":"k","body":body,"source":"词库","created_at":"c","updated_at":"c"})
}
fn def_sid(word: &str, line: i64) -> String {
  format!("{word}{SEP}a.md{SEP}{line}")
}

#[test]
fn triggers_record_insert_update_delete() {
  let conn = db();
  word(&conn, "w1", "a");
  let (t0, deleted, dirty) = change(&conn, "review_word", "w1").unwrap();
  assert_eq!((deleted, dirty), (0, 1));
  assert!(t0 > 1_700_000_000_000);
  clear_dirty(&conn);
  conn.execute("UPDATE review_word SET note = 'b' WHERE id = 'w1'", []).unwrap();
  let (t1, deleted, dirty) = change(&conn, "review_word", "w1").unwrap();
  assert!(t1 > t0 && deleted == 0 && dirty == 1);
  clear_dirty(&conn);
  conn.execute("DELETE FROM review_word WHERE id = 'w1'", []).unwrap();
  let (t2, deleted, dirty) = change(&conn, "review_word", "w1").unwrap();
  assert!(t2 > t1 && deleted == 1 && dirty == 1);
}

#[test]
fn auto_and_composite_tables_get_identity() {
  let conn = db();
  word(&conn, "w1", "a");
  note(&conn, "n", "2026-01-02T10:00:00Z");
  let uid: String = conn.query_row("SELECT sync_uid FROM vocab_note", [], |r| r.get(0)).unwrap();
  assert!(uid.starts_with("u:") && uid.len() == 34, "{uid}");
  assert_eq!(change(&conn, "vocab_note", &uid).unwrap().1, 0);
  // 改正文不换身份，只记一笔
  clear_dirty(&conn);
  conn.execute("UPDATE vocab_note SET body = 'n2'", []).unwrap();
  assert_eq!(change(&conn, "vocab_note", &uid).unwrap().2, 1);
  assert_eq!(count(&conn, "SELECT COUNT(*) FROM sync_change WHERE tbl = 'vocab_note'"), 1);
  definition(&conn, "w1");
  assert!(change(&conn, "review_definition", &def_sid("w1", 3)).is_some());
  conn.execute("DELETE FROM vocab_note", []).unwrap();
  assert_eq!(change(&conn, "vocab_note", &uid).unwrap().1, 1);
}

#[test]
fn cascade_deletes_are_recorded_too() {
  let conn = db();
  word(&conn, "w1", "a");
  definition(&conn, "w1");
  log(&conn, "w1", "t");
  clear_dirty(&conn);
  conn.execute("DELETE FROM review_word WHERE id = 'w1'", []).unwrap();
  assert_eq!(change(&conn, "review_definition", &def_sid("w1", 3)).unwrap().1, 1);
  let uid = conn.query_row("SELECT sid FROM sync_change WHERE tbl = 'review_log'", [], |r| r.get::<_, String>(0)).unwrap();
  assert_eq!(change(&conn, "review_log", &uid).unwrap().1, 1);
}

#[test]
fn applying_remote_changes_does_not_record_dirty() {
  let conn = db();
  let r = apply(
    &conn,
    &[remote("review_word", "w9", 5000, "other", word_data("远端")), remote("vocab_note", "u:remote1", 5001, "other", note_data("b"))],
    "me",
    Some(("srv#x", 7)),
  )
  .unwrap();
  assert_eq!(r, ApplyResult { applied: 2, skipped: 0 });
  assert_eq!(count(&conn, "SELECT COUNT(*) FROM sync_change WHERE dirty = 1"), 0);
  assert_eq!(change(&conn, "review_word", "w9"), Some((5000, 0, 0)));
  assert_eq!(count(&conn, "SELECT COUNT(*) FROM sync_meta WHERE k = 'applying'"), 0);
  assert_eq!(status(&conn, "srv#x", "me").unwrap().cursor, 7);
  // 暂停结束后，本机的修改照常记账
  conn.execute("UPDATE review_word SET note = 'x' WHERE id = 'w9'", []).unwrap();
  assert_eq!(change(&conn, "review_word", "w9").unwrap().2, 1);
}

#[test]
fn merge_rules_newer_wins_and_dirty_local_is_kept() {
  let conn = db();
  word(&conn, "w1", "本机");
  let local_t = change(&conn, "review_word", "w1").unwrap().0;
  let r = apply(&conn, &[remote("review_word", "w1", local_t - 10, "other", word_data("旧远端"))], "me", None).unwrap();
  assert_eq!(r, ApplyResult { applied: 0, skipped: 1 });
  assert_eq!(count(&conn, "SELECT COUNT(*) FROM review_word WHERE note = '本机'"), 1);
  let r = apply(&conn, &[remote("review_word", "w1", local_t + 10, "other", word_data("新远端"))], "me", None).unwrap();
  assert_eq!(r.applied, 1);
  assert_eq!(count(&conn, "SELECT COUNT(*) FROM review_word WHERE note = '新远端'"), 1);
  assert_eq!(change(&conn, "review_word", "w1"), Some((local_t + 10, 0, 0)));
  // 一样新且本机待推送：设备号大的赢
  conn.execute("UPDATE review_word SET note = '平局本机' WHERE id = 'w1'", []).unwrap();
  let t = change(&conn, "review_word", "w1").unwrap().0;
  assert_eq!(apply(&conn, &[remote("review_word", "w1", t, "aaa", word_data("平局远端"))], "zzz", None).unwrap().skipped, 1);
  assert_eq!(apply(&conn, &[remote("review_word", "w1", t, "zzz-more", word_data("平局远端"))], "zzz", None).unwrap().applied, 1);
}

#[test]
fn deletes_propagate_and_old_edits_do_not_resurrect() {
  let conn = db();
  word(&conn, "w1", "a");
  clear_dirty(&conn);
  let r = apply(&conn, &[gone("review_word", "w1", 9_000_000_000_000, "other")], "me", None).unwrap();
  assert_eq!(r.applied, 1);
  assert_eq!(count(&conn, "SELECT COUNT(*) FROM review_word"), 0);
  assert_eq!(change(&conn, "review_word", "w1"), Some((9_000_000_000_000, 1, 0)));
  let r = apply(&conn, &[remote("review_word", "w1", 8_000_000_000_000, "third", word_data("旧"))], "me", None).unwrap();
  assert_eq!(r, ApplyResult { applied: 0, skipped: 1 });
  assert_eq!(count(&conn, "SELECT COUNT(*) FROM review_word"), 0);
  assert_eq!(apply(&conn, &[remote("review_word", "w1", 9_000_000_000_001, "third", word_data("新"))], "me", None).unwrap().applied, 1);
  assert_eq!(count(&conn, "SELECT COUNT(*) FROM review_word"), 1);
}

#[test]
fn append_only_tables_are_never_overwritten_or_deleted() {
  let conn = db();
  word(&conn, "w1", "a");
  log(&conn, "w1", "t1");
  let uid: String = conn.query_row("SELECT sync_uid FROM review_log", [], |r| r.get(0)).unwrap();
  let data = serde_json::json!({"word_id":"w1","review_date":"X","kind":"recall","correct":0,"before_status":"b","after_status":"b","before_due":"","after_due":"","created_at":"t1"});
  let r = apply(&conn, &[remote("review_log", &uid, i64::MAX / 2, "other", data), gone("review_log", &uid, i64::MAX / 2, "other")], "me", None).unwrap();
  assert_eq!(r.applied, 0);
  assert_eq!(count(&conn, "SELECT COUNT(*) FROM review_log WHERE review_date = '2026-01-02'"), 1);
}

#[test]
fn column_mismatch_is_tolerated() {
  let conn = db();
  // data 多一列 zzz，少了 updated_at（NOT NULL 无默认）
  let r = apply(
    &conn,
    &[remote("vocab_note", "u:x1", 10, "o", serde_json::json!({"word_key":"k","word":"k","body":"b","source":"词库","created_at":"c","zzz":1}))],
    "me",
    None,
  )
  .unwrap();
  assert_eq!(r.applied, 1);
  assert_eq!(count(&conn, "SELECT COUNT(*) FROM vocab_note WHERE sync_uid = 'u:x1' AND updated_at = ''"), 1);
  // review_word 缺 source / verification_status → 用本机默认值
  let mut d = word_data("n");
  d.as_object_mut().unwrap().remove("source");
  d.as_object_mut().unwrap().remove("verification_status");
  assert_eq!(apply(&conn, &[remote("review_word", "w2", 10, "o", d)], "me", None).unwrap().applied, 1);
  assert_eq!(count(&conn, "SELECT COUNT(*) FROM review_word WHERE id = 'w2' AND source = 'Hermes 词库' AND verification_status = '未查证'"), 1);
  // 约束不满足的单条丢掉，不影响同页其他条
  let bad = remote("vocab_note", "u:bad", 10, "o", serde_json::json!({"word_key":"","word":"k","body":"b","source":"词库","created_at":"c","updated_at":"c"}));
  let ok = remote("vocab_note", "u:ok", 10, "o", note_data("b"));
  assert_eq!(apply(&conn, &[bad, ok], "me", None).unwrap(), ApplyResult { applied: 1, skipped: 1 });
  // 白名单外的表忽略
  assert_eq!(apply(&conn, &[remote("import_run", "1", 1, "o", serde_json::json!({}))], "me", None).unwrap().skipped, 1);
}

#[test]
fn child_before_parent_in_one_page_is_fine() {
  let conn = db();
  let child = remote(
    "review_definition",
    &def_sid("w7", 3),
    10,
    "o",
    serde_json::json!({"word_id":"w7","source_file":"a.md","source_line":3,"pos":"n.","english":"e","chinese":"c"}),
  );
  let parent = remote("review_word", "w7", 10, "o", word_data("p"));
  let r = apply(&conn, &[child, parent], "me", None).unwrap();
  assert_eq!(r.applied, 2);
  assert_eq!(count(&conn, "SELECT COUNT(*) FROM review_definition WHERE source_line = 3"), 1);
  // 孤儿子表行（父表一直没来）：整页仍能完成，不卡死；外键开关恢复
  let orphan = remote(
    "review_definition",
    &def_sid("nope", 1),
    10,
    "o",
    serde_json::json!({"word_id":"nope","source_file":"a.md","source_line":1,"pos":"n.","english":"e","chinese":"c"}),
  );
  assert_eq!(apply(&conn, &[orphan], "me", Some(("k", 1))).unwrap().applied, 1);
  assert_eq!(count(&conn, "PRAGMA foreign_keys"), 1);
}

#[test]
fn integer_key_rows_match_by_sync_uid_not_local_id() {
  let conn = db();
  note(&conn, "本机已有", "2026-01-01T00:00:00Z");
  apply(&conn, &[remote("vocab_note", "u:remote", 10, "o", note_data("远端第一版"))], "me", None).unwrap();
  assert_eq!(count(&conn, "SELECT COUNT(*) FROM vocab_note"), 2);
  apply(&conn, &[remote("vocab_note", "u:remote", 20, "o", note_data("远端第二版"))], "me", None).unwrap();
  assert_eq!(count(&conn, "SELECT COUNT(*) FROM vocab_note"), 2);
  assert_eq!(count(&conn, "SELECT COUNT(*) FROM vocab_note WHERE body = '远端第二版' AND sync_uid = 'u:remote'"), 1);
}

#[test]
fn ack_keeps_rows_edited_after_collect() {
  let conn = db();
  word(&conn, "w1", "a");
  word(&conn, "w2", "a");
  let out = collect(&conn, 10).unwrap();
  assert_eq!(out.len(), 2);
  assert!(out.iter().all(|c| c.data.is_some()));
  conn.execute("UPDATE review_word SET note = 'changed' WHERE id = 'w1'", []).unwrap();
  let items: Vec<AckItem> = out.iter().map(|c| AckItem { table: c.table.clone(), id: c.id.clone(), updated_at: c.updated_at }).collect();
  assert_eq!(ack(&conn, &items).unwrap(), 1);
  assert_eq!(change(&conn, "review_word", "w1").unwrap().2, 1);
  assert_eq!(change(&conn, "review_word", "w2").unwrap().2, 0);
  assert_eq!(collect(&conn, 1).unwrap().len(), 1);
}

#[test]
fn collect_then_apply_round_trips_between_two_databases() {
  let a = db();
  word(&a, "w1", "n1");
  definition(&a, "w1");
  log(&a, "w1", "t1");
  note(&a, "笔记", "2026-01-02T10:00:00Z");
  a.execute("INSERT INTO quick_note (body, created_at, updated_at, device_id, ctx_time) VALUES ('随手', 'c', 'c', 'd', 12.5)", []).unwrap();
  a.execute("INSERT INTO example_scene (key, sentence, scene, source, updated_at) VALUES ('k', 's', 'summary', 'AI', 'u')", []).unwrap();
  let out = collect(&a, 100).unwrap();
  for c in out.iter().filter(|c| c.table == "review_log") {
    let obj = c.data.as_ref().unwrap().as_object().unwrap();
    assert!(!obj.contains_key("id") && !obj.contains_key("sync_uid"));
  }
  let b = db();
  let changes: Vec<RemoteChange> =
    out.iter().map(|c| RemoteChange { table: c.table.clone(), id: c.id.clone(), updated_at: c.updated_at, deleted: c.deleted, device_id: "a".into(), data: c.data.clone() }).collect();
  assert_eq!(apply(&b, &changes, "b", None).unwrap().skipped, 0);
  for t in ["review_word", "review_definition", "review_log", "vocab_note", "quick_note", "example_scene"] {
    assert_eq!(count(&a, &format!("SELECT COUNT(*) FROM {t}")), count(&b, &format!("SELECT COUNT(*) FROM {t}")), "{t}");
  }
  assert_eq!(count(&b, "SELECT COUNT(*) FROM quick_note WHERE ctx_time = 12.5"), 1);
  assert!(collect(&b, 10).unwrap().is_empty());
}

#[test]
fn first_sync_marks_everything_dirty_with_existing_times() {
  let conn = db();
  word(&conn, "w1", "a");
  definition(&conn, "w1");
  conn.execute("DELETE FROM sync_change", []).unwrap(); // 模拟「升级前就有的行」：账本里没有记录
  let b = begin(&conn, "srv#sp", "me").unwrap();
  assert!(b.first_time && b.cursor == 0);
  assert_eq!(count(&conn, "SELECT COUNT(*) FROM sync_change WHERE dirty = 1"), 2);
  assert_eq!(change(&conn, "review_word", "w1").unwrap().0, 1_767_312_000_000); // 行里 updated_at = 2026-01-02
  assert_eq!(change(&conn, "review_definition", &def_sid("w1", 3)).unwrap().0, 0);
  assert!(!begin(&conn, "srv#sp", "me").unwrap().first_time);
  assert!(begin(&conn, "srv#other", "me").unwrap().first_time);
}

#[test]
fn reset_all_clears_cursor_and_remarks_every_row() {
  let conn = db();
  word(&conn, "w1", "a");
  begin(&conn, "s#1", "me").unwrap();
  apply(&conn, &[], "me", Some(("s#1", 42))).unwrap();
  clear_dirty(&conn);
  conn.execute("INSERT INTO sync_change (tbl, sid, updated_at, deleted, dirty) VALUES ('review_word', 'ghost', 1, 1, 0)", []).unwrap();
  assert_eq!(status(&conn, "s#1", "me").unwrap().cursor, 42);
  reset_all(&conn).unwrap();
  assert_eq!(status(&conn, "s#1", "me").unwrap().cursor, 0);
  assert_eq!(change(&conn, "review_word", "ghost"), None);
  assert_eq!(change(&conn, "review_word", "w1").unwrap().2, 1);
  assert!(begin(&conn, "s#1", "me").unwrap().first_time);
}

#[test]
fn legacy_uid_is_deterministic_and_field_sensitive() {
  let f = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
  assert_eq!(legacy_uid("vocab_note", 3, &f(&["k", "w", "t1"])), legacy_uid("vocab_note", 3, &f(&["k", "w", "t1"])));
  assert_ne!(legacy_uid("vocab_note", 3, &f(&["k", "w", "t1"])), legacy_uid("vocab_note", 3, &f(&["k", "w", "t2"])));
  assert_ne!(legacy_uid("vocab_note", 3, &f(&["k", "w", "t1"])), legacy_uid("vocab_note", 4, &f(&["k", "w", "t1"])));
  assert!(legacy_uid("quick_note", 1, &[]).starts_with("legacy:quick_note:1:"));
}

#[test]
fn specs_cover_the_whitelist_and_every_table_has_triggers() {
  assert_eq!(SPECS.len(), 19);
  let conn = db();
  for s in SPECS {
    conn.prepare(&format!("SELECT * FROM {} LIMIT 0", s.name)).unwrap();
    for suffix in ["ai", "au", "ad"] {
      assert_eq!(count(&conn, &format!("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'sync_{}_{suffix}'", s.name)), 1);
    }
  }
  assert_eq!(count(&conn, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync_import_run%'"), 0);
}
