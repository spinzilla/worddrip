#[cfg(not(target_os = "android"))]
mod anki;
#[cfg(not(target_os = "android"))]
mod backup;
#[cfg(not(target_os = "android"))]
mod bailian;
#[cfg(not(target_os = "android"))]
mod cache;
#[cfg(not(target_os = "android"))]
mod clips;
#[cfg(not(target_os = "android"))]
mod cloud_asr;
#[cfg(not(target_os = "android"))]
mod cloud_pieces;
#[cfg(not(target_os = "android"))]
mod convert;
#[cfg(test)]
mod cloud_live_tests;
#[cfg(not(target_os = "android"))]
mod decode;
#[cfg(not(target_os = "android"))]
mod device;
mod dicts;
mod dicts_import;
#[cfg(not(target_os = "android"))]
mod dtw;
#[cfg(not(target_os = "android"))]
mod groq;
#[cfg(not(target_os = "android"))]
mod import;
#[cfg(not(target_os = "android"))]
mod import_queue;
mod ja_dict;
mod paths;
#[cfg(not(target_os = "android"))]
mod podcast;
#[cfg(not(target_os = "android"))]
mod repeat_fix;
mod tts;
mod tts_gec;
#[cfg(not(target_os = "android"))]
mod gpus;
mod vocab;
mod wordpack;
mod whisper_setup;
#[cfg(not(target_os = "android"))]
mod word_order;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // 真实窗口测试用（docs/e2e.md）：调试版且设了 ES_E2E_ISOLATE 时不注册 http 插件，
  // 因为它的 .cookies 会写到系统 Known Folder（改环境变量拦不住）。没设时和以前完全一样；发布版永远注册。
  let skip_http = cfg!(debug_assertions)
    && std::env::var_os("ES_E2E_ISOLATE").map_or(false, |v| !v.is_empty());
  let builder = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init());
  let builder = if skip_http { builder } else { builder.plugin(tauri_plugin_http::init()) };
  #[cfg(not(target_os = "android"))]
  let builder = builder
    .plugin(tauri_plugin_process::init())
    // 077：官方更新器（只电脑编译）。清单地址和公钥在 tauri.conf.json 的 plugins.updater。
    .plugin(tauri_plugin_updater::Builder::new().build());
  builder
    .plugin(tauri_plugin_opener::init())
    // 原版的一次性更新在这里注册过（从 linguaclipapp.com 下载）；English Studio 不用。
    .setup(|app| {
      let data_dir = paths::app_data_dir();
      std::fs::create_dir_all(&data_dir)
        .map_err(|error| format!("创建应用数据目录 {} 失败：{error}", data_dir.display()))?;
      dicts::sweep();
      vocab::schema::migrate_existing(&vocab::schema::db_path())
        .map_err(|error| format!("启动时升级词库数据库失败：{error}"))?;
      if cfg!(debug_assertions) {
        let mut log = tauri_plugin_log::Builder::default().level(log::LevelFilter::Info);
        // 真实窗口测试用（docs/e2e.md）：ES_LOG_DIR 有值就把日志写到那个目录；没设时和以前完全一样。
        if let Some(dir) = std::env::var_os("ES_LOG_DIR").filter(|v| !v.is_empty()) {
          log = log.clear_targets().target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::Folder { path: dir.into(), file_name: None },
          ));
        }
        app.handle().plugin(log.build())?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      #[cfg(not(target_os = "android"))]
      import::start_import,
      #[cfg(not(target_os = "android"))]
      import::cancel_import,
      #[cfg(not(target_os = "android"))]
      import::open_youtube_login,
      #[cfg(not(target_os = "android"))]
      import::probe_import_sizes,
      #[cfg(not(target_os = "android"))]
      anki::anki_request,
      #[cfg(not(target_os = "android"))]
      cache::write_cache,
      tts::tts,
      #[cfg(not(target_os = "android"))]
      whisper_setup::import_tools,
      #[cfg(not(target_os = "android"))]
      gpus::list_gpus,
      #[cfg(not(target_os = "android"))]
      whisper_setup::transcribe_location,
      ja_dict::ja_dict_status,
      ja_dict::install_ja_dict,
      ja_dict::remove_ja_dict,
      #[cfg(not(target_os = "android"))]
      convert::convert_tool_status,
      #[cfg(not(target_os = "android"))]
      convert::install_convert_tool,
      #[cfg(not(target_os = "android"))]
      convert::probe_video,
      #[cfg(not(target_os = "android"))]
      clips::cut_clip,
      #[cfg(not(target_os = "android"))]
      clips::sweep_clips,
      #[cfg(not(target_os = "android"))]
      clips::clips_info,
      #[cfg(not(target_os = "android"))]
      backup::backup_write,
      #[cfg(not(target_os = "android"))]
      backup::backup_stage,
      #[cfg(not(target_os = "android"))]
      backup::backup_list,
      #[cfg(not(target_os = "android"))]
      backup::backup_read,
      #[cfg(not(target_os = "android"))]
      backup::backup_unpack,
      #[cfg(not(target_os = "android"))]
      backup::backup_kept_clips,
      #[cfg(not(target_os = "android"))]
      backup::backup_remove,
      #[cfg(not(target_os = "android"))]
      device::device_info,
      dicts::dict_list,
      dicts::dict_check,
      dicts::dict_import,
      dicts::dict_download,
      dicts::dict_update,
      dicts::dict_move,
      dicts::dict_remove,
      dicts::dict_lookup,
      vocab::commands::sync_begin,
      vocab::commands::sync_collect,
      vocab::commands::sync_ack,
      vocab::commands::sync_apply,
      vocab::commands::sync_finish,
      vocab::commands::sync_status,
      vocab::commands::sync_reset,
      vocab::commands::vocab_library_export,
      vocab::commands::vocab_library_preview,
      vocab::commands::vocab_library_import,
      vocab::commands::vocab_import,
      vocab::commands::vocab_import_preview,
      vocab::commands::vocab_definition_preview,
      vocab::commands::vocab_definition_import,
      vocab::commands::vocab_errors_import_preview,
      vocab::commands::vocab_errors_import,
      vocab::commands::vocab_stats,
      vocab::commands::vocab_browse,
      vocab::commands::vocab_coach_browse,
      vocab::commands::vocab_coach_archive_preview,
      vocab::commands::vocab_coach_archive,
      wordpack::wordpack_info,
      wordpack::wordpack_list,
      wordpack::wordpack_lookup,
      wordpack::wordpack_band,
      wordpack::wordpack_license,
      vocab::commands::vocab_review_submit,
      vocab::commands::vocab_review_event,
      vocab::commands::vocab_review_flagged,
      vocab::commands::vocab_review_metadata_update,
      vocab::commands::vocab_inbox_confirm,
      vocab::commands::vocab_manual_add,
      vocab::commands::vocab_export,
      vocab::commands::vocab_notes,
      vocab::commands::vocab_note_add,
      vocab::commands::vocab_note_update,
      vocab::commands::vocab_note_delete,
      vocab::commands::vocab_examples,
      vocab::commands::vocab_example_add,
      vocab::commands::vocab_example_delete,
      vocab::commands::vocab_definitions_en,
      vocab::commands::vocab_definition_en_add,
      vocab::commands::vocab_definition_en_update,
      vocab::commands::vocab_definition_en_delete,
      vocab::commands::vocab_scenes,
      vocab::commands::quicknote_list,
      vocab::commands::quicknote_add,
      vocab::commands::quicknote_update,
      vocab::commands::quicknote_mark,
      vocab::commands::quicknote_delete,
      vocab::commands::vocab_scene_set,
      vocab::commands::wordpack_pick_list,
      vocab::commands::wordpack_pick_set,
      vocab::commands::wordpack_pick_take,
      vocab::commands::wordpack_pick_clear_known,
      vocab::commands::wordpack_pick_undo,
      vocab::commands::daily_plan_get,
      vocab::commands::daily_plan_set,
      #[cfg(not(target_os = "android"))]
      trash_file
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[cfg(not(target_os = "android"))]
// Move a file to the Trash / Recycle Bin (recoverable), with the system's own tool.
#[tauri::command]
fn trash_file(path: String) -> Result<(), String> {
  if !std::path::Path::new(&path).is_file() {
    return Err("not a file".into());
  }
  #[cfg(not(windows))]
  let out = paths::command("/usr/bin/trash").arg(&path).output();
  // The path travels in an env var, never spliced into the script. USB sticks and
  // network shares have no Recycle Bin: there DeleteFile would delete for good,
  // so only a local fixed drive goes ahead (a network path throws, which fails too).
  #[cfg(windows)]
  let out = paths::command("powershell")
    .args([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$d = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($env:LC_TRASH_PATH)); if ($d.DriveType -ne 'Fixed') { [Console]::Error.Write('no recycle bin on this drive'); exit 3 }; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:LC_TRASH_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    ])
    .env("LC_TRASH_PATH", &path)
    .output();
  let out = out.map_err(|e| e.to_string())?;
  if out.status.success() {
    Ok(())
  } else {
    Err(String::from_utf8_lossy(&out.stderr).into_owned())
  }
}
