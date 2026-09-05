import type { Store } from '../store/db.js';

/** Edge weights for PageRank / community detection. */
export const EDGE_WEIGHT: Record<string, number> = {
  calls: 1.0,
  extends: 0.9,
  implements: 0.9,
  references: 0.5,
  decorates: 0.4,
  passes: 0.7,
  imports: 0.3,
  defines_route: 0.8,
  tests: 0.2,
  reads_config: 0.2,
  contains: 0.15,
};

export const KIND_IDS: Record<string, number> = { calls: 1, extends: 2, implements: 3, references: 4, decorates: 5, imports: 6, defines_route: 7, tests: 8, reads_config: 9, contains: 10, passes: 11 };
export const KIND_NAMES: string[] = ['related', 'calls', 'extends', 'implements', 'references', 'decorates', 'imports', 'defines_route', 'tests', 'reads_config', 'contains', 'passes'];
/** Structural kinds preferred when explaining how two symbols connect. */
export const STRUCTURAL_KIND_IDS = new Set([1, 2, 3, 5, 7, 10, 11]);

export interface Graph {
  ids: string[];
  index: Map<string, number>;
  /** adjacency: out[i] = [[j, w, kindId], ...] */
  out: [number, number, number][][];
  in: [number, number, number][][];
}

/** Load the symbol graph (non-module symbols plus modules) into memory. */
export interface EdgeRow {
  src: string;
  dst: string;
  kind: string;
  confidence: number;
}
export interface SymRow {
  id: string;
  parent: string | null;
  kind: string;
  file: string;
}

/** Raw rows shared by every graph projection built during one analysis run. */
export function loadRows(store: Store): { symbols: SymRow[]; edges: EdgeRow[]; testFiles: Set<string> } {
  return {
    // ORDER BY is load-bearing: node order decides Louvain's tie-breaking, and without it the
    // order is SQLite's insertion history, so an edit-and-revert would renumber communities.
    symbols: store.prep('SELECT id, parent, kind, file FROM symbols ORDER BY id').all() as SymRow[],
    edges: store.prep('SELECT src, dst, kind, confidence FROM edges ORDER BY src, dst, kind, file, line').all() as EdgeRow[],
    testFiles: new Set((store.prep('SELECT path FROM files WHERE is_test = 1').all() as { path: string }[]).map((r) => r.path)),
  };
}

export function loadGraph(store: Store, opts: { includeModules?: boolean; includeContains?: boolean; excludeTests?: boolean; excludeDocs?: boolean; rows?: ReturnType<typeof loadRows> } = {}): Graph {
  const ids: string[] = [];
  const index = new Map<string, number>();
  const raw = opts.rows ?? loadRows(store);
  const testFiles = raw.testFiles;
  const rows = raw.symbols.filter((r) => (!opts.excludeTests || (r.kind !== 'test' && !testFiles.has(r.file))) && (!opts.excludeDocs || (r.kind !== 'section' && !r.file.endsWith('.md'))));
  for (const r of rows) {
    if (!opts.includeModules && r.kind === 'module') continue;
    index.set(r.id, ids.length);
    ids.push(r.id);
  }
  const out: [number, number, number][][] = ids.map(() => []);
  const inn: [number, number, number][][] = ids.map(() => []);
  const edges = raw.edges;
  for (const e of edges) {
    if (opts.excludeTests && e.kind === 'tests') continue;
    const a = index.get(e.src);
    const b = index.get(e.dst);
    if (a === undefined || b === undefined || a === b) continue;
    const w = (EDGE_WEIGHT[e.kind] ?? 0.3) * e.confidence;
    const k = KIND_IDS[e.kind] ?? 0;
    out[a]!.push([b, w, k]);
    inn[b]!.push([a, w, k]);
  }
  if (opts.includeContains) {
    for (const r of rows) {
      if (!r.parent) continue;
      const a = index.get(r.parent);
      const b = index.get(r.id);
      if (a === undefined || b === undefined) continue;
      out[a]!.push([b, EDGE_WEIGHT.contains!, KIND_IDS.contains!]);
      inn[b]!.push([a, EDGE_WEIGHT.contains!, KIND_IDS.contains!]);
    }
  }
  return { ids, index, out, in: inn };
}

/** PageRank on the reverse graph: a symbol is important when many important symbols depend on it. */
export function pagerank(g: Graph, damping = 0.85, iterations = 40): Float64Array {
  const n = g.ids.length;
  const pr = new Float64Array(n).fill(n ? 1 / n : 0);
  if (!n) return pr;
  const outWeight = new Float64Array(n);
  for (let i = 0; i < n; i++) for (const [, w] of g.out[i]!) outWeight[i] = outWeight[i]! + w;
  const next = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    let dangling = 0;
    for (let i = 0; i < n; i++) if (outWeight[i] === 0) dangling += pr[i]!;
    const base = (1 - damping) / n + (damping * dangling) / n;
    next.fill(base);
    for (let i = 0; i < n; i++) {
      const ow = outWeight[i]!;
      if (ow === 0) continue;
      const share = (damping * pr[i]!) / ow;
      for (const [j, w] of g.out[i]!) next[j] = next[j]! + share * w;
    }
    let diff = 0;
    for (let i = 0; i < n; i++) {
      diff += Math.abs(next[i]! - pr[i]!);
      pr[i] = next[i]!;
    }
    if (diff < 1e-9) break;
  }
  return pr;
}

export function computeMetrics(store: Store, rows = loadRows(store)) {
  // PageRank over production code only: test volume must not decide importance.
  const g = loadGraph(store, { includeModules: true, excludeTests: true, rows });
  const pr = pagerank(g);
  const full = loadGraph(store, { includeModules: true, rows });
  const callers = new Int32Array(full.ids.length);
  const callees = new Int32Array(full.ids.length);
  for (const e of store.prep("SELECT src, dst FROM edges WHERE kind = 'calls'").all() as { src: string; dst: string }[]) {
    const a = full.index.get(e.src);
    const b = full.index.get(e.dst);
    if (a !== undefined) callees[a] = callees[a]! + 1;
    if (b !== undefined) callers[b] = callers[b]! + 1;
  }
  store.transaction(() => {
    store.db.exec('DELETE FROM metrics');
    const ins = store.prep('INSERT INTO metrics(symbol, pagerank, in_degree, out_degree, callers, callees) VALUES(?,?,?,?,?,?)');
    for (let i = 0; i < full.ids.length; i++) {
      const gi = g.index.get(full.ids[i]!);
      const p = gi === undefined ? 0 : pr[gi]! * g.ids.length;
      ins.run(full.ids[i]!, p, full.in[i]!.length, full.out[i]!.length, callers[i]!, callees[i]!);
    }
  });
}
