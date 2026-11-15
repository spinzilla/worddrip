#[tauri::command]
pub fn vocab_library_export() -> Result<Vec<u8>, String> {
  super::library::export_at(&schema::db_path())
}

#[tauri::command]
pub fn vocab_library_preview(request: super::library::LibraryImportRequest) -> Result<super::library::LibrarySummary, String> {
  super::library::preview_at(&schema::db_path(), &request.data)
}

#[tauri::command]
pub fn vocab_library_import(request: super::library::LibraryImportRequest) -> Result<super::library::LibraryImportResult, String> {
  super::library::import_at(&schema::db_path(), &request.data)
}
use super::import;
use super::models::{ImportPreviewReport, ImportReport, ImportRequest, VocabStats};
use super::schema;

#[tauri::command]
pub fn vocab_import(request: ImportRequest) -> Result<ImportReport, String> {
  import::import_at(&schema::db_path(), request)
}

#[tauri::command]
pub fn vocab_import_preview(request: ImportRequest) -> Result<ImportPreviewReport, String> {
  import::preview_at(&schema::db_path(), request)
}

/// 手写候选只有点击确认后才到这里；整批事务写入，重复词不会部分入库。
#[tauri::command]
pub fn vocab_definition_preview(
  request: super::models::DefinitionImportRequest,
) -> Result<super::models::DefinitionImportReport, String> {
  super::definition::preview_at(&schema::db_path(), request)
}

#[tauri::command]
pub fn vocab_definition_import(
  request: super::models::DefinitionImportRequest,
) -> Result<super::models::DefinitionImportReport, String> {
  super::definition::import_at(&schema::db_path(), request)
}

#[tauri::command]
pub fn vocab_inbox_confirm(
  request: super::inbox::InboxConfirmRequest,
) -> Result<super::inbox::InboxConfirmResult, String> {
  super::inbox::confirm_at(&schema::db_path(), request)
}

/// 042 手动加词：词库页「添加词条」、查词卡「加入词库」。同名词默认拒绝，用户选了才再加一行。
#[tauri::command]
pub fn vocab_manual_add(
  request: super::manual::ManualAddRequest,
) -> Result<super::manual::ManualAddResult, String> {
  super::manual::add_at(&schema::db_path(), request)
}

/// 只读浏览：一次返回三类记录（升级词含有序例句）。
#[tauri::command]
pub fn vocab_browse() -> Result<super::models::BrowseData, String> {
  super::query::browse_at(&schema::db_path())
}

/// 教练页只读查询，不建库，也不改待巩固状态。
#[tauri::command]
pub fn vocab_coach_browse() -> Result<super::models::CoachArchiveData, String> {
  super::query::coach_at(&schema::db_path())
}

/// 记录一次复习；选择题和同日重复产出题只写日志。
#[tauri::command]
pub fn vocab_review_submit(
  request: super::review::ReviewSubmitRequest,
) -> Result<super::review::ReviewSubmitResult, String> {
  super::review::submit_at(&schema::db_path(), request)
}

/// 同日复检、题目出错、笔误申诉：只写日志，不改复习状态。
#[tauri::command]
pub fn vocab_review_event(
  request: super::review::ReviewEventRequest,
) -> Result<super::review::ReviewEventResult, String> {
  super::review::event_at(&schema::db_path(), request)
}

/// 用户标过「这题出错了」的题面。
#[tauri::command]
pub fn vocab_review_flagged() -> Result<Vec<super::review::FlaggedSurface>, String> {
  super::review::flagged_at(&schema::db_path())
}

/// 修改词条来源与查证状态；复习状态和原始行不受影响。
#[tauri::command]
pub fn vocab_review_metadata_update(
  request: super::metadata::ReviewMetadataRequest
) -> Result<super::metadata::ReviewMetadataResult, String> {
  super::metadata::update_at(&schema::db_path(), request)
}

/// 只读生成归档预览；不创建作文、批次或错误项。
#[tauri::command]
pub fn vocab_coach_archive_preview(
  request: super::archive::CoachArchiveRequest,
) -> Result<super::archive::CoachArchivePlan, String> {
  super::archive::preview_at(&schema::db_path(), request)
}

/// 用户确认后整批归档；review_id 保证同一次批改只写一份。
#[tauri::command]
pub fn vocab_coach_archive(
  request: super::archive::CoachArchiveRequest,
) -> Result<super::archive::CoachArchivePlan, String> {
  super::archive::archive_at(&schema::db_path(), request)
}
#[tauri::command]
pub fn vocab_stats() -> Result<VocabStats, String> {
  import::stats_at(&schema::db_path())
}

/// 导出只读副本；保存对话框取消时前端不会调用这里。
#[tauri::command]
pub fn vocab_export(request: super::export::ExportRequest) -> Result<super::export::VocabExportResult, String> {
  super::export::export_at(&schema::db_path(), request.kind, std::path::Path::new(&request.path))
}

#[tauri::command]
pub fn vocab_errors_import_preview() -> Result<(), String> {
  super::errors::preview_at(&schema::db_path())
}

#[tauri::command]
pub fn vocab_errors_import(
  request: super::models::ErrorImportRequest,
) -> Result<super::models::ErrorImportReport, String> {
  super::errors::import_at(&schema::db_path(), request)
}

/// 040 词条笔记：只读列出全部笔记（按词归一化键分组）。
#[tauri::command]
pub fn vocab_notes() -> Result<Vec<super::notes::VocabNote>, String> {
  super::notes::list_at(&schema::db_path())
}

#[tauri::command]
pub fn vocab_note_add(request: super::notes::NoteAddRequest) -> Result<super::notes::VocabNote, String> {
  super::notes::add_at(&schema::db_path(), request)
}

#[tauri::command]
pub fn vocab_note_update(request: super::notes::NoteUpdateRequest) -> Result<super::notes::VocabNote, String> {
  super::notes::update_at(&schema::db_path(), request)
}

#[tauri::command]
pub fn vocab_note_delete(request: super::notes::NoteDeleteRequest) -> Result<i64, String> {
  super::notes::delete_at(&schema::db_path(), request)
}

/// 043 我的例句：只读列出全部例句（按词归一化键分组）。
#[tauri::command]
pub fn vocab_examples() -> Result<Vec<super::examples::VocabExample>, String> {
  super::examples::list_at(&schema::db_path())
}

/// 给一个词存一句或几句（整批一个事务）。
#[tauri::command]
pub fn vocab_example_add(request: super::examples::ExampleAddRequest) -> Result<Vec<super::examples::VocabExample>, String> {
  super::examples::add_at(&schema::db_path(), request)
}

/// 078 英英释义：只读列出全部（按词归一化键分组）。
#[tauri::command]
pub fn vocab_definitions_en() -> Result<Vec<super::definition_en::VocabDefinitionEn>, String> {
  super::definition_en::list_at(&schema::db_path())
}

#[tauri::command]
pub fn vocab_definition_en_add(request: super::definition_en::DefinitionEnAddRequest) -> Result<Vec<super::definition_en::VocabDefinitionEn>, String> {
  super::definition_en::add_at(&schema::db_path(), request)
}

#[tauri::command]
pub fn vocab_definition_en_update(request: super::definition_en::DefinitionEnUpdateRequest) -> Result<super::definition_en::VocabDefinitionEn, String> {
  super::definition_en::update_at(&schema::db_path(), request)
}

#[tauri::command]
pub fn vocab_definition_en_delete(request: super::definition_en::DefinitionEnDeleteRequest) -> Result<i64, String> {
  super::definition_en::delete_at(&schema::db_path(), request)
}

/// 048 例句场景标签：只读列出全部。
#[tauri::command]
pub fn vocab_scenes() -> Result<Vec<super::scenes::ExampleScene>, String> {
  super::scenes::list_at(&schema::db_path())
}

/// 048：写一批场景标签（AI 标的不会覆盖手动的）。
#[tauri::command]
pub fn vocab_scene_set(request: super::scenes::SceneSetRequest) -> Result<Vec<super::scenes::ExampleScene>, String> {
  super::scenes::set_at(&schema::db_path(), request)
}

/// 055 随手记：按时间倒序列出，status 可选「待整理 / 已整理」。
#[tauri::command]
pub fn quicknote_list(status: Option<String>) -> Result<Vec<super::quicknote::QuickNote>, String> {
  super::quicknote::list_at(&schema::db_path(), status.as_deref())
}

#[tauri::command]
pub fn quicknote_add(request: super::quicknote::QuickNoteAddRequest) -> Result<super::quicknote::QuickNote, String> {
  super::quicknote::add_at(&schema::db_path(), request)
}

#[tauri::command]
pub fn quicknote_update(request: super::quicknote::QuickNoteUpdateRequest) -> Result<super::quicknote::QuickNote, String> {
  super::quicknote::update_at(&schema::db_path(), request)
}

#[tauri::command]
pub fn quicknote_mark(request: super::quicknote::QuickNoteMarkRequest) -> Result<super::quicknote::QuickNote, String> {
  super::quicknote::mark_at(&schema::db_path(), request)
}

#[tauri::command]
pub fn quicknote_delete(request: super::quicknote::QuickNoteDeleteRequest) -> Result<i64, String> {
  super::quicknote::delete_at(&schema::db_path(), request)
}

#[tauri::command]
pub fn vocab_example_delete(request: super::examples::ExampleDeleteRequest) -> Result<i64, String> {
  super::examples::delete_at(&schema::db_path(), request)
}

// ───── 071 同步核心：前端（utils/sync）负责联网，这里只处理本机词库 ─────

fn sync_conn() -> Result<rusqlite::Connection, String> {
  let conn = schema::open(&schema::db_path()).map_err(|e| format!("打开词库失败：{e}"))?;
  conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
  Ok(conn)
}

#[derive(serde::Deserialize)]
pub struct SyncKeyRequest {
  pub server_key: String,
}

#[derive(serde::Deserialize)]
pub struct SyncCollectRequest {
  pub limit: Option<usize>,
}

#[derive(serde::Deserialize)]
pub struct SyncAckRequest {
  pub items: Vec<super::sync::AckItem>,
}

#[derive(serde::Deserialize)]
pub struct SyncApplyRequest {
  pub server_key: String,
  pub changes: Vec<super::sync::RemoteChange>,
  pub cursor: Option<i64>,
}

/// 一次同步开始：首次同步会把现有行都记成待推送；返回设备号和上次的 cursor。
#[tauri::command]
pub fn sync_begin(request: SyncKeyRequest) -> Result<super::sync::Begin, String> {
  let device = super::sync::device_id()?;
  super::sync::begin(&sync_conn()?, &request.server_key, &device).map_err(|e| format!("准备同步失败：{e}"))
}

#[tauri::command]
pub fn sync_collect(request: SyncCollectRequest) -> Result<Vec<super::sync::ChangeOut>, String> {
  let limit = request.limit.unwrap_or(500).clamp(1, 2000);
  super::sync::collect(&sync_conn()?, limit).map_err(|e| format!("读取待同步改动失败：{e}"))
}

#[tauri::command]
pub fn sync_ack(request: SyncAckRequest) -> Result<usize, String> {
  super::sync::ack(&sync_conn()?, &request.items).map_err(|e| format!("记录同步结果失败：{e}"))
}

#[tauri::command]
pub fn sync_apply(request: SyncApplyRequest) -> Result<super::sync::ApplyResult, String> {
  let device = super::sync::device_id()?;
  let cursor = request.cursor.map(|c| (request.server_key.as_str(), c));
  super::sync::apply(&sync_conn()?, &request.changes, &device, cursor)
}

#[tauri::command]
pub fn sync_finish(request: SyncKeyRequest) -> Result<(), String> {
  let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
  super::sync::finish(&sync_conn()?, &request.server_key, now).map_err(|e| e.to_string())
}

/// 状态：待推送条数、cursor、上次同步时间。本机还没有词库时不建库，直接返回零。
#[tauri::command]
pub fn sync_status(request: SyncKeyRequest) -> Result<super::sync::Status, String> {
  let device = super::sync::device_id()?;
  if !schema::db_path().is_file() {
    return Ok(super::sync::Status { device_id: device, dirty: 0, cursor: 0, last_sync_ms: None });
  }
  super::sync::status(&sync_conn()?, &request.server_key, &device).map_err(|e| e.to_string())
}

/// 手动重置同步状态（换同步空间、怀疑对不上时用）：cursor 归零，所有行重新记成待推送。
#[tauri::command]
pub fn sync_reset() -> Result<(), String> {
  super::sync::reset_all(&sync_conn()?).map_err(|e| format!("重置同步状态失败：{e}"))
}

/// 081 每日新词：候选池（认识 / 收下 / 以后再说）。
#[tauri::command]
pub fn wordpack_pick_list() -> Result<Vec<super::pick::PickRow>, String> {
  super::pick::list_at(&schema::db_path())
}

#[tauri::command]
pub fn wordpack_pick_set(items: Vec<super::pick::PickItem>) -> Result<usize, String> {
  super::pick::set_at(&schema::db_path(), items)
}

/// 079 重测词汇量：清掉某个来源自动记下的「认识」，返回清了几个。
#[tauri::command]
pub fn wordpack_pick_clear_known(pack: String) -> Result<usize, String> {
  super::pick::clear_known_at(&schema::db_path(), &pack)
}

#[tauri::command]
pub fn wordpack_pick_take(request: super::pick::TakeRequest) -> Result<super::pick::TakeResult, String> {
  super::pick::take_at(&schema::db_path(), request)
}

/// 081 学习计划（单行表 daily_plan，会同步）。没设置过返回 null。
#[tauri::command]
pub fn daily_plan_get() -> Result<Option<super::pick::PlanRow>, String> {
  super::pick::plan_get_at(&schema::db_path())
}

#[tauri::command]
pub fn daily_plan_set(plan: super::pick::PlanRow) -> Result<super::pick::PlanRow, String> {
  super::pick::plan_set_at(&schema::db_path(), plan)
}

#[tauri::command]
pub fn wordpack_pick_undo(request: super::pick::UndoRequest) -> Result<(), String> {
  super::pick::undo_at(&schema::db_path(), request)
}
