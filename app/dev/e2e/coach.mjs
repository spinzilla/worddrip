import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// 启动产物留在仓库缓存里；真实窗口、应用数据和 WebView 数据仍全部隔离。
process.env.ES_E2E_ROOT = path.join(process.cwd(), 'node_modules', '.cache', 'es-e2e');
const { start, stop } = await import('./launch.mjs');
const { connect } = await import('./cdp.mjs');
const { openDb, countRows } = await import('./db.mjs');

const runId = `coach-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${process.pid}`;
const session = await start({ port: Number(process.env.ES_COACH_E2E_PORT) || 9349, runId });
let page;
try {
  page = await connect({ port: session.port });
  await page.waitReady('nav button');
  await page.clickText('教练');
  await page.waitFor('[data-testid="coach-empty"]');
  await page.waitText('词库 → 导入');
  await page.waitText('不影响错误档案浏览');
  await page.screenshot(path.join(session.out, 'coach-empty.png'));

  // 不走系统文件对话框：在页面里复用正式解析器和 018 的 Tauri 导入命令。
  const content = readFileSync(new URL('../fixtures/vocab/errors.md', import.meta.url), 'utf8');
  const report = await page.evaluate(async md => {
    const { parseErrorArchive } = await import('/utils/vocab/errors.ts');
    const { vocabApi } = await import('/utils/vocab/api.ts');
    return vocabApi.importErrors({ ...parseErrorArchive(md), source: { fileName: 'errors.md', content: md } });
  }, content);
  assert.deepEqual([report.top, report.batches, report.items, report.todos], [1, 3, 2, 2]);

  await page.click('[data-testid="coach-refresh"]');
  await page.waitFor('[data-testid="coach-data"]');
  const counts = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="coach-data"]');
    return {
      top: root.getAttribute('data-top-count'),
      batches: root.getAttribute('data-batch-count'),
      items: root.getAttribute('data-item-count'),
      todos: root.getAttribute('data-todo-count'),
      topRows: document.querySelectorAll('[data-testid="coach-top-row"]').length,
      batchRows: document.querySelectorAll('[data-testid="coach-batch"]').length,
      itemRows: document.querySelectorAll('[data-testid="coach-item"]').length,
      todoRows: document.querySelectorAll('[data-testid="coach-todo"]').length,
      batchIds: [...document.querySelectorAll('[data-testid="coach-batch"]')].map(node => node.getAttribute('data-batch-id')),
    };
  });
  assert.deepEqual(counts, {
    top: '1', batches: '3', items: '2', todos: '2',
    topRows: 1, batchRows: 3, itemRows: 2, todoRows: 2,
    batchIds: ['eb:2026-01-04', 'eb:2026-01-03', 'eb:2026-01-02'],
  });
  await page.click('[data-batch-id="eb:2026-01-03"] summary');
  await page.click('[data-batch-id="eb:2026-01-02"] summary');
  const dataText = await page.text('[data-testid="coach-data"]');
  for (const text of ['主谓一致', 'notes is', 'notes are', '复数主语', 'Q1 · 拼写', '交稿前冷读', '这批没有错误项。']) {
    assert.ok(dataText.includes(text), `教练页应显示：${text}`);
  }
  await page.evaluate(`document.querySelector('main').scrollTo({ top: 0 })`);
  await page.screenshot(path.join(session.out, 'coach-data.png'));

  await page.setViewport(390, 844);
  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(widths.html <= 390 && widths.body <= 390, `390px 窄屏出现横向滚动：${JSON.stringify(widths)}`);
  await page.screenshot(path.join(session.out, 'coach-narrow.png'));
  await page.setViewport();

  const db = await openDb(session);
  assert.equal(countRows(db, 'error_top'), 1);
  assert.equal(countRows(db, 'error_batch'), 3);
  assert.equal(countRows(db, 'error_item'), 2);
  assert.equal(countRows(db, 'error_todo'), 2);
  db.close();
  // launch.mjs 的隔离模式刻意不注册 http 插件，首页检查更新会留下这条已知日志。
  const unexpectedErrors = page.errors.filter(error => !error.includes('plugin http not found'));
  assert.deepEqual(unexpectedErrors, [], `页面不应有未捕获异常或 console.error：${unexpectedErrors.join('\n')}`);
  console.log(`coach e2e: all checks passed\n截图目录：${session.out}`);
} finally {
  if (page) page.close();
  await stop(session.runDir);
}
