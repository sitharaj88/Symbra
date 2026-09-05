import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';

const src = readFileSync(new URL('../fixtures/python/sample.py', import.meta.url), 'utf8');

describe('python extractor', () => {
  it('extracts definitions with kinds, ranges, docs and signatures', async () => {
    const ir = (await extractFile('pkg/sample.py', src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(ir.doc).toBe('Sample module for extractor tests.');
    expect(by['BaseRepo'].kind).toBe('class');
    expect(by['BaseRepo'].doc).toBe('Base repository.');
    expect(by['UserRepo'].supertypes.map((s) => s.name)).toEqual(['BaseRepo', 'Generic']);
    expect(by['UserRepo.__init__'].kind).toBe('constructor');
    expect(by['UserRepo.size'].kind).toBe('property');
    expect(by['UserRepo.find'].signature).toContain('-> Optional[User]');
    expect(by['UserRepo.find'].range.startLine).toBe(29);
    expect(by['_normalize'].modifiers).toContain('private');
    expect(by['MAX_RETRIES'].kind).toBe('constant');
    expect(by['test_find'].kind).toBe('test');
    expect(ir.definitions.find((d) => d.kind === 'route')?.name).toBe('GET /users/{id}');
  });
  it('extracts imports with relative levels', async () => {
    const ir = (await extractFile('pkg/sample.py', src))!;
    const rel = ir.imports.find((i) => i.source === 'models');
    expect(rel?.relativeLevel).toBe(1);
    expect(rel?.names).toEqual([{ name: 'User', alias: 'User' }, { name: 'Session', alias: 'Sess' }]);
    expect(ir.imports.find((i) => i.source === 'core')?.relativeLevel).toBe(2);
    expect(ir.imports.find((i) => i.source === 'os')?.namespace).toBe(true);
  });
  it('extracts calls, receiver types and config reads', async () => {
    const ir = (await extractFile('pkg/sample.py', src))!;
    const calls = ir.references.filter((r) => r.kind === 'call' || r.kind === 'new');
    expect(calls.some((c) => c.qualifier === 'self.session' && c.name === 'get')).toBe(true);
    expect(calls.some((c) => c.name === '_normalize' && c.qualifier === '')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'session' && t.type === 'Sess')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'self.cache' && t.type === 'Cache')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'config' && r.name === 'API_TOKEN')).toBe(true);
  });
});
