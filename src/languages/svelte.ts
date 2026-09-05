import type { Node } from 'web-tree-sitter';
import type { Definition, FileIR, Range } from '../ir/types.js';
import type { LanguageSupport } from './types.js';
import { oneLine, named, kids } from '../parse/walk.js';
import { resolveJsModule } from './javascript.js';
import { contentHash } from '../index/extract.js';
import { blankBlocks, componentNameFor, emptyIR, mergeWalkResult, parseScript, scanBlocks, scanComponentUses, type TagBlock } from './sfc.js';

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

/** `<script context="module">` / Svelte 5's `<script module>`: module scope, not component props. */
function isModuleScript(attrs: string): boolean {
  return /\bcontext\s*=\s*["']?module\b/i.test(attrs) || /(^|\s)module(\s|$|=)/i.test(attrs);
}

interface RuneProp {
  name: string;
  declaredType?: string;
  optional: boolean;
  node: Node;
  signature: string;
}

/** Property name -> declared type for every `interface X {…}` / `type X = {…}` in a script. */
function objectTypeMembers(root: Node, typeName: string): Map<string, { type?: string; optional: boolean }> {
  const out = new Map<string, { type?: string; optional: boolean }>();
  let body: Node | null = null;
  eachNode(root, (n) => {
    if (body) return;
    if (n.type === 'interface_declaration' && n.childForFieldName('name')?.text === typeName) body = n.childForFieldName('body');
    else if (n.type === 'type_alias_declaration' && n.childForFieldName('name')?.text === typeName) {
      const v = n.childForFieldName('value');
      if (v?.type === 'object_type') body = v;
    }
  });
  if (!body) return out;
  for (const m of named(body)) {
    if (m.type !== 'property_signature') continue;
    const name = m.childForFieldName('name')?.text;
    if (!name) continue;
    out.set(name, {
      type: m.childForFieldName('type')?.text.replace(/^\s*:\s*/, '').trim() || undefined,
      optional: kids(m).some((c) => c.text === '?' && !c.isNamed),
    });
  }
  return out;
}

/** Svelte 5 runes: `let { a, b = 1 }: Props = $props()`. */
function runeProps(root: Node): RuneProp[] {
  const out: RuneProp[] = [];
  eachNode(root, (n) => {
    if (n.type !== 'variable_declarator') return;
    const value = n.childForFieldName('value');
    if (value?.type !== 'call_expression' || value.childForFieldName('function')?.text !== '$props') return;
    const pattern = n.childForFieldName('name');
    if (pattern?.type !== 'object_pattern') return;
    const typeName = n.childForFieldName('type')?.text.replace(/^\s*:\s*/, '').trim() ?? '';
    const members = typeName ? objectTypeMembers(root, typeName) : new Map<string, { type?: string; optional: boolean }>();
    for (const el of named(pattern)) {
      let nameNode: Node | null = null;
      let hasDefault = false;
      if (el.type === 'shorthand_property_identifier_pattern') nameNode = el;
      else if (el.type === 'object_assignment_pattern') {
        nameNode = el.childForFieldName('left');
        hasDefault = true;
      } else if (el.type === 'pair_pattern') nameNode = el.childForFieldName('key');
      if (!nameNode) continue;
      const name = nameNode.text;
      const info = members.get(name);
      out.push({ name, declaredType: info?.type, optional: hasDefault || (info?.optional ?? false), node: el, signature: oneLine(`${name}${info?.type ? ': ' + info.type : ''}`) });
    }
  });
  return out;
}

/**
 * Extract a Svelte component.
 *
 * `<script>` blocks are parsed with the JavaScript/TypeScript module and every position is shifted
 * back into `.svelte` coordinates. The file itself becomes one `class`-like component symbol;
 * `export let x: T` (and Svelte 5's `$props()` destructuring) become its props, `$:` reactive
 * statements declare nothing, and component tags in the markup become value references.
 */
export async function extractSvelte(path: string, content: string): Promise<FileIR> {
  const ir = emptyIR(path, 'svelte', contentHash(content), Buffer.byteLength(content, 'utf8'));
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
    meta: { component: true, framework: 'svelte' },
  };
  ir.definitions.push(component);

  const props: string[] = [];
  const addedProps = new Set<string>();
  let scriptChars = 0;
  let errorChars = 0;

  for (const block of scanBlocks(content, 'script')) {
    const moduleScope = isModuleScript(block.attrs);
    const parsed = await parseScript(block, path);
    if (!parsed) continue;
    try {
      const base = ir.definitions.length;
      mergeWalkResult(ir, parsed.result, base);
      if (!ir.doc && parsed.result.doc) ir.doc = parsed.result.doc;
      scriptChars += block.content.length;
      errorChars += (parsed.result.errorPct / 100) * block.content.length;

      if (moduleScope) {
        for (const d of ir.definitions.slice(base)) if (d.parent < 0) d.modifiers = [...d.modifiers, 'module'];
        continue;
      }

      // `export let x: T` at the top level of the instance script is a component prop.
      for (const d of ir.definitions.slice(base)) {
        if (d.parent !== -1 || !d.exported || d.kind !== 'variable') continue;
        d.kind = 'field';
        d.parent = 0;
        d.fqn = `${compName}.${d.name}`;
        d.meta = { ...(d.meta ?? {}), prop: true };
        // The JS signature ends in a bare `=` when there is no initialiser: `let title: string =`.
        d.modifiers = [...d.modifiers, /=\s*\S/.test(d.signature) ? 'optional' : 'required'];
        addedProps.add(d.name);
        props.push(d.name);
      }

      for (const rp of runeProps(parsed.tree.rootNode)) {
        if (addedProps.has(rp.name)) continue;
        addedProps.add(rp.name);
        props.push(rp.name);
        ir.definitions.push({
          ordinal: ir.definitions.length,
          kind: 'field',
          name: rp.name,
          fqn: `${compName}.${rp.name}`,
          range: shiftRange(rp.node, block),
          parent: 0,
          signature: rp.signature,
          doc: '',
          modifiers: [rp.optional ? 'optional' : 'required'],
          exported: true,
          supertypes: [],
          declaredType: rp.declaredType,
          meta: { prop: true },
        });
      }
    } finally {
      parsed.tree.delete();
    }
  }

  if (props.length) component.meta!.props = props.join(',');

  const markup = blankBlocks(content, ['script', 'style']);
  for (const use of scanComponentUses(markup, new Set([compName]))) {
    ir.references.push({ kind: 'value', name: use.name, qualifier: '', line: use.line, startByte: use.index, scope: 0 });
  }

  ir.errorPct = scriptChars ? Math.min(100, Math.round((errorChars / scriptChars) * 100)) : 0;
  if (ir.errorPct > 0) ir.diagnostics.push({ severity: ir.errorPct > 20 ? 'warning' : 'info', message: `parse errors cover ${ir.errorPct}% of the script blocks` });
  return ir;
}

/** Registry entry: no grammar of its own; extraction is handled by `extractSvelte`. */
export const svelte: LanguageSupport = {
  id: 'svelte',
  grammar: '',
  extensions: ['.svelte'],
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
