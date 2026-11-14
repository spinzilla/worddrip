use super::models::BrowseData;
use super::query;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const UPGRADE_HEADER: &str = "| 日常/口语 | 学术升级 | 例句 | 出处 | 备注 |\n|---|---|---|---|---|";
const REVIEW_HEADER: &str = "| 单词 | 期号 | 入库日期 | 状态 | 下次到期 | 备注 |\n|---|---|---|---|---|---|";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportKind { Upgrade, Review }

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest { pub kind: ExportKind, pub path: String }

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VocabExportResult {
  pub path: String,
  pub kind: ExportKind,
  pub records: usize,
  pub self_checks: usize,
  pub source_csv_path: Option<String>,
  /// 040：有笔记时同目录写的 `我的笔记.md`；没有笔记为 None。
  pub notes_path: Option<String>,
  pub notes: usize,
  /// 043：有例句时同目录写的 `我的例句.md`；没有例句为 None。
  pub examples_path: Option<String>,
  pub examples: usize,
}

fn render_upgrade(data: &BrowseData) -> Result<String, String> {
  if data.upgrades.is_empty() { return Err("学术升级库为空，没有可导出的升级记录".into()); }
  let mut lines = vec!["## 词汇升级".to_string(), UPGRADE_HEADER.to_string()];
  lines.extend(data.upgrades.iter().map(|item| item.raw.clone()));
  lines.push("## 写作自查对照".to_string());
  lines.extend(data.self_checks.iter().map(|item| item.raw.clone()));
  lines.push(String::new());
  Ok(lines.join("\n"))
}

fn current_review_row(item: &super::models::BrowseReviewWord) -> String {
  let due = if item.due.is_empty() { "—" } else { item.due.as_str() };
  let cells: Vec<_> = item.raw.trim().trim_start_matches('|').trim_end_matches('|').split('|').map(str::trim).collect();
  // 没写回过的行逐字保留；写回过的行只按当前业务字段重排六列。
  if cells.len() == 6
    && cells[0] == item.word
    && cells[1] == item.issue
    && cells[2] == item.added_at
    && cells[3] == item.status
    && (cells[4] == due || (item.due.is_empty() && cells[4].is_empty()))
    && cells[5] == item.note
  {
    return item.raw.clone();
  }
  format!("| {} | {} | {} | {} | {} | {} |", item.word, item.issue, item.added_at, item.status, due, item.note)
}

fn render_review(data: &BrowseData) -> Result<String, String> {
  if data.review_words.is_empty() { return Err("复习库为空，没有可导出的复习记录".into()); }
  let mut lines = vec!["# 词汇总词库".to_string(), "## 总词库".to_string(), REVIEW_HEADER.to_string()];
  lines.extend(data.review_words.iter().map(current_review_row));
  lines.push(String::new());
  Ok(lines.join("\n"))
}

fn csv_cell(value: &str) -> String {
  if value.contains([',', '"', '\r', '\n']) {
    format!("\"{}\"", value.replace('"', "\"\""))
  } else {
    value.to_string()
  }
}

fn render_review_csv(data: &BrowseData) -> String {
  // Excel 双击打开 UTF-8 文件时按本地编码猜，中文会乱码；开头加 UTF-8 BOM 就能认出来。
  let mut lines = vec!["\u{feff}词条 ID,词目,来源,查证状态".to_string()];
  lines.extend(data.review_words.iter().map(|item| [
    csv_cell(&item.id),
    csv_cell(&item.word),
    csv_cell(&item.source),
    csv_cell(&item.verification_status),
  ].join(",")));
  lines.push(String::new());
  lines.join("\n")
}

fn protected_dirs() -> Vec<PathBuf> {
  let mut dirs = vec![PathBuf::from(r"D:\Hermes"), PathBuf::from(r"D:\english"), PathBuf::from(r"D:\Apps\LinguaClip")];
  if let Some(local) = std::env::var_os("LOCALAPPDATA") {
    let local = PathBuf::from(local);
    dirs.push(local.join("hermes"));
    dirs.push(local.join("com.linguaclip.app"));
  }
  if let Some(profile) = std::env::var_os("USERPROFILE") {
    let profile = PathBuf::from(profile);
    dirs.push(profile.join("Videos").join("LinguaClip"));
    dirs.push(profile.join("Documents").join("linguaclip-srt"));
  }
  dirs
}

#[cfg(windows)]
fn path_key(path: &Path) -> PathBuf { PathBuf::from(path.to_string_lossy().to_lowercase()) }
#[cfg(not(windows))]
fn path_key(path: &Path) -> PathBuf { path.to_path_buf() }
fn inside(path: &Path, dir: &Path) -> bool { path_key(path).starts_with(path_key(dir)) }

/// 目标尚不存在，规范化已存在的父目录；这样能穿过符号链接和 Windows 联接。
fn resolve_new_target(path: &Path, protected: &[PathBuf]) -> Result<PathBuf, String> {
  if !path.is_absolute() { return Err("导出路径必须是绝对路径".into()); }
  match fs::symlink_metadata(path) {
    Ok(_) => return Err("目标文件已存在，已拒绝覆盖".into()),
    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
    Err(error) => return Err(format!("检查导出目标失败：{error}")),
  }
  let parent = path.parent().filter(|parent| !parent.as_os_str().is_empty())
    .ok_or_else(|| "导出路径缺少文件名".to_string())?;
  let name = path.file_name().ok_or_else(|| "导出路径缺少文件名".to_string())?;
  let canonical_parent = parent.canonicalize().map_err(|error| {
    if error.kind() == io::ErrorKind::NotFound { "导出位置的父目录不存在，请重新选择".to_string() }
    else { format!("解析导出目录失败：{error}") }
  })?;
  if !canonical_parent.is_dir() { return Err("导出位置的父路径不是文件夹".into()); }
  let target = canonical_parent.join(name);
  for dir in protected {
    if let Ok(canonical_dir) = dir.canonicalize() {
      if canonical_dir.is_dir() && inside(&target, &canonical_dir) {
        return Err(format!("不能写入只读来源目录：{}", dir.display()));
      }
    }
  }
  Ok(target)
}

fn create_error(error: io::Error) -> String {
  if error.kind() == io::ErrorKind::AlreadyExists { "目标文件已存在，已拒绝覆盖".into() }
  else { format!("排他创建导出文件失败：{error}") }
}

/// create_new 是最后的原子闸门；失败时只删除这次成功创建的半成品。
fn write_new_with<F>(path: &Path, content: &str, protected: &[PathBuf], before_write: F) -> Result<(), String>
where F: FnOnce(&mut File) -> io::Result<()> {
  let target = resolve_new_target(path, protected)?;
  let mut file = OpenOptions::new().write(true).create_new(true).open(&target).map_err(create_error)?;
  let result = (|| -> io::Result<()> {
    before_write(&mut file)?;
    file.write_all(content.as_bytes())?;
    file.sync_all()
  })();
  match result {
    Ok(()) => { drop(file); Ok(()) }
    Err(error) => {
      drop(file);
      match fs::remove_file(&target) {
        Ok(()) => Err(format!("写入导出文件失败，已清理半成品：{error}")),
        Err(cleanup) => Err(format!("写入导出文件失败：{error}；半成品清理也失败：{cleanup}")),
      }
    }
  }
}

fn write_new(path: &Path, content: &str, protected: &[PathBuf]) -> Result<(), String> {
  write_new_with(path, content, protected, |_| Ok(()))
}

pub const NOTES_FILE_NAME: &str = "我的笔记.md";
pub const EXAMPLES_FILE_NAME: &str = "我的例句.md";

/// 已写好的文件逐个删掉（倒序），把清理结果拼到错误后面。
fn rollback(error: String, written: &[(&Path, &str)]) -> String {
  let mut message = error;
  for (path, label) in written.iter().rev() {
    match fs::remove_file(path) {
      Ok(()) => message.push_str(&format!("；已清理本次新建的{label}")),
      Err(cleanup) => message.push_str(&format!("；本次新建的{label}清理也失败：{cleanup}")),
    }
  }
  message
}

pub fn export_at(db_path: &Path, kind: ExportKind, output: &Path) -> Result<VocabExportResult, String> {
  let data = query::browse_at(db_path)?;
  let content = match kind {
    ExportKind::Upgrade => render_upgrade(&data)?,
    ExportKind::Review => render_review(&data)?,
  };
  let protected = protected_dirs();
  let source_csv = (kind == ExportKind::Review).then(|| output.with_file_name("词条来源与查证.csv"));
  // 040：笔记跟着复习库（总词库）一起导出，内容是全部笔记（含升级库候选词的）；没有笔记就不写。
  // 只挂在复习库导出上，两种导出存到同一个文件夹时才不会互相撞名。
  let notes = if kind == ExportKind::Review { super::notes::list_at(db_path)? } else { Vec::new() };
  let notes_markdown = super::notes::render_markdown(&notes);
  let notes_path = notes_markdown.as_ref().map(|_| output.with_file_name(NOTES_FILE_NAME));
  // 043：例句同理，只跟复习库导出，没有就不写。
  let examples = if kind == ExportKind::Review { super::examples::list_at(db_path)? } else { Vec::new() };
  let examples_markdown = super::examples::render_markdown(&examples);
  let examples_path = examples_markdown.as_ref().map(|_| output.with_file_name(EXAMPLES_FILE_NAME));
  if let Some(csv_path) = &source_csv {
    // 所有目标都先检查，避免 CSV 或笔记已存在时留下一个看似成功的 Markdown。
    let markdown_target = resolve_new_target(output, &protected)?;
    let csv_target = resolve_new_target(csv_path, &protected)?;
    if path_key(&markdown_target) == path_key(&csv_target) {
      return Err("Markdown 与词条来源 CSV 不能保存为同一个文件".into());
    }
    if let Some(notes) = &notes_path {
      let notes_target = resolve_new_target(notes, &protected)?;
      if path_key(&markdown_target) == path_key(&notes_target) {
        return Err(format!("词库 Markdown 不能和笔记文件同名（{NOTES_FILE_NAME}）"));
      }
    }
    if let Some(examples) = &examples_path {
      let examples_target = resolve_new_target(examples, &protected)?;
      if path_key(&markdown_target) == path_key(&examples_target) {
        return Err(format!("词库 Markdown 不能和例句文件同名（{EXAMPLES_FILE_NAME}）"));
      }
    }
  }
  write_new(output, &content, &protected)?;
  if let Some(csv_path) = &source_csv {
    if let Err(error) = write_new(csv_path, &render_review_csv(&data), &protected) {
      return Err(rollback(error, &[(output, " Markdown")]));
    }
  }
  if let (Some(notes), Some(markdown), Some(csv_path)) = (&notes_path, &notes_markdown, &source_csv) {
    if let Err(error) = write_new(notes, markdown, &protected) {
      return Err(rollback(error, &[(output, " Markdown"), (csv_path, "词条来源 CSV")]));
    }
  }
  if let (Some(examples_file), Some(markdown), Some(csv_path)) = (&examples_path, &examples_markdown, &source_csv) {
    if let Err(error) = write_new(examples_file, markdown, &protected) {
      let mut written: Vec<(&Path, &str)> = vec![(output, " Markdown"), (csv_path, "词条来源 CSV")];
      if let Some(notes) = &notes_path { written.push((notes, "笔记文件")); }
      return Err(rollback(error, &written));
    }
  }
  Ok(VocabExportResult {
    path: output.to_string_lossy().into_owned(), kind,
    records: match kind { ExportKind::Upgrade => data.upgrades.len(), ExportKind::Review => data.review_words.len() },
    self_checks: if kind == ExportKind::Upgrade { data.self_checks.len() } else { 0 },
    source_csv_path: source_csv.map(|path| path.to_string_lossy().into_owned()),
    notes_path: notes_path.map(|path| path.to_string_lossy().into_owned()),
    notes: notes.len(),
    examples_path: examples_path.map(|path| path.to_string_lossy().into_owned()),
    examples: examples.len(),
  })
}
#[cfg(test)]
mod tests {
  use super::*;
  use crate::vocab::{import, models::ImportRequest, schema};
  use rusqlite::{Connection, OpenFlags};
  use sha2::{Digest, Sha256};
  use std::sync::{Arc, Barrier};
  use uuid::Uuid;

  struct Tmp(PathBuf);
  impl Tmp {
    fn new(label: &str) -> Self {
      let path = std::env::temp_dir().join(format!("vocab-export-{label}-{}", Uuid::new_v4()));
      fs::create_dir_all(&path).unwrap();
      Self(path)
    }
  }
  impl Drop for Tmp {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
  }

  fn sha256(path: &Path) -> String { format!("{:x}", Sha256::digest(fs::read(path).unwrap())) }

  fn seed(path: &Path) {
    let conn = schema::open(path).unwrap();
    conn.execute(
      "INSERT INTO upgrade_entry (id, ord, line, raw, plain, upgrade, source, note, imported_at, updated_at, deleted)
       VALUES ('up:b', 2, 9, '| b | **B** | b: B. | 来源 | 长备注 |', 'b', 'B', '来源', '长备注', 't', 't', 0),
              ('up:a', 1, 8, '| a | **A** | a: A. (AI) | 来源 | 备注 |', 'a', 'A', '来源', '备注', 't', 't', 0),
              ('up:gone', 0, 1, '| deleted |', 'gone', 'gone', '', '', 't', 't', 1)", [],
    ).unwrap();
    conn.execute(
      "INSERT INTO self_check (id, ord, line, raw, text, imported_at, updated_at, deleted)
       VALUES ('sc:1', 1, 12, '- 自查原行', '自查原行', 't', 't', 0),
              ('sc:gone', 0, 1, '- deleted', 'deleted', 't', 't', 1)", [],
    ).unwrap();
    conn.execute(
      "INSERT INTO review_word (id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note, imported_at, updated_at, deleted)
       VALUES ('rv:a', 1, 4, '| word | 1.1 | 原日期 | L4 | — | 原备注 |', 'word', 'word', '1.1', '原日期', 'L4', 4, '', '原备注', 't', 't', 0),
              ('rv:gone', 0, 1, '| deleted |', 'gone', 'gone', '', '', '', NULL, '', '', 't', 't', 1)", [],
    ).unwrap();
    conn.execute(
      "UPDATE review_word SET source = '课堂，\"ACL\"', verification_status = '老师确认' WHERE id = 'rv:a'",
      [],
    ).unwrap();
  }

  fn fingerprint(path: &Path) -> Vec<String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let queries = [
      "SELECT id, ord, line, raw, plain, upgrade, source, note, imported_at, updated_at, deleted FROM upgrade_entry ORDER BY id",
      "SELECT entry_id, seq, cand, sentence, ai FROM upgrade_example ORDER BY entry_id, seq",
      "SELECT id, ord, line, raw, text, imported_at, updated_at, deleted FROM self_check ORDER BY id",
      "SELECT id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note, source, verification_status, imported_at, updated_at, deleted FROM review_word ORDER BY id",
      "SELECT id, source_file, source_sha256, started_at, counts_json, warnings_json FROM import_run ORDER BY id",
    ];
    let mut result = Vec::new();
    for sql in queries {
      let mut stmt = conn.prepare(sql).unwrap();
      let count = stmt.column_count();
      let rows = stmt.query_map([], |row| {
        let values = (0..count).map(|index| row.get::<_, rusqlite::types::Value>(index))
          .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(values.iter().map(|value| format!("{value:?}")).collect::<Vec<_>>().join("|"))
      }).unwrap();
      result.extend(rows.map(|row| row.unwrap()));
    }
    result
  }

  #[test]
  fn exports_raw_in_order_and_does_not_change_db() {
    let tmp = Tmp::new("raw");
    let db = tmp.0.join("vocab.db");
    seed(&db);
    let before = fingerprint(&db);
    let before_hash = sha256(&db);
    let upgrade = tmp.0.join("升级.md");
    let result = export_at(&db, ExportKind::Upgrade, &upgrade).unwrap();
    assert_eq!(result.records, 2);
    assert_eq!(result.self_checks, 1);
    assert_eq!(fs::read_to_string(&upgrade).unwrap(), concat!(
      "## 词汇升级\n",
      "| 日常/口语 | 学术升级 | 例句 | 出处 | 备注 |\n",
      "|---|---|---|---|---|\n",
      "| a | **A** | a: A. (AI) | 来源 | 备注 |\n",
      "| b | **B** | b: B. | 来源 | 长备注 |\n",
      "## 写作自查对照\n",
      "- 自查原行\n"
    ));
    assert!(!fs::read(&upgrade).unwrap().starts_with(&[0xef, 0xbb, 0xbf]));
    let review = tmp.0.join("复习.md");
    export_at(&db, ExportKind::Review, &review).unwrap();
    assert_eq!(fs::read_to_string(&review).unwrap(), concat!(
      "# 词汇总词库\n## 总词库\n",
      "| 单词 | 期号 | 入库日期 | 状态 | 下次到期 | 备注 |\n",
      "|---|---|---|---|---|---|\n",
      "| word | 1.1 | 原日期 | L4 | — | 原备注 |\n"
    ));
    let csv = tmp.0.join("词条来源与查证.csv");
    let csv_bytes = fs::read(&csv).unwrap();
    assert_eq!(&csv_bytes[..3], &[0xef, 0xbb, 0xbf], "CSV 必须以 UTF-8 BOM 开头，Excel 才不会把中文认错");
    assert_eq!(String::from_utf8(csv_bytes[3..].to_vec()).unwrap(), concat!(
      "词条 ID,词目,来源,查证状态\n",
      "rv:a,word,\"课堂，\"\"ACL\"\"\",老师确认\n"
    ));
    assert_eq!(fingerprint(&db), before);
    assert_eq!(sha256(&db), before_hash);
  }

  fn add_note(db: &Path, word: &str, body: &str, source: &str) {
    crate::vocab::notes::add_at(db, crate::vocab::notes::NoteAddRequest { word: word.into(), body: body.into(), source: source.into() }).unwrap();
  }

  fn add_example(db: &Path, word: &str, sentence: &str, source: &str) {
    crate::vocab::examples::add_at(db, crate::vocab::examples::ExampleAddRequest {
      word: word.into(),
      items: vec![crate::vocab::examples::ExampleItem { sentence: sentence.into(), source: source.into(), explanation: Some("说明".into()), sense: None, original: None }],
    }).unwrap();
  }

  /// 043：复习库导出时，有例句就在同目录多写一份「我的例句.md」；原 Markdown、CSV、笔记文件一字不变；升级库导出不带。
  #[test]
  fn review_export_writes_examples_file_next_to_notes() {
    let tmp = Tmp::new("examples");
    let db = tmp.0.join("vocab.db");
    seed(&db);
    let plain = tmp.0.join("plain");
    fs::create_dir(&plain).unwrap();
    let result = export_at(&db, ExportKind::Review, &plain.join("复习.md")).unwrap();
    assert_eq!((result.examples_path, result.examples), (None, 0));
    assert!(!plain.join(EXAMPLES_FILE_NAME).exists());
    let plain_md = fs::read(plain.join("复习.md")).unwrap();
    let plain_csv = fs::read(plain.join("词条来源与查证.csv")).unwrap();

    add_example(&db, "Word", "My first word sentence.", "自己写");
    add_example(&db, "word", "A second word sentence.", "AI生成");
    add_note(&db, "word", "一条笔记", "词库");
    let before = fingerprint(&db);
    let dir = tmp.0.join("with");
    fs::create_dir(&dir).unwrap();
    let result = export_at(&db, ExportKind::Review, &dir.join("复习.md")).unwrap();
    let examples_path = dir.join(EXAMPLES_FILE_NAME);
    assert_eq!(result.examples_path.as_deref(), Some(examples_path.to_string_lossy().as_ref()));
    assert_eq!(result.examples, 2);
    assert_eq!(result.notes, 1);
    assert!(dir.join(NOTES_FILE_NAME).exists());
    assert_eq!(fs::read(dir.join("复习.md")).unwrap(), plain_md);
    assert_eq!(fs::read(dir.join("词条来源与查证.csv")).unwrap(), plain_csv);
    let text = fs::read_to_string(&examples_path).unwrap();
    assert_eq!(Some(text.clone()), crate::vocab::examples::render_markdown(&crate::vocab::examples::list_at(&db).unwrap()));
    assert!(text.starts_with("# 我的例句

共 1 个词、2 句。"));
    assert!(text.contains("- A second word sentence.
  - 来源：AI生成"));
    assert!(text.contains("- My first word sentence.
  - 来源：自己写"));
    assert_eq!(fingerprint(&db), before, "导出不改库");

    // 升级库导出不带例句
    let upgrade_dir = tmp.0.join("upgrade");
    fs::create_dir(&upgrade_dir).unwrap();
    let result = export_at(&db, ExportKind::Upgrade, &upgrade_dir.join("升级.md")).unwrap();
    assert_eq!(result.examples_path, None);
    assert!(!upgrade_dir.join(EXAMPLES_FILE_NAME).exists());

    // 例句文件已存在：拒绝覆盖，本次一个文件都不留下
    let taken = tmp.0.join("taken");
    fs::create_dir(&taken).unwrap();
    fs::write(taken.join(EXAMPLES_FILE_NAME), "原有例句").unwrap();
    assert!(export_at(&db, ExportKind::Review, &taken.join("复习.md")).unwrap_err().contains("拒绝覆盖"));
    assert_eq!(fs::read_dir(&taken).unwrap().count(), 1);
    assert_eq!(fs::read_to_string(taken.join(EXAMPLES_FILE_NAME)).unwrap(), "原有例句");
    // 把复习库本身存成「我的例句.md」也拒绝
    let other = tmp.0.join("other");
    fs::create_dir(&other).unwrap();
    assert!(export_at(&db, ExportKind::Review, &other.join(EXAMPLES_FILE_NAME)).unwrap_err().contains("同名"));
    assert_eq!(fs::read_dir(&other).unwrap().count(), 0);
  }

  /// 040：复习库导出时，有笔记就在同目录多写一份「我的笔记.md」；原 Markdown 和 CSV 一字不变。
  #[test]
  fn review_export_writes_notes_file_and_keeps_markdown_and_csv() {
    let tmp = Tmp::new("notes");
    let db = tmp.0.join("vocab.db");
    seed(&db);
    // 没有笔记：不写笔记文件
    let plain = tmp.0.join("plain");
    fs::create_dir(&plain).unwrap();
    let result = export_at(&db, ExportKind::Review, &plain.join("复习.md")).unwrap();
    assert_eq!((result.notes_path, result.notes), (None, 0));
    assert!(!plain.join(NOTES_FILE_NAME).exists());
    let plain_md = fs::read(plain.join("复习.md")).unwrap();
    let plain_csv = fs::read(plain.join("词条来源与查证.csv")).unwrap();

    add_note(&db, "Word", "第一条\n第二行", "词库");
    add_note(&db, "word", "第二条", "复习");
    add_note(&db, "in the light of", "升级库里的短语", "词库");
    let before = fingerprint(&db);
    let with_notes = tmp.0.join("with");
    fs::create_dir(&with_notes).unwrap();
    let result = export_at(&db, ExportKind::Review, &with_notes.join("复习.md")).unwrap();
    let notes_path = with_notes.join(NOTES_FILE_NAME);
    assert_eq!(result.notes_path.as_deref(), Some(notes_path.to_string_lossy().as_ref()));
    assert_eq!(result.notes, 3);
    assert_eq!(fs::read(with_notes.join("复习.md")).unwrap(), plain_md);
    assert_eq!(fs::read(with_notes.join("词条来源与查证.csv")).unwrap(), plain_csv);
    let text = fs::read_to_string(&notes_path).unwrap();
    let all = crate::vocab::notes::list_at(&db).unwrap();
    assert_eq!(Some(text.clone()), crate::vocab::notes::render_markdown(&all));
    assert!(text.starts_with("# 我的笔记\n\n共 2 个词、3 条笔记。"));
    let light = text.find("## in the light of").unwrap();
    let word = text.find("## Word").unwrap();
    assert!(light < word);
    assert!(text.find("  第二条").unwrap() < text.find("  第一条").unwrap(), "同一个词新的在前");
    assert!(text.contains(" · 复习\n  第二条") && text.contains(" · 词库\n  第一条\n  第二行"));
    assert_eq!(fingerprint(&db), before);

    // 升级库导出不带笔记
    let upgrade_dir = tmp.0.join("upgrade");
    fs::create_dir(&upgrade_dir).unwrap();
    let result = export_at(&db, ExportKind::Upgrade, &upgrade_dir.join("升级.md")).unwrap();
    assert_eq!(result.notes_path, None);
    assert!(!upgrade_dir.join(NOTES_FILE_NAME).exists());
  }

  #[test]
  fn existing_notes_file_is_not_overwritten_and_nothing_is_left_behind() {
    let tmp = Tmp::new("notes-exists");
    let db = tmp.0.join("vocab.db");
    seed(&db);
    add_note(&db, "word", "x", "词库");
    let notes = tmp.0.join(NOTES_FILE_NAME);
    fs::write(&notes, "原有笔记").unwrap();
    let error = export_at(&db, ExportKind::Review, &tmp.0.join("复习.md")).unwrap_err();
    assert!(error.contains("拒绝覆盖"));
    assert!(!tmp.0.join("复习.md").exists());
    assert!(!tmp.0.join("词条来源与查证.csv").exists());
    assert_eq!(fs::read_to_string(&notes).unwrap(), "原有笔记");
    // 把复习库本身存成「我的笔记.md」也拒绝
    let other = tmp.0.join("other");
    fs::create_dir(&other).unwrap();
    assert!(export_at(&db, ExportKind::Review, &other.join(NOTES_FILE_NAME)).unwrap_err().contains("同名"));
    assert_eq!(fs::read_dir(&other).unwrap().count(), 0);
  }

  #[test]
  fn existing_source_csv_is_not_overwritten_and_markdown_is_cleaned_up() {
    let tmp = Tmp::new("existing-csv");
    let db = tmp.0.join("vocab.db");
    seed(&db);
    let review = tmp.0.join("复习.md");
    let csv = tmp.0.join("词条来源与查证.csv");
    fs::write(&csv, "原有 CSV").unwrap();

    let error = export_at(&db, ExportKind::Review, &review).unwrap_err();
    assert!(error.contains("拒绝覆盖"));
    assert!(!review.exists());
    assert_eq!(fs::read_to_string(&csv).unwrap(), "原有 CSV");
  }

  #[test]
  fn existing_file_is_never_overwritten() {
    let tmp = Tmp::new("exists");
    let db = tmp.0.join("vocab.db");
    seed(&db);
    let output = tmp.0.join("existing.md");
    fs::write(&output, "原有内容").unwrap();
    let before = sha256(&output);
    assert!(export_at(&db, ExportKind::Upgrade, &output).unwrap_err().contains("拒绝覆盖"));
    assert_eq!(sha256(&output), before);
  }

  #[test]
  fn missing_parent_is_not_created() {
    let tmp = Tmp::new("parent");
    let db = tmp.0.join("vocab.db");
    seed(&db);
    let parent = tmp.0.join("missing");
    let error = export_at(&db, ExportKind::Upgrade, &parent.join("out.md")).unwrap_err();
    assert!(error.contains("父目录不存在"));
    assert!(!parent.exists());
  }

  #[test]
  fn write_failure_removes_only_new_partial_file() {
    let tmp = Tmp::new("failure");
    let output = tmp.0.join("partial.md");
    let error = write_new_with(&output, "不会完整写入", &[], |_| {
      Err(io::Error::other("注入写失败"))
    }).unwrap_err();
    assert!(error.contains("注入写失败"));
    assert!(!output.exists());
    fs::write(&output, "既有文件").unwrap();
    assert!(write_new(&output, "新内容", &[]).is_err());
    assert_eq!(fs::read_to_string(&output).unwrap(), "既有文件");
  }

  #[test]
  fn competing_exports_have_exactly_one_winner() {
    let tmp = Tmp::new("race");
    let db = tmp.0.join("vocab.db");
    seed(&db);
    let output = Arc::new(tmp.0.join("race.md"));
    let db = Arc::new(db);
    let barrier = Arc::new(Barrier::new(2));
    let threads = (0..2).map(|_| {
      let output = Arc::clone(&output);
      let db = Arc::clone(&db);
      let barrier = Arc::clone(&barrier);
      std::thread::spawn(move || {
        barrier.wait();
        export_at(&db, ExportKind::Upgrade, &output)
      })
    }).collect::<Vec<_>>();
    let results = threads.into_iter().map(|thread| thread.join().unwrap()).collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
    assert!(fs::read_to_string(&*output).unwrap().contains("| a | **A**"));
  }

  #[test]
  fn junction_to_protected_directory_is_rejected() {
    let tmp = Tmp::new("junction");
    let protected = tmp.0.join("protected");
    fs::create_dir(&protected).unwrap();
    let alias = tmp.0.join("alias");
    #[cfg(windows)]
    let status = std::process::Command::new("cmd").args(["/c", "mklink", "/J"])
      .arg(&alias).arg(&protected).status().unwrap();
    #[cfg(not(windows))]
    let status = {
      std::os::unix::fs::symlink(&protected, &alias).unwrap();
      std::process::ExitStatus::default()
    };
    assert!(status.success());
    let error = write_new(&alias.join("out.md"), "不得写入", &[protected]).unwrap_err();
    assert!(error.contains("只读来源目录"));
    assert!(!alias.join("out.md").exists());
  }

  #[test]
  fn empty_category_and_missing_db_do_not_create_output_or_db() {
    let tmp = Tmp::new("empty");
    let db = tmp.0.join("missing.db");
    let output = tmp.0.join("out.md");
    assert!(export_at(&db, ExportKind::Upgrade, &output).unwrap_err().contains("为空"));
    assert!(!db.exists() && !output.exists());
  }
  #[derive(Serialize)]
  struct RawRow { id: String, raw: String }

  fn raw_rows(conn: &Connection, sql: &str) -> Vec<RawRow> {
    let mut stmt = conn.prepare(sql).unwrap();
    stmt.query_map([], |row| Ok(RawRow { id: row.get(0)?, raw: row.get(1)? })).unwrap()
      .collect::<rusqlite::Result<Vec<_>>>().unwrap()
  }

  /// Node 脚本提供 007 的解析结果；这里走生产导入、生产导出，再独立直查 SQLite。
  #[test]
  #[ignore = "由 node test-vocab-export.mjs 提供输入并调用"]
  fn node_round_trip() {
    let root = PathBuf::from(std::env::var_os("ES_VOCAB_EXPORT_ROUNDTRIP_DIR").unwrap());
    let request: ImportRequest = serde_json::from_str(&fs::read_to_string(root.join("request.json")).unwrap()).unwrap();
    let db = root.join("vocab.db");
    import::import_at(&db, request).unwrap();
    {
      let conn = schema::open(&db).unwrap();
      conn.execute(
        "INSERT INTO upgrade_entry (id, ord, line, raw, plain, upgrade, source, note, imported_at, updated_at, deleted)
         VALUES ('up:deleted', 0, 1, '| deleted-upgrade |', 'deleted', 'deleted', '', '', 't', 't', 1)", [],
      ).unwrap();
      conn.execute(
        "INSERT INTO self_check (id, ord, line, raw, text, imported_at, updated_at, deleted)
         VALUES ('sc:deleted', 0, 1, '- deleted-check', 'deleted', 't', 't', 1)", [],
      ).unwrap();
      conn.execute(
        "INSERT INTO review_word (id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note, imported_at, updated_at, deleted)
         VALUES ('rv:deleted', 0, 1, '| deleted-review |', 'deleted', 'deleted', '', '', '', NULL, '', '', 't', 't', 1)", [],
      ).unwrap();
    }
    let before = fingerprint(&db);
    let before_hash = sha256(&db);
    let upgrade = root.join("upgrade-export.md");
    let review = root.join("review-export.md");
    export_at(&db, ExportKind::Upgrade, &upgrade).unwrap();
    export_at(&db, ExportKind::Review, &review).unwrap();
    assert_eq!(fingerprint(&db), before);
    assert_eq!(sha256(&db), before_hash);
    let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let evidence = serde_json::json!({
      "upgrade": raw_rows(&conn, "SELECT id, raw FROM upgrade_entry WHERE deleted = 0 ORDER BY ord, id"),
      "selfChecks": raw_rows(&conn, "SELECT id, raw FROM self_check WHERE deleted = 0 ORDER BY ord, id"),
      "review": raw_rows(&conn, "SELECT id, raw FROM review_word WHERE deleted = 0 ORDER BY ord, id"),
      "dbSha256Before": before_hash,
      "dbSha256After": sha256(&db),
      "recordSnapshotUnchanged": fingerprint(&db) == before,
    });
    fs::write(root.join("db-evidence.json"), serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
  }
}