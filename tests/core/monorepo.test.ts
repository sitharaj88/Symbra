import { describe, it, expect, afterEach } from 'vitest';
import { indexRepo } from '../../src/index/indexer.js';
import { Store } from '../../src/store/db.js';
import { makeRepo, type TempRepo } from './helpers.js';

const repos: TempRepo[] = [];
function repo(files: Record<string, string>): TempRepo {
  const r = makeRepo(files);
  repos.push(r);
  return r;
}
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

describe('workspace package resolution', () => {
  it('resolves an import by workspace package name to the package sources, not its dist entry', async () => {
    const r = repo({
      'pnpm-workspace.yaml': ['packages:', '  - "packages/*"', ''].join('\n'),
      'package.json': JSON.stringify({ name: 'root', private: true }),
      'packages/core/package.json': JSON.stringify({ name: '@acme/core', main: 'dist/index.js', types: 'dist/index.d.ts' }),
      'packages/core/src/index.ts': ['export function createSession(id: string): string {', '  return id;', '}', ''].join('\n'),
      'packages/core/src/util.ts': ['export function slugify(s: string): string {', '  return s.toLowerCase();', '}', ''].join('\n'),
      'packages/cli/package.json': JSON.stringify({ name: '@acme/cli', dependencies: { '@acme/core': 'workspace:*' } }),
      'packages/cli/src/main.ts': [
        'import { createSession } from "@acme/core";',
        'import { slugify } from "@acme/core/util";',
        '',
        'export function main(): string {',
        '  return slugify(createSession("a"));',
        '}',
        '',
      ].join('\n'),
    });
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      const imports = store.prep('SELECT source, resolved FROM imports WHERE file = ?').all('packages/cli/src/main.ts') as { source: string; resolved: string | null }[];
      expect(imports.find((i) => i.source === '@acme/core')?.resolved).toBe('packages/core/src/index.ts');
      expect(imports.find((i) => i.source === '@acme/core/util')?.resolved).toBe('packages/core/src/util.ts');
      const edges = store.edgesFrom('packages/cli/src/main.ts::main');
      const call = edges.find((e) => e.dst === 'packages/core/src/index.ts::createSession' && e.kind === 'calls');
      expect(call).toBeTruthy();
      expect(call!.resolver).toBe('import');
      expect(call!.confidence).toBe(1);
      expect(edges.some((e) => e.dst === 'packages/core/src/util.ts::slugify' && e.kind === 'calls')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('falls back to packages/* and apps/* when no workspace manifest declares them', async () => {
    const r = repo({
      'packages/lib/package.json': JSON.stringify({ name: '@acme/lib' }),
      'packages/lib/src/index.ts': ['export function ping(): string {', '  return "pong";', '}', ''].join('\n'),
      'apps/web/package.json': JSON.stringify({ name: '@acme/web' }),
      'apps/web/src/app.ts': ['import { ping } from "@acme/lib";', '', 'export function boot(): string {', '  return ping();', '}', ''].join('\n'),
    });
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      const edges = store.edgesFrom('apps/web/src/app.ts::boot');
      expect(edges.some((e) => e.dst === 'packages/lib/src/index.ts::ping' && e.kind === 'calls')).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe('nearest tsconfig aliases', () => {
  it('uses the tsconfig closest to the importing file, not only the repo root', async () => {
    const r = repo({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./shared/*'] } } }),
      'shared/cn.ts': ['export function cn(a: string): string {', '  return a;', '}', ''].join('\n'),
      // `web/` re-points `@/*` at its own sources; the root config would find `shared/lib/cn` instead.
      'web/tsconfig.json': JSON.stringify({ extends: '../tsconfig.json', compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
      'web/src/lib/cn.ts': ['export function classNames(a: string): string {', '  return a;', '}', ''].join('\n'),
      'web/src/page.ts': ['import { classNames } from "@/lib/cn";', '', 'export function render(): string {', '  return classNames("x");', '}', ''].join('\n'),
    });
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      const imp = store.prep('SELECT source, resolved FROM imports WHERE file = ?').all('web/src/page.ts') as { source: string; resolved: string | null }[];
      expect(imp[0]!.resolved).toBe('web/src/lib/cn.ts');
      expect(store.edgesFrom('web/src/page.ts::render').some((e) => e.dst === 'web/src/lib/cn.ts::classNames')).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe('external imports are not ambiguous', () => {
  it('records no unresolved candidates for a name imported from a node builtin', async () => {
    const r = repo({
      // A same-named local definition is exactly what would be offered as a bogus candidate.
      'src/fsutil.ts': ['export async function writeFile(p: string): Promise<string> {', '  return p;', '}', ''].join('\n'),
      'src/save.ts': ['import { writeFile } from "node:fs/promises";', '', 'export async function save(p: string): Promise<void> {', '  await writeFile(p, "x");', '}', ''].join('\n'),
      'src/pkg.ts': ['import { render } from "some-npm-package";', '', 'export function draw(): string {', '  return render();', '}', ''].join('\n'),
      'src/other.ts': ['export function render(): string {', '  return "r";', '}', ''].join('\n'),
    });
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      const rows = store.prep('SELECT file, name FROM unresolved').all() as { file: string; name: string }[];
      expect(rows.filter((x) => x.name === 'writeFile')).toEqual([]);
      expect(rows.filter((x) => x.name === 'render')).toEqual([]);
      // ...and no edge was invented to the same-named local definitions either.
      expect(store.edgesFrom('src/save.ts::save').some((e) => e.dst === 'src/fsutil.ts::writeFile')).toBe(false);
      expect(store.edgesFrom('src/pkg.ts::draw').some((e) => e.dst === 'src/other.ts::render')).toBe(false);
    } finally {
      store.close();
    }
  });

  it('still records candidates for a name that is not imported from anywhere', async () => {
    const r = repo({
      'src/a.ts': ['export function computeTotals(x: number): number {', '  return x;', '}', ''].join('\n'),
      'src/b.ts': ['export class Bag {', '  computeTotals(x: number): number {', '    return x;', '  }', '}', ''].join('\n'),
      'src/c.ts': ['export function run(bag: unknown): unknown {', '  return (bag as any).computeTotals(1);', '}', ''].join('\n'),
    });
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      const rows = store.prep("SELECT file, name FROM unresolved WHERE name = 'computeTotals'").all() as { file: string }[];
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it('does not treat a test-runner global as an ambiguous call', async () => {
    const r = repo({
      'src/lib.ts': ['export function describe(x: string): string {', '  return x;', '}', ''].join('\n'),
      'tests/lib.test.ts': ['import { describe, it, expect } from "vitest";', '', 'describe("suite", () => {', '  it("works", () => {', '    expect(1).toBe(1);', '  });', '});', ''].join('\n'),
    });
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      const rows = store.prep("SELECT name FROM unresolved WHERE name IN ('describe','it','expect')").all() as { name: string }[];
      expect(rows).toEqual([]);
      // the `describe`/`it` block is still extracted as a test definition
      const tests = store.prep("SELECT name FROM symbols WHERE file = 'tests/lib.test.ts' AND kind = 'test'").all() as { name: string }[];
      expect(tests.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});
