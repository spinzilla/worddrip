import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const outfile = join(process.cwd(), 'node_modules', '.cache', `coach-review-${process.pid}.mjs`);
mkdirSync(dirname(outfile), { recursive: true });
try {
  await build({ entryPoints: ['utils/coach/review.ts'], bundle: true, format: 'esm', outfile });
  const review = await import(pathToFileURL(outfile).href);

  // 写死的正确答案：The / analysis / shows / benefits 共 4 词，后两个 AWL 词次。
  const sample = review.analyzeEssay('The analysis shows benefits.');
  assert.equal(sample.wordCount, 4);
  assert.equal(sample.awlCount, 2);
  assert.equal(sample.awlCoverage, 50);
  assert.deepEqual(sample.awlFamilies, [{ headword: 'analyse', sublist: 1 }, { headword: 'benefit', sublist: 1 }]);
  assert.equal(review.countWords('  one\n two\tthree  '), 3);
  assert.equal(review.countWords('   '), 0);

  // 词族必须匹配变形，不能只查词头。
  const variants = review.analyzeEssay('Analysed and benefiting');
  assert.equal(variants.awlCount, 2);

  const partB = review.analyzeEssay('Text A Text B Text C Do not copy summary 100-130 words. This device helps people.');
  const partC = review.analyzeEssay('ASPECTS OF TECHNOLOGY ABILITIES battery device 150-250 words.');
  const general = review.analyzeEssay('The analysis shows benefits.');
  assert.equal(partB.paperType, 'part-b');
  assert.equal(partC.paperType, 'part-c');
  assert.equal(general.paperType, 'general');
  assert.equal(review.analyzeEssay('The analysis shows benefits.', 'part-c').paperType, 'part-c', '手动选择优先于自动判定');

  const valid = {
    summary: {
      weakFeatures: [{ feature: 'formal', note: '表达偏口语。' }],
      oneThing: '先替换模糊表达。',
      hardChecks: ['词数符合要求。'],
    },
    corrections: [{ original: 'It shows a lot of things.', kind: 'AWL', correction: 'It demonstrates numerous factors.', why: '用具体学术表达。' }],
    selfCheck: [
      { question: '第一处怎么改？', answer: '使用 demonstrate。' },
      { question: '第二处怎么改？', answer: '补全主谓。' },
      { question: '第三处怎么改？', answer: '增加衔接。' },
    ],
    archiveComparison: { recurring: ['主谓一致'], newIssues: ['模糊表达'] },
  };
  const parsed = review.parseFirstReview(`\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\n`);
  assert.deepEqual(parsed, valid);
  assert.throws(() => review.parseFirstReview('```json\n{坏掉啦}\n```'), /模型返回格式不正确/);
  assert.throws(() => review.parseFirstReview(JSON.stringify({ ...valid, selfCheck: [] })), /模型返回格式不正确/);
  assert.throws(() => review.parseFirstReview(JSON.stringify({ ...valid, corrections: '不是数组' })), /模型返回格式不正确/);

  assert.ok(review.honestyNoticeFor('part-b').includes('语言类维度的权重是我的推断'));
  assert.ok(review.honestyNoticeFor('part-c').includes('不是格院官方公布的评分细则'));
  assert.equal(review.honestyNoticeFor('general'), '');

  const top = [{ id: 'top-1', ord: 0, rank: 1, kind: '主谓一致', count: '8', lastAt: '2026-01-04', status: '🔴' }];
  const prompt = review.buildFirstPrompt('The analysis shows benefits.', sample, top);
  assert.ok(prompt.includes('1. 主谓一致；次数 8'), '提示词必须包含高频错误 Top');
  assert.ok(prompt.includes('词数：4'), '提示词必须使用程序算出的词数');
  assert.ok(prompt.includes('AWL 覆盖率：50%'));
  assert.ok(prompt.indexOf('学生作文') < prompt.indexOf('输出要求（最后阅读并严格遵守）'), '输出要求必须放在最后');

  const longAnalysis = { ...sample, wordCount: 280 };
  const overviewPrompt = review.buildLongOverviewPrompt('long essay', longAnalysis, top);
  assert.ok(overviewPrompt.includes('这一轮只做总评、自查题和档案对照'));
  const longOverview = { ...valid, corrections: [] };
  assert.deepEqual(review.parseFirstReview(JSON.stringify(longOverview)).corrections, []);
  assert.deepEqual(
    review.parseSentenceCorrections(JSON.stringify({ corrections: valid.corrections })),
    valid.corrections,
  );

  const rewritten = review.parseRewriteReview('```json\n{"rewrite":"A complete academic paragraph.","improvements":["结构更清楚。"]}\n```');
  assert.equal(rewritten.rewrite, 'A complete academic paragraph.');
  assert.throws(() => review.parseRewriteReview('not json'), /模型返回格式不正确/);
  console.log('coach review: all checks passed');
} finally {
  rmSync(outfile, { force: true });
}
