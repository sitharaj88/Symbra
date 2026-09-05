import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { svelte } from '../../src/languages/svelte.js';

beforeAll(() => registerLanguage(svelte));

const listSrc = readFileSync(new URL('../fixtures/svelte/TodoList.svelte', import.meta.url), 'utf8');
const runeSrc = readFileSync(new URL('../fixtures/svelte/RuneCard.svelte', import.meta.url), 'utf8');

describe('svelte extractor', () => {
  it('emits a component symbol named after the file', async () => {
    const ir = (await extractFile('src/lib/TodoList.svelte', listSrc))!;
    expect(ir.language).toBe('svelte');
    expect(ir.errorPct).toBe(0);
    const comp = ir.definitions[0]!;
    expect(comp.kind).toBe('class');
    expect(comp.name).toBe('TodoList');
    expect(comp.meta?.component).toBe(true);
    expect(comp.meta?.framework).toBe('svelte');
  });

  it('parses <script> blocks with real .svelte line numbers', async () => {
    const ir = (await extractFile('src/lib/TodoList.svelte', listSrc))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['refresh'].kind).toBe('function');
    expect(by['refresh'].range.startLine).toBe(20);
    expect(by['refresh'].doc).toBe('Refresh from the API.');
    expect(listSrc.slice(by['refresh'].range.startByte, by['refresh'].range.startByte + 5)).toBe('async');
    // the `context="module"` block is a separate block, offset from line 1
    expect(by['LIMIT'].range.startLine).toBe(2);
    expect(by['LIMIT'].modifiers).toContain('module');
    expect(ir.references.some((r) => r.kind === 'call' && r.name === 'load' && r.line === 21)).toBe(true);
  });

  it('turns `export let` into props with declared types', async () => {
    const ir = (await extractFile('src/lib/TodoList.svelte', listSrc))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['TodoList.title'].kind).toBe('field');
    expect(by['TodoList.title'].declaredType).toBe('string');
    expect(by['TodoList.title'].modifiers).toContain('required');
    expect(by['TodoList.title'].parent).toBe(0);
    expect(by['TodoList.items'].modifiers).toContain('optional');
    expect(by['TodoList.compact'].meta?.prop).toBe(true);
    expect(ir.definitions[0]!.meta?.props).toBe('title,items,compact');
    // `$:` reactive statements declare nothing
    expect(ir.definitions.some((d) => d.name === 'visible' || d.name === '$')).toBe(false);
    // a plain (non-exported) `let` stays a local variable
    expect(by['filter'].kind).toBe('variable');
  });

  it('handles Svelte 5 `$props()` destructuring with an interface', async () => {
    const ir = (await extractFile('src/lib/RuneCard.svelte', runeSrc))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['RuneCard.label'].declaredType).toBe('string');
    expect(by['RuneCard.label'].modifiers).toContain('required');
    expect(by['RuneCard.count'].declaredType).toBe('number');
    expect(by['RuneCard.count'].modifiers).toContain('optional');
    expect(ir.definitions[0]!.meta?.props).toBe('label,count');
  });

  it('extracts imports and template component usage', async () => {
    const ir = (await extractFile('src/lib/TodoList.svelte', listSrc))!;
    const imp = Object.fromEntries(ir.imports.map((i) => [i.source, i]));
    expect(imp['./TodoItem.svelte'].names[0]!.alias).toBe('TodoItem');
    expect(imp['./TodoItem.svelte'].line).toBe(7);
    const uses = ir.references.filter((r) => r.scope === 0 && r.kind === 'value');
    expect(uses.find((r) => r.name === 'TodoItem')?.line).toBe(31);
    // kebab-case tags are PascalCased so they meet the component's own symbol name
    expect(uses.find((r) => r.name === 'TodoFooter')?.line).toBe(34);
    expect(uses.some((r) => r.name === 'Ul' || r.name === 'Input' || r.name === 'H1')).toBe(false);
    const spec = { source: './TodoItem.svelte', names: [], namespace: false, alias: '', kind: 'static' as const, line: 1 };
    expect(svelte.resolveModule('./TodoItem.svelte', 'src/lib/TodoList.svelte', spec, { hasFile: () => true })).toContain('src/lib/TodoItem.svelte');
  });
});
