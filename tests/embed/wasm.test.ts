/**
 * The WebAssembly fallback backend. `@huggingface/transformers` statically imports
 * `onnxruntime-node`, so on platforms without a prebuilt native binary the only way to run
 * the model is the injected `onnxruntime-web` runtime; `SYMBRA_EMBED_BACKEND=wasm` takes
 * that same path deliberately. Vitest gives each test file its own module registry, so the
 * loader singleton here is independent of the native-backend test file.
 *
 * Skipped unless the optional package and the cached model are both present (never downloads).
 */
import { describe, it, expect } from 'vitest';

process.env.SYMBRA_EMBED_BACKEND = 'wasm';
const { loadEmbedder, modelCached, BACKEND_WASM } = await import('../../src/embed/model.js');
const { cosine } = await import('../../src/embed/vectors.js');

let available = false;
try {
  available = modelCached() && !!(await import('node:module')).createRequire(import.meta.url).resolve('@huggingface/transformers');
} catch {
  available = false;
}
const embedder = available ? await loadEmbedder({ allowDownload: false, log: () => {} }) : null;

describe.skipIf(!embedder)('wasm backend fallback', () => {
  it('runs the model on WebAssembly and embeds meaningfully', async () => {
    expect(embedder!.backend).toBe(BACKEND_WASM);
    expect(embedder!.dim).toBe(384);
    const [greet, db, query] = await embedder!.embed(['method greet. greet. say hello to a user by name', 'class ConnectionPool. database connection pooling', 'greet a person']);
    expect(greet!.length).toBe(384);
    // unit length, as the pipeline normalises
    expect(cosine(greet!, greet!)).toBeCloseTo(1, 5);
    // the semantically closer symbol wins, by a wide margin
    expect(cosine(greet!, query!)).toBeGreaterThan(0.7);
    expect(cosine(greet!, query!)).toBeGreaterThan(cosine(db!, query!) + 0.2);
  }, 60_000);
});
