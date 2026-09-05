import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { kotlin } from '../../src/languages/kotlin.js';

registerLanguage(kotlin);

const src = readFileSync(new URL('../fixtures/kotlin/sample.kt', import.meta.url), 'utf8');
const PATH = 'src/main/kotlin/com/acme/users/Sample.kt';

describe('kotlin extractor', () => {
  it('extracts definitions with kinds, ranges, docs and signatures', async () => {
    const ir = (await extractFile(PATH, src))!;
    expect(ir.errorPct).toBe(0);
    expect(ir.doc).toBe('Sample Kotlin file for extractor tests.');
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    // top-level properties
    expect(by['MAX_RETRIES'].kind).toBe('constant');
    expect(by['logger'].kind).toBe('variable');
    expect(by['logger'].declaredType).toBe('Logger');
    expect(by['counter'].declaredType).toBe('Int');
    // classes
    expect(by['BaseRepo'].kind).toBe('class');
    expect(by['BaseRepo'].doc).toBe('Base repository.');
    expect(by['BaseRepo'].modifiers).toEqual(['abstract']);
    expect(by['BaseRepo'].signature).toBe('abstract class BaseRepo<T>(protected val session: Session) : Repository<T>, Closeable');
    expect(by['BaseRepo'].supertypes).toEqual([
      { name: 'Repository<T>', kind: 'implements' },
      { name: 'Closeable', kind: 'implements' },
    ]);
    expect(by['UserRepo'].supertypes).toEqual([{ name: 'BaseRepo<User>', kind: 'extends' }]);
    expect(by['UserRepo'].range).toMatchObject({ startLine: 38, endLine: 54 });
    expect(by['Repository'].kind).toBe('interface');
    expect(by['User'].meta).toEqual({ data: true });
    expect(by['Color'].kind).toBe('enum');
    expect(by['Color.RED'].kind).toBe('enum_member');
    expect(by['Color.label'].kind).toBe('method');
    expect(by['Result'].modifiers).toEqual(['sealed']);
    expect(by['Result.Empty'].kind).toBe('class');
    expect(by['Result.Empty'].meta).toEqual({ object: true });
    expect(by['Result.Empty'].supertypes).toEqual([{ name: 'Result', kind: 'extends' }]);
    expect(by['Registry'].meta).toEqual({ object: true });
    expect(by['BaseRepo.Companion'].meta).toEqual({ companion: true });
    expect(by['BaseRepo.Companion.NAME'].kind).toBe('constant');
    expect(by['BaseRepo.Companion.create'].kind).toBe('method');
    // primary-constructor properties become fields; plain params do not
    expect(by['UserRepo.strings'].kind).toBe('field');
    expect(by['UserRepo.strings'].declaredType).toBe('Strings');
    expect(by['UserRepo.strings'].exported).toBe(false);
    expect(by['UserRepo.session']).toBeUndefined();
    expect(by['User.id'].modifiers).toContain('val');
    expect(by['User.name'].modifiers).toContain('var');
    // member properties
    expect(by['BaseRepo.cache'].kind).toBe('field');
    expect(by['BaseRepo.cache'].declaredType).toBe('Cache');
    expect(by['UserRepo.size'].kind).toBe('property');
    // functions
    expect(by['BaseRepo.find'].kind).toBe('method');
    expect(by['BaseRepo.find'].signature).toBe('abstract fun find(id: String): Optional<T>');
    expect(by['BaseRepo.find'].doc).toBe('Find one by id.');
    expect(by['BaseRepo.find'].declaredType).toBe('Optional');
    expect(by['UserRepo.find'].modifiers).toEqual(['override']);
    expect(by['UserRepo.normalize'].exported).toBe(false);
    expect(by['Registry.lookup'].declaredType).toBe('User');
    expect(by['slug'].kind).toBe('function');
    expect(by['slug'].meta).toEqual({ receiver: 'String' });
    expect(by['slug'].signature).toBe('fun String.slug(): String');
    expect(by['Handler'].kind).toBe('type_alias');
    expect(by['module'].kind).toBe('function');
    // tests
    expect(by['UserRepoTest.finds user'].kind).toBe('test');
  });

  it('extracts Spring and Ktor routes', async () => {
    const ir = (await extractFile(PATH, src))!;
    const routes = ir.definitions.filter((d) => d.kind === 'route').map((d) => [d.name, d.meta?.handler]);
    expect(routes).toEqual([
      ['GET /users/{id}', 'getUser'],
      ['POST /users', 'createUser'],
      ['GET /health', 'module'],
      ['POST /items', 'module'],
    ]);
  });

  it('extracts imports with wildcard and alias', async () => {
    const ir = (await extractFile(PATH, src))!;
    expect(ir.imports.find((i) => i.source === 'com.acme.util.Strings')).toMatchObject({ names: [{ name: 'Strings', alias: 'Strings' }], namespace: false });
    expect(ir.imports.find((i) => i.source === 'com.acme.util')).toMatchObject({ names: [], namespace: true, alias: '' });
    expect(ir.imports.find((i) => i.source === 'com.acme.util.Formatter')).toMatchObject({ names: [{ name: 'Formatter', alias: 'Fmt' }] });
  });

  it('extracts calls, constructor calls, decorators, type refs, receiver facts and config reads', async () => {
    const ir = (await extractFile(PATH, src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    const find = by['UserRepo.find'].ordinal;
    const refs = ir.references;
    const has = (kind: string, name: string, qualifier = '') => refs.some((r) => r.kind === kind && r.name === name && r.qualifier === qualifier);
    expect(refs.find((r) => r.kind === 'call' && r.name === 'get' && r.qualifier === 'session')).toMatchObject({ scope: find, arity: 1, line: 44 });
    expect(has('call', 'normalize')).toBe(true);
    expect(has('call', 'ofNullable', 'Optional')).toBe(true);
    expect(refs.find((r) => r.kind === 'new' && r.name === 'Validator')).toMatchObject({ arity: 1 });
    expect(has('new', 'Fmt')).toBe(true);
    expect(has('new', 'UserRepo')).toBe(true);
    expect(has('call', 'TODO')).toBe(true); // all-caps bare call is not a constructor
    expect(has('decorator', 'Service')).toBe(true);
    expect(has('decorator', 'GetMapping')).toBe(true);
    expect(has('decorator', 'Test')).toBe(true);
    expect(has('type', 'Optional')).toBe(true);
    expect(has('type', 'Fmt')).toBe(true);
    expect(has('config', 'API_TOKEN')).toBe(true);
    expect(has('extends', 'BaseRepo')).toBe(true);
    expect(has('implements', 'Repository')).toBe(true);
    // routing lambda: the inner call emits once, the trailing-lambda wrapper does not
    expect(refs.filter((r) => r.kind === 'call' && r.name === 'get' && r.qualifier === '')).toHaveLength(1);
    const lt = ir.localTypes;
    expect(lt.some((t) => t.name === 'id' && t.type === 'String' && t.scope === find)).toBe(true);
    expect(lt.some((t) => t.name === 'v' && t.type === 'Validator' && t.via === 'constructor_call' && t.scope === find)).toBe(true);
    expect(lt.some((t) => t.name === 'fmt' && t.type === 'Fmt' && t.via === 'annotation')).toBe(true);
    expect(lt.some((t) => t.name === 'session' && t.type === 'Session' && t.scope === by['UserRepo'].ordinal)).toBe(true);
    expect(lt.some((t) => t.name === 'cache' && t.type === 'Cache' && t.via === 'field' && t.scope === by['BaseRepo'].ordinal)).toBe(true);
  });

  it('flags test files and resolves imports against JVM roots', () => {
    expect(kotlin.isTestFile!('src/test/kotlin/com/acme/FooTest.kt')).toBe(true);
    expect(kotlin.isTestFile!('lib/FooTest.kt')).toBe(true);
    expect(kotlin.isTestFile!('src/main/kotlin/com/acme/Foo.kt')).toBe(false);
    const imp = { source: 'com.acme.util.Strings', names: [{ name: 'Strings', alias: 'Strings' }], namespace: false, alias: '', kind: 'static' as const, line: 1 };
    const c = kotlin.resolveModule('com.acme.util.Strings', 'src/main/kotlin/com/acme/users/UserRepo.kt', imp, { hasFile: () => false, jvmRoots: ['src/main/kotlin'] });
    expect(c.slice(0, 2)).toEqual(['src/main/kotlin/com/acme/util/Strings.kt', 'src/main/kotlin/com/acme/util/Strings.java']);
  });
});
