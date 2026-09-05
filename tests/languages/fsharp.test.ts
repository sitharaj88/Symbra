import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { fsharp } from '../../src/languages/fsharp.js';

registerLanguage(fsharp);

const src = readFileSync(new URL('../fixtures/fsharp/Sample.fs', import.meta.url), 'utf8');

describe('fsharp extractor', () => {
  it('extracts namespaces, modules, types and members', async () => {
    const ir = (await extractFile('src/App/Sample.fs', src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(ir.errorPct).toBe(0);
    expect(by['App.Service'].kind).toBe('namespace');
    expect(by['App.Service.User'].kind).toBe('struct');
    expect(by['App.Service.User'].doc).toBe('A user record.');
    expect(by['App.Service.User.Id'].declaredType).toBe('int');
    expect(by['App.Service.Status'].kind).toBe('enum');
    expect(by['App.Service.Status.Suspended'].kind).toBe('enum_member');
    expect(by['App.Service.IStore'].kind).toBe('interface');
    expect(by['App.Service.IStore.Get'].modifiers).toContain('abstract');
    expect(by['App.Service.MemoryStore'].kind).toBe('class');
    expect(by['App.Service.MemoryStore'].supertypes).toEqual([
      { name: 'BaseStore', kind: 'extends' },
      { name: 'IStore', kind: 'implements' },
    ]);
    expect(by['App.Service.MemoryStore.Count'].kind).toBe('property');
    expect(by['App.Service.MemoryStore.Count'].doc).toBe('Current item count.');
    expect(by['App.Service.MemoryStore.Add'].kind).toBe('method');
    expect(by['App.Service.MemoryStore.count'].kind).toBe('field');
    expect(by['App.Service.Users'].kind).toBe('namespace');
    expect(by['App.Service.Users.findUser'].kind).toBe('function');
    expect(by['App.Service.Users.findUser'].doc).toBe('Find a user by id.');
    expect(by['App.Service.Users.normalize'].modifiers).toContain('rec');
    expect(by['App.Service.Users.maxRetries'].kind).toBe('constant');
  });

  it('marks attributed functions as tests', async () => {
    const ir = (await extractFile('src/App/Sample.fs', src))!;
    const tests = ir.definitions.filter((d) => d.kind === 'test');
    expect(tests.map((t) => t.name)).toEqual(['normalize is idempotent', 'testRender']);
    expect(tests[0]!.meta?.framework).toBe('Test');
    expect(tests[1]!.meta?.framework).toBe('Fact');
    expect(ir.references.some((r) => r.kind === 'decorator' && r.name === 'Fact')).toBe(true);
  });

  it('extracts opens, calls, member calls and config reads', async () => {
    const ir = (await extractFile('src/App/Sample.fs', src))!;
    expect(ir.imports.map((i) => i.source)).toEqual(['System', 'App.Store.Repo']);
    expect(ir.imports[1]!.namespace).toBe(true);
    expect(fsharp.resolveModule('App.Store.Repo', 'src/App/Sample.fs', ir.imports[1]!, { hasFile: () => false })).toContain('src/App/Store/Repo.fs');
    const calls = ir.references.filter((r) => r.kind === 'call');
    expect(calls.some((c) => c.qualifier === 'Map' && c.name === 'tryFind' && c.arity === 2)).toBe(true);
    expect(calls.some((c) => c.qualifier === 'store' && c.name === 'Add')).toBe(true);
    expect(calls.some((c) => c.qualifier === '' && c.name === 'normalize')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'new' && r.name === 'MemoryStore')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'config' && r.name === 'API_TOKEN')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'type' && r.name === 'User')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'u' && t.type === 'User')).toBe(true);
  });
});
