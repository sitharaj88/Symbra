import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { swift } from '../../src/languages/swift.js';

registerLanguage(swift);
const src = readFileSync(new URL('../fixtures/swift/sample.swift', import.meta.url), 'utf8');

describe('swift extractor', () => {
  it('extracts types, members, extensions and tests', async () => {
    const ir = (await extractFile('Sources/App/Sample.swift', src))!;
    // first definition wins: `extension UserRepo` shares the class's fqn so its methods become `UserRepo.x`
    const by: Record<string, (typeof ir.definitions)[number]> = {};
    for (const d of ir.definitions) by[d.fqn] ??= d;
    expect(by['Repo'].kind).toBe('interface');
    expect(by['Repo'].doc).toBe('A base protocol.');
    expect(by['Repo.find'].kind).toBe('method');
    expect(by['User'].kind).toBe('struct');
    expect(by['User'].supertypes).toEqual([{ name: 'Codable', kind: 'implements' }, { name: 'Equatable', kind: 'implements' }]);
    expect(by['User.empty'].modifiers).toContain('static');
    expect(by['User.empty'].declaredType).toBe('User');
    expect(by['Status'].kind).toBe('enum');
    expect(ir.definitions.filter((d) => d.kind === 'enum_member').map((d) => d.name)).toEqual(['active', 'inactive', 'pending']);
    expect(by['UserRepo'].supertypes).toEqual([{ name: 'BaseRepo', kind: 'extends' }, { name: 'Repo', kind: 'implements' }]);
    expect(by['UserRepo'].doc).toBe('User repository.');
    expect(by['UserRepo.init'].kind).toBe('constructor');
    expect(by['UserRepo.session'].kind).toBe('field');
    expect(by['UserRepo.session'].declaredType).toBe('Session');
    expect(by['UserRepo.count'].kind).toBe('property');
    expect(by['UserRepo.find'].signature).toBe('public func find(id: Int) -> User?');
    expect(by['UserRepo.helper'].modifiers).toEqual(expect.arrayContaining(['private', 'static', 'async']));
    expect(by['UserRepo.helper'].exported).toBe(false);
    expect(by['UserRepo.extra'].kind).toBe('method');
    const ext = ir.definitions.find((d) => d.meta?.extension);
    expect(ext).toMatchObject({ kind: 'class', fqn: 'UserRepo', range: { startLine: 43 } });
    // The extension block stays (it carries the conformances), but its members are attached to the
    // type it extends, which is declared in this same file.
    expect(ir.definitions[by['UserRepo.extra'].parent]).toBe(by['UserRepo']);
    expect(by['UserMap'].kind).toBe('type_alias');
    expect(by['GLOBAL_CONST'].kind).toBe('constant');
    expect(by['mutableGlobal'].kind).toBe('variable');
    expect(by['Counter'].meta?.actor).toBe(true);
    expect(by['topLevel'].kind).toBe('function');
    expect(by['UserRepoTests.testFind'].kind).toBe('test');
  });
  it('extracts imports as module namespaces', async () => {
    const ir = (await extractFile('Sources/App/Sample.swift', src))!;
    expect(ir.imports.map((i) => i.source)).toEqual(['Foundation', 'XCTest']);
    expect(ir.imports[0]).toMatchObject({ namespace: true, alias: 'Foundation' });
    expect(swift.resolveModule('Foundation', 'Sources/App/Sample.swift', ir.imports[0]!, { hasFile: () => true })).toEqual([]);
    // An import of a target built in this repo becomes the marker the resolver expands.
    expect(swift.resolveModule('App', 'Tests/AppTests/Sample.swift', ir.imports[0]!, { hasFile: () => true, swiftTargets: new Set(['App']) })).toEqual(['swift-target:App']);
  });
  it('extracts calls, constructor calls, type refs, receiver facts and env reads', async () => {
    const ir = (await extractFile('Sources/App/Sample.swift', src))!;
    const calls = ir.references.filter((r) => r.kind === 'call' || r.kind === 'new');
    expect(calls.some((c) => c.kind === 'new' && c.name === 'User' && c.arity === 2)).toBe(true);
    expect(calls.some((c) => c.kind === 'call' && c.name === 'get' && c.qualifier === 'session' && c.arity === 2)).toBe(true);
    expect(calls.some((c) => c.name === 'helper' && c.qualifier === '')).toBe(true);
    expect(calls.some((c) => c.name === 'init' && c.qualifier === 'super')).toBe(true);
    // subscripts are not calls
    expect(calls.some((c) => c.name === 'cache')).toBe(false);
    expect(ir.references.some((r) => r.kind === 'type' && r.name === 'UserRepo')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'decorator' && r.name === 'objc')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'u' && t.type === 'User' && t.via === 'constructor_call')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'b' && t.type === 'UserRepo' && t.via === 'annotation')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'self.session' && t.type === 'Session')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'config' && r.name === 'API_TOKEN')).toBe(true);
  });

  it('emits value refs for callbacks in argument position and array literals', async () => {
    const snippet = `
      func wire() {
        register(onCreated)
        register(handler: onCreated)
        let handlers = [onCreated, onDeleted]
        register(self, nil, true)
      }
    `;
    const ir = (await extractFile('Sources/App/Wire.swift', snippet))!;
    const values = ir.references.filter((r) => r.kind === 'value');
    expect(values.some((r) => r.name === 'onCreated')).toBe(true);
    expect(values.some((r) => r.name === 'onDeleted')).toBe(true);
    // the argument label ("handler:") and self/nil/true are never emitted as value refs
    expect(values.some((r) => r.name === 'handler')).toBe(false);
    expect(values.some((r) => r.name === 'self' || r.name === 'nil' || r.name === 'true')).toBe(false);
  });
});
