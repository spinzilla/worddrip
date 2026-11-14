//! 071 联调：真实的 Rust 同步核心（两个独立的磁盘词库 A、B）对着真实的本机同步服务（server/sync）。
//! 默认不跑（#[ignore]）；用 `node dev/sync-live.mjs` 起服务并跑它，或自己设 SYNC_LIVE_URL / SYNC_LIVE_KEY 再
//! `cargo test --lib sync_live -- --ignored --nocapture`。
//! 这里的「客户端」是和 app/utils/sync/client.ts 同样流程的最小 Rust 版：先推后拉，只用来联调，不进正式代码。
use super::library;
use super::schema;
use super::sync::*;
use rusqlite::Connection;
use serde_json::{json, Value as Json};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};

fn http(method: &str, url: &str, headers: &[(&str, String)], body: Option<&Json>) -> Result<(u16, Json), String> {
  let rest = url.strip_prefix("http://").ok_or("只支持 http")?;
  let (host, path) = rest.split_once('/').map(|(h, p)| (h, format!("/{p}"))).unwrap_or((rest, "/".into()));
  let mut stream = TcpStream::connect(host).map_err(|e| format!("连不上同步服务器：{e}"))?;
  let payload = body.map(|b| b.to_string()).unwrap_or_default();
  let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Length: {}\r\n", payload.len());
  if body.is_some() {
    req += "Content-Type: application/json\r\n";
  }
  for (k, v) in headers {
    req += &format!("{k}: {v}\r\n");
  }
  req += "\r\n";
  stream.write_all(req.as_bytes()).and_then(|_| stream.write_all(payload.as_bytes())).map_err(|e| e.to_string())?;
  let mut raw = Vec::new();
  stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
  let text = String::from_utf8_lossy(&raw).into_owned();
  let (head, mut rest_body) = text.split_once("\r\n\r\n").ok_or("响应格式不对")?;
  let status: u16 = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or("没有状态码")?;
  if head.to_lowercase().contains("transfer-encoding: chunked") {
    let mut out = String::new();
    while let Some((size_line, after)) = rest_body.split_once("\r\n") {
      let n = usize::from_str_radix(size_line.trim(), 16).unwrap_or(0);
      if n == 0 {
        break;
      }
      out += &after[..n];
      rest_body = &after[n + 2..];
    }
    return Ok((status, serde_json::from_str(&out).unwrap_or(Json::Null)));
  }
  Ok((status, serde_json::from_str(rest_body).unwrap_or(Json::Null)))
}

struct Space {
  url: String,
  app_key: String,
  id: String,
  secret: String,
}

impl Space {
  fn create(url: &str, app_key: &str) -> Space {
    let (st, j) = http("POST", &format!("{url}/spaces"), &[("X-App-Key", app_key.into())], Some(&json!({}))).unwrap();
    assert_eq!(st, 200, "{j}");
    Space { url: url.into(), app_key: app_key.into(), id: j["space_id"].as_str().unwrap().into(), secret: j["space_secret"].as_str().unwrap().into() }
  }
  fn headers(&self) -> Vec<(&'static str, String)> {
    vec![("X-App-Key", self.app_key.clone()), ("Authorization", format!("Bearer {}.{}", self.id, self.secret))]
  }
  fn key(&self) -> String {
    format!("{}#{}", self.url, self.id)
  }
}

/// 一次同步：先推后拉。返回 (推了, 拉了, 跳过)；联网失败返回 Err，本机数据不动。
fn sync(conn: &Connection, space: &Space, device: &str) -> Result<(usize, usize, usize), String> {
  let begin = begin(conn, &space.key(), device).map_err(|e| e.to_string())?;
  let mut pushed = 0;
  loop {
    let batch = collect(conn, 500).map_err(|e| e.to_string())?;
    if batch.is_empty() {
      break;
    }
    let (st, j) = http("POST", &format!("{}/push", space.url), &space.headers(), Some(&json!({"device_id": device, "changes": batch})))?;
    if st != 200 {
      return Err(format!("push 返回 {st}：{j}"));
    }
    let items: Vec<AckItem> = batch.iter().map(|c| AckItem { table: c.table.clone(), id: c.id.clone(), updated_at: c.updated_at }).collect();
    pushed += batch.len();
    if ack(conn, &items).map_err(|e| e.to_string())? == 0 {
      break;
    }
  }
  let (mut pulled, mut skipped) = (0, 0);
  let mut cursor = begin.cursor;
  loop {
    let (st, j) = http("GET", &format!("{}/pull?since={cursor}&limit=500", space.url), &space.headers(), None)?;
    if st != 200 {
      return Err(format!("pull 返回 {st}：{j}"));
    }
    let changes: Vec<RemoteChange> = serde_json::from_value(j["changes"].clone()).map_err(|e| e.to_string())?;
    let next = cursor.max(j["cursor"].as_i64().unwrap_or(cursor));
    let r = apply(conn, &changes, device, Some((&space.key(), next)))?;
    pulled += r.applied;
    skipped += r.skipped;
    cursor = next;
    if !j["more"].as_bool().unwrap_or(false) || changes.is_empty() {
      break;
    }
  }
  Ok((pushed, pulled, skipped))
}

fn n(conn: &Connection, sql: &str) -> i64 {
  conn.query_row(sql, [], |r| r.get(0)).unwrap()
}
const TABLES: [&str; 11] = ["review_word", "review_log", "review_event", "vocab_note", "vocab_example", "quick_note", "review_definition", "review_definition_example", "upgrade_entry", "upgrade_example", "self_check"];
fn counts(conn: &Connection) -> Vec<i64> {
  TABLES.iter().map(|t| n(conn, &format!("SELECT COUNT(*) FROM {t}"))).collect()
}
fn pause() {
  std::thread::sleep(std::time::Duration::from_millis(15));
}

fn seed(conn: &Connection) {
  for i in 1..=3 {
    conn
      .execute(
        "INSERT INTO review_word (id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note, imported_at, updated_at, deleted)
         VALUES (?1, ?2, 1, 'raw', ?3, ?3, '1', '2026-01-01', 'L1', 1, '2026-01-02', '原备注', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 0)",
        rusqlite::params![format!("w{i}"), i, format!("word{i}")],
      )
      .unwrap();
  }
  conn.execute_batch(
    "INSERT INTO review_log (word_id, review_date, kind, correct, before_status, after_status, before_due, after_due, created_at) VALUES ('w1', '2026-01-02', 'recall', 1, 'L1', 'L2', '', '', '2026-01-02T01:00:00Z');
     INSERT INTO review_event (word_id, review_date, kind, correct, detail, created_at) VALUES ('w1', '2026-01-02', 'recheck', 1, '{}', '2026-01-02T02:00:00Z');
     INSERT INTO vocab_note (word_key, word, body, source, created_at, updated_at) VALUES ('word1', 'word1', '老笔记一', '词库', '2026-01-02T03:00:00Z', '2026-01-02T03:00:00Z');
     INSERT INTO vocab_note (word_key, word, body, source, created_at, updated_at) VALUES ('word2', 'word2', '老笔记二', '词库', '2026-01-02T04:00:00Z', '2026-01-02T04:00:00Z');
     INSERT INTO vocab_example (word_key, word, sentence, source, created_at) VALUES ('word1', 'word1', 'An example.', '自己写', '2026-01-02T05:00:00Z');
     INSERT INTO quick_note (body, created_at, updated_at, device_id) VALUES ('老随手记', '2026-01-02T06:00:00Z', '2026-01-02T06:00:00Z', 'old');
     INSERT INTO review_definition (word_id, source_file, source_line, pos, english, chinese) VALUES ('w1', 'a.md', 1, 'n.', 'e', 'c');
     INSERT INTO review_definition_example (word_id, source_file, definition_line, seq, sentence, ai) VALUES ('w1', 'a.md', 1, 1, 'S.', 0);
     INSERT INTO upgrade_entry (id, ord, line, raw, plain, upgrade, source, note, imported_at, updated_at, deleted) VALUES ('u1', 1, 1, 'r', 'p', 'u', 's', '', '2026-01-01', '2026-01-01', 0);
     INSERT INTO upgrade_example (entry_id, seq, cand, sentence, ai) VALUES ('u1', 1, 'c', 'S.', 0);
     INSERT INTO self_check (id, ord, line, raw, text, imported_at, updated_at, deleted) VALUES ('s1', 1, 1, 'r', 't', '2026-01-01', '2026-01-01', 0);",
  )
  .unwrap();
}

fn tmp(name: &str) -> PathBuf {
  let dir = PathBuf::from("D:\\tmp\\es-sync").join(format!("live-{name}-{}", uuid::Uuid::new_v4().simple()));
  std::fs::create_dir_all(&dir).unwrap();
  dir
}

fn open_db(path: &Path) -> Connection {
  let c = schema::open(path).unwrap();
  c.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
  c
}

#[test]
#[ignore]
fn sync_live() {
  let url = std::env::var("SYNC_LIVE_URL").expect("需要 SYNC_LIVE_URL，用 node dev/sync-live.mjs 跑");
  let key = std::env::var("SYNC_LIVE_KEY").unwrap_or_else(|_| "test-app-key".into());
  let dir = tmp("ab");
  let (pa, pb) = (dir.join("a.db"), dir.join("b.db"));
  let a = open_db(&pa);
  seed(&a);
  let space = Space::create(&url, &key);
  let before = counts(&a);
  println!("步骤0 A 的行数 {before:?}");

  // 1. B 用 A 的整库导出导入（模拟用户现在的情况）：真实的 library::export_at / import_at
  let bytes = library::export_at(&pa).unwrap();
  library::import_at(&pb, &bytes).unwrap();
  let b = open_db(&pb);
  assert_eq!(counts(&b), before);
  assert!(n(&b, "SELECT COUNT(*) FROM sync_change WHERE dirty = 1") >= 1, "导入整库后所有行应重新记成待推送");
  let uid_a: String = a.query_row("SELECT sync_uid FROM vocab_note ORDER BY id LIMIT 1", [], |r| r.get(0)).unwrap();
  let uid_b: String = b.query_row("SELECT sync_uid FROM vocab_note ORDER BY id LIMIT 1", [], |r| r.get(0)).unwrap();
  assert_eq!(uid_a, uid_b, "整库导出导入后，老行的 sync_uid 必须一致");

  // 2. 第一次同步：A 推，B 推再拉；两边行数和之前一样（没有重复）
  let r = sync(&a, &space, "dev-a").unwrap();
  println!("步骤1 A 首次同步 推{} 拉{} 跳过{}", r.0, r.1, r.2);
  let r = sync(&b, &space, "dev-b").unwrap();
  println!("步骤1 B 首次同步 推{} 拉{} 跳过{}", r.0, r.1, r.2);
  sync(&a, &space, "dev-a").unwrap();
  assert_eq!(counts(&a), before, "A 首次同步后不能多出行");
  assert_eq!(counts(&b), before, "B 首次同步后不能多出行");
  println!("步骤1 两边行数仍是 {before:?}");

  // 3. A 加一个词、复习一次、写一条笔记和一条随手记 → A 同步 → B 同步
  a.execute_batch(
    "INSERT INTO review_word (id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note, imported_at, updated_at, deleted)
       VALUES ('w-new', 9, 1, 'raw', 'brandnew', 'brandnew', '1', '2026-02-01', 'L1', 1, '2026-02-02', '', '2026-02-01', '2026-02-01', 0);
     INSERT INTO review_log (word_id, review_date, kind, correct, before_status, after_status, before_due, after_due, created_at) VALUES ('w-new', '2026-02-02', 'recall', 1, 'L1', 'L2', '', '', '2026-02-02T01:00:00Z');
     INSERT INTO vocab_note (word_key, word, body, source, created_at, updated_at) VALUES ('brandnew', 'brandnew', 'A 的新笔记', '复习', '2026-02-02T03:00:00Z', '2026-02-02T03:00:00Z');
     INSERT INTO quick_note (body, created_at, updated_at, device_id) VALUES ('A 的新随手记', '2026-02-02T06:00:00Z', '2026-02-02T06:00:00Z', 'a');",
  )
  .unwrap();
  sync(&a, &space, "dev-a").unwrap();
  let r = sync(&b, &space, "dev-b").unwrap();
  println!("步骤2 B 拉到 {} 条", r.1);
  assert_eq!(n(&b, "SELECT COUNT(*) FROM review_word WHERE word = 'brandnew'"), 1);
  assert_eq!(n(&b, "SELECT COUNT(*) FROM review_log WHERE word_id = 'w-new'"), 1);
  assert_eq!(n(&b, "SELECT COUNT(*) FROM vocab_note WHERE body = 'A 的新笔记'"), 1);
  assert_eq!(n(&b, "SELECT COUNT(*) FROM quick_note WHERE body = 'A 的新随手记'"), 1);
  assert_eq!(counts(&a), counts(&b));
  println!("步骤2 B 的行数 {:?}", counts(&b));

  // 4. 两边改同一个词的备注，B 后改 → 各同步两轮 → 都是 B 的
  a.execute("UPDATE review_word SET note = 'A 改的' WHERE id = 'w2'", []).unwrap();
  pause();
  b.execute("UPDATE review_word SET note = 'B 改的' WHERE id = 'w2'", []).unwrap();
  // 5. 两边各自复习同一个词（各产生复习记录）
  a.execute("INSERT INTO review_log (word_id, review_date, kind, correct, before_status, after_status, before_due, after_due, created_at) VALUES ('w3', '2026-02-03', 'recall', 1, 'L1', 'L2', '', '', '2026-02-03T01:00:00Z')", []).unwrap();
  b.execute("INSERT INTO review_log (word_id, review_date, kind, correct, before_status, after_status, before_due, after_due, created_at) VALUES ('w3', '2026-02-03', 'recall', 0, 'L1', 'L1', '', '', '2026-02-03T02:00:00Z')", []).unwrap();
  // 6. A 删一条笔记
  a.execute("DELETE FROM vocab_note WHERE body = '老笔记二'", []).unwrap();
  let logs_before = n(&a, "SELECT COUNT(*) FROM review_log");
  for _ in 0..2 {
    sync(&a, &space, "dev-a").unwrap();
    sync(&b, &space, "dev-b").unwrap();
  }
  for (name, c) in [("A", &a), ("B", &b)] {
    let note: String = c.query_row("SELECT note FROM review_word WHERE id = 'w2'", [], |r| r.get(0)).unwrap();
    assert_eq!(note, "B 改的", "{name} 的备注应是后改的 B");
    assert_eq!(n(c, "SELECT COUNT(*) FROM review_log WHERE word_id = 'w3'"), 2, "{name} 的 w3 复习记录应是两边的并集");
    assert_eq!(n(c, "SELECT COUNT(*) FROM review_log"), logs_before + 1, "{name}");
    assert_eq!(n(c, "SELECT COUNT(*) FROM vocab_note WHERE body = '老笔记二'"), 0, "{name} 的删除应已传到");
  }
  println!("步骤3-5 备注两边都是 B 的；w3 复习记录两边各 2 条；老笔记二两边都已删除；A 行数 {:?} B 行数 {:?}", counts(&a), counts(&b));
  assert_eq!(counts(&a), counts(&b));
  // B 之后再同步，不会把删掉的笔记同步回来
  sync(&b, &space, "dev-b").unwrap();
  sync(&a, &space, "dev-a").unwrap();
  assert_eq!(n(&b, "SELECT COUNT(*) FROM vocab_note WHERE body = '老笔记二'"), 0);
  assert_eq!(n(&a, "SELECT COUNT(*) FROM vocab_note WHERE body = '老笔记二'"), 0);
  println!("步骤6 删除没有复活");

  // 7. 另一个空间 C：写点数据，A、B 拉不到；C 也拉不到 A、B 的
  let space_c = Space::create(&url, &key);
  let dir_c = tmp("c");
  let c = open_db(&dir_c.join("c.db"));
  c.execute_batch("INSERT INTO vocab_note (word_key, word, body, source, created_at, updated_at) VALUES ('c', 'c', '只属于C的笔记', '词库', '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z');").unwrap();
  sync(&c, &space_c, "dev-c").unwrap();
  sync(&a, &space, "dev-a").unwrap();
  sync(&b, &space, "dev-b").unwrap();
  assert_eq!(n(&a, "SELECT COUNT(*) FROM vocab_note WHERE body = '只属于C的笔记'"), 0);
  assert_eq!(n(&b, "SELECT COUNT(*) FROM vocab_note WHERE body = '只属于C的笔记'"), 0);
  assert_eq!(n(&c, "SELECT COUNT(*) FROM review_word"), 0);
  println!("步骤7 空间 C 的数据 A/B 没有；C 也没有 A/B 的词");

  // 8. 服务中断：同步报网络错误，本机数据不坏、待推送还在；恢复后补上
  a.execute("INSERT INTO quick_note (body, created_at, updated_at, device_id) VALUES ('断线时写的', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z', 'a')", []).unwrap();
  let dead = Space { url: "http://127.0.0.1:1".into(), app_key: key.clone(), id: space.id.clone(), secret: space.secret.clone() };
  let err = sync(&a, &dead, "dev-a").unwrap_err();
  println!("步骤8 断线时的错误：{err}");
  let integrity: String = a.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
  assert_eq!(integrity, "ok");
  assert!(n(&a, "SELECT COUNT(*) FROM sync_change WHERE dirty = 1") >= 1);
  sync(&a, &space, "dev-a").unwrap();
  sync(&b, &space, "dev-b").unwrap();
  assert_eq!(n(&b, "SELECT COUNT(*) FROM quick_note WHERE body = '断线时写的'"), 1);
  println!("步骤8 恢复后补上，B 已有『断线时写的』");

  // 9. 删除空间后再同步 → 401
  let (st, _) = http("DELETE", &format!("{url}/space"), &space_c.headers(), None).unwrap();
  assert_eq!(st, 200);
  let err = sync(&c, &space_c, "dev-c").unwrap_err();
  assert!(err.contains("401"), "{err}");
  println!("步骤9 删除空间后再同步：{err}");
  drop((a, b, c));
  let _ = std::fs::remove_dir_all(dir);
  let _ = std::fs::remove_dir_all(dir_c);
}
