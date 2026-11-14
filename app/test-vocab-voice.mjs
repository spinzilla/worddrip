// 050 词库发音：假词典、假朗读检查优先级、无声音提示所需的 null 结果和例句合成缓存。
// 用法（在 app 目录）：node test-vocab-voice.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const output = path.resolve('src-tauri/target/e2e', `050-vocab-voice-${process.pid}.mjs`);
fs.mkdirSync(path.dirname(output), { recursive: true });
await build({
  stdin: {
    contents: [
      "export { wordVoiceForLanguage } from './utils/wordVoice.ts';",
      "export { createSentenceClipCache } from './utils/vocab/voice.ts';",
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  outfile: output,
  logLevel: 'silent',
  define: { 'import.meta.env.DEV': 'true' },
  plugins: [{
    name: 'fake-tauri-voice-dependencies',
    setup(builder) {
      builder.onResolve({ filter: /\/dictVoice$/ }, args => ({ path: args.path, namespace: 'voice-test' }));
      builder.onLoad({ filter: /.*/, namespace: 'voice-test' }, () => ({ contents: "export const dictVoice = async () => 'none';" }));
      builder.onResolve({ filter: /\/(videoStorage|deckLang)$/ }, args => ({ path: args.path, namespace: 'wordvoice-test' }));
      builder.onLoad({ filter: /.*/, namespace: 'wordvoice-test' }, args => ({
        contents: args.path.endsWith('deckLang') ? "export const videoLang = () => 'en';" : 'export const getVideoRecord = async () => null;',
      }));
      builder.onResolve({ filter: /\/desktop$/ }, args => ({ path: args.path, namespace: 'desktop-test' }));
      builder.onLoad({ filter: /.*/, namespace: 'desktop-test' }, () => ({ contents: 'export const synthesizeSpeech = async () => null;' }));
    },
  }],
});

const bytes = value => Uint8Array.of(value).buffer;
const calls = [];
globalThis.window = {
  __ES_E2E_VOCAB_VOICE__: async (kind, text, voice) => {
    calls.push({ kind, text, voice });
    if (text === 'recorded') return kind === 'dictionary' ? bytes(1) : bytes(2);
    if (text === 'fallback') return kind === 'dictionary' ? 'none' : bytes(3);
    if (text === 'offline') return 'error';
    return kind === 'dictionary' ? 'none' : bytes(4);
  },
};

try {
  const { wordVoiceForLanguage, createSentenceClipCache } = await import(pathToFileURL(output).href);
  assert.equal(new Uint8Array(await wordVoiceForLanguage('recorded', 'en'))[0], 1, '有词典录音时优先用录音');
  assert.deepEqual(calls.slice(0, 2).map(call => call.kind), ['dictionary', 'tts'], '录音和朗读同时请求');

  calls.length = 0;
  assert.equal(new Uint8Array(await wordVoiceForLanguage('fallback', 'en'))[0], 3, '没有录音时用朗读');
  assert.ok(calls.some(call => call.kind === 'dictionary'), '词仍会查词典');

  calls.length = 0;
  assert.equal(await wordVoiceForLanguage('offline', 'en'), null, '两路失败时返回无声音');
  assert.equal(calls.length, 2);

  let synthesisCount = 0;
  const sentence = 'The council allocated funds to the library.';
  const getSentence = createSentenceClipCache(async text => {
    synthesisCount += 1;
    assert.equal(text, sentence);
    return { text, lang: 'en', url: 'blob:sentence-audio' };
  });
  const [first, second] = await Promise.all([getSentence(sentence), getSentence(sentence)]);
  assert.equal(first.url, 'blob:sentence-audio');
  assert.equal(second, first, '同一句共用已合成的 clip');
  assert.equal(synthesisCount, 1, '同一句仅合成一次');

  let failedCount = 0;
  const getFailedSentence = createSentenceClipCache(async text => {
    failedCount += 1;
    return { text, lang: 'en', url: null };
  });
  assert.equal(await getFailedSentence('no sound'), null);
  assert.equal(await getFailedSentence('no sound'), null);
  assert.equal(failedCount, 1, '失败也会缓存，避免反复合成');
  console.log('test-vocab-voice: 全部通过');
} finally {
  fs.rmSync(output, { force: true });
}
