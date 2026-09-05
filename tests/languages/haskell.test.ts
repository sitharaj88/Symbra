import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { haskell } from '../../src/languages/haskell.js';

registerLanguage(haskell);

const src = readFileSync(new URL('../fixtures/haskell/Sample.hs', import.meta.url), 'utf8');

describe('haskell extractor', () => {
  it('extracts module, types, classes and functions', async () => {
    const ir = (await extractFile('src/App/Service/User.hs', src))!;
    const by = Object.fromEntries(ir.definitions.filter((d) => !d.meta?.impl).map((d) => [d.fqn, d]));
    expect(ir.errorPct).toBe(0);
    expect(ir.doc).toBe('Sample module for extractor tests.');
    expect(by['App.Service.User'].kind).toBe('namespace');
    expect(by['User'].kind).toBe('struct');
    expect(by['User'].doc).toBe('A user record.');
    expect(by['User.userId'].kind).toBe('field');
    expect(by['User.userId'].declaredType).toBe('Int');
    expect(by['Status'].kind).toBe('enum');
    expect(by['Status.Suspended'].kind).toBe('enum_member');
    expect(by['UserId'].kind).toBe('struct');
    expect(by['UserId'].meta?.newtype).toBe(true);
    expect(by['UserTable'].kind).toBe('type_alias');
    expect(by['Storable'].kind).toBe('trait');
    expect(by['Storable.storeKey'].kind).toBe('method');
    expect(by['findUser'].kind).toBe('function');
    expect(by['findUser'].signature).toBe('findUser :: UserTable -> Int -> Maybe User');
    expect(by['findUser'].doc).toBe('Find a user by id.');
    expect(by['counter'].kind).toBe('constant');
    expect(by['counter'].doc).toBe('Block haddock for the counter.');
    expect(by['prop_normalizeIdempotent'].kind).toBe('test');
  });

  it('collapses multiple equations into one symbol', async () => {
    const ir = (await extractFile('src/App/Service/User.hs', src))!;
    expect(ir.definitions.filter((d) => d.name === 'renderUser').length).toBe(1);
  });

  it('models an instance as an impl block reparented onto the type', async () => {
    const ir = (await extractFile('src/App/Service/User.hs', src))!;
    const impl = ir.definitions.find((d) => d.meta?.impl === true)!;
    expect(impl.supertypes).toEqual([
      { name: 'Storable', kind: 'implements' },
      { name: 'User', kind: 'extends' },
    ]);
    const storeKey = ir.definitions.find((d) => d.name === 'storeKey' && d.parent === ir.definitions.find((x) => x.name === 'User' && x.kind === 'struct')!.ordinal);
    expect(storeKey).toBeTruthy();
  });

  it('extracts imports', async () => {
    const ir = (await extractFile('src/App/Service/User.hs', src))!;
    const map = ir.imports.find((i) => i.source === 'Data.Map')!;
    expect(map.namespace).toBe(true);
    expect(map.alias).toBe('Map');
    const text = ir.imports.find((i) => i.source === 'Data.Text')!;
    expect(text.namespace).toBe(false);
    expect(text.names).toEqual([{ name: 'Text', alias: 'Text' }, { name: 'pack', alias: 'pack' }]);
    expect(ir.imports.find((i) => i.source === 'App.Store.Repo')!.namespace).toBe(true);
    expect(haskell.resolveModule('App.Store.Repo', 'src/App/Service/User.hs', ir.imports[0]!, { hasFile: () => false })).toContain('src/App/Store/Repo.hs');
  });

  it('extracts calls, qualified calls and config reads', async () => {
    const ir = (await extractFile('src/App/Service/User.hs', src))!;
    const calls = ir.references.filter((r) => r.kind === 'call');
    expect(calls.some((c) => c.name === 'lookup' && c.qualifier === 'Map')).toBe(true);
    expect(calls.some((c) => c.name === 'renderUser' && c.qualifier === '')).toBe(true);
    expect(calls.some((c) => c.name === 'userName')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'config' && r.name === 'API_TOKEN')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'config' && r.name === 'OPTIONAL_TOKEN')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'type' && r.name === 'Text')).toBe(true);
  });
});

const specSrc = readFileSync(new URL('../fixtures/haskell/UserSpec.hs', import.meta.url), 'utf8');

describe('haskell hspec extractor', () => {
  it('extracts describe/it blocks as tests', async () => {
    const ir = (await extractFile('test/App/Service/UserSpec.hs', specSrc))!;
    expect(ir.errorPct).toBe(0);
    const tests = ir.definitions.filter((d) => d.kind === 'test');
    expect(tests.map((t) => t.name)).toEqual([
      'spec',
      'describe findUser',
      'it returns Nothing for a missing id',
      'it normalizes',
    ]);
    expect(haskell.isTestFile!('test/App/Service/UserSpec.hs')).toBe(true);
    const call = ir.references.find((r) => r.kind === 'call' && r.name === 'normalize')!;
    expect(ir.definitions[call.scope]!.name).toBe('it returns Nothing for a missing id');
  });
});
