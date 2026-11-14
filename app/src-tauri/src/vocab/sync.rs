//! 071 同步核心（应用端）：记账（触发器）、推送用的读取、拉取后的合并。
//! 网络请求在前端（app/utils/sync/）；这里只管本机 vocab.db，协议见 docs/tasks/070-同步服务-服务器端.md。
//!
//! 同步身份（sid）：
//! - TEXT 主键表：主键本身；
//! - 复合主键表：各主键列按固定顺序用 `\u{1f}`（ASCII 单元分隔符，正常文字里不会出现）拼起来；
//! - 自增整数主键表（review_log、review_event、vocab_note、vocab_example、quick_note）：新加的 `sync_uid` 列
//!   （新行 `u:` + 随机 32 位十六进制；老行迁移时按确定性算法回填 `legacy:…`，见 [`legacy_uid`]）。

use rusqlite::{params, types::Value, types::ValueRef, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

pub const SEP: char = '\u{1f}';

#[derive(Clone, Copy)]
pub enum Key {
  /// 单列 TEXT 主键
  Text(&'static str),
  /// 复合主键（列的顺序就是拼 sid 的顺序）
  Composite(&'static [&'static str]),
  /// 自增整数 id + sync_uid；参数是「创建时就定下、之后不改」的列，用来算 legacy 回填
  Auto(&'static [&'static str]),
}

pub struct Spec {
  pub name: &'static str,
  pub key: Key,
  /// 首次同步时拿来当 updated_at 的列（依次试，取第一个能解析的）
  pub time_cols: &'static [&'static str],
  /// 只增不删：同身份已存在就不覆盖、不删除
  pub append_only: bool,
}

const fn spec(name: &'static str, key: Key, time_cols: &'static [&'static str]) -> Spec {
  Spec { name, key, time_cols, append_only: false }
}

/// 白名单（和服务端一致）。顺序里父表在子表前面。
pub const SPECS: &[Spec] = &[
  spec("review_word", Key::Text("id"), &["updated_at", "imported_at"]),
  spec("upgrade_entry", Key::Text("id"), &["updated_at", "imported_at"]),
  spec("upgrade_example", Key::Composite(&["entry_id", "seq"]), &[]),
  spec("self_check", Key::Text("id"), &["updated_at", "imported_at"]),
  spec("review_definition", Key::Composite(&["word_id", "source_file", "source_line"]), &[]),
  spec("review_definition_example", Key::Composite(&["word_id", "source_file", "definition_line", "seq"]), &[]),
  Spec { name: "review_log", key: Key::Auto(&["word_id", "review_date", "kind", "correct", "before_status", "after_status", "before_due", "after_due", "created_at"]), time_cols: &["created_at"], append_only: true },
  Spec { name: "review_event", key: Key::Auto(&["word_id", "review_date", "kind", "correct", "created_at"]), time_cols: &["created_at"], append_only: true },
  spec("vocab_note", Key::Auto(&["word_key", "word", "created_at"]), &["updated_at", "created_at"]),
  spec("vocab_example", Key::Auto(&["word_key", "word", "created_at"]), &["created_at"]),
  spec("example_scene", Key::Text("key"), &["updated_at"]),
  spec("quick_note", Key::Auto(&["created_at", "device_id", "ctx_kind"]), &["updated_at", "created_at"]),
  spec("error_top", Key::Text("id"), &[]),
  spec("error_batch", Key::Text("id"), &[]),
  spec("error_item", Key::Text("id"), &[]),
  spec("error_todo", Key::Text("id"), &[]),
  spec("error_essay", Key::Text("id"), &[]),
  spec("coach_essay", Key::Text("id"), &["created_at"]),
  spec("coach_top_progress", Key::Text("top_id"), &[]),
];

pub fn find_spec(name: &str) -> Option<&'static Spec> {
  SPECS.iter().find(|s| s.name == name)
}

fn auto_tables() -> impl Iterator<Item = &'static Spec> {
  SPECS.iter().filter(|s| matches!(s.key, Key::Auto(_)))
}

/// SQL 里取某行 sid 的表达式；`p` 是 `NEW.` / `OLD.` / 空。
fn sid_expr(spec: &Spec, p: &str) -> String {
  match spec.key {
    Key::Text(c) => format!("{p}{c}"),
    Key::Composite(cols) => cols.iter().map(|c| format!("{p}{c}")).collect::<Vec<_>>().join(" || char(31) || "),
    Key::Auto(_) => format!("{p}sync_uid"),
  }
}

const NOW_MS: &str = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const NOT_APPLYING: &str = "NOT EXISTS (SELECT 1 FROM sync_meta WHERE k = 'applying' AND v = '1')";

fn record_sql(table: &str, sid: &str, deleted: u8) -> String {
  format!(
    "INSERT INTO sync_change (tbl, sid, updated_at, deleted, dirty) SELECT '{table}', {sid}, {NOW_MS}, {deleted}, 1 \
     WHERE {NOT_APPLYING} \
     ON CONFLICT(tbl, sid) DO UPDATE SET updated_at = max(excluded.updated_at, sync_change.updated_at + 1), deleted = excluded.deleted, dirty = 1;"
  )
}

fn trigger_sql() -> String {
  let mut sql = String::new();
  for s in SPECS {
    let t = s.name;
    let auto = matches!(s.key, Key::Auto(_));
    for suffix in ["ai", "au", "ad"] {
      sql += &format!("DROP TRIGGER IF EXISTS sync_{t}_{suffix};
");
    }
    // INSERT
    if auto {
      sql += &format!(
        "CREATE TRIGGER sync_{t}_ai AFTER INSERT ON {t} BEGIN \
         UPDATE {t} SET sync_uid = 'u:' || lower(hex(randomblob(16))) WHERE id = NEW.id AND sync_uid IS NULL; {} END;\n",
        record_sql(t, &format!("(SELECT sync_uid FROM {t} WHERE id = NEW.id)"), 0)
      );
    } else {
      sql += &format!("CREATE TRIGGER sync_{t}_ai AFTER INSERT ON {t} BEGIN {} END;\n", record_sql(t, &sid_expr(s, "NEW."), 0));
    }
    // UPDATE（改了主键时，旧身份记成删除）
    let when = if auto { "WHEN OLD.sync_uid IS NOT NULL AND NEW.sync_uid IS OLD.sync_uid" } else { "" };
    let old_gone = if auto { String::new() } else {
      format!(
        "INSERT INTO sync_change (tbl, sid, updated_at, deleted, dirty) SELECT '{t}', {old}, {NOW_MS}, 1, 1 \
         WHERE {NOT_APPLYING} AND ({old}) IS NOT ({new}) \
         ON CONFLICT(tbl, sid) DO UPDATE SET updated_at = max(excluded.updated_at, sync_change.updated_at + 1), deleted = 1, dirty = 1;",
        old = sid_expr(s, "OLD."), new = sid_expr(s, "NEW.")
      )
    };
    sql += &format!(
      "CREATE TRIGGER sync_{t}_au AFTER UPDATE ON {t} {when} BEGIN {old_gone} {} END;\n",
      record_sql(t, &sid_expr(s, "NEW."), 0)
    );
    // DELETE
    let when = if auto { "WHEN OLD.sync_uid IS NOT NULL" } else { "" };
    sql += &format!("CREATE TRIGGER sync_{t}_ad AFTER DELETE ON {t} {when} BEGIN {} END;\n", record_sql(t, &sid_expr(s, "OLD."), 1));
  }
  sql
}

fn text_of(v: &Value) -> String {
  match v {
    Value::Null => String::new(),
    Value::Integer(i) => i.to_string(),
    Value::Real(f) => f.to_string(),
    Value::Text(s) => s.clone(),
    Value::Blob(b) => format!("blob{}", b.len()),
  }
}

/// 老行（迁移前就有的行）的确定性 sync_uid：`legacy:表名:本机整数id:哈希`，哈希取各「创建时定下」的列。
/// 同一份库复制出的两台设备算出来一样；复制之后各自新增、恰好撞号的行，因为创建时间等字段不同，算出来不一样。
pub fn legacy_uid(table: &str, id: i64, stable: &[String]) -> String {
  let mut h = Sha256::new();
  h.update(table.as_bytes());
  h.update([0x1f]);
  h.update(id.to_string().as_bytes());
  for f in stable {
    h.update([0x1f]);
    h.update(f.as_bytes());
  }
  let hex: String = h.finalize().iter().take(16).map(|b| format!("{b:02x}")).collect();
  format!("legacy:{table}:{id}:{hex}")
}

/// v11 → v12：加 sync_uid（回填）、sync_change、sync_meta 和全部触发器。
pub fn migrate_v12(conn: &Connection) -> rusqlite::Result<()> {
  conn.execute_batch(
    "CREATE TABLE IF NOT EXISTS sync_change (
       tbl TEXT NOT NULL, sid TEXT NOT NULL, updated_at INTEGER NOT NULL,
       deleted INTEGER NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 1,
       PRIMARY KEY (tbl, sid));
     CREATE INDEX IF NOT EXISTS sync_change_dirty ON sync_change(dirty) WHERE dirty = 1;
     CREATE TABLE IF NOT EXISTS sync_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);",
  )?;
  for s in auto_tables() {
    let Key::Auto(stable) = s.key else { continue };
    let t = s.name;
    // 已经有这一列（例如测试里把库「降级」后重新升级）就不再加
    let has_uid = {
      let mut stmt = conn.prepare(&format!("PRAGMA table_info({t})"))?;
      let names = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
      names.iter().any(|n| n == "sync_uid")
    };
    if !has_uid {
      conn.execute_batch(&format!("ALTER TABLE {t} ADD COLUMN sync_uid TEXT;"))?;
    }
    let sql = format!("SELECT id, {} FROM {t}", stable.join(", "));
    let rows = {
      let mut stmt = conn.prepare(&sql)?;
      let list = stmt
        .query_map([], |row| {
          let id: i64 = row.get(0)?;
          let mut fields = Vec::new();
          for i in 0..stable.len() {
            fields.push(text_of(&row.get::<_, Value>(i + 1)?));
          }
          Ok((id, fields))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
      list
    };
    let mut upd = conn.prepare(&format!("UPDATE {t} SET sync_uid = ?1 WHERE id = ?2 AND sync_uid IS NULL"))?;
    for (id, fields) in rows {
      upd.execute(params![legacy_uid(t, id, &fields), id])?;
    }
    conn.execute_batch(&format!("CREATE UNIQUE INDEX IF NOT EXISTS {t}_sync_uid ON {t}(sync_uid);"))?;
  }
  conn.execute_batch(&trigger_sql())?;
  Ok(())
}

// ───────────────────────── 状态与首次同步 ─────────────────────────

fn meta_get(conn: &Connection, k: &str) -> rusqlite::Result<Option<String>> {
  conn.query_row("SELECT v FROM sync_meta WHERE k = ?1", [k], |r| r.get(0)).optional()
}
fn meta_set(conn: &Connection, k: &str, v: &str) -> rusqlite::Result<()> {
  conn.execute("INSERT INTO sync_meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v", params![k, v])?;
  Ok(())
}

/// 把所有白名单表的现有行记成 dirty=1。updated_at：已有记录的保留；没有的用行里已有的修改时间（解析不出就 0）。
pub fn mark_all_dirty(conn: &Connection) -> rusqlite::Result<()> {
  for s in SPECS {
    let time = if s.time_cols.is_empty() {
      "0".to_string()
    } else {
      let parts: Vec<String> = s.time_cols.iter().map(|c| format!("CAST(strftime('%s', {c}) AS INTEGER) * 1000")).collect();
      format!("COALESCE({}, 0)", parts.join(", "))
    };
    conn.execute_batch(&format!(
      "INSERT INTO sync_change (tbl, sid, updated_at, deleted, dirty) SELECT '{t}', {sid}, {time}, 0, 1 FROM {t} WHERE {sid} IS NOT NULL \
       ON CONFLICT(tbl, sid) DO UPDATE SET dirty = 1;",
      t = s.name, sid = sid_expr(s, "")
    ))?;
  }
  Ok(())
}

/// 整库搬家后：同步状态全部作废（cursor、首次标记、别的设备留下的账本），所有行重新记成待推送。
pub fn reset_all(conn: &Connection) -> rusqlite::Result<()> {
  let tx = conn.unchecked_transaction()?;
  tx.execute("DELETE FROM sync_meta", [])?;
  tx.execute("DELETE FROM sync_change", [])?;
  mark_all_dirty(&tx)?;
  tx.commit()
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct Begin {
  pub device_id: String,
  pub cursor: i64,
  pub first_time: bool,
}

/// 一次同步开始：这个「服务器#空间」第一次同步就把所有行记成待推送；返回上次的 cursor。
pub fn begin(conn: &Connection, server_key: &str, device_id: &str) -> rusqlite::Result<Begin> {
  let init_key = format!("init:{server_key}");
  let first_time = meta_get(conn, &init_key)?.is_none();
  if first_time {
    let tx = conn.unchecked_transaction()?;
    mark_all_dirty(&tx)?;
    tx.execute("DELETE FROM sync_meta WHERE k = ?1", [format!("cursor:{server_key}")])?;
    meta_set(&tx, &init_key, "1")?;
    tx.commit()?;
  }
  let cursor = meta_get(conn, &format!("cursor:{server_key}"))?.and_then(|v| v.parse().ok()).unwrap_or(0);
  Ok(Begin { device_id: device_id.to_string(), cursor, first_time })
}

pub fn finish(conn: &Connection, server_key: &str, now_ms: i64) -> rusqlite::Result<()> {
  meta_set(conn, &format!("last:{server_key}"), &now_ms.to_string())
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct Status {
  pub device_id: String,
  pub dirty: i64,
  pub cursor: i64,
  pub last_sync_ms: Option<i64>,
}

pub fn status(conn: &Connection, server_key: &str, device_id: &str) -> rusqlite::Result<Status> {
  Ok(Status {
    device_id: device_id.to_string(),
    dirty: conn.query_row("SELECT COUNT(*) FROM sync_change WHERE dirty = 1", [], |r| r.get(0))?,
    cursor: meta_get(conn, &format!("cursor:{server_key}"))?.and_then(|v| v.parse().ok()).unwrap_or(0),
    last_sync_ms: meta_get(conn, &format!("last:{server_key}"))?.and_then(|v| v.parse().ok()),
  })
}

// ───────────────────────── 推送侧：读出改动 ─────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ChangeOut {
  pub table: String,
  pub id: String,
  pub updated_at: i64,
  pub deleted: bool,
  pub data: Option<Json>,
}

fn json_of(v: ValueRef) -> Json {
  match v {
    ValueRef::Null | ValueRef::Blob(_) => Json::Null,
    ValueRef::Integer(i) => Json::from(i),
    ValueRef::Real(f) => serde_json::Number::from_f64(f).map(Json::Number).unwrap_or(Json::Null),
    ValueRef::Text(t) => Json::String(String::from_utf8_lossy(t).into_owned()),
  }
}

/// 按 sid 拼 WHERE 条件和参数。
fn where_for(spec: &Spec, sid: &str) -> Option<(String, Vec<String>)> {
  match spec.key {
    Key::Text(c) => Some((format!("{c} = ?1"), vec![sid.to_string()])),
    Key::Auto(_) => Some(("sync_uid = ?1".into(), vec![sid.to_string()])),
    Key::Composite(cols) => {
      let parts: Vec<&str> = sid.split(SEP).collect();
      if parts.len() != cols.len() {
        return None;
      }
      let cond = cols.iter().enumerate().map(|(i, c)| format!("{c} = ?{}", i + 1)).collect::<Vec<_>>().join(" AND ");
      Some((cond, parts.into_iter().map(String::from).collect()))
    }
  }
}

fn read_row(conn: &Connection, spec: &Spec, sid: &str) -> rusqlite::Result<Option<Json>> {
  let Some((cond, args)) = where_for(spec, sid) else { return Ok(None) };
  let mut stmt = conn.prepare(&format!("SELECT * FROM {} WHERE {cond}", spec.name))?;
  let names: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
  let mut rows = stmt.query(rusqlite::params_from_iter(args.iter()))?;
  let Some(row) = rows.next()? else { return Ok(None) };
  let auto = matches!(spec.key, Key::Auto(_));
  let mut map = Map::new();
  for (i, name) in names.iter().enumerate() {
    if auto && (name == "id" || name == "sync_uid") {
      continue;
    }
    map.insert(name.clone(), json_of(row.get_ref(i)?));
  }
  Ok(Some(Json::Object(map)))
}

/// 取最多 limit 条待推送改动（整行读出；行已不在就按删除推）。
pub fn collect(conn: &Connection, limit: usize) -> rusqlite::Result<Vec<ChangeOut>> {
  let pending = {
    let mut stmt = conn.prepare("SELECT tbl, sid, updated_at, deleted FROM sync_change WHERE dirty = 1 ORDER BY rowid LIMIT ?1")?;
    let list = stmt
      .query_map([limit as i64], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)? != 0)))?
      .collect::<rusqlite::Result<Vec<_>>>()?;
    list
  };
  let mut out = Vec::new();
  for (tbl, sid, updated_at, deleted) in pending {
    let Some(spec) = find_spec(&tbl) else { continue };
    let data = if deleted { None } else { read_row(conn, spec, &sid)? };
    let gone = deleted || data.is_none();
    out.push(ChangeOut { table: tbl, id: sid, updated_at, deleted: gone, data: if gone { None } else { data } });
  }
  Ok(out)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AckItem {
  pub table: String,
  pub id: String,
  pub updated_at: i64,
}

/// 服务端收下后清 dirty；推送期间又被改过（updated_at 变了）的不清。
pub fn ack(conn: &Connection, items: &[AckItem]) -> rusqlite::Result<usize> {
  let tx = conn.unchecked_transaction()?;
  let mut n = 0;
  {
    let mut stmt = tx.prepare("UPDATE sync_change SET dirty = 0 WHERE tbl = ?1 AND sid = ?2 AND updated_at = ?3")?;
    for i in items {
      n += stmt.execute(params![i.table, i.id, i.updated_at])?;
    }
  }
  tx.commit()?;
  Ok(n)
}

// ───────────────────────── 拉取侧：合并 ─────────────────────────

#[derive(Debug, Deserialize, Clone)]
pub struct RemoteChange {
  pub table: String,
  pub id: String,
  pub updated_at: i64,
  #[serde(default)]
  pub deleted: bool,
  #[serde(default)]
  pub device_id: String,
  #[serde(default)]
  pub data: Option<Json>,
}

#[derive(Debug, Serialize, Default, PartialEq)]
pub struct ApplyResult {
  pub applied: usize,
  pub skipped: usize,
}

enum Outcome {
  Applied,
  Skipped,
}

fn bind_json(v: &Json) -> Value {
  match v {
    Json::Null => Value::Null,
    Json::Bool(b) => Value::Integer(*b as i64),
    Json::Number(n) => n.as_i64().map(Value::Integer).unwrap_or_else(|| Value::Real(n.as_f64().unwrap_or(0.0))),
    Json::String(s) => Value::Text(s.clone()),
    other => Value::Text(other.to_string()),
  }
}

struct Col {
  name: String,
  ty: String,
  notnull: bool,
  has_default: bool,
}

fn table_cols(conn: &Connection, table: &str) -> rusqlite::Result<Vec<Col>> {
  let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
  let list = stmt
    .query_map([], |r| {
      Ok(Col { name: r.get(1)?, ty: r.get::<_, String>(2)?.to_uppercase(), notnull: r.get::<_, i64>(3)? != 0, has_default: r.get::<_, Option<String>>(4)?.is_some() })
    })?
    .collect::<rusqlite::Result<Vec<_>>>()?;
  Ok(list)
}

fn set_change(conn: &Connection, table: &str, sid: &str, updated_at: i64, deleted: bool) -> rusqlite::Result<()> {
  conn.execute(
    "INSERT INTO sync_change (tbl, sid, updated_at, deleted, dirty) VALUES (?1, ?2, ?3, ?4, 0) \
     ON CONFLICT(tbl, sid) DO UPDATE SET updated_at = excluded.updated_at, deleted = excluded.deleted, dirty = 0",
    params![table, sid, updated_at, deleted as i64],
  )?;
  Ok(())
}

fn apply_one(conn: &Connection, c: &RemoteChange, device_id: &str) -> Result<Outcome, String> {
  let err = |e: rusqlite::Error| e.to_string();
  let Some(spec) = find_spec(&c.table) else { return Ok(Outcome::Skipped) };
  let local: Option<(i64, i64)> = conn
    .query_row("SELECT updated_at, dirty FROM sync_change WHERE tbl = ?1 AND sid = ?2", params![c.table, c.id], |r| Ok((r.get(0)?, r.get(1)?)))
    .optional()
    .map_err(err)?;
  // 本机记录比远端更新（含已推送的删除记录，防止旧修改把删掉的行复活），
  // 或一样新且本机待推送、本机设备号更大：跳过，等下次推上去。
  if let Some((lu, dirty)) = local {
    if lu > c.updated_at || (lu == c.updated_at && dirty == 1 && device_id >= c.device_id.as_str()) {
      return Ok(Outcome::Skipped);
    }
  }
  let Some((cond, args)) = where_for(spec, &c.id) else { return Ok(Outcome::Skipped) };
  let exists = |conn: &Connection| -> Result<bool, String> {
    conn.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {} WHERE {cond})", spec.name), rusqlite::params_from_iter(args.iter()), |r| r.get(0)).map_err(err)
  };
  if spec.append_only {
    // 只增不删：已有就保持原样；删除请求不理。
    if c.deleted {
      return Ok(Outcome::Skipped);
    }
    if exists(conn)? {
      set_change(conn, &c.table, &c.id, c.updated_at, false).map_err(err)?;
      return Ok(Outcome::Skipped);
    }
  }
  if c.deleted {
    conn.execute(&format!("DELETE FROM {} WHERE {cond}", spec.name), rusqlite::params_from_iter(args.iter())).map_err(err)?;
    set_change(conn, &c.table, &c.id, c.updated_at, true).map_err(err)?;
    return Ok(Outcome::Applied);
  }
  let Some(Json::Object(data)) = &c.data else { return Ok(Outcome::Skipped) };
  let cols = table_cols(conn, spec.name).map_err(err)?;
  let local_cols: Vec<&str> = cols.iter().map(|c| c.name.as_str()).collect();
  let key_cols: Vec<&str> = match spec.key {
    Key::Text(k) => vec![k],
    Key::Composite(k) => k.to_vec(),
    Key::Auto(_) => vec![],
  };
  let skip_cols = ["id", "sync_uid"];
  // 提供的非主键列：data 里有、本机也有的（自增表还要排除 id / sync_uid）
  let provided: Vec<(&str, Value)> = data
    .iter()
    .filter(|(k, _)| local_cols.contains(&k.as_str()) && !key_cols.contains(&k.as_str()) && !(matches!(spec.key, Key::Auto(_)) && skip_cols.contains(&k.as_str())))
    .map(|(k, v)| (k.as_str(), bind_json(v)))
    .collect();
  // 本机多出来、data 没有的列：有默认值的交给默认值；NOT NULL 又没默认值的补空值，免得插入失败。
  let filler = |name: &str| -> Option<Value> {
    let col = cols.iter().find(|c| c.name == name)?;
    if provided.iter().any(|(n, _)| *n == name) || !col.notnull || col.has_default {
      return None;
    }
    Some(if col.ty.contains("INT") || col.ty.contains("REAL") { Value::Integer(0) } else { Value::Text(String::new()) })
  };
  let t = spec.name;
  match spec.key {
    Key::Auto(_) => {
      let id: Option<i64> = conn.query_row(&format!("SELECT id FROM {t} WHERE sync_uid = ?1"), [&c.id], |r| r.get(0)).optional().map_err(err)?;
      if let Some(id) = id {
        if !provided.is_empty() {
          let set = provided.iter().enumerate().map(|(i, (n, _))| format!("{n} = ?{}", i + 1)).collect::<Vec<_>>().join(", ");
          let mut vals: Vec<Value> = provided.iter().map(|(_, v)| v.clone()).collect();
          vals.push(Value::Integer(id));
          conn.execute(&format!("UPDATE {t} SET {set} WHERE id = ?{}", vals.len()), rusqlite::params_from_iter(vals.iter())).map_err(err)?;
        }
      } else {
        let mut names = vec!["sync_uid".to_string()];
        let mut vals = vec![Value::Text(c.id.clone())];
        for (n, v) in &provided {
          names.push(n.to_string());
          vals.push(v.clone());
        }
        for col in &cols {
          if col.name == "id" || col.name == "sync_uid" {
            continue;
          }
          if let Some(v) = filler(&col.name) {
            names.push(col.name.clone());
            vals.push(v);
          }
        }
        let ph = (1..=vals.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
        conn.execute(&format!("INSERT INTO {t} ({}) VALUES ({ph})", names.join(", ")), rusqlite::params_from_iter(vals.iter())).map_err(err)?;
      }
    }
    _ => {
      let key_vals: Vec<Value> = match spec.key {
        Key::Text(k) => vec![data.get(k).map(bind_json).filter(|v| *v != Value::Null).unwrap_or_else(|| Value::Text(c.id.clone()))],
        _ => {
          let parts: Vec<&str> = c.id.split(SEP).collect();
          key_cols
            .iter()
            .enumerate()
            .map(|(i, k)| data.get(*k).map(bind_json).filter(|v| *v != Value::Null).unwrap_or_else(|| Value::Text(parts.get(i).unwrap_or(&"").to_string())))
            .collect()
        }
      };
      let mut names: Vec<String> = key_cols.iter().map(|s| s.to_string()).collect();
      let mut vals = key_vals;
      for (n, v) in &provided {
        names.push(n.to_string());
        vals.push(v.clone());
      }
      for col in &cols {
        if key_cols.contains(&col.name.as_str()) {
          continue;
        }
        if let Some(v) = filler(&col.name) {
          names.push(col.name.clone());
          vals.push(v);
        }
      }
      let ph = (1..=vals.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(", ");
      let conflict = if provided.is_empty() {
        "DO NOTHING".to_string()
      } else {
        format!("DO UPDATE SET {}", provided.iter().map(|(n, _)| format!("{n} = excluded.{n}")).collect::<Vec<_>>().join(", "))
      };
      conn.execute(
        &format!("INSERT INTO {t} ({}) VALUES ({ph}) ON CONFLICT({}) {conflict}", names.join(", "), key_cols.join(", ")),
        rusqlite::params_from_iter(vals.iter()),
      )
      .map_err(err)?;
    }
  }
  set_change(conn, &c.table, &c.id, c.updated_at, false).map_err(err)?;
  Ok(Outcome::Applied)
}

fn apply_page_once(conn: &Connection, changes: &[RemoteChange], device_id: &str, cursor: Option<(&str, i64)>, defer_fk: bool) -> Result<ApplyResult, String> {
  let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
  if defer_fk {
    tx.execute_batch("PRAGMA defer_foreign_keys = ON").map_err(|e| e.to_string())?;
  }
  meta_set(&tx, "applying", "1").map_err(|e| e.to_string())?;
  let mut result = ApplyResult::default();
  for c in changes {
    tx.execute_batch("SAVEPOINT row_apply").map_err(|e| e.to_string())?;
    match apply_one(&tx, c, device_id) {
      Ok(Outcome::Applied) => {
        tx.execute_batch("RELEASE row_apply").map_err(|e| e.to_string())?;
        result.applied += 1;
      }
      Ok(Outcome::Skipped) => {
        tx.execute_batch("RELEASE row_apply").map_err(|e| e.to_string())?;
        result.skipped += 1;
      }
      Err(_) => {
        // 单条写不进（约束、列类型不对等）：丢掉这一条，不拖垮整页。
        tx.execute_batch("ROLLBACK TO row_apply; RELEASE row_apply").map_err(|e| e.to_string())?;
        result.skipped += 1;
      }
    }
  }
  tx.execute("DELETE FROM sync_meta WHERE k = 'applying'", []).map_err(|e| e.to_string())?;
  if let Some((key, cur)) = cursor {
    let old: i64 = meta_get(&tx, &format!("cursor:{key}")).map_err(|e| e.to_string())?.and_then(|v| v.parse().ok()).unwrap_or(0);
    meta_set(&tx, &format!("cursor:{key}"), &cur.max(old).to_string()).map_err(|e| e.to_string())?;
  }
  tx.commit().map_err(|e| e.to_string())?;
  Ok(result)
}

/// 一页一个事务：触发器暂停记账、外键检查推迟到提交时；提交时仍有外键问题就关掉外键再来一次，免得同步永远卡在这一页。
pub fn apply(conn: &Connection, changes: &[RemoteChange], device_id: &str, cursor: Option<(&str, i64)>) -> Result<ApplyResult, String> {
  match apply_page_once(conn, changes, device_id, cursor, true) {
    Err(e) if e.contains("FOREIGN KEY") => {
      conn.pragma_update(None, "foreign_keys", "OFF").map_err(|e| e.to_string())?;
      let r = apply_page_once(conn, changes, device_id, cursor, false);
      let _ = conn.pragma_update(None, "foreign_keys", "ON");
      r
    }
    other => other,
  }
}

// ───────────────────────── 设备号 ─────────────────────────

/// 设备号放在数据目录下单独一个文件，不在 vocab.db 里：整库复制不会把设备号一起复制过去。
pub fn device_id_path() -> PathBuf {
  crate::paths::app_data_dir().join("sync-device-id")
}

pub fn device_id() -> Result<String, String> {
  let path = device_id_path();
  if let Ok(text) = std::fs::read_to_string(&path) {
    let id = text.trim().to_string();
    if !id.is_empty() {
      return Ok(id);
    }
  }
  if let Some(dir) = path.parent() {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
  }
  let id = format!("dev-{}", uuid::Uuid::new_v4().simple());
  std::fs::write(&path, &id).map_err(|e| format!("保存设备号失败：{e}"))?;
  Ok(id)
}
