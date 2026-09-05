import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { lua } from '../../src/languages/lua.js';

registerLanguage(lua);
const src = readFileSync(new URL('../fixtures/lua/sample.lua', import.meta.url), 'utf8');

describe('lua extractor', () => {
  it('extracts module tables, functions, methods and tests', async () => {
    const ir = (await extractFile('lua/app/sample.lua', src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(ir.doc).toBe('Sample module.');
    expect(by['M'].kind).toBe('variable');
    expect(by['MAX_RETRIES'].kind).toBe('constant');
    expect(by['MAX_RETRIES'].exported).toBe(false);
    expect(by['COUNT'].exported).toBe(true);
    expect(by['M.add'].kind).toBe('method');
    expect(by['M.add'].doc).toBe('Adds two numbers.\n@param a number');
    expect(by['M.add'].signature).toBe('function M.add(a, b)');
    expect(by['M.reset'].meta?.self).toBe(true);
    expect(by['M.sub'].kind).toBe('method');
    expect(by['M.PI'].kind).toBe('constant');
    expect(by['helper'].kind).toBe('function');
    expect(by['helper'].exported).toBe(false);
    expect(by['helper'].doc).toBe('Local helper.');
    expect(by['globalFn'].exported).toBe(true);
    expect(by['Widget.new'].kind).toBe('method');
    expect(by['Widget.draw'].kind).toBe('method');
    expect(by['Widget.__index']).toBeUndefined();
    expect(ir.definitions.filter((d) => d.kind === 'test').map((d) => d.name)).toEqual(['describe M', 'it adds']);
  });
  it('extracts require imports and resolves dotted module names', async () => {
    const ir = (await extractFile('lua/app/sample.lua', src))!;
    expect(ir.imports.find((i) => i.source === 'app.util')).toMatchObject({ namespace: true, alias: 'util' });
    expect(ir.imports.find((i) => i.source === 'cjson')).toMatchObject({ namespace: true, alias: 'json' });
    const cands = lua.resolveModule('app.util', 'lua/app/sample.lua', ir.imports[0]!, { hasFile: () => true });
    expect(cands).toContain('app/util.lua');
    expect(cands).toContain('lua/app/util.lua');
    expect(cands).toContain('app/util/init.lua');
  });
  it('extracts calls with qualifiers and receiver facts', async () => {
    const ir = (await extractFile('lua/app/sample.lua', src))!;
    const calls = ir.references.filter((r) => r.kind === 'call' || r.kind === 'new');
    expect(calls.some((c) => c.name === 'clamp' && c.qualifier === 'util' && c.arity === 3)).toBe(true);
    expect(calls.some((c) => c.name === 'helper' && c.qualifier === '' && c.arity === 1)).toBe(true);
    expect(calls.some((c) => c.name === 'encode' && c.qualifier === 'json')).toBe(true);
    expect(calls.some((c) => c.name === 'reset' && c.qualifier === 'M')).toBe(true);
    expect(calls.some((c) => c.name === 'draw' && c.qualifier === 'obj')).toBe(true);
    expect(calls.some((c) => c.name === 'require' || c.name === 'setmetatable')).toBe(false);
    expect(ir.localTypes.some((t) => t.name === 'obj' && t.type === 'Widget' && t.via === 'constructor_call')).toBe(true);
  });
});
