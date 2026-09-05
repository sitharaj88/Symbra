import type { Store, SymbolRow } from '../store/db.js';
import { splitIdentifier } from '../store/db.js';
import { isPeripheralPath, hasFlutterOrKmpRoot } from '../analyze/peripheral.js';

export { PERIPHERAL_PATH, isPeripheralPath, hasFlutterOrKmpRoot } from '../analyze/peripheral.js';
import { fuseHits } from '../embed/fuse.js';

const STOP = new Set(
  'a an the of to in on for and or is are was were be been being do does did how what where when which who whom why can could should would will shall may might must this that these those it its with without from by as at into about over under between through during before after above below up down out off again further then once here there all any both each few more most other some such no nor not only own same so than too very s t just now i me my we our you your he she they them their code function class method file module implement implemented implementation work works working use uses used using does define defined definition handle handles handled get set find show me tell explain describe list'.split(' '),
);

const KIND_BOOST: Record<string, number> = {
  class: 1.3,
  interface: 1.25,
  struct: 1.25,
  trait: 1.25,
  enum: 1.1,
  function: 1.15,
  method: 1.1,
  constructor: 0.9,
  route: 1.2,
  module: 0.6,
  section: 0.6,
  test: 0.5,
  variable: 0.8,
  constant: 0.85,
  field: 0.7,
  property: 0.85,
  enum_member: 0.6,
  config_key: 0.9,
  type_alias: 1.0,
  // a per-file `namespace Foo;` declaration is a container, not an answer: same prior as a module
  namespace: 0.6,
};

/** Rust `impl` blocks and Swift/Kotlin extensions carry the type's name but are not the type. */
export function isReopenedBlock(s: SymbolRow): boolean {
  return !!s.meta && (s.meta.includes('"impl":true') || s.meta.includes('"extension":true'));
}

/**
 * A symbol whose doc text was copied down from a supertype/interface member by `inheritDocs`
 * (src/analyze/inherit_docs.ts), rather than written for this symbol. Interfaces and their
 * implementations then carry identical prose, which dilutes BM25: every sibling implementation
 * looks like an equally good match for a query about the doc's words. Returns the source symbol
 * id (the `doc_from` value) when inherited, or null when the doc is the symbol's own.
 */
export function inheritedDocFrom(s: SymbolRow): string | null {
  if (!s.meta || !s.meta.includes('"doc_from"')) return null;
  try {
    const v = (JSON.parse(s.meta) as Record<string, unknown>).doc_from;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}
/** Discount applied to the BM25 component of a hit whose doc was inherited, not written. */
const INHERITED_DOC_DISCOUNT = 0.85;

/**
 * Test scaffolding recognised from the path alone. `files.is_test` is set by the indexer's own
 * heuristics and misses shapes such as `src/test-helpers/scratch.ts` (production-looking module,
 * imported only by tests). A helper like that has many callers, so the caller prior lifts it over
 * the real answer unless it is demoted here. Matching on the path costs nothing and closes the gap
 * without a re-index.
 */
export const TEST_PATH =
  /(^|\/)(?:__tests__|__mocks__|tests?|specs?|testing|test-helpers?|test-utils?|testutil|mocks?)\/|(^|\/)[^/]*[._-](?:test|tests|spec|specs)\.[^/]+$|(^|\/)(?:conftest|test_[^/]*)\.[^/]+$/i;

/** True when the store marked the file as a test, or its path alone gives it away. */
export function isTestFile(file: string, testFiles: ReadonlySet<string>): boolean {
  return testFiles.has(file) || TEST_PATH.test(file);
}

/**
 * A natural-language question ("what makes the agent loop stop", "where is a tool call checked")
 * rather than a name lookup ("runLoop", "http parser"). What answers a question like this is code
 * that *does* something — a function or a method — not a data-shaped declaration that happens to
 * contain the same words, so the kind prior is re-weighted for these.
 */
const QUESTION_LEAD = /^\s*(?:how|what|where|why|when|which|who|whose|does|do|did|is|are|can|could|should|would|explain|describe)\b/i;

export function isBehaviouralQuestion(q: string, termCount: number): boolean {
  return termCount >= 3 && QUESTION_LEAD.test(q);
}

/**
 * Kind prior applied on top of KIND_BOOST for behavioural questions only. Declarations (a property,
 * a field, an interface, a type alias) name the vocabulary of an answer; the function or method is
 * the answer. Nothing is boosted here — functions and methods win by the others being damped, so a
 * question never scores higher overall than the same words asked as a lookup.
 */
const QUESTION_KIND_BOOST: Record<string, number> = {
  property: 0.78,
  field: 0.78,
  variable: 0.8,
  constant: 0.8,
  enum_member: 0.8,
  class: 0.86,
  interface: 0.86,
  struct: 0.86,
  trait: 0.86,
  enum: 0.86,
  type_alias: 0.86,
};

export interface SearchHit {
  symbol: SymbolRow;
  score: number;
  pagerank: number;
  callers: number;
  community: number | null;
  /** Cosine similarity when the hit came from (or was confirmed by) the semantic tier. */
  cosine?: number;
}

export interface SearchOptions {
  limit?: number;
  kinds?: string[];
  /** Restrict to a path prefix. */
  path?: string;
  includeTests?: boolean;
  /** Semantic hits (src/embed `semanticSearch`) to fuse by reciprocal rank with the lexical ranking. */
  semantic?: SearchHit[];
}

/**
 * A token is "code-shaped" when its spelling alone marks it as an identifier rather than English:
 * interior capital (CamelCase / httpVersion), underscore, dollar, digit, or a dotted path.
 */
export function isCodeShaped(t: string): boolean {
  return /[_$]/.test(t) || t.includes('.') || /\d/.test(t) || /[a-z][A-Z]/.test(t) || (/^[A-Z]/.test(t) && /[A-Z]/.test(t.slice(1)));
}

/** Tokenise a question or identifier list into search terms. Keeps code-ish tokens verbatim too. */
export function queryTerms(q: string): { terms: string[]; idents: string[]; quoted: string[] } {
  const identRe = /[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*/gu;
  const idents = (q.match(identRe) ?? []).filter((t) => /[A-Z_]/.test(t) || t.includes('.') || t.length >= 4);
  // identifiers the user marked as code with backticks or quotes are always treated as code-shaped
  const quoted: string[] = [];
  for (const m of q.matchAll(/[`'"]([^`'"]{1,80})[`'"]/g)) for (const t of m[1]!.match(identRe) ?? []) quoted.push(t);
  const words = splitIdentifier(q.replace(/[^\p{L}\p{N}$.\-\s]/gu, ' '))
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP.has(w));
  const terms = new Set(words);
  // light stemming so "greeting" finds "greet", "handlers" finds "handler"
  for (const w of words) {
    for (const suf of ['ings', 'ing', 'ed', 'ers', 'er', 'es', 's', 'ly', 'tion']) {
      if (w.length - suf.length >= 4 && w.endsWith(suf)) {
        terms.add(w.slice(0, -suf.length));
        break;
      }
    }
  }
  return { terms: [...terms], idents: [...new Set(idents)], quoted: [...new Set(quoted)] };
}

/**
 * Inverse document frequency of each term over symbol names, so that a rare word ("obfuscate")
 * outweighs a ubiquitous one ("request", "handler"). Counted over the name and split-name columns
 * only: that is where a term earns its discriminating power.
 */
function termIdf(store: Store, terms: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const n = Math.max(1, store.countSymbols());
  for (const t of terms) {
    if (!/^[\p{L}\p{N}_$]+$/u.test(t)) continue;
    let df = 0;
    try {
      df = (store.prep('SELECT COUNT(*) AS n FROM symbols_fts WHERE symbols_fts MATCH ?').get(`{name split_name} : (${ftsEscape(t)} OR ${ftsEscape(t)}*)`) as { n: number }).n;
    } catch {
      df = 0;
    }
    out.set(t, Math.max(0.15, Math.log((n + 1) / (df + 1))));
  }
  return out;
}

function ftsEscape(t: string): string {
  return `"${t.replace(/"/g, '""')}"`;
}

/** Build an FTS5 MATCH expression: any term, with prefix matching for longer tokens. */
export function ftsQuery(terms: string[]): string {
  const parts: string[] = [];
  for (const t of terms) {
    if (!/^[\p{L}\p{N}_$]+$/u.test(t)) continue;
    parts.push(t.length >= 3 ? `(${ftsEscape(t)} OR ${ftsEscape(t)}*)` : ftsEscape(t));
  }
  return parts.join(' OR ');
}

export function search(store: Store, q: string, opts: SearchOptions = {}): SearchHit[] {
  const limit = opts.limit ?? 20;
  const { terms, idents, quoted } = queryTerms(q);
  if (!terms.length && !idents.length) return [];
  const testFiles = new Set((store.prep('SELECT path FROM files WHERE is_test = 1').all() as { path: string }[]).map((r) => r.path));
  const flutterOrKmpRoot = hasFlutterOrKmpRoot(store);
  const hits = new Map<string, SearchHit>();
  const pr = (id: string) => (store.prep('SELECT pagerank, callers FROM metrics WHERE symbol = ?').get(id) as { pagerank: number; callers: number } | undefined) ?? { pagerank: 0, callers: 0 };
  const comm = (id: string) => (store.prep('SELECT community FROM communities WHERE symbol = ? AND level = 0').get(id) as { community: number } | undefined)?.community ?? null;

  // 1. exact identifier matches (name or fqn) get a strong bonus.
  //    The bonus is only full strength for code-shaped tokens: a plain English word such as
  //    "request" or "format" must not outrank real retrieval just because some symbol is named that.
  //    It is further divided by the token's inverse frequency, so a name shared by 36 impl blocks
  //    carries a sixth of the weight of a unique one.
  const quotedSet = new Set(quoted.map((t) => t.toLowerCase()));
  const AMBIGUOUS = 200; // a name this common carries no signal, and fetching it all is wasted work
  // A plain dictionary word ("checked", "stop", "loop") earns the exact-name bonus only when the
  // whole query is one or two words, i.e. the user was naming a symbol. Inside a sentence it is
  // English, not an identifier: "where is a tool call checked for permission" must not be decided
  // by the one property in the repo that happens to be spelled `checked`, which at n=1 collected
  // the full 22 * 0.35 and outweighed every other signal combined.
  const lookup = terms.length <= 2;
  for (const ident of idents) {
    const last = ident.includes('.') ? ident.slice(ident.lastIndexOf('.') + 1) : ident;
    const dotted = ident.includes('.');
    const n = dotted
      ? (store.prep('SELECT COUNT(*) AS n FROM symbols WHERE fqn = ? OR fqn LIKE ?').get(ident, `%.${ident}`) as { n: number }).n
      : (store.prep('SELECT COUNT(*) AS n FROM symbols WHERE name = ? COLLATE NOCASE').get(last) as { n: number }).n;
    if (!n || n > AMBIGUOUS) continue;
    const rows = dotted
      ? (store.prep('SELECT * FROM symbols WHERE fqn = ? OR fqn LIKE ? LIMIT ?').all(ident, `%.${ident}`, AMBIGUOUS) as SymbolRow[])
      : (store.prep('SELECT * FROM symbols WHERE name = ? COLLATE NOCASE LIMIT ?').all(last, AMBIGUOUS) as SymbolRow[]);
    if (!rows.length) continue;
    const codeish = isCodeShaped(ident) || quotedSet.has(ident.toLowerCase());
    if (!codeish && !lookup) continue;
    const idf = 1 / (1 + Math.log2(n));
    const shape = codeish ? 1 : 0.35;
    for (const s of rows) {
      const exact = s.name === last || s.fqn === ident;
      const h = hits.get(s.id) ?? { symbol: s, score: 0, ...pr(s.id), community: null };
      h.score += (exact ? 22 : 10) * idf * shape;
      hits.set(s.id, h);
    }
  }
  // 2. BM25 over name / split name / fqn / signature / doc
  const match = ftsQuery([...terms, ...idents.map((i) => i.toLowerCase()).filter((i) => /^[\p{L}\p{N}_$]+$/u.test(i))]);
  if (match) {
    const rows = store
      .prep(`SELECT id, bm25(symbols_fts, 0, 6.0, 4.0, 2.0, 1.5, 1.0, 0.8) AS rank FROM symbols_fts WHERE symbols_fts MATCH ? ORDER BY rank LIMIT ?`)
      .all(match, Math.max(60, limit * 6)) as { id: string; rank: number }[];
    for (const r of rows) {
      const s = store.getSymbol(r.id);
      if (!s) continue;
      const h = hits.get(s.id) ?? { symbol: s, score: 0, ...pr(s.id), community: null };
      // bm25 is negative-better; convert to positive. A hit whose doc was copied down from a
      // supertype (not exact-name matches, only this BM25 contribution) is discounted: it shares
      // its prose with every sibling implementation, so matching it says less than matching a
      // symbol with its own doc.
      const bm25 = Math.min(10, -r.rank);
      h.score += inheritedDocFrom(s) ? bm25 * INHERITED_DOC_DISCOUNT : bm25;
      hits.set(s.id, h);
    }
  }
  // 3. term coverage, weighted by inverse document frequency: matching "decompressor" says far more
  //    than matching "request". Coverage of the symbol's own *name* counts for more than coverage of
  //    its fqn or signature, which inherit their words from the enclosing class.
  const idf = termIdf(store, terms);
  const behavioural = isBehaviouralQuestion(q, terms.length);
  let idfTotal = 0;
  for (const t of terms) idfTotal += idf.get(t) ?? 0;
  // 4. importance and kind priors, test demotion
  const out: SearchHit[] = [];
  for (const h of hits.values()) {
    const s = h.symbol;
    if (idfTotal > 0) {
      const nameHay = `${s.name} ${splitIdentifier(s.name)}`.toLowerCase();
      const fullHay = `${nameHay} ${s.fqn} ${s.signature}`.toLowerCase();
      let cov = 0;
      let nameCov = 0;
      let nameHits = 0;
      for (const t of terms) {
        const w = idf.get(t) ?? 0;
        if (fullHay.includes(t)) cov += w;
        if (nameHay.includes(t)) {
          nameCov += w;
          nameHits++;
        }
      }
      h.score += (cov / idfTotal) * 3 + (nameCov / idfTotal) * 3.5;
      // every word of the question is in this symbol's own name
      if (terms.length >= 2 && nameHits === terms.length) h.score += 2;
    }
    if (opts.kinds?.length && !opts.kinds.includes(s.kind)) continue;
    if (opts.path && !s.file.startsWith(opts.path)) continue;
    const isTest = s.kind === 'test' || isTestFile(s.file, testFiles);
    if (isTest && !opts.includeTests) h.score *= 0.35;
    h.score *= KIND_BOOST[s.kind] ?? 1;
    if (behavioural) h.score *= QUESTION_KIND_BOOST[s.kind] ?? 1;
    // an `impl Bytes` / `extension HTTPHeader` block must rank behind the `struct Bytes` it reopens
    if (isReopenedBlock(s)) h.score *= 0.5;
    if (isPeripheralPath(s.file, flutterOrKmpRoot)) h.score *= 0.6;
    h.score += Math.log1p(h.pagerank) * 0.8 + Math.log1p(h.callers) * 0.3;
    if (s.doc) h.score += 0.3;
    h.community = comm(s.id);
    out.push(h);
  }
  // A hit whose doc is inherited from another hit in this same result set: when they tie on
  // score, the source (the symbol the doc was actually written on) is the more useful answer.
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aFrom = inheritedDocFrom(a.symbol);
    const bFrom = inheritedDocFrom(b.symbol);
    if (aFrom === b.symbol.id && bFrom !== a.symbol.id) return 1;
    if (bFrom === a.symbol.id && aFrom !== b.symbol.id) return -1;
    return a.symbol.fqn < b.symbol.fqn ? -1 : 1;
  });
  // 5. duplicate-name crowding: 36 `impl Bytes` blocks, per-file `namespace Slim;` declarations and
  //    Swift extensions all match the same name and would fill the whole top-5. Keep the best one at
  //    full weight and halve each further occurrence of the same fqn, then re-sort.
  dampenDuplicateFqns(out);
  // 6. optional semantic tier: reciprocal-rank fusion when vectors were available
  if (opts.semantic?.length) return fuseHits(out, opts.semantic, opts, limit);
  return out.slice(0, limit);
}

/**
 * Damp each repeat of an fqn already seen higher in the ranking (1, 0.5, 0.25, ...).
 * Only *redundant* repeats are damped hard: reopened impl/extension blocks, per-file namespace
 * declarations, modules and doc sections. Genuine overloads in different files (three `grow`
 * functions, three `Mediator.Send` overloads) are barely touched, because any of them can be the
 * answer.
 */
const REDUNDANT_KINDS = new Set(['namespace', 'module', 'section']);
function dampenDuplicateFqns(out: SearchHit[]): void {
  const seen = new Map<string, number>();
  let changed = false;
  for (const h of out) {
    const k = seen.get(h.symbol.fqn) ?? 0;
    seen.set(h.symbol.fqn, k + 1);
    if (k === 0) continue;
    const redundant = isReopenedBlock(h.symbol) || REDUNDANT_KINDS.has(h.symbol.kind);
    h.score *= Math.pow(redundant ? 0.5 : 0.92, Math.min(k, 6));
    changed = true;
  }
  if (changed) out.sort((a, b) => b.score - a.score || (a.symbol.fqn < b.symbol.fqn ? -1 : 1));
}

/** Resolve a user-supplied symbol reference (name, fqn, file:name, or id) to symbols. */
export function findSymbols(store: Store, text: string, limit = 8): SymbolRow[] {
  const t = text.trim();
  const byId = store.getSymbol(t);
  if (byId) return [byId];
  // file::fqn or file:name
  const m = t.match(/^(.+?)::?(.+)$/);
  if (m && (m[1]!.includes('/') || m[1]!.includes('.'))) {
    const rows = store.prep('SELECT * FROM symbols WHERE file LIKE ? AND (fqn = ? OR name = ?) LIMIT 500').all(`%${m[1]}%`, m[2]!, m[2]!) as SymbolRow[];
    if (rows.length) return rankPreferred(store, rows).slice(0, limit);
  }
  // Every candidate is fetched and ranked before it is truncated: `limit` used to cut the rows off
  // inside SQLite, so `path BytesMut` resolved to whichever impl block SQLite happened to return.
  // Exact-fqn and exact-name candidates are ranked together, with a bonus for the exact fqn, so a
  // test helper whose bare fqn matches ("BoundaryGenerator" in Tests/) cannot beat the production
  // symbol whose fqn is qualified ("MultipartFormData.BoundaryGenerator").
  const exactFqn = store.prep('SELECT * FROM symbols WHERE fqn = ? LIMIT 500').all(t) as SymbolRow[];
  const exactName = store.prep("SELECT * FROM symbols WHERE name = ? AND kind != 'module' LIMIT 500").all(t) as SymbolRow[];
  if (exactFqn.length || exactName.length) {
    const cand = new Map<string, SymbolRow>();
    const bonus = new Map<string, number>();
    for (const r of exactFqn) {
      cand.set(r.id, r);
      bonus.set(r.id, 8);
    }
    for (const r of exactName) if (!cand.has(r.id)) cand.set(r.id, r);
    return rankPreferred(store, [...cand.values()], bonus).slice(0, limit);
  }
  const ci = store.prep("SELECT * FROM symbols WHERE (name = ? COLLATE NOCASE OR fqn LIKE ?) AND kind != 'module' LIMIT 500").all(t, `%.${t}`) as SymbolRow[];
  if (ci.length) return rankPreferred(store, ci).slice(0, limit);
  return search(store, t, { limit }).map((h) => h.symbol);
}

/**
 * Order equally-named symbols by how likely each is to be the one the user meant: production over
 * test, exported over private, a real definition over a reopened impl/extension block or a README
 * section, then by PageRank. Metrics are prefetched in one query instead of one per comparison.
 */
function rankPreferred(store: Store, rows: SymbolRow[], bonus?: Map<string, number>): SymbolRow[] {
  if (rows.length < 2) return rows;
  const testFiles = new Set((store.prep('SELECT path FROM files WHERE is_test = 1').all() as { path: string }[]).map((r) => r.path));
  const flutterOrKmpRoot = hasFlutterOrKmpRoot(store);
  const pr = new Map<string, number>();
  const ids = rows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const q = `SELECT symbol, pagerank FROM metrics WHERE symbol IN (${chunk.map(() => '?').join(',')})`;
    for (const r of store.prep(q).all(...chunk) as { symbol: string; pagerank: number }[]) pr.set(r.symbol, r.pagerank);
  }
  const score = (s: SymbolRow) =>
    (testFiles.has(s.file) || s.kind === 'test' ? -100 : 0) +
    (s.exported ? 5 : 0) +
    (KIND_BOOST[s.kind] ?? 1) * 3 +
    (isReopenedBlock(s) ? -4 : 0) +
    (s.kind === 'section' || s.file.endsWith('.md') ? -6 : 0) +
    (isPeripheralPath(s.file, flutterOrKmpRoot) ? -3 : 0) +
    (bonus?.get(s.id) ?? 0);
  const scored = rows.map((s) => ({ s, k: score(s), p: pr.get(s.id) ?? 0 }));
  scored.sort((a, b) => b.k - a.k || b.p - a.p || (a.s.file < b.s.file ? -1 : a.s.file > b.s.file ? 1 : a.s.id < b.s.id ? -1 : 1));
  return scored.map((x) => x.s);
}
