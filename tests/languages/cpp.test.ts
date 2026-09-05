import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { cpp } from '../../src/languages/cpp.js';

registerLanguage(cpp);

const header = readFileSync(new URL('../fixtures/cpp/sample.hpp', import.meta.url), 'utf8');
const source = readFileSync(new URL('../fixtures/cpp/sample.cpp', import.meta.url), 'utf8');

describe('cpp extractor', () => {
  it('extracts namespaces, classes, access levels, templates and aliases from headers', async () => {
    const ir = (await extractFile('include/sample.hpp', header))!;
    expect(ir.errorPct).toBe(0);
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['acme'].kind).toBe('namespace');
    expect(by['acme.db'].kind).toBe('namespace');
    expect(by['acme.db.Repo'].kind).toBe('class');
    expect(by['acme.db.Repo'].doc).toBe('Base repository.');
    expect(by['acme.db.Repo'].supertypes).toEqual([
      { name: 'Entity', kind: 'extends' },
      { name: 'Serializable', kind: 'extends' },
    ]);
    expect(by['acme.db.Repo.Repo'].kind).toBe('constructor');
    expect(by['acme.db.Repo.Repo'].meta?.prototype).toBe(true);
    expect(by['acme.db.Repo.Repo'].modifiers).toEqual(['explicit', 'public', 'declaration']);
    expect(by['acme.db.Repo.~Repo'].kind).toBe('method');
    expect(by['acme.db.Repo.find'].kind).toBe('method');
    expect(by['acme.db.Repo.find'].modifiers).toEqual(['virtual', 'const', 'abstract', 'public', 'declaration']);
    expect(by['acme.db.Repo.find'].signature).toBe('virtual User find(int id) const = 0');
    expect(by['acme.db.Repo.count'].modifiers).toContain('static');
    expect(by['acme.db.Repo.name_'].kind).toBe('field');
    expect(by['acme.db.Repo.name_'].declaredType).toBe('string');
    expect(by['acme.db.Repo.name_'].modifiers).toEqual(['protected']);
    expect(by['acme.db.Repo.cache_'].declaredType).toBe('Cache'); // std::unique_ptr<Cache> unwrapped
    expect(by['acme.db.Repo.hidden_'].exported).toBe(false);
    expect(by['acme.db.Repo.hidden_'].declaredType).toBe('int');
    expect(by['acme.db.Repo.Inspector']).toBeUndefined(); // friend
    expect(by['acme.db.Point'].kind).toBe('struct');
    expect(by['acme.db.Point.x'].modifiers).toEqual(['public']);
    expect(by['acme.db.Color'].kind).toBe('enum');
    expect(by['acme.db.Color'].meta?.scoped).toBe(true);
    expect(by['acme.db.Color.Red'].kind).toBe('enum_member');
    expect(by['acme.db.Legacy'].meta).toBeUndefined();
    expect(by['acme.db.Box'].kind).toBe('class');
    expect(by['acme.db.Box'].signature).toBe('template <typename T> class Box');
    expect(by['acme.db.Box.value'].kind).toBe('field');
    expect(by['acme.db.Box.get'].kind).toBe('method');
    expect(by['acme.db.Box.get'].modifiers).toEqual(['const', 'public']);
    expect(by['acme.db.clamp'].kind).toBe('function');
    expect(by['acme.db.clamp'].meta?.prototype).toBe(true);
    expect(by['acme.db.clamp'].signature).toBe('template <typename T> T clamp(T v, T lo, T hi)');
    expect(by['acme.db.UserPtr'].kind).toBe('type_alias');
    expect(by['acme.db.UserPtr'].declaredType).toBe('User');
    expect(by['acme.db.Id'].kind).toBe('type_alias');
    // qualified type refs carry their namespace as qualifier
    expect(ir.references.some((r) => r.kind === 'type' && r.name === 'string' && r.qualifier === 'std')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'type' && r.name === 'Cache' && r.line === 20)).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'cache_' && t.type === 'Cache' && t.via === 'field')).toBe(true);
  });

  it('extracts out-of-class definitions, namespace blocks, tests and includes', async () => {
    const ir = (await extractFile('src/sample.cpp', source))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['acme.db'].kind).toBe('namespace');
    expect(by['acme.db.Repo.Repo'].kind).toBe('constructor');
    expect(by['acme.db.Repo.Repo'].parent).toBe(by['acme.db'].ordinal);
    expect(by['acme.db.Repo.~Repo'].kind).toBe('method');
    expect(by['acme.db.Repo.save'].kind).toBe('method');
    expect(by['acme.db.Repo.save'].doc).toBe('Saves a user.');
    expect(by['acme.db.Repo.save'].signature).toBe('void Repo::save(const User& u)');
    expect(by['acme.db.Repo.save'].meta).toBeUndefined();
    expect(by['acme.db.Repo.count'].kind).toBe('method');
    expect(by['acme.db.helper2'].exported).toBe(false);
    expect(by['acme.db.globalCounter'].kind).toBe('variable');
    expect(by['acme.db.kLimit'].kind).toBe('constant');
    expect(by['main'].kind).toBe('function');
    const tests = ir.definitions.filter((d) => d.kind === 'test');
    expect(tests.map((t) => t.name)).toEqual(['RepoTest.SavesUser', 'RepoFixture.Finds', 'repo counts']);
    expect(tests[0]!.meta?.framework).toBe('gtest');
    expect(tests[0]!.signature).toBe('TEST(RepoTest, SavesUser)');
    expect(tests[0]!.range).toMatchObject({ startLine: 41, endLine: 44 });
    expect(tests[2]!.meta?.framework).toBe('catch2');
    // references inside test bodies are attributed to the test scope
    expect(ir.references.some((r) => r.kind === 'call' && r.qualifier === 'Repo' && r.name === 'count' && r.scope === tests[0]!.ordinal)).toBe(true);
    expect(ir.references.some((r) => r.kind === 'call' && r.name === 'REQUIRE' && r.scope === tests[2]!.ordinal)).toBe(true);
    expect(ir.references.some((r) => r.kind === 'call' && r.name === 'TEST_CASE')).toBe(false);

    const imp = Object.fromEntries(ir.imports.map((i) => [i.source, i]));
    expect(imp['sample.hpp'].namespace).toBe(true);
    expect(imp['cstdlib'].namespace).toBe(false);
    expect(imp['acme::db']).toMatchObject({ namespace: true, names: [] });
    expect(imp['std'].names).toEqual([{ name: 'string', alias: 'string' }]);
    expect(cpp.resolveModule('sample.hpp', 'src/sample.cpp', imp['sample.hpp'], { hasFile: () => false })).toContain('include/sample.hpp');
    expect(cpp.resolveModule('acme::db', 'src/sample.cpp', imp['acme::db'], { hasFile: () => false })).toEqual([]); // namespaces are not files
  });

  it('extracts calls, constructor refs, smart pointers and local type facts', async () => {
    const ir = (await extractFile('src/sample.cpp', source))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    const save = by['acme.db.Repo.save'].ordinal;
    const refs = ir.references.filter((r) => r.scope === save);
    const news = refs.filter((r) => r.kind === 'new').map((r) => `${r.line}:${r.name}/${r.arity}`);
    expect(news).toEqual(['15:Cache/0', '16:Cache/0', '17:Cache/0', '18:Session/1', '19:User/1']);
    expect(refs.some((r) => r.kind === 'call' && r.qualifier === 'c' && r.name === 'warm')).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.qualifier === 'cache_' && r.name === 'store' && r.arity === 1)).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.qualifier === 'std' && r.name === 'getenv')).toBe(true);
    expect(refs.some((r) => r.kind === 'config' && r.name === 'HOME')).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.qualifier === '' && r.name === 'count')).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.qualifier === 'acme.util' && r.name === 'log')).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.name === 'helper' && r.arity === 1)).toBe(true);
    // `Session sess(name_)` must not produce a bogus type ref for `name_`
    expect(refs.some((r) => r.kind === 'type' && r.name === 'name_')).toBe(false);
    const lt = ir.localTypes.filter((t) => t.scope === save);
    expect(lt).toEqual(
      expect.arrayContaining([
        { name: 'u', type: 'User', via: 'annotation', scope: save },
        { name: 'c', type: 'Cache', via: 'new', scope: save },
        { name: 'local', type: 'Cache', via: 'annotation', scope: save },
        { name: 'raw', type: 'Cache', via: 'annotation', scope: save },
        { name: 'sess', type: 'Session', via: 'annotation', scope: save },
        { name: 'copy', type: 'User', via: 'annotation', scope: save },
      ]),
    );
    expect(ir.localTypes.some((t) => t.name === 'r' && t.type === 'Repo')).toBe(true);
  });

  it('handles auto initialisers, enum class bases, final classes and template member definitions', async () => {
    const src = 'class Foo final : public Bar<int>, ns::Baz { public: Foo& operator+(const Foo&); };\nvoid f() { auto a = Cache{}; auto b = Cache(1); auto s = std::make_shared<Cache>(); Box<int> bx; }\ntemplate <typename T> void Box<T>::put(T v) {}\nextern "C" { void cfun(); }\n';
    const ir = (await extractFile('src/y.cpp', src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['Foo'].modifiers).toEqual(['final']);
    expect(by['Foo'].supertypes).toEqual([
      { name: 'Bar', kind: 'extends' },
      { name: 'ns.Baz', kind: 'extends' },
    ]);
    expect(by['Foo.operator+'].kind).toBe('method');
    expect(by['Box.put'].kind).toBe('method');
    expect(by['Box.put'].signature).toBe('template <typename T> void Box<T>::put(T v)');
    expect(by['cfun'].meta?.prototype).toBe(true);
    const f = by['f'].ordinal;
    const lt = ir.localTypes.filter((t) => t.scope === f).map((t) => `${t.name}:${t.type}:${t.via}`);
    expect(lt).toEqual(['a:Cache:new', 'b:Cache:constructor_call', 's:Cache:new', 'bx:Box:annotation']);
    expect(ir.references.filter((r) => r.kind === 'new' && r.scope === f).map((r) => r.name)).toEqual(['Cache', 'Cache', 'Cache']);
  });

  it('detects test files', () => {
    expect(cpp.isTestFile!('tests/foo.cpp')).toBe(true);
    expect(cpp.isTestFile!('src/foo_test.cc')).toBe(true);
    expect(cpp.isTestFile!('src/FooTests.cpp')).toBe(true);
    expect(cpp.isTestFile!('src/foo.cpp')).toBe(false);
  });
});
