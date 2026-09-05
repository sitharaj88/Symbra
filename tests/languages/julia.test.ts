import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { julia } from '../../src/languages/julia.js';

registerLanguage(julia);

const src = readFileSync(new URL('../fixtures/julia/sample.jl', import.meta.url), 'utf8');
const testSrc = readFileSync(new URL('../fixtures/julia/test_sample.jl', import.meta.url), 'utf8');

describe('julia extractor', () => {
  it('extracts modules, structs, functions, constants and macros', async () => {
    const ir = (await extractFile('src/sample.jl', src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(ir.errorPct).toBe(0);
    expect(ir.doc).toBe('Sample module for extractor tests.');
    expect(by['UserService'].kind).toBe('namespace');
    expect(by['UserService.User'].kind).toBe('struct');
    expect(by['UserService.User'].doc).toBe('A user record.');
    expect(by['UserService.User.id'].declaredType).toBe('Int');
    expect(by['UserService.Cache'].modifiers).toContain('mutable');
    expect(by['UserService.Cache.entries'].declaredType).toBe('Dict');
    expect(by['UserService.Storable'].kind).toBe('interface');
    expect(by['UserService.Storable'].doc).toBe('Any storable thing.');
    expect(by['UserService.Row'].supertypes).toEqual([{ name: 'Storable', kind: 'extends' }]);
    expect(by['UserService.MAX_RETRIES'].kind).toBe('constant');
    expect(by['UserService.trace'].kind).toBe('macro');
    expect(by['UserService.find_user'].kind).toBe('function');
    expect(by['UserService.find_user'].doc).toBe('Find a user by id.');
    expect(by['UserService.normalize'].kind).toBe('function');
    expect(by['UserService.render_user'].signature).toBe('render_user(u::User)');
    expect(by['UserService.traced'].kind).toBe('function');
    // only exported names are marked exported
    expect(by['UserService.find_user'].exported).toBe(true);
    expect(by['UserService.normalize'].exported).toBe(false);
  });

  it('collapses multiple methods into one symbol with a method count', async () => {
    const ir = (await extractFile('src/sample.jl', src))!;
    const defs = ir.definitions.filter((d) => d.name === 'find_user');
    expect(defs.length).toBe(1);
    expect(defs[0]!.meta?.methods).toBe(2);
  });

  it('extracts using/import/include', async () => {
    const ir = (await extractFile('src/sample.jl', src))!;
    const store = ir.imports.find((i) => i.source === 'App.Store')!;
    expect(store.names).toEqual([{ name: 'find_row', alias: 'find_row' }, { name: 'save_row', alias: 'save_row' }]);
    expect(store.namespace).toBe(false);
    const cfg = ir.imports.find((i) => i.source === 'App.Config')!;
    expect(cfg.namespace).toBe(true);
    expect(cfg.alias).toBe('Config');
    const inc = ir.imports.find((i) => i.source === 'helpers.jl')!;
    expect(julia.resolveModule(inc.source, 'src/sample.jl', inc, { hasFile: () => false })[0]).toBe('src/helpers.jl');
    expect(julia.resolveModule('App.Store', 'src/sample.jl', store, { hasFile: () => false })).toContain('src/App/Store.jl');
  });

  it('extracts calls, type annotations, decorators and config reads', async () => {
    const ir = (await extractFile('src/sample.jl', src))!;
    expect(ir.references.some((r) => r.kind === 'call' && r.name === 'normalize')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'type' && r.name === 'User')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'decorator' && r.name === 'trace')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'config' && r.name === 'API_TOKEN')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'config' && r.name === 'OPTIONAL_TOKEN')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'u' && t.type === 'User')).toBe(true);
  });

  it('extracts @testset blocks as tests', async () => {
    const ir = (await extractFile('test/test_sample.jl', testSrc))!;
    const tests = ir.definitions.filter((d) => d.kind === 'test');
    expect(tests.map((t) => t.name)).toEqual(['find_user']);
    expect(tests[0]!.meta?.framework).toBe('Test');
    expect(julia.isTestFile!('test/test_sample.jl')).toBe(true);
    const calls = ir.references.filter((r) => r.kind === 'call');
    expect(calls.some((c) => c.qualifier === 'UserService' && c.name === 'find_user')).toBe(true);
    expect(ir.definitions[calls[0]!.scope]!.kind).toBe('test');
  });
});
