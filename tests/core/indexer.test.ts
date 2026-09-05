import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync } from 'node:fs';
import { indexRepo } from '../../src/index/indexer.js';
import { Store } from '../../src/store/db.js';
import { makeRepo, type TempRepo } from './helpers.js';

const repos: TempRepo[] = [];
function repo(files: Record<string, string> = {}): TempRepo {
  const r = makeRepo(files);
  repos.push(r);
  return r;
}
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

describe('incremental indexing', () => {
  it('does not re-hash a non-ASCII file on every run (size is stored in bytes)', async () => {
    // "héllo — ünïcode" is longer in UTF-8 bytes than in JS chars, so a char-length size would
    // never match the scanner's byte size and the file would look changed forever.
    const r = repo({ 'a.py': 'def grüße():\n    """héllo — ünïcode"""\n    return "☃" * 3\n' });
    const first = await indexRepo({ root: r.root, dbPath: r.dbPath });
    expect(first.changed).toBe(1);
    const second = await indexRepo({ root: r.root, dbPath: r.dbPath });
    expect(second.changed).toBe(0);
    const third = await indexRepo({ root: r.root, dbPath: r.dbPath });
    expect(third.changed).toBe(0);
  });

  it('leaves indexed_at alone on a run that changed nothing', async () => {
    const r = repo({ 'a.py': 'def one():\n    return 1\n' });
    await indexRepo({ root: r.root, dbPath: r.dbPath });
    const store = new Store(r.dbPath);
    const stamp = store.getMeta('indexed_at');
    const generation = store.getMeta('generation');
    store.close();
    expect(stamp).toBeTruthy();
    await new Promise((res) => setTimeout(res, 5));
    await indexRepo({ root: r.root, dbPath: r.dbPath });
    const s2 = new Store(r.dbPath);
    // The cached-graph key is built from indexed_at, so a no-op run must not invalidate it.
    expect(s2.getMeta('indexed_at')).toBe(stamp);
    expect(s2.getMeta('generation')).toBe(generation);
    expect(Number(s2.getMeta('checked_at'))).toBeGreaterThanOrEqual(Number(stamp));
    s2.close();

    r.write('a.py', 'def one():\n    return 2\n');
    await indexRepo({ root: r.root, dbPath: r.dbPath });
    const s3 = new Store(r.dbPath);
    expect(s3.getMeta('indexed_at')).not.toBe(stamp);
    expect(Number(s3.getMeta('generation'))).toBe(Number(generation) + 1);
    s3.close();
  });

  it('survives a file that becomes unreadable between the scan and the change check', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root can read anything
    const r = repo({ 'a.py': 'def one():\n    return 1\n', 'b.py': 'def two():\n    return 2\n' });
    await indexRepo({ root: r.root, dbPath: r.dbPath });
    // Change b.py so the indexer must read it to compare hashes, then make the read fail.
    r.write('b.py', 'def two():\n    return 22\n');
    chmodSync(`${r.root}/b.py`, 0o000);
    try {
      const stats = await indexRepo({ root: r.root, dbPath: r.dbPath });
      expect(stats.files).toBe(2);
    } finally {
      chmodSync(`${r.root}/b.py`, 0o644);
    }
  });

  it('re-resolves imports that never resolved once the missing module appears', async () => {
    const r = repo({ 'a.py': 'from b import helper\n\n\ndef caller():\n    return helper()\n' });
    await indexRepo({ root: r.root, dbPath: r.dbPath });
    let store = new Store(r.dbPath);
    expect(store.prep('SELECT resolved FROM imports WHERE file = ?').get('a.py').resolved).toBe(null);
    store.close();

    r.write('b.py', 'def helper():\n    return 1\n');
    await indexRepo({ root: r.root, dbPath: r.dbPath });
    store = new Store(r.dbPath);
    expect(store.prep('SELECT resolved FROM imports WHERE file = ?').get('a.py').resolved).toBe('b.py');
    expect(store.edgesFrom('a.py::caller').some((e) => e.kind === 'calls' && e.dst === 'b.py::helper')).toBe(true);
    store.close();
  });

  it('resolves an inherited member through an extends edge produced in the same incremental pass', async () => {
    const r = repo({
      'base.py': 'class Base:\n    def helper(self):\n        return 1\n',
      'sub.py': 'from base import Base\n\n\nclass Sub:\n    def run(self):\n        return 0\n',
    });
    await indexRepo({ root: r.root, dbPath: r.dbPath });
    // Now add the inheritance *and* the inherited call in one edit: the single incremental pass
    // has to learn Sub -> Base before it resolves self.helper().
    r.write('sub.py', 'from base import Base\n\n\nclass Sub(Base):\n    def run(self):\n        return self.helper()\n');
    const stats = await indexRepo({ root: r.root, dbPath: r.dbPath });
    expect(stats.changed).toBe(1);
    const store = new Store(r.dbPath);
    const edges = store.edgesFrom('sub.py::Sub.run');
    expect(edges.some((e) => e.kind === 'calls' && e.dst === 'base.py::Base.helper')).toBe(true);
    store.close();
  });

  it('drops config keys nobody reads any more and re-resolves files pointing into a deleted one', async () => {
    const r = repo({
      'a.py': 'import os\n\n\ndef token():\n    return os.environ["SYMBRA_TEST_TOKEN"]\n',
      'b.py': 'from a import token\n\n\ndef use():\n    return token()\n',
    });
    await indexRepo({ root: r.root, dbPath: r.dbPath });
    let store = new Store(r.dbPath);
    expect(store.getSymbol('env::SYMBRA_TEST_TOKEN')?.kind).toBe('config_key');
    store.close();

    r.remove('a.py');
    r.write('b.py', 'def use():\n    return 0\n');
    await indexRepo({ root: r.root, dbPath: r.dbPath });
    store = new Store(r.dbPath);
    expect(store.getSymbol('env::SYMBRA_TEST_TOKEN')).toBe(null);
    // No edge may survive pointing into the deleted file's symbols.
    const dangling = store.prep("SELECT COUNT(*) AS n FROM edges WHERE dst LIKE 'a.py%'").get().n;
    expect(dangling).toBe(0);
    store.close();
  });

  it('defers PageRank and communities for a small change and marks the analysis stale', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 8; i++) files[`m${i}.py`] = `def f${i}():\n    return ${i}\n`;
    const r = repo(files);
    const full = await indexRepo({ root: r.root, dbPath: r.dbPath });
    expect(full.analysisStale).toBe(false);
    let store = new Store(r.dbPath);
    const analyzedAt = store.getMeta('analyzed_at');
    store.close();

    r.write('m0.py', 'def f0():\n    return 100\n');
    const small = await indexRepo({ root: r.root, dbPath: r.dbPath });
    expect(small.changed).toBe(1);
    expect(small.analysisStale).toBe(true);
    store = new Store(r.dbPath);
    expect(store.getMeta('analysis_stale')).toBe('1');
    expect(store.getMeta('analyzed_at')).toBe(analyzedAt); // Louvain did not run again
    store.close();

    // A full run always recomputes and clears the flag.
    const again = await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    expect(again.analysisStale).toBe(false);
    store = new Store(r.dbPath);
    expect(store.getMeta('analysis_stale')).toBe('0');
    store.close();
  });
});
