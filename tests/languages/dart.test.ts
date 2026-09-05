import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { dart } from '../../src/languages/dart.js';

registerLanguage(dart);
const src = readFileSync(new URL('../fixtures/dart/sample.dart', import.meta.url), 'utf8');

describe('dart extractor', () => {
  it('extracts classes, mixins, enums, extensions, members and tests', async () => {
    const ir = (await extractFile('lib/sample.dart', src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['BaseRepo'].kind).toBe('class');
    expect(by['BaseRepo'].modifiers).toContain('abstract');
    expect(by['BaseRepo'].doc).toBe('Base repository.');
    expect(by['BaseRepo'].supertypes).toEqual([{ name: 'Disposable', kind: 'implements' }]);
    expect(by['BaseRepo.load'].modifiers).toContain('abstract');
    expect(by['Loggable'].kind).toBe('trait');
    expect(by['Loggable.log'].kind).toBe('method');
    expect(by['UserRepo'].supertypes).toEqual([
      { name: 'BaseRepo', kind: 'extends' },
      { name: 'Loggable', kind: 'implements' },
      { name: 'Repo', kind: 'implements' },
      { name: 'Other', kind: 'implements' },
    ]);
    expect(by['UserRepo.session'].kind).toBe('field');
    expect(by['UserRepo.session'].declaredType).toBe('Session');
    expect(by['UserRepo._name'].exported).toBe(false);
    expect(by['UserRepo._name'].declaredType).toBe('String');
    expect(by['UserRepo.load'].range).toMatchObject({ startLine: 32, endLine: 40 });
    expect(by['UserRepo.MAX'].modifiers).toEqual(expect.arrayContaining(['static', 'const']));
    expect(by['UserRepo.UserRepo'].kind).toBe('constructor');
    expect(by['UserRepo.UserRepo.named'].kind).toBe('constructor');
    expect(by['UserRepo.UserRepo.create'].modifiers).toContain('factory');
    expect(by['UserRepo.count'].kind).toBe('property');
    expect(by['UserRepo.load'].modifiers).toContain('override');
    expect(by['UserRepo.find'].signature).toBe('Future<User?> find(int id) async');
    expect(by['UserRepo.find'].modifiers).toContain('async');
    expect(by['Status'].kind).toBe('enum');
    expect(by['Status.pending'].kind).toBe('enum_member');
    expect(by['User.greet'].kind).toBe('method');
    expect(by['User'].meta).toEqual({ extension: true, extensionName: 'UserExt' });
    expect(by['Callback'].kind).toBe('type_alias');
    expect(by['GLOBAL_MAX'].kind).toBe('constant');
    expect(by['config'].declaredType).toBe('Config');
    expect(by['counter'].kind).toBe('variable');
    expect(by['topLevel'].kind).toBe('function');
    expect(by['main'].kind).toBe('function');
    expect(ir.definitions.filter((d) => d.kind === 'test').map((d) => d.name)).toEqual(['group UserRepo', 'test finds user']);
  });
  it('extracts imports, exports and parts', async () => {
    const ir = (await extractFile('lib/sample.dart', src))!;
    expect(ir.imports.find((i) => i.source === 'package:flutter/material.dart')).toMatchObject({ namespace: true, alias: '', names: [] });
    expect(ir.imports.find((i) => i.source === 'package:myapp/models/user.dart')).toMatchObject({ namespace: true, alias: 'models', names: [{ name: 'User', alias: 'User' }, { name: 'Session', alias: 'Session' }] });
    expect(ir.imports.find((i) => i.source === 'src/widgets.dart')?.kind).toBe('reexport');
    expect(ir.imports.find((i) => i.source === 'sample.g.dart')).toBeTruthy();
    const ctx = { hasFile: () => true };
    expect(dart.resolveModule('package:myapp/models/user.dart', 'lib/sample.dart', ir.imports[1]!, ctx)[0]).toBe('lib/models/user.dart');
    expect(dart.resolveModule('../core/base.dart', 'lib/src/sample.dart', ir.imports[3]!, ctx)).toEqual(['lib/core/base.dart']);
    expect(dart.resolveModule('dart:io', 'lib/sample.dart', ir.imports[0]!, ctx)).toEqual([]);
  });
  it('extracts calls, constructor calls, type refs, receiver facts and env reads', async () => {
    const ir = (await extractFile('lib/sample.dart', src))!;
    const calls = ir.references.filter((r) => r.kind === 'call' || r.kind === 'new');
    expect(calls.some((c) => c.kind === 'new' && c.name === 'User' && c.qualifier === '' && c.arity === 1)).toBe(true);
    expect(calls.some((c) => c.kind === 'call' && c.name === 'open' && c.qualifier === 'Session')).toBe(true);
    const load = ir.definitions.find((d) => d.fqn === 'UserRepo.load')!;
    const topLevel = ir.definitions.find((d) => d.fqn === 'topLevel')!;
    // bodies are sibling nodes of their signatures: references inside must still get the function's scope
    expect(calls.some((c) => c.name === 'get' && c.qualifier === 'session' && c.arity === 2 && c.scope === load.ordinal)).toBe(true);
    expect(calls.some((c) => c.name === 'topLevel2' && c.scope === topLevel.ordinal)).toBe(true);
    expect(calls.some((c) => c.name === '_helper' && c.qualifier === '')).toBe(true);
    expect(calls.some((c) => c.name === 'fromJson' && c.qualifier === 'models.User')).toBe(true);
    expect(calls.some((c) => c.name === 'find' && c.qualifier === 'repo')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'type' && r.name === 'UserRepo')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'u' && t.type === 'User' && t.via === 'constructor_call')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'repo' && t.type === 'UserRepo' && t.via === 'annotation')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 's')).toBe(false); // Session.open() is not a constructor
    expect(ir.references.some((r) => r.kind === 'config' && r.name === 'API_TOKEN')).toBe(true);
  });
});
