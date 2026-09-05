import type { Node } from 'web-tree-sitter';
import type { Definition, FileIR, Range } from '../ir/types.js';
import type { LanguageSupport } from './types.js';
import { oneLine, named, kids } from '../parse/walk.js';
import { resolveJsModule } from './javascript.js';
import { contentHash } from '../index/extract.js';
import {
  blankBlocks,
  componentNameFor,
  emptyIR,
  mergeWalkResult,
  parseScript,
  scanBlocks,
  scanComponentUses,
  type TagBlock,
} from './sfc.js';

/** `props: { x: String }` constructor -> a type name a reader (and the resolver) recognises. */
const CTOR_TYPES: Record<string, string> = {
  String: 'string',
  Number: 'number',
  Boolean: 'boolean',
  Array: 'Array',
  Object: 'object',
  Function: 'Function',
  Date: 'Date',
  Symbol: 'symbol',
  BigInt: 'bigint',
};

function eachNode(root: Node, fn: (n: Node) => void): void {
  const stack: Node[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    fn(n);
    for (const c of kids(n)) stack.push(c);
  }
}

function shiftRange(node: Node, block: TagBlock): Range {
  return {
    startLine: node.startPosition.row + block.startLine,
    endLine: node.endPosition.row + block.startLine,
    startByte: node.startIndex + block.startIndex,
    endByte: node.endIndex + block.startIndex,
  };
}

function stringValue(n: Node | null | undefined): string | null {
  if (!n) return null;
  if (n.type !== 'string' && n.type !== 'template_string') return null;
  const frag = named(n).find((c) => c.type === 'string_fragment');
  return frag ? frag.text : n.text.replace(/^['"`]|['"`]$/g, '');
}

interface PropInfo {
  name: string;
  declaredType?: string;
  optional: boolean;
  node: Node;
  signature: string;
}

/** `defineProps<{ a: A; b?: B }>()` / `interface Props { … }` shaped object type. */
function propsFromObjectType(objType: Node): PropInfo[] {
  const out: PropInfo[] = [];
  for (const p of named(objType)) {
    if (p.type !== 'property_signature') continue;
    const nameNode = p.childForFieldName('name');
    const name = nameNode ? (stringValue(nameNode) ?? nameNode.text) : '';
    if (!name) continue;
    const t = p.childForFieldName('type')?.text.replace(/^\s*:\s*/, '').trim();
    out.push({ name, declaredType: t || undefined, optional: kids(p).some((c) => c.text === '?' && !c.isNamed), node: p, signature: oneLine(p.text) });
  }
  return out;
}

/** `props: { title: String, count: { type: Number, required: true } }` or `props: ['a', 'b']`. */
function propsFromValue(value: Node): PropInfo[] {
  const out: PropInfo[] = [];
  if (value.type === 'array') {
    for (const el of named(value)) {
      const name = stringValue(el);
      if (name) out.push({ name, optional: true, node: el, signature: oneLine(`${name}: any`) });
    }
    return out;
  }
  if (value.type !== 'object') return out;
  for (const pair of named(value)) {
    if (pair.type !== 'pair') continue;
    const keyNode = pair.childForFieldName('key');
    const name = keyNode ? (stringValue(keyNode) ?? keyNode.text) : '';
    if (!name) continue;
    const v = pair.childForFieldName('value');
    let declaredType: string | undefined;
    let optional = true;
    if (v?.type === 'identifier') declaredType = CTOR_TYPES[v.text] ?? v.text;
    else if (v?.type === 'object') {
      for (const inner of named(v)) {
        if (inner.type !== 'pair') continue;
        const k = inner.childForFieldName('key')?.text;
        const iv = inner.childForFieldName('value');
        if (k === 'type' && iv) {
          const first = iv.type === 'array' ? (named(iv)[0] ?? iv) : iv;
          declaredType = CTOR_TYPES[first.text] ?? first.text;
        } else if (k === 'required' && iv?.text === 'true') optional = false;
      }
    } else if (v?.type === 'array') declaredType = 'Array';
    out.push({ name, declaredType, optional, node: pair, signature: oneLine(pair.text) });
  }
  return out;
}

/** Event names from `defineEmits([...])` / `defineEmits<{…}>()` / `emits: [...]`. */
function emitNames(node: Node): string[] {
  const out: string[] = [];
  const add = (s: string | null) => {
    if (s && !out.includes(s)) out.push(s);
  };
  if (node.type === 'array') {
    for (const el of named(node)) add(stringValue(el));
    return out;
  }
  if (node.type === 'object') {
    for (const pair of named(node)) {
      if (pair.type !== 'pair') continue;
      const k = pair.childForFieldName('key');
      if (k) add(stringValue(k) ?? k.text);
    }
    return out;
  }
  if (node.type === 'object_type') {
    for (const m of named(node)) {
      if (m.type === 'property_signature') {
        const k = m.childForFieldName('name');
        if (k) add(stringValue(k) ?? k.text);
      } else if (m.type === 'call_signature') {
        // `(e: 'change', id: number): void`
        const params = m.childForFieldName('parameters');
        const first = named(params)[0];
        const lit = first ? first.childForFieldName('type')?.text.replace(/^\s*:\s*/, '') : '';
        if (lit) add(lit.replace(/^['"`]|['"`]$/g, ''));
      }
    }
  }
  return out;
}

function callName(call: Node): string {
  const fn = call.childForFieldName('function');
  return fn?.type === 'identifier' ? fn.text : '';
}

/** Extract the SFC-specific facts (props, emits, registered components) from one script tree. */
function scriptFacts(root: Node) {
  const props: PropInfo[] = [];
  const emits: string[] = [];
  const components: { name: string; node: Node }[] = [];
  let declaredName = '';

  eachNode(root, (n) => {
    if (n.type === 'call_expression') {
      const fn = callName(n);
      if (fn === 'defineProps') {
        const ta = n.childForFieldName('type_arguments');
        const objType = ta ? named(ta).find((c) => c.type === 'object_type') : null;
        if (objType) props.push(...propsFromObjectType(objType));
        else {
          const arg = named(n.childForFieldName('arguments'))[0];
          if (arg) props.push(...propsFromValue(arg));
        }
      } else if (fn === 'defineEmits' || fn === 'defineModel') {
        const ta = n.childForFieldName('type_arguments');
        const objType = ta ? named(ta).find((c) => c.type === 'object_type') : null;
        if (objType) emits.push(...emitNames(objType));
        else {
          const arg = named(n.childForFieldName('arguments'))[0];
          if (arg) emits.push(...emitNames(arg));
        }
      }
      return;
    }
    // Options API object: `export default { … }` / `defineComponent({ … })`.
    if (n.type !== 'pair') return;
    const key = n.childForFieldName('key')?.text;
    const value = n.childForFieldName('value');
    if (!key || !value) return;
    if (key === 'props') props.push(...propsFromValue(value));
    else if (key === 'emits') emits.push(...emitNames(value));
    else if (key === 'name') declaredName = stringValue(value) ?? '';
    else if (key === 'components' && value.type === 'object') {
      for (const c of named(value)) {
        if (c.type === 'shorthand_property_identifier') components.push({ name: c.text, node: c });
        else if (c.type === 'pair') {
          const v = c.childForFieldName('value');
          if (v?.type === 'identifier') components.push({ name: v.text, node: v });
        }
      }
    }
  });

  return { props, emits, components, declaredName };
}

/**
 * Extract a Vue single-file component.
 *
 * The `<script>` blocks are parsed with the JavaScript/TypeScript module (so imports, functions,
 * calls and types come out exactly as they would in a `.ts` file, with `.vue` line numbers), and
 * the SFC itself is represented by one `class`-like component symbol carrying its props and emits.
 * Component tags used in `<template>` become value references to that component's name.
 */
export async function extractVue(path: string, content: string): Promise<FileIR> {
  const ir = emptyIR(path, 'vue', contentHash(content), Buffer.byteLength(content, 'utf8'));
  const compName = componentNameFor(path);
  const totalLines = content.split('\n').length;

  const component: Definition = {
    ordinal: 0,
    kind: 'class',
    name: compName,
    fqn: compName,
    range: { startLine: 1, endLine: totalLines, startByte: 0, endByte: content.length },
    parent: -1,
    signature: `component ${compName}`,
    doc: '',
    modifiers: [],
    exported: true,
    supertypes: [],
    meta: { component: true, framework: 'vue' },
  };
  ir.definitions.push(component);

  const blocks = scanBlocks(content, 'script');
  const allProps: { info: PropInfo; block: TagBlock }[] = [];
  const emits: string[] = [];
  let scriptChars = 0;
  let errorChars = 0;

  for (const block of blocks) {
    const parsed = await parseScript(block, path);
    if (!parsed) continue;
    try {
      mergeWalkResult(ir, parsed.result, ir.definitions.length);
      if (!ir.doc && parsed.result.doc) ir.doc = parsed.result.doc;
      scriptChars += block.content.length;
      errorChars += (parsed.result.errorPct / 100) * block.content.length;
      const facts = scriptFacts(parsed.tree.rootNode);
      for (const info of facts.props) allProps.push({ info, block });
      for (const e of facts.emits) if (!emits.includes(e)) emits.push(e);
      if (facts.declaredName) component.meta!.declaredName = facts.declaredName;
      for (const c of facts.components) {
        ir.references.push({ kind: 'value', name: c.name, qualifier: '', line: c.node.startPosition.row + block.startLine, startByte: c.node.startIndex + block.startIndex, scope: 0 });
      }
    } finally {
      parsed.tree.delete();
    }
  }

  const seenProp = new Set<string>();
  for (const { info, block } of allProps) {
    if (seenProp.has(info.name)) continue;
    seenProp.add(info.name);
    ir.definitions.push({
      ordinal: ir.definitions.length,
      kind: 'field',
      name: info.name,
      fqn: `${compName}.${info.name}`,
      range: shiftRange(info.node, block),
      parent: 0,
      signature: info.signature,
      doc: '',
      modifiers: info.optional ? ['optional'] : ['required'],
      exported: true,
      supertypes: [],
      declaredType: info.declaredType,
      meta: { prop: true },
    });
  }
  if (emits.length) component.meta!.emits = emits.join(',');

  // Template: component tags become references to the component symbol of the same name.
  const template = blankBlocks(content, ['script', 'style']);
  for (const use of scanComponentUses(template, new Set([compName]))) {
    ir.references.push({ kind: 'value', name: use.name, qualifier: '', line: use.line, startByte: use.index, scope: 0 });
  }

  ir.errorPct = scriptChars ? Math.min(100, Math.round((errorChars / scriptChars) * 100)) : 0;
  if (ir.errorPct > 0) ir.diagnostics.push({ severity: ir.errorPct > 20 ? 'warning' : 'info', message: `parse errors cover ${ir.errorPct}% of the script blocks` });
  return ir;
}

/** Registry entry: no grammar of its own; extraction is handled by `extractVue`. */
export const vue: LanguageSupport = {
  id: 'vue',
  grammar: '',
  extensions: ['.vue'],
  classLike: new Set(),
  definition: () => null,
  imports: () => null,
  references: () => undefined,
  doc: () => '',
  isTestFile(path) {
    return /(^|\/)(__tests__|tests?|spec)\//.test(path);
  },
  resolveModule(source, fromPath, _imp, project) {
    return resolveJsModule(source, fromPath, project);
  },
};
