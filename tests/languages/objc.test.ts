import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { objc } from '../../src/languages/objc.js';

registerLanguage(objc);
const src = readFileSync(new URL('../fixtures/objc/Sample.m', import.meta.url), 'utf8');
const PATH = 'Classes/Sample.m';

describe('objective-c extractor', () => {
  it('extracts interfaces, protocols, categories and members', async () => {
    const ir = (await extractFile(PATH, src))!;
    const by: Record<string, (typeof ir.definitions)[number]> = {};
    for (const d of ir.definitions) by[d.fqn] ??= d;

    expect(by['Repo'].kind).toBe('interface');
    expect(by['Repo'].doc).toBe('A repository protocol.');
    expect(by['Repo'].supertypes).toEqual([{ name: 'NSObject', kind: 'extends' }]);
    expect(by['Repo.find:'].kind).toBe('method');

    expect(by['UserRepo'].kind).toBe('class');
    expect(by['UserRepo'].doc).toBe('User repository.');
    expect(by['UserRepo'].signature).toBe('@interface UserRepo : BaseRepo <Repo, NSCopying>');
    expect(by['UserRepo'].supertypes).toEqual([
      { name: 'BaseRepo', kind: 'extends' },
      { name: 'Repo', kind: 'implements' },
      { name: 'NSCopying', kind: 'implements' },
    ]);

    // selector-named methods, `+` methods marked static
    expect(by['UserRepo.find:other:'].kind).toBe('method');
    expect(by['UserRepo.find:other:'].declaredType).toBe('User');
    expect(by['UserRepo.initWithSession:'].kind).toBe('method');
    expect(by['UserRepo.reset'].modifiers).toContain('static');

    // @property and ivars are fields, with declared types the resolver can use
    expect(by['UserRepo.name']).toMatchObject({ kind: 'field', declaredType: 'NSString' });
    expect(by['UserRepo.name'].doc).toBe('The display name.');
    expect(by['UserRepo.name'].modifiers).toEqual(['nonatomic', 'strong']);
    expect(by['UserRepo._hits']).toMatchObject({ kind: 'field', declaredType: 'NSInteger' });

    expect(by['kDefaultName'].kind).toBe('constant');
    expect(by['helperFunction'].kind).toBe('function');
  });

  it('reparents @implementation and category members onto the @interface', async () => {
    const ir = (await extractFile(PATH, src))!;
    const iface = ir.definitions.find((d) => d.kind === 'class' && d.name === 'UserRepo' && d.meta?.interface && !d.meta?.extension)!;
    const impl = ir.definitions.find((d) => d.meta?.impl === true)!;
    expect(impl.name).toBe('UserRepo');
    const category = ir.definitions.find((d) => d.meta?.category === 'Extra' && d.meta?.extension)!;
    expect(category.name).toBe('UserRepo');
    expect(category.meta?.container).toBe('UserRepo');

    // the method body defined in @implementation hangs off the @interface, not off the block
    const found = ir.definitions.filter((d) => d.name === 'find:other:' && !d.meta?.declaration);
    expect(found).toHaveLength(1);
    expect(ir.definitions[found[0]!.parent]).toBe(iface);
    const extra = ir.definitions.find((d) => d.name === 'extra' && !d.meta?.declaration)!;
    expect(ir.definitions[extra.parent]).toBe(iface);
    expect(extra.fqn).toBe('UserRepo.extra');
  });

  it('recovers NS_ENUM declarations the grammar cannot parse', async () => {
    const ir = (await extractFile(PATH, src))!;
    const status = ir.definitions.find((d) => d.kind === 'enum' && d.name === 'Status');
    expect(status).toBeTruthy();
    expect(ir.definitions.filter((d) => d.kind === 'enum_member').map((d) => d.fqn)).toEqual([
      'Status.StatusActive',
      'Status.StatusInactive',
      'Status.StatusPending',
    ]);
  });

  it('extracts imports and resolves local headers to the files next to them', async () => {
    const ir = (await extractFile(PATH, src))!;
    expect(ir.imports.map((i) => i.source)).toEqual(['BaseRepo.h', 'Foundation/Foundation.h', 'CoreData']);
    const local = ir.imports[0]!;
    const cands = objc.resolveModule(local.source, PATH, local, { hasFile: () => true });
    expect(cands).toContain('Classes/BaseRepo.h');
    expect(cands).toContain('Classes/BaseRepo.m');
    // frameworks are external
    expect(objc.resolveModule('CoreData', PATH, ir.imports[2]!, { hasFile: () => true })).toEqual([]);
  });

  it('extracts message sends, allocations, receiver facts and config reads', async () => {
    const ir = (await extractFile(PATH, src))!;
    const calls = ir.references.filter((r) => r.kind === 'call' || r.kind === 'new');
    // `[s get:ident with:b]` -> selector name, receiver qualifier, arity from the colons
    expect(calls.some((c) => c.kind === 'call' && c.name === 'get:with:' && c.qualifier === 's' && c.arity === 2)).toBe(true);
    expect(calls.some((c) => c.kind === 'call' && c.name === 'reload' && c.qualifier === 'self')).toBe(true);
    // `[[User alloc] initWithName:…]` is a construction of User plus a call of its initialiser
    expect(calls.some((c) => c.kind === 'new' && c.name === 'User')).toBe(true);
    expect(calls.some((c) => c.kind === 'call' && c.name === 'initWithName:' && c.qualifier === 'User')).toBe(true);
    expect(calls.some((c) => c.kind === 'new' && c.name === 'UserRepo')).toBe(true);
    // framework noise is dropped
    expect(calls.some((c) => c.name === 'NSLog')).toBe(false);

    expect(ir.localTypes.some((t) => t.name === 's' && t.type === 'Session')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'b' && t.type === 'NSString' && t.via === 'annotation')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'value' && r.name === 'session' && r.qualifier === 'self')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'type' && r.name === 'Session')).toBe(true);

    expect(ir.references.some((r) => r.kind === 'config' && r.name === 'API_TOKEN')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'config' && r.name === 'HOME')).toBe(true);
  });

  it('marks XCTest methods as tests', async () => {
    const ir = (await extractFile(PATH, src))!;
    const t = ir.definitions.find((d) => d.name === 'testFind')!;
    expect(t.kind).toBe('test');
    expect(t.fqn).toBe('UserRepoTests.testFind');
  });
});
