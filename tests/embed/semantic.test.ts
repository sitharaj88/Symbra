/**
 * End-to-end semantic search over the fixture repo. Runs only when the optional
 * @huggingface/transformers package is installed and the model is already cached
 * (it never downloads); otherwise the suite is skipped.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexRepo } from '../../src/index/indexer.js';
import { Store } from '../../src/store/db.js';
import { search } from '../../src/query/search.js';
import { embedRepo, semanticSearch, hasVectors, loadEmbedder, searchHybrid, exploreHybrid, vectorCount } from '../../src/embed/index.js';

const root = fileURLToPath(new URL('../fixtures/repo', import.meta.url));
const embedder = await loadEmbedder({ allowDownload: false, log: () => {} });

describe.skipIf(!embedder)('semantic search (model available)', () => {
  let dbDir: string;
  let store: Store;

  beforeAll(async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'symbra-embed-test-'));
    await indexRepo({ root, dbPath: join(dbDir, 'index.db') });
    store = new Store(join(dbDir, 'index.db'));
  }, 60_000);
  afterAll(() => {
    store?.close();
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  });

  it('embeds the fixture incrementally', async () => {
    expect(hasVectors(store)).toBe(false);
    expect(await semanticSearch(store, 'greet a person')).toEqual([]);
    const first = await embedRepo(store, { log: () => {} });
    expect(first.backend).toBe(embedder!.backend);
    expect(first.embedded).toBeGreaterThan(3);
    expect(first.vectors).toBe(first.embedded);
    expect(hasVectors(store)).toBe(true);
    const again = await embedRepo(store, { log: () => {} });
    expect(again.embedded).toBe(0);
    expect(again.unchanged).toBe(first.embedded);
    expect(vectorCount(store)).toBe(first.embedded);
  }, 60_000);

  it('ranks UserService.greet first for "greet a person"', async () => {
    const hits = await semanticSearch(store, 'greet a person', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.symbol.fqn).toBe('UserService.greet');
    expect(hits[0]!.cosine).toBeGreaterThan(0.5);
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
  }, 30_000);

  it('fuses into search() and explore() without changing the lexical-only path', async () => {
    const lexical = search(store, 'greet a person');
    const fused = await searchHybrid(store, 'greet a person', { limit: 5 });
    expect(fused[0]!.symbol.fqn).toBe('UserService.greet');
    expect(fused[0]!.cosine).toBeDefined();
    expect(search(store, 'greet a person')).toEqual(lexical);
    const pack = await exploreHybrid(store, 'greet a person', { root, budget: 800, includeSource: false });
    expect(pack.symbols[0]!.fqn).toBe('UserService.greet');
  }, 30_000);
});
