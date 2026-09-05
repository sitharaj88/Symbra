import { describe, it, expect } from 'vitest';
import { Store } from '../../src/store/db.js';
import { computeCommunities } from '../../src/analyze/communities.js';

describe('community detection at scale', () => {
  it('does not overflow the stack above ~125K symbols', () => {
    // `Math.max(...assign)` spreads one argument per symbol; V8 throws
    // "Maximum call stack size exceeded" past roughly 125K.
    const store = new Store(':memory:');
    try {
      store.transaction(() => {
        const ins = store.prep("INSERT INTO symbols(id, file, ordinal, kind, name, fqn, start_line, end_line, start_byte, end_byte) VALUES(?, 'f.py', ?, 'function', ?, ?, 1, 1, 0, 1)");
        for (let i = 0; i < 140_000; i++) ins.run(`f.py::fn${i}`, i, `fn${i}`, `fn${i}`);
      });
      expect(() => computeCommunities(store)).not.toThrow();
      expect(store.prep('SELECT COUNT(*) AS n FROM communities').get().n).toBe(140_000);
    } finally {
      store.close();
    }
  }, 60_000);
});
