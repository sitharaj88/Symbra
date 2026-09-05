/**
 * Import a compiler-generated SCIP index (scip-typescript, scip-python, scip-java,
 * scip-go, rust-analyzer, scip-clang, …) into an existing Symbra index.
 *
 * Every reference occurrence becomes an edge with `resolver = 'scip'` and
 * `confidence = 1` from the innermost Symbra symbol enclosing the occurrence to the
 * Symbra symbol the SCIP definition maps to (see `mapDefinition`). Heuristic edges
 * for the same call site (same file, line, source symbol and edge kind) are removed,
 * as are `unresolved` candidate sets on lines SCIP resolved. Definitions Symbra's
 * extractors missed are added as symbol rows with meta `{"scip": true}`.
 *
 * Two passes over the index buffer keep memory flat: pass 1 collects definition
 * sites and symbol information and maps them onto Symbra ids; pass 2 walks the
 * reference occurrences and writes edges. Re-importing is idempotent: a document's
 * scip edges are dropped before its edges are written again. The whole import runs in
 * one transaction, which `dryRun` rolls back instead of committing.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Edge, EdgeKind } from '../ir/types.js';
import type { Store, SymbolRow } from '../store/db.js';
import { computeMetrics, loadRows } from '../analyze/metrics.js';
import { computeCommunities } from '../analyze/communities.js';
import { walkIndex, readIndexFile, SymbolRole, SyntaxKind, type ScipDocument, type ScipMetadata, type ScipOccurrence, type ScipRange } from './proto.js';
import { FileSymbolIndex, mapDefinition, parseSymbol, symbolName, isCallableKind, isClassLikeKind, type DefinitionSite } from './symbol.js';

export interface ScipImportOptions {
  /** Count what would change without writing. */
  dryRun?: boolean;
  /** Recompute PageRank and communities afterwards (default true unless dryRun). */
  analyze?: boolean;
  /**
   * Create `variable`-kind symbol rows for SCIP definitions Symbra did not extract. Off by
   * default: a SCIP index names every binding, and importing them all drowns the graph in
   * module-scope consts and destructured locals. References to variables Symbra already extracted
   * are mapped either way.
   */
  includeVariables?: boolean;
  log?: (msg: string) => void;
}

export interface ScipImportStats {
  tool: string;
  /** Documents in the index. */
  documents: number;
  /** Documents whose path is a file in the Symbra index. */
  documentsMatched: number;
  /** SCIP definitions (excluding parameters, type parameters and locals). */
  definitions: number;
  /** …of which matched an existing Symbra symbol. */
  symbolsMatched: number;
  /** …of which were created from the SCIP definition. */
  symbolsCreated: number;
  /** …of which were dropped: variable definitions with no Symbra row (see `includeVariables`). */
  symbolsSkipped: number;
  /** Reference occurrences seen (excluding definitions and import specifiers). */
  references: number;
  /** References skipped because the target is external, local, or a parameter. */
  referencesSkipped: number;
  edges: Record<EdgeKind, number> & { total: number };
  /** Heuristic edges replaced by scip edges. */
  replaced: number;
  /** Unresolved candidate rows removed. */
  unresolvedRemoved: number;
  ms: number;
}

interface DefInfo {
  site: DefinitionSite;
  relationships: { symbol: string; isImplementation: boolean }[];
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/** Compute the prefix that turns SCIP `relative_path`s into Symbra repo-relative paths. */
function pathPrefix(root: string, meta: ScipMetadata | null, scipPath: string): string {
  let projectRoot = '';
  if (meta?.projectRoot) {
    try {
      projectRoot = meta.projectRoot.startsWith('file:') ? fileURLToPath(meta.projectRoot) : meta.projectRoot;
    } catch {
      projectRoot = '';
    }
  }
  if (!projectRoot || !isAbsolute(projectRoot) || !existsSync(projectRoot)) {
    // No usable project_root: assume the index sits at the root it describes.
    projectRoot = resolve(scipPath, '..');
  }
  const rel = toPosix(relative(resolve(root), resolve(projectRoot)));
  if (!rel || rel === '.') return '';
  if (rel.startsWith('..') || isAbsolute(rel)) return '';
  return rel + '/';
}

/** Lines that are import/use/require statements in the languages SCIP indexers cover. */
const IMPORT_LINE = /^\s*(import\b|from\s+\S+\s+import\b|use\s|using\s|#include\b|require\s*\(|require_relative\b|export\s+(type\s+)?(\*|\{[^}]*\})\s*from\b)/;

/** Whether the identifier at [startChar, endChar) on `line` is followed by a call. Null = cannot tell. */
export function callShape(line: string | undefined, r: ScipRange, name: string): 'call' | 'new' | 'decorator' | 'plain' | null {
  if (line === undefined) return null;
  let s = r.startChar;
  let e = r.startLine === r.endLine ? r.endChar : line.length;
  if (line.slice(s, e) !== name) {
    // position encoding mismatch (UTF-8 vs UTF-16 columns): find the nearest occurrence of the name
    let best = -1;
    let i = line.indexOf(name);
    while (i >= 0) {
      if (best < 0 || Math.abs(i - s) < Math.abs(best - s)) best = i;
      i = line.indexOf(name, i + 1);
    }
    if (best < 0) return null;
    s = best;
    e = best + name.length;
  }
  const after = line.slice(e);
  const before = line.slice(0, s);
  if (/\bnew\s+$/.test(before)) return 'new';
  if (/@\s*$/.test(before)) return 'decorator';
  if (/^\s*!?\s*(\?\.)?\s*(<[^()]*>)?\s*\(/.test(after)) return 'call';
  return 'plain';
}

export function importScip(store: Store, root: string, scipPath: string, opts: ScipImportOptions = {}): ScipImportStats {
  const t0 = performance.now();
  const log = opts.log ?? (() => {});
  const dryRun = !!opts.dryRun;
  const buf = readIndexFile(scipPath);
  log(`read ${(buf.length / 1024).toFixed(0)} KB`);

  const stats: ScipImportStats = {
    tool: '',
    documents: 0,
    documentsMatched: 0,
    definitions: 0,
    symbolsMatched: 0,
    symbolsCreated: 0,
    symbolsSkipped: 0,
    references: 0,
    referencesSkipped: 0,
    edges: { calls: 0, references: 0, imports: 0, extends: 0, implements: 0, contains: 0, defines_route: 0, tests: 0, reads_config: 0, decorates: 0, passes: 0, total: 0 },
    replaced: 0,
    unresolvedRemoved: 0,
    ms: 0,
  };

  // ---- pass 1: definitions and symbol information, grouped by file
  let meta: ScipMetadata | null = null;
  let prefix = '';
  const defsByFile = new Map<string, Map<string, DefInfo>>();
  const docPath = (d: ScipDocument) => prefix + d.relativePath.replace(/\\/g, '/');
  walkIndex(buf, {
    onMetadata: (m) => {
      meta = m;
      prefix = pathPrefix(root, m, scipPath);
      stats.tool = m.toolName ? `${m.toolName} ${m.toolVersion}`.trim() : '';
      if (prefix) log(`index project root maps to ${prefix}`);
    },
    onDocument: (d) => {
      stats.documents++;
      const path = docPath(d);
      if (!store.getFile(path)) return;
      stats.documentsMatched++;
      const infos = new Map<string, ScipDocument['symbols'][number]>();
      for (const s of d.symbols) infos.set(s.symbol, s);
      let defs = defsByFile.get(path);
      if (!defs) defsByFile.set(path, (defs = new Map()));
      for (const o of d.occurrences) {
        if (!(o.symbolRoles & SymbolRole.Definition)) continue;
        const prev = defs.get(o.symbol);
        if (prev && (prev.site.endLine > prev.site.startLine || !o.enclosingRange)) continue; // keep the first definition with a body
        const info = infos.get(o.symbol);
        const enc = o.enclosingRange;
        defs.set(o.symbol, {
          site: {
            file: path,
            line: o.range.startLine + 1,
            startLine: (enc ? enc.startLine : o.range.startLine) + 1,
            endLine: (enc ? enc.endLine : o.range.endLine) + 1,
            info: info ? { kind: info.kind, documentation: info.documentation, signature: info.signature, displayName: info.displayName } : null,
          },
          relationships: (info?.relationships ?? []).filter((r) => r.isImplementation).map((r) => ({ symbol: r.symbol, isImplementation: r.isImplementation })),
        });
      }
      // SymbolInformation without a definition occurrence in this document but with an enclosing symbol here
      // (e.g. synthesised members) is ignored: we only map entities that have a source location.
    },
  });
  void meta;
  log(`${stats.documents} documents, ${stats.documentsMatched} in the Symbra index`);

  // ---- map definitions onto Symbra symbols
  const indexes = new Map<string, FileSymbolIndex>();
  const symToId = new Map<string, string>();
  const kindOf = new Map<string, SymbolRow['kind']>();
  const fileOf = new Map<string, string>();
  const rowOf = (id: string): SymbolRow | null => {
    const f = fileOf.get(id);
    const idx = f !== undefined ? indexes.get(f) : undefined;
    return idx?.get(id) ?? store.getSymbol(id);
  };
  const mapAll = () => {
    for (const [file, defs] of defsByFile) {
      const idx = new FileSymbolIndex(file, store.symbolsInFile(file));
      indexes.set(file, idx);
      for (const [sym, def] of defs) {
        const p = parseSymbol(sym);
        if (p.local || !p.descriptors.length) continue;
        const last = p.descriptors[p.descriptors.length - 1]!;
        if (last.suffix === 'parameter' || last.suffix === 'type_parameter') continue;
        stats.definitions++;
        const m = mapDefinition(store, idx, sym, def.site, { includeVariables: opts.includeVariables });
        if (!m) {
          stats.symbolsSkipped++;
          continue;
        }
        if (m.created) stats.symbolsCreated++;
        else stats.symbolsMatched++;
        symToId.set(sym, m.id);
        fileOf.set(m.id, file);
        const row = idx.get(m.id) ?? store.getSymbol(m.id);
        kindOf.set(m.id, row?.kind ?? 'variable');
      }
    }
  };

  // ---- pass 2: references -> edges
  const testFiles = new Set<string>();
  for (const f of store.allFiles()) if (f.is_test) testFiles.add(f.path);
  const delScip = store.prep("DELETE FROM edges WHERE file = ? AND resolver = 'scip'");
  const delHeur = store.prep("DELETE FROM edges WHERE file = ? AND line = ? AND src = ? AND kind = ? AND resolver != 'scip'");
  const delUnres = store.prep('DELETE FROM unresolved WHERE file = ? AND line = ?');
  const enclosingTest = (idx: FileSymbolIndex, line: number): string | null => {
    for (const s of idx.containing(line)) if (s.kind === 'test') return s.id;
    return null;
  };

  const processDocument = (d: ScipDocument) => {
    const path = docPath(d);
    const idx = indexes.get(path);
    if (!idx) return;
    let lines: string[] | null = null;
    try {
      lines = readFileSync(resolve(root, path), 'utf8').split(/\r?\n/);
    } catch {
      lines = null;
    }
    const edges: Edge[] = [];
    const seen = new Set<string>();
    /**
     * `line|src|kind` of every call site SCIP resolved, recorded as edges are pushed so that
     * a heuristic edge is still replaced when the scip edge for that site is later folded into
     * another one (the `references` half of a heritage clause).
     */
    const sites = new Set<string>();
    /** Lines SCIP resolved; their `unresolved` candidate sets go. */
    const lineSet = new Set<number>();
    const push = (src: string, dst: string, kind: EdgeKind, line: number) => {
      if (src === dst) return;
      const key = `${src}|${dst}|${kind}|${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      sites.add(`${line}|${src}|${kind}`);
      if (kind !== 'tests') lineSet.add(line);
      edges.push({ src, dst, kind, file: path, line, resolver: 'scip', confidence: 1 });
    };
    const isTestFile = testFiles.has(path);

    for (const o of d.occurrences) {
      if (o.symbolRoles & (SymbolRole.Definition | SymbolRole.ForwardDefinition | SymbolRole.Import)) continue;
      if (!o.symbol) continue;
      stats.references++;
      let dst = symToId.get(o.symbol);
      if (!dst) {
        stats.referencesSkipped++;
        continue;
      }
      const line = o.range.startLine + 1;
      const src = idx.scopeAt(line);
      const lineText = lines?.[o.range.startLine];
      // Import statements are module -> module `imports` edges in Symbra; SCIP's per-name
      // occurrences on those lines (scip-typescript does not set the Import role) add nothing.
      if (src === idx.moduleId && (kindOf.get(dst) === 'module' || (lineText !== undefined && IMPORT_LINE.test(lineText)))) continue;
      let dstKind = kindOf.get(dst) ?? 'variable';
      const kind = edgeKindFor(o, dstKind, lineText, symbolName(parseSymbol(o.symbol)));
      // `new Foo()` resolves to Foo's constructor in SCIP; Symbra binds construction to the class itself
      if (dstKind === 'constructor') {
        const parent = rowOf(dst)?.parent;
        const cls = parent ? rowOf(parent) : null;
        if (cls && isClassLikeKind(cls.kind)) {
          dst = cls.id;
          dstKind = cls.kind;
        }
      }
      push(src, dst, kind, line);
      if ((kind === 'calls' || kind === 'references') && !testFiles.has(fileOf.get(dst) ?? '')) {
        const t = enclosingTest(idx, line);
        if (t || isTestFile) push(t ?? src, dst, 'tests', line);
      }
    }

    // inheritance from relationships (is_implementation on a type = extends/implements)
    const defs = defsByFile.get(path);
    if (defs) {
      for (const [sym, def] of defs) {
        if (!def.relationships.length) continue;
        const src = symToId.get(sym);
        if (!src) continue;
        const srcKind = kindOf.get(src) ?? 'variable';
        if (!isClassLikeKind(srcKind)) continue; // method overrides have no Symbra edge kind
        const srcRow = rowOf(src);
        for (const rel of def.relationships) {
          const dst = symToId.get(rel.symbol);
          if (!dst) continue;
          const dstKind = kindOf.get(dst) ?? 'variable';
          if (!isClassLikeKind(dstKind)) continue;
          const kind: EdgeKind = dstKind === 'interface' || dstKind === 'trait' ? 'implements' : 'extends';
          push(src, dst, kind, srcRow?.start_line ?? def.site.line);
        }
      }
    }

    // the heritage clause of `class A extends B` is both an extends edge and a name occurrence; keep the former
    const heritage = new Set(edges.filter((e) => e.kind === 'extends' || e.kind === 'implements').map((e) => `${e.src}|${e.dst}|${e.line}`));
    if (heritage.size) {
      for (let i = edges.length - 1; i >= 0; i--) {
        const e = edges[i]!;
        if (e.kind === 'references' && heritage.has(`${e.src}|${e.dst}|${e.line}`)) edges.splice(i, 1);
      }
    }

    delScip.run(path);
    for (const s of sites) {
      const i = s.indexOf('|');
      const j = s.lastIndexOf('|');
      stats.replaced += Number(delHeur.run(path, Number(s.slice(0, i)), s.slice(i + 1, j), s.slice(j + 1)).changes);
    }
    for (const l of lineSet) stats.unresolvedRemoved += Number(delUnres.run(path, l).changes);
    store.insertEdges(edges);
    for (const e of edges) {
      stats.edges[e.kind]++;
      stats.edges.total++;
    }
  };

  // A dry run is a real run rolled back, so its counts are exactly the counts of the
  // import it predicts (mapping a definition changes what the next one maps to, so
  // simulating the writes separately drifts).
  store.db.exec('BEGIN');
  try {
    mapAll();
    log(`${stats.definitions} definitions: ${stats.symbolsMatched} matched, ${stats.symbolsCreated} created${stats.symbolsSkipped ? `, ${stats.symbolsSkipped} variable definitions skipped (--include-variables to keep them)` : ''}`);
    walkIndex(buf, { onDocument: (d) => void processDocument(d) });
  } catch (e) {
    store.db.exec('ROLLBACK');
    throw e;
  }
  if (dryRun) store.db.exec('ROLLBACK');
  else {
    store.setMeta('scip_imported_at', String(Date.now()));
    store.setMeta('scip_source', resolve(scipPath));
    if (stats.tool) store.setMeta('scip_tool', stats.tool);
    store.db.exec('COMMIT');
    if (opts.analyze !== false) {
      log('recomputing metrics and communities');
      const rows = loadRows(store);
      computeMetrics(store, rows);
      computeCommunities(store, rows);
      store.setMeta('analyzed_at', String(Date.now()));
    }
  }
  log(`${stats.edges.total} scip edges (${stats.replaced} heuristic edges replaced, ${stats.unresolvedRemoved} candidate sets resolved)`);
  stats.ms = Math.round(performance.now() - t0);
  return stats;
}

/** Decide the edge kind for a reference occurrence. */
function edgeKindFor(o: ScipOccurrence, dstKind: SymbolRow['kind'], lineText: string | undefined, name: string): EdgeKind {
  const shape = callShape(lineText, o.range, name);
  if (shape === 'decorator') return 'decorates';
  if (isCallableKind(dstKind)) {
    if (shape === 'call' || shape === 'new') return 'calls';
    if (shape === null) return o.syntaxKind === SyntaxKind.IdentifierFunction || o.syntaxKind === SyntaxKind.IdentifierMacro || o.syntaxKind === SyntaxKind.Unspecified ? 'calls' : 'references';
    return 'references';
  }
  // `new Foo()` / `Foo()` on a class binds to the class, as Symbra's own resolver does
  if (isClassLikeKind(dstKind) && (shape === 'new' || shape === 'call')) return 'calls';
  return 'references';
}
