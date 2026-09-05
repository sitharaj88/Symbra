import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { c } from '../../src/languages/c.js';

registerLanguage(c);

const header = readFileSync(new URL('../fixtures/c/sample.h', import.meta.url), 'utf8');
const source = readFileSync(new URL('../fixtures/c/sample.c', import.meta.url), 'utf8');

describe('c extractor', () => {
  it('extracts header declarations: macros, structs, unions, enums, typedefs, prototypes', async () => {
    const ir = (await extractFile('include/sample.h', header))!;
    expect(ir.errorPct).toBe(0);
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['SAMPLE_H']).toBeUndefined(); // header guard is not a macro definition
    expect(by['MAX_ITEMS'].kind).toBe('macro');
    expect(by['MAX_ITEMS'].signature).toBe('#define MAX_ITEMS 10');
    expect(by['SQUARE'].kind).toBe('macro');
    expect(by['SQUARE'].meta?.function_like).toBe(true);
    expect(by['point'].kind).toBe('struct');
    expect(by['point'].doc).toBe('A point.');
    expect(by['point.x'].kind).toBe('field');
    expect(by['point.x'].declaredType).toBe('int');
    expect(by['point.x'].modifiers).toEqual([]);
    expect(by['point_t'].kind).toBe('type_alias');
    expect(by['point_t'].declaredType).toBe('point');
    expect(by['callback_fn'].kind).toBe('type_alias');
    expect(by['callback_fn'].declaredType).toBeUndefined();
    expect(by['value'].kind).toBe('struct');
    expect(by['value'].meta?.union).toBe(true);
    expect(by['color'].kind).toBe('enum');
    expect(by['color.GREEN'].kind).toBe('enum_member');
    expect(by['color.GREEN'].signature).toBe('GREEN = 2');
    expect(by['add'].kind).toBe('function');
    expect(by['add'].meta?.prototype).toBe(true);
    expect(by['add'].modifiers).toContain('declaration');
    expect(by['add'].doc).toBe('Adds two numbers.');
    expect(by['make_point'].signature).toBe('struct point *make_point(int x, int y)');
    expect(by['counter'].kind).toBe('variable');
    expect(by['counter'].meta?.extern).toBe(true);
    expect(by['LIMIT'].kind).toBe('constant');
    expect(by['LIMIT'].exported).toBe(false);
  });

  it('extracts includes and resolves quoted ones relative to the file, root and include dirs', async () => {
    const ir = (await extractFile('include/sample.h', header))!;
    const sys = ir.imports.find((i) => i.source === 'stdio.h')!;
    const local = ir.imports.find((i) => i.source === 'util/helpers.h')!;
    expect(sys.namespace).toBe(false);
    expect(local.namespace).toBe(true);
    const project = { hasFile: () => false };
    expect(c.resolveModule('stdio.h', 'include/sample.h', sys, project)).toEqual([]);
    const cands = c.resolveModule('util/helpers.h', 'include/sample.h', local, project);
    expect(cands[0]).toBe('include/util/helpers.h');
    expect(cands).toContain('util/helpers.h');
    expect(cands).toContain('src/util/helpers.h');
    const deep = c.resolveModule('../common/x.h', 'src/mod/a.c', local, project);
    expect(deep[0]).toBe('src/common/x.h');
    expect(deep).toContain('src/include/../common/x.h'.replace('src/include/../', 'src/'));
  });

  it('extracts function definitions, globals and nested declarators', async () => {
    const ir = (await extractFile('src/sample.c', source))!;
    expect(ir.errorPct).toBe(0);
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['add'].kind).toBe('function');
    expect(by['add'].meta).toBeUndefined();
    expect(by['add'].doc).toBe('Adds two numbers.');
    expect(by['make_point'].doc).toBe('Makes a point.');
    expect(by['make_point'].range).toMatchObject({ startLine: 12, endLine: 18 });
    expect(by['process'].exported).toBe(false);
    expect(by['process'].modifiers).toEqual(['static']);
    expect(by['get_handler'].kind).toBe('function'); // int (*get_handler(void))(int)
    expect(by['get_handler'].signature).toBe('int (*get_handler(void))(int)');
    expect(by['main'].kind).toBe('function');
    expect(by['counter'].kind).toBe('variable');
    expect(by['hidden'].exported).toBe(false);
    expect(by['NAME'].kind).toBe('constant');
    expect(ir.definitions.filter((d) => d.kind === 'function').map((d) => d.name)).toEqual(['add', 'make_point', 'process', 'get_handler', 'main']);
  });

  it('extracts calls, field calls, type refs, config reads and local type facts', async () => {
    const ir = (await extractFile('src/sample.c', source))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    const refs = ir.references;
    expect(refs.some((r) => r.kind === 'call' && r.name === 'add' && r.arity === 2 && r.scope === by['process'].ordinal)).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.name === 'make_point' && r.scope === by['main'].ordinal)).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.qualifier === 'pt' && r.name === 'print')).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.name === 'SQUARE')).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.name === 'cb')).toBe(true);
    expect(refs.some((r) => r.kind === 'type' && r.name === 'point' && r.line === 12)).toBe(true);
    expect(refs.some((r) => r.kind === 'type' && r.name === 'callback_fn')).toBe(true);
    expect(refs.some((r) => r.kind === 'config' && r.name === 'HOME')).toBe(true);
    expect(refs.some((r) => r.kind === 'value' && r.name === 'p' && r.line === 32)).toBe(true);
    expect(refs.filter((r) => r.kind === 'new')).toEqual([]);
    const lt = ir.localTypes;
    expect(lt.some((t) => t.name === 'p' && t.type === 'point' && t.scope === by['make_point'].ordinal)).toBe(true);
    expect(lt.some((t) => t.name === 'pt' && t.type === 'point' && t.scope === by['process'].ordinal)).toBe(true);
    expect(lt.some((t) => t.name === 'cb' && t.type === 'callback_fn')).toBe(true);
    expect(lt.some((t) => t.name === 'local' && t.type === 'point_t')).toBe(true);
  });

  it('handles anonymous typedef structs and multiple declarators', async () => {
    const ir = (await extractFile('src/x.c', 'typedef struct { int a; } anon_t;\nint a = 1, b;\nstruct node { struct node *next; int vals[4]; };\n'))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['anon_t'].kind).toBe('struct');
    expect(by['anon_t.a'].kind).toBe('field');
    expect(by['a'].kind).toBe('variable');
    expect(by['b'].kind).toBe('variable');
    expect(by['node.next'].declaredType).toBe('node');
    expect(by['node.vals'].kind).toBe('field');
    expect(ir.definitions.filter((d) => d.kind === 'type_alias')).toEqual([]);
  });

  it('detects test files', () => {
    expect(c.isTestFile!('tests/foo.c')).toBe(true);
    expect(c.isTestFile!('src/foo_test.c')).toBe(true);
    expect(c.isTestFile!('src/foo.c')).toBe(false);
  });
});
