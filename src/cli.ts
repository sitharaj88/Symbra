import { Command } from 'commander';
import { resolve, join, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { indexRepo } from './index/indexer.js';
import { Store, defaultDbPath } from './store/db.js';
import { search, findSymbols } from './query/search.js';
import { callersOf, calleesOf, impact, shortestPath, testsFor, changedSymbols, edgeKindLabel } from './query/graph.js';
import { explore } from './query/explore.js';
import { overview } from './query/overview.js';
import { fmtSymbolLine } from './query/format.js';
import { embedRepo, searchHybrid, exploreHybrid, embedUnavailableReason, DEFAULT_EMBED_KINDS } from './embed/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string };

/** Walk up from cwd to find a directory holding .symbra/index.db (or a git root). */
export function findRoot(p?: string): string {
  const start = resolve(p ?? process.cwd());
  let cur = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(cur, '.symbra', 'index.db'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  cur = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(cur, '.git'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return start;
}

async function openStore(root: string, autoIndex = true): Promise<Store> {
  if (!Store.exists(root)) {
    if (!autoIndex) throw new Error(`no index at ${root}. run: symbra index`);
    console.error('[symbra] no index yet, building…');
    await indexRepo({ root });
  }
  return new Store(defaultDbPath(root));
}

async function refresh(root: string, quiet = true): Promise<void> {
  const stats = await indexRepo({ root, log: quiet ? undefined : (m) => console.error(`[symbra] ${m}`) });
  if (!quiet || stats.changed || stats.deleted) console.error(`[symbra] refreshed: ${stats.changed} changed, ${stats.deleted} deleted (${stats.ms}ms)`);
}

function printSymbol(store: Store, s: import('./store/db.js').SymbolRow, root: string, withSource: boolean) {
  console.log(fmtSymbolLine(s));
  if (s.signature && s.signature !== s.fqn) console.log(`  ${s.signature}`);
  if (s.doc) console.log(s.doc.split('\n').slice(0, 6).map((l) => `  ${l}`).join('\n'));
  const m = store.prep('SELECT pagerank, callers, callees FROM metrics WHERE symbol = ?').get(s.id) as { pagerank: number; callers: number; callees: number } | undefined;
  const c = store.prep('SELECT l.label FROM communities c JOIN community_labels l ON l.community = c.community AND l.level = c.level WHERE c.symbol = ? AND c.level = 0').get(s.id) as { label: string } | undefined;
  console.log(`  importance ${m?.pagerank.toFixed(1) ?? '0'} · callers ${m?.callers ?? 0} · callees ${m?.callees ?? 0}${c ? ` · subsystem "${c.label}"` : ''}`);
  const parent = s.parent && s.parent !== s.file ? store.getSymbol(s.parent) : null;
  if (parent) console.log(`  in ${fmtSymbolLine(parent)}`);
  const sup = store.prep("SELECT dst, kind FROM edges WHERE src = ? AND kind IN ('extends','implements')").all(s.id) as { dst: string; kind: string }[];
  for (const r of sup) console.log(`  ${r.kind} ${store.getSymbol(r.dst)?.fqn ?? r.dst}`);
  const subs = store.prep("SELECT src FROM edges WHERE dst = ? AND kind IN ('extends','implements')").all(s.id) as { src: string }[];
  if (subs.length) console.log(`  subtypes: ${subs.slice(0, 10).map((r) => store.getSymbol(r.src)?.fqn).join(', ')}${subs.length > 10 ? ` +${subs.length - 10}` : ''}`);
  const members = store.children(s.id);
  if (members.length) console.log(`  members (${members.length}): ${members.slice(0, 20).map((x) => `${x.name}${x.kind === 'method' || x.kind === 'function' ? '()' : ''}`).join(', ')}${members.length > 20 ? ' …' : ''}`);
  const allCallers = callersOf(store, s.id, ['calls', 'references', 'passes', 'decorates', 'defines_route']);
  const docMentions = allCallers.filter((x) => x.symbol.kind === 'section' || x.symbol.file.endsWith('.md'));
  const callers = allCallers.filter((x) => !docMentions.includes(x)).sort((a, b) => (a.edge.kind === 'calls' ? 0 : 1) - (b.edge.kind === 'calls' ? 0 : 1) || (a.symbol.kind === 'test' ? 1 : 0) - (b.symbol.kind === 'test' ? 1 : 0));
  if (callers.length) {
    console.log(`  callers (${callers.length}):`);
    for (const x of callers.slice(0, 15)) console.log(`    ${x.symbol.fqn}  ${x.edge.file}:${x.edge.line} [${edgeKindLabel(x.edge.kind)}${x.edge.confidence < 1 ? ' ' + x.edge.confidence : ''}]`);
    if (callers.length > 15) console.log(`    … ${callers.length - 15} more`);
  }
  if (docMentions.length) console.log(`  mentioned in docs (${docMentions.length}): ${[...new Set(docMentions.map((x) => x.symbol.file))].slice(0, 6).join(', ')}`);
  const callees = calleesOf(store, s.id, ['calls']);
  if (callees.length) console.log(`  calls: ${[...new Set(callees.map((x) => x.symbol.fqn))].slice(0, 15).join(', ')}`);
  const tests = testsFor(store, s.id);
  if (tests.length) console.log(`  tests (${tests.length}): ${tests.slice(0, 8).map((t) => t.name).join(', ')}${tests.length > 8 ? ' …' : ''}`);
  if (withSource && s.kind !== 'module') {
    try {
      const lines = readFileSync(join(root, s.file), 'utf8').split('\n').slice(s.start_line - 1, Math.min(s.end_line, s.start_line + 79));
      console.log('  ---');
      console.log(lines.map((l) => `  ${l}`).join('\n'));
      if (s.end_line - s.start_line + 1 > 80) console.log('  …');
    } catch {
      /* file gone */
    }
  }
}

export async function main(argv: string[]) {
  const program = new Command();
  program.name('symbra').description('Local-first, live code intelligence for AI coding agents.').version(pkg.version);
  program.option('-C, --root <path>', 'repository root (default: nearest .symbra or .git upward)');
  const rootOf = () => findRoot(program.opts<{ root?: string }>().root);

  program
    .command('index')
    .description('Build or update the index (incremental; only changed files are re-parsed)')
    .argument('[path]', 'repository root')
    .option('--full', 'discard the existing index and rebuild from scratch')
    .option('-q, --quiet', 'only print the summary')
    .action(async (path: string | undefined, o: { full?: boolean; quiet?: boolean }) => {
      const root = path ? resolve(path) : rootOf();
      const stats = await indexRepo({ root, full: o.full, log: o.quiet ? undefined : (m) => console.error(`[symbra] ${m}`) });
      console.log(`indexed ${stats.files} files (${stats.changed} changed, ${stats.deleted} deleted) in ${(stats.ms / 1000).toFixed(1)}s`);
      console.log(`${stats.symbols} symbols, ${stats.edges} edges, internal imports ${stats.importsResolved}/${stats.importsTotal}, ${stats.unresolved} ambiguous refs kept as candidates`);
      console.log(`index: ${defaultDbPath(root)}`);
    });

  program
    .command('embed')
    .description('Compute local semantic vectors for symbols (optional tier; needs @huggingface/transformers, downloads a ~34 MB model once)')
    .argument('[path]', 'repository root')
    .option('--full', 're-embed every symbol instead of only new or changed ones')
    .option('--limit-kinds <kinds>', 'comma-separated symbol kinds to embed', DEFAULT_EMBED_KINDS.join(','))
    .option('--batch <n>', 'texts per model call', '64')
    .option('-q, --quiet', 'no progress output')
    .action(async (path: string | undefined, o: { full?: boolean; limitKinds: string; batch: string; quiet?: boolean }) => {
      const root = path ? resolve(path) : rootOf();
      if (Store.exists(root)) await refresh(root);
      const store = await openStore(root);
      const log = o.quiet ? undefined : (m: string) => console.error(`[symbra] ${m}`);
      let lastLine = 0;
      const stats = await embedRepo(store, {
        full: o.full,
        kinds: o.limitKinds.split(',').map((k) => k.trim()).filter(Boolean),
        batchSize: Number(o.batch) || 64,
        log,
        downloadProgress: o.quiet ? undefined : (file, pct) => process.stderr.write(`\r[symbra] downloading ${file} ${pct}%`),
        progress: o.quiet
          ? undefined
          : (done, total, rate) => {
              if (Date.now() - lastLine < 200 && done < total) return;
              lastLine = Date.now();
              process.stderr.write(`\r[symbra] embedding ${done}/${total} (${Math.round(rate)}/s)${done === total ? '\n' : ''}`);
            },
      });
      if (!stats.backend && stats.embedded === 0 && stats.candidates > stats.unchanged) console.log(`no vectors written: ${embedUnavailableReason() ?? 'model unavailable'}`);
      else console.log(`embedded ${stats.embedded} symbols (${stats.unchanged} unchanged, ${stats.removed} removed) in ${(stats.ms / 1000).toFixed(1)}s${stats.embedded ? ` · ${Math.round(stats.perSecond)} symbols/s` : ''}`);
      console.log(`${stats.vectors} vectors · model ${stats.model}${stats.backend ? ` · backend ${stats.backend}` : ''} · ${defaultDbPath(root)}`);
      store.close();
    });

  program
    .command('status')
    .description('Show index freshness and size')
    .action(async () => {
      const root = rootOf();
      if (!Store.exists(root)) {
        console.log(`no index at ${root}. run: symbra index`);
        return;
      }
      const store = new Store(defaultDbPath(root));
      const files = store.allFiles();
      const langs = new Map<string, number>();
      for (const f of files) langs.set(f.language, (langs.get(f.language) ?? 0) + 1);
      const at = Number(store.getMeta('indexed_at') ?? 0);
      console.log(`root: ${root}`);
      console.log(`indexed: ${at ? new Date(at).toISOString() : 'never'}  git: ${store.getMeta('git_head')?.slice(0, 10) ?? '-'}`);
      console.log(`files: ${files.length}  symbols: ${store.countSymbols()}  edges: ${store.countEdges()}`);
      console.log(`languages: ${[...langs.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`);
      const kinds = store.prep("SELECT kind, COUNT(*) AS n FROM symbols WHERE kind != 'module' GROUP BY kind ORDER BY n DESC").all() as { kind: string; n: number }[];
      console.log(`kinds: ${kinds.map((k) => `${k.kind}=${k.n}`).join(' ')}`);
      const ek = store.prep('SELECT kind, COUNT(*) AS n FROM edges GROUP BY kind ORDER BY n DESC').all() as { kind: string; n: number }[];
      console.log(`edges: ${ek.map((k) => `${k.kind}=${k.n}`).join(' ')}`);
      const rs = store.prep('SELECT resolver, COUNT(*) AS n FROM edges GROUP BY resolver ORDER BY n DESC').all() as { resolver: string; n: number }[];
      console.log(`resolvers: ${rs.map((k) => `${k.resolver}=${k.n}`).join(' ')}`);
      const un = (store.prep('SELECT COUNT(*) AS n FROM unresolved').get() as { n: number }).n;
      const imp = store.prep('SELECT COUNT(*) AS n, SUM(resolved IS NOT NULL) AS r FROM imports').get() as { n: number; r: number };
      console.log(`imports resolved: ${imp.r}/${imp.n}  ambiguous refs: ${un}`);
      const scip = store.countScipEdges();
      if (scip) {
        const at = Number(store.getMeta('scip_imported_at') ?? 0);
        console.log(`scip: ${scip} compiler-resolved edges${store.getMeta('scip_tool') ? ` from ${store.getMeta('scip_tool')}` : ''} (imported ${at ? new Date(at).toISOString() : '-'}, ${store.getMeta('scip_source') ?? '-'})`);
      }
      store.close();
    });

  program
    .command('import-scip')
    .description('Upgrade the graph with compiler-accurate references from a SCIP index (scip-typescript, scip-python, scip-java, scip-go, rust-analyzer, scip-clang, …)')
    .argument('<file>', 'path to index.scip')
    .option('--dry-run', 'report what would change without writing')
    .option('--no-analysis', 'skip recomputing PageRank and communities afterwards')
    .option('--include-variables', 'also create symbols for variable definitions Symbra did not extract')
    .option('-q, --quiet', 'only print the summary')
    .action(async (file: string, o: { dryRun?: boolean; analysis: boolean; includeVariables?: boolean; quiet?: boolean }) => {
      const root = rootOf();
      const store = await openStore(root);
      const { importScip } = await import('./scip/import.js');
      const s = importScip(store, root, resolve(file), { dryRun: o.dryRun, analyze: o.analysis, includeVariables: o.includeVariables, log: o.quiet ? undefined : (m) => console.error(`[symbra] ${m}`) });
      store.close();
      const verb = o.dryRun ? 'would import' : 'imported';
      console.log(`${verb} ${s.edges.total} scip edges from ${s.documentsMatched}/${s.documents} documents${s.tool ? ` (${s.tool})` : ''} in ${(s.ms / 1000).toFixed(1)}s`);
      console.log(`edges: calls=${s.edges.calls} references=${s.edges.references} extends=${s.edges.extends} implements=${s.edges.implements} tests=${s.edges.tests} decorates=${s.edges.decorates}`);
      console.log(`definitions: ${s.definitions} (${s.symbolsMatched} matched existing symbols, ${s.symbolsCreated} ${o.dryRun ? 'would be ' : ''}created${s.symbolsSkipped ? `, ${s.symbolsSkipped} variable definitions skipped — pass --include-variables to keep them` : ''})`);
      console.log(`references: ${s.references} (${s.referencesSkipped} external/local skipped) · heuristic edges ${o.dryRun ? 'to replace' : 'replaced'}: ${s.replaced} · candidate sets resolved: ${s.unresolvedRemoved}`);
    });

  program
    .command('search')
    .description('Rank symbols for a query (identifiers or plain words)')
    .argument('<query...>')
    .option('-n, --limit <n>', 'max results', '15')
    .option('-k, --kind <kinds>', 'comma-separated kinds (class,function,method,...)')
    .option('-p, --path <prefix>', 'restrict to a path prefix')
    .action(async (q: string[], o: { limit: string; kind?: string; path?: string }) => {
      const root = rootOf();
      const store = await openStore(root);
      const hits = await searchHybrid(store, q.join(' '), { limit: Number(o.limit), kinds: o.kind?.split(','), path: o.path });
      for (const h of hits) console.log(`${h.score.toFixed(1).padStart(6)}  ${fmtSymbolLine(h.symbol)}${h.symbol.doc ? '  — ' + h.symbol.doc.split('\n')[0]!.slice(0, 70) : ''}`);
      if (!hits.length) console.log('no matches');
      store.close();
    });

  program
    .command('symbol')
    .alias('explain')
    .description('Show a symbol: signature, doc, relations, tests, source')
    .argument('<name>', 'name, Class.method, file:name, or id')
    .option('--no-source', 'omit the source body')
    .option('-a, --all', 'show every match instead of the best one')
    .action(async (name: string, o: { source: boolean; all?: boolean }) => {
      const root = rootOf();
      const store = await openStore(root);
      const syms = findSymbols(store, name, 8);
      if (!syms.length) {
        console.log(`no symbol matches "${name}"`);
        store.close();
        return;
      }
      const show = o.all ? syms : syms.slice(0, 1);
      for (const s of show) {
        printSymbol(store, s, root, o.source);
        console.log();
      }
      if (!o.all && syms.length > 1) console.log(`other matches: ${syms.slice(1).map((s) => `${s.fqn} (${s.file})`).join(', ')}`);
      store.close();
    });

  program
    .command('callers')
    .description('Who calls or references a symbol')
    .argument('<name>')
    .option('-d, --depth <n>', 'transitive depth', '1')
    .action(async (name: string, o: { depth: string }) => {
      const root = rootOf();
      const store = await openStore(root);
      const s = findSymbols(store, name, 1)[0];
      if (!s) return void console.log(`no symbol matches "${name}"`);
      console.log(fmtSymbolLine(s));
      const depth = Number(o.depth);
      let frontier = [s.id];
      const seen = new Set(frontier);
      for (let d = 1; d <= depth && frontier.length; d++) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const c of callersOf(store, id, ['calls', 'references', 'passes', 'decorates', 'defines_route'])) {
            console.log(`${'  '.repeat(d)}<- ${fmtSymbolLine(c.symbol)}  [${edgeKindLabel(c.edge.kind)} L${c.edge.line}${c.edge.confidence < 1 ? ' ' + c.edge.confidence : ''}]`);
            if (!seen.has(c.symbol.id)) {
              seen.add(c.symbol.id);
              next.push(c.symbol.id);
            }
          }
        }
        frontier = next;
      }
      store.close();
    });

  program
    .command('callees')
    .description('What a symbol calls')
    .argument('<name>')
    .action(async (name: string) => {
      const root = rootOf();
      const store = await openStore(root);
      const s = findSymbols(store, name, 1)[0];
      if (!s) return void console.log(`no symbol matches "${name}"`);
      console.log(fmtSymbolLine(s));
      for (const c of calleesOf(store, s.id, ['calls', 'references', 'passes'])) console.log(`  -> ${fmtSymbolLine(c.symbol)}  [${edgeKindLabel(c.edge.kind)} L${c.edge.line}${c.edge.confidence < 1 ? ' ' + c.edge.confidence : ''}]`);
      store.close();
    });

  program
    .command('path')
    .description('Shortest path between two symbols')
    .argument('<from>')
    .argument('<to>')
    .option('--directed', 'follow edge direction only')
    .action(async (from: string, to: string, o: { directed?: boolean }) => {
      const root = rootOf();
      const store = await openStore(root);
      const a = findSymbols(store, from, 1)[0];
      const b = findSymbols(store, to, 1)[0];
      if (!a || !b) return void console.log(`could not resolve ${!a ? from : to}`);
      const p = shortestPath(store, a.id, b.id, { directed: o.directed });
      if (!p) console.log(`no path between ${a.fqn} and ${b.fqn}`);
      else {
        console.log(`${p.length - 1} hops`);
        for (const h of p) console.log(h.via ? `  ${h.via.reversed ? '<--' : '-->'} [${h.via.kind}${h.via.line ? ' L' + h.via.line : ''}] ${fmtSymbolLine(h.symbol)}` : `  ${fmtSymbolLine(h.symbol)}`);
      }
      store.close();
    });

  program
    .command('impact')
    .description('Blast radius of a symbol, or of the current git diff when no name is given')
    .argument('[name]')
    .option('-d, --depth <n>', 'traversal depth', '3')
    .option('--base <ref>', 'diff against this git ref instead of the working tree')
    .action(async (name: string | undefined, o: { depth: string; base?: string }) => {
      const root = rootOf();
      await refresh(root);
      const store = await openStore(root);
      let roots: string[] = [];
      if (name) {
        const s = findSymbols(store, name, 1)[0];
        if (!s) return void console.log(`no symbol matches "${name}"`);
        roots = [s.id];
      } else {
        const ch = changedSymbols(store, root, o.base);
        if (!ch.symbols.length) return void console.log('no changed symbols in the diff');
        console.log(`changed: ${ch.symbols.map((s) => s.fqn).join(', ')}`);
        roots = ch.symbols.map((s) => s.id);
      }
      const r = impact(store, roots, { depth: Number(o.depth) });
      console.log(`${r.affected.length} dependent symbols in ${r.filesTouched.length} files · ${r.tests.length} tests`);
      let last = 0;
      for (const a of r.affected.slice(0, 100)) {
        if (a.depth !== last) {
          console.log(`depth ${a.depth}:`);
          last = a.depth;
        }
        console.log(`  ${fmtSymbolLine(a.symbol)}  ${a.kind} ${a.via}`);
      }
      if (r.tests.length) {
        console.log('tests to run:');
        for (const t of r.tests.slice(0, 40)) console.log(`  ${t.file}::${t.name}`);
        if (r.tests.length > 40) console.log(`  … ${r.tests.length - 40} more`);
      }
      store.close();
    });

  program
    .command('explore')
    .alias('query')
    .description('One-shot context pack for a question (hybrid search + graph ranking, packed under a token budget)')
    .argument('<question...>')
    .option('-b, --budget <tokens>', 'token budget', '4000')
    .option('--no-source', 'omit source bodies')
    .action(async (q: string[], o: { budget: string; source: boolean }) => {
      const root = rootOf();
      await refresh(root);
      const store = await openStore(root);
      const pack = await exploreHybrid(store, q.join(' '), { root, budget: Number(o.budget), includeSource: o.source });
      console.log(pack.text);
      console.error(`[symbra] ${pack.symbols.length} symbols, ~${pack.tokens} tokens, intent=${pack.intent.type}`);
      store.close();
    });

  program
    .command('overview')
    .alias('report')
    .description('Architecture overview: subsystems, hubs, entry points, env vars, import cycles')
    .option('-c, --communities <n>', 'communities to list', '12')
    .action(async (o: { communities: string }) => {
      const root = rootOf();
      const store = await openStore(root);
      console.log(overview(store, root, { communities: Number(o.communities) }).text);
      store.close();
    });

  program
    .command('serve')
    .description('Run the MCP server (stdio) for AI agents; keeps the index fresh automatically')
    .option('--no-watch', 'do not watch the file system')
    .action(async (o: { watch: boolean }) => {
      const root = rootOf();
      const { serveMcp } = await import('./mcp/server.js');
      await serveMcp({ root, watch: o.watch });
    });

  program
    .command('watch')
    .description('Watch the repository and re-index changed files as you edit')
    .action(async () => {
      const root = rootOf();
      const { watchRepo } = await import('./watch/watcher.js');
      await indexRepo({ root, log: (m) => console.error(`[symbra] ${m}`) });
      console.error(`[symbra] watching ${root}`);
      watchRepo(root, (stats) => console.error(`[symbra] ${stats.changed} changed, ${stats.deleted} deleted → ${stats.symbols} symbols (${stats.ms}ms)`));
      await new Promise(() => {});
    });

  program
    .command('install')
    .description('Register the MCP server and a short guidance section with your AI coding tools')
    .option('-t, --tool <tools>', 'comma-separated: claude,cursor,codex,windsurf,vscode,gemini,arcturn,all', 'claude')
    .option('--global', 'user-level registration instead of project-level')
    .option('--hooks', 'also add a once-per-session Claude Code hint hook for grep-style searches')
    .option('--command <cmd>', 'override the MCP server command, e.g. "node /path/to/bin/symbra.js" for a local checkout instead of "npx -y symbra"')
    .action(async (o: { tool: string; global?: boolean; hooks?: boolean; command?: string }) => {
      const root = rootOf();
      const { install } = await import('./install/install.js');
      await install({ root, tools: o.tool.split(','), global: !!o.global, hooks: !!o.hooks, command: o.command });
    });

  program
    .command('hook', { hidden: true })
    .description('Claude Code PreToolUse hook entry point (reads the tool call from stdin)')
    .action(async () => {
      const { runHook } = await import('./install/hook.js');
      await runHook(rootOf());
    });

  program
    .command('grammars')
    .description('Prefetch or show the status of tree-sitter grammars (shipped, cached, missing)')
    .argument('[names...]', 'grammar names to fetch, e.g. dart elixir')
    .option('--all', 'fetch every long-tail grammar')
    .option('--list', 'show status of every known grammar without fetching anything')
    .action(async (names: string[], o: { all?: boolean; list?: boolean }) => {
      const { grammarManifest } = await import('./parse/grammar-manifest.js');
      const { grammarStatus, ensureGrammar } = await import('./parse/loader.js');
      if (o.list || (!o.all && names.length === 0)) {
        for (const g of grammarManifest) {
          const status = grammarStatus(g.name);
          console.log(`${g.name.padEnd(20)} ${status.padEnd(8)} ${g.core ? 'core' : 'long-tail'}  ${g.pkg}@${g.version}`);
        }
        if (!o.list) console.log('\npass names, or --all, to fetch long-tail grammars into the cache');
        return;
      }
      const targets = o.all ? grammarManifest.filter((g) => !g.core).map((g) => g.name) : names;
      if (!targets.length) return void console.log('nothing to fetch; pass grammar names, --all, or --list');
      for (const name of targets) {
        const before = grammarStatus(name);
        if (before !== 'missing') {
          console.log(`${name}: already ${before}`);
          continue;
        }
        try {
          const path = await ensureGrammar(name);
          console.log(`${name}: fetched -> ${path}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`${name}: ${msg.replace(/^GRAMMAR_UNAVAILABLE\|[^|]+\|/, '')}`);
        }
      }
    });

  program
    .command('viz')
    .description('Write a self-contained interactive HTML map of the codebase')
    .option('-o, --out <file>', 'output path', '.symbra/map.html')
    .option('--open', 'open in the default browser')
    .action(async (o: { out: string; open?: boolean }) => {
      const root = rootOf();
      const store = await openStore(root);
      const { refreshStaleAnalysis } = await import('./analyze/refresh.js');
      refreshStaleAnalysis(store);
      const { writeViz } = await import('./viz/viz.js');
      const out = writeViz(store, root, resolve(root, o.out));
      store.close();
      console.log(`wrote ${out}`);
      if (o.open) {
        const { exec } = await import('node:child_process');
        exec(`${process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'} "${out}"`);
      }
    });

  await program.parseAsync(argv);
}
