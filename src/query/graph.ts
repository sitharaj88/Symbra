import { execSync } from 'node:child_process';
import type { Store, SymbolRow } from '../store/db.js';
import type { Edge } from '../ir/types.js';
import { loadGraph, type Graph, EDGE_WEIGHT, STRUCTURAL_KIND_IDS, KIND_NAMES, KIND_IDS } from '../analyze/metrics.js';

const graphCache = new WeakMap<Store, { key: string; g: Graph }>();

/** In-memory graph (all symbols incl. modules, no tests edges excluded), cached per index generation. */
export function cachedGraph(store: Store): Graph {
  // `generation` is bumped by every indexing run that wrote something, including ones that left the
  // edge count unchanged (a rename, an edge retargeted). `indexed_at` is the fallback for stores
  // written before generations existed, or by an importer that does not bump one.
  const key = `${store.getMeta('generation') ?? store.getMeta('indexed_at')}|${store.countEdges()}`;
  const c = graphCache.get(store);
  if (c && c.key === key) return c.g;
  const g = loadGraph(store, { includeModules: true, includeContains: true });
  graphCache.set(store, { key, g });
  return g;
}

/** Human label for an edge kind in caller listings: a `passes` edge is a callback registration, not a call. */
export function edgeKindLabel(kind: string): string {
  return kind === 'passes' ? 'passes (passed as callback)' : kind;
}

export interface Neighbor {
  symbol: SymbolRow;
  edge: Edge;
  /** True when the edge comes from an unresolved reference whose candidate set contains the target. */
  candidate?: boolean;
}

/**
 * Who calls or references a symbol.
 *
 * Resolved edges come first. After them come *candidate* callers: reference sites the resolver could
 * not narrow to one definition but whose candidate set contains this symbol (`delegate.retryRequest`
 * with `RequestDelegate.retryRequest` and `Session.retryRequest` both possible). Without them a
 * symbol only ever reached through a protocol or duck-typed receiver looks as if nothing calls it.
 * They carry `candidate: true` and a confidence of 1/|candidates| so callers can tell them apart.
 */
export function callersOf(store: Store, id: string, kinds: string[] = ['calls'], opts: { candidates?: boolean } = {}): Neighbor[] {
  const q = `SELECT * FROM edges WHERE dst = ? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY file, line`;
  const rows = store.prep(q).all(id, ...kinds) as Edge[];
  const out: Neighbor[] = [];
  const seen = new Set<string>();
  for (const e of rows) {
    const s = store.getSymbol(e.src);
    if (!s) continue;
    seen.add(`${e.src}|${e.file}|${e.line}`);
    out.push({ symbol: s, edge: e });
  }
  if (opts.candidates === false) return out;
  if (!kinds.includes('calls') && !kinds.includes('references')) return out;
  const target = store.getSymbol(id);
  if (!target) return out;
  const rows2 = store.prep('SELECT file, line, scope, kind, name, qualifier, candidates FROM unresolved WHERE name = ? AND candidates LIKE ? ORDER BY file, line').all(target.name, `%"${id}"%`) as {
    file: string;
    line: number;
    scope: string | null;
    kind: string;
    name: string;
    qualifier?: string;
    candidates: string;
  }[];
  for (const r of rows2) {
    if (!r.scope || r.scope === id) continue;
    let cand: string[];
    try {
      cand = JSON.parse(r.candidates) as string[];
    } catch {
      continue;
    }
    if (!cand.includes(id)) continue;
    const s = store.getSymbol(r.scope);
    if (!s) continue;
    const key = `${r.scope}|${r.file}|${r.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    push(s, r, cand.length);
  }
  // There used to be a last-resort tier here that scanned the `refs` table for the target's bare
  // name when nothing production-side resolved to it. It is gone: the resolver now records an
  // `unresolved` row (with the real candidate set) for every call/new reference it drops, so those
  // sites arrive through the candidate tier above with honest provenance instead of a query-time
  // name guess. Benchmarked at parity on callers and impact (both 100.0 found, MRR 0.942 / 0.955),
  // so the guess bought nothing the recorded candidates do not.
  return out;

  function push(s: SymbolRow, r: { scope: string | null; kind: string; file: string; line: number }, nCand: number) {
    out.push({
      symbol: s,
      candidate: true,
      edge: {
        src: r.scope!,
        dst: id,
        kind: r.kind === 'call' ? 'calls' : 'references',
        file: r.file,
        line: r.line,
        resolver: 'heuristic',
        confidence: Math.max(0.1, Math.round((1 / nCand) * 100) / 100),
      },
    });
  }
}

export function calleesOf(store: Store, id: string, kinds: string[] = ['calls']): Neighbor[] {
  const q = `SELECT * FROM edges WHERE src = ? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY line`;
  const rows = store.prep(q).all(id, ...kinds) as Edge[];
  const out: Neighbor[] = [];
  for (const e of rows) {
    const s = store.getSymbol(e.dst);
    if (s) out.push({ symbol: s, edge: e });
  }
  return out;
}

/** Tests that exercise a symbol (directly or through a member). */
export function testsFor(store: Store, id: string): SymbolRow[] {
  const rows = store.prep("SELECT DISTINCT src FROM edges WHERE dst = ? AND kind = 'tests'").all(id) as { src: string }[];
  const out: SymbolRow[] = [];
  for (const r of rows) {
    const s = store.getSymbol(r.src);
    if (s) out.push(s);
  }
  return out;
}

export interface PathHop {
  symbol: SymbolRow;
  via?: { kind: string; line: number; reversed: boolean };
}

/** Binary min-heap over (cost, node). */
class MinHeap {
  private a: number[] = [];
  private c: number[] = [];
  get size() {
    return this.a.length;
  }
  push(node: number, cost: number) {
    this.a.push(node);
    this.c.push(cost);
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.c[p]! <= this.c[i]!) break;
      [this.a[p], this.a[i]] = [this.a[i]!, this.a[p]!];
      [this.c[p], this.c[i]] = [this.c[i]!, this.c[p]!];
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.a[0]!, this.c[0]!];
    const ln = this.a.pop()!;
    const lc = this.c.pop()!;
    if (this.a.length) {
      this.a[0] = ln;
      this.c[0] = lc;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.a.length && this.c[l]! < this.c[m]!) m = l;
        if (r < this.a.length && this.c[r]! < this.c[m]!) m = r;
        if (m === i) break;
        [this.a[m], this.a[i]] = [this.a[i]!, this.a[m]!];
        [this.c[m], this.c[i]] = [this.c[i]!, this.c[m]!];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Shortest path between two symbols. Cost-weighted: entering a node costs more the more callers it
 * has, so the route through domain code beats the one through a logging helper called from everywhere.
 * Structural edges (contains/calls/extends/implements) are tried first; tests and docs are avoided
 * unless an endpoint is one.
 */
export function shortestPath(store: Store, from: string, to: string, opts: { directed?: boolean; maxDepth?: number; allowTests?: boolean; structuralOnly?: boolean } = {}): PathHop[] | null {
  if (opts.structuralOnly === undefined) return shortestPath(store, from, to, { ...opts, structuralOnly: true }) ?? shortestPath(store, from, to, { ...opts, structuralOnly: false });
  const g = cachedGraph(store);
  const a = g.index.get(from);
  const b = g.index.get(to);
  if (a === undefined || b === undefined) return null;
  if (a === b) return [{ symbol: store.getSymbol(from)! }];
  const n = g.ids.length;
  const maxDepth = opts.maxDepth ?? 12;
  const blocked = new Uint8Array(n);
  if (!opts.allowTests) {
    const testFiles = new Set((store.prep('SELECT path FROM files WHERE is_test = 1').all() as { path: string }[]).map((r) => r.path));
    for (const r of store.prep("SELECT id FROM symbols WHERE kind = 'test' OR kind = 'section'").all() as { id: string }[]) {
      const i = g.index.get(r.id);
      if (i !== undefined) blocked[i] = 1;
    }
    for (const [i, id] of g.ids.entries()) {
      const f = id.includes('::') ? id.slice(0, id.indexOf('::')) : id;
      if (testFiles.has(f) || f.endsWith('.md')) blocked[i] = 1;
    }
    blocked[a] = 0;
    blocked[b] = 0;
  }
  // Module nodes are never an explanation: every two symbols in one file are 2 hops apart through
  // `file -contains-> a` / `file -contains-> b`, which says nothing about how they relate. Block them
  // as intermediates in the structural pass (an endpoint stays reachable).
  const isModule = new Uint8Array(n);
  for (const r of store.prep("SELECT id FROM symbols WHERE kind = 'module'").all() as { id: string }[]) {
    const i = g.index.get(r.id);
    if (i !== undefined) isModule[i] = 1;
  }
  if (opts.structuralOnly) {
    for (let i = 0; i < n; i++) if (isModule[i]) blocked[i] = 1;
    blocked[a] = 0;
    blocked[b] = 0;
  }
  // fan-in from non-structural edges: how many distinct places depend on this node
  const fanIn = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let c = 0;
    for (const [, , k] of g.in[i]!) if (k !== 10) c++;
    fanIn[i] = c;
  }
  const enterCost = (v: number) => 1 + 0.6 * Math.log2(1 + fanIn[v]!);
  // A hop that explains behaviour (a call, an override) is worth more than one that merely says
  // "these live in the same body", so containment costs more per hop and containment through a
  // module costs a great deal more.
  const edgeCost = (k: number, u: number, v: number) => {
    if (k === KIND_IDS.contains) return isModule[u] || isModule[v] ? 5 : 1.5;
    if (k === KIND_IDS.imports) return 2.5;
    if (k === KIND_IDS.references) return 1.2;
    return 1;
  };
  const dist = new Float64Array(n).fill(Infinity);
  const hops = new Int32Array(n);
  const prev = new Int32Array(n).fill(-1);
  const prevRev = new Uint8Array(n);
  const prevKind = new Uint8Array(n);
  const heap = new MinHeap();
  dist[a] = 0;
  heap.push(a, 0);
  while (heap.size) {
    const [u, d] = heap.pop();
    if (d > dist[u]!) continue;
    if (u === b) break;
    if (hops[u]! >= maxDepth) continue;
    const adj: [number, boolean, number][] = [];
    for (const [v, , k] of g.out[u]!) if (!opts.structuralOnly || STRUCTURAL_KIND_IDS.has(k)) adj.push([v, false, k]);
    if (!opts.directed) for (const [v, , k] of g.in[u]!) if (!opts.structuralOnly || STRUCTURAL_KIND_IDS.has(k)) adj.push([v, true, k]);
    for (const [v, rev, k] of adj) {
      if (blocked[v]) continue;
      const nd = d + edgeCost(k, u, v) * (v === b ? 1 : enterCost(v));
      if (nd < dist[v]!) {
        dist[v] = nd;
        hops[v] = hops[u]! + 1;
        prev[v] = u;
        prevRev[v] = rev ? 1 : 0;
        prevKind[v] = k;
        heap.push(v, nd);
      }
    }
  }
  if (dist[b] === Infinity) return opts.allowTests || opts.structuralOnly ? null : shortestPath(store, from, to, { ...opts, allowTests: true });
  const chain: number[] = [];
  for (let v = b; v !== -1; v = prev[v]!) {
    chain.push(v);
    if (v === a) break;
  }
  chain.reverse();
  const out: PathHop[] = [];
  for (let i = 0; i < chain.length; i++) {
    const id = g.ids[chain[i]!]!;
    const sym = store.getSymbol(id);
    if (!sym) continue;
    if (i === 0) {
      out.push({ symbol: sym });
      continue;
    }
    const prevId = g.ids[chain[i - 1]!]!;
    const rev = prevRev[chain[i]!] === 1;
    const kindName = KIND_NAMES[prevKind[chain[i]!]!] ?? 'related';
    if (kindName === 'contains') {
      out.push({ symbol: sym, via: { kind: 'contains', line: 0, reversed: rev } });
      continue;
    }
    const e = (rev ? store.prep('SELECT kind, line FROM edges WHERE src = ? AND dst = ? AND kind = ? LIMIT 1').get(id, prevId, kindName) : store.prep('SELECT kind, line FROM edges WHERE src = ? AND dst = ? AND kind = ? LIMIT 1').get(prevId, id, kindName)) as { kind: string; line: number } | undefined;
    out.push({ symbol: sym, via: { kind: e?.kind ?? kindName, line: e?.line ?? 0, reversed: rev } });
  }
  return out;
}

export interface ImpactEntry {
  symbol: SymbolRow;
  depth: number;
  score: number;
  via: string; // fqn of the symbol through which impact propagates
  kind: string;
}

export interface ImpactResult {
  roots: SymbolRow[];
  affected: ImpactEntry[];
  tests: SymbolRow[];
  filesTouched: string[];
}

const IMPACT_KINDS = new Set(['calls', 'references', 'passes', 'extends', 'implements', 'decorates', 'defines_route', 'imports']);

/** Reverse dependency closure: what depends (transitively) on these symbols. */
export function impact(store: Store, rootIds: string[], opts: { depth?: number; limit?: number } = {}): ImpactResult {
  const maxDepth = opts.depth ?? 3;
  const limit = opts.limit ?? 200;
  const testFiles = new Set((store.prep('SELECT path FROM files WHERE is_test = 1').all() as { path: string }[]).map((r) => r.path));
  const roots = rootIds.map((id) => store.getSymbol(id)).filter((s): s is SymbolRow => !!s);
  // Include members of a class root: changing a class affects callers of its methods too.
  const seedSet = new Map<string, number>();
  for (const r of roots) {
    seedSet.set(r.id, 1);
    if (['class', 'interface', 'struct', 'trait', 'enum'].includes(r.kind)) for (const c of store.children(r.id)) seedSet.set(c.id, 0.9);
  }
  // An overload of a root (`get(TypeToken)` calling `get(TypeToken, bool)`) is the least surprising
  // dependent there is: keep it, but rank the callers that actually depend on the behaviour first.
  const overloadKeys = new Set(roots.map((r) => `${r.parent ?? ''}|${r.name}`));
  const best = new Map<string, ImpactEntry>();
  const tests = new Map<string, SymbolRow>();
  let frontier = [...seedSet.entries()].map(([id, score]) => ({ id, score, depth: 0 }));
  const visited = new Set(seedSet.keys());
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next: typeof frontier = [];
    for (const f of frontier) {
      const viaSym = store.getSymbol(f.id);
      const rows = store.prep('SELECT src, kind, confidence FROM edges WHERE dst = ?').all(f.id) as { src: string; kind: string; confidence: number }[];
      // A caller the resolver could only narrow to a candidate set still breaks when this changes.
      for (const c of callersOf(store, f.id, ['calls', 'references', 'passes'])) {
        if (c.candidate) rows.push({ src: c.edge.src, kind: c.edge.kind, confidence: c.edge.confidence });
      }
      for (const e of rows) {
        if (e.kind === 'tests') {
          const t = store.getSymbol(e.src);
          if (t) tests.set(t.id, t);
          continue;
        }
        if (!IMPACT_KINDS.has(e.kind)) continue;
        const s = store.getSymbol(e.src);
        if (!s) continue;
        if (s.kind === 'test' || testFiles.has(s.file)) {
          tests.set(s.id, s);
          continue;
        }
        const score = f.score * (EDGE_WEIGHT[e.kind] ?? 0.3) * e.confidence * (d === 1 ? 1 : 0.6) * (overloadKeys.has(`${s.parent ?? ''}|${s.name}`) ? 0.5 : 1);
        const cur = best.get(s.id);
        if (!cur || cur.score < score) best.set(s.id, { symbol: s, depth: d, score, via: viaSym?.fqn ?? f.id, kind: e.kind });
        if (!visited.has(s.id)) {
          visited.add(s.id);
          next.push({ id: s.id, score, depth: d });
        }
      }
    }
    frontier = next;
  }
  const affected = [...best.values()].sort((a, b) => a.depth - b.depth || b.score - a.score || (a.symbol.fqn < b.symbol.fqn ? -1 : 1)).slice(0, limit);
  const files = new Set<string>();
  for (const a of affected) files.add(a.symbol.file);
  return { roots, affected, tests: [...tests.values()].sort((a, b) => (a.file < b.file ? -1 : 1)), filesTouched: [...files].sort() };
}

/** Symbols overlapping changed line ranges from `git diff` (working tree vs HEAD, or a given base). */
export function changedSymbols(store: Store, root: string, base?: string): { symbols: SymbolRow[]; files: string[] } {
  let diff = '';
  try {
    diff = execSync(`git diff --unified=0 ${base ? base : 'HEAD'} --`, { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    if (!diff.trim() && !base) diff = execSync('git diff --unified=0 --cached --', { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch {
    return { symbols: [], files: [] };
  }
  const files: string[] = [];
  const out = new Map<string, SymbolRow>();
  let cur = '';
  for (const line of diff.split('\n')) {
    const f = line.match(/^\+\+\+ b\/(.+)$/);
    if (f) {
      cur = f[1]!;
      files.push(cur);
      continue;
    }
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h && cur) {
      const start = Number(h[1]);
      const len = h[2] === undefined ? 1 : Number(h[2]);
      const end = start + Math.max(len, 1) - 1;
      const rows = store.prep("SELECT * FROM symbols WHERE file = ? AND kind != 'module' AND start_line <= ? AND end_line >= ? ORDER BY (end_line - start_line) ASC").all(cur, end, start) as SymbolRow[];
      // innermost symbol per hunk
      const seen = new Set<string>();
      for (const s of rows) {
        if (seen.has(s.parent ?? '')) continue;
        out.set(s.id, s);
        seen.add(s.id);
        break;
      }
      if (!rows.length) {
        const mod = store.getSymbol(cur);
        if (mod) out.set(mod.id, mod);
      }
    }
  }
  return { symbols: [...out.values()], files };
}
