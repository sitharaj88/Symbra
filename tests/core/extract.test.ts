import { describe, it, expect, afterEach } from 'vitest';
import { extractFile } from '../../src/index/extract.js';
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

describe('TypeScript overloads', () => {
  const src = [
    'export function parse(x: string): number;',
    'export function parse(x: number): number;',
    'export function parse(x: unknown): number {',
    '  return Number(x);',
    '}',
    '',
    'export class P {',
    '  run(a: string): void;',
    '  run(a: number): void;',
    '  run(a: unknown): void {',
    '    void a;',
    '  }',
    '',
    '  bodiless(): void;',
    '}',
    '',
    'export interface I {',
    '  parse(x: string): number;',
    '}',
    '',
    'export declare function standalone(x: string): void;',
    '',
  ].join('\n');

  it('emits one symbol per overloaded function and method', async () => {
    const ir = (await extractFile('a.ts', src))!;
    const fqns = ir.definitions.map((d) => d.fqn);
    expect(fqns.filter((f) => f === 'parse')).toHaveLength(1);
    expect(fqns.filter((f) => f === 'P.run')).toHaveLength(1);
    // Signatures with no implementation after them are still real definitions.
    expect(fqns).toContain('P.bodiless');
    expect(fqns).toContain('I.parse');
    expect(fqns).toContain('standalone');
  });

  it('gives a call site one edge, not one per overload', async () => {
    const r = repo({
      'lib.ts': src,
      'main.ts': ['import { parse } from "./lib.js";', '', 'export function main(): number {', '  return parse("1");', '}', ''].join('\n'),
    });
    await indexRepo({ root: r.root, dbPath: r.dbPath, full: true });
    const store = new Store(r.dbPath);
    try {
      const calls = store.edgesFrom('main.ts::main').filter((e) => e.kind === 'calls');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.dst).toBe('lib.ts::parse');
    } finally {
      store.close();
    }
  });
});

describe('C/C++ local declarations', () => {
  it('does not turn a declaration inside a #ifdef block into a scope-owning variable', async () => {
    const src = ['int convert(int a);', 'int helper(int b);', '', 'int run(int x) {', '#ifdef __POSIX__', '  int file = convert(x);', '  int y = helper(file);', '  return file + y;', '#endif', '  return 0;', '}', ''].join('\n');
    const ir = (await extractFile('os.cc', src))!;
    const fqns = ir.definitions.map((d) => d.fqn);
    expect(fqns).toEqual(['convert', 'helper', 'run']);
    const runOrdinal = ir.definitions.find((d) => d.fqn === 'run')!.ordinal;
    // Every call in the body belongs to the function, not to a local it happens to initialise.
    for (const ref of ir.references.filter((x) => x.kind === 'call')) expect(ref.scope).toBe(runOrdinal);
  });

  it('still records top-level declarations, including inside conditional compilation', async () => {
    const src = ['#ifdef __POSIX__', 'const int kLimit = 4;', '#endif', 'int other = 2;', ''].join('\n');
    const ir = (await extractFile('t.c', src))!;
    expect(ir.definitions.map((d) => d.fqn).sort()).toEqual(['kLimit', 'other']);
  });
});
