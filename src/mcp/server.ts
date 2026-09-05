import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Store, defaultDbPath } from '../store/db.js';
import { indexRepo } from '../index/indexer.js';
import { search, findSymbols } from '../query/search.js';
import { callersOf, calleesOf, impact, shortestPath, testsFor, changedSymbols, edgeKindLabel } from '../query/graph.js';
import { explore, freshnessHeader } from '../query/explore.js';
import { overview } from '../query/overview.js';
import { fmtSymbolLine } from '../query/format.js';
import { watchRepo } from '../watch/watcher.js';
import { searchHybrid, exploreHybrid, warmEmbedder } from '../embed/index.js';

export interface ServeOptions {
  root: string;
  watch?: boolean;
}

const GUIDANCE = `Symbra indexes this repository into a symbol graph (definitions with kinds, ranges, signatures, docs; call/import/inheritance edges with provenance). Prefer these tools over grep/read loops:
- explore(question): one call returns the relevant symbols with source, relations and paths. Start here for any "how does X work / where is Y / what handles Z" question.
- symbol(name): definition, signature, doc, callers, callees, tests, source.
- callers / callees / path / impact: precise graph questions. impact() with no name analyses the current git diff and lists tests to run.
- search(query): ranked symbol search when you only have a vague term.
- overview(): subsystems, hubs, entry points, env vars, import cycles.
Every response starts with an index-freshness line; symbols marked STALE come from files edited after the last index. The index refreshes itself on each call.`;

/**
 * Auto-indexing walks the whole tree, so the root has to look like a repository. `$HOME` with no
 * marker would index every file the user owns.
 */
function refuseAutoIndex(root: string): string | null {
  const resolved = resolve(root);
  if (resolved === resolve(homedir())) return `refusing to index the home directory (${resolved})`;
  if (!existsSync(join(resolved, '.git')) && !existsSync(join(resolved, '.symbra'))) return `${resolved} has no .git and no .symbra directory, so it does not look like a repository`;
  return null;
}

export async function serveMcp(opts: ServeOptions): Promise<void> {
  const root = opts.root;
  if (!Store.exists(root)) {
    const refusal = refuseAutoIndex(root);
    if (refusal) {
      console.error(`[symbra] ${refusal}.\nRun \`symbra index\` from the repository you want served, or start the server with \`symbra -C <repo> serve\`.`);
      throw new Error(`[symbra] cannot auto-index: ${refusal}`);
    }
    await indexRepo({ root });
  }
  let store = new Store(defaultDbPath(root));
  // Preload the embedding model and the vector matrix so the first question does not pay for it.
  // Fire-and-forget: it is a no-op without vectors, never downloads and never throws.
  warmEmbedder(store);
  let lastRefresh = 0;
  let refreshing: Promise<void> | null = null;

  async function ensureFresh(force = false) {
    const now = Date.now();
    if (!force && now - lastRefresh < 3000) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const stats = await indexRepo({ root });
        if (stats.changed || stats.deleted) reopenStore();
      } catch (err) {
        console.error(`[symbra] refresh failed: ${(err as Error).message}`);
      } finally {
        lastRefresh = Date.now();
        refreshing = null;
      }
    })();
    return refreshing;
  }

  /** Reopen the store after an external re-index. Never leaves `store` pointing at a closed handle. */
  function reopenStore() {
    const previous = store;
    let next: Store;
    try {
      next = new Store(defaultDbPath(root));
    } catch (err) {
      // Could not reopen (locked, mid-write, disk error): keep serving from the handle we have.
      console.error(`[symbra] could not reopen the index: ${(err as Error).message}`);
      return;
    }
    store = next;
    warmEmbedder(store);
    try {
      previous.close();
    } catch {
      /* the old handle is unreachable now anyway */
    }
  }

  if (opts.watch !== false) {
    watchRepo(root, () => {
      lastRefresh = 0;
      try {
        reopenStore();
      } catch (err) {
        console.error(`[symbra] watch refresh failed: ${(err as Error).message}`);
      }
    });
  }

  const server = new McpServer({ name: 'symbra', version: JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')).version }, { instructions: GUIDANCE });

  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

  server.registerTool(
    'explore',
    {
      title: 'Explore the codebase',
      description: 'Answer a natural-language or symbol question in one call: ranked relevant symbols with signatures, docs, source bodies, relations and paths, packed under a token budget. Understands "who calls X", "what breaks if I change X", "how does X reach Y", "where is X defined".',
      inputSchema: { question: z.string().describe('Question or symbol name'), budget: z.number().int().min(500).max(20000).optional().describe('Token budget (default 4000)'), source: z.boolean().optional().describe('Include source bodies (default true)') },
    },
    async ({ question, budget, source }) => {
      await ensureFresh();
      const pack = await exploreHybrid(store, question, { root, budget: budget ?? 4000, includeSource: source !== false });
      // explore() adds the "N further ranked symbols omitted" note itself for the free-form pack,
      // but the graph intents build their own text; surface the count either way.
      const omitted = pack.omitted && !pack.text.includes(`${pack.omitted} further ranked symbol`) ? `\n(${pack.omitted} further ranked symbol${pack.omitted === 1 ? '' : 's'} omitted to stay within the budget; ask again with a larger budget)` : '';
      return text(pack.text + omitted);
    },
  );

  server.registerTool(
    'symbol',
    {
      title: 'Symbol details',
      description: 'Definition, signature, doc, supertypes/subtypes, members, callers, callees, tests and source for a symbol. Accepts a name, Class.method, file:name or id.',
      inputSchema: { name: z.string(), source: z.boolean().optional().describe('Include the source body (default true)') },
    },
    async ({ name, source }) => {
      await ensureFresh();
      const syms = findSymbols(store, name, 5);
      if (!syms.length) return text(`${freshnessHeader(store, root)}\nNo symbol matches "${name}". Try search().`);
      const s = syms[0]!;
      const out: string[] = [freshnessHeader(store, root), fmtSymbolLine(s)];
      if (s.signature && s.signature !== s.fqn) out.push(s.signature);
      if (s.doc) out.push(s.doc);
      const m = store.prep('SELECT pagerank, callers, callees FROM metrics WHERE symbol = ?').get(s.id) as { pagerank: number; callers: number; callees: number } | undefined;
      out.push(`importance ${m?.pagerank.toFixed(1) ?? 0} · callers ${m?.callers ?? 0} · callees ${m?.callees ?? 0}`);
      const sup = store.prep("SELECT dst, kind FROM edges WHERE src = ? AND kind IN ('extends','implements')").all(s.id) as { dst: string; kind: string }[];
      for (const r of sup) out.push(`${r.kind} ${store.getSymbol(r.dst)?.fqn ?? r.dst}`);
      const subs = store.prep("SELECT src FROM edges WHERE dst = ? AND kind IN ('extends','implements')").all(s.id) as { src: string }[];
      if (subs.length) out.push(`subtypes: ${subs.map((r) => store.getSymbol(r.src)?.fqn).join(', ')}`);
      const members = store.children(s.id);
      if (members.length) out.push(`members: ${members.map((x) => `${x.name}${x.kind === 'method' ? '()' : ''}`).join(', ')}`);
      const callers = callersOf(store, s.id, ['calls', 'references', 'passes', 'decorates', 'defines_route']);
      // A candidate caller is a reference the resolver could not narrow to one definition; saying so
      // is the difference between an honest lead and a fabricated edge.
      const callerLine = (x: (typeof callers)[number]) => `  ${x.symbol.fqn}  ${x.edge.file}:${x.edge.line} [${edgeKindLabel(x.edge.kind)}${x.candidate === true ? `, candidate, conf ${x.edge.confidence}` : x.edge.confidence < 1 ? `, conf ${x.edge.confidence}` : ''}]`;
      if (callers.length) out.push(`callers (${callers.length}):\n${callers.slice(0, 25).map(callerLine).join('\n')}${callers.length > 25 ? `\n  … ${callers.length - 25} more` : ''}`);
      const callees = calleesOf(store, s.id, ['calls']);
      if (callees.length) out.push(`calls: ${[...new Set(callees.map((x) => x.symbol.fqn))].join(', ')}`);
      const tests = testsFor(store, s.id);
      if (tests.length) out.push(`tests (${tests.length}): ${tests.slice(0, 12).map((t) => `${t.file}::${t.name}`).join(', ')}`);
      // `s.file` is '' for synthetic symbols such as config_key, and join(root, '') is the root
      // directory itself, which would make readFileSync throw EISDIR.
      if (source !== false && s.kind !== 'module' && s.file && s.start_line > 0) {
        const abs = join(root, s.file);
        try {
          if (statSync(abs).isFile()) {
            const lines = readFileSync(abs, 'utf8').split('\n').slice(s.start_line - 1, Math.min(s.end_line, s.start_line + 119));
            out.push('```\n' + lines.join('\n') + (s.end_line - s.start_line + 1 > 120 ? '\n…' : '') + '\n```');
          }
        } catch (err) {
          out.push(`(source unavailable: ${(err as Error).message})`);
        }
      }
      if (syms.length > 1) out.push(`other matches: ${syms.slice(1).map((x) => `${x.fqn} (${x.file})`).join(', ')}`);
      return text(out.join('\n'));
    },
  );

  server.registerTool(
    'callers',
    { title: 'Callers of a symbol', description: 'Direct (or transitive, with depth) callers and referencers of a symbol with call-site file:line.', inputSchema: { name: z.string(), depth: z.number().int().min(1).max(4).optional() } },
    async ({ name, depth }) => {
      await ensureFresh();
      const s = findSymbols(store, name, 1)[0];
      if (!s) return text(`No symbol matches "${name}".`);
      const out = [freshnessHeader(store, root), fmtSymbolLine(s)];
      let frontier = [s.id];
      const seen = new Set(frontier);
      // A hub symbol can have thousands of callers per level; keep the response bounded.
      const PER_LEVEL = 40;
      for (let d = 1; d <= (depth ?? 1) && frontier.length; d++) {
        const next: string[] = [];
        const rows: string[] = [];
        let shown = 0;
        let total = 0;
        for (const id of frontier)
          for (const c of callersOf(store, id, ['calls', 'references', 'passes', 'decorates', 'defines_route'])) {
            total++;
            if (shown < PER_LEVEL) {
              rows.push(`${'  '.repeat(d)}<- ${fmtSymbolLine(c.symbol)} [${edgeKindLabel(c.edge.kind)} L${c.edge.line}${c.candidate === true ? ` (candidate, conf ${c.edge.confidence})` : c.edge.confidence < 1 ? ' conf ' + c.edge.confidence : ''}]`);
              shown++;
            }
            if (!seen.has(c.symbol.id)) {
              seen.add(c.symbol.id);
              next.push(c.symbol.id);
            }
          }
        out.push(...rows);
        if (total > shown) out.push(`${'  '.repeat(d)}… ${total - shown} more at depth ${d}`);
        frontier = next;
      }
      return text(out.join('\n'));
    },
  );

  server.registerTool(
    'callees',
    { title: 'Callees of a symbol', description: 'What a symbol calls and references, with lines.', inputSchema: { name: z.string() } },
    async ({ name }) => {
      await ensureFresh();
      const s = findSymbols(store, name, 1)[0];
      if (!s) return text(`No symbol matches "${name}".`);
      const out = [freshnessHeader(store, root), fmtSymbolLine(s)];
      for (const c of calleesOf(store, s.id, ['calls', 'references', 'passes'])) out.push(`  -> ${fmtSymbolLine(c.symbol)} [${edgeKindLabel(c.edge.kind)} L${c.edge.line}]`);
      return text(out.join('\n'));
    },
  );

  server.registerTool(
    'path',
    { title: 'Path between symbols', description: 'Shortest chain of calls/imports/inheritance connecting two symbols.', inputSchema: { from: z.string(), to: z.string(), directed: z.boolean().optional() } },
    async ({ from, to, directed }) => {
      await ensureFresh();
      const a = findSymbols(store, from, 1)[0];
      const b = findSymbols(store, to, 1)[0];
      if (!a || !b) return text(`Could not resolve ${!a ? from : to}.`);
      const p = shortestPath(store, a.id, b.id, { directed });
      if (!p) return text(`No path between ${a.fqn} and ${b.fqn} within 10 hops.`);
      return text([freshnessHeader(store, root), `${p.length - 1} hops`, ...p.map((h) => (h.via ? `  ${h.via.reversed ? '<--' : '-->'} [${h.via.kind}${h.via.line ? ' L' + h.via.line : ''}] ${fmtSymbolLine(h.symbol)}` : `  ${fmtSymbolLine(h.symbol)}`))].join('\n'));
    },
  );

  server.registerTool(
    'impact',
    {
      title: 'Blast radius',
      description: 'Everything that depends (transitively) on a symbol, grouped by depth, plus the tests that cover it. With no name, analyses the current git diff (working tree vs HEAD, or vs base).',
      inputSchema: { name: z.string().optional(), depth: z.number().int().min(1).max(5).optional(), base: z.string().optional().describe('git ref to diff against') },
    },
    async ({ name, depth, base }) => {
      await ensureFresh(true);
      let roots: string[] = [];
      const out = [freshnessHeader(store, root)];
      if (name) {
        const s = findSymbols(store, name, 1)[0];
        if (!s) return text(`No symbol matches "${name}".`);
        roots = [s.id];
        out.push(`impact of ${s.fqn}`);
      } else {
        const ch = changedSymbols(store, root, base);
        if (!ch.symbols.length) return text(`${out[0]}\nNo changed symbols in the diff.`);
        out.push(`changed: ${ch.symbols.map((s) => s.fqn).join(', ')}`);
        roots = ch.symbols.map((s) => s.id);
      }
      const r = impact(store, roots, { depth: depth ?? 3 });
      out.push(`${r.affected.length} dependent symbols in ${r.filesTouched.length} files · ${r.tests.length} tests`);
      let last = 0;
      for (const a of r.affected.slice(0, 120)) {
        if (a.depth !== last) {
          out.push(`depth ${a.depth}:`);
          last = a.depth;
        }
        out.push(`  ${fmtSymbolLine(a.symbol)}  ${a.kind} ${a.via}`);
      }
      if (r.tests.length) out.push(`tests to run:\n${r.tests.slice(0, 60).map((t) => `  ${t.file}::${t.name}`).join('\n')}${r.tests.length > 60 ? `\n  … ${r.tests.length - 60} more` : ''}`);
      return text(out.join('\n'));
    },
  );

  server.registerTool(
    'search',
    { title: 'Search symbols', description: 'Ranked symbol search (BM25 over names, split identifiers, signatures and docs, boosted by importance).', inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional(), kind: z.string().optional().describe('comma-separated kinds'), path: z.string().optional().describe('path prefix filter') } },
    async ({ query, limit, kind, path }) => {
      await ensureFresh();
      const hits = await searchHybrid(store, query, { limit: limit ?? 15, kinds: kind?.split(','), path });
      if (!hits.length) return text(`${freshnessHeader(store, root)}\nno matches`);
      return text([freshnessHeader(store, root), ...hits.map((h) => `${fmtSymbolLine(h.symbol)}${h.symbol.signature && h.symbol.signature !== h.symbol.fqn ? '  ' + h.symbol.signature.slice(0, 100) : ''}${h.symbol.doc ? '\n    ' + h.symbol.doc.split('\n')[0]!.slice(0, 120) : ''}`)].join('\n'));
    },
  );

  server.registerTool(
    'overview',
    { title: 'Architecture overview', description: 'Subsystems (communities with labels), hubs by importance, entry points/routes, environment variables, import cycles, index quality.', inputSchema: { communities: z.number().int().min(1).max(50).optional() } },
    async ({ communities }) => {
      await ensureFresh();
      return text(overview(store, root, { communities: communities ?? 12 }).text);
    },
  );

  server.registerTool(
    'status',
    { title: 'Index status', description: 'Index freshness, counts and stale files; optionally force a re-index.', inputSchema: { reindex: z.boolean().optional() } },
    async ({ reindex }) => {
      if (reindex) await ensureFresh(true);
      const files = store.allFiles().length;
      return text(`${freshnessHeader(store, root)}\nroot: ${root}\nfiles: ${files}`);
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise(() => {});
}
