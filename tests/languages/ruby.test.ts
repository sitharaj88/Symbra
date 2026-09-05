import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { ruby } from '../../src/languages/ruby.js';

registerLanguage(ruby);

const src = readFileSync(new URL('../fixtures/ruby/sample.rb', import.meta.url), 'utf8');

describe('ruby extractor', () => {
  it('extracts modules, classes, mixins, methods, visibility and docs', async () => {
    const ir = (await extractFile('lib/billing/sample.rb', src))!;
    expect(ir.errorPct).toBe(0);
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(ir.doc).toBe('Sample Ruby module for extractor tests.\nCovers classes, modules, mixins, routes and specs.');
    expect(by['MAX_RETRIES'].kind).toBe('constant');
    expect(by['Billing'].kind).toBe('namespace');
    expect(by['Billing.Invoice'].kind).toBe('class');
    expect(by['Billing.Invoice'].doc).toBe('An invoice.\nSecond doc line.');
    expect(by['Billing.Invoice'].signature).toBe('class Invoice < Base::Record');
    expect(by['Billing.Invoice'].supertypes).toEqual([
      { name: 'Base.Record', kind: 'extends' },
      { name: 'Comparable', kind: 'implements' },
      { name: 'Forwardable', kind: 'implements' },
      { name: 'Loggable', kind: 'implements' },
    ]);
    expect(by['Billing.Invoice.total'].kind).toBe('property');
    expect(by['Billing.Invoice.items'].kind).toBe('property');
    expect(by['Billing.Invoice.status'].kind).toBe('property');
    expect(by['Billing.Invoice.RATE'].kind).toBe('constant');
    expect(by['Billing.Invoice.initialize'].kind).toBe('constructor');
    expect(by['Billing.Invoice.compute'].kind).toBe('method');
    expect(by['Billing.Invoice.compute'].doc).toBe('Computes stuff.');
    expect(by['Billing.Invoice.compute'].signature).toBe('def compute(a, b = 2, *rest, k: 1, &blk)');
    expect(by['Billing.Invoice.compute'].range.startLine).toBe(36);
    expect(by['Billing.Invoice.build'].modifiers).toContain('static');
    expect(by['Billing.Invoice.build'].signature).toBe('def self.build(x)');
    expect(by['Billing.Invoice.name=']).toBeDefined();
    // visibility sections, `private def`, `private :sym`
    expect(by['Billing.Invoice.secret'].modifiers).toEqual(['private']);
    expect(by['Billing.Invoice.secret'].exported).toBe(false);
    expect(by['Billing.Invoice.prot'].modifiers).toEqual(['protected']);
    expect(by['Billing.Invoice.hidden'].modifiers).toEqual(['private']);
    expect(by['Billing.Invoice.listed'].modifiers).toEqual(['private']);
    expect(by['Billing.Invoice.klass_m'].modifiers).toContain('static');
    expect(by['Billing.Invoice.old_compute'].meta?.alias_of).toBe('compute');
    // Struct.new with a block is a class
    expect(by['Billing.Point'].kind).toBe('class');
    expect(by['Billing.Point.dist'].kind).toBe('method');
    expect(by['top_fn'].kind).toBe('function');
    expect(by['InvoiceTest'].supertypes).toEqual([{ name: 'Minitest.Test', kind: 'extends' }]);
  });

  it('extracts Rails / Sinatra routes and RSpec / minitest tests', async () => {
    const ir = (await extractFile('lib/billing/sample.rb', src))!;
    const routes = ir.definitions.filter((d) => d.kind === 'route');
    const names = routes.map((r) => r.name);
    expect(names).toContain('GET /hello');
    expect(names).toContain('GET /');
    expect(names).toContain('GET /users');
    expect(names).toContain('POST /users');
    expect(names).toContain('GET /posts');
    expect(names).toContain('GET /posts/:id');
    expect(names).toContain('POST /posts');
    expect(names).toContain('PATCH /posts/:id');
    expect(names).toContain('DELETE /posts/:id');
    expect(names).toContain('GET /admin/reports');
    // `only:` restricts resource actions
    expect(names.filter((n) => n.includes('/comments'))).toEqual(['GET /comments', 'GET /comments/:id']);
    expect(routes.find((r) => r.name === 'GET /users')?.meta).toMatchObject({ method: 'GET', path: '/users', handler: 'users#index', controller: 'users', action: 'index' });
    expect(routes.find((r) => r.name === 'POST /users')?.meta?.handler).toBe('users#create');
    expect(routes.find((r) => r.name === 'GET /admin/reports')?.meta?.handler).toBe('admin/reports#index');
    // Sinatra block route scopes its body
    const hello = routes.find((r) => r.name === 'GET /hello')!;
    expect(ir.references.some((r) => r.kind === 'call' && r.name === 'top_fn' && r.scope === hello.ordinal)).toBe(true);
    // routes are never emitted inside tests
    expect(names).not.toContain('GET /not/a/route');
    const tests = ir.definitions.filter((d) => d.kind === 'test');
    expect(tests.map((t) => t.name)).toEqual(['describe Billing::Invoice', 'context when empty', 'it is zero', 'test_total']);
    const itDef = tests.find((t) => t.name === 'it is zero')!;
    expect(ir.definitions[itDef.parent]!.name).toBe('context when empty');
    expect(ir.references.some((r) => r.kind === 'new' && r.name === 'Invoice' && r.scope === itDef.ordinal)).toBe(true);
    expect(ruby.isTestFile!('spec/models/user_spec.rb')).toBe(true);
    expect(ruby.isTestFile!('test/user_test.rb')).toBe(true);
    expect(ruby.isTestFile!('lib/user.rb')).toBe(false);
  });

  it('extracts requires, autoload and resolves module paths', async () => {
    const ir = (await extractFile('lib/billing/sample.rb', src))!;
    expect(ir.imports.find((i) => i.source === 'json')).toMatchObject({ namespace: true, alias: '', relativeLevel: 0 });
    expect(ir.imports.find((i) => i.source === 'helpers/util')?.relativeLevel).toBe(1);
    expect(ir.imports.find((i) => i.source === 'billing/formatter')?.names).toEqual([{ name: 'Formatter', alias: 'Formatter' }]);
    const project = { hasFile: () => false };
    const rel = ir.imports.find((i) => i.source === 'helpers/util')!;
    expect(ruby.resolveModule('helpers/util', 'lib/billing/sample.rb', rel, project)[0]).toBe('lib/billing/helpers/util.rb');
    const up = ir.imports.find((i) => i.source === '../base')!;
    expect(ruby.resolveModule('../base', 'lib/billing/sample.rb', up, project)[0]).toBe('lib/base.rb');
    const abs = ir.imports.find((i) => i.source === 'json')!;
    const cands = ruby.resolveModule('json', 'lib/billing/sample.rb', abs, project);
    expect(cands).toContain('lib/json.rb');
    expect(cands).toContain('json.rb');
    expect(cands).toContain('app/models/json.rb');
  });

  it('extracts calls, new, constants, super, config reads and receiver-type facts', async () => {
    const ir = (await extractFile('lib/billing/sample.rb', src))!;
    const refs = ir.references;
    expect(refs.some((r) => r.kind === 'new' && r.name === 'Cache' && r.qualifier === '')).toBe(true);
    expect(refs.some((r) => r.kind === 'new' && r.name === 'Invoice' && r.qualifier === 'Billing')).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.name === 'run' && r.qualifier === 'helper')).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.name === 'baz' && r.qualifier === 'Foo::Bar' && r.arity === 2)).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.name === 'compute' && r.qualifier === '' && r.arity === 1)).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.name === 'get' && r.qualifier === '@cache')).toBe(true);
    expect(refs.some((r) => r.kind === 'call' && r.name === 'compute' && r.qualifier === 'super')).toBe(true);
    expect(refs.some((r) => r.kind === 'type' && r.name === 'ArgumentError')).toBe(true);
    expect(refs.some((r) => r.kind === 'type' && r.name === 'Klass')).toBe(true);
    // constant/class names used as receivers or definitions are not double-reported
    expect(refs.filter((r) => r.kind === 'type' && (r.name === 'Cache' || r.name === 'MAX_RETRIES' || r.name === 'RATE' || r.name === 'Point'))).toEqual([]);
    expect(refs.some((r) => r.kind === 'config' && r.name === 'API_KEY')).toBe(true);
    expect(refs.some((r) => r.kind === 'config' && r.name === 'SECRET')).toBe(true);
    // DSL calls (require/include/attr_*) are not calls
    expect(refs.some((r) => r.kind === 'call' && ['require', 'require_relative', 'include', 'extend', 'prepend', 'attr_reader', 'attr_accessor', 'describe', 'it', 'resources'].includes(r.name))).toBe(false);
    expect(ir.localTypes.some((t) => t.name === '@cache' && t.type === 'Cache' && t.via === 'new')).toBe(true);
    expect(ir.localTypes.some((t) => t.name === 'helper' && t.type === 'Helper' && t.via === 'new')).toBe(true);
  });
});
