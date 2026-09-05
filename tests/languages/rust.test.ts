import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { registerLanguage } from '../../src/languages/registry.js';
import { rust } from '../../src/languages/rust.js';
import { extractFile } from '../../src/index/extract.js';
import type { Import } from '../../src/ir/types.js';

registerLanguage(rust);

const src = readFileSync(new URL('../fixtures/rust/sample.rs', import.meta.url), 'utf8');
const imp: Import = { source: '', names: [], namespace: true, alias: '', kind: 'static', line: 1 };
const project = { hasFile: () => false };

describe('rust extractor', () => {
  it('extracts definitions with kinds, ranges, docs and signatures', async () => {
    const ir = (await extractFile('src/sample.rs', src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(ir.errorPct).toBe(0);
    expect(ir.doc).toBe('Sample crate module for the Rust extractor.');
    expect(by['models'].kind).toBe('namespace');
    expect(by['models.Model'].kind).toBe('struct');
    expect(by['MAX_RETRIES']).toMatchObject({ kind: 'constant', exported: true, doc: 'Maximum retries.', declaredType: 'u32' });
    expect(by['COUNTER']).toMatchObject({ kind: 'constant', exported: false, modifiers: ['static'] });
    expect(by['Id']).toMatchObject({ kind: 'type_alias', doc: 'Alias for ids.', signature: 'pub type Id = u64' });
    // structs and their impl blocks share an fqn; look the struct up by kind
    const structUser = ir.definitions.find((d) => d.kind === 'struct' && d.name === 'User')!;
    expect(structUser).toMatchObject({ exported: true, doc: 'A user.', signature: 'pub struct User' });
    expect(structUser.range).toMatchObject({ startLine: 24, endLine: 29 });
    expect(by['User.id']).toMatchObject({ kind: 'field', parent: structUser.ordinal, exported: true, doc: 'The id.', declaredType: 'Id' });
    expect(by['User.cache']).toMatchObject({ kind: 'field', exported: false, declaredType: 'Cache' });
    expect(ir.definitions.find((d) => d.kind === 'struct' && d.name === 'Cache')?.signature).toBe('pub struct Cache(HashMap<String, String>)');
    expect(by['Role']).toMatchObject({ kind: 'enum', doc: 'Roles.' });
    expect(by['Role.Admin']).toMatchObject({ kind: 'enum_member', doc: 'Admin role.' });
    expect(by['Role.Member'].signature).toBe('Member { level: u8 }');
    expect(by['Role.Member.level']).toBeUndefined();
    expect(by['Repo']).toMatchObject({ kind: 'trait', doc: 'Something findable.' });
    expect(by['Repo.find']).toMatchObject({ kind: 'method', doc: 'Find by id.', signature: 'fn find(&self, id: Id) -> Option<User>' });
    expect(by['Repo.find'].modifiers).toContain('abstract');
    expect(by['Repo.close'].kind).toBe('method');
    // impl blocks are class-like containers named after the type
    const implUser = ir.definitions.find((d) => d.kind === 'class' && d.name === 'User')!;
    expect(implUser.meta).toEqual({ impl: true });
    expect(implUser.signature).toBe('impl User');
    expect(implUser.range).toMatchObject({ startLine: 48, endLine: 61 });
    // Members of an `impl` block hang off the type itself when the type is defined in the same
    // file; the block symbol stays for the trait link. (`by` is keyed by fqn, and the block shares
    // the type's fqn, so look the struct up by kind.)
    const userStruct = ir.definitions.find((d) => d.kind === 'struct' && d.name === 'User')!;
    expect(by['User.new']).toMatchObject({ kind: 'method', parent: userStruct.ordinal, exported: true, doc: 'Construct a user.', signature: 'pub fn new(name: &str) -> Self' });

    expect(by['User.new'].modifiers).toContain('static');
    expect(by['User.greet'].modifiers).not.toContain('static');
    expect(by['User.save'].exported).toBe(false);
    const implRepo = ir.definitions.find((d) => d.kind === 'class' && d.name === 'Cache')!;
    expect(implRepo.meta).toEqual({ impl: true, trait: 'Repo' });
    expect(implRepo.supertypes).toContainEqual({ name: 'Repo', kind: 'implements' });
    expect(by['Cache.find']).toMatchObject({ kind: 'method', parent: ir.definitions.find((d) => d.kind === 'struct' && d.name === 'Cache')!.ordinal, exported: true });
    expect(ir.definitions.find((d) => d.kind === 'class' && d.name === 'Wrapper')?.signature).toBe('impl<T: Clone> Ser for Wrapper<T>');
    expect(by['map_all']).toMatchObject({ kind: 'function', exported: true, doc: 'Generic map.' });
    expect(by['helper'].modifiers).toEqual(['async']);
    expect(by['helper'].signature).toBe('pub async fn helper(id: Id) -> Result<(), Box<dyn std::error::Error>>');
    expect(by['square']).toMatchObject({ kind: 'macro', signature: 'macro_rules! square' });
    expect(by['greet_works'].kind).toBe('test');
    expect(by['greet_works'].range.startLine).toBe(99);
    expect(by['tests'].kind).toBe('test');
    expect(by['tests.find_works'].kind).toBe('test');
  });

  it('extracts use declarations, mod declarations and path imports', async () => {
    const ir = (await extractFile('src/sample.rs', src))!;
    expect(ir.imports).toContainEqual({ source: 'std::collections', names: [{ name: 'HashMap', alias: 'HashMap' }], namespace: false, alias: '', kind: 'static', line: 3 });
    expect(ir.imports).toContainEqual({ source: 'std::env', names: [], namespace: true, alias: 'env', kind: 'static', line: 4 });
    expect(ir.imports).toContainEqual({ source: 'crate::store', names: [{ name: 'Store', alias: 'Store' }], namespace: false, alias: '', kind: 'static', line: 5 });
    expect(ir.imports).toContainEqual({ source: 'crate::store', names: [{ name: 'open', alias: 'open_store' }], namespace: false, alias: '', kind: 'static', line: 5 });
    expect(ir.imports).toContainEqual({ source: 'super::util', names: [], namespace: true, alias: '', kind: 'static', line: 6 });
    expect(ir.imports).toContainEqual({ source: 'serde', names: [{ name: 'Serialize', alias: 'Ser' }], namespace: false, alias: '', kind: 'static', line: 7 });
    expect(ir.imports).toContainEqual({ source: 'mod:config', names: [], namespace: true, alias: 'config', kind: 'static', line: 9 });
    // `crate::util::helper(id)` binds the path as a module alias for the resolver
    expect(ir.imports).toContainEqual({ source: 'crate::util', names: [], namespace: true, alias: 'crate.util', kind: 'static', line: 72 });
  });

  it('extracts calls, struct literals, type refs, receiver types and config reads', async () => {
    const ir = (await extractFile('src/sample.rs', src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    const calls = ir.references.filter((r) => r.kind === 'call');
    expect(calls.some((c) => c.qualifier === 'self' && c.name === 'save' && c.scope === by['User.greet'].ordinal)).toBe(true);
    expect(calls.some((c) => c.qualifier === 'User' && c.name === 'new' && c.arity === 1)).toBe(true);
    expect(calls.some((c) => c.qualifier === 'store.Service' && c.name === 'new')).toBe(true);
    expect(calls.some((c) => c.qualifier === 'crate.util' && c.name === 'helper' && c.arity === 1)).toBe(true);
    expect(calls.some((c) => c.qualifier === 'other' && c.name === 'greet')).toBe(true);
    expect(calls.some((c) => c.qualifier === '' && c.name === 'open_store')).toBe(true);
    expect(calls.some((c) => c.name === 'format' && c.line === 57)).toBe(true);
    // calls inside macro token trees
    expect(calls.some((c) => c.qualifier === 'u' && c.name === 'greet' && c.line === 101)).toBe(true);
    expect(calls.some((c) => c.qualifier === 'c' && c.name === 'find' && c.scope === by['tests.find_works'].ordinal)).toBe(true);
    const news = ir.references.filter((r) => r.kind === 'new');
    expect(news.some((n) => n.name === 'User' && n.line === 52)).toBe(true);
    expect(news.some((n) => n.name === 'User' && n.line === 67 && n.arity === 3)).toBe(true);
    const types = ir.references.filter((r) => r.kind === 'type');
    expect(types.some((t) => t.name === 'Error' && t.qualifier === 'std.error')).toBe(true);
    expect(types.some((t) => t.name === 'u32' || t.name === 'Self')).toBe(false);
    expect(ir.references.some((r) => r.kind === 'implements' && r.name === 'Repo')).toBe(true);
    expect(ir.references.filter((r) => r.kind === 'decorator').map((r) => r.name)).toEqual(['Debug', 'Clone']);
    expect(ir.references.filter((r) => r.kind === 'config').map((r) => r.name)).toEqual(['API_TOKEN', 'DEBUG', 'HOME']);

    const lt = ir.localTypes;
    expect(lt.some((t) => t.name === 'store' && t.type === 'Store' && t.via === 'annotation' && t.scope === by['Cache.find'].ordinal)).toBe(true);
    expect(lt.some((t) => t.name === 'user' && t.type === 'User' && t.via === 'constructor_call')).toBe(true);
    expect(lt.some((t) => t.name === 'other' && t.type === 'User' && t.via === 'new')).toBe(true);
    expect(lt.some((t) => t.name === 'svc' && t.type === 'store.Service' && t.via === 'constructor_call')).toBe(true);
    expect(lt.some((t) => t.name === 'cache' && t.type === 'Cache' && t.scope === by['User.new'].ordinal)).toBe(true);
    expect(lt.some((t) => t.name === 'id' && t.type === 'Id' && t.via === 'annotation' && t.scope === by['helper'].ordinal)).toBe(true);
  });

  it('detects test files and resolves module paths', () => {
    expect(rust.isTestFile!('tests/integration.rs')).toBe(true);
    expect(rust.isTestFile!('src/lib.rs')).toBe(false);
    expect(rust.resolveModule('mod:config', 'src/lib.rs', imp, project)).toEqual(['src/config.rs', 'src/config/mod.rs']);
    expect(rust.resolveModule('mod:sub', 'src/store.rs', imp, project)).toEqual(['src/store/sub.rs', 'src/store/sub/mod.rs']);
    expect(rust.resolveModule('crate::a::b', 'src/x/y.rs', imp, project).slice(0, 3)).toEqual(['src/a/b.rs', 'src/a/b/mod.rs', 'src/a/b/lib.rs']);
    expect(rust.resolveModule('crate::a::b', 'crates/core/src/x.rs', imp, project)).toContain('crates/core/src/a/b.rs');
    expect(rust.resolveModule('crate', 'src/x.rs', imp, project)).toContain('src/lib.rs');
    expect(rust.resolveModule('self::x', 'src/a/b.rs', imp, project)).toContain('src/a/b/x.rs');
    expect(rust.resolveModule('self::x', 'src/a/mod.rs', imp, project)).toContain('src/a/x.rs');
    expect(rust.resolveModule('super::util', 'src/a/b.rs', imp, project)).toContain('src/a/util.rs');
    expect(rust.resolveModule('super::util', 'src/a/mod.rs', imp, project)).toContain('src/util.rs');
    // src/a/b/c.rs is module a::b::c, so super::super is module a whose children live in src/a/
    expect(rust.resolveModule('super::super::util', 'src/a/b/c.rs', imp, project)).toContain('src/a/util.rs');
    expect(rust.resolveModule('super', 'src/a/b.rs', imp, project)).toContain('src/a/mod.rs');
    // 2018 uniform paths: local module, crate-root module, or workspace crate
    const uniform = rust.resolveModule('store::Service', 'src/lib.rs', imp, project);
    expect(uniform).toContain('src/store/Service.rs');
    expect(rust.resolveModule('mycrate::a', 'src/lib.rs', imp, project)).toContain('crates/mycrate/src/a.rs');
    expect(rust.resolveModule('my_crate', 'src/lib.rs', imp, project)).toContain('crates/my-crate/src/lib.rs');
  });
});
