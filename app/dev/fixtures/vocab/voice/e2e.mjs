// 050 真实窗口验证：隔离词库、假词典和假朗读，不碰真实数据库。
// 检查详情/闪卡的播放按钮、同句缓存、无声提示、作答中防泄题，以及 1280 / 390 截图。
// 默认离线运行；加 --live 会在假声测试之后额外试一次真实联网发音。
// 用法（在 app 目录）：node dev/fixtures/vocab/voice/e2e.mjs [--live]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { start, stop, DEV_PORT } from '../../../e2e/launch.mjs';
import { connect } from '../../../e2e/cdp.mjs';
import { portInUse } from '../../../e2e/proc.mjs';

if (await portInUse(DEV_PORT)) {
  console.error(`${DEV_PORT} 端口已被占用（可能有别的开发窗口在跑），先关掉再测。`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runDir = path.resolve('D:/tmp/es-e2e', `050-vocab-voice-${stamp}-${process.pid}`);
const out = path.join(runDir, 'out');
fs.mkdirSync(out, { recursive: true });
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const today = localDate();
const importRequest = {
  upgrade: { fileName: 'empty-upgrade.md', content: '# 学术升级库\n' },
  review: { fileName: 'voice-050.md', content: '# 词汇总词库\n' },
  entries: [{ id: 'dummy@1.1', line: 2, raw: '| dummy |', plain: 'dummy', upgrade: 'dummy', source: '测试', note: '' }],
  examples: [], selfChecks: [],
  reviewWords: [
    { id: 'mitigate@11.1', ord: 1, line: 2, raw: '| mitigate |', word: 'mitigate', issue: '11.1', addedAt: today, status: 'L1', level: 1, due: today, note: '' },
    { id: 'allocate@11.1', ord: 2, line: 3, raw: '| allocate |', word: 'allocate', issue: '11.1', addedAt: today, status: 'L1', level: 1, due: today, note: '' },
    { id: 'constrain@11.2', ord: 3, line: 4, raw: '| constrain |', word: 'constrain', issue: '11.2', addedAt: today, status: '🌱待考察', level: null, due: '', note: '' },
  ],
  warnings: { upgrade: [], review: [] },
};
const issueFiles = [
  { fileName: '20261101.md', content: `## 词单分析\n1. **mitigate** v. — to make something less harmful（减轻）；*The new measures can mitigate the damage.*\n2. **allocate** v. — to give something for a purpose（分配）；*The council will allocate funds to the library.*\n` },
  { fileName: '20261102.md', content: '## 词单分析\n1. **constrain** v. — to limit something（限制）；*Limited funding may constrain the project.*\n' },
];
const GOOD_SENTENCE = 'A sentence for the speaker cache.';
const QUIET_SENTENCE = 'This sentence should have no sound.';

const invoke = async (page, command, args = {}) => {
  const result = await page.evaluate(async (cmd, payload) => {
    try { return { value: await window.__TAURI_INTERNALS__.invoke(cmd, payload) }; }
    catch (error) { return { error: typeof error === 'string' ? error : String(error) }; }
  }, command, args);
  if (result.error) throw new Error(`${command} 失败：${result.error}`);
  return result.value;
};
const shot = (page, name) => page.screenshot(path.join(out, name), { full: true });
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const openBrowse = async page => {
  await page.clickText('词库', { timeout: 60000 });
  await page.clickText('查词', { selector: 'button[role=tab]', exact: true });
  await page.waitFor('[data-testid=vocab-list]');
};
const openWord = async (page, word) => {
  await page.evaluate(name => {
    const row = [...document.querySelectorAll('[data-testid=vocab-list] > button')].find(element => element.innerText.trim().startsWith(name));
    if (!row) throw new Error(`词库列表里没有 ${name}`);
    row.click();
  }, word);
  await page.waitFor('[data-testid=word-detail]');
};
const buttons = (page, root = 'body') => page.evaluate(selector => [...document.querySelector(selector).querySelectorAll('[data-testid=vocab-voice]')].map(button => ({ kind: button.dataset.kind, text: button.dataset.text })), root);

let session;
let page;
try {
  session = await start({ runDir, port: 9470 });
  page = await connect({ port: session.port });
  await page.waitReady();
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });

  await page.clickText('词库', { timeout: 60000 });
  assert.equal((await invoke(page, 'vocab_import', { request: importRequest })).reviewWords.added, 3);
  assert.equal((await invoke(page, 'vocab_definition_import', { request: { issues: issueFiles, eagp: null } })).examplesAdded, 3);
  await invoke(page, 'vocab_example_add', { request: { word: 'mitigate', items: [
    { sentence: GOOD_SENTENCE, source: '自己写' },
    { sentence: QUIET_SENTENCE, source: '自己写' },
  ] } });
  await page.reload();
  await openBrowse(page);

  await page.evaluate(() => {
    window.__voiceCalls = [];
    window.__ES_E2E_VOCAB_VOICE__ = async (kind, text, voice) => {
      window.__voiceCalls.push({ kind, text, voice });
      if (text === window.__ES_E2E_VOICE_FAIL_TEXT__) return 'error';
      if (kind === 'dictionary') return text === 'mitigate' ? new Uint8Array([1, 2, 3]).buffer : 'none';
      return new Uint8Array([4, 5, 6]).buffer;
    };
    window.Audio = class {
      constructor(url) { this.url = url; this.listeners = {}; }
      addEventListener(name, fn) { this.listeners[name] = fn; }
      play() { return Promise.resolve(); }
      pause() {}
    };
  });

  await openWord(page, 'mitigate');
  const detailButtons = await buttons(page, '[data-testid=word-detail]');
  assert.equal(detailButtons.filter(button => button.kind === 'word' && button.text === 'mitigate').length, 1);
  assert.equal(detailButtons.filter(button => button.kind === 'sentence').length, 3, '词库例句和两条我的例句都有播放键');
  await shot(page, '01-detail-1280.png');
  assert.equal(await noOverflow(page), true, '详情 1280 不横向溢出');

  await page.click('[data-testid=vocab-voice][data-kind=word]');
  await page.evaluate(() => document.querySelector('[data-testid=vocab-voice][data-kind=word]')?.click());
  try {
    await page.waitUntil('词典录音与朗读假服务收到单词', `window.__voiceCalls.filter(call => call.text === 'mitigate').length === 2`);
  } catch (error) {
    const debug = await page.evaluate(() => ({ calls: window.__voiceCalls, hook: typeof window.__ES_E2E_VOCAB_VOICE__, status: document.querySelector('[data-testid=vocab-voice-error]')?.textContent, active: document.activeElement?.outerHTML, button: document.querySelector('[data-testid=vocab-voice][data-kind=word]')?.outerHTML }));
    throw new Error(`${error.message}；调试：${JSON.stringify({ ...debug, errors: page.errors })}`);
  }
  const wordCalls = await page.evaluate(() => window.__voiceCalls.filter(call => call.text === 'mitigate'));
  assert.deepEqual(wordCalls.map(call => call.kind).sort(), ['dictionary', 'tts'], '单词并行请求词典和朗读');

  const definitionSpeaker = '[data-testid=definition-example] [data-testid=vocab-voice][data-kind=sentence]';
  const definitionText = await page.evaluate(selector => document.querySelector(selector)?.dataset.text, definitionSpeaker);
  await page.evaluate(() => { window.__voiceCalls.length = 0; });
  await page.click(definitionSpeaker);
  await page.waitUntil('朗读服务收到例句', 'window.__voiceCalls.some(call => call.text === ' + JSON.stringify(definitionText) + ')');
  assert.deepEqual(await page.evaluate(() => window.__voiceCalls.map(call => call.kind)), ['tts'], '例句只走朗读，不查词典');
  const synthesisCount = await page.evaluate(() => window.__voiceCalls.length);
  await page.click(definitionSpeaker);
  assert.equal(await page.evaluate(() => window.__voiceCalls.length), synthesisCount, '再次播放同一句不重复合成');

  await page.click(`[data-testid=example-item] [data-testid=vocab-voice][data-text="${GOOD_SENTENCE}"]`);
  await page.waitUntil('我的例句朗读', `window.__voiceCalls.some(call => call.text === ${JSON.stringify(GOOD_SENTENCE)})`);
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  assert.equal(await noOverflow(page), true, '详情 390 不横向溢出');
  await shot(page, '02-detail-390.png');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });

  // 闪卡背面应有词、词库例句、我的例句；正面不放播放键。
  await page.click('[data-testid=due-start]');
  await page.waitFor('[data-testid=flash]');
  assert.equal(await page.text('[data-testid=flash-word]'), 'mitigate');
  assert.equal((await buttons(page, '[data-testid=flash]')).length, 0, '闪卡正面没有发音按钮');
  await page.click('[data-testid=flash-card]');
  await page.waitUntil('闪卡翻到背面', `document.querySelector('[data-testid=flash-card]')?.dataset.side === 'back'`);
  const backButtons = await buttons(page, '[data-testid=flash]');
  assert.equal(backButtons.filter(button => button.kind === 'word').length, 1);
  assert.equal(backButtons.filter(button => button.kind === 'sentence').length, 3);
  assert.equal(await noOverflow(page), true, '闪卡 1280 不横向溢出');
  await shot(page, '03-flashcard-1280.png');

  const flashSentence = '[data-testid=flash-definitions] [data-testid=vocab-voice][data-kind=sentence]';
  await page.click(flashSentence);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=flash-card]')?.dataset.side), 'back', '点喇叭不会翻面');
  const spaceResult = await page.evaluate(() => {
    const button = document.querySelector('[data-testid=flash-definitions] [data-testid=vocab-voice]');
    button.focus();
    const event = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    return { prevented: event.defaultPrevented, side: document.querySelector('[data-testid=flash-card]')?.dataset.side };
  });
  assert.deepEqual(spaceResult, { prevented: false, side: 'back' }, '焦点在喇叭时，空格不被闪卡快捷键抢走');
  await page.evaluate(text => { window.__ES_E2E_VOICE_FAIL_TEXT__ = text; }, QUIET_SENTENCE);
  await page.click(`[data-testid=example-item] [data-testid=vocab-voice][data-text="${QUIET_SENTENCE}"]`);
  await page.waitFor('[data-testid=vocab-voice-error]');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=flash-card]')?.dataset.side), 'back', '无声提示不影响闪卡');
  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  assert.equal(await noOverflow(page), true, '闪卡 390 不横向溢出');
  await shot(page, '04-flashcard-390-no-sound.png');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.click('button[aria-label^="下一张"]');
  assert.equal(await page.text('[data-testid=flash-word]'), 'allocate', '无声后仍能切换下一张');
  await page.click('button[aria-label^="退出闪卡"]');

  // 复习作答和首考作答不能出现播放按钮。
  await page.click('[data-testid=due-recall-start]');
  await page.waitFor('[data-testid=recall-screen]');
  assert.equal((await buttons(page, '[data-testid=recall]')).length, 0, '复习作答中没有发音按钮');
  await page.click('button[aria-label^="退出复习"]');
  await page.waitFor('[data-testid=first-test-start]');
  await page.click('[data-testid=first-test-start]');
  await page.waitFor('[data-testid=first-test-preview]');
  await page.click('[data-testid=first-preview-skip]');
  await page.waitFor('[data-testid=recall-screen]');
  assert.equal((await buttons(page, '[data-testid=recall]')).length, 0, '首考作答中没有发音按钮');
  await page.click('button[aria-label^="退出复习"]');

  assert.deepEqual(page.errors.filter(error => error !== 'plugin http not found'), [], '假声音下页面没有错误');
  const fakeVoiceCalls = await page.evaluate(() => window.__voiceCalls);
  let liveAttempt = '未请求（运行时加 --live 可执行）';
  if (process.argv.includes('--live')) {
    await page.reload();
    await page.clickText('词库', { timeout: 60000 });
    await openBrowse(page);
    await openWord(page, 'mitigate');
    await page.evaluate(() => {
      delete window.__ES_E2E_VOCAB_VOICE__;
      window.__ES_E2E_LIVE_AUDIO__ = [];
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input?.url ?? '';
        const match = url.match(/^http:\/\/ipc\.localhost\/([^?]+)/);
        if (match && decodeURIComponent(match[1]).includes('tts')) window.__ES_E2E_LIVE_AUDIO__.push({ kind: 'tts-request' });
        return originalFetch(input, init);
      };
      const originalPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        const attempt = { kind: 'audio-play', status: 'pending' };
        window.__ES_E2E_LIVE_AUDIO__.push(attempt);
        return originalPlay.call(this).then(() => { attempt.status = 'started'; }).catch(error => {
          attempt.status = 'failed'; attempt.error = String(error);
          throw error;
        });
      };
    });
    const liveWord = '[data-testid=word-detail] [data-testid=vocab-voice][data-kind=word]';
    await page.evaluate(selector => document.querySelector(selector)?.click(), liveWord);
    let wordSettled = true;
    try {
      await page.waitUntil('真实单词发音请求结束', `(() => { const button = document.querySelector(${JSON.stringify(liveWord)}); return window.__ES_E2E_LIVE_AUDIO__.some(item => item.status === 'started' || item.status === 'failed') || !!button?.parentElement.querySelector('[role=status]'); })()`, { timeout: 30000 });
    } catch { wordSettled = false; }
    const wordResult = await page.evaluate(settled => ({ settled, audio: window.__ES_E2E_LIVE_AUDIO__.slice(), noSound: !!document.querySelector('[data-testid=vocab-voice-error]') }), wordSettled);

    const liveSentence = '[data-testid=definition-example] [data-testid=vocab-voice][data-kind=sentence]';
    const previousPlays = await page.evaluate(() => window.__ES_E2E_LIVE_AUDIO__.filter(item => item.kind === 'audio-play' && item.status !== 'pending').length);
    await page.evaluate(selector => document.querySelector(selector)?.click(), liveSentence);
    let sentenceSettled = true;
    try {
      await page.waitUntil('真实例句发音请求结束', `(() => { const button = document.querySelector(${JSON.stringify(liveSentence)}); const settled = window.__ES_E2E_LIVE_AUDIO__.filter(item => item.kind === 'audio-play' && item.status !== 'pending').length; return settled > ${previousPlays} || !!button?.parentElement.querySelector('[role=status]'); })()`, { timeout: 30000 });
    } catch { sentenceSettled = false; }
    const sentenceResult = await page.evaluate(settled => ({ settled, audio: window.__ES_E2E_LIVE_AUDIO__.slice(), noSound: !!document.querySelector('[data-testid=vocab-voice-error]') }), sentenceSettled);
    liveAttempt = { word: wordResult, sentence: sentenceResult, pageErrors: page.errors.filter(error => error.includes('plugin http')), notes: '记录 tts 请求和 HTML 音频播放是否开始；隔离版未注册 HTTP 插件，真人词典录音可能不可用。' };
  }
  console.log(JSON.stringify({ result: '通过', runDir, screenshots: fs.readdirSync(out).filter(name => name.endsWith('.png')).sort(), fakeVoiceCalls, liveAttempt }, null, 2));
} finally {
  page?.close();
  if (session) await stop(runDir).catch(error => console.error(`停止隔离窗口失败：${error.message}`));
}
