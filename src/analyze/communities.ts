import type { Store } from '../store/db.js';
import { loadGraph, loadRows, type Graph } from './metrics.js';
import { splitIdentifier } from '../store/db.js';

/**
 * Deterministic Louvain community detection on the undirected weighted projection of the
 * symbol graph, with a weak directory prior (symbols in the same file get a small extra edge).
 */
export function louvain(g: Graph, filePrior: Map<number, number>, resolution = 1.0): Int32Array {
  const n = g.ids.length;
  // Build undirected weighted adjacency (merge both directions).
  const adj: Map<number, number>[] = Array.from({ length: n }, () => new Map());
  const addW = (a: number, b: number, w: number) => {
    if (a === b) return;
    adj[a]!.set(b, (adj[a]!.get(b) ?? 0) + w);
    adj[b]!.set(a, (adj[b]!.get(a) ?? 0) + w);
  };
  for (let i = 0; i < n; i++) for (const [j, w] of g.out[i]!) addW(i, j, w);
  // file prior: chain symbols of the same file (linear, cheap, keeps files cohesive)
  const byFile = new Map<number, number[]>();
  for (const [node, f] of filePrior) {
    let a = byFile.get(f);
    if (!a) byFile.set(f, (a = []));
    a.push(node);
  }
  for (const nodes of byFile.values()) {
    nodes.sort((a, b) => a - b);
    for (let i = 1; i < nodes.length; i++) addW(nodes[i - 1]!, nodes[i]!, 0.1);
    if (nodes.length > 2) addW(nodes[0]!, nodes[nodes.length - 1]!, 0.1);
  }

  let curAdj = adj;
  let curN = n;
  const levels: Int32Array[] = [];
  for (let level = 0; level < 10; level++) {
    const comm = localMoving(curAdj, curN, resolution);
    levels.push(comm);
    const relabel = new Map<number, number>();
    const compact = new Int32Array(curN);
    for (let i = 0; i < curN; i++) {
      let c = relabel.get(comm[i]!);
      if (c === undefined) relabel.set(comm[i]!, (c = relabel.size));
      compact[i] = c;
    }
    const k = relabel.size;
    if (k === curN) break;
    const nextAdj: Map<number, number>[] = Array.from({ length: k }, () => new Map());
    for (let i = 0; i < curN; i++) {
      const ci = compact[i]!;
      for (const [j, w] of curAdj[i]!) {
        const cj = compact[j]!;
        if (ci === cj) {
          if (i < j) nextAdj[ci]!.set(ci, (nextAdj[ci]!.get(ci) ?? 0) + w);
          continue;
        }
        nextAdj[ci]!.set(cj, (nextAdj[ci]!.get(cj) ?? 0) + w);
      }
    }
    curAdj = nextAdj;
    curN = k;
    if (k <= 1) break;
  }
  // compose levels properly: each level maps ids of that level to raw community ids; we tracked compact relabels separately.
  return composeLevels(levels, n);
}

function composeLevels(levels: Int32Array[], n: number): Int32Array {
  // Rebuild: level 0 assigns each node a community id (arbitrary ints). We compact each level as we go.
  let assign = new Int32Array(n);
  for (let i = 0; i < n; i++) assign[i] = i;
  for (const lvl of levels) {
    const relabel = new Map<number, number>();
    const compactLvl = new Int32Array(lvl.length);
    for (let i = 0; i < lvl.length; i++) {
      let c = relabel.get(lvl[i]!);
      if (c === undefined) relabel.set(lvl[i]!, (c = relabel.size));
      compactLvl[i] = c;
    }
    const next = new Int32Array(n);
    for (let v = 0; v < n; v++) next[v] = compactLvl[assign[v]!]!;
    assign = next;
  }
  return assign;
}

function localMoving(adj: Map<number, number>[], n: number, resolution: number): Int32Array {
  const comm = new Int32Array(n);
  const degree = new Float64Array(n);
  let m2 = 0; // 2m
  for (let i = 0; i < n; i++) {
    comm[i] = i;
    let d = 0;
    for (const [j, w] of adj[i]!) d += j === i ? 2 * w : w;
    degree[i] = d;
    m2 += d;
  }
  if (m2 === 0) return comm;
  const tot = new Float64Array(n); // total degree per community
  for (let i = 0; i < n; i++) tot[i] = degree[i]!;
  let improved = true;
  let rounds = 0;
  while (improved && rounds < 25) {
    improved = false;
    rounds++;
    for (let i = 0; i < n; i++) {
      const ci = comm[i]!;
      const ki = degree[i]!;
      // weights to neighboring communities
      const nbW = new Map<number, number>();
      for (const [j, w] of adj[i]!) {
        if (j === i) continue;
        const cj = comm[j]!;
        nbW.set(cj, (nbW.get(cj) ?? 0) + w);
      }
      // remove i from its community
      tot[ci] = tot[ci]! - ki;
      const wOwn = nbW.get(ci) ?? 0;
      let best = ci;
      let bestGain = wOwn - (resolution * tot[ci]! * ki) / m2;
      // deterministic order: sorted community ids
      const cands = [...nbW.keys()].sort((a, b) => a - b);
      for (const c of cands) {
        if (c === ci) continue;
        const gain = nbW.get(c)! - (resolution * tot[c]! * ki) / m2;
        if (gain > bestGain + 1e-12) {
          bestGain = gain;
          best = c;
        }
      }
      tot[best] = tot[best]! + ki;
      if (best !== ci) {
        comm[i] = best;
        improved = true;
      }
    }
  }
  return comm;
}

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'in', 'is', 'for', 'get', 'set', 'init', 'new', 'test', 'tests', 'index', 'main', 'src', 'lib', 'utils', 'util', 'core', 'base', 'impl', 'default', 'type', 'types', 'js', 'ts', 'py', 'spec', 'this', 'self', 'module', 'exports']);

function labelFor(members: { name: string; file: string; kind: string; pr: number }[]): { label: string; dirs: string[] } {
  // common directory prefix
  const dirs = new Map<string, number>();
  for (const m of members) {
    const d = m.file.includes('/') ? m.file.slice(0, m.file.lastIndexOf('/')) : '.';
    dirs.set(d, (dirs.get(d) ?? 0) + 1);
  }
  const topDirs = [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((d) => d[0]);
  // tf over split names, weighted by pagerank
  const tf = new Map<string, number>();
  for (const m of members) {
    const toks = new Set(splitIdentifier(m.name).split(' ').filter((t) => t.length > 2 && !STOP.has(t) && /^[a-z]+$/.test(t)));
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1 + m.pr);
  }
  const top = [...tf.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map((t) => t[0]);
  const hub = [...members].sort((a, b) => b.pr - a.pr)[0];
  const dirLabel = topDirs[0] && topDirs[0] !== '.' ? topDirs[0]!.split('/').slice(-2).join('/') : '';
  const words = top.join(' ');
  const label = dirLabel && words ? `${dirLabel}: ${words}` : words || dirLabel || hub?.name || 'misc';
  return { label, dirs: topDirs };
}

/** Split any community larger than `maxSize` by re-running Louvain on its induced subgraph at a higher resolution. */
function refine(g: Graph, assign: Int32Array, filePrior: Map<number, number>, maxSize: number): Int32Array {
  const n = g.ids.length;
  const members = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    let a = members.get(assign[i]!);
    if (!a) members.set(assign[i]!, (a = []));
    a.push(i);
  }
  const out = new Int32Array(assign);
  // Loop rather than Math.max(...assign): spreading a >120K-element array overflows the stack.
  let nextId = 0;
  for (let i = 0; i < n; i++) if (assign[i]! >= nextId) nextId = assign[i]! + 1;
  for (const [c, nodes] of members) {
    if (nodes.length <= maxSize) continue;
    const local = new Map<number, number>();
    nodes.forEach((v, i) => local.set(v, i));
    const sub: Graph = { ids: nodes.map((v) => g.ids[v]!), index: new Map(), out: nodes.map(() => []), in: nodes.map(() => []) };
    for (let i = 0; i < nodes.length; i++) {
      for (const [j, w, k] of g.out[nodes[i]!]!) {
        const lj = local.get(j);
        if (lj !== undefined) {
          sub.out[i]!.push([lj, w, k]);
          sub.in[lj]!.push([i, w, k]);
        }
      }
    }
    const subPrior = new Map<number, number>();
    for (let i = 0; i < nodes.length; i++) {
      const f = filePrior.get(nodes[i]!);
      if (f !== undefined) subPrior.set(i, f);
    }
    const subAssign = louvain(sub, subPrior, 1.8);
    const relabel = new Map<number, number>();
    for (let i = 0; i < nodes.length; i++) {
      let id = relabel.get(subAssign[i]!);
      if (id === undefined) relabel.set(subAssign[i]!, (id = relabel.size === 0 ? c : nextId++));
      out[nodes[i]!] = id;
    }
  }
  return out;
}

export function computeCommunities(store: Store, rows = loadRows(store)) {
  const g = loadGraph(store, { includeModules: false, includeContains: true, excludeTests: true, excludeDocs: true, rows });
  const n = g.ids.length;
  if (!n) return;
  const files = store.prep("SELECT id, file FROM symbols WHERE kind != 'module' ORDER BY id").all() as { id: string; file: string }[];
  const fileIdx = new Map<string, number>();
  const filePrior = new Map<number, number>();
  for (const r of files) {
    const i = g.index.get(r.id);
    if (i === undefined) continue;
    let f = fileIdx.get(r.file);
    if (f === undefined) fileIdx.set(r.file, (f = fileIdx.size));
    filePrior.set(i, f);
  }
  let assign = louvain(g, filePrior, 1.0);
  const maxSize = Math.max(40, Math.round(n * 0.2));
  assign = refine(g, assign, filePrior, maxSize);
  assign = refine(g, assign, filePrior, maxSize);
  // Order communities by size desc for stable, meaningful ids
  const sizes = new Map<number, number>();
  for (let i = 0; i < n; i++) sizes.set(assign[i]!, (sizes.get(assign[i]!) ?? 0) + 1);
  const order = [...sizes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map((e) => e[0]);
  const rank = new Map<number, number>();
  order.forEach((c, i) => rank.set(c, i));
  const pr = new Map<string, number>();
  for (const r of store.prep('SELECT symbol, pagerank FROM metrics ORDER BY symbol').all() as { symbol: string; pagerank: number }[]) pr.set(r.symbol, r.pagerank);
  const meta = new Map<string, { name: string; file: string; kind: string }>();
  for (const r of store.prep("SELECT id, name, file, kind FROM symbols WHERE kind != 'module' ORDER BY id").all() as { id: string; name: string; file: string; kind: string }[]) meta.set(r.id, r);
  const members = new Map<number, { id: string; name: string; file: string; kind: string; pr: number }[]>();
  for (let i = 0; i < n; i++) {
    const c = rank.get(assign[i]!)!;
    const id = g.ids[i]!;
    const m = meta.get(id);
    if (!m) continue;
    let arr = members.get(c);
    if (!arr) members.set(c, (arr = []));
    arr.push({ id, ...m, pr: pr.get(id) ?? 0 });
  }
  store.transaction(() => {
    store.db.exec('DELETE FROM communities');
    store.db.exec('DELETE FROM community_labels');
    const ins = store.prep('INSERT INTO communities(symbol, level, community) VALUES(?, 0, ?)');
    const insL = store.prep('INSERT INTO community_labels(level, community, label, size, top_symbols, dirs) VALUES(0, ?, ?, ?, ?, ?)');
    for (const [c, arr] of members) {
      for (const m of arr) ins.run(m.id, c);
      const { label, dirs } = labelFor(arr);
      const top = [...arr].sort((a, b) => b.pr - a.pr).slice(0, 8).map((m) => m.id);
      insL.run(c, label, arr.length, JSON.stringify(top), JSON.stringify(dirs));
    }
  });
}
