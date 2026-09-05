import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { php } from '../../src/languages/php.js';

registerLanguage(php);

const src = readFileSync(new URL('../fixtures/php/sample.php', import.meta.url), 'utf8');

describe('php extractor', () => {
  it('extracts namespaces, classes, interfaces, traits, enums, members and docs', async () => {
    const ir = (await extractFile('src/Services/UserService.php', src))!;
    expect(ir.errorPct).toBe(0);
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(ir.doc).toBe('Sample PHP file for extractor tests.');
    expect(by['App.Services'].kind).toBe('namespace');
    expect(by['App.Services.VERSION'].kind).toBe('constant');
    const svc = by['App.Services.UserService'];
    expect(svc.kind).toBe('class');
    expect(svc.parent).toBe(-1);
    expect(svc.modifiers).toEqual(['abstract']);
    expect(svc.doc).toBe('Service for users.');
    expect(svc.signature).toBe('abstract class UserService extends BaseService implements Repo, Countable');
    expect(svc.supertypes).toEqual([
      { name: 'BaseService', kind: 'extends' },
      { name: 'Repo', kind: 'implements' },
      { name: 'Countable', kind: 'implements' },
      { name: 'HasTimestamps', kind: 'implements' },
      { name: 'Loggable', kind: 'implements' },
    ]);
    expect(by['App.Services.UserService.MAX'].kind).toBe('constant');
    expect(by['App.Services.UserService.MIN'].exported).toBe(false);
    expect(by['App.Services.UserService.repo']).toMatchObject({ kind: 'field', declaredType: 'Repo', exported: false });
    expect(by['App.Services.UserService.user']).toMatchObject({ kind: 'field', declaredType: 'User' });
    expect(by['App.Services.UserService.count'].kind).toBe('method');
    expect(by['App.Services.UserService.count'].modifiers).toEqual(['final', 'public']);
    // promoted constructor params become fields of the class
    expect(by['App.Services.UserService.cache']).toMatchObject({ kind: 'field', declaredType: 'C', parent: svc.ordinal, exported: false });
    expect(by['App.Services.UserService.log'].modifiers).toEqual(['protected', 'readonly']);
    expect(by['App.Services.UserService.__construct'].kind).toBe('constructor');
    expect(by['App.Services.UserService.find'].signature).toBe('public static function find(int $id, ?P $p = null): ?User');
    expect(by['App.Services.UserService.find'].doc).toBe('Find one.');
    expect(by['App.Services.UserService.find'].range.startLine).toBe(57);
    expect(by['App.Services.UserService.helper'].modifiers).toEqual(['abstract', 'protected']);
    expect(by['App.Services.UserService.hidden'].exported).toBe(false);
    expect(by['App.Services.Repo'].kind).toBe('interface');
    expect(by['App.Services.Repo'].supertypes).toEqual([{ name: 'Countable', kind: 'extends' }, { name: 'Base', kind: 'extends' }]);
    expect(by['App.Services.Loggable'].kind).toBe('trait');
    expect(by['App.Services.Status'].kind).toBe('enum');
    expect(by['App.Services.Status.Active'].kind).toBe('enum_member');
    expect(by['App.Services.Status.label'].kind).toBe('method');
    expect(by['App.Services.helper'].kind).toBe('function');
    expect(by['App.Services.helper'].signature).toBe('function helper(User $u, $x): string');
  });

  it('extracts attribute and Laravel routes, and tests', async () => {
    const ir = (await extractFile('src/Services/UserService.php', src))!;
    const routes = ir.definitions.filter((d) => d.kind === 'route');
    expect(routes.map((r) => r.name)).toEqual(['GET,HEAD /users/{id}', 'GET /api/users', 'POST /api/users', 'GET /closure']);
    expect(routes[0]!.meta).toEqual({ method: 'GET,HEAD', path: '/users/{id}', handler: 'show' });
    expect(routes[1]!.meta?.handler).toBe('UserController.show');
    expect(routes[2]!.meta?.handler).toBe('UserController.store');
    expect(routes[3]!.meta?.handler).toBe('');
    expect(ir.references.filter((r) => r.kind === 'decorator').map((r) => r.name)).toEqual(['Route', 'Deprecated', 'Route']);
    const tests = ir.definitions.filter((d) => d.kind === 'test').map((d) => d.name);
    expect(tests).toEqual(['itWorks', 'testBar']);
    expect(ir.definitions.find((d) => d.name === 'helperNotTest')?.kind).toBe('method');
    expect(php.isTestFile!('tests/Unit/UserTest.php')).toBe(true);
    expect(php.isTestFile!('src/FooTest.php')).toBe(true);
    expect(php.isTestFile!('src/Foo.php')).toBe(false);
  });

  it('extracts use imports, require/include and resolves PSR-4 paths', async () => {
    const ir = (await extractFile('src/Services/UserService.php', src))!;
    expect(ir.imports.find((i) => i.names[0]?.name === 'User')).toMatchObject({ source: 'App\\Models', names: [{ name: 'User', alias: 'User' }], namespace: false });
    expect(ir.imports.find((i) => i.names[0]?.name === 'Post')?.names).toEqual([{ name: 'Post', alias: 'P' }]);
    // group use expands to one import per name
    expect(ir.imports.filter((i) => i.source === 'App\\Contracts').map((i) => i.names[0])).toEqual([{ name: 'Repo', alias: 'Repo' }, { name: 'Cache', alias: 'C' }]);
    expect(ir.imports.find((i) => i.names[0]?.name === 'fmt')?.source).toBe('App\\Helpers');
    expect(ir.imports.find((i) => i.source === './helpers.php')).toMatchObject({ names: [], namespace: false });
    expect(ir.imports.find((i) => i.source === 'legacy.php')).toBeDefined();
    const project = { hasFile: () => false };
    const user = ir.imports.find((i) => i.names[0]?.name === 'User')!;
    const cands = php.resolveModule(user.source, 'src/Services/UserService.php', user, project);
    expect(cands).toContain('src/Models/User.php');
    expect(cands).toContain('app/Models/User.php');
    expect(cands).toContain('lib/Models/User.php');
    expect(cands).toContain('Models/User.php');
    expect(cands).toContain('src/App/Models/User.php');
    expect(cands).toContain('app/models/User.php');
    const req = ir.imports.find((i) => i.source === './helpers.php')!;
    expect(php.resolveModule(req.source, 'src/Services/UserService.php', req, project)[0]).toBe('src/Services/helpers.php');
    const inc = ir.imports.find((i) => i.source === 'legacy.php')!;
    expect(php.resolveModule(inc.source, 'src/Services/UserService.php', inc, project)).toContain('src/Services/legacy.php');
  });

  it('extracts calls with qualifiers, new, type refs, config reads and receiver-type facts', async () => {
    const ir = (await extractFile('src/Services/UserService.php', src))!;
    const refs = ir.references;
    expect(refs.some((r) => r.kind === 'new' && r.name === 'UserRepo')).toBe(true);
    expect(refs.some((r) => r.kind === 'new' && r.name === 'Post' && r.qualifier === 'App.Models')).toBe(true);
    // `new static` / `new self` are skipped
    expect(refs.some((r) => r.kind === 'new' && (r.name === 'static' || r.name === 'self'))).toBe(false);
    expect(refs.some((r) => r.kind === 'call' && r.name === 'save' && r.qualifier === 'u')).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.name === 'get' && r.qualifier === 'this.cache' && r.arity === 1)).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.name === 'helper' && r.qualifier === 'self')).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.name === 'create' && r.qualifier === 'static')).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.name === '__construct' && r.qualifier === 'parent')).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.name === 'find' && r.qualifier === 'User')).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.name === 'all' && r.qualifier === 'User')).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.name === 'fmt' && r.qualifier === '')).toBe(true);
    expect(refs.some((r) => r.kind === 'type' && r.name === 'Repo')).toBe(true);
    expect(refs.some((r) => r.kind === 'type' && r.name === 'Logger')).toBe(true);
    expect(refs.some((r) => r.kind === 'type' && r.name === 'P' && r.line === 50)).toBe(true); // instanceof
    expect(refs.some((r) => r.kind === 'type' && r.name === 'Response')).toBe(true); // return type
    expect(refs.some((r) => r.kind === 'type' && r.name === 'UserController')).toBe(true); // ::class
    expect(refs.filter((r) => r.kind === 'config').map((r) => r.name)).toEqual(['HOME', 'DB_HOST', 'APP_KEY']);
    expect(ir.localTypes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'this.repo', type: 'UserRepo', via: 'new' }),
        expect.objectContaining({ name: 'u', type: 'User', via: 'new' }),
        expect.objectContaining({ name: 'cache', type: 'C', via: 'annotation' }),
        expect.objectContaining({ name: 'this.cache', type: 'C', via: 'field' }),
        expect.objectContaining({ name: 'found', type: 'User', via: 'constructor_call' }),
        expect.objectContaining({ name: 'p', type: 'P', via: 'annotation' }),
      ]),
    );
    expect(ir.localTypes.some((t) => t.name === 'e' && t.type === 'Post')).toBe(true);
  });
});
