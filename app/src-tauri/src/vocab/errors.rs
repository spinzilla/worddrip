use std::collections::HashSet;
use std::fs;
use std::path::Path;

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, Transaction};
use sha2::{Digest, Sha256};

use super::models::{ErrorImportReport, ErrorImportRequest};
use super::schema;

fn sha256(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn required(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{field} 不能为空"))
    } else {
        Ok(())
    }
}

fn unique_ids<'a>(ids: impl Iterator<Item = &'a str>, table: &str) -> Result<(), String> {
    let mut seen = HashSet::new();
    for id in ids {
        required(id, &format!("{table} ID"))?;
        if !seen.insert(id) {
            return Err(format!("{table} 本批 ID 重复：{id}"));
        }
    }
    Ok(())
}

fn record(id: &str, ord: i64, line: i64, raw: &str, label: &str) -> Result<(), String> {
    if ord < 1 || line < 1 {
        return Err(format!("{label} {id} 的顺序或行号无效"));
    }
    required(raw, &format!("{label} {id} 的 raw"))
}

fn validate(request: &ErrorImportRequest) -> Result<(), String> {
    required(&request.source.file_name, "错误档案文件名")?;
    required(&request.source.content, "错误档案内容")?;
    unique_ids(request.top.iter().map(|row| row.id.as_str()), "高频错误")?;
    unique_ids(
        request.batches.iter().map(|row| row.id.as_str()),
        "错误批次",
    )?;
    unique_ids(request.items.iter().map(|row| row.id.as_str()), "错误项")?;
    unique_ids(request.todos.iter().map(|row| row.id.as_str()), "待巩固")?;
    unique_ids(request.essays.iter().map(|row| row.id.as_str()), "作文索引")?;

    for row in &request.top {
        record(&row.id, row.ord, row.line, &row.raw, "高频错误")?;
    }
    for row in &request.batches {
        record(&row.id, row.ord, row.line, &row.raw, "错误批次")?;
        required(&row.title, &format!("错误批次 {} 的标题", row.id))?;
        if !row.metadata.is_object() {
            return Err(format!("错误批次 {} 的元数据不是 JSON 对象", row.id));
        }
    }
    let batch_ids: HashSet<&str> = request.batches.iter().map(|row| row.id.as_str()).collect();
    for row in &request.items {
        record(&row.id, row.ord, row.line, &row.raw, "错误项")?;
        if !batch_ids.contains(row.batch_id.as_str()) {
            return Err(format!("错误项 {} 引用了不存在的批次", row.id));
        }
    }
    for row in &request.todos {
        record(&row.id, row.ord, row.line, &row.raw, "待巩固")?;
        required(&row.text, &format!("待巩固 {} 的内容", row.id))?;
    }
    for row in &request.essays {
        record(&row.id, row.ord, row.line, &row.raw, "作文索引")?;
    }
    for warning in &request.warnings {
        if warning.line < 0 {
            return Err("警告行号不能是负数".into());
        }
        required(&warning.kind, "警告类型")?;
        required(&warning.message, "警告内容")?;
    }
    Ok(())
}

fn ensure_replace_allowed(conn: &Connection) -> Result<(), String> {
    let archived: i64 = conn
        .query_row("SELECT COUNT(*) FROM coach_essay", [], |row| row.get(0))
        .map_err(|error| format!("检查作文归档失败：{error}"))?;
    if archived > 0 {
        return Err(format!(
            "软件里已有 {archived} 篇归档作文，重新导入会覆盖，已停止；如需重新导入请先导出备份。"
        ));
    }
    Ok(())
}

fn insert_rows(tx: &Transaction<'_>, request: &ErrorImportRequest) -> Result<(), String> {
    // 子表先删，随后整体替换五区；词库四表完全不动。
    tx.execute_batch(
        "DELETE FROM error_item;
     DELETE FROM error_top;
     DELETE FROM error_batch;
     DELETE FROM error_todo;
     DELETE FROM error_essay;",
    )
    .map_err(|error| format!("清空旧错误档案失败：{error}"))?;

    for row in &request.top {
        tx.execute(
            "INSERT INTO error_top (
        id, ord, line, raw, rank, kind, count, last_at, status, source_file
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                row.id,
                row.ord,
                row.line,
                row.raw,
                row.rank,
                row.kind,
                row.count,
                row.last_at,
                row.status,
                request.source.file_name
            ],
        )
        .map_err(|error| format!("写入高频错误 {} 失败：{error}", row.id))?;
    }
    for row in &request.batches {
        tx.execute(
            "INSERT INTO error_batch (
        id, ord, line, raw, title, date, metadata_json, source_file
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                row.id,
                row.ord,
                row.line,
                row.raw,
                row.title,
                row.date,
                serde_json::to_string(&row.metadata).map_err(|error| error.to_string())?,
                request.source.file_name
            ],
        )
        .map_err(|error| format!("写入错误批次 {} 失败：{error}", row.id))?;
    }
    for row in &request.items {
        tx.execute(
            "INSERT INTO error_item (
        id, batch_id, ord, line, raw, question, kind, written, correction, note, source_file
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                row.id,
                row.batch_id,
                row.ord,
                row.line,
                row.raw,
                row.question,
                row.kind,
                row.written,
                row.correction,
                row.note,
                request.source.file_name
            ],
        )
        .map_err(|error| format!("写入错误项 {} 失败：{error}", row.id))?;
    }
    for row in &request.todos {
        tx.execute(
            "INSERT INTO error_todo (id, ord, line, raw, done, text, source_file)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                row.id,
                row.ord,
                row.line,
                row.raw,
                row.done,
                row.text,
                request.source.file_name
            ],
        )
        .map_err(|error| format!("写入待巩固 {} 失败：{error}", row.id))?;
    }
    for row in &request.essays {
        tx.execute(
            "INSERT INTO error_essay (
        id, ord, line, raw, date, standard, topic, word_count, original_file, result, source_file
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                row.id,
                row.ord,
                row.line,
                row.raw,
                row.date,
                row.standard,
                row.topic,
                row.word_count,
                row.original_file,
                row.result,
                request.source.file_name
            ],
        )
        .map_err(|error| format!("写入作文索引 {} 失败：{error}", row.id))?;
    }
    Ok(())
}

/// 文件选择后的只读检查；已有软件归档时不展示整体替换确认。
pub fn preview_at(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("只读打开词库数据库失败：{error}"))?;
    let has_coach_essay: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'coach_essay')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("检查作文归档表失败：{error}"))?;
    if has_coach_essay {
        ensure_replace_allowed(&conn)?;
    }
    Ok(())
}

/// 错误档案五区在同一事务中整体替换；任一条失败都会恢复旧档案和旧导入日志。
pub fn import_at(path: &Path, request: ErrorImportRequest) -> Result<ErrorImportReport, String> {
    validate(&request)?;
    let source_sha256 = sha256(&request.source.content);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建词库目录失败：{error}"))?;
    }
    let mut conn = schema::open(path).map_err(|error| format!("打开词库数据库失败：{error}"))?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let tx = conn
        .transaction()
        .map_err(|error| format!("开启错误档案导入事务失败：{error}"))?;
    // 预览后仍可能新增归档，确认写入前必须在同一事务里再拦截一次。
    ensure_replace_allowed(&tx)?;
    insert_rows(&tx, &request)?;
    let counts = serde_json::json!({
      "top": request.top.len(),
      "batches": request.batches.len(),
      "items": request.items.len(),
      "todos": request.todos.len(),
      "essays": request.essays.len(),
    });
    tx.execute(
    "INSERT INTO import_run (source_file, source_sha256, started_at, counts_json, warnings_json)
     VALUES (?1, ?2, ?3, ?4, ?5)",
    params![
      request.source.file_name,
      source_sha256,
      now,
      serde_json::to_string(&counts).map_err(|error| error.to_string())?,
      serde_json::to_string(&request.warnings).map_err(|error| error.to_string())?
    ],
  )
  .map_err(|error| format!("写入错误档案导入日志失败：{error}"))?;
    let totals = super::import::stats_from_conn(&tx)?;
    tx.commit()
        .map_err(|error| format!("提交错误档案导入事务失败：{error}"))?;
    Ok(ErrorImportReport {
        top: request.top.len() as i64,
        batches: request.batches.len() as i64,
        items: request.items.len() as i64,
        todos: request.todos.len() as i64,
        essays: request.essays.len() as i64,
        source_sha256,
        totals,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vocab::models::{
        ErrorBatchInput, ErrorEssayInput, ErrorItemInput, ErrorTodoInput, ErrorTopInput,
        SourceInput,
    };
    use rusqlite::types::Value;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn path() -> PathBuf {
        std::env::temp_dir().join(format!("english-studio-errors-{}.db", Uuid::new_v4()))
    }

    fn request() -> ErrorImportRequest {
        ErrorImportRequest {
            source: SourceInput {
                file_name: "错误档案.md".into(),
                content: "# 错误档案\n".into(),
            },
            top: vec![ErrorTopInput {
                id: "et:1".into(),
                ord: 1,
                line: 3,
                raw: "| old |".into(),
                rank: 1,
                kind: "主谓一致".into(),
                count: "3".into(),
                last_at: "2026-01-01".into(),
                status: "复发".into(),
            }],
            batches: vec![ErrorBatchInput {
                id: "eb:2026-01-01".into(),
                ord: 1,
                line: 5,
                raw: "### 2026-01-01\n| old |".into(),
                title: "2026-01-01 · 测试".into(),
                date: "2026-01-01".into(),
                metadata: serde_json::json!({"词数": "100"}),
            }],
            items: vec![ErrorItemInput {
                id: "ei:one".into(),
                batch_id: "eb:2026-01-01".into(),
                ord: 1,
                line: 7,
                raw: "| old |".into(),
                question: "".into(),
                kind: "主谓一致".into(),
                written: "notes is".into(),
                correction: "notes are".into(),
                note: "复数".into(),
            }],
            todos: vec![ErrorTodoInput {
                id: "todo:1".into(),
                ord: 1,
                line: 9,
                raw: "- [ ] 冷读".into(),
                done: false,
                text: "冷读".into(),
            }],
            essays: vec![ErrorEssayInput {
                id: "ee:2026-01-01".into(),
                ord: 1,
                line: 11,
                raw: "| 2026-01-01 | 测试 |".into(),
                date: "2026-01-01".into(),
                standard: "雅思".into(),
                topic: "测试".into(),
                word_count: "100".into(),
                original_file: "原文.pdf".into(),
                result: "作文.md".into(),
            }],
            warnings: vec![],
        }
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
    }

    #[test]
    fn repeat_import_replaces_all_five_sections_without_duplicates() {
        let path = path();
        let first = import_at(&path, request()).unwrap();
        assert_eq!(
            (
                first.top,
                first.batches,
                first.items,
                first.todos,
                first.essays
            ),
            (1, 1, 1, 1, 1)
        );
        let second = import_at(&path, request()).unwrap();
        assert_eq!(second.totals.import_runs, 2);
        preview_at(&path).unwrap();

        let conn = schema::open(&path).unwrap();
        for table in [
            "error_top",
            "error_batch",
            "error_item",
            "error_todo",
            "error_essay",
        ] {
            assert_eq!(count(&conn, table), 1, "{table} 重复导入后仍只能有一条");
        }
        let metadata: String = conn
            .query_row("SELECT metadata_json FROM error_batch", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(metadata, "{\"词数\":\"100\"}");
        assert_eq!(count(&conn, "import_run"), 2);
        drop(conn);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn mid_transaction_failure_restores_old_archive_and_run_log() {
        let path = path();
        import_at(&path, request()).unwrap();
        let conn = schema::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER fail_error_item BEFORE INSERT ON error_item
         WHEN NEW.id = 'ei:explode'
         BEGIN SELECT RAISE(ABORT, 'intentional test failure'); END;",
        )
        .unwrap();
        drop(conn);

        let mut replacement = request();
        replacement.top[0].raw = "| replacement |".into();
        replacement.items[0].id = "ei:explode".into();
        assert!(import_at(&path, replacement).is_err());

        let conn = schema::open(&path).unwrap();
        let raw: String = conn
            .query_row("SELECT raw FROM error_top WHERE id = 'et:1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(raw, "| old |");
        for table in [
            "error_top",
            "error_batch",
            "error_item",
            "error_todo",
            "error_essay",
        ] {
            assert_eq!(count(&conn, table), 1, "失败后 {table} 的旧数据必须保留");
        }
        assert_eq!(count(&conn, "import_run"), 1, "失败导入不能留下日志");
        drop(conn);
        fs::remove_file(path).unwrap();
    }

    fn table_rows(conn: &Connection, table: &str, order_by: &str) -> Vec<Vec<Value>> {
        let mut stmt = conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY {order_by}"))
            .unwrap();
        let columns = stmt.column_count();
        let mut rows = stmt.query([]).unwrap();
        let mut result = Vec::new();
        while let Some(row) = rows.next().unwrap() {
            result.push(
                (0..columns)
                    .map(|index| row.get::<_, Value>(index).unwrap())
                    .collect(),
            );
        }
        result
    }

    #[test]
    fn archived_coach_data_blocks_preview_and_import_without_any_changes() {
        let path = path();
        let archive = crate::vocab::archive::CoachArchiveRequest {
            review_id: "review-protect-import".into(),
            essay: "The archived essay must survive.".into(),
            result_json: serde_json::json!({"score": 6.5}).to_string(),
            title: "2026-11-10 · 归档保护".into(),
            date: "2026-11-10".into(),
            paper_type: "通用学术写作".into(),
            word_count: 5,
            items: vec![crate::vocab::archive::CoachArchiveItemInput {
                kind: "主谓一致".into(),
                written: "notes is".into(),
                correction: "notes are".into(),
                note: "复数".into(),
            }],
        };
        crate::vocab::archive::archive_at(&path, archive).unwrap();

        let conn = schema::open(&path).unwrap();
        let tables = [
            ("coach_essay", "id"),
            ("coach_top_progress", "top_id"),
            ("error_batch", "id"),
            ("error_item", "id"),
            ("error_top", "id"),
            ("error_todo", "id"),
            ("error_essay", "id"),
            ("import_run", "id"),
        ];
        let before: Vec<_> = tables
            .iter()
            .map(|(table, order_by)| table_rows(&conn, table, order_by))
            .collect();
        drop(conn);

        let preview_error = preview_at(&path).unwrap_err();
        assert!(preview_error.contains("已有 1 篇归档作文"), "{preview_error}");
        assert!(preview_error.contains("已停止"), "{preview_error}");
        let import_error = import_at(&path, request()).unwrap_err();
        assert_eq!(import_error, preview_error);

        let conn = schema::open(&path).unwrap();
        let after: Vec<_> = tables
            .iter()
            .map(|(table, order_by)| table_rows(&conn, table, order_by))
            .collect();
        assert_eq!(after, before, "预览和确认都不能改动归档、五区或导入日志");
        let top_count: String = conn
            .query_row("SELECT count FROM error_top WHERE kind = '主谓一致'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(top_count, "1");
        drop(conn);
        fs::remove_file(path).unwrap();
    }
}
