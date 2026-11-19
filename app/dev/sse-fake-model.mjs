// 090 本机假模型服务：OpenAI 兼容的 /v1/chat/completions，按 text/event-stream 慢慢吐内容。
//   单独跑：node dev/sse-fake-model.mjs [端口，默认 9791]
//   脚本里用：import { startFakeModel } from './sse-fake-model.mjs'
// 请求体里的 model 决定行为：
//   fake-stream（默认）  先吐几段 reasoning_content（思考），再吐几段 content（正文），最后 data: [DONE]
//   fake-json            不支持流式：忽略 stream，直接回普通 JSON
//   fake-echo            091 用：流式回「收到 N 条消息」（N = 不含 system 的消息条数），用来证明追问带上了前文
//   fake-reject-stream   带 stream 就回 400「stream is not supported」，不带 stream 才回普通 JSON
// 只监听 127.0.0.1；不读真实密钥（Authorization 只记「有没有」）。
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const THINK_PIECES = ['先想一想，', '这个词的意思，', '再举个例子。'];
export const TEXT_PIECES = ['Hello', ', ', 'streaming ', 'world', '!'];
// 092：「让 AI 看看」的判句回复（fake-grade）。固定内容，验收脚本据此核对「存改后 / 存更地道的」。
export const GRADE_FIXED = 'The team stayed resilient after the setback.';
export const GRADE_BETTER = 'The team remained remarkably resilient throughout the crisis.';
export const GRADE_REASON = '这句话里的动词搭配不太地道，改成 stayed resilient 更贴切。';
const GRADE_THINK = ['先看看句子的用法，', '再对照一下词义，', '最后给出改法。'];
const GRADE_JSON = JSON.stringify({
  usedTarget: true, grammarOk: false, verdict: 'wrong', reason: GRADE_REASON, targetForm: 'resilient',
  grammarFix: GRADE_FIXED, academicUpgrade: GRADE_BETTER, taskOk: true,
});

// 093：「AI 给例句」（fake-examples）和「AI 帮我看看」释义（fake-defcheck）的固定回复。
// 例句里的词从提示词里取（提示词里有 "target": "词"），所以换哪个词都能通过「用上目标词」的检查。
export const DEF_FIX_SUGGESTION = 'A list of the subjects to be discussed at a meeting.';
const DEF_CHECK_REASON = '这条写得不太像英英词典，可以再简练一点。';
const EXAMPLE_THINK = ['先想想这个词的常见搭配，', '再写三句校园场景的例句。'];
export const examplesJsonFor = target => JSON.stringify({
  examples: [
    { sentence: `The ${target} for today's lecture was reviewed in class.`, collocation: `${target} for the lecture`, chinese: '今天讲座的议程在课上过了一遍。' },
    { sentence: `We kept the ${target} short so that every student could follow it.`, collocation: `keep the ${target} short`, chinese: '我们把议程压得很短，好让每个同学都能跟上。' },
    { sentence: `Students added one item to the ${target} before the group project started.`, collocation: `add an item to the ${target}`, chinese: '小组项目开始前，同学们在议程里加了一项。' },
  ],
});
const DEF_CHECK_JSON = JSON.stringify({ good: false, comment: DEF_CHECK_REASON, suggestion: DEF_FIX_SUGGESTION });

// 095：写作出题 / 批改。fake-writing 按提示词标题判断当前是哪一步；fake-writing-bad 专门返回坏 JSON。
export const WRITING_TASK_JSON = JSON.stringify({
  prompt: 'Should universities require students to volunteer in their local communities?',
  chinese: '请表明你是否支持大学要求学生参加社区志愿服务，并给出理由。',
  requirements: '2–4 句，表明立场并给一个理由',
});
export const WRITING_REVIEW_JSON = JSON.stringify({
  task: { verdict: 'partly', comment: '已经表明立场，但理由还可以说得更具体。' },
  issues: [
    { original: 'students is', suggestion: 'students are', reason: '复数主语后要用 are。' },
    { original: 'very good', suggestion: 'beneficial', reason: '这里用 beneficial 更准确。' },
    { original: 'in my opinion I think', suggestion: 'I think', reason: '两个表达重复，保留一个即可。' },
    { original: '第四条不会被采用', suggestion: '仅用于测试最多三条', reason: '解析器只保留前三条。' },
  ],
  words: [{ word: 'resilient', used: true, correct: true, comment: 'resilient 在这里用得正确。' }],
  better: 'I believe universities should encourage community service. It helps students understand local needs. Such experience also makes education more meaningful.',
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function startFakeModel({ port = 0, thinkDelayMs = 150, textDelayMs = 300 } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    if (req.method !== 'POST' || !String(req.url).includes('/chat/completions')) { res.writeHead(404).end('not found'); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 忽略 */ }
    requests.push({ at: Date.now(), body, hasAuth: !!req.headers.authorization });
    const model = String(body.model ?? 'fake-stream');
    const fullText = TEXT_PIECES.join('');

    if (model === 'fake-writing' || model === 'fake-writing-bad') {
      const prompt = (Array.isArray(body.messages) ? body.messages : []).map(m => String(m.content ?? '')).join('\n');
      const content = model === 'fake-writing-bad' ? '{这不是 JSON' : (prompt.includes('【写作批改】') ? WRITING_REVIEW_JSON : WRITING_TASK_JSON);
      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      const sendWriting = delta => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      for (const piece of content.match(/.{1,32}/gs)) { if (res.destroyed) return; sendWriting({ content: piece }); await sleep(textDelayMs); }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (model === 'fake-echo' && body.stream) {
      const count = (Array.isArray(body.messages) ? body.messages : []).filter(m => m.role !== 'system').length;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      const sendEcho = delta => res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
      for (const piece of ['收到 ', String(count), ' 条消息']) { if (res.destroyed) return; sendEcho({ content: piece }); await sleep(textDelayMs); }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (model === 'fake-reject-stream' && body.stream) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'stream is not supported by this model' } }));
      return;
    }
    if (model === 'fake-grade' && body.stream) {
      // 先慢慢「想」（思考增长），再慢慢吐判句 JSON。
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      const sendGrade = delta => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      for (const piece of GRADE_THINK) { if (res.destroyed) return; sendGrade({ reasoning_content: piece }); await sleep(400); }
      for (const piece of GRADE_JSON.match(/.{1,24}/gs)) { if (res.destroyed) return; sendGrade({ content: piece }); await sleep(120); }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if ((model === 'fake-examples' || model === 'fake-defcheck') && body.stream) {
      // 先慢慢「想」，再慢慢吐 JSON（和判句一样的节奏）。
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      const sendJson = delta => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      const prompt = (Array.isArray(body.messages) ? body.messages : []).map(m => String(m.content ?? '')).join('\n');
      const target = /"target":\s*"([^"]+)"/.exec(prompt)?.[1] ?? 'agenda';
      const content = model === 'fake-examples' ? examplesJsonFor(target) : DEF_CHECK_JSON;
      for (const piece of (model === 'fake-examples' ? EXAMPLE_THINK : GRADE_THINK)) { if (res.destroyed) return; sendJson({ reasoning_content: piece }); await sleep(400); }
      for (const piece of content.match(/.{1,24}/gs)) { if (res.destroyed) return; sendJson({ content: piece }); await sleep(120); }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (model === 'fake-json' || model === 'fake-reject-stream' || !body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: fullText, reasoning_content: THINK_PIECES.join('') } }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    const send = delta => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
    for (const piece of THINK_PIECES) { if (res.destroyed) return; send({ reasoning_content: piece }); await sleep(thinkDelayMs); }
    for (const piece of TEXT_PIECES) { if (res.destroyed) return; send({ content: piece }); await sleep(textDelayMs); }
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      port: server.address().port,
      requests,
      close: () => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()); }),
    }));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fake = await startFakeModel({ port: Number(process.argv[2]) || 9791 });
  console.log(`假模型已启动：http://127.0.0.1:${fake.port}/v1（Ctrl+C 结束）`);
}
