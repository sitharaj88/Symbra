// Usage: node scripts/db.mjs <repo-root> "<sql>" [...more sql]
import { DatabaseSync } from 'node:sqlite';
const [root, ...sqls] = process.argv.slice(2);
const db = new DatabaseSync(`${root}/.symbra/index.db`, { readOnly: true });
for (const sql of sqls) {
  console.log(`--- ${sql.slice(0, 110)}`);
  for (const r of db.prepare(sql).all()) console.log(Object.values(r).map(v => typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(3) : String(v).slice(0, 100)).join(' | '));
}
