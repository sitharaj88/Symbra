import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { scala } from '../../src/languages/scala.js';

registerLanguage(scala);

const src = readFileSync(new URL('../fixtures/scala/sample.scala', import.meta.url), 'utf8');
const PATH = 'src/main/scala/com/acme/users/Sample.scala';

describe('scala extractor', () => {
  it('extracts definitions with kinds, ranges, docs and signatures', async () => {
    const ir = (await extractFile(PATH, src))!;
    expect(ir.errorPct).toBe(0);
    expect(ir.doc).toBe('Sample Scala file for extractor tests.');
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['BaseRepo'].kind).toBe('class');
    expect(by['BaseRepo'].doc).toBe('Base repository.');
    expect(by['BaseRepo'].modifiers).toEqual(['abstract']);
    expect(by['BaseRepo'].signature).toBe('abstract class BaseRepo[T](protected val session: Session) extends Repository[T] with Closeable');
    expect(by['BaseRepo'].supertypes).toEqual([
      { name: 'Repository[T]', kind: 'extends' },
      { name: 'Closeable', kind: 'implements' },
    ]);
    expect(by['BaseRepo'].range).toMatchObject({ startLine: 13, endLine: 21 });
    expect(by['UserRepo'].supertypes).toEqual([{ name: 'BaseRepo[User]', kind: 'extends' }]);
    expect(by['Repository'].kind).toBe('trait');
    expect(by['Repository'].supertypes).toEqual([{ name: 'AutoCloseable', kind: 'extends' }]);
    expect(by['User'].kind).toBe('class');
    expect(by['User'].meta).toEqual({ case: true });
    expect(by['User'].signature).toBe('case class User(id: String, name: String)');
    expect(by['User.id'].kind).toBe('field'); // case-class params are public vals
    expect(by['User.id'].declaredType).toBe('String');
    expect(by['UserRepo.session']).toBeUndefined(); // plain constructor param
    expect(by['BaseRepo.session'].kind).toBe('field');
    expect(by['Registry'].kind).toBe('class');
    expect(by['Registry'].meta).toEqual({ object: true });
    expect(by['Registry'].supertypes).toEqual([{ name: 'Repository[User]', kind: 'extends' }]);
    // members
    expect(by['BaseRepo.cache'].kind).toBe('field');
    expect(by['BaseRepo.cache'].declaredType).toBe('Cache');
    expect(by['BaseRepo.cache'].exported).toBe(false);
    expect(by['BaseRepo.MAX_RETRIES'].kind).toBe('constant');
    expect(by['UserRepo.count'].kind).toBe('field');
    expect(by['UserRepo.count'].modifiers).toEqual(['var']);
    expect(by['BaseRepo.find'].kind).toBe('method'); // abstract declaration
    expect(by['BaseRepo.find'].signature).toBe('def find(id: String): Option[T]');
    expect(by['BaseRepo.find'].doc).toBe('Find one by id.');
    expect(by['BaseRepo.close'].signature).toBe('override def close(): Unit');
    expect(by['UserRepo.find'].modifiers).toEqual(['override']);
    expect(by['UserRepo.find'].declaredType).toBe('Option');
    expect(by['UserRepo.find'].range).toMatchObject({ startLine: 27, endLine: 35 });
    expect(by['UserRepo.normalize'].exported).toBe(false);
    expect(by['Registry.users'].kind).toBe('field');
    expect(by['Handler'].kind).toBe('type_alias');
    // ScalaTest tests
    expect(by['UserRepoSpec.finds user'].kind).toBe('test');
    expect(by['UserRepoSpec.finds user'].range).toMatchObject({ startLine: 55, endLine: 58 });
    expect(by['UserRepoWordSpec.UserRepo'].kind).toBe('test');
    expect(by['UserRepoWordSpec.UserRepo.find users'].kind).toBe('test');
    expect(by['UserRepoWordSpec.also works'].kind).toBe('test');
  });

  it('extracts imports: single, wildcard, and one import per selector', async () => {
    const ir = (await extractFile(PATH, src))!;
    expect(ir.imports.find((i) => i.source === 'com.acme.util.Strings')).toMatchObject({ names: [{ name: 'Strings', alias: 'Strings' }], namespace: false });
    expect(ir.imports.find((i) => i.source === 'com.acme.util')).toMatchObject({ names: [], namespace: true, alias: '' });
    expect(ir.imports.find((i) => i.source === 'com.acme.util.Formatter')).toMatchObject({ names: [{ name: 'Formatter', alias: 'Fmt' }] });
    expect(ir.imports.find((i) => i.source === 'com.acme.util.Parser')).toMatchObject({ names: [{ name: 'Parser', alias: 'Parser' }] });
    expect(ir.imports.find((i) => i.source === 'scala.collection.mutable')).toBeTruthy();
  });

  it('extracts calls, constructor calls, type refs, receiver facts and config reads', async () => {
    const ir = (await extractFile(PATH, src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    const find = by['UserRepo.find'].ordinal;
    const refs = ir.references;
    const has = (kind: string, name: string, qualifier = '') => refs.some((r) => r.kind === kind && r.name === name && r.qualifier === qualifier);
    expect(refs.find((r) => r.kind === 'call' && r.name === 'get' && r.qualifier === 'session')).toMatchObject({ scope: find, arity: 1, line: 28 });
    expect(has('call', 'close', 'session')).toBe(true);
    expect(has('call', 'normalize')).toBe(true);
    expect(refs.find((r) => r.kind === 'new' && r.name === 'Validator')).toMatchObject({ arity: 1 });
    expect(has('new', 'Fmt')).toBe(true); // companion apply
    expect(has('new', 'UserRepo')).toBe(true);
    expect(has('call', 'lookup', 'Registry')).toBe(true);
    expect(has('value', 'Map', 'mutable')).toBe(true);
    expect(has('type', 'Strings')).toBe(true);
    expect(has('type', 'Option')).toBe(true);
    expect(has('config', 'API_TOKEN')).toBe(true);
    expect(has('extends', 'BaseRepo')).toBe(true);
    expect(has('implements', 'Closeable')).toBe(true);
    expect(refs.some((r) => r.name === 'with')).toBe(false);
    // test-registration calls are not emitted as calls into the test body's scope twice
    expect(refs.filter((r) => r.kind === 'call' && r.name === 'test')).toHaveLength(1);
    // refs inside a test body are scoped to the test definition
    const t = by['UserRepoWordSpec.UserRepo.find users'].ordinal;
    expect(refs.find((r) => r.line === 65)).toMatchObject({ scope: t, name: 'find', qualifier: 'repo' });
    const lt = ir.localTypes;
    expect(lt.some((t) => t.name === 'id' && t.type === 'String' && t.scope === find)).toBe(true);
    expect(lt.some((t) => t.name === 'v' && t.type === 'Validator' && t.via === 'new' && t.scope === find)).toBe(true);
    expect(lt.some((t) => t.name === 'session' && t.type === 'Session' && t.scope === by['UserRepo'].ordinal)).toBe(true);
    expect(lt.some((t) => t.name === 'cache' && t.type === 'Cache' && t.via === 'field' && t.scope === by['BaseRepo'].ordinal)).toBe(true);
  });

  it('flags test files and resolves imports against JVM roots', () => {
    expect(scala.isTestFile!('src/test/scala/com/acme/FooSpec.scala')).toBe(true);
    expect(scala.isTestFile!('lib/FooSpec.scala')).toBe(true);
    expect(scala.isTestFile!('src/main/scala/com/acme/Foo.scala')).toBe(false);
    const imp = { source: 'com.acme.util.Strings', names: [{ name: 'Strings', alias: 'Strings' }], namespace: false, alias: '', kind: 'static' as const, line: 1 };
    const c = scala.resolveModule('com.acme.util.Strings', 'src/main/scala/com/acme/users/UserRepo.scala', imp, { hasFile: () => false, jvmRoots: ['src/main/scala'] });
    expect(c[0]).toBe('src/main/scala/com/acme/util/Strings.scala');
    // relative `import Foo._` also tries the importing file's directory
    const rel = scala.resolveModule('Foo', 'src/main/scala/com/acme/users/UserRepo.scala', { ...imp, source: 'Foo', names: [], namespace: true }, { hasFile: () => false, jvmRoots: [] });
    expect(rel).toContain('src/main/scala/com/acme/users/Foo.scala');
  });
});
