use chrono::{Duration, Local, NaiveDate, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::Path;

use super::schema;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReviewKind {
    Recall,
    Rewrite,
    Sentence,
    Choice,
}

impl ReviewKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Recall => "recall",
            Self::Rewrite => "rewrite",
            Self::Sentence => "sentence",
            Self::Choice => "choice",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSubmitRequest {
    pub id: String,
    pub kind: ReviewKind,
    pub correct: bool,
    /// 首考前看过释义；旧调用和到期复习不传时仍是 false。
    #[serde(default)]
    pub previewed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSubmitResult {
    pub id: String,
    pub kind: ReviewKind,
    pub correct: bool,
    pub review_date: String,
    pub changed: bool,
    pub status: String,
    pub level: Option<i64>,
    pub due: String,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NextState {
    status: String,
    level: Option<i64>,
    due: String,
    note: String,
    changed: bool,
}

fn unchanged(status: &str, level: Option<i64>, due: &str, note: &str) -> NextState {
    NextState {
        status: status.into(),
        level,
        due: due.into(),
        note: note.into(),
        changed: false,
    }
}

fn plus_days(today: &str, days: i64) -> Result<String, String> {
    let date = NaiveDate::parse_from_str(today, "%Y-%m-%d")
        .map_err(|_| format!("复习日不是合法日期：{today}"))?;
    date.checked_add_signed(Duration::days(days))
        .map(|next| next.format("%Y-%m-%d").to_string())
        .ok_or_else(|| "下次到期日超出日期范围".into())
}

/// 只负责状态规则；同日是否已有产出题记录由参数传入，方便固定日期测试。
fn next_state(
    status: &str,
    level: Option<i64>,
    due: &str,
    note: &str,
    kind: ReviewKind,
    correct: bool,
    today: &str,
    already_reviewed: bool,
    previewed: bool,
) -> Result<NextState, String> {
    match status {
        "✅已掌握" => return Err("词条已掌握，不能复习".into()),
        "🧊冷库" => return Err("词条在冷库中，不能复习".into()),
        "🌱待考察" | "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7" => {}
        _ => return Err(format!("词条状态无法复习：{status}")),
    }
    if kind == ReviewKind::Choice || already_reviewed {
        return Ok(unchanged(status, level, due, note));
    }

    let mut next = unchanged(status, level, due, note);
    next.changed = true;
    if status == "🌱待考察" {
        if previewed {
            next.status = "L1".into();
            next.level = Some(1);
            next.due = plus_days(today, 2)?;
            next.note = format!("{note}；{today} 首考前看过释义");
        } else if correct {
            next.status = "L3".into();
            next.level = Some(3);
            next.due = plus_days(today, 8)?;
            next.note = format!("{note}；{today} 首考过");
        } else {
            next.status = "L1".into();
            next.level = Some(1);
            next.due = plus_days(today, 2)?;
        }
        return Ok(next);
    }

    if !correct {
        if matches!(status, "L5" | "L6" | "L7") {
            next.status = "L3".into();
            next.level = Some(3);
            next.due = plus_days(today, 8)?;
        } else {
            next.status = "L1".into();
            next.level = Some(1);
            next.due = plus_days(today, 2)?;
        }
        return Ok(next);
    }
    match status {
        "L1" => {
            next.status = "L2".into();
            next.level = Some(2);
            next.due = plus_days(today, 4)?;
        }
        "L2" => {
            next.status = "L3".into();
            next.level = Some(3);
            next.due = plus_days(today, 8)?;
        }
        "L3" => {
            next.status = "L4".into();
            next.level = Some(4);
            next.due = plus_days(today, 16)?;
        }
        "L4" => {
            next.status = "L5".into();
            next.level = Some(5);
            next.due = plus_days(today, 45)?;
        }
        "L5" => {
            next.status = "L6".into();
            next.level = Some(6);
            next.due = plus_days(today, 90)?;
        }
        "L6" => {
            next.status = "L7".into();
            next.level = Some(7);
            next.due = plus_days(today, 180)?;
        }
        "L7" => {
            next.status = "✅已掌握".into();
            next.level = None;
            next.due.clear();
        }
        _ => unreachable!(),
    }
    Ok(next)
}

pub fn submit_at(
    db_path: &Path,
    request: ReviewSubmitRequest,
) -> Result<ReviewSubmitResult, String> {
    let today = Local::now().date_naive().format("%Y-%m-%d").to_string();
    let mut conn = schema::open(db_path).map_err(|error| error.to_string())?;
    submit_with_date(&mut conn, request, &today)
}

fn submit_with_date(
    conn: &mut Connection,
    request: ReviewSubmitRequest,
    today: &str,
) -> Result<ReviewSubmitResult, String> {
    NaiveDate::parse_from_str(today, "%Y-%m-%d")
        .map_err(|_| format!("复习日不是合法日期：{today}"))?;
    // IMMEDIATE 防止两个窗口同时通过「今天是否已复习」的检查。
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let current = tx
        .query_row(
            "SELECT status, level, due, note, deleted FROM review_word WHERE id = ?1",
            params![request.id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("词条不存在：{}", request.id))?;
    let (status, level, due, note, deleted) = current;
    if deleted != 0 {
        return Err(format!("词条已删除，不能复习：{}", request.id));
    }
    let already_reviewed = tx
    .query_row(
      "SELECT EXISTS(SELECT 1 FROM review_log WHERE word_id = ?1 AND review_date = ?2 AND kind IN ('recall', 'rewrite', 'sentence'))",
      params![request.id, today],
      |row| row.get::<_, bool>(0),
    )
    .map_err(|error| error.to_string())?;
    let next = next_state(
        &status,
        level,
        &due,
        &note,
        request.kind,
        request.correct,
        today,
        already_reviewed,
        request.previewed,
    )?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    if next.changed {
        tx.execute(
      "UPDATE review_word SET status = ?2, level = ?3, due = ?4, note = ?5, updated_at = ?6 WHERE id = ?1",
      params![request.id, next.status, next.level, next.due, next.note, now],
    )
    .map_err(|error| error.to_string())?;
    }
    tx.execute(
        "INSERT INTO review_log (
      word_id, review_date, kind, correct, before_status, after_status,
      before_due, after_due, created_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            request.id,
            today,
            request.kind.as_str(),
            request.correct,
            status,
            next.status,
            due,
            next.due,
            now
        ],
    )
    .map_err(|error| error.to_string())?;
    let result = ReviewSubmitResult {
        id: request.id,
        kind: request.kind,
        correct: request.correct,
        review_date: today.into(),
        changed: next.changed,
        status: next.status,
        level: next.level,
        due: next.due,
        note: next.note,
    };
    tx.commit().map_err(|error| error.to_string())?;
    Ok(result)
}

/// 只写日志的事件：同日复检、题目出错、笔误申诉。永远不改 review_word。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Recheck,
    QuestionError,
    Typo,
}

impl EventKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Recheck => "recheck",
            Self::QuestionError => "question_error",
            Self::Typo => "typo",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEventRequest {
    pub id: String,
    pub kind: EventKind,
    pub correct: bool,
    /// 复检：用户写法；题目出错：题面标识；笔误：「笔误：用户写法」。
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEventResult {
    pub id: String,
    pub kind: EventKind,
    pub review_date: String,
    pub status: String,
    pub due: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FlaggedSurface {
    pub word_id: String,
    pub detail: String,
}

pub fn event_at(db_path: &Path, request: ReviewEventRequest) -> Result<ReviewEventResult, String> {
    let today = Local::now().date_naive().format("%Y-%m-%d").to_string();
    let mut conn = schema::open(db_path).map_err(|error| error.to_string())?;
    event_with_date(&mut conn, request, &today)
}

fn event_with_date(
    conn: &mut Connection,
    request: ReviewEventRequest,
    today: &str,
) -> Result<ReviewEventResult, String> {
    NaiveDate::parse_from_str(today, "%Y-%m-%d")
        .map_err(|_| format!("复习日不是合法日期：{today}"))?;
    if request.detail.chars().count() > 2000 {
        return Err("日志内容太长".into());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let (status, due, deleted) = tx
        .query_row(
            "SELECT status, due, deleted FROM review_word WHERE id = ?1",
            params![request.id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("词条不存在：{}", request.id))?;
    if deleted != 0 {
        return Err(format!("词条已删除：{}", request.id));
    }
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    tx.execute(
        "INSERT INTO review_event (word_id, review_date, kind, correct, detail, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![request.id, today, request.kind.as_str(), request.correct, request.detail, now],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(ReviewEventResult {
        id: request.id,
        kind: request.kind,
        review_date: today.into(),
        status,
        due,
    })
}

/// 用户标过「这题出错了」的题面，出题时跳过。
pub fn flagged_at(db_path: &Path) -> Result<Vec<FlaggedSurface>, String> {
    if !db_path.exists() {
        return Ok(Vec::new());
    }
    let conn = schema::open(db_path).map_err(|error| error.to_string())?;
    let mut stmt = conn
        .prepare("SELECT word_id, detail FROM review_event WHERE kind = 'question_error' ORDER BY id")
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok(FlaggedSurface { word_id: row.get(0)?, detail: row.get(1)? }))
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vocab::export::{export_at, ExportKind};
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    const TODAY: &str = "2026-11-09";

    fn memory_db() -> Connection {
        schema::open(Path::new(":memory:")).unwrap()
    }

    fn add_word(
        conn: &Connection,
        id: &str,
        status: &str,
        level: Option<i64>,
        due: &str,
        note: &str,
        deleted: i64,
    ) {
        let raw = format!("| {id} | 1.1 | 2026-11-01 | {status} | {due} | {note} |");
        conn.execute(
            "INSERT INTO review_word (
        id, ord, line, raw, word, word_norm, issue, added_at, status,
        level, due, note, imported_at, updated_at, deleted
      ) VALUES (?1, 1, 4, ?2, ?1, ?1, '1.1', '2026-11-01', ?3, ?4, ?5, ?6, 'old', 'old', ?7)",
            params![id, raw, status, level, due, note, deleted],
        )
        .unwrap();
    }

    fn request(id: &str, kind: ReviewKind, correct: bool) -> ReviewSubmitRequest {
        ReviewSubmitRequest {
            id: id.into(),
            kind,
            correct,
            previewed: false,
        }
    }

    fn submit(
        conn: &mut Connection,
        id: &str,
        kind: ReviewKind,
        correct: bool,
    ) -> Result<ReviewSubmitResult, String> {
        submit_with_date(conn, request(id, kind, correct), TODAY)
    }

    fn word(conn: &Connection, id: &str) -> (String, Option<i64>, String, String, String) {
        conn.query_row(
            "SELECT status, level, due, note, updated_at FROM review_word WHERE id = ?1",
            params![id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap()
    }

    fn log_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM review_log", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn transition_table_covers_every_status_rule_and_calendar_boundaries() {
        struct Case {
            name: &'static str,
            today: &'static str,
            status: &'static str,
            level: Option<i64>,
            correct: bool,
            expected_status: &'static str,
            expected_level: Option<i64>,
            expected_due: &'static str,
            expected_note: &'static str,
        }
        let cases = [
            Case {
                name: "待考察不看释义答对",
                today: TODAY,
                status: "🌱待考察",
                level: None,
                correct: true,
                expected_status: "L3",
                expected_level: Some(3),
                expected_due: "2026-11-17",
                expected_note: "旧备注；2026-11-09 首考过",
            },
            Case {
                name: "待考察答错",
                today: TODAY,
                status: "🌱待考察",
                level: None,
                correct: false,
                expected_status: "L1",
                expected_level: Some(1),
                expected_due: "2026-11-11",
                expected_note: "旧备注",
            },
            Case {
                name: "L1答对",
                today: TODAY,
                status: "L1",
                level: Some(1),
                correct: true,
                expected_status: "L2",
                expected_level: Some(2),
                expected_due: "2026-11-13",
                expected_note: "旧备注",
            },
            Case {
                name: "L2答对",
                today: TODAY,
                status: "L2",
                level: Some(2),
                correct: true,
                expected_status: "L3",
                expected_level: Some(3),
                expected_due: "2026-11-17",
                expected_note: "旧备注",
            },
            Case {
                name: "L3答对",
                today: TODAY,
                status: "L3",
                level: Some(3),
                correct: true,
                expected_status: "L4",
                expected_level: Some(4),
                expected_due: "2026-11-25",
                expected_note: "旧备注",
            },
            Case {
                name: "L4答对",
                today: TODAY,
                status: "L4",
                level: Some(4),
                correct: true,
                expected_status: "L5",
                expected_level: Some(5),
                expected_due: "2026-12-24",
                expected_note: "旧备注",
            },
            Case {
                name: "L5答对",
                today: TODAY,
                status: "L5",
                level: Some(5),
                correct: true,
                expected_status: "L6",
                expected_level: Some(6),
                expected_due: "2027-02-07",
                expected_note: "旧备注",
            },
            Case {
                name: "L6答对",
                today: TODAY,
                status: "L6",
                level: Some(6),
                correct: true,
                expected_status: "L7",
                expected_level: Some(7),
                expected_due: "2027-05-08",
                expected_note: "旧备注",
            },
            Case {
                name: "L7答对",
                today: TODAY,
                status: "L7",
                level: Some(7),
                correct: true,
                expected_status: "✅已掌握",
                expected_level: None,
                expected_due: "",
                expected_note: "旧备注",
            },
            Case {
                name: "L1答错",
                today: TODAY,
                status: "L1",
                level: Some(1),
                correct: false,
                expected_status: "L1",
                expected_level: Some(1),
                expected_due: "2026-11-11",
                expected_note: "旧备注",
            },
            Case {
                name: "L2答错",
                today: TODAY,
                status: "L2",
                level: Some(2),
                correct: false,
                expected_status: "L1",
                expected_level: Some(1),
                expected_due: "2026-11-11",
                expected_note: "旧备注",
            },
            Case {
                name: "L3答错",
                today: TODAY,
                status: "L3",
                level: Some(3),
                correct: false,
                expected_status: "L1",
                expected_level: Some(1),
                expected_due: "2026-11-11",
                expected_note: "旧备注",
            },
            Case {
                name: "L4答错",
                today: TODAY,
                status: "L4",
                level: Some(4),
                correct: false,
                expected_status: "L1",
                expected_level: Some(1),
                expected_due: "2026-11-11",
                expected_note: "旧备注",
            },
            Case {
                name: "L5答错",
                today: TODAY,
                status: "L5",
                level: Some(5),
                correct: false,
                expected_status: "L3",
                expected_level: Some(3),
                expected_due: "2026-11-17",
                expected_note: "旧备注",
            },
            Case {
                name: "L6答错",
                today: TODAY,
                status: "L6",
                level: Some(6),
                correct: false,
                expected_status: "L3",
                expected_level: Some(3),
                expected_due: "2026-11-17",
                expected_note: "旧备注",
            },
            Case {
                name: "L7答错",
                today: TODAY,
                status: "L7",
                level: Some(7),
                correct: false,
                expected_status: "L3",
                expected_level: Some(3),
                expected_due: "2026-11-17",
                expected_note: "旧备注",
            },
            Case {
                name: "跨月",
                today: "2026-10-31",
                status: "L1",
                level: Some(1),
                correct: true,
                expected_status: "L2",
                expected_level: Some(2),
                expected_due: "2026-11-04",
                expected_note: "旧备注",
            },
            Case {
                name: "跨年",
                today: "2026-12-31",
                status: "L2",
                level: Some(2),
                correct: true,
                expected_status: "L3",
                expected_level: Some(3),
                expected_due: "2027-01-08",
                expected_note: "旧备注",
            },
        ];
        for case in cases {
            let next = next_state(
                case.status,
                case.level,
                "2026-11-09",
                "旧备注",
                ReviewKind::Recall,
                case.correct,
                case.today,
                false,
                false,
            )
            .unwrap();
            assert_eq!(
                (
                    next.status.as_str(),
                    next.level,
                    next.due.as_str(),
                    next.note.as_str(),
                    next.changed
                ),
                (
                    case.expected_status,
                    case.expected_level,
                    case.expected_due,
                    case.expected_note,
                    true
                ),
                "{}",
                case.name
            );
        }
        for kind in [
            ReviewKind::Recall,
            ReviewKind::Rewrite,
            ReviewKind::Sentence,
        ] {
            assert_eq!(
                next_state("L1", Some(1), "", "", kind, true, TODAY, false, false)
                    .unwrap()
                    .status,
                "L2"
            );
        }
    }

    #[test]
    fn previewed_first_test_enters_l1_and_appends_note_for_either_verdict() {
        for correct in [true, false] {
            let next = next_state(
                "🌱待考察",
                None,
                "",
                "旧备注",
                ReviewKind::Recall,
                correct,
                TODAY,
                false,
                true,
            )
            .unwrap();
            assert_eq!(next.status, "L1");
            assert_eq!(next.level, Some(1));
            assert_eq!(next.due, "2026-11-11");
            assert_eq!(next.note, "旧备注；2026-11-09 首考前看过释义");
            assert!(next.changed);
        }
    }

    #[test]
    fn previewed_defaults_false_and_does_not_change_other_rules() {
        let legacy: ReviewSubmitRequest = serde_json::from_str(
            r#"{"id":"rv:legacy","kind":"recall","correct":true}"#,
        )
        .unwrap();
        assert!(!legacy.previewed);

        let l1 = next_state("L1", Some(1), "", "旧备注", ReviewKind::Recall, true, TODAY, false, true)
            .unwrap();
        assert_eq!((l1.status.as_str(), l1.due.as_str(), l1.note.as_str()), ("L2", "2026-11-13", "旧备注"));

        for (kind, already_reviewed) in [(ReviewKind::Choice, false), (ReviewKind::Recall, true)] {
            let unchanged = next_state(
                "🌱待考察", None, "", "旧备注", kind, true, TODAY, already_reviewed, true,
            )
            .unwrap();
            assert_eq!(unchanged.status, "🌱待考察");
            assert_eq!(unchanged.note, "旧备注");
            assert!(!unchanged.changed);
        }
    }

    #[test]
    fn second_production_review_same_day_only_writes_log_even_when_wrong() {
        let mut conn = memory_db();
        add_word(&conn, "rv:repeat", "L1", Some(1), "2026-11-09", "备注", 0);
        let first = submit(&mut conn, "rv:repeat", ReviewKind::Recall, true).unwrap();
        assert!(first.changed);
        let after_first = word(&conn, "rv:repeat");
        let second = submit(&mut conn, "rv:repeat", ReviewKind::Rewrite, true).unwrap();
        assert!(!second.changed);
        assert_eq!(word(&conn, "rv:repeat"), after_first);
        assert_eq!(log_count(&conn), 2);

        let mut conn = memory_db();
        add_word(&conn, "rv:wrong", "L2", Some(2), "2026-11-09", "备注", 0);
        submit(&mut conn, "rv:wrong", ReviewKind::Recall, true).unwrap();
        let wrong = submit(&mut conn, "rv:wrong", ReviewKind::Sentence, false).unwrap();
        assert!(!wrong.changed);
        assert_eq!(word(&conn, "rv:wrong").0, "L3");
        assert_eq!(word(&conn, "rv:wrong").2, "2026-11-17");
        let log: (String, String) = conn
            .query_row(
                "SELECT before_status, after_status FROM review_log ORDER BY id DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(log, ("L3".into(), "L3".into()));
    }

    #[test]
    fn choice_never_changes_state_and_does_not_consume_daily_production_review() {
        let mut conn = memory_db();
        add_word(&conn, "rv:choice", "L3", Some(3), "2026-11-09", "备注", 0);
        let choice = submit(&mut conn, "rv:choice", ReviewKind::Choice, false).unwrap();
        assert!(!choice.changed);
        assert_eq!(
            word(&conn, "rv:choice"),
            (
                "L3".into(),
                Some(3),
                "2026-11-09".into(),
                "备注".into(),
                "old".into()
            )
        );
        let production = submit(&mut conn, "rv:choice", ReviewKind::Recall, true).unwrap();
        assert!(production.changed);
        assert_eq!(word(&conn, "rv:choice").0, "L4");
        assert_eq!(log_count(&conn), 2);
    }

    #[test]
    fn mastered_cold_deleted_unknown_and_missing_are_rejected_without_writes() {
        let mut conn = memory_db();
        for (id, status, level, deleted) in [
            ("rv:mastered", "✅已掌握", None, 0),
            ("rv:cold", "🧊冷库", None, 0),
            ("rv:deleted", "L1", Some(1), 1),
            ("rv:unknown", "未知", None, 0),
        ] {
            add_word(&conn, id, status, level, "2026-11-09", "备注", deleted);
            let before = word(&conn, id);
            assert!(
                submit(&mut conn, id, ReviewKind::Recall, true).is_err(),
                "{id}"
            );
            assert_eq!(word(&conn, id), before);
        }
        let error = submit(&mut conn, "rv:missing", ReviewKind::Recall, true).unwrap_err();
        assert!(error.contains("不存在"));
        assert_eq!(log_count(&conn), 0);
    }

    #[test]
    fn log_insert_failure_rolls_back_word_and_log() {
        let mut conn = memory_db();
        add_word(&conn, "rv:rollback", "L1", Some(1), "2026-11-09", "备注", 0);
        let before = word(&conn, "rv:rollback");
        conn.execute_batch("CREATE TEMP TRIGGER force_review_log_failure BEFORE INSERT ON review_log BEGIN SELECT RAISE(ABORT, 'forced review log failure'); END").unwrap();
        let error = submit(&mut conn, "rv:rollback", ReviewKind::Recall, true).unwrap_err();
        assert!(error.contains("forced review log failure"));
        assert_eq!(word(&conn, "rv:rollback"), before);
        assert_eq!(log_count(&conn), 0);
    }

    fn event(conn: &mut Connection, id: &str, kind: EventKind, correct: bool, detail: &str) -> Result<ReviewEventResult, String> {
        event_with_date(
            conn,
            ReviewEventRequest { id: id.into(), kind, correct, detail: detail.into() },
            TODAY,
        )
    }

    #[test]
    fn recheck_after_first_round_wrong_keeps_l1_and_never_changes_state() {
        let mut conn = memory_db();
        add_word(&conn, "rv:recheck", "L3", Some(3), "2026-11-09", "备注", 0);
        let first = submit(&mut conn, "rv:recheck", ReviewKind::Recall, false).unwrap();
        assert_eq!((first.status.as_str(), first.due.as_str()), ("L1", "2026-11-11"));
        let after_first = word(&conn, "rv:recheck");
        let logs = log_count(&conn);

        // 复检答对：状态、到期日、备注、更新时间全不变，review_log 也不多一行。
        let result = event(&mut conn, "rv:recheck", EventKind::Recheck, true, "resilient").unwrap();
        assert_eq!((result.status.as_str(), result.due.as_str()), ("L1", "2026-11-11"));
        assert_eq!(word(&conn, "rv:recheck"), after_first);
        assert_eq!(log_count(&conn), logs);
        let events: i64 = conn
            .query_row("SELECT COUNT(*) FROM review_event WHERE kind = 'recheck' AND correct = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(events, 1);
    }

    #[test]
    fn question_error_and_typo_events_do_not_touch_state_or_consume_daily_review() {
        let mut conn = memory_db();
        add_word(&conn, "rv:flag", "L2", Some(2), "2026-11-09", "备注", 0);
        let before = word(&conn, "rv:flag");
        event(&mut conn, "rv:flag", EventKind::QuestionError, false, "rv:flag|surface").unwrap();
        event(&mut conn, "rv:flag", EventKind::Typo, true, "笔误：用户写法 resiliant").unwrap();
        assert_eq!(word(&conn, "rv:flag"), before);
        assert_eq!(log_count(&conn), 0);
        // 题目出错不占用「今天已复习」：之后首轮仍能正常升级。
        let first = submit(&mut conn, "rv:flag", ReviewKind::Recall, true).unwrap();
        assert!(first.changed);
        assert_eq!(word(&conn, "rv:flag").0, "L3");
    }

    #[test]
    fn events_reject_missing_deleted_words_and_list_flagged_surfaces() {
        let mut conn = memory_db();
        add_word(&conn, "rv:gone", "L1", Some(1), "2026-11-09", "备注", 1);
        assert!(event(&mut conn, "rv:gone", EventKind::Recheck, true, "x").unwrap_err().contains("已删除"));
        assert!(event(&mut conn, "rv:none", EventKind::Recheck, true, "x").unwrap_err().contains("不存在"));
        assert!(event(&mut conn, "rv:gone", EventKind::Recheck, true, &"长".repeat(2001)).is_err());
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM review_event", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn flagged_at_returns_only_question_error_rows() {
        let dir = TestDir::new();
        let db = dir.0.join("flag.db");
        assert!(flagged_at(&db).unwrap().is_empty(), "没有库文件不建库");
        assert!(!db.exists());
        let mut conn = schema::open(&db).unwrap();
        add_word(&conn, "rv:f", "L1", Some(1), "2026-11-09", "备注", 0);
        event(&mut conn, "rv:f", EventKind::QuestionError, false, "surface-1").unwrap();
        event(&mut conn, "rv:f", EventKind::Recheck, false, "ignored").unwrap();
        drop(conn);
        assert_eq!(
            flagged_at(&db).unwrap(),
            vec![FlaggedSurface { word_id: "rv:f".into(), detail: "surface-1".into() }]
        );
    }

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join("vocab-review-tests")
                .join(Uuid::new_v4().to_string());
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn export_after_submit_contains_new_status_due_and_note() {
        let dir = TestDir::new();
        let db = dir.0.join("vocab.db");
        let mut conn = schema::open(&db).unwrap();
        add_word(&conn, "rv:export", "L3", Some(3), "2026-11-09", "旧备注", 0);
        submit(&mut conn, "rv:export", ReviewKind::Recall, true).unwrap();
        drop(conn);
        let output = dir.0.join("review.md");
        export_at(&db, ExportKind::Review, &output).unwrap();
        let markdown = fs::read_to_string(output).unwrap();
        assert!(
            markdown.contains("| rv:export | 1.1 | 2026-11-01 | L4 | 2026-11-25 | 旧备注 |"),
            "{markdown}"
        );
        assert!(!markdown.contains("| rv:export | 1.1 | 2026-11-01 | L3 | 2026-11-09 | 旧备注 |"));
    }

    #[test]
    fn export_after_previewed_first_test_contains_l1_and_preview_note() {
        let dir = TestDir::new();
        let db = dir.0.join("vocab.db");
        let mut conn = schema::open(&db).unwrap();
        add_word(&conn, "rv:preview", "🌱待考察", None, "", "旧备注", 0);
        submit_with_date(
            &mut conn,
            ReviewSubmitRequest { previewed: true, ..request("rv:preview", ReviewKind::Recall, true) },
            TODAY,
        )
        .unwrap();
        drop(conn);
        let output = dir.0.join("review.md");
        export_at(&db, ExportKind::Review, &output).unwrap();
        let markdown = fs::read_to_string(output).unwrap();
        assert!(
            markdown.contains("| rv:preview | 1.1 | 2026-11-01 | L1 | 2026-11-11 | 旧备注；2026-11-09 首考前看过释义 |"),
            "{markdown}"
        );
    }
}
