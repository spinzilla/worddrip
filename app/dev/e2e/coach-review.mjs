import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

// 全部数据、窗口和截图都隔离；唯一的外部连接是本机假模型。
process.env.ES_E2E_ROOT = path.join(process.cwd(), 'node_modules', '.cache', 'es-e2e');
const { start, stop } = await import('./launch.mjs');
const { connect } = await import('./cdp.mjs');

const fakeKey = 'coach-review-local-only-key';
const firstResult = {
  summary: {
    weakFeatures: [{ feature: 'formal', note: 'a lot of 和 big 偏口语，表达不够准确。' }],
    oneThing: '先把模糊、口语化的词换成准确的学术表达。',
    hardChecks: [],
  },
  corrections: [{
    original: 'Technology help people get good results.',
    kind: 'grammar / AWL',
    correction: 'Technology helps people obtain reliable results.',
    why: 'Technology 是单数主语，谓语用 helps；get good results 可改为更准确的 obtain reliable results。',
  }],
  selfCheck: [
    { question: 'Technology help 的主谓一致应该怎么改？', answer: '改为 Technology helps，因为主语是第三人称单数。' },
    { question: 'a lot of 可以换成哪个更正式的表达？', answer: '可以按语境改为 numerous 或 considerable。' },
    { question: '句首 So 应该怎样改成正式衔接？', answer: '可以改为 Therefore 或 Consequently。' },
  ],
  archiveComparison: { recurring: ['主谓一致再次出现，需要交稿前逐句检查谓语。'], newIssues: ['模糊表达 big。'] },
};
const rewriteResult = {
  rewrite: 'This analysis demonstrates considerable benefits. Technology helps people obtain reliable results; therefore, it plays a significant role in modern society.',
  improvements: ['用 demonstrates、considerable 和 significant 替换模糊表达。', '用 therefore 明确表示因果关系，结构更正式。'],
};

let requestCount = 0;
const prompts = [];
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(req.url, '/v1/chat/completions');
  assert.ok(req.headers.authorization === `Bearer ${fakeKey}`, '假模型收到的密钥不正确');
  assert.equal(payload.model, 'fake-coach-review');
  const prompt = payload.messages?.[0]?.content;
  assert.equal(typeof prompt, 'string');
  prompts.push(prompt);
  requestCount += 1;
  res.setHeader('Content-Type', 'application/json');
  let content;
  if (prompt.includes('RETURN_BAD_JSON')) content = '```json\n{这不是 JSON}\n```';
  else if (prompt.includes('整段改写示范')) {
    // 020：第二步改写失败时点「跳过」，自查答案也要照常显示。
    if (prompt.includes('FAIL_REWRITE')) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: { message: '假改写失败' } }));
    }
    content = JSON.stringify(rewriteResult);
  } else content = `\`\`\`json\n${JSON.stringify(firstResult)}\n\`\`\``;
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const modelPort = typeof address === 'object' && address ? address.port : 0;
const runId = `coach-review-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${process.pid}`;
let session;
let page;
try {
  session = await start({ port: Number(process.env.ES_COACH_REVIEW_E2E_PORT) || 9351, runId });
  page = await connect({ port: session.port });
  await page.waitReady('nav button');
  await page.setViewport(1280, 900, { mobile: false, dpr: 1 });
  await page.evaluate(baseUrl => {
    localStorage.setItem('linguaclip_ai_config', JSON.stringify({ baseUrl, apiKey: 'coach-review-local-only-key', model: 'fake-coach-review', temperature: 0.2 }));
    window.__ES_E2E_HTTP_FETCH__ = window.fetch.bind(window);
  }, `http://127.0.0.1:${modelPort}/v1`);
  await page.clickText('教练');
  await page.click('[data-testid=coach-tab-errors]'); // 096：教练页分了小标签，默认是写作练习
  await page.waitFor('[data-testid="coach-empty"]');
  await page.click('[data-testid=coach-tab-essay]');
  await page.waitFor('[data-testid="essay-review"]');

  // 复用 018 的真实导入命令，让首条提示词确实读到错误档案 Top。
  const archive = fs.readFileSync(new URL('../fixtures/vocab/errors.md', import.meta.url), 'utf8');
  await page.evaluate(async markdown => {
    const { parseErrorArchive } = await import('/utils/vocab/errors.ts');
    const { vocabApi } = await import('/utils/vocab/api.ts');
    await vocabApi.importErrors({ ...parseErrorArchive(markdown), source: { fileName: 'errors.md', content: markdown } });
  }, archive);
  await page.click('[data-testid=coach-tab-errors]');
  await page.click('[data-testid="coach-refresh"]');
  await page.waitFor('[data-testid="coach-data"]');
  await page.click('[data-testid=coach-tab-essay]');

  // 超过 400 词必须先问，确认前一次模型请求都不能发。
  await page.type('[data-testid="review-essay"]', `RETURN_BAD_JSON ${'ordinary '.repeat(400)}word`);
  await page.click('[data-testid="review-submit"]');
  await page.waitFor('[data-testid="review-long-confirm"]');
  assert.equal(requestCount, 0);
  await page.clickText('先不批');

  const essay = fs.readFileSync(new URL('../fixtures/coach/sample-essay.txt', import.meta.url), 'utf8');
  await page.type('[data-testid="review-essay"]', essay);
  await page.click('[data-testid="review-submit"]');
  await page.waitFor('[data-testid="review-result"]');
  assert.equal(requestCount, 1, '提交后只能请求第一批改');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="review-rewrite"]') !== null), false, '跳过前不能显示改写示范');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="review-answers"]') !== null), false, '跳过前不能泄露自查答案');
  assert.ok(prompts[0].includes('主谓一致'), '首条提示词没有高频错误 Top');
  assert.match(prompts[0], /词数：\d+/);
  assert.match(prompts[0], /AWL 覆盖率：\d+(?:\.\d+)?%/);
  const resultText = await page.text('[data-testid="review-result"]');
  for (const expected of ['① 总评', '② 逐句改错', '②+ 先自查', '④ 与档案对照', 'Technology helps people obtain reliable results.']) {
    assert.ok(resultText.includes(expected), `首批评改缺少：${expected}`);
  }
  await page.screenshot(path.join(session.out, 'review-result.png'));

  await page.click('[data-testid="review-skip"]');
  await page.waitFor('[data-testid="review-rewrite"]');
  assert.equal(requestCount, 2, '跳过后才允许发第二条请求');
  assert.ok(prompts[1].includes('整段改写示范'));
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="review-answers"]').open), false, '跳过后的答案必须默认折叠');
  assert.ok((await page.text('body')).includes(rewriteResult.rewrite));
  await page.screenshot(path.join(session.out, 'review-rewrite.png'));

  // 改写请求失败后点「跳过」：不显示改写示范，但自查答案要出现（020 回归）。
  await page.type('[data-testid="review-essay"]', `FAIL_REWRITE ${essay}`);
  await page.click('[data-testid="review-submit"]');
  await page.waitFor('[data-testid="review-result"]');
  await page.click('[data-testid="review-skip"]');
  await page.waitUntil('改写失败后仍显示自查答案', `!!document.querySelector('[data-testid="review-answers"]')`);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="review-rewrite"]') !== null), false, '改写失败不应显示示范');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="review-answers"]').open), false, '答案仍默认折叠');
  await page.evaluate(() => document.querySelector('[data-testid="review-answers"] summary').click());
  await page.waitUntil('展开后能看到自查答案', `document.querySelector('[data-testid="review-answers"]').innerText.includes(${JSON.stringify(firstResult.selfCheck[0].answer)})`);
  await page.screenshot(path.join(session.out, 'review-skip-failed.png'));

  await page.setViewport(390, 844, { mobile: true, dpr: 1 });
  const widths = await page.evaluate(() => ({ viewport: window.innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(widths.html <= 390 && widths.body <= 390, `390px 窄屏出现横向滚动：${JSON.stringify(widths)}`);
  await page.screenshot(path.join(session.out, 'review-narrow.png'));
  await page.setViewport();

  await page.type('[data-testid="review-essay"]', 'RETURN_BAD_JSON The analysis shows benefits.');
  await page.click('[data-testid="review-submit"]');
  await page.waitFor('[data-testid="review-error"]');
  assert.equal(requestCount, 5, '第一批、改写、失败批改、改写、坏 JSON 各一次');
  assert.ok((await page.text('[data-testid="review-error"]')).includes('模型返回格式不正确'));
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid="review-result"]') !== null), false, '坏 JSON 不能留下旧结果');
  assert.ok((await page.text('body')).includes('批改作文'), '坏 JSON 后页面不能白屏');

  const unexpectedErrors = page.errors.filter(error => !error.includes('plugin http not found'));
  assert.deepEqual(unexpectedErrors, [], `页面不应有未捕获异常或 console.error：${unexpectedErrors.join('\n')}`);
  for (const name of ['review-result.png', 'review-rewrite.png', 'review-skip-failed.png', 'review-narrow.png']) {
    assert.ok(fs.statSync(path.join(session.out, name)).size > 1000, `截图无效：${name}`);
  }
  // 应用日志不得写入假 key；脚本本身也只打印请求次数和截图目录。
  const logFiles = fs.existsSync(session.logs) ? fs.readdirSync(session.logs) : [];
  for (const name of logFiles) {
    const file = path.join(session.logs, name);
    if (fs.statSync(file).isFile()) assert.ok(!fs.readFileSync(file, 'utf8').includes(fakeKey), `日志泄露假 key：${name}`);
  }
  console.log(`coach review e2e: all checks passed；假模型请求 ${requestCount} 次，key 未出现在运行输出或应用日志`);
  console.log(`截图目录：${session.out}`);
} finally {
  if (page) page.close();
  if (session) await stop(session.runDir);
  await new Promise(resolve => server.close(resolve));
}
