import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, simpleTypeName, cleanComment, named, kids, reparentReopenedBlocks } from '../parse/walk.js';

const COMMENTS = new Set(['line_comment', 'block_comment']);
const TEST_ATTR = /^#\[\s*(?:[\w]+::)*(test|bench|rstest|test_case|quickcheck|wasm_bindgen_test)\b/;
const SKIP_ATTRS = new Set(['cfg', 'cfg_attr', 'test', 'bench', 'ignore', 'should_panic', 'allow', 'warn', 'deny', 'forbid', 'expect', 'doc', 'inline', 'must_use', 'macro_export', 'macro_use', 'non_exhaustive', 'repr', 'automatically_derived', 'deprecated', 'path', 'no_mangle', 'track_caller', 'cold', 'link', 'global_allocator', 'panic_handler', 'no_std', 'no_main', 'feature', 'derive']);
/** Smart pointers / containers unwrapped when learning a receiver type: `Box<dyn Repo>` -> `Repo`. */
const WRAPPERS = new Set(['Box', 'Rc', 'Arc', 'Option', 'RefCell', 'Cell', 'Mutex', 'RwLock', 'Weak', 'Pin', 'Cow']);
const ENV_FNS = new Set(['var', 'var_os']);
const ENV_MACROS = new Set(['env', 'option_env']);
/** Node types whose `type_identifier` child is the name being declared (not a reference). */
const NAME_HOLDERS = new Set(['struct_item', 'enum_item', 'trait_item', 'type_item', 'union_item', 'associated_type', 'type_parameter', 'struct_expression', 'impl_item']);
const ROOT_FILES = new Set(['mod.rs', 'lib.rs', 'main.rs']);

/** Per-walk set of synthetic path imports already emitted (`crate::a::b`), keyed by the walk context. */
const pathImports = new WeakMap<WalkContext, Set<string>>();

function dotted(path: string): string {
  return path.replace(/\s+/g, '').replace(/::/g, '.');
}

function isDocComment(n: Node): boolean {
  if (n.type === 'block_comment') return /^\/\*\*[^*/]/.test(n.text) || /^\/\*!/.test(n.text);
  return /^\/\/\/(?!\/)/.test(n.text) || /^\/\/!/.test(n.text);
}

function cleanDoc(parts: string[]): string {
  const text = parts.map((t) => t.replace(/\n$/, '').replace(/^\/\/!/, '///').replace(/^\/\*!/, '/**')).join('\n');
  return cleanComment(text);
}

/** Line (`///`) or block doc comments immediately preceding an item, looking past attributes. */
function rustDoc(node: Node): string {
  const parts: string[] = [];
  let prev = node.previousSibling;
  let lastStart = node.startPosition.row;
  while (prev) {
    if (prev.type === 'attribute_item') {
      lastStart = prev.startPosition.row;
      prev = prev.previousSibling;
      continue;
    }
    if (!COMMENTS.has(prev.type) || !isDocComment(prev) || /^\/\/!/.test(prev.text)) break;
    if (lastStart - prev.endPosition.row > 1) break;
    parts.unshift(prev.text);
    lastStart = prev.startPosition.row;
    prev = prev.previousSibling;
  }
  return parts.length ? cleanDoc(parts) : '';
}

/** Outer attributes (`#[...]`) attached to an item. */
function attributesOf(node: Node): Node[] {
  const out: Node[] = [];
  let prev = node.previousSibling;
  while (prev && (prev.type === 'attribute_item' || COMMENTS.has(prev.type))) {
    if (prev.type === 'attribute_item') out.push(prev);
    prev = prev.previousSibling;
  }
  return out;
}

function hasVisibility(node: Node): boolean {
  return kids(node).some((c) => c.type === 'visibility_modifier');
}

function modifiersOf(node: Node): string[] {
  const m = kids(node).find((c) => c.type === 'function_modifiers');
  return m ? m.text.split(/\s+/).filter((w) => /^(async|unsafe|const|extern|default)$/.test(w)) : [];
}

/** Type name as written, with `::` -> `.`, wrappers/references/generics stripped: `&mut Vec<T>` -> `Vec`, `Box<dyn Repo>` -> `Repo`. */
function rustTypeName(t: Node | null | undefined): string {
  let n: Node | null | undefined = t;
  while (n) {
    switch (n.type) {
      case 'reference_type':
      case 'pointer_type':
        n = n.childForFieldName('type');
        continue;
      case 'dynamic_type':
      case 'abstract_type':
        n = n.childForFieldName('trait');
        continue;
      case 'bracketed_type':
      case 'qualified_type':
        n = named(n)[0];
        continue;
      case 'generic_type': {
        const base = n.childForFieldName('type');
        const baseName = base ? rustTypeName(base) : '';
        if (WRAPPERS.has(simpleTypeName(baseName))) {
          const inner = named(n.childForFieldName('type_arguments')).find((a) => a.type !== 'lifetime');
          if (inner) {
            n = inner;
            continue;
          }
        }
        return baseName;
      }
      case 'type_identifier':
        return n.text;
      case 'scoped_type_identifier':
        return dotted(n.text);
      case 'primitive_type':
        return n.text;
      default:
        return '';
    }
  }
  return '';
}

function qualifierOf(path: string): string {
  const d = dotted(path);
  return d.includes('.') ? d.slice(0, d.lastIndexOf('.')) : '';
}

function typeRefsFromBounds(bounds: Node | null | undefined): NonNullable<DefSpec['supertypes']> {
  const out: NonNullable<DefSpec['supertypes']> = [];
  for (const b of named(bounds)) {
    if (b.type === 'lifetime' || b.type === 'removed_trait_bound' || b.type === 'higher_ranked_trait_bound') continue;
    const t = rustTypeName(b);
    if (t) out.push({ name: t, kind: 'extends' });
  }
  return out;
}

function emitTypeRefs(t: Node | null | undefined, ctx: WalkContext) {
  if (!t) return;
  const stack: Node[] = [t];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'type_identifier') {
      if (n.text !== 'Self') ctx.emitRef({ kind: 'type', name: n.text }, n);
      continue;
    }
    if (n.type === 'scoped_type_identifier') {
      const name = n.childForFieldName('name');
      const path = n.childForFieldName('path');
      if (name) ctx.emitRef({ kind: 'type', name: name.text, qualifier: path ? dotted(path.text) : '' }, name);
      continue;
    }
    if (n.type === 'primitive_type' || n.type === 'lifetime') continue;
    for (const c of named(n)) stack.push(c);
  }
}

/** Infer a type from an initializer: `Foo { .. }`, `Foo::new()`, `pkg::Foo::default()`, `Foo(x)`, `Box::new(Foo::new())`. */
function inferType(expr: Node | null | undefined): { type: string; via: 'new' | 'constructor_call' } | null {
  if (!expr) return null;
  if (expr.type === 'struct_expression') {
    const t = rustTypeName(expr.childForFieldName('name'));
    return t && t !== 'Self' ? { type: t, via: 'new' } : null;
  }
  if (expr.type === 'reference_expression' || expr.type === 'try_expression' || expr.type === 'await_expression') return inferType(named(expr)[0]);
  if (expr.type === 'call_expression') {
    const fn = expr.childForFieldName('function');
    if (!fn) return null;
    if (fn.type === 'identifier') return /^\p{Lu}/u.test(fn.text) ? { type: fn.text, via: 'new' } : null;
    if (fn.type === 'scoped_identifier') {
      const path = fn.childForFieldName('path');
      const last = simpleTypeName(path?.text ?? '');
      if (!path || !/^\p{Lu}/u.test(last) || last === 'Self') return null;
      if (WRAPPERS.has(last)) return inferType(named(expr.childForFieldName('arguments'))[0]);
      return { type: dotted(path.text), via: 'constructor_call' };
    }
  }
  return null;
}

/** Emit call references for `ident(...)`, `recv.ident(...)`, `a::b::ident(...)` patterns inside a macro's token tree. */
function scanTokenTree(tt: Node, ctx: WalkContext) {
  const cs = kids(tt);
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]!;
    if (c.type === 'token_tree') {
      scanTokenTree(c, ctx);
      continue;
    }
    if (c.type !== 'identifier') continue;
    const next = cs[i + 1];
    if (!next || next.type !== 'token_tree' || !next.text.startsWith('(')) continue;
    let qualifier = '';
    const sep = cs[i - 1];
    const recv = cs[i - 2];
    if (sep && recv && (sep.type === '.' || sep.type === '::') && (recv.type === 'identifier' || recv.type === 'self')) {
      qualifier = recv.text;
      // one more level: `a.b.c(` / `a::b::c(`
      const sep2 = cs[i - 3];
      const recv2 = cs[i - 4];
      if (sep2 && recv2 && (sep2.type === '.' || sep2.type === '::') && (recv2.type === 'identifier' || recv2.type === 'self')) qualifier = `${recv2.text}.${qualifier}`;
    }
    ctx.emitRef({ kind: /^\p{Lu}/u.test(c.text) && !qualifier ? 'new' : 'call', name: c.text, qualifier }, c);
  }
}

function emitPathImport(path: Node, ctx: WalkContext) {
  // `crate::a::b::f()` / `super::x::f()`: bind the path as a module alias so the resolver can follow it.
  const text = path.text.replace(/\s+/g, '');
  if (!/^(crate|super|self)::/.test(text)) return;
  let seen = pathImports.get(ctx);
  if (!seen) pathImports.set(ctx, (seen = new Set()));
  if (seen.has(text)) return;
  seen.add(text);
  ctx.emitImport({ source: text, names: [], namespace: true, alias: dotted(text), kind: 'static', line: path.startPosition.row + 1 });
}

function emitCallee(fn: Node, arity: number, args: Node[], ctx: WalkContext) {
  switch (fn.type) {
    case 'identifier':
      ctx.emitRef({ kind: /^\p{Lu}/u.test(fn.text) ? 'new' : 'call', name: fn.text, arity }, fn);
      return;
    case 'scoped_identifier': {
      const name = fn.childForFieldName('name');
      const path = fn.childForFieldName('path');
      if (!name) return;
      const q = path ? dotted(path.text) : '';
      if (path && ENV_FNS.has(name.text) && simpleTypeName(path.text) === 'env') {
        const key = args[0]?.type === 'string_literal' ? args[0].text.slice(1, -1) : null;
        if (key !== null && args[0]) ctx.emitRef({ kind: 'config', name: key }, args[0]);
      }
      if (path) emitPathImport(path, ctx);
      ctx.emitRef({ kind: 'call', name: name.text, qualifier: q, arity }, name);
      return;
    }
    case 'field_expression': {
      const field = fn.childForFieldName('field');
      const value = fn.childForFieldName('value');
      if (field) ctx.emitRef({ kind: 'call', name: field.text, qualifier: value ? dotted(value.text) : '', arity }, field);
      return;
    }
    case 'generic_function': {
      const inner = fn.childForFieldName('function');
      if (inner) emitCallee(inner, arity, args, ctx);
      return;
    }
  }
}

function useLeaf(full: string[], alias: string, line: number, kind: Import['kind'], out: Import[]) {
  const last = full[full.length - 1]!;
  if (full.length === 1) {
    out.push({ source: last, names: [], namespace: true, alias: alias || last, kind, line });
    return;
  }
  out.push({ source: full.slice(0, -1).join('::'), names: [{ name: last, alias: alias || last }], namespace: false, alias: '', kind, line });
  // snake_case leaf: may be a module (`use crate::util;` then `util::f()`), bind it as a module alias too.
  if (/^[a-z_]/.test(last)) out.push({ source: full.join('::'), names: [], namespace: true, alias: alias || last, kind, line });
}

function parseUse(node: Node, prefix: string[], line: number, kind: Import['kind'], out: Import[]) {
  switch (node.type) {
    case 'identifier':
    case 'crate':
    case 'super':
    case 'metavariable':
      useLeaf([...prefix, node.text], '', line, kind, out);
      return;
    case 'self':
      if (prefix.length) out.push({ source: prefix.join('::'), names: [], namespace: true, alias: prefix[prefix.length - 1]!, kind, line });
      return;
    case 'scoped_identifier':
      useLeaf([...prefix, ...node.text.replace(/\s+/g, '').split('::')], '', line, kind, out);
      return;
    case 'use_as_clause': {
      const path = node.childForFieldName('path');
      const alias = node.childForFieldName('alias')?.text ?? '';
      if (path) useLeaf([...prefix, ...path.text.replace(/\s+/g, '').split('::')], alias === '_' ? '' : alias, line, kind, out);
      return;
    }
    case 'scoped_use_list': {
      const path = node.childForFieldName('path');
      const list = node.childForFieldName('list');
      const p = path ? [...prefix, ...path.text.replace(/\s+/g, '').split('::')] : prefix;
      if (list) parseUse(list, p, line, kind, out);
      return;
    }
    case 'use_list':
      for (const c of named(node)) parseUse(c, prefix, line, kind, out);
      return;
    case 'use_wildcard': {
      const path = named(node)[0];
      const p = path ? [...prefix, ...path.text.replace(/\s+/g, '').split('::')] : prefix;
      if (p.length) out.push({ source: p.join('::'), names: [], namespace: true, alias: '', kind, line });
      return;
    }
  }
}

function isTestMod(node: Node): boolean {
  const name = node.childForFieldName('name')?.text ?? '';
  if (name === 'tests' || name === 'test') return true;
  return attributesOf(node).some((a) => /^#\[\s*cfg\s*\(\s*test\s*\)/.test(a.text));
}

function fnSignature(node: Node, name: string): string {
  const vis = kids(node).find((c) => c.type === 'visibility_modifier')?.text ?? '';
  const mods = modifiersOf(node);
  const tp = node.childForFieldName('type_parameters')?.text ?? '';
  const params = node.childForFieldName('parameters')?.text ?? '()';
  const ret = node.childForFieldName('return_type');
  return oneLine(`${vis ? vis + ' ' : ''}${mods.length ? mods.join(' ') + ' ' : ''}fn ${name}${tp}${params}${ret ? ' -> ' + ret.text : ''}`);
}

function crateRoot(fromPath: string): string {
  const i = fromPath.lastIndexOf('/src/');
  if (i >= 0) return fromPath.slice(0, i + 4);
  if (fromPath.startsWith('src/')) return 'src';
  return fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
}

function parentDir(d: string): string {
  return d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
}

export const rust: LanguageSupport = {
  id: 'rust',
  grammar: 'rust',
  extensions: ['.rs'],
  classLike: new Set(['impl_item', 'trait_item']),
  skip: new Set(['line_comment', 'block_comment', 'string_literal', 'raw_string_literal', 'char_literal']),

  isTestFile(path) {
    return /(^|\/)(tests|benches)\//.test(path) || /_test\.rs$/.test(path) || /(^|\/)tests?\.rs$/.test(path);
  },

  doc(node) {
    return rustDoc(node);
  },

  moduleDoc(root) {
    const parts: string[] = [];
    for (const c of named(root)) {
      if (c.type === 'inner_attribute_item') continue;
      if (COMMENTS.has(c.type) && (/^\/\/!/.test(c.text) || /^\/\*!/.test(c.text))) {
        parts.push(c.text);
        continue;
      }
      break;
    }
    return parts.length ? cleanDoc(parts) : '';
  },

  definition(node, ctx): DefSpec | null {
    switch (node.type) {
      case 'function_item':
      case 'function_signature_item': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const attrs = attributesOf(node);
        const isTest = attrs.some((a) => TEST_ATTR.test(a.text));
        const parentKind = ctx.scopeDef?.kind;
        const inTraitLike = parentKind === 'trait' || (parentKind === 'class' && ctx.scopeDef?.meta?.trait !== undefined);
        let kind: DefSpec['kind'] = isTest ? 'test' : ctx.inClass ? 'method' : 'function';
        const mods = modifiersOf(node);
        if (node.type === 'function_signature_item') mods.push('abstract');
        if (ctx.inClass && !named(node.childForFieldName('parameters')).some((p) => p.type === 'self_parameter')) mods.push('static');
        return {
          kind,
          name,
          body: node.childForFieldName('body'),
          signature: fnSignature(node, name),
          doc: rustDoc(node),
          modifiers: mods,
          exported: hasVisibility(node) || inTraitLike,
        };
      }
      case 'struct_item':
      case 'union_item': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const tp = node.childForFieldName('type_parameters')?.text ?? '';
        const body = node.childForFieldName('body');
        const tuple = body?.type === 'ordered_field_declaration_list' ? body.text : '';
        const kw = node.type === 'union_item' ? 'union' : 'struct';
        return { kind: 'struct', name, body, signature: oneLine(`${hasVisibility(node) ? 'pub ' : ''}${kw} ${name}${tp}${tuple}`, 200), doc: rustDoc(node), modifiers: kw === 'union' ? ['union'] : [], exported: hasVisibility(node) };
      }
      case 'enum_item': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const tp = node.childForFieldName('type_parameters')?.text ?? '';
        return { kind: 'enum', name, body: node.childForFieldName('body'), signature: oneLine(`${hasVisibility(node) ? 'pub ' : ''}enum ${name}${tp}`), doc: rustDoc(node), exported: hasVisibility(node) };
      }
      case 'enum_variant': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        return { kind: 'enum_member', name, signature: oneLine(node.text, 120), doc: rustDoc(node), exported: true };
      }
      case 'field_declaration': {
        if (ctx.scopeDef?.kind !== 'struct') return null; // enum-variant fields are not symbols
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const t = node.childForFieldName('type');
        return { kind: 'field', name, signature: oneLine(`${hasVisibility(node) ? 'pub ' : ''}${name}: ${t?.text ?? ''}`, 160), doc: rustDoc(node), exported: hasVisibility(node), declaredType: rustTypeName(t) || undefined };
      }
      case 'trait_item': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const tp = node.childForFieldName('type_parameters')?.text ?? '';
        const bounds = node.childForFieldName('bounds');
        const sup = typeRefsFromBounds(bounds);
        return { kind: 'trait', name, body: node.childForFieldName('body'), signature: oneLine(`${hasVisibility(node) ? 'pub ' : ''}trait ${name}${tp}${bounds ? bounds.text : ''}`), doc: rustDoc(node), exported: hasVisibility(node), supertypes: sup, modifiers: kids(node).some((c) => c.type === 'unsafe') ? ['unsafe'] : [] };
      }
      case 'impl_item': {
        const typeNode = node.childForFieldName('type');
        const typeName = rustTypeName(typeNode);
        const name = simpleTypeName(typeName);
        if (!name) return null;
        const traitNode = node.childForFieldName('trait');
        const trait = traitNode ? rustTypeName(traitNode) : '';
        const sup: NonNullable<DefSpec['supertypes']> = [];
        if (trait) sup.push({ name: trait, kind: 'implements' });
        // Link the impl block to its type so member lookup through `self.field` reaches the struct's fields.
        if (typeName !== 'Self') sup.push({ name: typeName, kind: 'extends' });
        const tp = node.childForFieldName('type_parameters')?.text ?? '';
        const meta: DefSpec['meta'] = { impl: true };
        if (trait) meta.trait = trait;
        return {
          kind: 'class',
          name,
          body: node.childForFieldName('body'),
          signature: oneLine(`impl${tp} ${trait ? traitNode!.text + ' for ' : ''}${typeNode?.text ?? name}`),
          doc: rustDoc(node),
          exported: false,
          supertypes: sup,
          meta,
        };
      }
      case 'const_item':
      case 'static_item': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const t = node.childForFieldName('type');
        const value = node.childForFieldName('value');
        const mods: string[] = [];
        if (node.type === 'static_item') mods.push('static');
        if (kids(node).some((c) => c.type === 'mutable_specifier')) mods.push('mut');
        return { kind: 'constant', name, signature: oneLine(`${hasVisibility(node) ? 'pub ' : ''}${node.type === 'static_item' ? 'static' : 'const'} ${name}${t ? ': ' + t.text : ''}${value ? ' = ' + value.text : ''}`, 160), doc: rustDoc(node), modifiers: mods, exported: hasVisibility(node) || ctx.scopeDef?.kind === 'trait', declaredType: rustTypeName(t) || undefined };
      }
      case 'type_item':
      case 'associated_type': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const t = node.childForFieldName('type');
        return { kind: 'type_alias', name, signature: oneLine(`${hasVisibility(node) ? 'pub ' : ''}type ${name}${node.childForFieldName('type_parameters')?.text ?? ''}${t ? ' = ' + t.text : ''}`, 200), doc: rustDoc(node), exported: hasVisibility(node) || ctx.inClass, declaredType: rustTypeName(t) || undefined };
      }
      case 'mod_item': {
        const body = node.childForFieldName('body');
        if (!body) return null; // `mod foo;` is an import
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const test = isTestMod(node);
        return { kind: test ? 'test' : 'namespace', name, body, signature: `${hasVisibility(node) ? 'pub ' : ''}mod ${name}`, doc: rustDoc(node), exported: hasVisibility(node) };
      }
      case 'macro_definition': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const exported = attributesOf(node).some((a) => /^#\[\s*macro_export\b/.test(a.text)) || hasVisibility(node);
        return { kind: 'macro', name, body: node, signature: `macro_rules! ${name}`, doc: rustDoc(node), exported };
      }
    }
    return null;
  },

  imports(node): Import[] | null {
    const line = node.startPosition.row + 1;
    if (node.type === 'use_declaration') {
      const arg = node.childForFieldName('argument');
      if (!arg) return [];
      const out: Import[] = [];
      parseUse(arg, [], line, hasVisibility(node) ? 'reexport' : 'static', out);
      return out;
    }
    if (node.type === 'mod_item' && !node.childForFieldName('body')) {
      const name = node.childForFieldName('name')?.text ?? '';
      return name ? [{ source: `mod:${name}`, names: [], namespace: true, alias: name, kind: 'static', line }] : [];
    }
    if (node.type === 'extern_crate_declaration') {
      const name = node.childForFieldName('name')?.text ?? '';
      const alias = node.childForFieldName('alias')?.text ?? name;
      return name ? [{ source: name, names: [], namespace: true, alias, kind: 'static', line }] : [];
    }
    return null;
  },

  references(node, ctx) {
    switch (node.type) {
      case 'call_expression': {
        const fn = node.childForFieldName('function');
        const args = named(node.childForFieldName('arguments'));
        if (fn) emitCallee(fn, args.length, args, ctx);
        return;
      }
      case 'macro_invocation': {
        const m = node.childForFieldName('macro');
        const tt = named(node).find((c) => c.type === 'token_tree');
        if (m) {
          const name = m.type === 'scoped_identifier' ? m.childForFieldName('name')?.text ?? '' : m.text;
          const q = m.type === 'scoped_identifier' ? dotted(m.childForFieldName('path')?.text ?? '') : '';
          if (name) ctx.emitRef({ kind: 'call', name, qualifier: q }, m);
          if (ENV_MACROS.has(name) && tt) {
            const s = named(tt)[0];
            if (s?.type === 'string_literal') ctx.emitRef({ kind: 'config', name: s.text.slice(1, -1) }, s);
          }
        }
        if (tt) scanTokenTree(tt, ctx);
        return true;
      }
      case 'struct_expression': {
        const nameNode = node.childForFieldName('name');
        const t = rustTypeName(nameNode);
        if (t && t !== 'Self' && nameNode) ctx.emitRef({ kind: 'new', name: simpleTypeName(t), qualifier: qualifierOf(t), arity: named(node.childForFieldName('body')).length }, nameNode);
        return;
      }
      case 'scoped_identifier': {
        // value position: `Role::Admin`, `Foo::bar` passed as a value
        const p = node.parent?.type ?? '';
        if (['call_expression', 'scoped_identifier', 'scoped_type_identifier', 'generic_function', 'attribute', 'use_declaration', 'scoped_use_list', 'use_as_clause', 'use_wildcard', 'macro_invocation', 'field_expression'].includes(p)) {
          if (p === 'field_expression') {
            const path = node.childForFieldName('path');
            if (path) emitPathImport(path, ctx);
          }
          return true;
        }
        const name = node.childForFieldName('name');
        const path = node.childForFieldName('path');
        if (name && path) {
          emitPathImport(path, ctx);
          ctx.emitRef({ kind: 'value', name: name.text, qualifier: dotted(path.text) }, name);
        }
        return true;
      }
      case 'type_identifier': {
        const p = node.parent;
        if (p && NAME_HOLDERS.has(p.type) && p.childForFieldName('name')?.id === node.id) return true;
        if (p?.type === 'impl_item' || p?.type === 'struct_expression') return true;
        if (node.text !== 'Self') ctx.emitRef({ kind: 'type', name: node.text }, node);
        return true;
      }
      case 'scoped_type_identifier': {
        if (node.parent?.type === 'struct_expression' || node.parent?.type === 'impl_item') return true;
        emitTypeRefs(node, ctx);
        return true;
      }
      case 'parameter': {
        const pat = node.childForFieldName('pattern');
        const t = node.childForFieldName('type');
        if (pat?.type === 'identifier' && t) {
          const tn = rustTypeName(t);
          if (tn) ctx.emitLocalType({ name: pat.text, type: tn, via: 'annotation' });
        }
        return;
      }
      case 'let_declaration': {
        const pat = node.childForFieldName('pattern');
        const t = node.childForFieldName('type');
        const value = node.childForFieldName('value');
        if (pat?.type === 'identifier') {
          const tn = t ? rustTypeName(t) : '';
          if (tn) ctx.emitLocalType({ name: pat.text, type: tn, via: 'annotation' });
          else {
            const inf = inferType(value);
            if (inf) ctx.emitLocalType({ name: pat.text, type: inf.type, via: inf.via });
          }
        }
        return;
      }
      case 'assignment_expression': {
        const left = node.childForFieldName('left');
        if (left && (left.type === 'identifier' || left.type === 'field_expression')) {
          const inf = inferType(node.childForFieldName('right'));
          if (inf) ctx.emitLocalType({ name: dotted(left.text), type: inf.type, via: inf.via });
        }
        return;
      }
      case 'attribute_item': {
        const attr = named(node)[0];
        const head = attr ? named(attr)[0] : null;
        if (!head) return true;
        const name = head.type === 'scoped_identifier' ? head.childForFieldName('name')?.text ?? '' : head.text;
        const q = head.type === 'scoped_identifier' ? dotted(head.childForFieldName('path')?.text ?? '') : '';
        if (name === 'derive') {
          for (const d of named(attr?.childForFieldName('arguments'))) {
            if (d.type === 'identifier') ctx.emitRef({ kind: 'decorator', name: d.text }, d);
            else if (d.type === 'scoped_identifier') {
              const n = d.childForFieldName('name');
              if (n) ctx.emitRef({ kind: 'decorator', name: n.text, qualifier: dotted(d.childForFieldName('path')?.text ?? '') }, n);
            }
          }
        } else if (name && !SKIP_ATTRS.has(name)) ctx.emitRef({ kind: 'decorator', name, qualifier: q }, head);
        return true;
      }
      case 'inner_attribute_item':
        return true;
      case 'identifier': {
        // bare name in value position: call argument, array element, struct field initializer
        const p = node.parent;
        if (p && (p.type === 'arguments' || p.type === 'array_expression' || (p.type === 'field_initializer' && p.childForFieldName('value')?.id === node.id)) && !/^(self|Self|None|true|false)$/.test(node.text)) ctx.emitRef({ kind: 'value', name: node.text }, node);
        return;
      }
    }
    return;
  },

  postWalk: reparentReopenedBlocks,

  resolveModule(source, fromPath, _imp, _project) {
    const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
    const base = fromPath.slice(fromPath.lastIndexOf('/') + 1);
    const stem = base.replace(/\.rs$/, '');
    const isRoot = ROOT_FILES.has(base);
    // Directory holding this module's child modules (`mod x;` / `self::x`).
    const selfDir = isRoot ? dir : dir ? `${dir}/${stem}` : stem;
    const root = crateRoot(fromPath);
    const join = (a: string, b: string) => (a ? (b ? `${a}/${b}` : a) : b);
    const filesFor = (baseDir: string, rest: string[]): string[] => {
      if (!rest.length) return [join(baseDir, 'mod.rs'), join(baseDir, 'lib.rs'), join(baseDir, 'main.rs'), `${baseDir}.rs`];
      const p = join(baseDir, rest.join('/'));
      return [`${p}.rs`, `${p}/mod.rs`, `${p}/lib.rs`];
    };
    if (source.startsWith('mod:')) {
      const name = source.slice(4);
      return [join(selfDir, `${name}.rs`), join(selfDir, `${name}/mod.rs`)];
    }
    const segs = source.split('::').filter(Boolean);
    const out: string[] = [];
    const head = segs[0] ?? '';
    if (head === 'crate') {
      out.push(...filesFor(root, segs.slice(1)));
      if (root !== 'src') out.push(...filesFor('src', segs.slice(1)));
    } else if (head === 'self') {
      out.push(...filesFor(selfDir, segs.slice(1)));
    } else if (head === 'super') {
      let d = isRoot ? parentDir(dir) : dir; // parent module's directory
      let i = 1;
      while (segs[i] === 'super') {
        d = parentDir(d);
        i++;
      }
      // the parent module itself vs. a sibling inside it
      const rest = segs.slice(i);
      if (!rest.length) out.push(join(d, 'mod.rs'), `${d}.rs`, join(d, 'lib.rs'), join(d, 'main.rs'));
      else out.push(...filesFor(d, rest));
    } else {
      // 2018 uniform paths: a local module in scope, a crate-root module, or an external workspace crate.
      out.push(...filesFor(selfDir, segs));
      out.push(...filesFor(root, segs));
      const hy = head.replace(/_/g, '-');
      const rest = segs.slice(1);
      for (const crateDir of [`crates/${head}`, `crates/${hy}`, head, hy, `libs/${head}`, `libs/${hy}`, `packages/${head}`, `packages/${hy}`]) {
        out.push(...filesFor(`${crateDir}/src`, rest).filter((f) => rest.length || /lib\.rs$/.test(f)));
      }
    }
    return [...new Set(out)];
  },
};
