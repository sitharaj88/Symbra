import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Store, SymbolRow } from '../store/db.js';
import { search, findSymbols, type SearchHit } from './search.js';
import { cachedGraph, callersOf, calleesOf, impact, shortestPath, testsFor, edgeKindLabel } from './graph.js';
import { EDGE_WEIGHT } from '../analyze/metrics.js';
import { fmtSymbolLine, estimateTokens, indent } from './format.js';

export interface ExploreOptions {
  budget?: number; // tokens
  root: string;
  depth?: number;
  includeSource?: boolean;
  /** Semantic hits (src/embed) fused into the retrieval seeds; see `exploreHybrid`. */
  semantic?: SearchHit[];
}

export type Intent = { type: 'callers'; target: string } | { type: 'impact'; target: string } | { type: 'path'; from: string; to: string } | { type: 'define'; target: string } | { type: 'explore' };

// Identifier shapes a question may name: Ruby bang/predicate methods (`handle_exception!`, `empty?`),
// Ruby/C++/PHP scope operators (`Foo::bar`), Rust/C# generics-free paths and anonymous suffixes
// (`Handle#2`), plus the usual dots and slashes. `?` is allowed inside a name but a lone trailing `?`
// is treated as the question mark it almost always is (see `stripQuestionMark`).
const ID = String.raw`[\p{L}\p{N}_$][\p{L}\p{N}_$.:/#!?-]*`;
const re = (body: string) => new RegExp(body, 'iu');

export function detectIntent(q: string): Intent {
  const s = q.trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(re(String.raw`^(?:who|what)\s+(?:calls|uses|invokes|references|depends on)\s+\x60?(${ID})\x60?\??$`))) || (m = s.match(re(String.raw`^(?:callers|usages|references)\s+(?:of|for)\s+\x60?(${ID})\x60?\??$`))))
    return { type: 'callers', target: m[1]! };
  if ((m = s.match(re(String.raw`^(?:what (?:breaks|is affected|would break|happens) if (?:i|we)?\s*(?:change|modify|edit|remove|delete|rename)|impact of(?: changing)?|blast radius (?:of|for))\s+\x60?(${ID})\x60?\??$`))))
    return { type: 'impact', target: m[1]! };
  if (
    (m = s.match(re(String.raw`^(?:how (?:does|do|is)\s+)?\x60?(${ID})\x60?\s+(?:reach|reaches|connect(?:s|ed)? to|get(?:s)? to|call(?:s)?|relate(?:s)? to|lead(?:s)? to|flow(?:s)? to)\s+\x60?(${ID})\x60?\??$`))) ||
    (m = s.match(re(String.raw`^path (?:from|between)\s+\x60?(${ID})\x60?\s+(?:to|and)\s+\x60?(${ID})\x60?$`)))
  )
    return { type: 'path', from: m[1]!, to: m[2]! };
  if ((m = s.match(re(String.raw`^(?:where is|where'?s|find|show|define|definition of|what is|explain)\s+\x60?(${ID})\x60?(?:\s+defined)?\??$`)))) return { type: 'define', target: m[1]! };
  if (new RegExp(String.raw`^${ID}$`, 'u').test(s) && /\p{L}/u.test(s)) return { type: 'define', target: s };
  return { type: 'explore' };
}

/**
 * Resolve the symbol a routed question names. A trailing `?` is ambiguous: `empty?` is a real Ruby
 * predicate method, while `who calls send?` ends in a question mark. Try it as part of the name
 * first, then without.
 */
function resolveTarget(store: Store, target: string, limit: number): SymbolRow[] {
  const hit = findSymbolsExact(store, target, limit);
  if (hit.length) return hit;
  if (target.endsWith('?')) {
    const alt = findSymbolsExact(store, target.slice(0, -1), limit);
    if (alt.length) return alt;
  }
  return findSymbols(store, target, limit);
}

/** findSymbols without its fuzzy last resort, so the `?`-stripping retry gets a chance. */
function findSymbolsExact(store: Store, target: string, limit: number): SymbolRow[] {
  const rows = findSymbols(store, target, limit);
  if (rows.length === 1 && (rows[0]!.name === target || rows[0]!.fqn === target || rows[0]!.id === target)) return rows;
  return rows.filter((r) => r.name === target || r.fqn === target || r.fqn.endsWith(`.${target}`) || r.id === target);
}

const CONTAINS_KIND_ID = 10;

/**
 * Personalised PageRank from seed symbols; returns scores over graph indices.
 *
 * `containsScale` damps `contains` edges. They run in both directions here, so with their full
 * weight a class collects the mass of every member that matched the question and always outranks the
 * one member that actually answers it. Containment still carries a trickle, because a class whose
 * members all match is genuinely relevant.
 */
export function personalizedPageRank(store: Store, seeds: Map<string, number>, iterations = 25, alpha = 0.15, containsScale = 0.15): Map<string, number> {
  const g = cachedGraph(store);
  const n = g.ids.length;
  if (!n || !seeds.size) return new Map();
  const kw = (w: number, k: number) => (k === CONTAINS_KIND_ID ? w * containsScale : w);
  const restart = new Float64Array(n);
  let total = 0;
  for (const [id, w] of seeds) {
    const i = g.index.get(id);
    if (i === undefined) continue;
    restart[i] = w;
    total += w;
  }
  if (!total) return new Map();
  for (let i = 0; i < n; i++) restart[i] = restart[i]! / total;
  // Use both directions so callers and callees of a seed are reachable.
  const outW = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const [, w, k] of g.out[i]!) s += kw(w, k);
    for (const [, w, k] of g.in[i]!) s += kw(w, k) * 0.7;
    outW[i] = s;
  }
  let pr = Float64Array.from(restart);
  const next = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) next[i] = alpha * restart[i]!;
    for (let i = 0; i < n; i++) {
      const p = pr[i]!;
      if (p === 0 || outW[i] === 0) continue;
      const share = ((1 - alpha) * p) / outW[i]!;
      for (const [j, w, k] of g.out[i]!) next[j] = next[j]! + share * kw(w, k);
      for (const [j, w, k] of g.in[i]!) next[j] = next[j]! + share * kw(w, k) * 0.7;
    }
    const tmp = pr;
    pr = next as Float64Array<ArrayBuffer>;
    (next as Float64Array).set(tmp); // reuse buffer
  }
  const out = new Map<string, number>();
  for (let i = 0; i < n; i++) if (pr[i]! > 1e-7) out.set(g.ids[i]!, pr[i]!);
  return out;
}

function readSource(root: string, s: SymbolRow, maxLines = 80): { text: string; truncated: boolean } {
  try {
    const content = readFileSync(join(root, s.file), 'utf8');
    let lines = content.split('\n').slice(s.start_line - 1, s.end_line);
    // Drop a leading docstring / JSDoc block that is already rendered as `doc`.
    if (s.doc && lines.length > 2) {
      const openRe = /^\s*(?:[rRuUbB]*"""|[rRuUbB]*'''|\/\*\*)/;
      const first = lines.findIndex((l, i) => i > 0 && i < 3 && openRe.test(l));
      if (first > 0) {
        const l0 = lines[first]!;
        const closer = l0.includes('"""') ? '"""' : l0.includes("'''") ? "'''" : '*/';
        let endIdx = first;
        const sameLine = closer !== '*/' && l0.split(closer).length > 2;
        if (!sameLine) {
          endIdx = lines.findIndex((l, i) => i > first && l.includes(closer));
          if (endIdx < 0) endIdx = first;
        }
        lines = [...lines.slice(0, first), ...lines.slice(endIdx + 1)];
      }
    }
    const truncated = lines.length > maxLines;
    const body = (truncated ? [...lines.slice(0, maxLines), '    …'] : lines).join('\n');
    return { text: body, truncated };
  } catch {
    return { text: '', truncated: false };
  }
}

/** For class-like symbols: header plus member signatures instead of the raw body. */
function classOutline(store: Store, s: SymbolRow): string {
  const members = store.children(s.id);
  const lines = [s.signature || s.fqn];
  for (const m of members.slice(0, 40)) lines.push(`    ${m.signature || m.name}${m.doc ? `  # ${m.doc.split('\n')[0]!.slice(0, 60)}` : ''}`);
  if (members.length > 40) lines.push(`    … ${members.length - 40} more members`);
  return lines.join('\n');
}

function staleFiles(store: Store, root: string, files: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const f of new Set(files)) {
    if (!f) continue;
    const row = store.getFile(f);
    if (!row) continue;
    try {
      const st = statSync(join(root, f));
      if (st.size !== row.size || Math.abs(st.mtimeMs - row.mtime) > 1) out.add(f);
    } catch {
      out.add(f);
    }
  }
  return out;
}

export interface ContextPack {
  text: string;
  tokens: number;
  symbols: SymbolRow[];
  intent: Intent;
  /** Ranked symbols that did not fit the budget. Reported so the caller can ask for more. */
  omitted?: number;
}

export function explore(store: Store, question: string, opts: ExploreOptions): ContextPack {
  const budget = opts.budget ?? 4000;
  const intent = detectIntent(question);
  const lines: string[] = [];
  const header = freshnessHeader(store, opts.root);
  lines.push(header);

  if (intent.type === 'callers') {
    const syms = resolveTarget(store, intent.target, 3);
    if (!syms.length) return notFound(intent.target, store, question, header, intent);
    for (const s of syms.slice(0, 2)) {
      lines.push(`## Callers of ${fmtSymbolLine(s)}`);
      const cs = callersOf(store, s.id, ['calls', 'references', 'passes', 'decorates', 'defines_route']);
      if (!cs.length) lines.push('(no callers indexed)');
      for (const c of cs.slice(0, 60))
        lines.push(`- ${fmtSymbolLine(c.symbol)}  via ${edgeKindLabel(c.edge.kind)} at ${c.edge.file}:${c.edge.line}${c.candidate ? ` (candidate, conf ${c.edge.confidence})` : c.edge.confidence < 1 ? ` (conf ${c.edge.confidence})` : ''}`);
      if (cs.length > 60) lines.push(`… ${cs.length - 60} more`);
      const ts = testsFor(store, s.id);
      if (ts.length) lines.push(`Tests: ${ts.slice(0, 12).map((t) => t.fqn).join(', ')}${ts.length > 12 ? ` … +${ts.length - 12}` : ''}`);
    }
    const text = lines.join('\n');
    return { text, tokens: estimateTokens(text), symbols: syms, intent };
  }

  if (intent.type === 'impact') {
    const syms = resolveTarget(store, intent.target, 2);
    if (!syms.length) return notFound(intent.target, store, question, header, intent);
    const r = impact(store, syms.map((s) => s.id), { depth: opts.depth ?? 3 });
    lines.push(`## Impact of changing ${syms.map((s) => s.fqn).join(', ')}`);
    lines.push(`${r.affected.length} dependent symbols across ${r.filesTouched.length} files, ${r.tests.length} tests`);
    let last = 0;
    for (const a of r.affected.slice(0, 80)) {
      if (a.depth !== last) {
        lines.push(`### depth ${a.depth}`);
        last = a.depth;
      }
      lines.push(`- ${fmtSymbolLine(a.symbol)}  ${a.kind} ${a.via}`);
    }
    if (r.tests.length) lines.push(`### tests to run\n${r.tests.slice(0, 40).map((t) => `- ${t.file}::${t.name}`).join('\n')}`);
    const text = lines.join('\n');
    return { text, tokens: estimateTokens(text), symbols: syms, intent };
  }

  if (intent.type === 'path') {
    const a = resolveTarget(store, intent.from, 1)[0];
    const b = resolveTarget(store, intent.to, 1)[0];
    if (!a) return notFound(intent.from, store, question, header, intent);
    if (!b) return notFound(intent.to, store, question, header, intent);
    const p = shortestPath(store, a.id, b.id);
    lines.push(`## Path from ${a.fqn} to ${b.fqn}`);
    if (!p) lines.push('No path found within 10 hops.');
    else {
      lines.push(`${p.length - 1} hops`);
      for (const h of p) lines.push(h.via ? `  ${h.via.reversed ? '<--' : '-->'} [${h.via.kind}${h.via.line ? ' L' + h.via.line : ''}] ${fmtSymbolLine(h.symbol)}` : `  ${fmtSymbolLine(h.symbol)}`);
    }
    const text = lines.join('\n');
    return { text, tokens: estimateTokens(text), symbols: [a, b], intent };
  }

  // define / explore: hybrid search + PPR, packed under budget
  let hits: SearchHit[] = intent.type === 'define' ? resolveTarget(store, intent.target, 6).map((s) => ({ symbol: s, score: 10, pagerank: 0, callers: 0, community: null })) : search(store, question, { limit: 12, semantic: opts.semantic });
  if (!hits.length) return notFound(question, store, question, header, intent);
  // Prefer real symbols over whole files as seeds when enough of them matched.
  const nonModule = hits.filter((h) => h.symbol.kind !== 'module');
  if (nonModule.length >= 3) hits = nonModule;
  const seeds = new Map<string, number>();
  hits.forEach((h, i) => seeds.set(h.symbol.id, Math.max(0.1, h.score) / (i + 1)));
  const ppr = personalizedPageRank(store, seeds);
  const rankedPpr = [...ppr.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
  // reciprocal rank fusion
  const fused = new Map<string, number>();
  hits.forEach((h, i) => fused.set(h.symbol.id, (fused.get(h.symbol.id) ?? 0) + 1 / (i + 1)));
  const testFiles = new Set((store.prep('SELECT path FROM files WHERE is_test = 1').all() as { path: string }[]).map((r) => r.path));
  rankedPpr.forEach(([id], i) => {
    const s = store.getSymbol(id);
    if (!s || s.kind === 'module' || s.kind === 'test' || testFiles.has(s.file)) return;
    fused.set(id, (fused.get(id) ?? 0) + 0.7 / (i + 1));
  });
  for (const [id] of fused) {
    const s = store.getSymbol(id);
    if (s && (s.kind === 'test' || testFiles.has(s.file))) fused.set(id, fused.get(id)! * 0.2);
  }
  let ordered = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => store.getSymbol(id)!).filter(Boolean);
  ordered = hoistMembers(ordered, new Map(hits.map((h, i) => [h.symbol.id, i])));
  const stale = staleFiles(store, opts.root, ordered.map((s) => s.file));
  const packed: SymbolRow[] = [];
  let used = estimateTokens(lines.join('\n'));
  lines.push(`## Context for: ${question}`);
  const bodyAllowance = Math.floor(budget * 0.55);
  const hardCap = Math.floor(budget * 1.05);
  let bodyUsed = 0;
  let omitted = 0;
  for (const s of ordered) {
    if (packed.length >= 25 || (packed.length >= 3 && used >= budget)) {
      omitted++;
      continue;
    }
    const entry: string[] = [];
    entry.push(`### ${fmtSymbolLine(s)}${stale.has(s.file) ? '  (STALE: file changed since index)' : ''}`);
    if (s.signature && s.signature !== s.fqn) entry.push(s.signature);
    if (s.doc) entry.push(indent(s.doc.split('\n').slice(0, 4).join('\n'), '  '));
    const rel = relations(store, s);
    if (rel) entry.push(rel);
    let block = entry.join('\n');
    const withSource = opts.includeSource !== false && bodyUsed < bodyAllowance && packed.length < 6 && s.kind !== 'module' && s.kind !== 'section';
    if (withSource) {
      const isClassLike = ['class', 'interface', 'struct', 'trait', 'enum'].includes(s.kind);
      const src = isClassLike ? { text: classOutline(store, s), truncated: false } : readSource(opts.root, s, 60);
      if (src.text) {
        const srcTokens = estimateTokens(src.text);
        if ((bodyUsed + srcTokens <= bodyAllowance && used + srcTokens < hardCap) || packed.length < 2) {
          block += `\n\`\`\`\n${src.text}\n\`\`\``;
          bodyUsed += srcTokens;
        }
      }
    }
    const t = estimateTokens(block);
    if (used + t > budget && packed.length >= 3) {
      omitted++;
      continue;
    }
    lines.push(block);
    used += t;
    packed.push(s);
  }
  const edgesText = edgesAmong(store, packed);
  if (edgesText && used + estimateTokens(edgesText) <= hardCap) {
    lines.push(edgesText);
    used += estimateTokens(edgesText);
  }
  if (omitted) lines.push(`(${omitted} further ranked symbol${omitted === 1 ? '' : 's'} omitted to stay within the ${budget}-token budget)`);
  const text = lines.join('\n');
  return { text, tokens: estimateTokens(text), symbols: packed, intent, omitted };
}

const CLASS_LIKE = new Set(['class', 'interface', 'struct', 'trait', 'enum', 'namespace', 'module']);

/**
 * A question is almost never answered by a class; it is answered by one of its methods. Containment
 * makes the parent score at least as high as any member (it matches every member's text and collects
 * their PageRank mass), so a member the lexical tier ranked at least as highly as its own parent is
 * moved in front of it. `lexRank` is the position of a symbol in the raw search ranking.
 */
function hoistMembers(ordered: SymbolRow[], lexRank: Map<string, number>): SymbolRow[] {
  const out = [...ordered];
  const rank = (id: string) => lexRank.get(id) ?? Infinity;
  for (let i = 0; i < out.length; i++) {
    const parent = out[i]!;
    if (!CLASS_LIKE.has(parent.kind)) continue;
    let best = -1;
    for (let j = i + 1; j < out.length; j++) {
      const c = out[j]!;
      if (c.parent !== parent.id) continue;
      if (rank(c.id) > rank(parent.id)) continue; // only a member retrieval liked at least as much
      if (best < 0 || rank(c.id) < rank(out[best]!.id)) best = j;
    }
    if (best < 0) continue;
    const [c] = out.splice(best, 1);
    out.splice(i, 0, c!);
    i++;
  }
  return out;
}

function relations(store: Store, s: SymbolRow): string {
  const parts: string[] = [];
  const callees = calleesOf(store, s.id, ['calls']).slice(0, 8);
  const sup = store.prep("SELECT dst FROM edges WHERE src = ? AND kind IN ('extends','implements')").all(s.id) as { dst: string }[];
  const subs = store.prep("SELECT src FROM edges WHERE dst = ? AND kind IN ('extends','implements')").all(s.id) as { src: string }[];
  if (sup.length) parts.push(`extends: ${sup.map((r) => store.getSymbol(r.dst)?.fqn ?? r.dst).join(', ')}`);
  if (subs.length) parts.push(`subtypes: ${subs.slice(0, 8).map((r) => store.getSymbol(r.src)?.fqn ?? r.src).join(', ')}${subs.length > 8 ? ` +${subs.length - 8}` : ''}`);
  const allCallers = callersOf(store, s.id, ['calls']).filter((c) => c.symbol.kind !== 'test');
  if (allCallers.length) {
    const top = allCallers.slice(0, 6);
    parts.push(`callers (${allCallers.length}): ${top.map((c) => `${c.symbol.fqn}${c.candidate ? ' (candidate)' : ''}`).join(', ')}${allCallers.length > 6 ? ' …' : ''}`);
  }
  const mentions = store.prep("SELECT COUNT(*) AS n FROM edges e JOIN symbols s2 ON s2.id = e.src WHERE e.dst = ? AND e.kind = 'references' AND s2.kind = 'section'").get(s.id) as { n: number };
  if (mentions.n) parts.push(`mentioned in docs: ${mentions.n} places`);
  if (callees.length) parts.push(`calls: ${[...new Set(callees.map((c) => c.symbol.fqn))].join(', ')}`);
  if (['class', 'interface', 'struct', 'trait', 'enum', 'namespace'].includes(s.kind)) {
    const members = store.children(s.id);
    if (members.length) parts.push(`members (${members.length}): ${members.slice(0, 14).map((m) => m.name).join(', ')}${members.length > 14 ? ' …' : ''}`);
  }
  const routes = store.prep("SELECT src FROM edges WHERE dst = ? AND kind = 'defines_route'").all(s.id) as { src: string }[];
  if (routes.length) parts.push(`routes: ${routes.map((r) => store.getSymbol(r.src)?.name ?? r.src).join(', ')}`);
  return parts.map((p) => `  ${p}`).join('\n');
}

function edgesAmong(store: Store, syms: SymbolRow[]): string {
  if (syms.length < 2) return '';
  const ids = new Set(syms.map((s) => s.id));
  const out: string[] = [];
  for (const s of syms) {
    const rows = store.prep('SELECT dst, kind, line FROM edges WHERE src = ?').all(s.id) as { dst: string; kind: string; line: number }[];
    for (const r of rows) if (ids.has(r.dst) && r.kind !== 'tests') out.push(`${s.fqn} --${r.kind}--> ${store.getSymbol(r.dst)?.fqn} (L${r.line})`);
  }
  if (!out.length) return '';
  const uniq = [...new Set(out)].slice(0, 40);
  return `## Relations among the symbols above\n${uniq.join('\n')}`;
}

function notFound(target: string, store: Store, question: string, header: string, intent: Intent): ContextPack {
  const alt = search(store, question, { limit: 8 });
  const text = [header, `No symbol matched "${target}".`, alt.length ? `Closest matches:\n${alt.map((h) => `- ${fmtSymbolLine(h.symbol)}`).join('\n')}` : ''].filter(Boolean).join('\n');
  return { text, tokens: estimateTokens(text), symbols: alt.map((h) => h.symbol), intent };
}

export function freshnessHeader(store: Store, root: string): string {
  // `indexed_at` is a content stamp (it only moves when something changed); `checked_at` moves on
  // every run. The freshness the agent cares about is "when did we last look", so lead with that
  // and name the content stamp only when the two differ.
  const indexedAt = Number(store.getMeta('indexed_at') ?? 0);
  const checkedAt = Number(store.getMeta('checked_at') ?? 0) || indexedAt;
  const ago = (at: number) => {
    const age = at ? Math.round((Date.now() - at) / 1000) : -1;
    return age < 0 ? 'never' : age < 90 ? `${age}s ago` : age < 5400 ? `${Math.round(age / 60)}m ago` : `${Math.round(age / 3600)}h ago`;
  };
  const checkedText = ago(checkedAt);
  const indexedText = ago(indexedAt);
  const freshness = indexedText === checkedText ? `index ${checkedText}` : `index ${indexedText}, checked ${checkedText}`;
  const head = store.getMeta('git_head')?.slice(0, 8);
  void root;
  return `[symbra] ${freshness}${head ? ` @ ${head}` : ''} · ${store.countSymbols()} symbols · ${store.countEdges()} edges`;
}

export { fmtSymbolLine };
