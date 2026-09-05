import { scanRepo } from '../dist/index/scan.js';
import { DatabaseSync } from 'node:sqlite';
const root = process.argv[2];
const db = new DatabaseSync(`${root}/.symbra/index.db`, { readOnly: true });
const stored = new Set(db.prepare('select path from files').all().map(r => r.path));
for (const f of scanRepo({ root })) if (!stored.has(f.path)) console.log('missing', f.path, f.language, f.size);
