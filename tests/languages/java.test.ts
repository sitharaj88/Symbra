import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { java } from '../../src/languages/java.js';

registerLanguage(java);

const src = readFileSync(new URL('../fixtures/java/sample.java', import.meta.url), 'utf8');
const PATH = 'src/main/java/com/acme/users/Sample.java';

describe('java extractor', () => {
  it('extracts definitions with kinds, ranges, docs and signatures', async () => {
    const ir = (await extractFile(PATH, src))!;
    expect(ir.errorPct).toBe(0);
    expect(ir.doc).toBe('Sample Java file for extractor tests.');
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['BaseRepo'].kind).toBe('class');
    expect(by['BaseRepo'].doc).toBe('Base repository.');
    expect(by['BaseRepo'].modifiers).toEqual(['public', 'abstract']);
    expect(by['BaseRepo'].exported).toBe(true);
    expect(by['BaseRepo'].signature).toBe('public abstract class BaseRepo<T> implements Repository<T>, Closeable');
    expect(by['BaseRepo'].supertypes).toEqual([
      { name: 'Repository<T>', kind: 'implements' },
      { name: 'Closeable', kind: 'implements' },
    ]);
    expect(by['UserRepo'].supertypes).toEqual([{ name: 'BaseRepo<User>', kind: 'extends' }]);
    expect(by['Repository'].kind).toBe('interface');
    expect(by['Repository'].supertypes.map((s) => `${s.kind}:${s.name}`)).toEqual(['extends:AutoCloseable', 'extends:Iterable<T>']);
    expect(by['Repository'].exported).toBe(false); // package-private
    expect(by['Repository.find'].exported).toBe(true); // interface members are public
    expect(by['Repository.size'].modifiers).toEqual(['default']);
    // fields and constants
    expect(by['BaseRepo.MAX_RETRIES'].kind).toBe('constant');
    expect(by['BaseRepo.MAX_RETRIES'].doc).toBe('Max retries.');
    expect(by['BaseRepo.session'].kind).toBe('field');
    expect(by['BaseRepo.session'].declaredType).toBe('Session');
    expect(by['BaseRepo.session'].exported).toBe(false);
    expect(by['BaseRepo.packagePrivate'].kind).toBe('field');
    expect(by['BaseRepo.other'].signature).toBe('int other = 2');
    // members
    expect(by['BaseRepo.BaseRepo'].kind).toBe('constructor');
    expect(by['BaseRepo.find'].kind).toBe('method');
    expect(by['BaseRepo.find'].signature).toBe('public abstract Optional<T> find(String id) throws NotFoundException');
    expect(by['BaseRepo.find'].doc).toBe('Find one by id.\n@param id the id');
    expect(by['BaseRepo.find'].range.startLine).toBe(31);
    expect(by['UserRepo.find'].range).toMatchObject({ startLine: 51, endLine: 60 });
    expect(by['UserRepo.normalize'].modifiers).toEqual(['private', 'static']);
    expect(by['UserRepo.normalize'].exported).toBe(false);
    // enum / record / annotation type
    expect(by['Color'].kind).toBe('enum');
    expect(by['Color.RED'].kind).toBe('enum_member');
    expect(by['Color.GREEN'].signature).toBe('GREEN("g")');
    expect(by['Color.Color'].kind).toBe('constructor');
    expect(by['Point'].kind).toBe('class');
    expect(by['Point'].meta).toEqual({ record: true });
    expect(by['Point.x'].kind).toBe('field');
    expect(by['Point.x'].declaredType).toBe('int');
    expect(by['Point.dist'].kind).toBe('method');
    expect(by['Marker'].kind).toBe('interface');
    expect(by['Marker'].meta).toEqual({ annotation: true });
    expect(by['Marker.value'].kind).toBe('method');
    // tests
    expect(by['UserRepoTest.findsUser'].kind).toBe('test');
  });

  it('extracts Spring and JAX-RS routes with class-level prefixes', async () => {
    const ir = (await extractFile(PATH, src))!;
    const routes = ir.definitions.filter((d) => d.kind === 'route').map((d) => [d.name, d.meta?.handler]);
    expect(routes).toEqual([
      ['GET /api/users/{id}', 'getUser'],
      ['POST /api/users', 'createUser'],
      ['DELETE /api/users/{id}', 'deleteUser'],
      ['GET /api/legacy', 'legacy'],
    ]);
    expect(ir.definitions.find((d) => d.kind === 'route')?.parent).toBe(-1);
  });

  it('extracts imports', async () => {
    const ir = (await extractFile(PATH, src))!;
    expect(ir.imports.find((i) => i.source === 'com.acme.util.Strings')).toMatchObject({ names: [{ name: 'Strings', alias: 'Strings' }], namespace: false });
    expect(ir.imports.find((i) => i.source === 'java.util')).toMatchObject({ names: [], namespace: true, alias: '' });
    expect(ir.imports.find((i) => i.source === 'java.util.Collections')).toMatchObject({ names: [{ name: 'emptyList', alias: 'emptyList' }] });
  });

  it('extracts calls, constructor calls, decorators, type refs, receiver facts and config reads', async () => {
    const ir = (await extractFile(PATH, src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    const find = by['UserRepo.find'].ordinal;
    const refs = ir.references;
    const has = (kind: string, name: string, qualifier = '') => refs.some((r) => r.kind === kind && r.name === name && r.qualifier === qualifier);
    expect(has('call', 'get', 'session')).toBe(true);
    expect(has('call', 'normalize')).toBe(true);
    expect(has('call', 'split', 'Strings')).toBe(true);
    expect(refs.find((r) => r.kind === 'call' && r.name === 'get' && r.qualifier === 'session')).toMatchObject({ scope: find, arity: 1, line: 53 });
    expect(refs.find((r) => r.kind === 'new' && r.name === 'Validator')).toMatchObject({ arity: 1 });
    expect(has('new', 'User')).toBe(true); // User::new
    expect(has('new', 'UserRepo')).toBe(true);
    expect(has('decorator', 'Service')).toBe(true);
    expect(has('decorator', 'GetMapping')).toBe(true);
    expect(has('type', 'NotFoundException')).toBe(true);
    expect(has('type', 'Strings')).toBe(true);
    expect(has('value', 'strings', 'this')).toBe(true);
    expect(has('config', 'API_TOKEN')).toBe(true);
    // supertypes are emitted by the walker as extends/implements refs
    expect(has('extends', 'BaseRepo')).toBe(true);
    expect(has('implements', 'Repository')).toBe(true);
    // no duplicate type ref for the `new Cache()` type
    expect(refs.filter((r) => r.line === 20 && r.name === 'Cache').map((r) => r.kind).sort()).toEqual(['new', 'type']);
    // local type facts: params, locals, fields
    const lt = ir.localTypes;
    expect(lt.some((t) => t.name === 'id' && t.type === 'String' && t.scope === find)).toBe(true);
    expect(lt.some((t) => t.name === 'v' && t.type === 'Validator' && t.scope === find)).toBe(true);
    expect(lt.some((t) => t.name === 'all' && t.type === 'List')).toBe(true);
    expect(lt.some((t) => t.name === 'cache' && t.type === 'Cache' && t.via === 'field' && t.scope === by['BaseRepo'].ordinal)).toBe(true);
    expect(lt.filter((t) => t.name === 'x' && t.type === 'int')).toHaveLength(1);
  });

  it('flags test files and resolves JVM imports against source roots', () => {
    expect(java.isTestFile!('src/test/java/com/acme/FooTest.java')).toBe(true);
    expect(java.isTestFile!('lib/FooIT.java')).toBe(true);
    expect(java.isTestFile!('src/main/java/com/acme/Foo.java')).toBe(false);
    const project = { hasFile: () => false, jvmRoots: ['other/src/main/java', 'src/main/java', 'src/test/java'] };
    const imp = { source: 'com.acme.util.Strings', names: [{ name: 'Strings', alias: 'Strings' }], namespace: false, alias: '', kind: 'static' as const, line: 1 };
    const c = java.resolveModule('com.acme.util.Strings', 'src/test/java/com/acme/users/UserRepoTest.java', imp, project);
    // closest root first, own language first, other-module roots later, bare package path last
    expect(c[0]).toBe('src/test/java/com/acme/util/Strings.java');
    expect(c[1]).toBe('src/test/java/com/acme/util/Strings.kt');
    const main = c.indexOf('src/main/java/com/acme/util/Strings.java');
    expect(main).toBeGreaterThan(0);
    expect(main).toBeLessThan(c.indexOf('other/src/main/java/com/acme/util/Strings.java'));
    expect(c.indexOf('other/src/main/java/com/acme/util/Strings.kt')).toBeLessThan(c.indexOf('com/acme/util/Strings.java'));
    // nested type import falls back to the outer type's file
    expect(java.resolveModule('com.acme.Outer.Inner', 'A.java', { ...imp, source: 'com.acme.Outer.Inner' }, project)).toContain('src/main/java/com/acme/Outer.java');
    // wildcard imports point at a package index that will not exist
    expect(java.resolveModule('com.acme.util', 'A.java', { ...imp, source: 'com.acme.util', names: [], namespace: true }, project)[0]).toMatch(/\/com\/acme\/util\/index\.java$/);
  });
});
