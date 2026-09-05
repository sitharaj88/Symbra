import { describe, it, expect } from 'vitest';
import { parseSymbol, parseDescriptors, symbolFqn, symbolName, isSubSymbol, mapKind, FileSymbolIndex } from '../../src/scip/symbol.js';
import { ScipKind } from '../../src/scip/proto.js';
import type { SymbolRow } from '../../src/store/db.js';

describe('scip symbol parser', () => {
  it('parses scheme, package and every descriptor suffix', () => {
    const p = parseSymbol('scip-typescript npm scip-ts-fixture 1.0.0 src/`greeter.ts`/Greeter#greet().(name)');
    expect(p.local).toBe(false);
    expect(p.scheme).toBe('scip-typescript');
    expect(p.manager).toBe('npm');
    expect(p.package).toBe('scip-ts-fixture');
    expect(p.version).toBe('1.0.0');
    expect(p.descriptors).toEqual([
      { name: 'src', suffix: 'namespace', disambiguator: '' },
      { name: 'greeter.ts', suffix: 'namespace', disambiguator: '' },
      { name: 'Greeter', suffix: 'type', disambiguator: '' },
      { name: 'greet', suffix: 'method', disambiguator: '' },
      { name: 'name', suffix: 'parameter', disambiguator: '' },
    ]);
    expect(parseDescriptors('a/b#c.d(+1).[T](p)m:x!')).toEqual([
      { name: 'a', suffix: 'namespace', disambiguator: '' },
      { name: 'b', suffix: 'type', disambiguator: '' },
      { name: 'c', suffix: 'term', disambiguator: '' },
      { name: 'd', suffix: 'method', disambiguator: '+1' },
      { name: 'T', suffix: 'type_parameter', disambiguator: '' },
      { name: 'p', suffix: 'parameter', disambiguator: '' },
      { name: 'm', suffix: 'meta', disambiguator: '' },
      { name: 'x', suffix: 'macro', disambiguator: '' },
    ]);
  });

  it('handles local symbols, placeholder package fields, escaped spaces and backticks', () => {
    const l = parseSymbol('local 42');
    expect(l.local).toBe(true);
    expect(l.localId).toBe('42');
    expect(isSubSymbol(l)).toBe(true);
    // <symbol> ::= <scheme> ' ' <manager> ' ' <package-name> ' ' <version> ' ' (<descriptor>)+
    const py = parseSymbol('scip-python python mypkg 1.2.3 mod/Class#method().');
    expect(py.manager).toBe('python');
    expect(py.package).toBe('mypkg');
    expect(py.version).toBe('1.2.3');
    expect(symbolFqn(py)).toBe('Class.method');
    // '.' is the placeholder for an empty manager/package/version
    const bare = parseSymbol('scip-java . . . mod/Class#method().');
    expect(bare.manager).toBe('');
    expect(bare.package).toBe('');
    expect(bare.version).toBe('');
    expect(symbolFqn(bare)).toBe('Class.method');
    const sp = parseSymbol('my  scheme mgr my  pkg 1.0 `weird name`/`has``tick`#');
    expect(sp.scheme).toBe('my scheme');
    expect(sp.package).toBe('my pkg');
    expect(sp.descriptors.map((d) => d.name)).toEqual(['weird name', 'has`tick']);
    expect(() => parseSymbol('s m p v `unterminated')).toThrow(/unterminated/);
    expect(() => parseSymbol('s m p v bad~')).toThrow(/unexpected/);
  });

  it('derives Symbra names and fqns', () => {
    const p = parseSymbol('scip-typescript npm p 1 src/`greeter.ts`/Greeter#`<constructor>`().');
    expect(symbolName(p)).toBe('<constructor>');
    expect(symbolFqn(p)).toBe('Greeter.<constructor>');
    expect(symbolFqn(parseSymbol('scip-typescript npm p 1 src/`greeter.ts`/'))).toBe('greeter.ts');
    expect(isSubSymbol(parseSymbol('s m p v a/b#[T]'))).toBe(true);
    expect(isSubSymbol(parseSymbol('s m p v a/b#'))).toBe(false);
  });

  it('maps SymbolInformation.Kind, falling back to the descriptor suffix', () => {
    const m = parseSymbol('s m p v a/B#m().');
    expect(mapKind(ScipKind.Method, m)).toBe('method');
    expect(mapKind(ScipKind.StaticMethod, m)).toBe('method');
    expect(mapKind(ScipKind.Interface, m)).toBe('interface');
    expect(mapKind(ScipKind.Trait, m)).toBe('trait');
    expect(mapKind(ScipKind.Protocol, m)).toBe('trait');
    expect(mapKind(ScipKind.Constructor, m)).toBe('constructor');
    expect(mapKind(ScipKind.Field, m)).toBe('field');
    expect(mapKind(ScipKind.Property, m)).toBe('property');
    expect(mapKind(ScipKind.TypeAlias, m)).toBe('type_alias');
    expect(mapKind(ScipKind.Macro, m)).toBe('macro');
    expect(mapKind(ScipKind.Package, m)).toBe('namespace');
    // unspecified kind: infer from the descriptor and its container
    expect(mapKind(0, m)).toBe('method');
    expect(mapKind(0, parseSymbol('s m p v a/f().'))).toBe('function');
    expect(mapKind(0, parseSymbol('s m p v a/B#'))).toBe('class');
    expect(mapKind(0, parseSymbol('s m p v a/B#x.'))).toBe('field');
    expect(mapKind(0, parseSymbol('s m p v a/x.'))).toBe('variable');
    expect(mapKind(0, parseSymbol('s m p v a/B#`<constructor>`().'))).toBe('constructor');
    expect(mapKind(0, parseSymbol('s m p v a/m!'))).toBe('macro');
  });
});

function row(id: string, kind: SymbolRow['kind'], start: number, end: number, parent: string | null): SymbolRow {
  const name = id.slice(id.lastIndexOf('.') + 1);
  return { id, file: 'f.ts', ordinal: 0, kind, name, fqn: id, start_line: start, end_line: end, start_byte: 0, end_byte: 0, signature: '', doc: '', modifiers: '', exported: 1, parent, declared_type: null, meta: null };
}

describe('FileSymbolIndex', () => {
  const rows = [row('f.ts', 'module', 1, 40, null), row('A', 'class', 2, 20, 'f.ts'), row('A.m', 'method', 5, 10, 'A'), row('g', 'function', 25, 30, 'f.ts')];
  const idx = new FileSymbolIndex('f.ts', rows);
  it('finds the innermost symbol and its containing chain', () => {
    expect(idx.innermost(7)?.id).toBe('A.m');
    expect(idx.innermost(3)?.id).toBe('A');
    expect(idx.innermost(22)).toBeNull();
    expect(idx.scopeAt(22)).toBe('f.ts');
    expect(idx.scopeAt(27)).toBe('g');
    expect(idx.containing(7).map((r) => r.id)).toEqual(['A.m', 'A']);
    expect(idx.containing(50)).toEqual([]);
  });
  it('makes symbols added during an import findable by id but never an enclosing scope', () => {
    idx.add(row('A.m.inner', 'function', 6, 8, 'A.m'));
    expect(idx.get('A.m.inner')?.id).toBe('A.m.inner');
    expect(idx.innermost(7)?.id).toBe('A.m');
    expect(idx.containing(7).map((r) => r.id)).toEqual(['A.m', 'A']);
  });

  it('ignores previously scip-created rows when painting the line map', () => {
    const created = { ...row('A.v', 'variable', 7, 7, 'A.m'), meta: '{"scip":true}' };
    const i2 = new FileSymbolIndex('f.ts', [...rows, created]);
    expect(i2.get('A.v')?.id).toBe('A.v');
    expect(i2.innermost(7)?.id).toBe('A.m');
  });
});
