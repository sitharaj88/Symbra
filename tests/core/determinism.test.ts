import { describe, it, expect, afterEach } from 'vitest';
import { indexRepo } from '../../src/index/indexer.js';
import { Store } from '../../src/store/db.js';
import { computeMetrics, loadRows } from '../../src/analyze/metrics.js';
import { computeCommunities } from '../../src/analyze/communities.js';
import { makeRepo, type TempRepo } from './helpers.js';

const repos: TempRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

function assignments(dbPath: string): string[] {
  const store = new Store(dbPath);
  try {
    return (store.prep('SELECT symbol, community FROM communities WHERE level = 0 ORDER BY symbol').all() as { symbol: string; community: number }[]).map((r) => `${r.symbol}=${r.community}`);
  } finally {
    store.close();
  }
}

describe('determinism', () => {
  it('gives identical community ids after an edit and a revert', async () => {
    const files: Record<string, string> = {};
    // One densely connected package: every function calls three others, so Louvain has genuinely
    // ambiguous splits and its answer depends on the order the nodes are visited in.
    const N = 12;
    const M = 4;
    for (let f = 0; f < N; f++) {
      const lines: string[] = [];
      for (let g = 0; g < N; g++) if (g !== f) lines.push(`from pkg.mod${g} import fn${g}_0, fn${g}_1, fn${g}_2, fn${g}_3`);
      lines.push('');
      for (let i = 0; i < M; i++) {
        lines.push(`def fn${f}_${i}():`);
        lines.push(`    return fn${(f + 1) % N}_${i}() + fn${(f + 5) % N}_${(i + 1) % M}() + fn${(f + 7) % N}_${(i + 3) % M}()`);
        lines.push('');
      }
      files[`pkg/mod${f}.py`] = lines.join('\n');
    }
    const r = makeRepo(files);
    repos.push(r);

    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const before = assignments(r.dbPath);
    expect(before.length).toBeGreaterThan(10);

    // Incremental edits delete a file's rows and re-append them, so afterwards the table's
    // physical order differs from the original even though the content is identical again.
    const original = files['pkg/mod0.py']!;
    r.write('pkg/mod0.py', original + '\n\ndef extra0():\n    return fn0_0()\n');
    await indexRepo({ root: r.root, dbPath: r.dbPath });
    r.write('pkg/mod0.py', original);
    await indexRepo({ root: r.root, dbPath: r.dbPath });

    // Recompute in place (a one-file change defers the analysis by design).
    const store = new Store(r.dbPath);
    try {
      const rows = loadRows(store);
      computeMetrics(store, rows);
      computeCommunities(store, rows);
    } finally {
      store.close();
    }

    // Node order comes from an ORDER BY, not from SQLite's insertion history, so reverting the
    // edit must reproduce the numbering exactly.
    expect(assignments(r.dbPath)).toEqual(before);
  });
});
