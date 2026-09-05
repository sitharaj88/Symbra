/**
 * Semantic tier: embed symbols into the `embeddings` table and answer questions by cosine
 * similarity. Everything here degrades to "no results" when the model is unavailable.
 */
import type { Store, SymbolRow } from '../store/db.js';
import type { SearchHit } from '../query/search.js';
import { loadEmbedder, embeddingsDisabled, MODEL_ID, MODEL_DIM } from './model.js';
import { DEFAULT_EMBED_KINDS, symbolText, textHash } from './text.js';
import { buildMatrix, cosineTopK, decodeVec, encodeVec, type VectorMatrix } from './vectors.js';

export interface EmbedOptions {
  /** Re-embed every symbol instead of only new/changed ones. */
  full?: boolean;
  /** Symbol kinds to embed (default: DEFAULT_EMBED_KINDS). */
  kinds?: readonly string[];
  batchSize?: number;
  /** Allow downloading the model into the cache (default true for this command). */
  allowDownload?: boolean;
  log?: (message: string) => void;
  progress?: (done: number, total: number, perSecond: number) => void;
  downloadProgress?: (file: string, pct: number) => void;
}

export interface EmbedStats {
  model: string;
  backend: string | null;
  /** Symbols of the selected kinds in non-test files. */
  candidates: number;
  embedded: number;
  unchanged: number;
  /** Orphan rows removed (symbols that no longer exist). */
  removed: number;
  /** Vectors in the table after the run. */
  vectors: number;
  ms: number;
  /** Embedding throughput (symbols per second) over the embedding phase only. */
  perSecond: number;
}

interface CandidateRow {
  id: string;
  file: string;
  kind: SymbolRow['kind'];
  name: string;
  fqn: string;
  signature: string;
  doc: string;
  parent: string | null;
}

export function vectorCount(store: Store): number {
  return (store.prep('SELECT COUNT(*) AS n FROM embeddings').get() as { n: number }).n;
}

/** True when the store holds vectors and the semantic tier is not switched off. */
export function hasVectors(store: Store): boolean {
  return !embeddingsDisabled() && vectorCount(store) > 0;
}

/** Embed symbols that have no vector yet or whose text changed. Incremental by text hash. */
export async function embedRepo(store: Store, opts: EmbedOptions = {}): Promise<EmbedStats> {
  const t0 = Date.now();
  const kinds = opts.kinds?.length ? opts.kinds : DEFAULT_EMBED_KINDS;
  const batch = Math.max(1, opts.batchSize ?? 64);
  const log = opts.log ?? (() => {});

  const removed = Number(store.prep('DELETE FROM embeddings WHERE symbol NOT IN (SELECT id FROM symbols)').run().changes);
  const existing = new Map<string, { text_hash: string; model: string }>();
  for (const r of store.prep('SELECT symbol, text_hash, model FROM embeddings').all() as { symbol: string; text_hash: string; model: string }[]) existing.set(r.symbol, r);
  const modelChanged = [...existing.values()].some((e) => e.model !== MODEL_ID);
  const full = !!opts.full || modelChanged;
  if (full && existing.size) {
    store.prep('DELETE FROM embeddings').run();
    existing.clear();
  }

  const rows = store
    .prep(`SELECT s.id, s.file, s.kind, s.name, s.fqn, s.signature, s.doc, s.parent FROM symbols s JOIN files f ON f.path = s.file WHERE f.is_test = 0 AND s.kind IN (${kinds.map(() => '?').join(',')}) ORDER BY s.file, s.ordinal`)
    .all(...kinds) as CandidateRow[];
  const parentFqn = new Map<string, string | null>();
  const parentOf = (id: string | null): string | null => {
    if (!id) return null;
    let v = parentFqn.get(id);
    if (v === undefined) {
      v = store.getSymbol(id)?.fqn ?? null;
      parentFqn.set(id, v);
    }
    return v;
  };
  const todo: { id: string; file: string; text: string; hash: string }[] = [];
  let unchanged = 0;
  for (const r of rows) {
    const text = symbolText(r, parentOf(r.parent));
    const hash = textHash(text, MODEL_ID);
    const e = existing.get(r.id);
    if (e && e.text_hash === hash) {
      unchanged++;
      continue;
    }
    todo.push({ id: r.id, file: r.file, text, hash });
  }
  log(`${rows.length} candidate symbols: ${todo.length} to embed, ${unchanged} unchanged, ${removed} orphans removed`);

  const base = { model: MODEL_ID, candidates: rows.length, unchanged, removed };
  if (!todo.length) return { ...base, backend: null, embedded: 0, vectors: vectorCount(store), ms: Date.now() - t0, perSecond: 0 };

  const embedder = await loadEmbedder({ allowDownload: opts.allowDownload ?? true, log: opts.log, progress: opts.downloadProgress });
  if (!embedder) return { ...base, backend: null, embedded: 0, vectors: vectorCount(store), ms: Date.now() - t0, perSecond: 0 };

  const ins = store.prep('INSERT OR REPLACE INTO embeddings(symbol, file, model, dim, text_hash, vec) VALUES(?,?,?,?,?,?)');
  const tEmbed = Date.now();
  let done = 0;
  // Sort each chunk by text length so a batch pads to a similar token count; chunking keeps
  // progress steady and file order roughly intact.
  const CHUNK = batch * 8;
  for (let i = 0; i < todo.length; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK).sort((a, b) => a.text.length - b.text.length || (a.id < b.id ? -1 : 1));
    for (let j = 0; j < chunk.length; j += batch) {
      const items = chunk.slice(j, j + batch);
      const vecs = await embedder.embed(items.map((x) => x.text));
      store.transaction(() => {
        for (let k = 0; k < items.length; k++) {
          const it = items[k]!;
          const v = vecs[k];
          if (!v) continue;
          ins.run(it.id, it.file, embedder.model, v.length, it.hash, encodeVec(v));
        }
      });
      done += items.length;
      opts.progress?.(done, todo.length, done / Math.max(0.001, (Date.now() - tEmbed) / 1000));
    }
  }
  const embedMs = Date.now() - tEmbed;
  store.setMeta('embedded_at', String(Date.now()));
  store.setMeta('embed_model', embedder.model);
  return { ...base, backend: embedder.backend, embedded: done, vectors: vectorCount(store), ms: Date.now() - t0, perSecond: done / Math.max(0.001, embedMs / 1000) };
}

// ---- query side ----

const matrixCache = new WeakMap<Store, { key: string; matrix: VectorMatrix }>();

/** Store generation the cached matrix belongs to: row count plus the index and embed timestamps. */
function generation(store: Store): string {
  return `${vectorCount(store)}|${store.getMeta('indexed_at') ?? ''}|${store.getMeta('embedded_at') ?? ''}`;
}

/** All vectors as one Float32Array matrix, loaded once per store generation. */
export function loadMatrix(store: Store): VectorMatrix {
  const key = generation(store);
  const c = matrixCache.get(store);
  if (c && c.key === key) return c.matrix;
  const rows = store.prep('SELECT symbol, dim, vec FROM embeddings WHERE model = ? ORDER BY symbol').all(MODEL_ID) as { symbol: string; dim: number; vec: Uint8Array }[];
  const dim = rows[0]?.dim ?? MODEL_DIM;
  const decoded: { id: string; vec: Float32Array }[] = [];
  for (const r of rows) {
    if (r.dim !== dim) continue;
    const v = decodeVec(r.vec, dim);
    if (v) decoded.push({ id: r.symbol, vec: v });
  }
  const matrix = buildMatrix(decoded, dim);
  matrixCache.set(store, { key, matrix });
  return matrix;
}

/** BGE v1.5 is trained with this instruction on the query side of short-query / passage retrieval. */
export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

export interface SemanticOptions {
  /** Drop hits below this cosine (default 0: keep all). */
  minScore?: number;
  /** Prefix the question with the BGE retrieval instruction (default true). */
  instruct?: boolean;
}

/**
 * Rank symbols by cosine similarity between the question and their vectors.
 * Returns SearchHit objects whose `score` (and `cosine`) is the cosine similarity.
 * Empty when there are no vectors or the model cannot be loaded (never downloads).
 */
export async function semanticSearch(store: Store, question: string, limit = 20, opts: SemanticOptions = {}): Promise<SearchHit[]> {
  const q = question.trim();
  if (!q || limit <= 0 || !hasVectors(store)) return [];
  const embedder = await loadEmbedder({ allowDownload: false });
  if (!embedder) return [];
  const matrix = loadMatrix(store);
  if (!matrix.ids.length) return [];
  const [qv] = await embedder.embed([(opts.instruct ?? true) ? QUERY_PREFIX + q : q]);
  if (!qv) return [];
  const top = cosineTopK(matrix, qv, limit * 2, opts.minScore ?? 0);
  const hits: SearchHit[] = [];
  for (const t of top) {
    const s = store.getSymbol(t.id);
    if (!s) continue; // vector outlives its symbol until the next `symbra embed`
    const m = (store.prep('SELECT pagerank, callers FROM metrics WHERE symbol = ?').get(s.id) as { pagerank: number; callers: number } | undefined) ?? { pagerank: 0, callers: 0 };
    const community = (store.prep('SELECT community FROM communities WHERE symbol = ? AND level = 0').get(s.id) as { community: number } | undefined)?.community ?? null;
    hits.push({ symbol: s, score: t.score, cosine: t.score, pagerank: m.pagerank, callers: m.callers, community });
    if (hits.length >= limit) break;
  }
  return hits;
}
