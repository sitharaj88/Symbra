import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { zig } from '../../src/languages/zig.js';

registerLanguage(zig);
const src = readFileSync(new URL('../fixtures/zig/sample.zig', import.meta.url), 'utf8');

describe('zig extractor', () => {
  it('extracts containers, functions, fields, constants and tests', async () => {
    const ir = (await extractFile('src/sample.zig', src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(ir.doc).toBe('Sample module.');
    expect(by['Allocator'].kind).toBe('type_alias');
    expect(by['MAX_RETRIES'].kind).toBe('constant');
    expect(by['MAX_RETRIES'].exported).toBe(true);
    expect(by['MAX_RETRIES'].doc).toBe('Maximum retries.');
    expect(by['MAX_RETRIES'].declaredType).toBe('u32');
    expect(by['counter'].kind).toBe('variable');
    expect(by['counter'].exported).toBe(false);
    expect(by['User'].kind).toBe('struct');
    expect(by['User'].doc).toBe('A user.');
    expect(by['User.id'].kind).toBe('field');
    expect(by['User.name'].declaredType).toBe('u8');
    expect(by['User.init'].kind).toBe('method');
    expect(by['User.init'].signature).toBe('pub fn init(id: u32) User');
    expect(by['User.greet'].exported).toBe(true);
    expect(by['Status'].kind).toBe('enum');
    expect(by['Status.active'].kind).toBe('enum_member');
    expect(by['Value'].meta?.union).toBe(true);
    expect(by['Error'].meta?.error_set).toBe(true);
    expect(by['Error.NotFound'].kind).toBe('enum_member');
    expect(by['helper'].kind).toBe('function');
    expect(by['helper'].exported).toBe(false);
    expect(by['topLevel'].modifiers).toContain('pub');
    expect(ir.definitions.filter((d) => d.kind === 'test').map((d) => d.name)).toEqual(['helper adds one', 'test:49']);
    // imports are not constants
    expect(by['std']).toBeUndefined();
  });
  it('extracts @import declarations and resolves file imports', async () => {
    const ir = (await extractFile('src/sample.zig', src))!;
    expect(ir.imports.find((i) => i.source === 'std')).toMatchObject({ namespace: true, alias: 'std' });
    expect(ir.imports.find((i) => i.source === 'util.zig')).toMatchObject({ namespace: true, alias: 'util' });
    const ctx = { hasFile: () => true };
    expect(zig.resolveModule('std', 'src/sample.zig', ir.imports[0]!, ctx)).toEqual([]);
    expect(zig.resolveModule('util.zig', 'src/sample.zig', ir.imports[1]!, ctx)[0]).toBe('src/util.zig');
    expect(zig.resolveModule('../lib/x.zig', 'src/sample.zig', ir.imports[1]!, ctx)[0]).toBe('lib/x.zig');
  });
  it('extracts calls, type refs, receiver facts and env reads', async () => {
    const ir = (await extractFile('src/sample.zig', src))!;
    const calls = ir.references.filter((r) => r.kind === 'call' || r.kind === 'new');
    expect(calls.some((c) => c.name === 'init' && c.qualifier === 'User' && c.arity === 1)).toBe(true);
    expect(calls.some((c) => c.name === 'greet' && c.qualifier === 'u')).toBe(true);
    expect(calls.some((c) => c.name === 'helper' && c.qualifier === '' && c.arity === 1)).toBe(true);
    expect(calls.some((c) => c.name === 'doThing' && c.qualifier === 'util')).toBe(true);
    expect(calls.some((c) => c.name === 'save' && c.qualifier === 'repo')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'type' && r.name === 'Repo')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'type' && r.name === 'Allocator' && r.qualifier === 'std.mem')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'u' && t.type === 'User' && t.via === 'constructor_call')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'repo' && t.type === 'Repo' && t.via === 'annotation')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'self' && t.type === 'User')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'list' && t.type === 'ArrayList')).toBe(true);
    const cfg = ir.references.filter((r) => r.kind === 'config').map((r) => r.name);
    expect(cfg).toEqual(['HOME', 'API_TOKEN']);
  });
});
