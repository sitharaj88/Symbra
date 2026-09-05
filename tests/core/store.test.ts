import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SCHEMA_VERSION, BUSY_TIMEOUT_MS } from '../../src/store/db.js';

const dirs: string[] = [];
function dbPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'symbra-store-'));
  dirs.push(d);
  return join(d, 'index.db');
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('Store', () => {
  it('sets a busy timeout so a second process waits instead of throwing "database is locked"', () => {
    const path = dbPath();
    const a = new Store(path);
    const b = new Store(path); // the MCP server alongside the indexer
    try {
      for (const s of [a, b]) expect(Number(s.prep('PRAGMA busy_timeout').get().timeout)).toBe(BUSY_TIMEOUT_MS);
      a.setMeta('x', '1');
      expect(b.getMeta('x')).toBe('1');
    } finally {
      a.close();
      b.close();
    }
  });

  it('rebuilds the tables when the schema version changed, instead of only emptying them', () => {
    const path = dbPath();
    let store = new Store(path);
    store.db.exec('ALTER TABLE symbols ADD COLUMN stale_column TEXT');
    store.db.exec("CREATE TABLE leftover(a TEXT)");
    store.prep('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('schema_version', String(SCHEMA_VERSION - 1));
    store.close();

    store = new Store(path);
    try {
      const cols = (store.prep('PRAGMA table_info(symbols)').all() as { name: string }[]).map((c) => c.name);
      expect(cols).not.toContain('stale_column');
      expect(store.prep("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'leftover'").get().n).toBe(0);
      expect(store.getMeta('schema_version')).toBe(String(SCHEMA_VERSION));
      // The FTS index and the embeddings table must come back too.
      store.prep("INSERT INTO symbols_fts(id, name, split_name, fqn, signature, doc, file) VALUES('a','a','a','a','','','f')").run();
      expect(store.prep("SELECT COUNT(*) AS n FROM embeddings").get().n).toBe(0);
    } finally {
      store.close();
    }
  });

  it('deleteFile removes a file’s FTS rows and nothing else', () => {
    const path = dbPath();
    const store = new Store(path);
    try {
      const ins = store.prep("INSERT INTO symbols_fts(id, name, split_name, fqn, signature, doc, file) VALUES(?,?,?,?,'','',?)");
      const insSym = store.prep("INSERT INTO symbols(id, file, ordinal, kind, name, fqn, start_line, end_line, start_byte, end_byte) VALUES(?,?,0,'function',?,?,1,1,0,1)");
      for (let i = 0; i < 400; i++) {
        const file = i % 2 ? 'keep.py' : 'drop.py';
        ins.run(`${file}::f${i}`, `f${i}`, `f ${i}`, `f${i}`, file);
        insSym.run(`${file}::f${i}`, file, `f${i}`, `f${i}`);
      }
      const t0 = performance.now();
      store.deleteFile('drop.py');
      const ms = performance.now() - t0;
      expect(store.prep("SELECT COUNT(*) AS n FROM symbols_fts WHERE file = 'drop.py'").get().n).toBe(0);
      expect(store.prep("SELECT COUNT(*) AS n FROM symbols_fts WHERE file = 'keep.py'").get().n).toBe(200);
      expect(store.prep("SELECT COUNT(*) AS n FROM symbols WHERE file = 'keep.py'").get().n).toBe(200);
      expect(ms).toBeLessThan(2000);
    } finally {
      store.close();
    }
  });
});
