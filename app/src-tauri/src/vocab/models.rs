use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInput {
  pub file_name: String,
  pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeEntryInput {
  pub id: String,
  pub line: i64,
  pub raw: String,
  pub plain: String,
  pub upgrade: String,
  pub source: String,
  pub note: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeExampleInput {
  pub entry_id: String,
  pub seq: i64,
  pub cand: String,
  pub sentence: String,
  pub ai: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfCheckInput {
  pub id: String,
  pub line: i64,
  pub raw: String,
  pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewWordInput {
  pub id: String,
  pub line: i64,
  pub raw: String,
  pub word: String,
  pub issue: String,
  pub added_at: String,
  pub status: String,
  pub level: Option<i64>,
  pub due: String,
  pub note: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WarningInput {
  pub line: i64,
  pub kind: String,
  pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportWarnings {
  pub upgrade: Vec<WarningInput>,
  pub review: Vec<WarningInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
  pub upgrade: SourceInput,
  pub review: SourceInput,
  pub entries: Vec<UpgradeEntryInput>,
  pub examples: Vec<UpgradeExampleInput>,
  pub self_checks: Vec<SelfCheckInput>,
  pub review_words: Vec<ReviewWordInput>,
  pub warnings: ImportWarnings,
}

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportCounts {
  pub added: i64,
  pub skipped: i64,
}

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewImportCounts {
  pub added: i64,
  pub updated: i64,
  pub skipped: i64,
  pub conflicts: i64,
}

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewReport {
  pub review_words: ReviewImportCounts,
  pub conflicts: Vec<String>,
}

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
  pub upgrade_entries: ImportCounts,
  pub upgrade_examples_added: i64,
  pub self_checks: ImportCounts,
  pub review_words: ReviewImportCounts,
  pub totals: VocabStats,
  pub upgrade_sha256: String,
  pub review_sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionImportRequest {
  pub issues: Vec<SourceInput>,
  pub eagp: Option<SourceInput>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionUnmatched {
  pub file_name: String,
  pub line: i64,
  pub word: String,
  pub reason: String,
}

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionImportReport {
  pub matched: i64,
  pub added: i64,
  pub skipped: i64,
  pub unmatched: i64,
  pub examples_added: i64,
  pub unmatched_items: Vec<DefinitionUnmatched>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowseDefinitionExample {
  pub seq: i64,
  pub sentence: String,
  pub ai: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowseDefinition {
  pub source_file: String,
  pub source_line: i64,
  pub pos: String,
  pub english: String,
  pub chinese: String,
  pub examples: Vec<BrowseDefinitionExample>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowseExample {
  pub seq: i64,
  pub cand: String,
  pub sentence: String,
  pub ai: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowseUpgrade {
  pub id: String,
  pub ord: i64,
  pub line: i64,
  pub raw: String,
  pub plain: String,
  pub upgrade: String,
  pub source: String,
  pub note: String,
  pub examples: Vec<BrowseExample>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowseSelfCheck {
  pub id: String,
  pub ord: i64,
  pub line: i64,
  pub raw: String,
  pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowseReviewWord {
  pub id: String,
  pub ord: i64,
  pub line: i64,
  pub raw: String,
  pub word: String,
  pub issue: String,
  pub added_at: String,
  pub status: String,
  pub level: Option<i64>,
  pub due: String,
  pub note: String,
  pub source: String,
  pub verification_status: String,
  pub definitions: Vec<BrowseDefinition>,
}

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowseData {
  pub upgrades: Vec<BrowseUpgrade>,
  pub self_checks: Vec<BrowseSelfCheck>,
  pub review_words: Vec<BrowseReviewWord>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoachTop {
  pub id: String,
  pub ord: i64,
  pub rank: i64,
  pub kind: String,
  pub count: String,
  pub last_at: String,
  pub status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoachItem {
  pub id: String,
  pub batch_id: String,
  pub ord: i64,
  pub question: String,
  pub kind: String,
  pub written: String,
  pub correction: String,
  pub note: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoachBatch {
  pub id: String,
  pub ord: i64,
  pub title: String,
  pub date: String,
  pub metadata: serde_json::Value,
  pub items: Vec<CoachItem>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoachTodo {
  pub id: String,
  pub ord: i64,
  pub done: bool,
  pub text: String,
}

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoachArchiveData {
  pub top: Vec<CoachTop>,
  pub batches: Vec<CoachBatch>,
  pub todos: Vec<CoachTodo>,
}

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VocabStats {
  pub upgrade_entries: i64,
  pub upgrade_examples: i64,
  pub self_checks: i64,
  pub review_words: i64,
  pub import_runs: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorTopInput {
  pub id: String,
  pub ord: i64,
  pub line: i64,
  pub raw: String,
  pub rank: i64,
  pub kind: String,
  pub count: String,
  pub last_at: String,
  pub status: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBatchInput {
  pub id: String,
  pub ord: i64,
  pub line: i64,
  pub raw: String,
  pub title: String,
  pub date: String,
  pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorItemInput {
  pub id: String,
  pub batch_id: String,
  pub ord: i64,
  pub line: i64,
  pub raw: String,
  pub question: String,
  pub kind: String,
  pub written: String,
  pub correction: String,
  pub note: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorTodoInput {
  pub id: String,
  pub ord: i64,
  pub line: i64,
  pub raw: String,
  pub done: bool,
  pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEssayInput {
  pub id: String,
  pub ord: i64,
  pub line: i64,
  pub raw: String,
  pub date: String,
  pub standard: String,
  pub topic: String,
  pub word_count: String,
  pub original_file: String,
  pub result: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorImportRequest {
  pub source: SourceInput,
  pub top: Vec<ErrorTopInput>,
  pub batches: Vec<ErrorBatchInput>,
  pub items: Vec<ErrorItemInput>,
  pub todos: Vec<ErrorTodoInput>,
  pub essays: Vec<ErrorEssayInput>,
  pub warnings: Vec<WarningInput>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ErrorImportReport {
  pub top: i64,
  pub batches: i64,
  pub items: i64,
  pub todos: i64,
  pub essays: i64,
  pub source_sha256: String,
  pub totals: VocabStats,
}
