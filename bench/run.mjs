#!/usr/bin/env node
// Retrieval-quality benchmark for Codeloom.
//
//   node bench/run.mjs [--repo <name>] [--kind <kind>] [--verbose] [--save-baseline] [--budget <tokens>] [--no-embed]
//
// Runs every question in bench/questions.json against the live index of the repository named in
// bench/repos.json (name -> root holding .codeloom/index.db) through the library API, and reports
// recall@1, recall@5, found-anywhere, MRR and mean tokens per repo, per kind and overall.
//
// Rank semantics per question kind (1-based position of the first gold symbol):
//   search   ranked hits of search(question)                       -> hits[i].symbol
//   explore  the packed context of explore(question)               -> pack.symbols in packed order
//   callers  explore(question) with a callers intent               -> the callers (edge order: file, line), then the resolved targets
//   impact   explore(question) with an impact intent               -> impact().affected (depth, then score), then the resolved roots
//   path     explore(question) with a path intent                  -> intermediate hops of the shortest path, then the endpoints
// When the intent is not detected the list falls back to what explore() packed. For callers/impact/
// path the lists are only loosely ranked, so `found` (gold appears anywhere) is the primary column
// there; hit@1 then means "the first neighbour listed is a right one".
//
// The retrieval path is the hybrid one (searchHybrid/exploreHybrid), so the semantic tier is
// measured whenever the repo has vectors and the model is cached. `--no-embed` sets
// CODELOOM_EMBED=0 before the library is imported, which gives the lexical-only arm from the same
// script. BENCH_RESULTS_DIR overrides where results are written (e.g. a lexical-only run into
// bench/results/lexical.json's directory).
//
// Writes <results>/latest.json. With <results>/baseline.json present it prints the delta
// and exits 1 when overall recall@5 drops more than 3 points below the baseline.
// --save-baseline copies the fresh results to bench/results/baseline.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = process.env.BENCH_RESULTS_DIR ? resolve(process.env.BENCH_RESULTS_DIR) : join(BENCH_DIR, 'results');
const KINDS = ['explore', 'search', 'callers', 'impact', 'path'];
const REGRESSION_POINTS = 3;

// The library is imported after the arguments are parsed, so `--no-embed` can switch the semantic
// tier off before any module reads the environment.
const OPTS = parseArgs(process.argv.slice(2));
if (OPTS.noEmbed) process.env.CODELOOM_EMBED = '0';

const { Store, defaultDbPath } = await import('../dist/index.js');
const { findSymbols } = await import('../dist/query/search.js');
const { callersOf, impact, shortestPath } = await import('../dist/query/graph.js');
const { fmtSymbolLine, estimateTokens } = await import('../dist/query/format.js');
const { searchHybrid, exploreHybrid, hasVectors } = await import('../dist/embed/index.js');

// ---------------------------------------------------------------------------------------------
// args

function parseArgs(argv) {
  const o = { repo: null, kind: null, verbose: false, saveBaseline: false, noEmbed: false, budget: 4000, questions: join(BENCH_DIR, 'questions.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') o.repo = argv[++i];
    else if (a === '--kind') o.kind = argv[++i];
    else if (a === '--verbose' || a === '-v') o.verbose = true;
    else if (a === '--save-baseline') o.saveBaseline = true;
    else if (a === '--no-embed') o.noEmbed = true;
    else if (a === '--budget') o.budget = Number(argv[++i]);
    else if (a === '--questions') o.questions = resolve(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('usage: node bench/run.mjs [--repo <name>] [--kind explore|search|callers|impact|path] [--verbose] [--save-baseline] [--no-embed] [--budget <tokens>] [--questions <file>]');
      console.log('       BENCH_RESULTS_DIR=<dir> overrides where latest.json/baseline.json are written');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (o.kind && !KINDS.includes(o.kind)) {
    console.error(`--kind must be one of ${KINDS.join(', ')}`);
    process.exit(2);
  }
  return o;
}

// ---------------------------------------------------------------------------------------------
// gold resolution

/** Resolve a gold entry (symbol id or fqn) to the set of matching symbol ids. */
function resolveGold(store, g) {
  const byId = store.getSymbol(g);
  if (byId) return [byId.id];
  const byFqn = store.prep('SELECT id FROM symbols WHERE fqn = ?').all(g).map((r) => r.id);
  if (byFqn.length) return byFqn;
  // tolerate a fqn suffix such as `Context.Header` when it is unambiguous
  const bySuffix = store.prep("SELECT id FROM symbols WHERE fqn LIKE ? AND kind != 'module'").all(`%.${g}`).map((r) => r.id);
  if (bySuffix.length === 1) return bySuffix;
  return [];
}

// ---------------------------------------------------------------------------------------------
// running one question

/**
 * A question is "hard" when it does not spell out the name of any gold symbol: every gold name
 * token would have to be present in the question for a pure lexical matcher to have an easy time.
 * This is the subset where the semantic tier is supposed to earn its keep.
 */
function isHard(q) {
  const qt = new Set((q.question.toLowerCase().match(/[a-z0-9]+/g) ?? []));
  for (const g of q.gold ?? []) {
    const simple = g.split(/[.#/()]/).filter(Boolean).pop() ?? g;
    const toks = simple
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((t) => t.toLowerCase());
    if (toks.length && toks.every((t) => qt.has(t))) return false;
  }
  return true;
}

function uniqueSymbols(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

async function runQuestion(store, root, q, budget) {
  const t0 = performance.now();
  let returned = [];
  let tokens = 0;
  let intent = null;
  if (q.kind === 'search') {
    const hits = await searchHybrid(store, q.question, { limit: 20 });
    returned = hits.map((h) => h.symbol);
    tokens = estimateTokens(returned.map(fmtSymbolLine).join('\n'));
    intent = 'search';
  } else {
    const pack = await exploreHybrid(store, q.question, { root, budget });
    tokens = pack.tokens;
    intent = pack.intent.type;
    if (q.kind === 'explore') {
      returned = pack.symbols;
    } else if (q.kind === 'callers') {
      // callers first, then the resolved targets, so rank 1 = the first caller listed
      const cs = intent === 'callers' ? pack.symbols.slice(0, 2).flatMap((s) => callersOf(store, s.id, ['calls', 'references', 'decorates', 'defines_route']).map((c) => c.symbol)) : [];
      returned = [...cs, ...pack.symbols];
    } else if (q.kind === 'impact') {
      const aff = intent === 'impact' ? impact(store, pack.symbols.map((s) => s.id), { depth: 3 }).affected.map((a) => a.symbol) : [];
      returned = [...aff, ...pack.symbols];
    } else if (q.kind === 'path') {
      returned = [...pack.symbols];
      if (intent === 'path' && pack.symbols.length === 2) {
        const p = shortestPath(store, pack.symbols[0].id, pack.symbols[1].id);
        // intermediate hops first, endpoints last
        if (p) returned = [...p.slice(1, -1).map((h) => h.symbol), ...pack.symbols];
      }
    }
  }
  returned = uniqueSymbols(returned);
  const ms = performance.now() - t0;
  const rank = returned.findIndex((s) => q.goldIds.has(s.id)) + 1; // 0 = not found
  return {
    repo: q.repo,
    question: q.question,
    kind: q.kind,
    hard: isHard(q) ? 1 : 0,
    gold: q.gold,
    notes: q.notes ?? '',
    intent,
    rank,
    hit1: rank === 1 ? 1 : 0,
    hit5: rank >= 1 && rank <= 5 ? 1 : 0,
    found: rank >= 1 ? 1 : 0,
    rr: rank ? 1 / rank : 0,
    tokens,
    ms: Math.round(ms),
    returnedCount: returned.length,
    top: returned.slice(0, 5).map((s) => ({ id: s.id, kind: s.kind, fqn: s.fqn, file: s.file, line: s.start_line })),
  };
}

// ---------------------------------------------------------------------------------------------
// aggregation

function aggregate(rows) {
  const n = rows.length;
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  return {
    n,
    recall1: n ? (100 * sum('hit1')) / n : 0,
    recall5: n ? (100 * sum('hit5')) / n : 0,
    found: n ? (100 * sum('found')) / n : 0,
    mrr: n ? sum('rr') / n : 0,
    tokens: n ? sum('tokens') / n : 0,
    ms: n ? sum('ms') / n : 0,
  };
}

function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r[key])) m.set(r[key], []);
    m.get(r[key]).push(r);
  }
  return m;
}

const pad = (s, w, right = false) => (right ? String(s).padStart(w) : String(s).padEnd(w));
const f1 = (x) => x.toFixed(1);

function printTable(title, groups, overall) {
  console.log(`\n${title}`);
  const header = `${pad('', 12)} ${pad('n', 4, true)} ${pad('R@1', 6, true)} ${pad('R@5', 6, true)} ${pad('found', 6, true)} ${pad('MRR', 6, true)} ${pad('tokens', 7, true)} ${pad('ms', 6, true)}`;
  console.log(header);
  console.log('-'.repeat(header.length));
  const line = (name, a) => console.log(`${pad(name, 12)} ${pad(a.n, 4, true)} ${pad(f1(a.recall1), 6, true)} ${pad(f1(a.recall5), 6, true)} ${pad(f1(a.found), 6, true)} ${pad(a.mrr.toFixed(3), 6, true)} ${pad(Math.round(a.tokens), 7, true)} ${pad(Math.round(a.ms), 6, true)}`);
  for (const [name, a] of groups) line(name, a);
  console.log('-'.repeat(header.length));
  line('overall', overall);
}

function deltaLine(name, cur, base) {
  if (!base) return `${pad(name, 12)} (no baseline entry)`;
  const d = (k, digits = 1) => {
    const v = cur[k] - base[k];
    return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;
  };
  return `${pad(name, 12)} R@1 ${pad(d('recall1'), 6, true)}  R@5 ${pad(d('recall5'), 6, true)}  found ${pad(d('found'), 6, true)}  MRR ${pad(d('mrr', 3), 7, true)}  tokens ${pad(d('tokens', 0), 6, true)}`;
}

// ---------------------------------------------------------------------------------------------
// main

async function main() {
  const opts = OPTS;
  const repos = JSON.parse(readFileSync(join(BENCH_DIR, 'repos.json'), 'utf8'));
  delete repos._comment;
  let questions = JSON.parse(readFileSync(opts.questions, 'utf8'));
  if (opts.repo) questions = questions.filter((q) => q.repo === opts.repo);
  if (opts.kind) questions = questions.filter((q) => q.kind === opts.kind);
  if (!questions.length) {
    console.error('no questions selected');
    process.exit(2);
  }

  const results = [];
  const semanticRepos = [];
  const invalid = [];
  const skipped = [];
  const stores = new Map();
  const byRepo = groupBy(questions, 'repo');
  for (const [repo, qs] of byRepo) {
    const rootRaw = repos[repo];
    if (!rootRaw) {
      skipped.push({ repo, reason: 'not in bench/repos.json', n: qs.length });
      continue;
    }
    const root = isAbsolute(rootRaw) ? rootRaw : resolve(BENCH_DIR, rootRaw);
    if (!Store.exists(root)) {
      skipped.push({ repo, reason: `no index at ${defaultDbPath(root)} (run: codeloom index --full in that repo)`, n: qs.length });
      continue;
    }
    const store = new Store(defaultDbPath(root));
    stores.set(repo, store);
    if (hasVectors(store)) semanticRepos.push(repo);
    for (const q of qs) {
      if (!KINDS.includes(q.kind)) {
        invalid.push({ ...q, reason: `unknown kind ${q.kind}` });
        continue;
      }
      const goldIds = new Set();
      const unresolved = [];
      for (const g of q.gold ?? []) {
        const ids = resolveGold(store, g);
        if (!ids.length) unresolved.push(g);
        for (const id of ids) goldIds.add(id);
      }
      if (!goldIds.size) {
        invalid.push({ ...q, reason: `gold not found in index: ${unresolved.join(', ')}` });
        continue;
      }
      if (unresolved.length && opts.verbose) console.error(`warn: ${repo} "${q.question}": gold not in index: ${unresolved.join(', ')}`);
      results.push(await runQuestion(store, root, { ...q, goldIds }, opts.budget));
    }
  }
  for (const s of stores.values()) s.close();

  // ---- report
  const overall = aggregate(results);
  const perRepo = new Map([...groupBy(results, 'repo')].map(([k, v]) => [k, aggregate(v)]));
  const perKind = new Map([...groupBy(results, 'kind')].map(([k, v]) => [k, aggregate(v)]));
  const perIntentMismatch = results.filter((r) => r.kind !== 'search' && r.kind !== 'explore' && r.intent !== r.kind);

  console.log(`codeloom retrieval benchmark · ${results.length} questions · ${perRepo.size} repos · budget ${opts.budget} tokens · semantic tier ${opts.noEmbed ? 'off (--no-embed)' : semanticRepos.length ? `on (${semanticRepos.join(', ')})` : 'on (no repo has vectors)'}`);
  printTable('By repository', perRepo, overall);
  printTable('By question kind', perKind, overall);
  const hardRows = results.filter((r) => r.hard);
  if (hardRows.length) {
    const easyRows = results.filter((r) => !r.hard);
    printTable('By difficulty (hard = the question does not name the gold symbol)', new Map([['hard', aggregate(hardRows)], ['easy', aggregate(easyRows)]]), overall);
  }

  if (perIntentMismatch.length) {
    console.log(`\nIntent mismatches (${perIntentMismatch.length}): explore() did not detect the expected intent`);
    for (const r of perIntentMismatch) console.log(`  [${r.repo}] "${r.question}" expected ${r.kind}, got ${r.intent}`);
  }

  const misses = results.filter((r) => !r.hit5);
  console.log(`\nMisses (gold not in top 5): ${misses.length}/${results.length}`);
  for (const r of misses) {
    console.log(`\n  [${r.repo}/${r.kind}] ${r.question}`);
    console.log(`    gold: ${r.gold.join(' | ')}`);
    console.log(`    rank: ${r.rank || 'not found'}${r.rank ? '' : ` (of ${r.returnedCount} returned)`}`);
    console.log(`    got:  ${r.top.length ? r.top.map((t, i) => `${i + 1}. [${t.kind}] ${t.fqn} (${t.file}:${t.line})`).join('\n          ') : '(nothing)'}`);
    if (opts.verbose && r.notes) console.log(`    notes: ${r.notes}`);
  }
  if (opts.verbose) {
    console.log('\nAll questions');
    for (const r of results) console.log(`  ${pad(r.rank || '-', 3, true)}  ${pad(r.repo, 10)} ${pad(r.kind, 8)} ${pad(r.tokens, 6, true)}tok  ${r.question}`);
  }
  if (invalid.length) {
    console.log(`\nInvalid questions (excluded): ${invalid.length}`);
    for (const q of invalid) console.log(`  [${q.repo}] "${q.question}": ${q.reason}`);
  }
  if (skipped.length) {
    console.log(`\nSkipped repositories:`);
    for (const s of skipped) console.log(`  ${s.repo} (${s.n} questions): ${s.reason}`);
  }

  // ---- persist
  mkdirSync(RESULTS_DIR, { recursive: true });
  const out = {
    generatedAt: new Date().toISOString(),
    options: { repo: opts.repo, kind: opts.kind, budget: opts.budget, embed: !opts.noEmbed, semanticRepos },
    overall,
    perRepo: Object.fromEntries(perRepo),
    perKind: Object.fromEntries(perKind),
    hard: aggregate(results.filter((r) => r.hard)),
    easy: aggregate(results.filter((r) => !r.hard)),
    invalid: invalid.map((q) => ({ repo: q.repo, question: q.question, reason: q.reason })),
    skipped,
    questions: results,
  };
  writeFileSync(join(RESULTS_DIR, 'latest.json'), JSON.stringify(out, null, 2));
  console.log(`\nwrote ${join(RESULTS_DIR, 'latest.json')}`);

  const baselinePath = join(RESULTS_DIR, 'baseline.json');
  if (opts.saveBaseline) {
    writeFileSync(baselinePath, JSON.stringify(out, null, 2));
    console.log(`saved baseline to ${baselinePath}`);
    return 0;
  }
  if (!existsSync(baselinePath)) {
    console.log('no baseline yet (run with --save-baseline to create one)');
    return 0;
  }
  const base = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const filtered = opts.repo || opts.kind;
  console.log(`\nDelta vs baseline (${base.generatedAt}${filtered ? '; note: a filtered run is compared against the matching baseline subset' : ''})`);
  // compare on the same question set: recompute the baseline aggregate over questions present in this run
  const key = (r) => `${r.repo} ${r.question}`;
  const baseByKey = new Map((base.questions ?? []).map((r) => [key(r), r]));
  const baseRows = results.map((r) => baseByKey.get(key(r))).filter(Boolean);
  const baseOverall = baseRows.length === results.length ? aggregate(baseRows) : base.overall;
  if (baseRows.length !== results.length) console.log(`  (${results.length - baseRows.length} questions are new since the baseline; comparing against the stored overall figures)`);
  const baseRepo = new Map([...groupBy(baseRows, 'repo')].map(([k, v]) => [k, aggregate(v)]));
  for (const [repo, a] of perRepo) console.log('  ' + deltaLine(repo, a, baseRepo.get(repo) ?? base.perRepo?.[repo]));
  console.log('  ' + deltaLine('overall', overall, baseOverall));
  const changed = results.filter((r) => {
    const b = baseByKey.get(key(r));
    return b && b.rank !== r.rank;
  });
  if (changed.length) {
    console.log(`\n  Rank changes (${changed.length}):`);
    for (const r of changed) {
      const b = baseByKey.get(key(r));
      const better = (r.rank && (!b.rank || r.rank < b.rank)) ? 'better' : 'worse';
      console.log(`    ${better === 'better' ? '+' : '-'} [${r.repo}/${r.kind}] ${r.question}: ${b.rank || 'miss'} -> ${r.rank || 'miss'}`);
    }
  }
  const drop = baseOverall.recall5 - overall.recall5;
  if (drop > REGRESSION_POINTS) {
    console.log(`\nREGRESSION: overall recall@5 ${f1(overall.recall5)} is ${f1(drop)} points below baseline ${f1(baseOverall.recall5)}`);
    return 1;
  }
  console.log(`\nOK: overall recall@5 ${f1(overall.recall5)} vs baseline ${f1(baseOverall.recall5)}`);
  return 0;
}

process.exit(await main());
