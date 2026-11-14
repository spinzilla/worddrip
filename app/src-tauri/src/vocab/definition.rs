use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use rusqlite::{params, Connection, OpenFlags};

use super::models::{
  DefinitionImportReport, DefinitionImportRequest, DefinitionUnmatched, SourceInput,
};
use super::schema;

#[derive(Debug, Clone, PartialEq)]
struct ExampleInput {
  sentence: String,
  ai: bool,
}

#[derive(Debug, Clone, PartialEq)]
struct ParsedDefinition {
  file_name: String,
  line: i64,
  word: String,
  issue: Option<String>,
  pos: String,
  english: String,
  chinese: String,
  examples: Vec<ExampleInput>,
}

#[derive(Debug)]
struct ReviewCandidate {
  id: String,
  issue: String,
  word_norm: String,
}

#[derive(Debug, Clone, PartialEq)]
struct StoredDefinition {
  pos: String,
  english: String,
  chinese: String,
  examples: Vec<ExampleInput>,
}

type DefinitionKey = (String, String, i64);

#[derive(Debug)]
struct PlannedDefinition {
  word_id: String,
  parsed: ParsedDefinition,
}

#[derive(Debug, Default)]
struct ImportPlan {
  definitions: Vec<PlannedDefinition>,
  report: DefinitionImportReport,
}

fn contains_cjk(text: &str) -> bool {
  text.chars().any(|c| matches!(c, '\u{3400}'..='\u{9fff}'))
}

fn normalize_word(word: &str) -> String {
  word.trim().to_lowercase()
}

fn normalize_space(text: &str) -> String {
  text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_pos(text: &str) -> bool {
  let lower = text.trim().to_lowercase();
  let cleaned = lower
    .trim_matches(|c: char| matches!(c, '(' | ')' | '（' | '）' | '.' | ' '))
    .replace('.', "");
  if cleaned == "n - usually pl" || cleaned == "n-usually pl" {
    return true;
  }
  cleaned.split_whitespace().all(|part| {
    part.split('/').all(|item| {
      matches!(
        item,
        "n" | "v" | "adj" | "adv" | "phr" | "prep" | "conj" | "pron" | "det" | "num"
          | "prefix" | "suffix" | "aux"
      )
    })
  }) && !cleaned.is_empty()
}

fn split_plain_header(header: &str) -> (String, String) {
  let header = header.trim();
  let words = header.split_whitespace().collect::<Vec<_>>();
  for start in [words.len().saturating_sub(2), words.len().saturating_sub(1)] {
    if start < words.len() {
      let candidate = words[start..].join(" ");
      if is_pos(&candidate) {
        return (words[..start].join(" "), candidate);
      }
    }
  }
  (header.to_string(), String::new())
}

fn valid_word(word: &str) -> bool {
  !word.is_empty()
    && word.len() <= 120
    && word.chars().any(|c| c.is_ascii_alphabetic())
    && !contains_cjk(word)
    && !word.chars().any(|c| matches!(c, '|' | '#' | '*' | '`' | '—'))
}

fn issue_from_file(file_name: &str) -> Option<String> {
  let stem = Path::new(file_name).file_stem()?.to_str()?;
  if stem.len() != 8 || !stem.bytes().all(|b| b.is_ascii_digit()) {
    return None;
  }
  let month = stem[4..6].parse::<u8>().ok()?;
  let day = stem[6..8].parse::<u8>().ok()?;
  if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
    return None;
  }
  Some(format!("{month}.{day}"))
}

fn looks_like_example(text: &str) -> bool {
  text.chars().any(|c| c.is_ascii_alphabetic())
    && text.chars().any(char::is_whitespace)
    && !text.contains('\n')
}

fn tidy_example(text: &str) -> String {
  normalize_space(
    &text
      .replace("**", "")
      .replace("(AI)", "")
      .replace("（AI）", ""),
  )
  .trim()
  .to_string()
}

fn ai_after(text: &str, end: usize) -> Option<usize> {
  let rest = &text[end..];
  let spaces = rest.len() - rest.trim_start().len();
  let after = &rest[spaces..];
  for marker in ["(AI)", "（AI）"] {
    if after.starts_with(marker) {
      return Some(end + spaces + marker.len());
    }
  }
  None
}

/// 抽取一种成对标记。返回值里剩下的文本继续用于释义，避免例句又混进英英释义。
fn extract_marked(
  input: &str,
  open: &str,
  close: &str,
  italic: bool,
  examples: &mut Vec<ExampleInput>,
) -> String {
  let mut output = String::with_capacity(input.len());
  let mut cursor = 0;
  while let Some(relative) = input[cursor..].find(open) {
    let start = cursor + relative;
    if italic {
      let before = input[..start].ends_with('*');
      let after = input[start + 1..].starts_with('*');
      if before || after {
        output.push_str(&input[cursor..start + 1]);
        cursor = start + 1;
        continue;
      }
    }
    let content_start = start + open.len();
    let Some(relative_end) = input[content_start..].find(close) else {
      break;
    };
    let content_end = content_start + relative_end;
    if italic && input[content_end..].starts_with("**") {
      output.push_str(&input[cursor..content_end + 1]);
      cursor = content_end + 1;
      continue;
    }
    let raw = &input[content_start..content_end];
    let marked_end = content_end + close.len();
    let ai_end = ai_after(input, marked_end);
    let ai = raw.contains("(AI)") || raw.contains("（AI）") || ai_end.is_some();
    if looks_like_example(raw) {
      output.push_str(&input[cursor..start]);
      output.push(' ');
      examples.push(ExampleInput { sentence: tidy_example(raw), ai });
      cursor = ai_end.unwrap_or(marked_end);
    } else {
      output.push_str(&input[cursor..marked_end]);
      cursor = marked_end;
    }
  }
  output.push_str(&input[cursor..]);
  output
}

fn extract_examples(body: &str) -> (String, Vec<ExampleInput>) {
  let mut examples = Vec::new();
  let mut rest = extract_marked(body, "*", "*", true, &mut examples);
  rest = extract_marked(&rest, "“", "”", false, &mut examples);
  rest = extract_marked(&rest, "\"", "\"", false, &mut examples);
  (rest, examples)
}

fn remove_parenthesized_pos(body: &str) -> (String, String) {
  let mut output = String::with_capacity(body.len());
  let mut pos = String::new();
  let mut cursor = 0;
  let chars = body.char_indices().collect::<Vec<_>>();
  let mut index = 0;
  while index < chars.len() {
    let (at, c) = chars[index];
    let close = match c {
      '(' => ')',
      '（' => '）',
      _ => {
        index += 1;
        continue;
      }
    };
    let Some(end_index) = chars[index + 1..].iter().position(|(_, item)| *item == close).map(|p| p + index + 1) else {
      break;
    };
    let content_start = at + c.len_utf8();
    let content_end = chars[end_index].0;
    let content = &body[content_start..content_end];
    if is_pos(content) {
      output.push_str(&body[cursor..at]);
      output.push(' ');
      if pos.is_empty() {
        pos = content.trim().to_string();
      }
      cursor = content_end + close.len_utf8();
    }
    index = end_index + 1;
  }
  output.push_str(&body[cursor..]);
  (output, pos)
}

fn remove_leading_pos(body: &str) -> (String, String) {
  let trimmed = body.trim_start();
  let end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
  let candidate = &trimmed[..end];
  if is_pos(candidate) {
    (trimmed[end..].trim_start().to_string(), candidate.to_string())
  } else {
    (body.to_string(), String::new())
  }
}

fn split_chinese(body: &str) -> (String, String) {
  let mut without_parentheses = String::with_capacity(body.len());
  let mut chinese = Vec::new();
  let mut cursor = 0;
  let chars = body.char_indices().collect::<Vec<_>>();
  let mut index = 0;
  while index < chars.len() {
    let (at, c) = chars[index];
    let close = match c {
      '(' => ')',
      '（' => '）',
      _ => {
        index += 1;
        continue;
      }
    };
    let Some(end_index) = chars[index + 1..].iter().position(|(_, item)| *item == close).map(|p| p + index + 1) else {
      break;
    };
    let content_start = at + c.len_utf8();
    let content_end = chars[end_index].0;
    let content = &body[content_start..content_end];
    if contains_cjk(content) {
      without_parentheses.push_str(&body[cursor..at]);
      without_parentheses.push(' ');
      chinese.push(content.trim().to_string());
      cursor = content_end + close.len_utf8();
    }
    index = end_index + 1;
  }
  without_parentheses.push_str(&body[cursor..]);

  let mut english = String::with_capacity(without_parentheses.len());
  let mut run = String::new();
  for c in without_parentheses.chars() {
    if contains_cjk(&c.to_string()) || matches!(c, '，' | '。' | '、' | '；' | '：' | '？' | '！') {
      run.push(c);
    } else {
      if contains_cjk(&run) {
        let cleaned = run.trim_matches(|c: char| matches!(c, '，' | '。' | '、' | '；' | '：' | ' ')).to_string();
        if !cleaned.is_empty() {
          chinese.push(cleaned);
        }
      } else {
        english.push_str(&run);
      }
      run.clear();
      english.push(c);
    }
  }
  if contains_cjk(&run) {
    let cleaned = run.trim_matches(|c: char| matches!(c, '，' | '。' | '、' | '；' | '：' | ' ')).to_string();
    if !cleaned.is_empty() {
      chinese.push(cleaned);
    }
  } else {
    english.push_str(&run);
  }
  (english, chinese.join("；"))
}

fn clean_english(text: &str) -> String {
  let mut cleaned = normalize_space(&text.replace("**", "").replace('`', ""));
  if cleaned.to_lowercase().ends_with("e.g.") {
    cleaned.truncate(cleaned.len() - 4);
  }
  cleaned
    .trim_matches(|c: char| matches!(c, ' ' | ';' | '；' | '/' | '→'))
    .trim()
    .to_string()
}

fn parse_line(file_name: &str, issue: Option<&str>, line: i64, original: &str) -> Option<ParsedDefinition> {
  let mut text = original.trim();
  if text.starts_with('|') || text.starts_with('#') || text.starts_with('>') || !text.contains('—') {
    return None;
  }
  if let Some(rest) = text.strip_prefix("- ") {
    text = rest.trim_start();
  }
  if let Some(dot) = text.find(". ") {
    if text[..dot].bytes().all(|b| b.is_ascii_digit()) {
      text = text[dot + 2..].trim_start();
    }
  }
  let (word, header_pos, body) = if let Some(rest) = text.strip_prefix("**") {
    let end = rest.find("**")?;
    let word = rest[..end].trim().to_string();
    let after = rest[end + 2..].trim_start();
    let dash = after.find('—')?;
    (word, after[..dash].trim().to_string(), after[dash + '—'.len_utf8()..].trim().to_string())
  } else {
    let dash = text.find('—')?;
    let (word, pos) = split_plain_header(&text[..dash]);
    (word, pos, text[dash + '—'.len_utf8()..].trim().to_string())
  };
  if !valid_word(&word) {
    return None;
  }
  let (body_without_examples, examples) = extract_examples(&body);
  let (body_without_pos, body_pos) = remove_parenthesized_pos(&body_without_examples);
  let (body_without_leading_pos, leading_pos) = remove_leading_pos(&body_without_pos);
  let (english, chinese) = split_chinese(&body_without_leading_pos);
  Some(ParsedDefinition {
    file_name: file_name.to_string(),
    line,
    word: word.clone(),
    issue: issue.map(str::to_string),
    pos: if !header_pos.is_empty() {
      header_pos
    } else if !leading_pos.is_empty() {
      leading_pos
    } else {
      body_pos
    },
    english: clean_english(&english),
    chinese,
    examples,
  })
}

fn parse_source(source: &SourceInput) -> Vec<ParsedDefinition> {
  let issue = issue_from_file(&source.file_name);
  source
    .content
    .lines()
    .enumerate()
    .filter_map(|(index, line)| parse_line(&source.file_name, issue.as_deref(), index as i64 + 1, line))
    .collect()
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
  conn
    .query_row(
      "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
      [table],
      |row| row.get(0),
    )
    .map_err(|error| format!("检查释义表失败：{error}"))
}

fn load_candidates(conn: &Connection) -> Result<Vec<ReviewCandidate>, String> {
  let mut stmt = conn
    .prepare("SELECT id, issue, word_norm FROM review_word WHERE deleted = 0 ORDER BY ord, id")
    .map_err(|error| format!("读取复习词条失败：{error}"))?;
  let rows = stmt
    .query_map([], |row| Ok(ReviewCandidate { id: row.get(0)?, issue: row.get(1)?, word_norm: row.get(2)? }))
    .map_err(|error| format!("读取复习词条失败：{error}"))?;
  rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|error| format!("读取复习词条失败：{error}"))
}

fn load_existing(conn: &Connection) -> Result<HashMap<DefinitionKey, StoredDefinition>, String> {
  let mut result = HashMap::new();
  if !table_exists(conn, "review_definition")? {
    return Ok(result);
  }
  let mut stmt = conn
    .prepare("SELECT word_id, source_file, source_line, pos, english, chinese FROM review_definition")
    .map_err(|error| format!("读取已有释义失败：{error}"))?;
  let rows = stmt
    .query_map([], |row| {
      Ok((
        (row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?),
        StoredDefinition { pos: row.get(3)?, english: row.get(4)?, chinese: row.get(5)?, examples: Vec::new() },
      ))
    })
    .map_err(|error| format!("读取已有释义失败：{error}"))?;
  for row in rows {
    let (key, value) = row.map_err(|error| format!("读取已有释义失败：{error}"))?;
    result.insert(key, value);
  }
  let mut stmt = conn
    .prepare("SELECT word_id, source_file, definition_line, sentence, ai FROM review_definition_example ORDER BY word_id, source_file, definition_line, seq")
    .map_err(|error| format!("读取已有释义例句失败：{error}"))?;
  let rows = stmt
    .query_map([], |row| {
      Ok((
        (row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?),
        ExampleInput { sentence: row.get(3)?, ai: row.get::<_, i64>(4)? != 0 },
      ))
    })
    .map_err(|error| format!("读取已有释义例句失败：{error}"))?;
  for row in rows {
    let (key, example) = row.map_err(|error| format!("读取已有释义例句失败：{error}"))?;
    if let Some(definition) = result.get_mut(&key) {
      definition.examples.push(example);
    }
  }
  Ok(result)
}

fn unmatched(parsed: &ParsedDefinition, reason: &str) -> DefinitionUnmatched {
  DefinitionUnmatched {
    file_name: parsed.file_name.clone(),
    line: parsed.line,
    word: parsed.word.clone(),
    reason: reason.to_string(),
  }
}

fn match_candidate<'a>(candidates: &'a [ReviewCandidate], parsed: &ParsedDefinition) -> Result<Option<&'a str>, String> {
  let norm = normalize_word(&parsed.word);
  let global = candidates.iter().filter(|item| item.word_norm == norm).collect::<Vec<_>>();
  if global.is_empty() {
    return Ok(None);
  }
  if let Some(issue) = &parsed.issue {
    let same_issue = global.iter().filter(|item| &item.issue == issue).collect::<Vec<_>>();
    if same_issue.len() == 1 {
      return Ok(Some(same_issue[0].id.as_str()));
    }
    if same_issue.len() > 1 {
      return Err("同期同词仍有多个词条 ID，未猜测".into());
    }
  }
  if global.len() == 1 {
    Ok(Some(global[0].id.as_str()))
  } else {
    Err("同词有多个词条 ID，且没有唯一同期项".into())
  }
}

fn stored_value(parsed: &ParsedDefinition) -> StoredDefinition {
  StoredDefinition {
    pos: parsed.pos.clone(),
    english: parsed.english.clone(),
    chinese: parsed.chinese.clone(),
    examples: parsed.examples.clone(),
  }
}

fn stage(
  word_id: &str,
  parsed: ParsedDefinition,
  existing: &HashMap<DefinitionKey, StoredDefinition>,
  planned: &HashMap<DefinitionKey, usize>,
  plan: &mut ImportPlan,
) -> Option<usize> {
  let key = (word_id.to_string(), parsed.file_name.clone(), parsed.line);
  let value = stored_value(&parsed);
  if existing.get(&key) == Some(&value)
    || planned.get(&key).and_then(|index| plan.definitions.get(*index)).map(|item| stored_value(&item.parsed)) == Some(value)
  {
    plan.report.skipped += 1;
    return None;
  }
  plan.report.examples_added += parsed.examples.len() as i64;
  plan.definitions.push(PlannedDefinition { word_id: word_id.to_string(), parsed });
  Some(plan.definitions.len() - 1)
}

fn build_plan(conn: &Connection, request: &DefinitionImportRequest) -> Result<ImportPlan, String> {
  let candidates = load_candidates(conn)?;
  let existing = load_existing(conn)?;
  let mut existing_words = existing.keys().map(|(id, _, _)| id.clone()).collect::<HashSet<_>>();
  let mut plan = ImportPlan::default();
  let mut planned = HashMap::new();

  for source in &request.issues {
    for parsed in parse_source(source) {
      match match_candidate(&candidates, &parsed) {
        Ok(Some(word_id)) => {
          let word_id = word_id.to_string();
          plan.report.matched += 1;
          let key = (word_id.clone(), parsed.file_name.clone(), parsed.line);
          if let Some(index) = stage(&word_id, parsed, &existing, &planned, &mut plan) {
            planned.entry(key).or_insert(index);
          }
          existing_words.insert(word_id);
        }
        Ok(None) => plan.report.unmatched_items.push(unmatched(&parsed, "复习库中没有这个词目")),
        Err(reason) => plan.report.unmatched_items.push(unmatched(&parsed, &reason)),
      }
    }
  }

  // EAGP 资格按词目固定：同词在 EAGP 中的多条释义可一起导入，但已有期文件释义的词整组跳过。
  let mut eagp_eligibility: HashMap<String, Result<Option<String>, String>> = HashMap::new();
  if let Some(source) = &request.eagp {
    for parsed in parse_source(source) {
      let norm = normalize_word(&parsed.word);
      let eligibility = eagp_eligibility.entry(norm).or_insert_with(|| {
        let same_word = candidates.iter().filter(|item| item.word_norm == normalize_word(&parsed.word)).collect::<Vec<_>>();
        // 同一个词目已经有释义时，EAGP 整组只是兜底跳过；即使词条 ID 有歧义，也不误报未匹配。
        if same_word.iter().any(|item| existing_words.contains(&item.id)) {
          return Ok(None);
        }
        match match_candidate(&candidates, &parsed) {
          Ok(Some(id)) => Ok(Some(id.to_string())),
          Ok(None) => Err("复习库中没有这个词目".into()),
          Err(reason) => Err(reason),
        }
      });
      match eligibility {
        Ok(Some(word_id)) => {
          plan.report.matched += 1;
          let key = (word_id.clone(), parsed.file_name.clone(), parsed.line);
          if let Some(index) = stage(word_id, parsed, &existing, &planned, &mut plan) {
            planned.entry(key).or_insert(index);
          }
        }
        Ok(None) => {
          plan.report.matched += 1;
          plan.report.skipped += 1;
        }
        Err(reason) => plan.report.unmatched_items.push(unmatched(&parsed, reason)),
      }
    }
  }
  plan.report.unmatched = plan.report.unmatched_items.len() as i64;
  plan.report.added = plan.definitions.len() as i64;
  Ok(plan)
}

pub fn preview_at(path: &Path, request: DefinitionImportRequest) -> Result<DefinitionImportReport, String> {
  if !path.exists() {
    let conn = Connection::open_in_memory().map_err(|error| format!("创建空库预览失败：{error}"))?;
    schema::migrate(&conn).map_err(|error| format!("创建空库预览失败：{error}"))?;
    return Ok(build_plan(&conn, &request)?.report);
  }
  let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
    .map_err(|error| format!("只读打开词库数据库失败：{error}"))?;
  let version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0)).map_err(|error| format!("读取数据库版本失败：{error}"))?;
  if version > schema::SCHEMA_VERSION {
    return Err(format!("词库数据库版本 {version} 高于本应用支持的 {}", schema::SCHEMA_VERSION));
  }
  if version == 0 {
    let empty = Connection::open_in_memory().map_err(|error| format!("创建空库预览失败：{error}"))?;
    schema::migrate(&empty).map_err(|error| format!("创建空库预览失败：{error}"))?;
    return Ok(build_plan(&empty, &request)?.report);
  }
  Ok(build_plan(&conn, &request)?.report)
}

pub fn import_at(path: &Path, request: DefinitionImportRequest) -> Result<DefinitionImportReport, String> {
  let mut conn = schema::open(path).map_err(|error| format!("打开或升级词库数据库失败：{error}"))?;
  let plan = build_plan(&conn, &request)?;
  let tx = conn.transaction().map_err(|error| format!("启动释义导入事务失败：{error}"))?;
  for item in &plan.definitions {
    let parsed = &item.parsed;
    tx.execute(
      "INSERT INTO review_definition (word_id, source_file, source_line, pos, english, chinese)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(word_id, source_file, source_line) DO UPDATE SET
         pos = excluded.pos, english = excluded.english, chinese = excluded.chinese",
      params![item.word_id, parsed.file_name, parsed.line, parsed.pos, parsed.english, parsed.chinese],
    ).map_err(|error| format!("写入释义失败：{error}"))?;
    tx.execute(
      "DELETE FROM review_definition_example WHERE word_id = ?1 AND source_file = ?2 AND definition_line = ?3",
      params![item.word_id, parsed.file_name, parsed.line],
    ).map_err(|error| format!("更新释义例句失败：{error}"))?;
    for (index, example) in parsed.examples.iter().enumerate() {
      tx.execute(
        "INSERT INTO review_definition_example (word_id, source_file, definition_line, seq, sentence, ai)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![item.word_id, parsed.file_name, parsed.line, index as i64 + 1, example.sentence, example.ai],
      ).map_err(|error| format!("写入释义例句失败：{error}"))?;
    }
  }
  tx.commit().map_err(|error| format!("提交释义导入失败：{error}"))?;
  Ok(plan.report)
}

/// 给真实原料回归使用：目录只读，文件内容读入内存后仍走同一套导入代码。
pub fn request_from_files(issue_paths: &[String], eagp_path: Option<&str>) -> Result<DefinitionImportRequest, String> {
  fn read(path: &str) -> Result<SourceInput, String> {
    let content = fs::read_to_string(path).map_err(|error| format!("读取释义文件失败：{path}：{error}"))?;
    let file_name = Path::new(path).file_name().and_then(|name| name.to_str()).unwrap_or(path).to_string();
    Ok(SourceInput { file_name, content })
  }
  Ok(DefinitionImportRequest {
    issues: issue_paths.iter().map(|path| read(path)).collect::<Result<Vec<_>, _>>()?,
    eagp: eagp_path.map(read).transpose()?,
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use rusqlite::params;
  use uuid::Uuid;

  fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    schema::migrate(&conn).unwrap();
    conn
  }

  fn word(conn: &Connection, id: &str, word: &str, issue: &str) {
    conn.execute(
      "INSERT INTO review_word (
        id, ord, line, raw, word, word_norm, issue, added_at, status, level, due, note,
        imported_at, updated_at, deleted, source, verification_status
      ) VALUES (?1, 1, 1, '| original |', ?2, ?3, ?4, '2026-11-01', 'L2', 2,
        '2026-11-03', 'original note', 't1', 't1', 0, 'original source', '未查证')",
      params![id, word, normalize_word(word), issue],
    ).unwrap();
  }

  fn source(file_name: &str, content: &str) -> SourceInput {
    SourceInput { file_name: file_name.into(), content: content.into() }
  }

  #[test]
  fn parses_two_examples_of_each_supported_line_format() {
    let input = source("20261020.md", concat!(
      "1. **adjust** v. — to change slightly（调整）\n",
      "2. **adapt** v. — to change behaviour（改变自身）\n",
      "**benefit** n. — an advantage（益处）\n",
      "- **merit** n. — a good quality（优点）\n",
      "abbreviate — to make a word shorter. (v)\n",
      "mandate v. — to order somebody to do something（强制执行）\n",
    ));
    let parsed = parse_source(&input);
    assert_eq!(parsed.len(), 6);
    assert_eq!(parsed.iter().map(|item| item.word.as_str()).collect::<Vec<_>>(), ["adjust", "adapt", "benefit", "merit", "abbreviate", "mandate"]);
    assert_eq!(parsed[0].issue.as_deref(), Some("10.20"));
    assert_eq!(parsed[0].pos, "v.");
    assert_eq!(parsed[2].pos, "n.");
    assert_eq!(parsed[4].pos, "v");
    assert_eq!(parsed[5].pos, "v.");
  }

  #[test]
  fn separates_chinese_and_extracts_italic_and_quoted_ai_examples() {
    let input = source("20261020.md", concat!(
      "1. **adjust** v. — to change slightly to fit new conditions（调整、适应；adjust to）；",
      "e.g. *She adjusted quickly to the new class.* (AI)\n",
      "**benefit** n. — an advantage or profit（益处）；“Regular reading benefits every student.”\n",
      "delve — to search for information（探究） / \"We delve into one text every week.\" (AI)\n",
    ));
    let parsed = parse_source(&input);
    assert_eq!(parsed.len(), 3);
    assert_eq!(parsed[0].english, "to change slightly to fit new conditions");
    assert_eq!(parsed[0].chinese, "调整、适应；adjust to");
    assert_eq!(parsed[0].examples, vec![ExampleInput { sentence: "She adjusted quickly to the new class.".into(), ai: true }]);
    assert_eq!(parsed[1].examples[0].sentence, "Regular reading benefits every student.");
    assert_eq!(parsed[1].examples[0].ai, false);
    assert_eq!(parsed[2].examples[0].ai, true);
    assert!(!parsed[2].english.contains("We delve"));
  }

  #[test]
  fn extracts_bare_pos_at_the_start_of_the_body() {
    let input = source(
      "20260825.md",
      "hook — v./n. 勾\nrapid — adj. happening quickly（快速的）\ncontext — surrounding circumstances (n)",
    );
    let parsed = parse_source(&input);
    assert_eq!(parsed[0].pos, "v./n.");
    assert_eq!(parsed[0].english, "");
    assert_eq!(parsed[0].chinese, "勾");
    assert_eq!(parsed[1].pos, "adj.");
    assert_eq!(parsed[1].english, "happening quickly");
    assert_eq!(parsed[2].pos, "n");
    assert_eq!(parsed[2].english, "surrounding circumstances");
  }

  #[test]
  fn single_digit_issue_date_matches_the_same_issue() {
    assert_eq!(issue_from_file("20260901.md").as_deref(), Some("9.1"));
    let conn = db();
    word(&conn, "rv:current", "focus", "9.1");
    word(&conn, "rv:older", "focus", "8.25");
    let request = DefinitionImportRequest {
      issues: vec![source("20260901.md", "focus — v./n. 集中；焦点")],
      eagp: None,
    };
    let plan = build_plan(&conn, &request).unwrap();
    assert_eq!(plan.report.matched, 1);
    assert_eq!(plan.report.unmatched, 0);
    assert_eq!(plan.definitions[0].word_id, "rv:current");
  }

  #[test]
  fn same_issue_wins_and_ambiguous_or_unknown_words_are_reported() {
    let conn = db();
    word(&conn, "rv:current", "Same", "10.20");
    word(&conn, "rv:older", "same", "9.18");
    word(&conn, "rv:ambiguous-1", "twin", "8.25");
    word(&conn, "rv:ambiguous-2", "twin", "9.18");
    let request = DefinitionImportRequest {
      issues: vec![source("20261020.md", "1. **same** n. — current meaning（当前义）\n2. **twin** n. — ambiguous（歧义）\n3. **unknown** n. — missing（未知）")],
      eagp: None,
    };
    let report = preview_at(Path::new(":memory:"), request.clone()).unwrap();
    // :memory: 是另一个空数据库；真正预览用下面的 build_plan。
    assert_eq!(report.matched, 0);
    let plan = build_plan(&conn, &request).unwrap();
    assert_eq!(plan.report.matched, 1);
    assert_eq!(plan.report.unmatched, 2);
    assert_eq!(plan.definitions[0].word_id, "rv:current");
    assert!(plan.report.unmatched_items[0].reason.contains("多个"));
    assert_eq!(plan.report.unmatched_items[1].word, "unknown");
  }

  #[test]
  fn repeated_import_is_idempotent_and_does_not_touch_review_fields() {
    let path = std::env::temp_dir().join(format!("vocab-definition-{}.db", Uuid::new_v4()));
    let conn = schema::open(&path).unwrap();
    word(&conn, "rv:one", "adjust", "10.20");
    let before: Vec<(String, String, String, String, String)> = conn
      .prepare("SELECT id, raw, status, due, note FROM review_word")
      .unwrap()
      .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))
      .unwrap()
      .collect::<rusqlite::Result<Vec<_>>>()
      .unwrap();
    drop(conn);
    let request = DefinitionImportRequest {
      issues: vec![source("20261020.md", "1. **adjust** v. — to change（调整） *She adjusts well.* (AI)")],
      eagp: None,
    };
    let first = import_at(&path, request.clone()).unwrap();
    assert_eq!((first.matched, first.added, first.skipped, first.examples_added), (1, 1, 0, 1));
    let second = import_at(&path, request).unwrap();
    assert_eq!((second.matched, second.added, second.skipped, second.examples_added), (1, 0, 1, 0));
    let conn = schema::open(&path).unwrap();
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM review_definition", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM review_definition_example", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    let after: Vec<(String, String, String, String, String)> = conn
      .prepare("SELECT id, raw, status, due, note FROM review_word")
      .unwrap()
      .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))
      .unwrap()
      .collect::<rusqlite::Result<Vec<_>>>()
      .unwrap();
    assert_eq!(after, before);
    drop(conn);
    fs::remove_file(path).unwrap();
  }

  #[test]
  fn eagp_only_fills_words_without_definitions() {
    let conn = db();
    word(&conn, "rv:fresh", "context", "EAGP");
    word(&conn, "rv:has-definition", "evidence", "EAGP");
    word(&conn, "rv:extend-with-definition", "extend", "10.20");
    word(&conn, "rv:extend-without-definition", "extend", "EAGP");
    conn.execute(
      "INSERT INTO review_definition (word_id, source_file, source_line, pos, english, chinese)
       VALUES ('rv:has-definition', '20261020.md', 1, 'n.', 'proof', '证据')",
      [],
    ).unwrap();
    conn.execute(
      "INSERT INTO review_definition (word_id, source_file, source_line, pos, english, chinese)
       VALUES ('rv:extend-with-definition', '20261020.md', 2, 'v.', 'to make longer', '延伸')",
      [],
    ).unwrap();
    let request = DefinitionImportRequest {
      issues: vec![],
      eagp: Some(source("EAGP-词表-文本.md", "context — surrounding circumstances (n)\ncontext — words around a word (n)\nevidence — proof (n)\nextend — to make longer (v)")),
    };
    let plan = build_plan(&conn, &request).unwrap();
    assert_eq!(plan.report.matched, 4);
    assert_eq!(plan.report.added, 2);
    assert_eq!(plan.report.skipped, 2);
    assert_eq!(plan.report.unmatched, 0);
    assert!(plan.definitions.iter().all(|item| item.word_id == "rv:fresh"));
  }

  #[test]
  fn preview_does_not_create_or_migrate_database() {
    let path = std::env::temp_dir().join(format!("vocab-definition-preview-{}.db", Uuid::new_v4()));
    let request = DefinitionImportRequest { issues: vec![source("20261020.md", "1. **adjust** v. — to change（调整）")], eagp: None };
    let report = preview_at(&path, request).unwrap();
    assert_eq!(report.unmatched, 1);
    assert!(!path.exists());
  }
}
