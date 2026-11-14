// Where our files live and how helper programs are started, per OS.
use std::ffi::OsStr;
use std::path::PathBuf;
use std::process::Command;

// This app's own names. APP_ID must equal `identifier` in tauri.conf.json: it is
// where Tauri puts the WebView2 profile, so helper programs and caches sit beside
// it and a dev build can never write into another install's directory.
pub const APP_ID: &str = "com.englishstudio.app";
// Folder name for our media: ~/Movies/english-studio, ~/Videos/english-studio.
// Deliberately not "LinguaClip" — that folder belongs to the app we forked from.
pub const APP_DIR: &str = "english-studio";

pub fn home_dir() -> Result<PathBuf, String> {
  let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
  std::env::var_os(var)
    .map(PathBuf::from)
    .ok_or_else(|| "missing:HOME".to_string())
}

// %LOCALAPPDATA%\com.englishstudio.app on Windows, ~/Library/Application Support/
// com.englishstudio.app on macOS: whisper parts, the ffmpeg converter, dictionaries.
#[cfg(target_os = "android")]
pub fn app_data_dir() -> PathBuf {
  // 安卓没有桌面环境变量；这个目录由系统分给本应用，首次启动可以直接建库。
  PathBuf::from("/data/user/0").join(APP_ID).join("files")
}

#[cfg(not(target_os = "android"))]
pub fn app_data_dir() -> PathBuf {
  if cfg!(windows) {
    std::env::var_os("LOCALAPPDATA")
      .map(PathBuf::from)
      .unwrap_or_else(|| home_dir().unwrap_or_default().join("AppData/Local"))
      .join(APP_ID)
  } else {
    home_dir().unwrap_or_default().join("Library/Application Support").join(APP_ID)
  }
}

// ~/Movies/english-studio on macOS, ~/Videos/english-studio on Windows: downloads,
// generated .srt files and caches. `ownDir` in utils/desktop.ts must agree.
pub fn own_dir() -> Result<PathBuf, String> {
  let videos = if cfg!(windows) { "Videos" } else { "Movies" };
  Ok(home_dir()?.join(videos).join(APP_DIR))
}

// Every helper program goes through here so that on Windows it does not flash
// a console window.
pub fn command(program: impl AsRef<OsStr>) -> Command {
  #[allow(unused_mut)]
  let mut cmd = Command::new(program);
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
  }
  cmd
}

#[cfg(test)]
mod tests {
  // A dev build must never write into the folder of the app we forked from.
  #[test]
  fn own_dir_is_this_apps_folder() {
    let dir = super::own_dir().unwrap();
    assert_eq!(dir.file_name().and_then(|n| n.to_str()), Some(super::APP_DIR));
    assert!(
      !dir.to_string_lossy().to_ascii_lowercase().contains("linguaclip"),
      "own_dir still points at the fork's media folder: {dir:?}"
    );
  }

  #[test]
  fn app_data_dir_follows_the_identifier() {
    let dir = super::app_data_dir();
    assert_eq!(dir.file_name().and_then(|n| n.to_str()), Some(super::APP_ID));
    assert!(
      !dir.to_string_lossy().to_ascii_lowercase().contains("linguaclip"),
      "app_data_dir still points at the fork's data folder: {dir:?}"
    );
  }
}
