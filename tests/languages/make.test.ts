import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { make, isMakefilePath } from '../../src/languages/make.js';

const src = readFileSync(new URL('../fixtures/make/build.mk', import.meta.url), 'utf8');

beforeAll(() => {
  registerLanguage(make);
});

describe('make extractor', () => {
  it('indexes targets and variables with docs and phony flags', async () => {
    const ir = (await extractFile('build.mk', src))!;
    expect(ir.language).toBe('make');
    expect(ir.doc).toBe('Build tasks for the service.');
    const by = Object.fromEntries(ir.definitions.map((d) => [d.name, d]));

    expect(by['all'].kind).toBe('function');
    expect(by['all'].doc).toBe('Build everything.');
    expect(by['all'].meta).toMatchObject({ phony: true, prerequisites: '$(BIN_DIR)/app docs' });
    expect(by['test'].doc).toBe('Run the test suite.');
    expect(by['publish'].meta).not.toHaveProperty('phony');
    expect(by['%.o'].meta).toMatchObject({ pattern: true });
    // A computed target keeps the variable reference that names it.
    expect(by['$(BIN_DIR)/app'].kind).toBe('function');
    // `.PHONY` itself is a directive, not a build step.
    expect(Object.keys(by)).not.toContain('.PHONY');

    expect(by['CC'].kind).toBe('variable');
    expect(by['BIN_DIR'].modifiers).toContain('conditional');
    expect(by['CC'].modifiers).toContain('simple');
    expect(by['VERSION'].kind).toBe('variable');
  });

  it('links targets to their prerequisites, variables and sub-makes', async () => {
    const ir = (await extractFile('build.mk', src))!;
    const ord = (name: string) => ir.definitions.find((d) => d.name === name)!.ordinal;
    expect(ir.references).toContainEqual(
      expect.objectContaining({ kind: 'value', name: '$(BIN_DIR)/app', scope: ord('all') }),
    );
    expect(ir.references).toContainEqual(expect.objectContaining({ kind: 'value', name: 'docs', scope: ord('all') }));
    expect(ir.references).toContainEqual(expect.objectContaining({ kind: 'value', name: 'all', scope: ord('test') }));
    expect(ir.references).toContainEqual(expect.objectContaining({ kind: 'value', name: 'CC', scope: ord('$(BIN_DIR)/app') }));
    // `$(MAKE) publish` is a call, `$(MAKE) -C docs html` skips the -C argument.
    expect(ir.references).toContainEqual(expect.objectContaining({ kind: 'call', name: 'publish', scope: ord('release') }));
    expect(ir.references).toContainEqual(expect.objectContaining({ kind: 'call', name: 'html', scope: ord('docs') }));
    expect(ir.references.some((r) => r.name === 'docs' && r.kind === 'call')).toBe(false);
    // An unassigned ALL-CAPS variable is read from the environment.
    expect(ir.references).toContainEqual(expect.objectContaining({ kind: 'config', name: 'DEPLOY_ENV' }));
    // `.PHONY: all test …` declares targets; it must not look like a dependency on them.
    expect(ir.references.filter((r) => r.scope === -1)).toEqual([]);
  });

  it('treats include directives as imports', async () => {
    const ir = (await extractFile('build/build.mk', src))!;
    expect(ir.imports.map((i) => i.source)).toEqual(['scripts/common.mk', 'local.mk']);
    expect(make.resolveModule('local.mk', 'build/build.mk', ir.imports[1]!, { hasFile: () => false })).toEqual([
      'build/local.mk',
      'local.mk',
    ]);
  });

  it('extracts a file named Makefile, which has no extension to key off', async () => {
    const plain = readFileSync(new URL('../fixtures/make/Makefile', import.meta.url), 'utf8');
    const ir = (await extractFile('Makefile', plain))!;
    expect(ir.language).toBe('make');
    expect(ir.definitions.map((d) => d.name)).toEqual(['help']);
    expect(ir.definitions[0]!.meta).toMatchObject({ phony: true });
  });

  it('recognises extension-less makefile names', () => {
    expect(isMakefilePath('Makefile')).toBe(true);
    expect(isMakefilePath('sub/GNUmakefile')).toBe(true);
    expect(isMakefilePath('makefile.local')).toBe(true);
    expect(isMakefilePath('src/main.c')).toBe(false);
  });
});
