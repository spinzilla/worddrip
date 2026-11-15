//! 071 同步核心的单测（触发器记账、合并规则、外键顺序、首次同步、重置）。
use super::schema;
use super::sync::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value as Json;
use std::collections::BTreeSet;

fn db() -> Connection {
  let conn = Connection::open_in_memory().unwrap();
  conn.pragma_update(None, "foreign_keys", "ON").unwrap();
  schema::migrate(&conn).unwrap();
  conn
}

#[test]
fn client_and_server_sync_table_lists_match() {
  let source = include_str!("../../../../server/sync/store.py");
  let block = source.split("TABLES = frozenset(").nth(1).expect("服务端 TABLES 清单").split("\n)").next().expect("TABLES 清单结束");
  let server: BTreeSet<String> = block.lines().filter_map(|line| {
    line.trim().trim_end_matches(',').trim().strip_prefix('"').and_then(|value| value.strip_suffix('"')).map(str::to_owned)
  }).collect();
  let client: BTreeSet<String> = SPECS.iter().map(|spec| spec.name.to_owned()).collect();
  assert_eq!(client, server, "Rust SPECS 与 server/sync/store.py TABLES 应保持一致");
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
  assert_eq!(SPECS.len(), 22);
  let conn = db();
  for s in SPECS {
    conn.prepare(&format!("SELECT * FROM {} LIMIT 0", s.name)).unwrap();
    for suffix in ["ai", "au", "ad"] {
      assert_eq!(count(&conn, &format!("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'sync_{}_{suffix}'", s.name)), 1);
    }
  }
  assert_eq!(count(&conn, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync_import_run%'"), 0);
}

/// 078：英英释义（我写的、词典的）从 A 机同步到 B 机，改了、删了也同步过去。
#[test]
fn definition_en_syncs_between_two_libraries_including_edit_and_delete() {
  let a = db();
  let b = db();
  let req = |source: &str, text: &str| super::definition_en::DefinitionEnAddRequest {
    word: "resilient".into(), source: source.into(),
    items: vec![super::definition_en::DefinitionEnItem { pos: Some("adj.".into()), text: text.into() }],
  };
  super::definition_en::add_with_time(&a, req("mine", "able to recover"), "2026-11-14T01:00:00.000Z").unwrap();
  super::definition_en::add_with_time(&a, req("dict:cambridge", "flexible and strong"), "2026-11-14T01:00:01.000Z").unwrap();
  let to_remote = |changes: Vec<ChangeOut>| -> Vec<RemoteChange> {
    changes.into_iter().map(|c| RemoteChange { table: c.table, id: c.id, updated_at: c.updated_at, deleted: c.deleted, device_id: "a".into(), data: c.data }).collect()
  };
  let pushed: Vec<_> = collect(&a, 100).unwrap().into_iter().filter(|c| c.table == "vocab_definition_en").collect();
  assert_eq!(pushed.len(), 2);
  apply(&b, &to_remote(pushed), "b", None).unwrap();
  assert_eq!(count(&b, "SELECT COUNT(*) FROM vocab_definition_en"), 2);
  assert_eq!(count(&b, "SELECT COUNT(*) FROM vocab_definition_en WHERE source = 'dict:cambridge' AND text = 'flexible and strong'"), 1);
  assert_eq!(count(&b, "SELECT COUNT(*) FROM sync_change WHERE dirty = 1"), 0);

  clear_dirty(&a);
  let id: i64 = a.query_row("SELECT id FROM vocab_definition_en WHERE source = 'mine'", [], |r| r.get(0)).unwrap();
  super::definition_en::update_with_time(&a, super::definition_en::DefinitionEnUpdateRequest { id, pos: None, text: "bounces back".into() }, "2026-11-14T02:00:00.000Z").unwrap();
  let dict_id: i64 = a.query_row("SELECT id FROM vocab_definition_en WHERE source <> 'mine'", [], |r| r.get(0)).unwrap();
  super::definition_en::delete_in(&a, super::definition_en::DefinitionEnDeleteRequest { id: dict_id }).unwrap();
  let pushed: Vec<_> = collect(&a, 100).unwrap().into_iter().filter(|c| c.table == "vocab_definition_en").collect();
  assert_eq!(pushed.len(), 2);
  apply(&b, &to_remote(pushed), "b", None).unwrap();
  assert_eq!(count(&b, "SELECT COUNT(*) FROM vocab_definition_en"), 1);
  assert_eq!(count(&b, "SELECT COUNT(*) FROM vocab_definition_en WHERE text = 'bounces back' AND source = 'mine'"), 1);
}

/// 081：候选池（认识 / 收下）从 A 机同步到 B 机；B 机收到后不会再把它们推回去，撤销（删除）也同步。
#[test]
fn wordpack_pick_syncs_between_two_libraries_and_is_not_pushed_back() {
  use super::pick::{set_with_time, undo_with_time, PickItem, UndoRequest};
  let a = db();
  let b = db();
  let to_remote = |changes: Vec<ChangeOut>| -> Vec<RemoteChange> {
    changes.into_iter().map(|c| RemoteChange { table: c.table, id: c.id, updated_at: c.updated_at, deleted: c.deleted, device_id: "a".into(), data: c.data }).collect()
  };
  let item = |word: &str, state: &str| PickItem { word: word.into(), state: state.into(), pack: "四级".into(), date: "2026-11-14".into() };
  set_with_time(&a, vec![item("able", "known"), item("abroad", "later")], "2026-11-14T01:00:00.000Z").unwrap();
  clear_dirty(&b);
  let pushed: Vec<_> = collect(&a, 100).unwrap().into_iter().filter(|c| c.table == "wordpack_pick").collect();
  assert_eq!(pushed.len(), 2);
  apply(&b, &to_remote(pushed), "b", None).unwrap();
  assert_eq!(count(&b, "SELECT COUNT(*) FROM wordpack_pick WHERE state = 'known' AND word_key = 'able'"), 1);
  assert_eq!(count(&b, "SELECT COUNT(*) FROM wordpack_pick"), 2);
  let back: Vec<_> = collect(&b, 100).unwrap().into_iter().filter(|c| c.table == "wordpack_pick").collect();
  assert!(back.is_empty(), "拉下来的候选池不该再推回去");
  clear_dirty(&a);
  undo_with_time(&a, UndoRequest { word: "able".into(), previous: None, take_id: None, definition_en_ids: vec![] }, "2026-11-14T02:00:00.000Z").unwrap();
  let pushed: Vec<_> = collect(&a, 100).unwrap().into_iter().filter(|c| c.table == "wordpack_pick").collect();
  apply(&b, &to_remote(pushed), "b", None).unwrap();
  assert_eq!(count(&b, "SELECT COUNT(*) FROM wordpack_pick"), 1);
}

/// 081 返工：学习计划（单行表 daily_plan）从 A 机同步到 B 机，B 机改了之后能同步回 A 机，拉下来的不会再推回去。
#[test]
fn daily_plan_syncs_between_two_libraries_both_ways() {
  use super::pick::{plan_get_in, plan_set_with_time, PlanRow};
  let a = db();
  let b = db();
  let to_remote = |changes: Vec<ChangeOut>, dev: &str| -> Vec<RemoteChange> {
    changes.into_iter().map(|c| RemoteChange { table: c.table, id: c.id, updated_at: c.updated_at, deleted: c.deleted, device_id: dev.into(), data: c.data }).collect()
  };
  let plan = |packs: &[&str], per_day: i64, card_on: bool| PlanRow { packs: packs.iter().map(|s| s.to_string()).collect(), per_day, card_on, updated_at: String::new() };
  plan_set_with_time(&a, plan(&["cet4", "ngsl"], 5, true), "2026-11-14T01:00:00.000Z").unwrap();
  clear_dirty(&b);
  let pushed: Vec<_> = collect(&a, 100).unwrap().into_iter().filter(|c| c.table == "daily_plan").collect();
  assert_eq!(pushed.len(), 1);
  assert_eq!(pushed[0].id, "default");
  apply(&b, &to_remote(pushed, "a"), "b", None).unwrap();
  let got = plan_get_in(&b).unwrap().unwrap();
  assert_eq!((got.packs, got.per_day, got.card_on), (vec!["cet4".to_string(), "ngsl".to_string()], 5, true));
  let back: Vec<_> = collect(&b, 100).unwrap().into_iter().filter(|c| c.table == "daily_plan").collect();
  assert!(back.is_empty(), "拉下来的学习计划不该再推回去");
  // B 机改了计划，A 机收到后跟着变
  std::thread::sleep(std::time::Duration::from_millis(5));
  plan_set_with_time(&b, plan(&["gre"], 20, false), "2026-11-14T03:00:00.000Z").unwrap();
  clear_dirty(&a);
  let pushed: Vec<_> = collect(&b, 100).unwrap().into_iter().filter(|c| c.table == "daily_plan").collect();
  assert_eq!(pushed.len(), 1);
  apply(&a, &to_remote(pushed, "b"), "a", None).unwrap();
  let got = plan_get_in(&a).unwrap().unwrap();
  assert_eq!((got.packs, got.per_day, got.card_on), (vec!["gre".to_string()], 20, false));
  assert_eq!(count(&a, "SELECT COUNT(*) FROM daily_plan"), 1);
}
