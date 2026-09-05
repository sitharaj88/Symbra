import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { csharp } from '../../src/languages/csharp.js';

registerLanguage(csharp);

const sample = readFileSync(new URL('../fixtures/csharp/sample.cs', import.meta.url), 'utf8');
const program = readFileSync(new URL('../fixtures/csharp/Program.cs', import.meta.url), 'utf8');
const models = readFileSync(new URL('../fixtures/csharp/Models.cs', import.meta.url), 'utf8');

describe('csharp extractor', () => {
  it('extracts namespaces, types and members with kinds, docs and signatures', async () => {
    const ir = (await extractFile('src/Acme/sample.cs', sample))!;
    expect(ir.errorPct).toBe(0);
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['Acme.Services'].kind).toBe('namespace');
    expect(by['Acme.Services.BaseRepo'].kind).toBe('class');
    expect(by['Acme.Services.BaseRepo'].doc).toBe('Base repository.');
    expect(by['Acme.Services.BaseRepo'].modifiers).toEqual(['public', 'abstract']);
    expect(by['Acme.Services.BaseRepo'].supertypes).toEqual([{ name: 'IDisposable', kind: 'implements' }]);
    expect(by['Acme.Services.BaseRepo.items'].kind).toBe('field');
    expect(by['Acme.Services.BaseRepo.items'].declaredType).toBe('List');
    expect(by['Acme.Services.BaseRepo.items'].signature).toBe('protected readonly List<T> items = new List<T>()');
    expect(by['Acme.Services.IUserRepo'].kind).toBe('interface');
    expect(by['Acme.Services.IUserRepo.Find'].exported).toBe(true); // interface members are public
    expect(by['Acme.Services.UserRepo'].supertypes).toEqual([
      { name: 'BaseRepo', kind: 'extends' },
      { name: 'IUserRepo', kind: 'implements' },
    ]);
    expect(by['Acme.Services.UserRepo'].doc).toBe('Repository for users.');
    expect(by['Acme.Services.UserRepo.session'].kind).toBe('field');
    expect(by['Acme.Services.UserRepo.session'].declaredType).toBe('Session');
    expect(by['Acme.Services.UserRepo.session'].exported).toBe(false);
    expect(by['Acme.Services.UserRepo.Count'].kind).toBe('property');
    expect(by['Acme.Services.UserRepo.Count'].declaredType).toBe('int');
    expect(by['Acme.Services.UserRepo.MaxRetries'].signature).toBe('public static int MaxRetries = 3');
    expect(by['Acme.Services.UserRepo.Timeout'].kind).toBe('field');
    expect(by['Acme.Services.UserRepo.Changed'].modifiers).toContain('event');
    expect(by['Acme.Services.UserRepo.UserRepo'].kind).toBe('constructor');
    expect(by['Acme.Services.UserRepo.Find'].kind).toBe('method');
    expect(by['Acme.Services.UserRepo.Find'].signature).toBe('public User Find(int id)');
    expect(by['Acme.Services.UserRepo.Find'].doc).toBe('Finds a user.');
    expect(by['Acme.Services.UserRepo.Find'].range.startLine).toBe(41);
    expect(by['Acme.Services.UserRepo.Dispose'].modifiers).toEqual(['public', 'override']);
    expect(by['Acme.Services.UserRepo.Normalize'].exported).toBe(true); // internal
    expect(by['Acme.Services.UserRepo.Normalize'].modifiers).toContain('static');
    expect(by['Acme.Services.UserRepo.Normalize.Helper'].kind).toBe('function');
    expect(by['Acme.Services.Point'].kind).toBe('struct');
    expect(by['Acme.Services.Point.X'].kind).toBe('field');
    expect(by['Acme.Services.Person'].kind).toBe('class');
    expect(by['Acme.Services.Person'].meta?.record).toBe(true);
    expect(by['Acme.Services.Person.Name'].kind).toBe('field');
    expect(by['Acme.Services.Person.Name'].declaredType).toBe('string');
    expect(by['Acme.Services.Color'].kind).toBe('enum');
    expect(by['Acme.Services.Color.Green'].kind).toBe('enum_member');
    expect(by['Acme.Services.Handler'].kind).toBe('type_alias');
  });

  it('extracts ASP.NET attribute routes and test methods', async () => {
    const ir = (await extractFile('src/Acme/sample.cs', sample))!;
    const routes = ir.definitions.filter((d) => d.kind === 'route');
    expect(routes.map((r) => r.name)).toEqual(['GET /api/users/{id}', 'POST /api/users']);
    expect(routes[0]!.meta).toEqual({ method: 'GET', path: '/api/users/{id}', handler: 'Get' });
    expect(routes[0]!.parent).toBe(-1);
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['Acme.Services.UserRepoTests.FindReturnsUser'].kind).toBe('test');
    expect(by['Acme.Services.UserRepoTests.FindReturnsUser'].meta?.framework).toBe('xunit');
    expect(by['Acme.Services.UserRepoTests.FindTheory'].kind).toBe('test');
    expect(by['Acme.Services.UsersController.Get'].kind).toBe('method');
  });

  it('extracts using directives as namespace imports', async () => {
    const ir = (await extractFile('src/Acme/sample.cs', sample))!;
    expect(ir.imports.map((i) => i.source)).toEqual(['System', 'System.Collections.Generic', 'Microsoft.AspNetCore.Mvc', 'Xunit', 'System.Text.Json.JsonSerializer', 'System']);
    expect(ir.imports.filter((i) => i.namespace)).toHaveLength(5);
    expect(ir.imports.find((i) => i.source === 'System.Text.Json.JsonSerializer')?.alias).toBe('Json');
    // `using static System.Math` is modelled as the name `Math` imported from namespace `System`
    const stat = ir.imports[5]!;
    expect(stat.namespace).toBe(false);
    expect(stat.names).toEqual([{ name: 'Math', alias: '' }]);
    expect(csharp.resolveModule('System', 'src/Acme/sample.cs', ir.imports[0]!, { hasFile: () => true })).toEqual([]);
  });

  it('extracts calls, constructor refs, type refs, decorators and config reads', async () => {
    const ir = (await extractFile('src/Acme/sample.cs', sample))!;
    const refs = ir.references;
    expect(refs.some((r) => r.kind === 'call' && r.qualifier === 'session' && r.name === 'Get' && r.arity === 1)).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.qualifier === 'local' && r.name === 'Warm')).toBe(true);
    expect(refs.some((r) => r.kind === 'new' && r.name === 'User' && r.line === 44)).toBe(true);
    expect(refs.some((r) => r.kind === 'new' && r.name === 'Cache' && r.line === 45)).toBe(true); // implicit `new()`
    expect(refs.some((r) => r.kind === 'new' && r.name === 'UserRepo' && r.arity === 1)).toBe(true);
    expect(refs.some((r) => r.kind === 'type' && r.name === 'Session' && r.line === 50)).toBe(true); // typeof
    expect(refs.some((r) => r.kind === 'type' && r.name === 'User' && r.line === 51)).toBe(true); // as
    expect(refs.some((r) => r.kind === 'implements' && r.name === 'IUserRepo')).toBe(true);
    expect(refs.some((r) => r.kind === 'extends' && r.name === 'BaseRepo')).toBe(true);
    expect(refs.some((r) => r.kind === 'decorator' && r.name === 'Obsolete')).toBe(true);
    expect(refs.some((r) => r.kind === 'decorator' && r.name === 'FromBody')).toBe(true);
    expect(refs.some((r) => r.kind === 'config' && r.name === 'API_TOKEN')).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.qualifier === 'Assert' && r.name === 'NotNull')).toBe(true);
  });

  it('records local type facts for receiver typing', async () => {
    const ir = (await extractFile('src/Acme/sample.cs', sample))!;
    const lt = ir.localTypes;
    expect(lt.some((t) => t.name === 'session' && t.type === 'Session' && t.via === 'annotation')).toBe(true);
    expect(lt.some((t) => t.name === 'this.cache' && t.type === 'Cache' && t.via === 'field')).toBe(true);
    expect(lt.some((t) => t.name === 'fallback' && t.type === 'User')).toBe(true);
    expect(lt.some((t) => t.name === 'local' && t.type === 'Cache')).toBe(true);
    expect(lt.some((t) => t.name === 'u' && t.type === 'User')).toBe(true); // `is User u`
  });

  it('extracts minimal API routes and top-level statements', async () => {
    const ir = (await extractFile('src/Program.cs', program))!;
    const routes = ir.definitions.filter((d) => d.kind === 'route');
    expect(routes.map((r) => r.name)).toEqual(['GET /health', 'POST /users']);
    expect(routes[1]!.meta?.handler).toBe('CreateUser');
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['CreateUser'].kind).toBe('function');
    expect(by['app'].kind).toBe('variable');
    expect(ir.references.some((r) => r.kind === 'value' && r.name === 'CreateUser')).toBe(true);
  });

  it('emits value refs for callbacks in argument position and array-initializer elements', async () => {
    const src = `
      namespace Acme {
        class Repo {
          void Wire() {
            Register(OnCreated);
            Register(handler: OnCreated);
            var handlers = new Action[] { OnCreated, OnDeleted };
            Register(this, null, true);
          }
        }
      }
    `;
    const ir = (await extractFile('src/Acme/Wire.cs', src))!;
    const values = ir.references.filter((r) => r.kind === 'value');
    expect(values.some((r) => r.name === 'OnCreated')).toBe(true);
    expect(values.some((r) => r.name === 'OnDeleted')).toBe(true);
    // the argument label ("handler:") and this/null/true are never emitted as value refs
    expect(values.some((r) => r.name === 'handler')).toBe(false);
    expect(values.some((r) => r.name === 'this' || r.name === 'null' || r.name === 'true')).toBe(false);
  });

  it('prefixes file-scoped namespaces into fqns', async () => {
    const ir = (await extractFile('src/Models.cs', models))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['Acme.Models'].kind).toBe('namespace');
    expect(by['Acme.Models.User'].kind).toBe('class');
    expect(by['Acme.Models.User'].doc).toBe('A user.');
    expect(by['Acme.Models.User.Normalize'].kind).toBe('method');
    expect(by['Acme.Models.Employee.Name'].kind).toBe('field');
    expect(by['Acme.Models.Employee.Display'].kind).toBe('property');
  });

  it('detects test files', () => {
    expect(csharp.isTestFile!('src/Repo/UserRepoTests.cs')).toBe(true);
    expect(csharp.isTestFile!('tests/Unit/Foo.cs')).toBe(true);
    expect(csharp.isTestFile!('src/Repo/UserRepo.cs')).toBe(false);
  });
});
