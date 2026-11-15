use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
#[cfg(not(target_os = "android"))]
use std::{fs::File, path::Path};
#[cfg(not(target_os = "android"))]
use tauri::path::BaseDirectory;
use tauri::AppHandle;
#[cfg(not(target_os = "android"))]
use tauri::Manager;

#[cfg(not(target_os = "android"))]
const RESOURCE: &str = "wordpack/wordpack.json.gz";
static WORDPACK: OnceLock<Result<Wordpack, String>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
  pub word: String,
  pub phonetic: String,
  pub pos: String,
  pub zh: String,
  pub en: String,
  pub frq: Option<u32>,
  pub bnc: Option<u32>,
  pub tags: Vec<String>,
  pub exchange: String,
}

#[derive(Debug, Deserialize)]
struct Payload {
  version: u32,
  entries: Vec<Entry>,
}

struct Wordpack {
  version: u32,
  entries: Vec<Entry>,
  exact: HashMap<String, usize>,
  roots: HashMap<String, String>,
  tag_counts: HashMap<String, usize>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordpackInfo {
  pub version: u32,
  pub word_count: usize,
  pub tag_counts: HashMap<String, usize>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListOptions {
  #[serde(default)]
  pub exclude: Vec<String>,
  pub offset: Option<usize>,
  pub limit: Option<usize>,
}

impl Wordpack {
  #[cfg(any(test, target_os = "android"))]
  fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
    let mut decoder = GzDecoder::new(bytes);
    let mut json = Vec::new();
    decoder.read_to_end(&mut json).map_err(|e| format!("读取内置词表失败：{e}"))?;
    let payload: Payload = serde_json::from_slice(&json).map_err(|e| format!("解析内置词表失败：{e}"))?;
    Self::from_payload(payload)
  }

  fn from_payload(payload: Payload) -> Result<Self, String> {
    let mut exact = HashMap::new();
    let mut roots = HashMap::new();
    let mut tag_counts = HashMap::new();
    for (index, entry) in payload.entries.iter().enumerate() {
      let word = normalize(&entry.word);
      exact.insert(word.clone(), index);
      let root = entry.exchange.split('/')
        .find_map(|part| part.strip_prefix("0:"))
        .filter(|value| !value.is_empty())
        .unwrap_or(&entry.word)
        .to_lowercase();
      roots.entry(word).or_insert_with(|| root.clone());
      for part in entry.exchange.split('/') {
        let Some((kind, form)) = part.split_once(':') else { continue };
        if !form.trim().is_empty() && (kind == "0" || !kind.chars().all(|c| c.is_ascii_digit())) {
          roots.entry(normalize(form)).or_insert_with(|| root.clone());
        }
      }
      for tag in &entry.tags { *tag_counts.entry(tag.clone()).or_insert(0) += 1; }
    }
    Ok(Self { version: payload.version, entries: payload.entries, exact, roots, tag_counts })
  }

  fn lookup(&self, word: &str) -> Option<&Entry> {
    let key = normalize(word);
    let root = self.roots.get(&key).map(String::as_str).unwrap_or(&key);
    self.exact.get(root).or_else(|| self.exact.get(&key)).map(|index| &self.entries[*index])
  }

  fn list(&self, tags: &[String], options: &ListOptions) -> Vec<Entry> {
    let selected: HashSet<String> = tags.iter().map(|tag| normalize(tag)).collect();
    let excluded: HashSet<String> = options.exclude.iter().map(|word| normalize(word)).collect();
    let mut matches: Vec<&Entry> = self.entries.iter().filter(|entry| {
      !excluded.contains(&normalize(&entry.word))
        && (selected.is_empty() || entry.tags.iter().any(|tag| selected.contains(&normalize(tag))))
    }).collect();
    matches.sort_by(|a, b| frequency(a).cmp(&frequency(b)).then_with(|| a.word.cmp(&b.word)));
    let start = options.offset.unwrap_or(0).min(matches.len());
    let end = start.saturating_add(options.limit.unwrap_or(matches.len())).min(matches.len());
    matches[start..end].iter().map(|entry| (*entry).clone()).collect()
  }

  fn band(&self, rank_from: u32, rank_to: u32, count: usize, seed: Option<u64>) -> Vec<Entry> {
    let low = rank_from.min(rank_to);
    let high = rank_from.max(rank_to);
    let mut candidates: Vec<&Entry> = self.entries.iter()
      .filter(|entry| entry.frq.is_some_and(|rank| rank >= low && rank <= high))
      .collect();
    let mut state = seed.unwrap_or_else(random_seed).max(1);
    for i in (1..candidates.len()).rev() {
      state ^= state << 13;
      state ^= state >> 7;
      state ^= state << 17;
      candidates.swap(i, (state as usize) % (i + 1));
    }
    candidates.into_iter().take(count).cloned().collect()
  }
}

fn normalize(word: &str) -> String { word.trim().to_lowercase() }
fn frequency(entry: &Entry) -> u32 { entry.frq.or(entry.bnc).unwrap_or(u32::MAX) }
fn random_seed() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos() as u64
    ^ u64::from(std::process::id())
}

#[cfg(not(target_os = "android"))]
fn load_file(path: &Path) -> Result<Wordpack, String> {
  let file = File::open(path).map_err(|e| format!("找不到内置词表 {}：{e}", path.display()))?;
  let mut decoder = GzDecoder::new(file);
  let mut json = Vec::new();
  decoder.read_to_end(&mut json).map_err(|e| format!("解压内置词表失败：{e}"))?;
  let payload: Payload = serde_json::from_slice(&json).map_err(|e| format!("解析内置词表失败：{e}"))?;
  Wordpack::from_payload(payload)
}

#[cfg(target_os = "android")]
fn load_wordpack(_app: &AppHandle) -> Result<Wordpack, String> {
  Wordpack::from_bytes(include_bytes!("../resources/wordpack/wordpack.json.gz"))
}

#[cfg(not(target_os = "android"))]
fn load_wordpack(app: &AppHandle) -> Result<Wordpack, String> {
  let path = app.path().resolve(RESOURCE, BaseDirectory::Resource)
    .map_err(|e| format!("定位内置词表失败：{e}"))?;
  load_file(&path)
}

fn wordpack(app: &AppHandle) -> Result<&'static Wordpack, String> {
  WORDPACK.get_or_init(|| load_wordpack(app)).as_ref().map_err(Clone::clone)
}

#[tauri::command]
pub fn wordpack_info(app: AppHandle) -> Result<WordpackInfo, String> {
  let data = wordpack(&app)?;
  Ok(WordpackInfo { version: data.version, word_count: data.entries.len(), tag_counts: data.tag_counts.clone() })
}

#[tauri::command]
pub fn wordpack_list(app: AppHandle, tags: Vec<String>, options: Option<ListOptions>) -> Result<Vec<Entry>, String> {
  Ok(wordpack(&app)?.list(&tags, &options.unwrap_or_default()))
}

#[tauri::command]
pub fn wordpack_lookup(app: AppHandle, word: String) -> Result<Option<Entry>, String> {
  Ok(wordpack(&app)?.lookup(&word).cloned())
}

#[tauri::command]
pub fn wordpack_band(app: AppHandle, rank_from: u32, rank_to: u32, n: usize, seed: Option<u64>) -> Result<Vec<Entry>, String> {
  Ok(wordpack(&app)?.band(rank_from, rank_to, n, seed))
}

#[tauri::command]
pub fn wordpack_license() -> &'static str { include_str!("../resources/wordpack/LICENSE-DATA.md") }

#[cfg(test)]
mod tests {
  use super::*;

  fn sample() -> Wordpack {
    Wordpack::from_bytes(include_bytes!("../resources/wordpack/wordpack.json.gz")).unwrap()
  }

  #[test]
  fn lookup_form_returns_lemma() {
    let data = sample();
    assert_eq!(data.lookup("running").unwrap().word, "run");
    let abandon = data.lookup("abandon").unwrap();
    assert!(!abandon.phonetic.is_empty());
    assert!(!abandon.zh.is_empty());
    assert!(abandon.tags.iter().any(|tag| tag == "cet4"));
  }

  #[test]
  fn lists_are_sorted_filtered_and_paged() {
    let data = sample();
    let full = data.list(&["cet4".into()], &ListOptions::default());
    assert!(full.windows(2).all(|pair| frequency(&pair[0]) <= frequency(&pair[1])));
    let options = ListOptions { exclude: vec![full[0].word.clone()], offset: Some(1), limit: Some(3) };
    let page = data.list(&["cet4".into()], &options);
    assert_eq!(page.len(), 3);
    assert!(!page.iter().any(|entry| entry.word == full[0].word));
    assert_eq!(page[0].word, full[2].word);
  }

  #[test]
  fn seeded_band_is_repeatable() {
    let data = sample();
    let first: Vec<String> = data.band(1, 500, 12, Some(42)).into_iter().map(|entry| entry.word).collect();
    let second: Vec<String> = data.band(1, 500, 12, Some(42)).into_iter().map(|entry| entry.word).collect();
    assert_eq!(first, second);
  }

  #[test]
  fn ngsl_and_nawl_entries_have_their_tags() {
    let data = sample();
    for tag in ["ngsl", "nawl"] {
      let found = data.list(&[tag.into()], &ListOptions { limit: Some(5), ..Default::default() });
      assert_eq!(found.len(), 5);
      assert!(found.iter().all(|entry| entry.tags.iter().any(|value| value == tag)));
    }
  }
}
