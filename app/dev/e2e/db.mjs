// 真实窗口测试：只读核对隔离目录里的 SQLite 数据库（node:sqlite，不写库）。
//   const db = await openDb(session);               // session.appData 下的 vocab.db
//   countRows(db, 'upgrade_entry')                     // 数表行数
//   queryRows(db, 'import_run', 'id > ?', [0])           // 按条件查行（? 占位符，参数另传）
//   db.close()
import fs from 'node:fs';
import path from 'node:path';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const needName = n => {
  if (!NAME.test(n)) throw new Error(`表名不合法：${n}`);
  return n;
};

// target：会话对象（用 appData/vocab.db）或数据库文件路径。
export async function openDb(target, file = 'vocab.db') {
  const dbPath = typeof target === 'string' ? target : path.join(target.appData, file);
  if (!fs.existsSync(dbPath)) throw new Error(`数据库还不存在：${dbPath}（应用还没建库？）`);
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    throw new Error('这个 Node 没有 node:sqlite，需要 Node 22.5 以上');
  }
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  db.path = dbPath;
  return db;
}

export const listTables = db =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);

export const countRows = (db, table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM "${needName(table)}"`).get().n);

export function queryRows(db, table, where = '', params = []) {
  const sql = `SELECT * FROM "${needName(table)}"` + (where ? ` WHERE ${where}` : '');
  return db.prepare(sql).all(...params);
}
