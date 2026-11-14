#!/usr/bin/env node
// DeepSeek ASR / OCR + 挑词 / TTS 实测。密钥只从 D:\tmp\es-keys\deepseek.env 读，绝不写入输出。
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { retryFailedAsrSegments } from './asrReliability.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const APP = path.join(ROOT, 'app');
const AUDIO = 'D:/tmp/es-test/deepseek/audio';
const NOTES = 'D:/tmp/es-test/deepseek/notes/9.22.pdf';
const OUT = 'D:/tmp/es-test/deepseek/out';
const KEY_FILE = 'D:/tmp/es-keys/deepseek.env';
const MP3 = path.join(AUDIO, 'learning-from-different-generations.mp3');
const TRANSCRIPT_PDF = path.join(AUDIO, 'official-transcript.pdf');
const BASE = 'https://api.deepseek.com';
let pricingPeak = false;
const AUDIO_RATE = 0.058 / 3600; // 官方 ASR 限时半价；同时报告标准价（双倍）。
const OCR_RATE = 0.225 / 1000;
const CHECKPOINT = path.join(OUT, 'trial-partial.json');
const VERIFY_CHECKPOINT = path.join(OUT, 'verify-partial.json');
const VOICES = ['stella', 'tide'];
const EXAMPLES = [
  'Intergenerational projects can help fill a void.',
  'Clear notes make it easier to learn new vocabulary.',
];
const INBOX_PROMPT = `请识别这页笔记图片里的英文词目和对应备注。笔记里可能有中文释义、例句、划线和箭头，只提取英文词目/短语和它旁边的备注。只返回一个 JSON 对象，不要用 Markdown 代码块，格式严格为：
{"words":[{"word":"词目","note":"备注","uncertain":false}]}
每个条目都必须有 word、note、uncertain 三个字段；没有备注时 note 用空字符串。看不清或拿不准时 uncertain 用 true，不要猜成确定结果。没有识别到词条时返回 {"words":[]}。`;
const OCR_PICK_PROMPT = INBOX_PROMPT.replace('请识别这页笔记图片里的英文词目和对应备注。', '请从这段 OCR 文字里挑词，并提取英文词目和对应备注。');

await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(path.join(OUT, 'tts'), { recursive: true });

const readKey = async () => {
  const source = (await fs.readFile(KEY_FILE, 'utf8')).replace(/^\uFEFF/, '');
  const match = source.match(/^DEEPSEEK_API_KEY=(.+)\s*$/m);
  if (!match) throw new Error('指定的密钥文件里没有 DEEPSEEK_API_KEY。');
  return match[1].trim();
};

const safeApi = async (url, init, binary = false) => {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(600_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (binary) return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') || '' };
    let body;
    if (/event-stream/i.test(response.headers.get('content-type') || '')) {
      const raw = await response.text();
      let content = '', usage = null;
      for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const event = JSON.parse(data);
          const choice = event.choices?.[0];
          if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
          if (typeof choice?.message?.content === 'string') content += choice.message.content;
          if (event.usage) usage = event.usage;
          if (event.error) throw new Error('API 返回流式错误。');
        } catch (error) {
          if (error instanceof Error && error.message === 'API 返回流式错误。') throw error;
        }
      }
      body = { choices: [{ message: { content } }], usage };
    } else {
      body = await response.json();
    }
    if (body?.error) throw new Error(`API 返回错误（${body.error.type || 'unknown'}）`);
    return body;
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知网络错误';
    // 不打印异常原文/请求头/响应体，避免服务端把密钥回显时泄漏。
    if (/^HTTP \d+$/.test(message) || message.startsWith('API 返回错误')) throw error;
    const code = error && typeof error === 'object' ? (error.cause?.code || error.name) : 'unknown';
    throw new Error(`网络请求失败（${String(code).replace(/[^A-Z0-9_]/gi, '').slice(0, 40) || 'unknown'}）`);
  }
};

const loadModels = async key => {
  const body = await safeApi(`${BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
  const models = (body.data || []).map(row => row.id).filter(Boolean).sort();
  if (!models.length) throw new Error('GET /models 没有返回模型。');
  return models;
};

const compileAndDecode = async () => {
  const wav = path.join(OUT, 'episode-16k-mono.wav');
  const env = { ...process.env, CARGO_TARGET_DIR: 'E:/rust/target' };
  delete env.CFLAGS;
  const cargo = process.env.CARGO_HOME ? path.join(process.env.CARGO_HOME, 'bin', 'cargo.exe') : 'cargo';
  const build = spawnSync(cargo, ['run', '--quiet', '--manifest-path', path.join(HERE, 'Cargo.toml'), '--', MP3, wav], {
    cwd: ROOT, env, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
  });
  if (build.status !== 0) {
    const details = (build.stderr || '').split(/\r?\n/).filter(Boolean).slice(-8).join(' | ');
    throw new Error(`复用应用音频解码器失败：${details || 'cargo 退出码非 0'}`);
  }
  const bytes = await fs.readFile(wav);
  const info = wavInfo(bytes);
  if (info.rate !== 16000 || info.channels !== 1 || info.bits !== 16) throw new Error('解码结果不是 16kHz 单声道 16-bit WAV。');
  return { wav, bytes, info };
};

function wavInfo(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('WAV 头不合法。');
  let offset = 12, channels, rate, bits, dataOffset, dataBytes;
  while (offset + 8 <= bytes.length) {
    const name = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (name === 'fmt ') { channels = bytes.readUInt16LE(offset + 10); rate = bytes.readUInt32LE(offset + 12); bits = bytes.readUInt16LE(offset + 22); }
    if (name === 'data') { dataOffset = offset + 8; dataBytes = size; break; }
    offset += 8 + size + (size & 1);
  }
  if (!dataOffset || !channels || !rate || !bits) throw new Error('WAV 缺少格式或音频数据。');
  return { channels, rate, bits, dataOffset, dataBytes, duration: dataBytes / (channels * bits / 8 * rate) };
}

const normalizeWavHeader = input => {
  const bytes = Buffer.from(input);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('TTS 未返回 RIFF/WAVE 音频。');
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    if (id === 'data') {
      bytes.writeUInt32LE(bytes.length - offset - 8, offset + 4);
      bytes.writeUInt32LE(bytes.length - 8, 4);
      return bytes;
    }
    const size = bytes.readUInt32LE(offset + 4);
    if (size === 0xffffffff) throw new Error('TTS WAV 音频块长度不完整。');
    offset += 8 + size + (size & 1);
  }
  throw new Error('TTS WAV 缺少 data 音频块。');
};

const makeSlice = (audio, start, end) => {
  const { bytes, info } = audio;
  const stride = info.channels * info.bits / 8;
  const from = Math.floor(start * info.rate) * stride;
  const to = Math.min(info.dataBytes, Math.floor(end * info.rate) * stride);
  const pcm = bytes.subarray(info.dataOffset + from, info.dataOffset + to);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(info.channels, 22); header.writeUInt32LE(info.rate, 24);
  header.writeUInt32LE(info.rate * stride, 28); header.writeUInt16LE(stride, 32); header.writeUInt16LE(info.bits, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};

const segmentBySilence = (audio, limit = audio.info.duration) => {
  const { bytes, info } = audio;
  const maxEnd = Math.min(info.duration, limit);
  const frameSamples = Math.round(info.rate * 0.02);
  const energies = [];
  const sampleCount = Math.floor(info.dataBytes / 2);
  for (let start = 0; start < sampleCount; start += frameSamples) {
    const stop = Math.min(sampleCount, start + frameSamples);
    let sum = 0;
    for (let i = start; i < stop; i++) { const value = bytes.readInt16LE(info.dataOffset + i * 2) / 32768; sum += value * value; }
    energies.push({ time: start / info.rate, rms: Math.sqrt(sum / (stop - start)) });
  }
  const threshold = 10 ** (-38 / 20); // RMS −38 dBFS；静音至少 240 ms。
  const runs = [];
  let runStart = -1;
  for (let i = 0; i <= energies.length; i++) {
    const quiet = i < energies.length && energies[i].rms <= threshold;
    if (quiet && runStart < 0) runStart = i;
    if (!quiet && runStart >= 0) {
      if (i - runStart >= 12) runs.push({ start: energies[runStart].time, end: energies[i - 1].time + 0.02 });
      runStart = -1;
    }
  }
  const segments = [];
  let cursor = 0;
  while (maxEnd - cursor > 0.05) {
    const final = maxEnd - cursor <= 20;
    const target = Math.min(maxEnd, cursor + 18);
    if (final) { segments.push({ start: cursor, end: maxEnd, cut: '尾段' }); break; }
    const minCut = cursor + 12;
    const maxCut = Math.min(maxEnd, cursor + 20);
    const quiet = runs.filter(run => run.end >= minCut && run.start <= maxCut)
      .map(run => ({ at: (run.start + run.end) / 2, run }))
      .sort((a, b) => Math.abs(a.at - target) - Math.abs(b.at - target))[0];
    let cut, kind;
    if (quiet) { cut = quiet.at; kind = '静音'; }
    else {
      const nearby = energies.filter(row => row.time >= target - 1.2 && row.time <= target + 1.2 && row.time > cursor + 1);
      cut = nearby.sort((a, b) => a.rms - b.rms)[0]?.time ?? target;
      kind = '低能量兜底';
    }
    cut = Math.max(minCut, Math.min(maxCut, cut));
    segments.push({ start: cursor, end: cut, cut: kind });
    cursor = cut;
  }
  return { segments, thresholdDb: -38, frameMs: 20, minSilenceMs: 240, targetSeconds: 18, maxSeconds: 20 };
};

const commonOpeningWords = (recognized, expected) => {
  // 只比较短片段开头：允许识别漏掉/替换个别词，但匹配词必须按原顺序出现。
  const left = normalizeWords(recognized).slice(0, 12);
  const right = normalizeWords(expected).slice(0, 20);
  let previous = new Uint8Array(right.length + 1);
  for (const word of left) {
    const current = new Uint8Array(right.length + 1);
    for (let j = 1; j <= right.length; j++) {
      current[j] = word === right[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  return previous[right.length];
};

const mapLimit = async (items, concurrency, worker) => {
  let next = 0;
  const output = Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try { output[index] = await worker(items[index], index); }
      catch (error) { output[index] = { error: error instanceof Error ? error.message : '未知错误' }; }
    }
  }));
  return output;
};

const asrRequest = async (key, segment) => {
  const form = new FormData();
  form.append('file', new Blob([segment.wav], { type: 'audio/wav' }), 'speech.wav');
  const began = performance.now();
  const body = await safeApi(`${BASE}/v1/tools/asr`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  return { text: body.text || '', durationMs: body.duration_ms, elapsedMs: Math.round(performance.now() - began) };
};

const runAsrSet = async (key, segments, concurrency, label) => {
  console.log(`${label}：${segments.length} 段，并发 ${concurrency}`);
  const started = performance.now();
  const results = await mapLimit(segments, concurrency, async (segment, index) => {
    try {
      const result = await asrRequest(key, { wav: makeSlice(segment.audio, segment.start, segment.end) });
      return { start: segment.start, end: segment.end, cut: segment.cut, ...result };
    } catch (error) {
      return { start: segment.start, end: segment.end, cut: segment.cut,
        error: error instanceof Error ? error.message : '未知错误' };
    }
  });
  const succeeded = results.filter(row => !row.error);
  return {
    segments: results,
    text: succeeded.map(row => row.text).join(' ').trim(),
    requests: results.length,
    failures: results.filter(row => row.error).map(row => row.error),
    elapsedMs: results.reduce((sum, row) => sum + (row.elapsedMs || 0), 0),
    wallMs: Math.round(performance.now() - started),
  };
};

const ensureAsrRun = async (key, existing, segments, concurrency, label) => {
  const run = existing || await runAsrSet(key, segments, concurrency, label);
  return retryFailedAsrSegments(run, segments, concurrency, async segment =>
    asrRequest(key, { wav: makeSlice(segment.audio, segment.start, segment.end) }));
};

const normalizeWords = text => (text.toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)?/gu) || []);
const clipToEpisode = (reference, hypothesis) => {
  // RSS 音频含播客广告；用双方共同的节目开场和结束语限定正文，同时另报全文件原始 WER。
  const startPhrase = 'so georgie do you often spend time with people';
  const endPhrase = 'thanks for joining us and goodbye';
  const clip = text => {
    const words = normalizeWords(text);
    const joined = words.join(' ');
    const start = joined.indexOf(startPhrase);
    if (start < 0) return { text, startFound: false, endFound: false };
    const startWord = joined.slice(0, start).trim().split(/\s+/).filter(Boolean).length;
    const rest = words.slice(startWord);
    const restText = rest.join(' ');
    const end = restText.indexOf(endPhrase);
    const count = end < 0 ? rest.length : restText.slice(0, end + endPhrase.length).split(' ').length;
    return { text: rest.slice(0, count).join(' '), startFound: true, endFound: end >= 0 };
  };
  const ref = clip(reference), hyp = clip(hypothesis);
  return { reference: ref.text, hypothesis: hyp.text,
    markers: { referenceStartFound: ref.startFound, referenceEndFound: ref.endFound,
      hypothesisStartFound: hyp.startFound, hypothesisEndFound: hyp.endFound } };
};
const wer = (reference, hypothesis) => {
  const a = normalizeWords(reference), b = normalizeWords(hypothesis);
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  const back = Array.from({ length: a.length + 1 }, () => new Uint8Array(b.length + 1));
  for (let i = 0; i <= a.length; i++) { dp[i][0] = i; if (i) back[i][0] = 1; }
  for (let j = 0; j <= b.length; j++) { dp[0][j] = j; if (j) back[0][j] = 2; }
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    const same = a[i - 1] === b[j - 1];
    const choices = [dp[i - 1][j - 1] + (same ? 0 : 1), dp[i - 1][j] + 1, dp[i][j - 1] + 1];
    let index = choices.indexOf(Math.min(...choices)); dp[i][j] = choices[index]; back[i][j] = index;
  }
  const errors = []; let i = a.length, j = b.length;
  while (i || j) {
    const move = back[i][j];
    if (i && j && move === 0) { if (a[i - 1] !== b[j - 1]) errors.push({ type: '替换', reference: a[i - 1], recognized: b[j - 1] }); i--; j--; }
    else if (i && (!j || move === 1)) { errors.push({ type: '漏词', reference: a[i - 1], recognized: '∅' }); i--; }
    else { errors.push({ type: '多词', reference: '∅', recognized: b[j - 1] }); j--; }
  }
  errors.reverse();
  const edits = dp[a.length][b.length];
  const examples = errors.length <= 10 ? errors : Array.from({ length: 10 }, (_, index) =>
    errors[Math.round(index * (errors.length - 1) / 9)]);
  return { referenceWords: a.length, hypothesisWords: b.length, substitutions: errors.filter(e => e.type === '替换').length,
    deletions: errors.filter(e => e.type === '漏词').length, insertions: errors.filter(e => e.type === '多词').length,
    edits, wer: a.length ? edits / a.length : null, examples };
};

const extractPdfPages = async (file, renderTo = null, maxEdge = 2000) => {
  const require = createRequire(path.join(APP, 'package.json'));
  const canvasLib = require('@napi-rs/canvas');
  globalThis.DOMMatrix ||= canvasLib.DOMMatrix;
  globalThis.ImageData ||= canvasLib.ImageData;
  globalThis.Path2D ||= canvasLib.Path2D;
  const pdfjs = await import(pathToFileURL(path.join(APP, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')));
  const data = new Uint8Array(await fs.readFile(file));
  const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true });
  const pdf = await loadingTask.promise;
  const pages = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const page = await pdf.getPage(number);
    const text = await page.getTextContent();
    const base = page.getViewport({ scale: 1 });
    const scale = maxEdge / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale });
    pages.push({ number, width: Math.ceil(viewport.width), height: Math.ceil(viewport.height),
      items: text.items.filter(item => 'str' in item).map(item => item.str).filter(Boolean) });
    if (renderTo) {
      const canvas = canvasLib.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      await fs.writeFile(path.join(renderTo, `notes-page-${number}.jpg`), canvas.toBuffer('image/jpeg', 85));
    }
    page.cleanup();
  }
  await loadingTask.destroy();
  return pages;
};

const groupPdfLines = async file => {
  const require = createRequire(path.join(APP, 'package.json'));
  const pdfjs = await import(pathToFileURL(path.join(APP, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')));
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(file)), useSystemFonts: true });
  const pdf = await loadingTask.promise;
  const lines = [];
  for (let number = 1; number <= Math.min(pdf.numPages, 5); number++) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    const rows = new Map();
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const y = Math.round(item.transform?.[5] ?? 0);
      const row = rows.get(y) || [];
      row.push(item.str.trim()); rows.set(y, row);
    }
    for (const [, row] of [...rows].sort((a, b) => b[0] - a[0])) {
      const line = row.join(' ').replace(/\s+/g, ' ').trim();
      if (!line || /^Phil$|^Georgie$|^Myra Anubi$|^Ian$|^Liz Ludden$/i.test(line)) continue;
      if (/6 Minute English|©British Broadcasting|bbclearningenglish\.com|Page \d+ of \d+/i.test(line)) continue;
      if (/^(BBC LEARNING ENGLISH|Learning from different|generations|This is not a word-for-word transcript\.)$/i.test(line)) continue;
      lines.push(line);
    }
    page.cleanup();
  }
  await loadingTask.destroy();
  return lines.join(' ');
};

const ocrRequest = async (key, bytes, filename, purpose) => {
  const form = new FormData();
  form.append('file', new Blob([bytes]), filename);
  form.append('purpose', purpose);
  const began = performance.now();
  const body = await safeApi(`${BASE}/v1/tools/ocr`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  return { pages: body.pages || [], pageCount: body.page_count, usage: body.usage || null, elapsedMs: Math.round(performance.now() - began) };
};

const pickWords = async (key, model, prompt, content, image = null) => {
  const userContent = image ? [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.toString('base64')}` } },
  ] : `${prompt}\n\nOCR 原文：\n${content}`;
  const began = performance.now();
  const attempt = stream => safeApi(`${BASE}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0, ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      messages: [{ role: 'user', content: userContent }] }),
  });
  let body, transport = 'stream';
  try {
    body = await attempt(true);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const status = Number(message.match(/^HTTP (\d+)$/)?.[1] || 0);
    if (status && ![400, 404, 405, 415, 422, 501].includes(status)) throw error;
    transport = 'nonstream-fallback';
    body = await attempt(false);
  }
  const text = body.choices?.[0]?.message?.content;
  let parsed;
  try {
    const cleaned = String(text || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/gi, '').trim();
    parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed.words)) throw new Error();
    parsed.words = parsed.words.map(row => ({ word: String(row.word || '').trim(), note: String(row.note || '').trim(), uncertain: Boolean(row.uncertain) }));
  } catch { throw new Error('挑词模型返回的 JSON 不合格式。'); }
  return { words: parsed.words, usage: body.usage || null, elapsedMs: Math.round(performance.now() - began), transport };
};

const usageCost = usage => {
  if (!usage) return { usd: 0, missing: true };
  const hit = usage.prompt_cache_hit_tokens || 0;
  const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens || 0) - hit);
  const output = usage.completion_tokens || 0;
  const peak = pricingPeak;
  return { usd: (hit * (peak ? 0.006 : 0.003) + miss * (peak ? 0.3 : 0.15) + output * (peak ? 1.2 : 0.6)) / 1_000_000,
    hitTokens: hit, missTokens: miss, outputTokens: output, missing: false };
};

function isPeakHour(date) {
  const day = date.getUTCDay(), hour = date.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

const wordsCompare = (oldWords, newWords) => {
  const a = new Map(oldWords.map(row => [row.word.toLowerCase(), row]));
  const b = new Map(newWords.map(row => [row.word.toLowerCase(), row]));
  return {
    both: [...a.keys()].filter(word => b.has(word)).map(word => ({ old: a.get(word), new: b.get(word) })),
    onlyOld: [...a.keys()].filter(word => !b.has(word)).map(word => a.get(word)),
    onlyNew: [...b.keys()].filter(word => !a.has(word)).map(word => b.get(word)),
  };
};

const imageBlobs = async pages => Promise.all(pages.map(async page => ({
  number: page.number,
  bytes: await fs.readFile(path.join(OUT, `notes-page-${page.number}.jpg`)),
})));

const runNotes = async (key, model, mode = 'full', onChange = async () => {}, existing = null, refreshPicks = false) => {
  const notePdf = await fs.readFile(NOTES);
  const contentPages = mode === 'verify' ? [2] : [2, 3];
  const pages = await extractPdfPages(NOTES, OUT);
  const pageImages = await imageBlobs(pages.filter(page => contentPages.includes(page.number)));
  const state = existing || { notePages: pages.length, pagesCompared: contentPages, directPdfOcr: null, richLayout: null,
    picked: { old: {}, new: {}, perPage: {} } };
  state.notePages = pages.length;
  state.renderedPages = pages.map(({ number, width, height }) => ({ number, width, height }));
  state.pagesCompared = contentPages;
  state.picked ||= { old: {}, new: {}, perPage: {} };
  state.picked.old ||= {}; state.picked.new ||= {}; state.picked.perPage ||= {};
  if (!state.directPdfOcr) {
    console.log(`笔记：原 PDF 共 ${pages.length} 页；比较第 ${contentPages.join('、')} 页。直接整份 PDF OCR 开始`);
    const directStarted = performance.now();
    state.directPdfOcr = await ocrRequest(key, notePdf, path.basename(NOTES), 'text_recognition');
    state.directPdfOcr.elapsedMs = Math.round(performance.now() - directStarted);
    await onChange(state);
  }
  await onChange(state);
  for (const page of pageImages) {
    let oldPick = state.picked.old[page.number];
    if (refreshPicks ? !oldPick?.transport : !oldPick) {
      console.log(`笔记第 ${page.number} 页：旧流程看图挑词`);
      const started = performance.now();
      oldPick = await pickWords(key, model, INBOX_PROMPT, '', page.bytes);
      oldPick.elapsedMs = Math.round(performance.now() - started);
      state.picked.old[page.number] = oldPick;
      await onChange(state);
    }
    let newPage = state.picked.new[page.number] || {};
    if (!newPage.ocr) {
      console.log(`笔记第 ${page.number} 页：新流程 OCR`);
      const ocrStarted = performance.now();
      newPage.ocr = await ocrRequest(key, page.bytes, `notes-page-${page.number}.jpg`, 'text_recognition');
      newPage.ocrElapsedMs = Math.round(performance.now() - ocrStarted);
      newPage.recognizedText = (newPage.ocr.pages || []).map(item => item.text || '').join('\n');
      state.picked.new[page.number] = newPage;
      await onChange(state);
    }
    if (refreshPicks ? !newPage.pick?.transport : !newPage.pick) {
      console.log(`笔记第 ${page.number} 页：OCR 文字挑词`);
      newPage.pick = await pickWords(key, model, OCR_PICK_PROMPT, newPage.recognizedText || '');
      newPage.elapsedMs = (newPage.ocrElapsedMs || 0) + newPage.pick.elapsedMs;
      state.picked.new[page.number] = newPage;
      await onChange(state);
    }
    state.picked.perPage[page.number] = wordsCompare(oldPick.words, newPage.pick.words);
    if (mode !== 'verify' && page.number === 2 && !state.richLayout) {
      console.log('笔记第 2 页：rich_layout_recognition');
      const richStarted = performance.now();
      state.richLayout = await ocrRequest(key, page.bytes, 'notes-page-2.jpg', 'rich_layout_recognition');
      state.richLayout.elapsedMs = Math.round(performance.now() - richStarted);
      await onChange(state);
    }
  }
  return state;
};

const runTts = async (key, onChange = async () => {}, existing = []) => {
  const rows = [...existing];
  for (const voice of VOICES) for (let index = 0; index < EXAMPLES.length; index++) {
    const filename = `tts/${voice}-${index + 1}.wav`;
    if (rows.some(row => row.file === filename)) continue;
    console.log(`TTS：${voice} 例句 ${index + 1}`);
    const text = EXAMPLES[index];
    const started = performance.now();
    const result = await safeApi(`${BASE}/v1/tools/tts`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice_id: voice, format: 'wav' }),
    }, true);
    if (!result.contentType.includes('audio') || result.bytes.length < 44) throw new Error(`TTS ${voice} 第 ${index + 1} 条未返回有效 WAV。`);
    const normalized = normalizeWavHeader(result.bytes);
    const name = `${voice}-${index + 1}.wav`;
    await fs.writeFile(path.join(OUT, 'tts', name), normalized);
    rows.push({ voice, text, file: `tts/${name}`, bytes: normalized.length, elapsedMs: Math.round(performance.now() - started),
      billedCharacters: [...text].reduce((sum, char) => sum + (/[\u3400-\u9fff]/u.test(char) ? 2 : 1), 0) });
    await onChange(rows);
  }
  return rows;
};

const asrCost = seconds => ({ promoUsd: Math.ceil(seconds) * AUDIO_RATE, standardUsd: Math.ceil(seconds) * 0.116 / 3600 });
const ocrCost = pages => pages * OCR_RATE;
const sum = values => values.reduce((a, b) => a + b, 0);

const main = async () => {
  const command = process.argv[2] || 'full';
  if (command === 'refresh-verify') {
    const file = path.join(OUT, 'verify-results.json');
    const result = JSON.parse(await fs.readFile(file, 'utf8'));
    const transcript = await groupPdfLines(TRANSCRIPT_PDF);
    result.audio.sourceEpisode = '6 Minute English — Learning from different generations (BBC RSS GUID p0pmkr5c)';
    result.audio.rssListedDurationSeconds = 411;
    const clipped = clipToEpisode(transcript, result.asrB.run.text);
    result.asrB.rawWholeFileWer = wer(transcript, result.asrB.run.text);
    result.asrB.wer = wer(clipped.reference, clipped.hypothesis);
    result.asrB.werScope = '节目正文（按共同开场/结束短语排除片头、片尾插播广告）；rawWholeFileWer 保留广告未裁切值。';
    result.asrB.clipMarkers = clipped.markers;
    await fs.writeFile(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log('复验结果 WER 已按节目边界离线重算；没有重复调用 API。');
    return;
  }
  if (command === 'refresh-wer') {
    const result = JSON.parse(await fs.readFile(CHECKPOINT, 'utf8'));
    const transcript = await groupPdfLines(TRANSCRIPT_PDF);
    const runs = { aConcurrency1: result.asrAConcurrency1, aConcurrency3: result.asrAConcurrency3,
      bConcurrency1: result.asrBConcurrency1, bConcurrency3: result.asrBConcurrency3 };
    result.wer = { scope: '节目正文（共同开场/结束短语裁去插播广告）；全文件未裁切数据另见 rawWholeFileWer。', clipMarkers: {} };
    result.rawWholeFileWer = {};
    for (const [name, run] of Object.entries(runs)) {
      const clipped = clipToEpisode(transcript, run.text);
      result.wer[name] = wer(clipped.reference, clipped.hypothesis);
      result.wer.clipMarkers[name] = clipped.markers;
      result.rawWholeFileWer[name] = wer(transcript, run.text);
    }
    await fs.writeFile(CHECKPOINT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await fs.writeFile(path.join(OUT, 'trial-results.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log('WER 与分散抽样的 10 项错误已离线重算；没有重复调用 API。');
    return;
  }
  if (command === 'fix-tts') {
    const directory = path.join(OUT, 'tts');
    const files = (await fs.readdir(directory)).filter(name => name.toLowerCase().endsWith('.wav'));
    for (const name of files) {
      const file = path.join(directory, name);
      await fs.writeFile(file, normalizeWavHeader(await fs.readFile(file)));
    }
    console.log(`已修正 ${files.length} 个试听 WAV 的 RIFF 长度标记；没有调用 API。`);
    return;
  }
  if (command === 'prepare') {
    const audio = await compileAndDecode();
    const notes = await extractPdfPages(NOTES, OUT);
    const transcript = await groupPdfLines(TRANSCRIPT_PDF);
    await fs.writeFile(path.join(AUDIO, 'official-transcript.txt'), transcript, 'utf8');
    const plan = segmentBySilence(audio);
    console.log(`本地准备通过：WAV ${audio.info.rate}Hz/${audio.info.channels} 声道/${audio.info.bits}bit，${audio.info.duration.toFixed(2)} 秒；笔记 PDF ${notes.length} 页，渲染图写到任务临时目录；静音切段 ${plan.segments.length} 段。`);
    console.log(`逐字稿提取 ${normalizeWords(transcript).length} 词；没有发起 DeepSeek API 请求。`);
    return;
  }
  if (command === 'verify-starts') {
    const sourcePath = path.join(OUT, 'trial-results.json');
    const source = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
    const samples = source.segmentation?.sample10;
    const originalSegments = source.asrBConcurrency3?.segments;
    if (!Array.isArray(samples) || !Array.isArray(originalSegments)) {
      throw new Error('找不到完整实测的 10 段样本数据，请先运行 full。');
    }
    // 取报告样本 #3、#4、#6，均是节目正文而非头尾插播广告。
    const selected = [2, 3, 5].map(index => {
      const sample = samples[index];
      const original = originalSegments.find(row => Math.abs(row.start - sample?.start) < 0.001);
      if (!sample || !original || original.error) throw new Error(`报告样本 #${index + 1} 缺少成功的源 ASR 片段。`);
      return { sampleNumber: index + 1, start: sample.start, end: sample.end, expected: sample.text };
    });
    const key = await readKey();
    const audio = await compileAndDecode();
    const checks = [];
    for (const sample of selected) {
      const duration = Math.min(4, sample.end - sample.start, audio.info.duration - sample.start);
      const result = await asrRequest(key, { wav: makeSlice(audio, sample.start, sample.start + duration) });
      const matches = commonOpeningWords(result.text, sample.expected);
      checks.push({ sampleNumber: sample.sampleNumber, start: sample.start, excerptSeconds: duration,
        expectedOpening: sample.expected, recognizedOpening: result.text, matchedOpeningWords: matches,
        pass: matches >= 2, elapsedMs: result.elapsedMs, durationMs: result.durationMs });
      await fs.writeFile(path.join(OUT, 'start-check-partial.json'), `${JSON.stringify({ checks }, null, 2)}\n`, 'utf8');
      console.log(`样本 #${sample.sampleNumber} @ ${sample.start.toFixed(2)}s：${matches} 个顺序匹配词，${matches >= 2 ? '通过' : '未通过'}`);
    }
    const result = { checkedAt: new Date().toISOString(), method: '从 episode-16k-mono.wav 按样本开始时间截取最多 4 秒，逐段调用 DeepSeek ASR；比较识别开头前 12 词与原段前 20 词的最长公共子序列，至少 2 词通过。', checks };
    await fs.writeFile(path.join(OUT, 'start-check-results.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await fs.writeFile(path.join(OUT, 'start-check-partial.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    if (checks.some(row => !row.pass)) throw new Error('有样本未达到至少 2 个顺序匹配词；详见 start-check-results.json。');
    console.log(`三段自动起点核对完成：${path.join(OUT, 'start-check-results.json')}；密钥没有写入文件。`);
    return;
  }
  const mode = command === 'verify' || command === 'verify-resume' ? 'verify' : 'full';
  const refreshNotes = command === 'refresh-notes';
  const resumeVerify = command === 'verify-resume';
  const resume = command === 'resume' || command === 'refresh-picks' || refreshNotes || resumeVerify;
  const refreshPicks = command === 'refresh-picks';
  const key = await readKey();
  const models = await loadModels(key);
  const model = models.includes('deepseek-flash') ? 'deepseek-flash' : '';
  if (!model) throw new Error('GET /models 没有 deepseek-flash，无法按当前可用视觉模型实测。');
  console.log(`模型列表：${models.join(', ')}；用于看图/挑词：${model}`);
  const audio = await compileAndDecode();
  const transcript = await groupPdfLines(TRANSCRIPT_PDF);
  await fs.writeFile(path.join(AUDIO, 'official-transcript.txt'), transcript, 'utf8');
  const startedAt = new Date().toISOString();
  const peak = isPeakHour(new Date());
  pricingPeak = peak;
  const freshResult = { startedAt, model, audio: { file: path.basename(MP3),
    sourceEpisode: '6 Minute English — Learning from different generations (BBC RSS GUID p0pmkr5c)',
    rssListedDurationSeconds: 411, wav: path.basename(audio.wav), durationSeconds: audio.info.duration,
    sampleRate: audio.info.rate, channels: audio.info.channels, bits: audio.info.bits },
    prices: { asrPromoPerHour: 0.058, asrStandardPerHour: 0.116, ocrPerThousandPages: 0.225,
      ttsPromoPerTenThousandChars: 0.225, ttsStandardPerTenThousandChars: 0.45,
      flashInputMissPerMillion: peak ? 0.30 : 0.15, flashInputHitPerMillion: peak ? 0.006 : 0.003,
      flashOutputPerMillion: peak ? 1.20 : 0.60, pricingPeriod: peak ? 'UTC工作日高峰' : 'UTC非高峰' } };
  const result = resume ? JSON.parse(await fs.readFile(resumeVerify ? VERIFY_CHECKPOINT : CHECKPOINT, 'utf8')) : freshResult;
  if (resume) pricingPeak = result.prices?.pricingPeriod === 'UTC工作日高峰';
  if (refreshNotes) { result.notes = null; result.notesComplete = false; }
  const saveCheckpoint = async () => {
    if (mode === 'full') await fs.writeFile(CHECKPOINT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    else await fs.writeFile(VERIFY_CHECKPOINT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  };
  const saveAsrRun = async (run, label) => {
    if (run.failures.length) {
      result.status = `实测未完成：${label}仍有 ${run.failures.length} 段 ASR 失败`;
      delete result.wer;
      delete result.rawWholeFileWer;
      delete result.segmentation;
      delete result.costs;
      delete result.finishedAt;
    }
    await saveCheckpoint();
    if (run.failures.length) {
      throw new Error(`${result.status}；检查点已保存，请网络恢复后运行对应的 resume 命令重试。`);
    }
  };

  if (mode === 'verify') {
    // 复验整段音频（自然覆盖卡片要求的前 3 分钟），确保 WER 与全篇报告可直接对照。
    const plan = segmentBySilence(audio);
    const segments = plan.segments.map(segment => ({ ...segment, audio }));
    await saveCheckpoint();
    if (!result.asrB) result.asrB = { segmentation: { ...plan, count: segments.length,
      averageSeconds: sum(segments.map(row => row.end - row.start)) / segments.length }, run: null };
    result.asrB.run = await ensureAsrRun(key, result.asrB.run, segments, 3,
      '复验：停顿切句（全音频，覆盖前 3 分钟）');
    if (result.asrB.run.failures.length) {
      result.status = `复验未完成：仍有 ${result.asrB.run.failures.length} 段 ASR 失败`;
      delete result.asrB.wer;
      delete result.asrB.rawWholeFileWer;
      delete result.asrB.cost;
      delete result.asrB.clipMarkers;
      result.finishedAt = new Date().toISOString();
      await saveCheckpoint();
      await fs.writeFile(path.join(OUT, 'verify-results.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      throw new Error(`${result.status}；请修复网络后运行 verify-resume。`);
    }
    await saveCheckpoint();
    if (!result.notesComplete) {
      result.notes = await runNotes(key, model, 'verify', async state => { result.notes = state; await saveCheckpoint(); }, result.notes);
      result.notesComplete = true;
      await saveCheckpoint();
    }
    const clipped = clipToEpisode(transcript, result.asrB.run.text);
    result.asrB.rawWholeFileWer = wer(transcript, result.asrB.run.text);
    result.asrB.wer = wer(clipped.reference, clipped.hypothesis);
    result.asrB.werScope = '节目正文（按共同开场/结束短语排除片头、片尾插播广告）；rawWholeFileWer 保留广告未裁切值。';
    result.asrB.clipMarkers = clipped.markers;
    const verifiedSeconds = sum(result.asrB.run.segments.filter(row => !row.error)
      .map(row => Math.ceil((row.durationMs ?? (row.end - row.start) * 1000) / 1000)));
    result.asrB.cost = { billedSeconds: verifiedSeconds, promoUsd: verifiedSeconds * AUDIO_RATE,
      standardUsd: verifiedSeconds * 0.116 / 3600 };
    result.notes.costUsd = ocrCost((result.notes.picked.new[2]?.ocr.pageCount || 1)) + usageCost(result.notes.picked.new[2]?.pick.usage).usd;
    result.status = '复验命令成功';
  } else {
    await saveCheckpoint();
    const fixed = [];
    for (let start = 0; start < audio.info.duration; start += 110) fixed.push({ start, end: Math.min(audio.info.duration, start + 110), cut: '固定 110 秒', audio });
    const plan = segmentBySilence(audio);
    const silence = plan.segments.map(segment => ({ ...segment, audio }));
    result.asrAConcurrency1 = await ensureAsrRun(key, result.asrAConcurrency1, fixed, 1, '方案 A：固定切块');
    await saveAsrRun(result.asrAConcurrency1, '方案 A 并发 1');
    result.asrAConcurrency3 = await ensureAsrRun(key, result.asrAConcurrency3, fixed, 3, '方案 A：固定切块');
    await saveAsrRun(result.asrAConcurrency3, '方案 A 并发 3');
    result.asrBConcurrency1 = await ensureAsrRun(key, result.asrBConcurrency1, silence, 1, '方案 B：按停顿切句');
    await saveAsrRun(result.asrBConcurrency1, '方案 B 并发 1');
    result.asrBConcurrency3 = await ensureAsrRun(key, result.asrBConcurrency3, silence, 3, '方案 B：按停顿切句');
    await saveAsrRun(result.asrBConcurrency3, '方案 B 并发 3');
    const cutRows = result.asrBConcurrency3.segments.filter(row => row.text);
    const sentenceCutCount = cutRows.filter(row => !/[.!?…]["')\]]*$/u.test(row.text.trim())).length;
    result.segmentation = { ...plan, count: silence.length, averageSeconds: sum(silence.map(row => row.end - row.start)) / silence.length,
      longestSeconds: Math.max(...silence.map(row => row.end - row.start)), sentenceCutCount,
      sentenceCutRate: cutRows.length ? sentenceCutCount / cutRows.length : null,
      sample10: Array.from({ length: Math.min(10, silence.length) }, (_, n) => {
        const index = Math.round(n * (silence.length - 1) / Math.max(1, Math.min(10, silence.length) - 1));
        const segment = result.asrBConcurrency3.segments[index];
        return { start: segment.start, end: segment.end, text: segment.text };
      }) };
    const clipA1 = clipToEpisode(transcript, result.asrAConcurrency1.text);
    const clipA3 = clipToEpisode(transcript, result.asrAConcurrency3.text);
    const clipB1 = clipToEpisode(transcript, result.asrBConcurrency1.text);
    const clipB3 = clipToEpisode(transcript, result.asrBConcurrency3.text);
    result.wer = {
      aConcurrency1: wer(clipA1.reference, clipA1.hypothesis), aConcurrency3: wer(clipA3.reference, clipA3.hypothesis),
      bConcurrency1: wer(clipB1.reference, clipB1.hypothesis), bConcurrency3: wer(clipB3.reference, clipB3.hypothesis),
      scope: '节目正文（共同开场/结束短语裁去插播广告）；完整文件另见 rawWholeFileWer。',
      clipMarkers: { aConcurrency1: clipA1.markers, aConcurrency3: clipA3.markers, bConcurrency1: clipB1.markers, bConcurrency3: clipB3.markers },
    };
    result.rawWholeFileWer = {
      aConcurrency1: wer(transcript, result.asrAConcurrency1.text), aConcurrency3: wer(transcript, result.asrAConcurrency3.text),
      bConcurrency1: wer(transcript, result.asrBConcurrency1.text), bConcurrency3: wer(transcript, result.asrBConcurrency3.text),
    };
    if (!result.notesComplete || refreshPicks || refreshNotes) {
      result.notes = await runNotes(key, model, 'full', async state => { result.notes = state; await saveCheckpoint(); },
        refreshNotes ? null : result.notes, refreshPicks);
      result.notesComplete = true;
      await saveCheckpoint();
    }
    if (!result.ttsComplete) {
      result.tts = await runTts(key, async rows => { result.tts = rows; await saveCheckpoint(); }, result.tts);
      result.ttsComplete = true;
      await saveCheckpoint();
    }
    const allAsrRuns = [result.asrAConcurrency1, result.asrAConcurrency3, result.asrBConcurrency1, result.asrBConcurrency3];
    const secondsRecognized = sum(allAsrRuns.flatMap(run => run.segments
      .filter(row => !row.error)
      .map(row => Math.ceil((row.durationMs ?? (row.end - row.start) * 1000) / 1000))));
    const asrCharges = { promoUsd: secondsRecognized * AUDIO_RATE, standardUsd: secondsRecognized * 0.116 / 3600 };
    const allPickUsages = [
      ...Object.values(result.notes.picked.old).map(row => row.usage),
      ...Object.values(result.notes.picked.new).map(row => row.pick.usage),
    ];
    const chatUsd = sum(allPickUsages.map(usage => usageCost(usage).usd));
    const visionPages = result.notes.pagesCompared.length;
    const perPageOcr = sum(Object.values(result.notes.picked.new).map(row => row.ocr.pageCount || 1));
    const richPages = result.notes.richLayout?.pageCount || 0;
    const directPages = result.notes.directPdfOcr.pageCount || 0;
    const ttsCharacters = sum(result.tts.map(row => row.billedCharacters));
    const ttsPromo = ttsCharacters * 0.225 / 10000;
    result.costs = {
      asrAudioSecondsBilled: secondsRecognized, asrPromoUsd: asrCharges.promoUsd, asrStandardUsd: asrCharges.standardUsd,
      oldVisionModelUsd: sum(Object.values(result.notes.picked.old).map(row => usageCost(row.usage).usd)),
      newPickModelUsd: sum(Object.values(result.notes.picked.new).map(row => usageCost(row.pick.usage).usd)),
      oldMethodTotalUsd: sum(Object.values(result.notes.picked.old).map(row => usageCost(row.usage).usd)),
      newOcrPages: perPageOcr, newOcrAndPickTotalUsd: ocrCost(perPageOcr) + sum(Object.values(result.notes.picked.new).map(row => usageCost(row.pick.usage).usd)),
      separateDirectPdfOcrUsd: ocrCost(directPages), richLayoutOcrUsd: ocrCost(richPages),
      ttsCharacters, ttsPromoUsd: ttsPromo, ttsStandardUsd: ttsCharacters * 0.45 / 10000,
      allChatModelUsd: chatUsd,
      totalPromoUsd: asrCharges.promoUsd + chatUsd + (perPageOcr + directPages + richPages) * OCR_RATE + ttsPromo,
      totalStandardUsd: asrCharges.standardUsd + chatUsd + (perPageOcr + directPages + richPages) * OCR_RATE + ttsCharacters * 0.45 / 10000,
      note: 'DeepSeek API 当前官方标价；模型费用按响应 usage 和运行时段估算，ASR/TTS 同列限时半价与标准价。',
    };
    result.mobileCodeReview = {
      feasibility: '可行，但当前不能直接复用 Rust Symphonia 解码库到手机 WebView；可用 Web Audio decodeAudioData + PCM WAV 编码。',
      roughWork: '约 40–80 行 TypeScript（读文件、解码、单声道混音/重采样、PCM16/WAV 头、分块与清理），需真机测内存/兼容；完整音频一次解码峰值内存会偏大。',
      evidence: '审阅 app/src-tauri/src/decode.rs 的解码输出、app/utils/vocab/noteMedia.ts 的 WebView canvas 流程；未在手机执行。',
    };
  }
  result.finishedAt = new Date().toISOString();
  result.costFootnote = '模型费用根据 /chat/completions 返回 usage 估算；OCR 按成功页数；ASR 按音频秒数计费。';
  const filename = mode === 'verify' ? 'verify-results.json' : 'trial-results.json';
  await fs.writeFile(path.join(OUT, filename), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await saveCheckpoint();
  console.log(`完成：${path.join(OUT, filename)}；密钥没有写入文件。`);
};

main().catch(error => {
  console.error(`实测未完成：${error instanceof Error ? error.message : '发生未知错误'}`);
  process.exitCode = 1;
});
