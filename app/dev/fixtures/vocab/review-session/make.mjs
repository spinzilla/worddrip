// 014 真实窗口验收用的复习库：按「运行当天（本机自然日）」生成，不写死日期。
// 用法：node make.mjs <输出目录>  → 写出 review-none.md、review-due.md、review-one.md、expected.json。
// 也可以 import { makeFixtures } 在验收脚本里直接用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pad = n => String(n).padStart(2, '0');
/** 本机今天加 offset 天，按本机年月日输出 YYYY-MM-DD（不走 UTC）。 */
export function localDate(offset = 0, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const LONG_NOTE = '长备注测试：' + '这是一段很长的备注，用来检查闪卡背面能完整显示、窄屏不横向溢出；'.repeat(14) + 'averyveryveryverylongwordwithoutanyspacesthatmustwrapinsidethecardanddoesnotoverflow 末尾标记END';

export function makeFixtures(now = new Date()) {
  const at = offset => localDate(offset, now);
  const header = '# 词汇总词库\n## 总词库\n| 单词 | 期号 | 入库日期 | 状态 | 下次到期 | 备注 |\n|---|---|---|---|---|---|\n';
  const row = (w, issue, status, due, note) => `| ${w} | ${issue} | ${at(-30)} | ${status} | ${due} | ${note} |\n`;

  // 第一份：活跃词全都没到期 → 到期数应为 0。
  const none = header
    + row('alpha', '1.1', 'L1', at(1), '明天才到期')
    + row('bravo', '1.2', 'L4', at(30), '一个月后到期')
    + row('charlie', '1.3', '🌱待考察', '—', '待考察不参与')
    + row('delta', '1.4', '✅已掌握', at(-3), '已掌握即使日期过了也不参与')
    + row('echo', '1.5', '🧊冷库', at(-10), '冷库不参与');

  // 第二份：混合各种情况。
  const due = header
    + row('overdue', '2.1', 'L4', at(-400), '一年多以前到期（跨年）')
    + row('yesterday', '2.2', 'L1', at(-1), '昨天到期')
    + row('today', '2.3', 'L2', at(0), '今天到期')
    + row('tomorrow', '2.4', 'L3', at(1), '明天到期，不该出现')
    + row('blank', '2.5', 'L2', '—', '空日期，不该出现')
    // 无效日期（2026-02-30）不放进来：Rust 导入会整批拒绝它，到不了数据库；这一类由 test-vocab-due.mjs 覆盖。
    + row('pending', '2.7', '🌱待考察', at(-1), '待考察，不该出现')
    + row('mastered', '2.8', '✅已掌握', at(-1), '已掌握，不该出现')
    + row('cold', '2.9', '🧊冷库', at(-1), '冷库，不该出现')
    + row('shatter', '9.24', 'L1', at(0), '粉碎（第一行）')
    + row('shatter', '10.20', 'L2', at(0), '粉碎 hopes（第二行，同词不同期）')
    + row('longnote', '2.10', 'L3', at(-2), LONG_NOTE);

  // 第三份：只有 1 个到期词（单卡场景），其余不到期或不参与。
  const one = header
    + row('solo', '3.1', 'L2', at(-1), '单卡：唯一到期的词')
    + row('later', '3.2', 'L1', at(2), '后天才到期')
    + row('resting', '3.3', '🧊冷库', at(-5), '冷库不参与');

  // 期望的到期队列：到期日升序，同一天按导入顺序。
  const expected = {
    today: at(0),
    noneCount: 0,
    dueWords: ['overdue', 'longnote', 'yesterday', 'today', 'shatter', 'shatter'],
    dueIssues: ['2.1', '2.10', '2.2', '2.3', '9.24', '10.20'],
    oneWords: ['solo'],
  };
  return { none, due, one, expected };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('用法：node make.mjs <输出目录>'); process.exit(2); }
  fs.mkdirSync(dir, { recursive: true });
  const { none, due, one, expected } = makeFixtures();
  fs.writeFileSync(path.join(dir, 'review-none.md'), none, 'utf8');
  fs.writeFileSync(path.join(dir, 'review-due.md'), due, 'utf8');
  fs.writeFileSync(path.join(dir, 'review-one.md'), one, 'utf8');
  fs.writeFileSync(path.join(dir, 'expected.json'), JSON.stringify(expected, null, 2), 'utf8');
  console.log(`已写出到 ${dir}（今天按本机算是 ${expected.today}）`);
}
