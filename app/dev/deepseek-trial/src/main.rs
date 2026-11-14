use std::path::Path;

// decode.rs 只在应用里需要这个取消检查；实测工具没有应用队列，因此用空实现。
mod import_queue {
    pub fn check() -> Result<(), String> { Ok(()) }
}

#[path = "../../../src-tauri/src/decode.rs"]
mod app_decode;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("用法：deepseek-trial-audio <输入音频> <输出 WAV>");
        std::process::exit(2);
    }
    if let Err(error) = app_decode::to_wav(Path::new(&args[1]), Path::new(&args[2])) {
        // 输出只可能是本机解码错误，不包含 API 密钥。
        eprintln!("音频解码失败：{error}");
        std::process::exit(1);
    }
}
