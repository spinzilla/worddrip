import assert from 'node:assert/strict';
import test from 'node:test';
import { retryFailedAsrSegments } from './asrReliability.mjs';

test('失败段重试成功后会回填原位并重建全文', async () => {
  const run = {
    segments: [
      { start: 0, end: 10, text: 'first' },
      { start: 10, end: 20, error: '连接重置' },
    ],
    text: 'first', requests: 2,
  };
  let calls = 0;
  const result = await retryFailedAsrSegments(run, run.segments, 1, async () => {
    calls += 1;
    return { text: 'second', durationMs: 10 };
  });

  assert.equal(calls, 1);
  assert.equal(result.text, 'first second');
  assert.equal(result.failures.length, 0);
  assert.equal(result.segments[1].start, 10);
  assert.equal(result.requests, 3);
  assert.equal(result.retryAttempts, 1);
});

test('持久失败仍保留失败并计入请求数，不能伪装成完整结果', async () => {
  const run = {
    segments: [
      { start: 0, end: 10, text: 'first' },
      { start: 10, end: 20, error: '第一次失败' },
    ],
    text: 'first', requests: 2,
  };
  let calls = 0;
  const result = await retryFailedAsrSegments(run, run.segments, 1, async () => {
    calls += 1;
    throw new Error('仍然失败');
  });

  assert.equal(calls, 2);
  assert.equal(result.text, 'first');
  assert.equal(result.failures.length, 1);
  assert.equal(result.segments[1].error, '仍然失败');
  assert.equal(result.requests, 4);
  assert.equal(result.retryAttempts, 2);
});
