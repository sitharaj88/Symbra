import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ExtractPool } from '../../src/index/pool.js';

const SRC = 'def one():\n    return 1\n';
// The pool only starts threads when a built ./worker.js sits next to it; running from sources it
// extracts in-process, which is the "no live worker" path.
const builtWorker = fileURLToPath(new URL('../../dist/index/worker.js', import.meta.url));

describe('ExtractPool', () => {
  it('extracts in-process when no worker can be started', async () => {
    const pool = new ExtractPool();
    try {
      expect(pool.size).toBe(0);
      const ir = await pool.extract('a.py', SRC);
      expect(ir?.definitions.map((d) => d.fqn)).toEqual(['one']);
    } finally {
      await pool.close();
    }
  });

  it.skipIf(!existsSync(builtWorker))('keeps working after every worker dies', async () => {
    // Load the built pool so real worker threads are available.
    const { ExtractPool: BuiltPool } = (await import(fileURLToPath(new URL('../../dist/index/pool.js', import.meta.url)))) as { ExtractPool: typeof ExtractPool };
    const pool = new BuiltPool(2);
    try {
      expect(pool.size).toBe(2);
      expect(await pool.extract('warm.py', SRC)).toBeTruthy();

      // Kill both workers behind the pool's back and wait for the 'exit' handlers.
      const workers = (pool as unknown as { workers: { terminate(): Promise<number> }[] }).workers;
      await Promise.all(workers.map((w) => w.terminate()));
      await new Promise((res) => setTimeout(res, 100));
      expect(pool.liveWorkers).toBe(0);

      // Dead workers must not be handed jobs: this would hang forever before the fix.
      const irs = await Promise.all([pool.extract('a.py', SRC), pool.extract('b.py', SRC)]);
      for (const ir of irs) expect(ir?.definitions.map((d) => d.fqn)).toEqual(['one']);
    } finally {
      await pool.close();
    }
  }, 15000);
});
