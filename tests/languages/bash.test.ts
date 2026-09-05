import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { bash } from '../../src/languages/bash.js';

registerLanguage(bash);
const src = readFileSync(new URL('../fixtures/bash/sample.sh', import.meta.url), 'utf8');

describe('bash extractor', () => {
  it('extracts functions and top-level variables', async () => {
    const ir = (await extractFile('scripts/sample.sh', src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(ir.doc).toBe('Sample script.');
    expect(by['log'].kind).toBe('function');
    expect(by['log'].doc).toBe('Logs a message.');
    expect(by['fetch_user'].kind).toBe('function');
    expect(by['fetch_user'].range.startLine).toBe(22);
    expect(by['API_TOKEN'].kind).toBe('constant');
    expect(by['API_TOKEN'].modifiers).toContain('export');
    expect(by['API_TOKEN'].doc).toBe('Global config.');
    expect(by['MAX_RETRIES'].modifiers).toContain('readonly');
    expect(by['LOG_LEVEL'].kind).toBe('constant');
    expect(by['FOO'].modifiers).toContain('readonly');
    expect(by['local_thing'].kind).toBe('variable');
    // `local` declarations inside functions are not definitions
    expect(by['id']).toBeUndefined();
    expect(by['name']).toBeUndefined();
  });
  it('extracts source imports and resolves them relative to the script', async () => {
    const ir = (await extractFile('scripts/sample.sh', src))!;
    expect(ir.imports.map((i) => i.source)).toEqual(['./lib/common.sh', 'helpers.sh', 'lib/other.sh']);
    expect(ir.imports[1]!.kind).toBe('dynamic');
    expect(bash.resolveModule('./lib/common.sh', 'scripts/sample.sh', ir.imports[0]!, { hasFile: () => true })).toEqual(['scripts/lib/common.sh', 'lib/common.sh']);
    expect(bash.resolveModule('helpers.sh', 'scripts/sample.sh', ir.imports[1]!, { hasFile: () => true })[0]).toBe('scripts/helpers.sh');
  });
  it('extracts command calls and env reads', async () => {
    const ir = (await extractFile('scripts/sample.sh', src))!;
    const calls = ir.references.filter((r) => r.kind === 'call');
    expect(calls.some((c) => c.name === 'fetch_user' && c.arity === 1 && c.scope === -1)).toBe(true);
    expect(calls.some((c) => c.name === 'get_name' && c.arity === 1)).toBe(true);
    expect(calls.some((c) => c.name === 'retry' && c.arity === 3)).toBe(true);
    expect(calls.some((c) => c.name === 'log')).toBe(true);
    // builtins / common tools are not calls
    expect(calls.some((c) => c.name === 'echo' || c.name === 'curl' || c.name === 'set')).toBe(false);
    const cfg = ir.references.filter((r) => r.kind === 'config').map((r) => r.name);
    expect(cfg).toContain('BASE_URL');
    expect(cfg).not.toContain('API_TOKEN'); // assigned in this file
    expect(cfg).not.toContain('HOME'); // shell variable
    expect(cfg).not.toContain('LOG_LEVEL');
  });
});
