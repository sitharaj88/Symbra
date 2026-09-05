import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';

const src = readFileSync(new URL('../fixtures/javascript/sample.ts', import.meta.url), 'utf8');

describe('typescript extractor', () => {
  it('extracts classes, interfaces, methods, arrow functions and tests', async () => {
    const ir = (await extractFile('src/service.ts', src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['Greeter'].kind).toBe('interface');
    expect(by['Greeter.greet'].kind).toBe('method');
    expect(by['Base'].modifiers).toContain('abstract');
    expect(by['Base'].supertypes).toEqual([{ name: 'Greeter', kind: 'implements' }]);
    expect(by['Base.repo'].declaredType).toBe('Repo');
    expect(by['UserService'].supertypes[0]).toEqual({ name: 'Base', kind: 'extends' });
    expect(by['UserService'].doc).toBe('Concrete service.');
    expect(by['UserService.load'].modifiers).toContain('async');
    expect(by['helper'].kind).toBe('function');
    expect(by['main'].exported).toBe(true);
    expect(ir.definitions.find((d) => d.kind === 'route')?.meta?.handler).toBe('main');
    expect(ir.definitions.filter((d) => d.kind === 'test').map((d) => d.name)).toEqual(['describe UserService', 'it greets']);
  });
  it('extracts ES, type-only and CommonJS imports', async () => {
    const ir = (await extractFile('src/service.ts', src))!;
    expect(ir.imports.find((i) => i.source === './repo')?.names).toEqual([{ name: 'Repo', alias: 'Repo' }]);
    expect(ir.imports.find((i) => i.source === '../utils')).toMatchObject({ namespace: true, alias: 'utils' });
    expect(ir.imports.find((i) => i.source === './config')?.kind).toBe('type');
    expect(ir.imports.find((i) => i.source === './legacy')).toMatchObject({ namespace: true, alias: 'legacy' });
  });
  it('extracts calls with qualifiers and receiver-type facts', async () => {
    const ir = (await extractFile('src/service.ts', src))!;
    expect(ir.references.some((r) => r.kind === 'call' && r.qualifier === 'this.repo' && r.name === 'find')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'new' && r.name === 'UserService')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'config' && r.name === 'PORT')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'this.config' && t.type === 'Config')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'svc' && t.type === 'UserService')).toBe(true);
  });
});
