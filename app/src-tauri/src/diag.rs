//! 083 更新防丢数据：设置快照 + 启动记录，都放在应用自己的数据目录里（和 vocab.db 同一处）。
//! 快照只在本机，不上传、不进同步；内容由前端拼好（含 API key），这里只负责原子写入和读出。
//! 启动记录每次启动一行、最多留最近 100 行，下次出事时能查「库文件还在不在、设置有没有」。

use crate::paths::app_data_dir;
use chrono::Local;
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_LOG_LINES: usize = 100;
const SNAPSHOT_FILE: &str = "settings-snapshot.json";
const LOG_FILE: &str = "launch-log.txt";

fn dir() -> PathBuf { app_data_dir() }

/// 先写临时文件再改名，写到一半断电也不会留下半份快照。
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
  if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败：{e}"))?; }
  let tmp = path.with_extension("tmp");
  fs::write(&tmp, text).map_err(|e| format!("写入失败：{e}"))?;
  if path.exists() { let _ = fs::remove_file(path); }
  fs::rename(&tmp, path).map_err(|e| format!("保存失败：{e}"))
}

fn read_opt(path: &Path) -> Result<Option<String>, String> {
  match fs::read_to_string(path) {
    Ok(s) => Ok(Some(s)),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!("读取失败：{e}")),
  }
}

/// 把新一行接到旧记录后面，只留最后 `max` 行。
pub fn append_trimmed(existing: &str, line: &str, max: usize) -> String {
  let mut lines: Vec<&str> = existing.lines().filter(|l| !l.trim().is_empty()).collect();
  lines.push(line);
  let start = lines.len().saturating_sub(max);
  let mut out = lines[start..].join("\n");
  out.push('\n');
  out
}

#[tauri::command]
pub fn diag_snapshot_write(json: String) -> Result<(), String> {
  write_atomic(&dir().join(SNAPSHOT_FILE), &json)
}

#[tauri::command]
pub fn diag_snapshot_read() -> Result<Option<String>, String> {
  read_opt(&dir().join(SNAPSHOT_FILE))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchInfo {
  pub version: String,
  /// localStorage 里本应用的键数。
  pub keys: i64,
  /// 快照里的保存时间（毫秒），没有快照就不传。
  pub snapshot_at: Option<i64>,
  /// 仅安卓：包的首次安装 / 最近更新时间（毫秒）。
  pub first_install: Option<i64>,
  pub last_update: Option<i64>,
}

fn count_words(db: &Path) -> String {
  if !db.is_file() { return "无库".into(); }
  let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY;
  match rusqlite::Connection::open_with_flags(db, flags)
    .and_then(|c| c.query_row("SELECT COUNT(*) FROM review_word WHERE deleted = 0", [], |r| r.get::<_, i64>(0)))
  {
    Ok(n) => n.to_string(),
    Err(_) => "读不出".into(),
  }
}

fn stamp(ms: i64) -> String {
  chrono::DateTime::from_timestamp_millis(ms)
    .map(|t| t.with_timezone(&Local).format("%Y-%m-%d %H:%M").to_string())
    .unwrap_or_else(|| ms.to_string())
}

pub fn launch_line(info: &LaunchInfo, db: &Path, snapshot_exists: bool) -> String {
  let size = fs::metadata(db).map(|m| m.len().to_string()).unwrap_or_else(|_| "无".into());
  let snapshot = match (snapshot_exists, info.snapshot_at) {
    (true, Some(at)) => format!("有({})", stamp(at)),
    (true, None) => "有".into(),
    (false, _) => "无".into(),
  };
  let mut line = format!(
    "{} v{} 设置键={} 词数={} 库大小={}B 快照={}",
    Local::now().format("%Y-%m-%d %H:%M:%S"), info.version, info.keys, count_words(db), size, snapshot,
  );
  if let Some(t) = info.first_install { line.push_str(&format!(" 首次安装={}", stamp(t))); }
  if let Some(t) = info.last_update { line.push_str(&format!(" 最近更新={}", stamp(t))); }
  line
}

/// 记一行启动记录，返回这一行（方便界面和测试看）。
#[tauri::command]
pub fn diag_record_launch(info: LaunchInfo) -> Result<String, String> {
  let d = dir();
  let line = launch_line(&info, &super::vocab::schema::db_path(), d.join(SNAPSHOT_FILE).is_file());
  let path = d.join(LOG_FILE);
  let old = read_opt(&path)?.unwrap_or_default();
  write_atomic(&path, &append_trimmed(&old, &line, MAX_LOG_LINES))?;
  Ok(line)
}

/// 最近 n 行启动记录（旧在前）。
#[tauri::command]
pub fn diag_log_tail(n: usize) -> Result<Vec<String>, String> {
  let text = read_opt(&dir().join(LOG_FILE))?.unwrap_or_default();
  let lines: Vec<String> = text.lines().filter(|l| !l.trim().is_empty()).map(String::from).collect();
  let start = lines.len().saturating_sub(n);
  Ok(lines[start..].to_vec())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn log_keeps_only_latest_100_lines() {
    let mut text = String::new();
    for i in 0..130 { text = append_trimmed(&text, &format!("line{i}"), MAX_LOG_LINES); }
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 100);
    assert_eq!(lines[0], "line30");
    assert_eq!(lines[99], "line129");
  }

  #[test]
  fn launch_line_reports_missing_db_and_snapshot() {
    let info = LaunchInfo { version: "0.11.0".into(), keys: 7, snapshot_at: None, first_install: Some(0), last_update: None };
    let line = launch_line(&info, Path::new("Z:/no/such/vocab.db"), false);
    assert!(line.contains("v0.11.0") && line.contains("设置键=7") && line.contains("词数=无库") && line.contains("快照=无"));
    assert!(line.contains("首次安装="));
  }

  #[test]
  fn snapshot_roundtrip_and_missing() {
    let dir = std::env::temp_dir().join(format!("diag-test-{}", uuid::Uuid::new_v4().simple()));
    let p = dir.join(SNAPSHOT_FILE);
    assert_eq!(read_opt(&p).unwrap(), None);
    write_atomic(&p, "{\"a\":1}").unwrap();
    write_atomic(&p, "{\"a\":2}").unwrap();
    assert_eq!(read_opt(&p).unwrap().as_deref(), Some("{\"a\":2}"));
    let _ = fs::remove_dir_all(&dir);
  }
}
