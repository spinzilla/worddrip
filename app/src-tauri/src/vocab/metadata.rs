use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

use super::schema;

pub const VERIFICATION_STATUSES: [&str; 3] = ["未查证", "词典或ACL已查", "老师确认"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewMetadataRequest {
    pub id: String,
    pub source: String,
    pub verification_status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewMetadataResult {
    pub id: String,
    pub source: String,
    pub verification_status: String,
    pub updated_at: String,
}

pub fn update_at(
    db_path: &Path,
    request: ReviewMetadataRequest,
) -> Result<ReviewMetadataResult, String> {
    if !VERIFICATION_STATUSES.contains(&request.verification_status.as_str()) {
        return Err(format!(
            "非法查证状态：{}；只能是 {}",
            request.verification_status,
            VERIFICATION_STATUSES.join("、")
        ));
    }
    let conn = schema::open(db_path).map_err(|error| format!("打开词库数据库失败：{error}"))?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    update_with_time(&conn, request, &now)
}

fn update_with_time(
    conn: &Connection,
    request: ReviewMetadataRequest,
    now: &str,
) -> Result<ReviewMetadataResult, String> {
    if !VERIFICATION_STATUSES.contains(&request.verification_status.as_str()) {
        return Err(format!("非法查证状态：{}", request.verification_status));
    }
    let changed = conn
        .execute(
            "UPDATE review_word
     SET source = ?2, verification_status = ?3, updated_at = ?4
     WHERE id = ?1 AND deleted = 0",
            params![request.id, request.source, request.verification_status, now],
        )
        .map_err(|error| format!("保存词条来源与查证状态失败：{error}"))?;
    if changed == 0 {
        return Err("词条不存在或已删除，未保存来源与查证状态".into());
    }
    Ok(ReviewMetadataResult {
        id: request.id,
        source: request.source,
        verification_status: request.verification_status,
        updated_at: now.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::migrate(&conn).unwrap();
        for (id, deleted) in [("rv:one", 0), ("rv:deleted", 1)] {
            conn.execute(
        "INSERT INTO review_word (
          id, ord, line, raw, word, word_norm, issue, added_at, status,
          level, due, note, imported_at, updated_at, deleted
        ) VALUES (?1, 1, 1, '| word |', 'word', 'word', '1', '2026-11-01', 'L1', 1, '', '', 'old', 'old', ?2)",
        params![id, deleted],
      ).unwrap();
        }
        conn
    }

    fn request(id: &str, status: &str) -> ReviewMetadataRequest {
        ReviewMetadataRequest {
            id: id.into(),
            source: "课堂，例句 \"A\"\n第二行".into(),
            verification_status: status.into(),
        }
    }

    #[test]
    fn updates_both_fields_and_timestamp() {
        let conn = db();
        let result =
            update_with_time(&conn, request("rv:one", "老师确认"), "2026-11-09T12:00:00Z").unwrap();
        assert_eq!(result.source, "课堂，例句 \"A\"\n第二行");
        assert_eq!(result.verification_status, "老师确认");
        assert_eq!(result.updated_at, "2026-11-09T12:00:00Z");
        let saved: (String, String, String) = conn.query_row(
      "SELECT source, verification_status, updated_at FROM review_word WHERE id = 'rv:one'",
      [],
      |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap();
        assert_eq!(
            saved,
            (result.source, result.verification_status, result.updated_at)
        );
    }

    #[test]
    fn rejects_illegal_status_without_changing_word() {
        let conn = db();
        let error = update_with_time(&conn, request("rv:one", "随便查查"), "new").unwrap_err();
        assert!(error.contains("非法查证状态"));
        let saved: (String, String) = conn
            .query_row(
                "SELECT verification_status, updated_at FROM review_word WHERE id = 'rv:one'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(saved, ("未查证".into(), "old".into()));
        assert!(conn
            .execute(
                "UPDATE review_word SET verification_status = '随便查查' WHERE id = 'rv:one'",
                []
            )
            .is_err());
    }

    #[test]
    fn rejects_missing_and_deleted_words() {
        let conn = db();
        for id in ["rv:missing", "rv:deleted"] {
            assert!(update_with_time(&conn, request(id, "未查证"), "new")
                .unwrap_err()
                .contains("不存在或已删除"));
        }
    }
}
