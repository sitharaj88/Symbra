import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { ocaml, ocamlInterface } from '../../src/languages/ocaml.js';

registerLanguage(ocaml);
registerLanguage(ocamlInterface);

const src = readFileSync(new URL('../fixtures/ocaml/sample.ml', import.meta.url), 'utf8');
const iface = readFileSync(new URL('../fixtures/ocaml/sample.mli', import.meta.url), 'utf8');
const testSrc = readFileSync(new URL('../fixtures/ocaml/test_user.ml', import.meta.url), 'utf8');

describe('ocaml extractor', () => {
  it('extracts types, modules, classes and let bindings', async () => {
    const ir = (await extractFile('lib/sample.ml', src))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(ir.errorPct).toBe(0);
    expect(ir.doc).toBe('Sample module for extractor tests.');
    expect(by['user'].kind).toBe('struct');
    expect(by['user'].doc).toBe('A user record.');
    expect(by['user.id'].kind).toBe('field');
    expect(by['user.id'].declaredType).toBe('int');
    expect(by['status'].kind).toBe('enum');
    expect(by['status.Suspended'].kind).toBe('enum_member');
    expect(by['user_table'].kind).toBe('type_alias');
    expect(by['STORE'].kind).toBe('interface');
    expect(by['STORE.get'].meta?.prototype).toBe(true);
    expect(by['Store'].kind).toBe('namespace');
    expect(by['Store.get'].kind).toBe('function');
    expect(by['Store.table'].kind).toBe('constant');
    expect(by['Store.table'].doc).toBe('In-memory table.');
    expect(by['counter'].kind).toBe('class');
    expect(by['counter.bump'].kind).toBe('method');
    expect(by['counter.n'].kind).toBe('field');
    expect(by['find_user'].kind).toBe('function');
    expect(by['find_user'].doc).toBe('Find a user by id.');
    expect(by['find_user'].meta?.arity).toBe(2);
    // `let rec … and …` chains produce one symbol per binding
    expect(by['render_user'].modifiers).toContain('rec');
    expect(by['normalize'].kind).toBe('function');
    expect(by['max_retries'].kind).toBe('constant');
    expect(by['normalize is idempotent'].kind).toBe('test');
    expect(by['normalize is idempotent'].meta?.framework).toBe('ppx_inline_test');
  });

  it('extracts open/include as namespace imports', async () => {
    const ir = (await extractFile('lib/sample.ml', src))!;
    expect(ir.imports.map((i) => [i.source, i.namespace, i.kind])).toEqual([
      ['Core', true, 'static'],
      ['Store.Repo', true, 'static'],
      ['Utils', true, 'reexport'],
    ]);
    expect(ocaml.resolveModule('Utils', 'lib/sample.ml', ir.imports[2]!, { hasFile: () => false })).toContain('lib/utils.ml');
  });

  it('extracts qualified calls, type refs and config reads', async () => {
    const ir = (await extractFile('lib/sample.ml', src))!;
    const calls = ir.references.filter((r) => r.kind === 'call');
    expect(calls.some((c) => c.qualifier === 'Hashtbl' && c.name === 'find_opt' && c.arity === 2)).toBe(true);
    expect(calls.some((c) => c.qualifier === '' && c.name === 'normalize')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'type' && r.name === 'user_table')).toBe(true);
    expect(ir.references.some((r) => r.kind === 'config' && r.name === 'API_TOKEN')).toBe(true);
  });

  it('extracts .mli signatures as prototypes', async () => {
    const ir = (await extractFile('lib/sample.mli', iface))!;
    expect(ir.language).toBe('ocaml_interface');
    expect(ir.errorPct).toBe(0);
    expect(ir.doc).toBe('Interface for the sample module.');
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['find_user'].kind).toBe('function');
    expect(by['find_user'].meta?.prototype).toBe(true);
    expect(by['find_user'].signature).toBe('val find_user : user_table -> int -> user option');
    expect(by['find_user'].doc).toBe('Find a user by id.');
    expect(by['max_retries'].kind).toBe('constant');
    expect(by['user_table'].meta?.abstract).toBe(true);
    expect(by['user.id'].kind).toBe('field');
  });

  it('extracts alcotest cases and test_ functions', async () => {
    const ir = (await extractFile('test/test_user.ml', testSrc))!;
    const tests = ir.definitions.filter((d) => d.kind === 'test');
    expect(tests.map((t) => t.name)).toEqual(['test_find', 'finds a user']);
    expect(tests[1]!.meta?.framework).toBe('alcotest');
    expect(ocaml.isTestFile!('test/test_user.ml')).toBe(true);
  });
});
