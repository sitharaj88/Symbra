/**
 * Vectors must survive an ordinary re-index. `deleteFile()` no longer drops `embeddings` rows
 * (symbol ids are deterministic, so an unchanged symbol's vector is still valid after
 * re-extraction); orphaned rows (symbol id no longer in `symbols`) are pruned by `embedRepo`
 * instead. `indexRepo` also auto-embeds changed/new symbols once the semantic tier has been
 * opted into and the model is cached locally.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexRepo } from '../../src/index/indexer.js';
import { Store } from '../../src/store/db.js';
import { embedRepo, loadEmbedder } from '../../src/embed/index.js';

const fixture = fileURLToPath(new URL('../fixtures/repo', import.meta.url));
const embedder = await loadEmbedder({ allowDownload: false, log: () => {} });
const GREET_ID = 'src/services/user_service.py::UserService.greet';
const SAVE_ID = 'src/services/store.py::Store.save';

/** A private copy of the fixture repo so tests can edit/delete files freely. */
function copyFixture(): { root: string; dbPath: string; base: string } {
  const base = mkdtempSync(join(tmpdir(), 'symbra-embed-persist-'));
  const root = join(base, 'repo');
  cpSync(fixture, root, { recursive: true });
  return { root, dbPath: join(base, 'db', 'index.db'), base };
}

function insertFakeEmbedding(store: Store, symbol: string, file: string, hash: string) {
  const vec = new Float32Array(4); // dim mismatches the real model, which is exactly the point: this row is never touched by the model path in these tests
  store.prep('INSERT OR REPLACE INTO embeddings(symbol, file, model, dim, text_hash, vec) VALUES(?,?,?,?,?,?)').run(symbol, file, 'fake-model', vec.length, hash, new Uint8Array(vec.buffer));
}

function getEmbedding(store: Store, symbol: string): { text_hash: string } | undefined {
  return store.prep('SELECT text_hash FROM embeddings WHERE symbol = ?').get(symbol) as { text_hash: string } | undefined;
}

describe('embeddings survive re-index (always runs, no model needed)', () => {
  let dirs: { root: string; dbPath: string; base: string }[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d.base, { recursive: true, force: true });
    dirs = [];
  });

  it('deleteFile() no longer drops embeddings: a re-extracted file keeps its unchanged vectors', async () => {
    const d = copyFixture();
    dirs.push(d);
    await indexRepo({ root: d.root, dbPath: d.dbPath, embed: false });
    const store = new Store(d.dbPath);
    insertFakeEmbedding(store, GREET_ID, 'src/services/user_service.py', 'fake-hash-1');
    store.close();

    // Touch the file with a genuine content change (an added comment) so the indexer really
    // calls deleteFile() + insertFileIR() for it, while UserService.greet's fqn/id is unchanged.
    const path = join(d.root, 'src/services/user_service.py');
    const { readFileSync, writeFileSync } = await import('node:fs');
    writeFileSync(path, `# a harmless comment\n${readFileSync(path, 'utf8')}`);

    const stats = await indexRepo({ root: d.root, dbPath: d.dbPath, embed: false });
    expect(stats.changed).toBeGreaterThan(0);

    const store2 = new Store(d.dbPath);
    // The symbol still exists (re-extraction produced the same deterministic id)...
    expect(store2.getSymbol(GREET_ID)).not.toBeNull();
    // ...and its fake vector row was not wiped by the re-index.
    const row = getEmbedding(store2, GREET_ID);
    expect(row?.text_hash).toBe('fake-hash-1');
    store2.close();
  });

  it('embedRepo() prunes embeddings whose symbol no longer exists (e.g. a deleted file)', async () => {
    const d = copyFixture();
    dirs.push(d);
    await indexRepo({ root: d.root, dbPath: d.dbPath, embed: false });
    const store = new Store(d.dbPath);
    expect(store.getSymbol(SAVE_ID)).not.toBeNull();
    insertFakeEmbedding(store, SAVE_ID, 'src/services/store.py', 'fake-hash-2');
    insertFakeEmbedding(store, GREET_ID, 'src/services/user_service.py', 'fake-hash-3');
    store.close();

    const { rmSync: rm } = await import('node:fs');
    rm(join(d.root, 'src/services/store.py'), { force: true });
    // user_service.py imports Store, so removing store.py without adjusting the import is fine
    // for this test: only symbol/embedding survival across indexing is under test here.
    await indexRepo({ root: d.root, dbPath: d.dbPath, embed: false });

    const store2 = new Store(d.dbPath);
    expect(store2.getSymbol(SAVE_ID)).toBeNull(); // the symbol is gone with its file
    expect(getEmbedding(store2, SAVE_ID)).toBeDefined(); // deleteFile() no longer prunes it...
    store2.close();

    // ...pruning is embedRepo's job. It always removes orphaned rows as its first step, even
    // when the model itself is unavailable (it never needs the model to know a symbol id
    // no longer exists in `symbols`).
    const store3 = new Store(d.dbPath);
    const stats = await embedRepo(store3, { log: () => {} });
    expect(stats.removed).toBeGreaterThanOrEqual(1);
    expect(getEmbedding(store3, SAVE_ID)).toBeUndefined();
    // The still-valid symbol's row (any model) is untouched by pruning.
    expect(getEmbedding(store3, GREET_ID)).toBeDefined();
    store3.close();
  });
});

describe.skipIf(!embedder)('indexRepo auto-embed (requires the model cached locally; skipped otherwise)', () => {
  let dirs: { root: string; dbPath: string; base: string }[] = [];

  afterAll(() => {
    for (const d of dirs) rmSync(d.base, { recursive: true, force: true });
    dirs = [];
  });

  it(
    'embeds a changed symbol on the next index and keeps unchanged ones as-is',
    async () => {
      const d = copyFixture();
      dirs.push(d);
      await indexRepo({ root: d.root, dbPath: d.dbPath, embed: false });
      const store = new Store(d.dbPath);
      const first = await embedRepo(store, { log: () => {} });
      expect(first.embedded).toBeGreaterThan(3);
      const beforeGreet = getEmbedding(store, GREET_ID);
      const beforeSave = getEmbedding(store, SAVE_ID);
      expect(beforeGreet).toBeDefined();
      expect(beforeSave).toBeDefined();
      store.close();

      // Edit one file: change greet()'s doc/signature-relevant text so its hash changes.
      const { readFileSync, writeFileSync } = await import('node:fs');
      const path = join(d.root, 'src/services/user_service.py');
      writeFileSync(path, readFileSync(path, 'utf8').replace('def greet(self, name: str) -> str:', 'def greet(self, name: str) -> str:\n        """Say hello to a person by name."""'));

      const t0 = Date.now();
      const stats = await indexRepo({ root: d.root, dbPath: d.dbPath }); // default embed: true
      const ms = Date.now() - t0;
      // Reported for the task's timing ask: post-index auto-embed cost on a one-file edit.
      // eslint-disable-next-line no-console
      console.log(`[auto-embed timing] indexRepo (with auto-embed) on a one-file edit: ${ms}ms, files changed: ${stats.changed}`);

      const store2 = new Store(d.dbPath);
      const afterGreet = getEmbedding(store2, GREET_ID);
      const afterSave = getEmbedding(store2, SAVE_ID);
      expect(afterGreet).toBeDefined();
      expect(afterGreet!.text_hash).not.toBe(beforeGreet!.text_hash); // re-embedded
      expect(afterSave).toBeDefined();
      expect(afterSave!.text_hash).toBe(beforeSave!.text_hash); // untouched, hash unchanged
      store2.close();
    },
    60_000,
  );
});
