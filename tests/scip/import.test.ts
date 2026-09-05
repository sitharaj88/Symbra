import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, cpSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexRepo } from '../../src/index/indexer.js';
import { Store, defaultDbPath } from '../../src/store/db.js';
import { importScip, callShape } from '../../src/scip/import.js';
import { SymbolRole, ScipKind } from '../../src/scip/proto.js';
import * as pb from './pb.js';

const fixture = fileURLToPath(new URL('../fixtures/scip-ts', import.meta.url));
let root: string;
let scip: string;

beforeAll(async () => {
  // work on a copy so the incremental re-index test can edit files
  root = mkdtempSync(join(tmpdir(), 'symbra-scip-'));
  cpSync(fixture, root, { recursive: true });
  scip = join(root, 'index.scip');
  const stats = await indexRepo({ root });
  expect(stats.files).toBe(2);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const edgesAt = (store: Store, file: string, line: number) =>
  (store.prep('SELECT src, dst, kind, resolver, confidence FROM edges WHERE file = ? AND line = ? ORDER BY dst, kind').all(file, line) as { src: string; dst: string; kind: string; resolver: string; confidence: number }[]).map(
    (e) => `${e.src} ${e.kind} ${e.dst} ${e.resolver} ${e.confidence}`,
  );

let dry: ReturnType<typeof importScip>;

describe('import-scip on a scip-typescript index', () => {
  it('reports counts without writing in dry-run mode', () => {
    const store = new Store(defaultDbPath(root));
    const before = store.countEdges();
    const beforeSymbols = store.countSymbols();
    dry = importScip(store, root, scip, { dryRun: true });
    expect(dry.tool).toBe('scip-typescript 0.4.0');
    expect(dry.documentsMatched).toBe(2);
    expect(dry.edges.calls).toBeGreaterThanOrEqual(4);
    expect(dry.replaced).toBeGreaterThan(0);
    expect(store.countEdges()).toBe(before);
    expect(store.countSymbols()).toBe(beforeSymbols);
    expect(store.countScipEdges()).toBe(0);
    store.close();
  });

  it('replaces heuristic call edges with compiler-resolved ones', () => {
    const store = new Store(defaultDbPath(root));
    // before: Symbra's own resolvers found the call sites, one of them at reduced confidence
    expect(edgesAt(store, 'src/main.ts', 7)).toEqual(['src/main.ts::run calls src/greeter.ts::Greeter.greet receiver 0.9', 'src/main.ts::run calls src/greeter.ts::capitalize import 1']);
    const s = importScip(store, root, scip, { log: () => {} });
    expect(s.ms).toBeLessThan(5000);
    expect(s.symbolsCreated).toBe(0);
    // after: the same call sites carry resolver=scip, confidence=1, and the heuristic rows are gone
    expect(edgesAt(store, 'src/main.ts', 7)).toEqual(['src/main.ts::run calls src/greeter.ts::Greeter.greet scip 1', 'src/main.ts::run calls src/greeter.ts::capitalize scip 1']);
    // `new Greeter(...)` binds to the class (Symbra's convention), not the constructor symbol
    expect(edgesAt(store, 'src/main.ts', 5)).toEqual(['src/main.ts::run calls src/greeter.ts::Greeter scip 1']);
    // inheritance from SymbolInformation.relationships, super call inside the override
    expect(edgesAt(store, 'src/main.ts', 10)).toEqual(['src/main.ts::LoudGreeter extends src/greeter.ts::Greeter scip 1']);
    expect(edgesAt(store, 'src/main.ts', 12)).toEqual(['src/main.ts::LoudGreeter.greet calls src/greeter.ts::Greeter.greet scip 1']);
    expect(edgesAt(store, 'src/greeter.ts', 15)).toEqual(['src/greeter.ts::Person implements src/greeter.ts::Named scip 1']);
    // import specifiers do not become module-level reference edges; the imports edge stays
    expect(edgesAt(store, 'src/main.ts', 1)).toEqual(['src/main.ts imports src/greeter.ts import 1']);
    // the dry run predicted this import exactly
    expect({ ...s, ms: 0 }).toEqual({ ...dry, ms: 0 });
    expect(store.getMeta('scip_source')).toBe(scip);
    expect(store.getMeta('scip_tool')).toBe('scip-typescript 0.4.0');
    expect(store.countScipEdges()).toBe(s.edges.total);
    store.close();
  });

  it('is idempotent', () => {
    const store = new Store(defaultDbPath(root));
    const n = store.countEdges();
    const s = importScip(store, root, scip, { analyze: false });
    expect(store.countEdges()).toBe(n);
    expect(s.replaced).toBe(0);
    store.close();
  });

  it('survives a re-index with no changes', async () => {
    const before = new Store(defaultDbPath(root));
    const n = before.countScipEdges();
    const edges = edgesAt(before, 'src/main.ts', 7);
    before.close();
    expect(n).toBeGreaterThan(0);
    const stats = await indexRepo({ root });
    expect(stats.changed).toBe(0);
    const store = new Store(defaultDbPath(root));
    expect(store.countScipEdges()).toBe(n);
    expect(edgesAt(store, 'src/main.ts', 7)).toEqual(edges);
    store.close();
  });

  it('keeps scip edges on unchanged dependents across an incremental re-index and drops them for changed files', async () => {
    // greeter.ts changes -> main.ts (its importer) is re-resolved as a dependent
    appendFileSync(join(root, 'src/greeter.ts'), '\n// touched\n');
    const stats = await indexRepo({ root });
    expect(stats.changed).toBe(1);
    const store = new Store(defaultDbPath(root));
    expect(edgesAt(store, 'src/main.ts', 7)).toEqual(['src/main.ts::run calls src/greeter.ts::Greeter.greet scip 1', 'src/main.ts::run calls src/greeter.ts::capitalize scip 1']);
    expect(store.prep("SELECT COUNT(*) AS n FROM edges WHERE file = 'src/greeter.ts' AND resolver = 'scip'").get()).toEqual({ n: 0 });
    // the changed file got its heuristic edges back
    expect(edgesAt(store, 'src/greeter.ts', 15)).toContain('src/greeter.ts::Person implements src/greeter.ts::Named scope 1');
    store.close();
  });

  it('creates symbols Symbra missed and links references to them', () => {
    // A hand-built index: a `mystery` function defined on line 1 of main.ts (where Symbra has no symbol)
    // and a call to it from inside capitalize() in greeter.ts.
    const mystery = 'scip-test npm scip-ts-fixture 1.0.0 src/`main.ts`/mystery().';
    const bytes = pb.index({
      metadata: pb.metadata({ projectRoot: 'file://' + root }),
      documents: [
        pb.document({
          relativePath: 'src/main.ts',
          occurrences: [pb.occurrence({ range: [0, 0, 7], symbol: mystery, roles: SymbolRole.Definition, enclosing: [0, 0, 0, 40] })],
          symbols: [pb.symbolInformation({ symbol: mystery, kind: ScipKind.Function, documentation: ['Not in the source tree.'], signature: 'function mystery(): void' })],
        }),
        pb.document({ relativePath: 'src/greeter.ts', occurrences: [pb.occurrence({ range: [20, 2, 9], symbol: mystery })] }),
        pb.document({ relativePath: 'src/not-indexed.ts', occurrences: [pb.occurrence({ range: [0, 0, 1], symbol: mystery })] }),
      ],
    });
    const p = join(root, 'hand.scip');
    writeFileSync(p, bytes);
    const store = new Store(defaultDbPath(root));
    const s = importScip(store, root, p, { analyze: false });
    expect(s.documents).toBe(3);
    expect(s.documentsMatched).toBe(2);
    expect(s.symbolsCreated).toBe(1);
    const sym = store.getSymbol('src/main.ts::mystery')!;
    expect(sym).toMatchObject({ kind: 'function', name: 'mystery', start_line: 1, end_line: 1, doc: 'Not in the source tree.', signature: 'function mystery(): void', parent: 'src/main.ts' });
    expect(JSON.parse(sym.meta!)).toEqual({ scip: true });
    expect(edgesAt(store, 'src/greeter.ts', 21)).toEqual(['src/greeter.ts::capitalize calls src/main.ts::mystery scip 1']);
    // previous scip edges for these documents were replaced by this (smaller) index
    expect(store.countScipEdges()).toBe(1);
    // importing again over the symbols it just created changes nothing
    const edges = store.countEdges();
    const symbols = store.countSymbols();
    const again = importScip(store, root, p, { analyze: false });
    expect(again.symbolsCreated).toBe(0);
    expect(again.symbolsMatched).toBe(s.symbolsMatched + s.symbolsCreated);
    expect(again.edges.total).toBe(s.edges.total);
    expect(again.replaced).toBe(0);
    expect(store.countEdges()).toBe(edges);
    expect(store.countSymbols()).toBe(symbols);
    expect(edgesAt(store, 'src/greeter.ts', 21)).toEqual(['src/greeter.ts::capitalize calls src/main.ts::mystery scip 1']);
    store.close();
  });
});

describe('callShape', () => {
  const r = (s: number, e: number) => ({ startLine: 0, startChar: s, endLine: 0, endChar: e });
  it('recognises calls, constructions, decorators and plain mentions', () => {
    expect(callShape('  return greet(name);', r(9, 14), 'greet')).toBe('call');
    expect(callShape('  const g = new Greeter("x");', r(16, 23), 'Greeter')).toBe('new');
    expect(callShape('  x = make<T>(1)', r(6, 10), 'make')).toBe('call');
    expect(callShape('  fn?.(1)', r(2, 4), 'fn')).toBe('call');
    expect(callShape('  println!("x")', r(2, 9), 'println')).toBe('call');
    expect(callShape('@route("/")', r(1, 6), 'route')).toBe('decorator');
    expect(callShape('  arr.map(capitalize)', r(10, 20), 'capitalize')).toBe('plain');
    // column mismatch (e.g. UTF-8 vs UTF-16 offsets): the nearest occurrence of the name is used
    expect(callShape('  ü = greet(x)', r(7, 12), 'greet')).toBe('call');
    expect(callShape('  nothing here', r(0, 3), 'greet')).toBeNull();
    expect(callShape(undefined, r(0, 3), 'greet')).toBeNull();
  });
});
