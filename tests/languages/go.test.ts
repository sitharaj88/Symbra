import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { registerLanguage } from '../../src/languages/registry.js';
import { go } from '../../src/languages/go.js';
import { extractFile } from '../../src/index/extract.js';
import type { Import } from '../../src/ir/types.js';

registerLanguage(go);

const src = readFileSync(new URL('../fixtures/go/sample.go', import.meta.url), 'utf8');
const imp: Import = { source: '', names: [], namespace: true, alias: '', kind: 'static', line: 1 };

describe('go extractor', () => {
  it('extracts definitions with kinds, ranges, docs and signatures', async () => {
    const ir = (await extractFile('internal/sample/sample.go', src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(ir.errorPct).toBe(0);
    expect(ir.doc).toBe('Package sample is a fixture for the Go extractor.');
    expect(by['MaxRetries'].kind).toBe('constant');
    expect(by['MaxRetries'].doc).toBe('MaxRetries is the retry budget.');
    expect(by['Version'].doc).toBe('Version string.');
    expect(by['debug'].exported).toBe(false);
    expect(by['DefaultStore'].kind).toBe('variable');
    expect(by['DefaultStore'].declaredType).toBe('store.Store');
    expect(by['typed'].declaredType).toBe('Cache');
    expect(by['Cache'].kind).toBe('struct');
    expect(by['Cache'].doc).toBe('Cache holds entries.');
    expect(by['User'].supertypes).toEqual([
      { name: 'Base', kind: 'extends' },
      { name: 'store.Meta', kind: 'extends' },
    ]);
    expect(by['User.ID'].kind).toBe('field');
    expect(by['User.ID'].doc).toBe('ID identifies the user.');
    expect(by['User.ID'].exported).toBe(true);
    expect(by['User.Name'].meta?.tag).toBe('json:"name"');
    expect(by['User.cache'].declaredType).toBe('Cache');
    expect(by['User.cache'].exported).toBe(false);
    expect(by['Repo'].kind).toBe('interface');
    expect(by['Repo.Find'].kind).toBe('method');
    expect(by['Repo.Find'].signature).toBe('Find(id int) (*User, error)');
    expect(by['Repo.Find'].doc).toBe('Find returns a user.');
    expect(by['Repo.Find'].modifiers).toContain('abstract');
    expect(by['ID'].kind).toBe('type_alias');
    expect(by['Handler'].kind).toBe('type_alias');
    expect(by['NewUser'].kind).toBe('function');
    expect(by['NewUser'].signature).toBe('func NewUser(name string) *User');
    expect(by['NewUser'].range.startLine).toBe(57);
    expect(by['NewUser'].range.endLine).toBe(61);
    expect(by['User.Greet'].kind).toBe('method');
    expect(by['User.Greet'].parent).toBe(-1);
    expect(by['User.Greet'].doc).toBe('Greet says hello.');
    expect(by['User.Greet'].signature).toBe('func (u *User) Greet(prefix string) string');
    expect(by['Cache.Find'].meta?.receiver).toBe('Cache');
    expect(by['Map'].signature).toBe('func Map[T any, U any](xs []T, f func(T) U) []U');
    expect(by['helper'].exported).toBe(false);
    expect(by['TestGreet'].kind).toBe('test');
    expect(by['BenchmarkGreet'].kind).toBe('test');
    expect(by['main'].kind).toBe('function');
  });

  it('extracts routes with handlers, never inside tests', async () => {
    const ir = (await extractFile('internal/sample/sample.go', src))!;
    const routes = ir.definitions.filter((d) => d.kind === 'route');
    expect(routes.map((r) => r.name)).toEqual(['ANY /health', 'ANY /users', 'GET /users/:id', 'POST /users', 'DELETE /users/:id', 'GET /ping']);
    expect(routes.map((r) => r.meta?.handler)).toEqual(['healthHandler', 'listUsers', 'getUser', 'createUser', 'deleteUser', 'pingHandler']);
    expect(routes.every((r) => r.parent === -1)).toBe(true);
    expect(routes.find((r) => r.name === 'GET /users/:id')?.meta).toEqual({ method: 'GET', path: '/users/:id', handler: 'getUser' });
    expect(routes.some((r) => r.meta?.path === '/ignored')).toBe(false);
  });

  it('extracts namespace imports with package aliases', async () => {
    const ir = (await extractFile('internal/sample/sample.go', src))!;
    const bySrc = Object.fromEntries(ir.imports.map((i) => [i.source, i]));
    expect(ir.imports).toHaveLength(5);
    expect(bySrc['fmt']).toMatchObject({ namespace: true, alias: 'fmt', names: [], line: 5 });
    expect(bySrc['net/http']).toMatchObject({ namespace: true, alias: 'http' });
    expect(bySrc['github.com/gin-gonic/gin']).toMatchObject({ namespace: true, alias: 'gin', line: 9 });
    expect(bySrc['github.com/example/app/internal/store']).toMatchObject({ namespace: true, alias: 'store' });
  });

  it('extracts calls, composite literals, type refs, receiver types and config reads', async () => {
    const ir = (await extractFile('internal/sample/sample.go', src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    const calls = ir.references.filter((r) => r.kind === 'call');
    expect(calls.some((c) => c.qualifier === 'u' && c.name === 'Save' && c.scope === by['User.Greet'].ordinal)).toBe(true);
    expect(calls.some((c) => c.qualifier === 'store' && c.name === 'NewService')).toBe(true);
    expect(calls.some((c) => c.qualifier === '' && c.name === 'NewUser' && c.arity === 1)).toBe(true);
    expect(calls.some((c) => c.name === 'append' || c.name === 'len' || c.name === 'make')).toBe(false);
    const news = ir.references.filter((r) => r.kind === 'new');
    expect(news.some((n) => n.name === 'User' && n.line === 58)).toBe(true);
    expect(news.some((n) => n.name === 'Cache' && n.line === 59)).toBe(true);
    const types = ir.references.filter((r) => r.kind === 'type');
    expect(types.some((t) => t.name === 'ResponseWriter' && t.qualifier === 'http')).toBe(true);
    expect(types.some((t) => t.name === 'int' || t.name === 'string' || t.name === 'error')).toBe(false);
    expect(ir.references.some((r) => r.kind === 'extends' && r.name === 'Meta' && r.qualifier === 'store')).toBe(true);
    expect(ir.references.filter((r) => r.kind === 'config').map((r) => r.name)).toEqual(['API_TOKEN', 'DEBUG']);

    const lt = ir.localTypes;
    expect(lt.some((t) => t.name === 'u' && t.type === 'User' && t.via === 'annotation' && t.scope === by['User.Greet'].ordinal)).toBe(true);
    expect(lt.some((t) => t.name === 'c' && t.type === 'Cache' && t.scope === by['Cache.Find'].ordinal)).toBe(true);
    expect(lt.some((t) => t.name === 'repo' && t.type === 'Repo' && t.via === 'annotation')).toBe(true);
    expect(lt.some((t) => t.name === 'user' && t.type === 'User' && t.via === 'constructor_call')).toBe(true);
    expect(lt.some((t) => t.name === 'other' && t.type === 'User' && t.via === 'new')).toBe(true);
    expect(lt.some((t) => t.name === 'svc' && t.type === 'store.Service' && t.via === 'constructor_call')).toBe(true);
    expect(lt.some((t) => t.name === 'u.cache' && t.type === 'Cache' && t.via === 'new')).toBe(true);
    expect(lt.some((t) => t.name === 'c' && t.type === 'gin.Context' && t.scope === by['getUser'].ordinal)).toBe(true);
  });

  it('detects test files and resolves import paths to package file candidates', () => {
    expect(go.isTestFile!('pkg/store/store_test.go')).toBe(true);
    expect(go.isTestFile!('pkg/store/store.go')).toBe(false);
    const withMod = go.resolveModule('github.com/example/app/internal/store', 'cmd/app/main.go', imp, { hasFile: () => false, goModule: 'github.com/example/app' });
    expect(withMod[0]).toBe('internal/store/store.go');
    expect(withMod).toContain('internal/store/doc.go');
    expect(withMod.some((c) => c.startsWith('github.com/'))).toBe(false);
    expect(go.resolveModule('github.com/example/app', 'cmd/app/main.go', imp, { hasFile: () => false, goModule: 'github.com/example/app' })).toContain('app.go');
    const noMod = go.resolveModule('github.com/example/app/internal/store', 'cmd/app/main.go', imp, { hasFile: () => false });
    expect(noMod).toContain('internal/store/store.go');
    expect(noMod).toContain('app/internal/store/store.go');
    expect(noMod).not.toContain('github.com/example/app/internal/store/store.go');
    const bare = go.resolveModule('app/internal/store', 'cmd/app/main.go', imp, { hasFile: () => false });
    expect(bare).toContain('app/internal/store/store.go');
    expect(bare).toContain('internal/store/store.go');
    expect(go.resolveModule('fmt', 'main.go', imp, { hasFile: () => false })[0]).toBe('fmt/fmt.go');
  });
});
