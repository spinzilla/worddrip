#!/usr/bin/env node
// 词表数据生成器。原始文件只下载到 D:\tmp\es-downloads\wordpack，不进仓库。
// ECDICT (MIT): https://raw.githubusercontent.com/skywind3000/ECDICT/39cfb9672c0906b63569e0453c2e6abfb9ab182a/ecdict.csv
// SHA-256: D1ECBDF9EE2B920AFB6F430CA6B6BB9F559588CF0DFF86E04BD255F9390843CC
// NGSL: https://www.newgeneralservicelist.com/s/NGSL_12_stats.csv
// SHA-256: 2098BAB8955A120A9766C6282A51D7D578C6CB0A7D946600D2FFB73BA25A0B44
// NAWL: https://www.newgeneralservicelist.com/s/NAWL_12_lemmatized_for_teaching.csv
// SHA-256: 1790B0FA22C5815EBF5A9A15C9363C03A6E906C77BF217F99033734F1459137B

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const INPUT = 'D:\\tmp\\es-downloads\\wordpack';
const OUTPUT = join(ROOT, 'app/src-tauri/resources/wordpack');
const SOURCES = [
  { key: 'ecdict', file: 'ecdict.csv', url: 'https://raw.githubusercontent.com/skywind3000/ECDICT/39cfb9672c0906b63569e0453c2e6abfb9ab182a/ecdict.csv', sha256: 'D1ECBDF9EE2B920AFB6F430CA6B6BB9F559588CF0DFF86E04BD255F9390843CC' },
  { key: 'ngsl', file: 'ngsl.csv', url: 'https://www.newgeneralservicelist.com/s/NGSL_12_stats.csv', sha256: '2098BAB8955A120A9766C6282A51D7D578C6CB0A7D946600D2FFB73BA25A0B44' },
  { key: 'nawl', file: 'nawl.csv', url: 'https://www.newgeneralservicelist.com/s/NAWL_12_lemmatized_for_teaching.csv', sha256: '1790B0FA22C5815EBF5A9A15C9363C03A6E906C77BF217F99033734F1459137B' },
];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

async function ensureSource(source) {
  await mkdir(INPUT, { recursive: true });
  const path = join(INPUT, source.file);
  try {
    const bytes = await readFile(path);
    const actual = sha256(bytes);
    if (actual !== source.sha256) throw new Error(`${source.file} 校验失败：期望 ${source.sha256}，实际 ${actual}`);
    return bytes;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const partial = `${path}.download`;
  try {
    const response = await fetch(source.url, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`下载 ${source.file} 失败：HTTP ${response.status}`);
    await pipeline(response.body, createWriteStream(partial));
    const bytes = await readFile(partial);
    const actual = sha256(bytes);
    if (actual !== source.sha256) throw new Error(`${source.file} 校验失败：期望 ${source.sha256}，实际 ${actual}`);
    await rename(partial, path);
    return bytes;
  } finally {
    // 只清理本次下载创建的 .download 临时文件；原始输入文件绝不覆盖。
    await rm(partial, { force: true });
  }
}

// 支持逗号、双引号、换行都出现在带引号单元格中的 CSV。
function* csvRows(text) {
  let row = [], cell = '', quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(value => value !== '')) yield row;
      row = [];
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); if (row.some(value => value !== '')) yield row; }
}

const lines = value => String(value ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 3).join('\n');
const numberOrNull = value => {
  const number = Number(String(value ?? '').trim());
  return Number.isFinite(number) && number > 0 ? number : null;
};

async function main() {
  const sources = {};
  for (const source of SOURCES) sources[source.key] = await ensureSource(source);

  const ngsl = new Set();
  let ngslRows = 0;
  for (const row of csvRows(sources.ngsl.toString('utf8'))) {
    if (row[0]?.trim().toLowerCase() === 'lemma') continue;
    const word = row[0]?.trim().toLowerCase();
    if (word) { ngsl.add(word); ngslRows++; }
  }
  const nawl = new Set();
  for (const row of csvRows(sources.nawl.toString('utf8'))) {
    const word = row[0]?.trim().toLowerCase();
    if (word) nawl.add(word);
  }

  const rows = csvRows(sources.ecdict.toString('utf8'));
  const header = rows.next().value;
  if (!header?.includes('word') || !header.includes('translation') || !header.includes('tag')) {
    throw new Error('ECDICT CSV 列结构不符合预期');
  }
  const col = Object.fromEntries(header.map((name, i) => [name, i]));
  const entries = [];
  const matchedNgsl = new Set(), matchedNawl = new Set(), seen = new Set();
  for (const row of rows) {
    const word = (row[col.word] ?? '').trim();
    const key = word.toLowerCase();
    if (!key || seen.has(key)) continue;
    const tags = [...new Set((row[col.tag] ?? '').trim().split(/\s+/).filter(Boolean))];
    const inNgsl = ngsl.has(key), inNawl = nawl.has(key);
    if (!tags.length && !inNgsl && !inNawl) continue;
    seen.add(key);
    if (inNgsl) { tags.push('ngsl'); matchedNgsl.add(key); }
    if (inNawl) { tags.push('nawl'); matchedNawl.add(key); }
    entries.push({
      word,
      phonetic: row[col.phonetic] || '',
      pos: row[col.pos] || '',
      zh: lines(row[col.translation]),
      en: lines(row[col.definition]),
      frq: numberOrNull(row[col.frq]),
      bnc: numberOrNull(row[col.bnc]),
      tags: [...new Set(tags)].sort(),
      exchange: row[col.exchange] || '',
    });
  }

  const tagCounts = {};
  for (const entry of entries) for (const tag of entry.tags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
  entries.sort((a, b) => a.word.localeCompare(b.word, 'en'));
  const json = Buffer.from(JSON.stringify({ version: 1, entries }));
  await mkdir(OUTPUT, { recursive: true });
  const dataPath = join(OUTPUT, 'wordpack.json.gz');
  // gzipSync 默认 mtime=0，且输入顺序固定，保证同一源数据输出字节一致。
  const compressed = gzipSync(json, { level: 9, mtime: 0 });
  await writeFile(dataPath, compressed);

  const unmatchedNgsl = [...ngsl].filter(word => !matchedNgsl.has(word)).sort();
  const unmatchedNawl = [...nawl].filter(word => !matchedNawl.has(word)).sort();
  const report = [
    '# 内置词表构建报告', '',
    `- ECDICT 数据提交：39cfb9672c0906b63569e0453c2e6abfb9ab182a；原始数据 SHA-256：${sha256(sources.ecdict)}`,
    `- NGSL 1.2：${ngslRows} 个表内词条，匹配 ${matchedNgsl.size} 个；未匹配 ${unmatchedNgsl.length} 个。`,
    `- NAWL：${nawl.size} 个表内词条，匹配 ${matchedNawl.size} 个；未匹配 ${unmatchedNawl.length} 个。`,
    `- 输出词数：${entries.length}；压缩文件：${(await stat(dataPath)).size} 字节（${(await stat(dataPath)).size <= 10 * 1024 * 1024 ? '不超过 10 MB' : '超过 10 MB'}）。`,
    `- 输出文件 SHA-256：${sha256(compressed)}。`,
    '', '## 标签计数', '', '| 标签 | 词数 |', '|---|---:|',
    ...Object.entries(tagCounts).sort(([a], [b]) => a.localeCompare(b)).map(([tag, count]) => `| ${tag} | ${count} |`),
    '', '## 安卓资源说明', '', 'Android assets 只带许可证；运行时不从 assets 读取词包，词包由应用原生资源提供。',
    '', '## NGSL 未匹配词条', '', ...(unmatchedNgsl.length ? unmatchedNgsl.map(word => `- ${word}`) : ['- 无']),
    '', '## NAWL 未匹配词条', '', ...(unmatchedNawl.length ? unmatchedNawl.map(word => `- ${word}`) : ['- 无']), '',
  ].join('\n');
  await writeFile(join(OUTPUT, 'BUILD-REPORT.md'), report, 'utf8');

  console.log(`总词数：${entries.length}`);
  for (const [tag, count] of Object.entries(tagCounts).sort(([a], [b]) => a.localeCompare(b))) console.log(`${tag}：${count}`);
  console.log(`NGSL：${matchedNgsl.size}/${ngsl.size} 匹配，${unmatchedNgsl.length} 未匹配`);
  console.log(`NAWL：${matchedNawl.size}/${nawl.size} 匹配，${unmatchedNawl.length} 未匹配`);
  console.log(`文件大小：${compressed.length} 字节`);
  console.log(`数据 SHA-256：${sha256(compressed)}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
