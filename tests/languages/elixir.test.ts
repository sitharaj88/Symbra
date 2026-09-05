import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { elixir } from '../../src/languages/elixir.js';

registerLanguage(elixir);
const src = readFileSync(new URL('../fixtures/elixir/sample.ex', import.meta.url), 'utf8');

describe('elixir extractor', () => {
  it('extracts modules, functions, macros, structs and tests', async () => {
    const ir = (await extractFile('lib/my_app/accounts/user.ex', src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(ir.doc).toBe('A user.');
    expect(by['MyApp.Accounts.User'].kind).toBe('namespace');
    expect(by['MyApp.Accounts.User'].doc).toBe('A user.');
    expect(by['MyApp.Accounts.User.find'].kind).toBe('function');
    expect(by['MyApp.Accounts.User.find'].doc).toBe('Finds a user.');
    expect(by['MyApp.Accounts.User.find'].signature).toBe('def find(id) when is_integer(id)');
    expect(by['MyApp.Accounts.User.find'].meta?.arity).toBe(1);
    expect(by['MyApp.Accounts.User.create'].kind).toBe('function');
    expect(by['MyApp.Accounts.User.helper'].modifiers).toContain('private');
    expect(by['MyApp.Accounts.User.helper'].exported).toBe(false);
    expect(by['MyApp.Accounts.User.debug'].kind).toBe('macro');
    expect(by['MyApp.Accounts.User.__struct__'].kind).toBe('struct');
    expect(by['MyApp.Accounts.User.@max'].kind).toBe('constant');
    expect(by['MyApp.Accounts.User.Inner'].kind).toBe('namespace');
    expect(by['MyApp.Accounts.User.Inner.go'].kind).toBe('function');
    expect(ir.definitions.filter((d) => d.kind === 'test').map((d) => d.name)).toEqual(['describe find/1', 'test finds a user', 'test creates']);
  });
  it('extracts alias/import/use/require and resolves module paths', async () => {
    const ir = (await extractFile('lib/my_app/accounts/user.ex', src))!;
    const bySrc = Object.fromEntries(ir.imports.map((i) => [i.source, i]));
    expect(bySrc['Ecto.Schema']).toMatchObject({ namespace: true, alias: 'Schema' });
    expect(bySrc['Ecto.Changeset']).toMatchObject({ namespace: true, names: [] });
    expect(bySrc['MyApp.Helpers']).toMatchObject({ namespace: false, names: [{ name: 'fmt', alias: 'fmt' }] });
    expect(bySrc['MyApp.Repo']).toMatchObject({ namespace: true, alias: 'Repo' });
    expect(bySrc['MyApp.Accounts.Session']).toMatchObject({ alias: 'Session' });
    expect(bySrc['MyApp.Accounts.Token']).toMatchObject({ alias: 'Token' });
    expect(bySrc['MyApp.Long.Name']).toMatchObject({ alias: 'LN' });
    expect(bySrc['Logger']).toMatchObject({ alias: 'Logger' });
    // `use` also records an implements-style reference on the module
    expect(ir.references.some((r) => r.kind === 'implements' && r.name === 'Schema' && r.qualifier === 'Ecto')).toBe(true);
    const cands = elixir.resolveModule('MyApp.Accounts.User', 'lib/x.ex', bySrc['MyApp.Repo']!, { hasFile: () => true });
    expect(cands[0]).toBe('lib/my_app/accounts/user.ex');
    expect(elixir.resolveModule('MyAppWeb.UserController', 'lib/x.ex', bySrc['MyApp.Repo']!, { hasFile: () => true })).toContain('lib/my_app_web/controllers/user_controller.ex');
  });
  it('extracts calls, struct constructions and env reads', async () => {
    const ir = (await extractFile('lib/my_app/accounts/user.ex', src))!;
    const calls = ir.references.filter((r) => r.kind === 'call');
    expect(calls.some((c) => c.name === 'get' && c.qualifier === 'Repo' && c.arity === 2)).toBe(true);
    expect(calls.some((c) => c.name === 'normalize' && c.qualifier === '' && c.arity === 1)).toBe(true); // piped
    expect(calls.some((c) => c.name === 'helper' && c.qualifier === '')).toBe(true);
    expect(calls.some((c) => c.name === 'call' && c.qualifier === 'LN')).toBe(true);
    expect(calls.some((c) => c.name === 'changeset')).toBe(true);
    expect(calls.some((c) => c.name === 'find' && c.qualifier === 'User')).toBe(true);
    // definition heads and macros are not calls
    expect(calls.some((c) => c.name === 'def' || c.name === 'defmodule' || c.name === 'is_integer')).toBe(false);
    expect(calls.filter((c) => c.name === 'find' && c.qualifier === '')).toEqual([]);
    expect(ir.references.some((r) => r.kind === 'config' && r.name === 'API_TOKEN')).toBe(true);
  });
});
