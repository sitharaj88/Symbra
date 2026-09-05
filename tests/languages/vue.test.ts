import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFile } from '../../src/index/extract.js';
import { registerLanguage } from '../../src/languages/registry.js';
import { vue } from '../../src/languages/vue.js';

beforeAll(() => registerLanguage(vue));

const setupSrc = readFileSync(new URL('../fixtures/vue/UserCard.vue', import.meta.url), 'utf8');
const optionsSrc = readFileSync(new URL('../fixtures/vue/LegacyPanel.vue', import.meta.url), 'utf8');

describe('vue extractor', () => {
  it('emits a component symbol named after the file', async () => {
    const ir = (await extractFile('src/components/UserCard.vue', setupSrc))!;
    expect(ir.language).toBe('vue');
    expect(ir.errorPct).toBe(0);
    const comp = ir.definitions[0]!;
    expect(comp.kind).toBe('class');
    expect(comp.name).toBe('UserCard');
    expect(comp.meta?.component).toBe(true);
    expect(comp.meta?.framework).toBe('vue');
    expect(comp.range.startLine).toBe(1);
  });

  it('parses the <script setup> block with real .vue line numbers', async () => {
    const ir = (await extractFile('src/components/UserCard.vue', setupSrc))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    // `interface User` is on line 16 of the .vue file, not line 6 of the script block.
    expect(by['User'].kind).toBe('interface');
    expect(by['User'].range.startLine).toBe(16);
    expect(by['User.name'].declaredType).toBe('string');
    expect(by['onClick'].kind).toBe('function');
    expect(by['onClick'].range.startLine).toBe(33);
    expect(by['label'].doc).toBe('Display label for the card.');
    // byte offsets are file offsets too
    const onClick = by['onClick'];
    expect(setupSrc.slice(onClick.range.startByte, onClick.range.startByte + 8)).toBe('function');
  });

  it('extracts imports and calls from the script block', async () => {
    const ir = (await extractFile('src/components/UserCard.vue', setupSrc))!;
    const imp = Object.fromEntries(ir.imports.map((i) => [i.source, i]));
    expect(imp['vue'].names.map((n) => n.name)).toEqual(['computed', 'ref']);
    expect(imp['./Avatar.vue'].line).toBe(12);
    expect(imp['../utils/format'].names[0]!.alias).toBe('formatName');
    expect(ir.references.some((r) => r.kind === 'call' && r.name === 'formatName' && r.line === 31)).toBe(true);
  });

  it('turns defineProps into fields and defineEmits into component meta', async () => {
    const ir = (await extractFile('src/components/UserCard.vue', setupSrc))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['UserCard.user'].kind).toBe('field');
    expect(by['UserCard.user'].declaredType).toBe('User');
    expect(by['UserCard.user'].modifiers).toContain('required');
    expect(by['UserCard.user'].parent).toBe(0);
    expect(by['UserCard.compact'].declaredType).toBe('boolean');
    expect(by['UserCard.compact'].modifiers).toContain('optional');
    expect(ir.definitions[0]!.meta?.emits).toBe('select,close');
  });

  it('handles the options API: props object, emits and components', async () => {
    const ir = (await extractFile('src/components/LegacyPanel.vue', optionsSrc))!;
    const by = Object.fromEntries(ir.definitions.map((d) => [d.fqn, d]));
    expect(by['LegacyPanel'].meta?.declaredName).toBe('LegacyPanel');
    expect(by['LegacyPanel'].meta?.emits).toBe('refresh');
    expect(by['LegacyPanel.title'].declaredType).toBe('string');
    expect(by['LegacyPanel.count'].declaredType).toBe('number');
    expect(by['LegacyPanel.count'].modifiers).toContain('required');
    expect(by['LegacyPanel.items'].declaredType).toBe('Array');
    expect(by['refresh'].kind).toBe('method');
    // `components: { UserCard }` registration
    expect(ir.references.some((r) => r.kind === 'value' && r.name === 'UserCard' && r.line === 13)).toBe(true);
  });

  it('references components used in the template, PascalCasing kebab tags', async () => {
    const ir = (await extractFile('src/components/UserCard.vue', setupSrc))!;
    const tpl = ir.references.filter((r) => r.scope === 0 && r.kind === 'value');
    expect(tpl.find((r) => r.name === 'Avatar')?.line).toBe(3);
    expect(tpl.find((r) => r.name === 'UserBadge')?.line).toBe(4);
    // plain HTML elements are not components
    expect(tpl.some((r) => r.name === 'Div' || r.name === 'Button' || r.name === 'P')).toBe(false);
  });

  it('resolves .vue module specifiers through the JS resolver', () => {
    const imp = { source: './Avatar.vue', names: [], namespace: false, alias: '', kind: 'static' as const, line: 1 };
    expect(vue.resolveModule('./Avatar.vue', 'src/components/UserCard.vue', imp, { hasFile: () => true })).toContain('src/components/Avatar.vue');
  });
});
