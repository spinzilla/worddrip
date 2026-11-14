const errorText = error => error instanceof Error ? error.message : '未知错误';

const mapLimit = async (items, concurrency, worker) => {
  let next = 0;
  const output = Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await worker(items[index], index);
    }
  }));
  return output;
};

// 重试仍失败的段，并重建全文；未成功的段不能悄悄从 WER 输入中消失。
export const retryFailedAsrSegments = async (run, sourceSegments, concurrency, request, maxRetries = 2) => {
  const segments = run.segments.map(row => ({ ...row }));
  let attempts = 0;

  for (let retry = 0; retry < maxRetries; retry += 1) {
    const failedIndexes = segments.flatMap((row, index) => row.error ? [index] : []);
    if (!failedIndexes.length) break;

    const replacements = await mapLimit(failedIndexes, concurrency, async index => {
      const source = sourceSegments[index];
      try {
        return { start: source.start, end: source.end, cut: source.cut,
          ...await request(source, index) };
      } catch (error) {
        return { start: source.start, end: source.end, cut: source.cut, error: errorText(error) };
      }
    });

    failedIndexes.forEach((index, offset) => { segments[index] = replacements[offset]; });
    attempts += failedIndexes.length;
  }

  const succeeded = segments.filter(row => !row.error);
  return {
    ...run,
    segments,
    text: succeeded.map(row => row.text || '').join(' ').trim(),
    requests: (run.requests ?? run.segments.length) + attempts,
    retryAttempts: (run.retryAttempts || 0) + attempts,
    failures: segments.filter(row => row.error).map(row => row.error),
  };
};
