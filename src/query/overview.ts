import type { Store, SymbolRow } from '../store/db.js';
import { fmtSymbolLine } from './format.js';
import { freshnessHeader } from './explore.js';
import { refreshStaleAnalysis } from '../analyze/refresh.js';
import { isPeripheralPath, hasFlutterOrKmpRoot } from '../analyze/peripheral.js';

export interface Overview {
  text: string;
  communities: { id: number; label: string; size: number; top: SymbolRow[]; dirs: string[] }[];
  /** Communities flagged peripheral (migrations, platform scaffolding, docs, …): listed only as a
   *  one-line summary in `text`, not as full entries. */
  peripheralCommunities: { id: number; label: string; size: number }[];
  hubs: { symbol: SymbolRow; pagerank: number; callers: number }[];
  routes: SymbolRow[];
  cycles: string[][];
}

/** File-level import cycles via Tarjan SCC over resolved static imports. */
export function importCycles(store: Store, maxReport = 10): string[][] {
  const edges = store.prep("SELECT src, dst FROM edges WHERE kind = 'imports' AND confidence >= 1").all() as { src: string; dst: string }[];
  const idx = new Map<string, number>();
  const ids: string[] = [];
  const adj: number[][] = [];
  const id = (s: string) => {
    let i = idx.get(s);
    if (i === undefined) {
      idx.set(s, (i = ids.length));
      ids.push(s);
      adj.push([]);
    }
    return i;
  };
  for (const e of edges) adj[id(e.src)]!.push(id(e.dst));
  const n = ids.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  let counter = 0;
  const sccs: number[][] = [];
  const strong = (v: number) => {
    // iterative Tarjan
    const work: [number, number][] = [[v, 0]];
    index[v] = low[v] = counter++;
    stack.push(v);
    onStack[v] = 1;
    while (work.length) {
      const top = work[work.length - 1]!;
      const [u, i] = top;
      if (i < adj[u]!.length) {
        top[1] = i + 1;
        const w = adj[u]![i]!;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          work.push([w, 0]);
        } else if (onStack[w]) low[u] = Math.min(low[u]!, index[w]!);
      } else {
        work.pop();
        if (work.length) {
          const p = work[work.length - 1]![0];
          low[p] = Math.min(low[p]!, low[u]!);
        }
        if (low[u] === index[u]) {
          const comp: number[] = [];
          let w: number;
          do {
            w = stack.pop()!;
            onStack[w] = 0;
            comp.push(w);
          } while (w !== u);
          if (comp.length > 1) sccs.push(comp);
        }
      }
    }
  };
  for (let v = 0; v < n; v++) if (index[v] === -1) strong(v);
  return sccs
    .sort((a, b) => b.length - a.length)
    .slice(0, maxReport)
    .map((c) => c.map((i) => ids[i]!).sort());
}

export function overview(store: Store, root: string, opts: { communities?: number; hubs?: number } = {}): Overview {
  // Indexing defers PageRank/communities on small incremental runs; overview is the consumer that
  // needs them, so pay the debt here rather than reporting stale hubs and subsystems.
  refreshStaleAnalysis(store);
  const nComm = opts.communities ?? 12;
  const nHubs = opts.hubs ?? 15;
  const lines: string[] = [freshnessHeader(store, root)];
  const files = store.allFiles();
  const langs = new Map<string, number>();
  for (const f of files) langs.set(f.language, (langs.get(f.language) ?? 0) + 1);
  const kinds = store.prep("SELECT kind, COUNT(*) AS n FROM symbols WHERE kind NOT IN ('module') GROUP BY kind ORDER BY n DESC").all() as { kind: string; n: number }[];
  lines.push(`## Repository`);
  lines.push(`files: ${files.length} (${[...langs.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  lines.push(`symbols: ${kinds.map((k) => `${k.kind} ${k.n}`).join(', ')}`);
  const ek = store.prep('SELECT kind, COUNT(*) AS n FROM edges GROUP BY kind ORDER BY n DESC').all() as { kind: string; n: number }[];
  lines.push(`edges: ${ek.map((k) => `${k.kind} ${k.n}`).join(', ')}`);

  // communities. Real subsystems lead; communities flagged peripheral (migrations, platform
  // scaffolding, docs, …) are held back to a one-line summary so a repeated migration snapshot or
  // a generated Runner folder doesn't crowd out the actual feature subsystems.
  const allComms = store.prep('SELECT community, label, size, top_symbols, dirs, peripheral FROM community_labels WHERE level = 0 ORDER BY size DESC').all() as { community: number; label: string; size: number; top_symbols: string; dirs: string; peripheral: number }[];
  const realComms = allComms.filter((c) => !c.peripheral).slice(0, nComm);
  const peripheralComms = allComms.filter((c) => c.peripheral);
  const communities: Overview['communities'] = [];
  const peripheralCommunities: Overview['peripheralCommunities'] = peripheralComms.map((c) => ({ id: c.community, label: c.label, size: c.size }));
  lines.push(`## Subsystems (${allComms.length} communities)`);
  for (const c of realComms) {
    const top = (JSON.parse(c.top_symbols) as string[]).map((id) => store.getSymbol(id)).filter((s): s is SymbolRow => !!s);
    const dirs = JSON.parse(c.dirs) as string[];
    communities.push({ id: c.community, label: c.label, size: c.size, top, dirs });
    lines.push(`- #${c.community} ${c.label} (${c.size} symbols; ${dirs.slice(0, 2).join(', ')}) — ${top.slice(0, 5).map((s) => s.fqn).join(', ')}`);
  }
  if (peripheralComms.length) {
    lines.push(`Peripheral (migrations, platform scaffolding, docs): ${peripheralComms.map((c) => `#${c.community}`).join(', ')}`);
  }

  // hubs: production code only (test files already excluded), and peripheral files (migrations,
  // platform scaffolding, docs, …) too — a Serverpod migration snapshot or a generated
  // MainActivity shouldn't rank as a "hub" just because every snapshot repeats it.
  const flutterOrKmpRoot = hasFlutterOrKmpRoot(store);
  const hubCandidates = store
    .prep("SELECT s.*, m.pagerank, m.callers FROM metrics m JOIN symbols s ON s.id = m.symbol JOIN files f ON f.path = s.file WHERE s.kind NOT IN ('module','test','section','variable','constant','config_key','enum_member') AND f.is_test = 0 ORDER BY m.pagerank DESC LIMIT ?")
    .all(Math.max(60, nHubs * 6)) as (SymbolRow & { pagerank: number; callers: number })[];
  const hubRows = hubCandidates.filter((r) => !isPeripheralPath(r.file, flutterOrKmpRoot)).slice(0, nHubs);
  const hubs = hubRows.map((r) => ({ symbol: r, pagerank: r.pagerank, callers: r.callers }));
  lines.push(`## Hubs (by PageRank over production code)`);
  for (const h of hubs) lines.push(`- ${fmtSymbolLine(h.symbol)}  pr=${h.pagerank.toFixed(1)} callers=${h.callers}`);

  // entry points
  const routes = store.prep("SELECT * FROM symbols WHERE kind = 'route' ORDER BY file, start_line").all() as SymbolRow[];
  const mains = store.prep("SELECT * FROM symbols WHERE kind IN ('function') AND name IN ('main','cli','run','serve','start') AND exported = 1 ORDER BY file LIMIT 10").all() as SymbolRow[];
  if (routes.length || mains.length) {
    lines.push(`## Entry points`);
    for (const r of routes.slice(0, 40)) {
      const h = (store.prep("SELECT dst FROM edges WHERE src = ? AND kind = 'defines_route'").all(r.id) as { dst: string }[]).map((x) => store.getSymbol(x.dst)?.fqn).filter(Boolean);
      lines.push(`- ${r.name}  ${r.file}:${r.start_line}${h.length ? ' -> ' + h.join(', ') : ''}`);
    }
    if (routes.length > 40) lines.push(`… ${routes.length - 40} more routes`);
    for (const m of mains) lines.push(`- ${fmtSymbolLine(m)}`);
  }
  // config
  const cfg = store.prep("SELECT s.name, COUNT(e.src) AS n FROM symbols s LEFT JOIN edges e ON e.dst = s.id WHERE s.kind = 'config_key' GROUP BY s.id ORDER BY n DESC LIMIT 30").all() as { name: string; n: number }[];
  if (cfg.length) lines.push(`## Environment variables\n${cfg.map((c) => `${c.name}(${c.n})`).join(', ')}`);

  // cycles
  const cycles = importCycles(store);
  if (cycles.length) {
    lines.push(`## Import cycles (file level, ${cycles.length} shown)`);
    for (const c of cycles) lines.push(`- ${c.length} files: ${c.slice(0, 6).join(' -> ')}${c.length > 6 ? ' …' : ''}`);
  }
  // quality
  const un = (store.prep('SELECT COUNT(*) AS n FROM unresolved').get() as { n: number }).n;
  const imp = store.prep('SELECT COUNT(*) AS n, SUM(resolved IS NOT NULL) AS r FROM imports').get() as { n: number; r: number };
  const errs = store.prep('SELECT path, error_pct FROM files WHERE error_pct > 5 ORDER BY error_pct DESC LIMIT 5').all() as { path: string; error_pct: number }[];
  lines.push(`## Index quality`);
  lines.push(`internal imports resolved: ${imp.r}/${imp.n} (rest are external packages) · ambiguous references kept as candidates: ${un}`);
  if (errs.length) lines.push(`files with parse errors: ${errs.map((e) => `${e.path} (${e.error_pct}%)`).join(', ')}`);
  return { text: lines.join('\n'), communities, peripheralCommunities, hubs, routes, cycles };
}
