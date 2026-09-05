import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, named, simpleTypeName } from '../parse/walk.js';

/** Base names that add no signal as call edges. */
const SKIP_CALLS = new Set([
  'println', 'print', 'show', 'string', 'length', 'push!', 'pop!', 'get', 'get!', 'haskey', 'keys',
  'values', 'first', 'last', 'isempty', 'error', 'throw', 'typeof', 'convert', 'parse', 'map',
  'filter', 'reduce', 'sort', 'sort!', 'collect', 'zip', 'enumerate', 'min', 'max', 'sum', 'abs',
  'return', 'include', 'lowercase', 'uppercase', 'strip', 'split', 'join', 'repeat', 'copy',
]);
/** Type names that are containers, not project types. */
const BUILTIN_TYPES = new Set(['Int', 'Int8', 'Int16', 'Int32', 'Int64', 'UInt', 'UInt8', 'UInt32', 'UInt64', 'Float32', 'Float64', 'Bool', 'Char', 'String', 'Symbol', 'Any', 'Nothing', 'Missing', 'Number', 'Real', 'AbstractString', 'Vector', 'Matrix', 'Array', 'Dict', 'Set', 'Tuple', 'NamedTuple', 'Union', 'Ref']);
const TEST_MACROS = new Set(['testset', 'test', 'test_throws', 'test_broken', 'test_skip', 'testitem']);
/** Containers whose children are module-level items. */
const ITEM_CONTAINERS = new Set(['source_file', 'module_definition']);

interface State {
  exports: Set<string> | null;
  /** `${containerId}|${name}` → number of method definitions seen with that name. */
  methods: Map<string, number>;
  emitted: Set<string>;
}

const states = new WeakMap<WalkContext, State>();

function rootOf(node: Node): Node {
  let n = node;
  while (n.parent) n = n.parent;
  return n;
}

function collectExports(n: Node, out: Set<string>): void {
  for (const c of named(n)) {
    if (c.type === 'export_statement') {
      for (const e of named(c)) if (e.type === 'identifier' || e.type === 'operator' || e.type === 'macro_identifier') out.add(e.text);
    } else if (c.type === 'module_definition') {
      collectExports(c, out);
    }
  }
}

function stateFor(node: Node, ctx: WalkContext): State {
  let s = states.get(ctx);
  if (s) return s;
  const set = new Set<string>();
  collectExports(rootOf(node), set);
  s = { exports: set.size ? set : null, methods: new Map(), emitted: new Set() };
  states.set(ctx, s);
  return s;
}

function stringContent(n: Node | null | undefined): string {
  if (!n || n.type !== 'string_literal') return '';
  return named(n)
    .filter((c) => c.type === 'content')
    .map((c) => c.text)
    .join('');
}

/** A `"""…"""` docstring sitting immediately before a definition. */
function julDoc(node: Node): string {
  let prev = node.previousNamedSibling;
  while (prev && (prev.type === 'line_comment' || prev.type === 'block_comment')) prev = prev.previousNamedSibling;
  if (!prev || prev.type !== 'string_literal') return '';
  if (node.startPosition.row - prev.endPosition.row > 1) return '';
  const raw = stringContent(prev);
  return raw
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

/** `f(a, b)` head of a `signature` / short-form assignment. */
function callHead(n: Node | null | undefined): { name: string; nameNode: Node; args: Node[] } | null {
  let call: Node | null | undefined = n;
  if (call?.type === 'signature') call = named(call)[0];
  // `f(x)::T = …` and `f(x) where {T}` wrap the call.
  while (call && (call.type === 'typed_expression' || call.type === 'where_expression' || call.type === 'unary_typed_expression')) call = named(call)[0];
  if (!call || call.type !== 'call_expression') return null;
  const id = named(call)[0];
  if (!id) return null;
  const argList = named(call).find((c) => c.type === 'argument_list');
  const nameNode = id.type === 'field_expression' ? named(id)[named(id).length - 1]! : id;
  if (nameNode.type !== 'identifier' && nameNode.type !== 'operator') return null;
  return { name: nameNode.text, nameNode, args: named(argList) };
}

/** `Row <: Storable` → { name: 'Row', supertype: 'Storable' } */
function typeHead(node: Node): { name: string; supertype: string } | null {
  const head = named(node).find((c) => c.type === 'type_head');
  const inner = head ? named(head)[0] : null;
  if (!inner) return null;
  if (inner.type === 'binary_expression') {
    const parts = named(inner);
    const left = parts[0];
    const right = parts[parts.length - 1];
    if (!left) return null;
    return { name: simpleTypeName(left.text), supertype: right && right !== left ? right.text : '' };
  }
  return { name: simpleTypeName(inner.text), supertype: '' };
}

function isItem(node: Node): boolean {
  let p = node.parent;
  // `@trace function f() end` keeps the definition at item level.
  while (p && (p.type === 'macro_argument_list' || p.type === 'macrocall_expression')) p = p.parent;
  return !!p && ITEM_CONTAINERS.has(p.type);
}

/** True when this `call_expression` is a definition head rather than a call. */
function isDeclHead(node: Node): boolean {
  let n: Node = node;
  let p = n.parent;
  while (p && (p.type === 'typed_expression' || p.type === 'where_expression' || p.type === 'unary_typed_expression')) {
    n = p;
    p = p.parent;
  }
  if (!p) return false;
  if (p.type === 'signature') return true;
  if (p.type === 'assignment' && named(p)[0]?.equals(n)) return isItem(p) || p.parent?.type === 'struct_definition';
  return false;
}

/** Julia type names carry `{…}` parameters that `simpleTypeName` does not strip. */
function jlTypeName(text: string): string {
  return simpleTypeName(text.split('{')[0] ?? text);
}

function macroName(node: Node): string {
  const id = named(node).find((c) => c.type === 'macro_identifier');
  return id ? id.text.replace(/^@/, '') : '';
}

export const julia: LanguageSupport = {
  id: 'julia',
  grammar: 'julia',
  extensions: ['.jl'],
  classLike: new Set(['struct_definition', 'abstract_definition', 'primitive_definition']),
  skip: new Set(['line_comment', 'block_comment', 'string_literal', 'command_literal', 'prefixed_string_literal']),

  isTestFile(path) {
    return /(^|\/)test\//.test(path) || /(^|\/)test_[^/]*\.jl$/.test(path) || /_test\.jl$/.test(path) || /(^|\/)runtests\.jl$/.test(path);
  },

  doc(node) {
    return julDoc(node);
  },

  moduleDoc(root) {
    const first = named(root)[0];
    if (first?.type === 'string_literal') {
      return stringContent(first)
        .split('\n')
        .map((l) => l.trim())
        .join('\n')
        .trim();
    }
    return '';
  },

  definition(node, ctx): DefSpec | null {
    const st = () => stateFor(node, ctx);
    switch (node.type) {
      case 'module_definition': {
        const nm = node.childForFieldName('name') ?? named(node)[0];
        if (!nm) return null;
        const bare = node.children.some((c) => c?.type === 'baremodule');
        return { kind: 'namespace', name: nm.text, signature: oneLine(`module ${nm.text}`), doc: julDoc(node), exported: true, modifiers: bare ? ['bare'] : [] };
      }
      case 'struct_definition': {
        const head = typeHead(node);
        if (!head) return null;
        const mutable = node.children.some((c) => c?.type === 'mutable');
        const sup: NonNullable<DefSpec['supertypes']> = head.supertype ? [{ name: head.supertype, kind: 'extends' }] : [];
        return {
          kind: 'struct',
          name: head.name,
          signature: oneLine(`${mutable ? 'mutable ' : ''}struct ${head.name}${head.supertype ? ' <: ' + head.supertype : ''}`, 200),
          doc: julDoc(node),
          modifiers: mutable ? ['mutable'] : [],
          exported: st().exports?.has(head.name) ?? true,
          supertypes: sup,
        };
      }
      case 'abstract_definition':
      case 'primitive_definition': {
        const head = typeHead(node);
        if (!head) return null;
        return {
          kind: node.type === 'abstract_definition' ? 'interface' : 'struct',
          name: head.name,
          signature: oneLine(node.text, 160),
          doc: julDoc(node),
          modifiers: node.type === 'abstract_definition' ? ['abstract'] : ['primitive'],
          exported: st().exports?.has(head.name) ?? true,
          supertypes: head.supertype ? [{ name: head.supertype, kind: 'extends' }] : [],
        };
      }
      case 'const_statement': {
        const asg = named(node).find((c) => c.type === 'assignment');
        const lhs = asg ? named(asg)[0] : null;
        if (!lhs || (lhs.type !== 'identifier' && lhs.type !== 'typed_expression')) return null;
        const name = lhs.type === 'typed_expression' ? (named(lhs)[0]?.text ?? '') : lhs.text;
        if (!name) return null;
        const t = lhs.type === 'typed_expression' ? named(lhs)[1] : null;
        return { kind: 'constant', name, signature: oneLine(node.text, 160), doc: julDoc(node), declaredType: t ? jlTypeName(t.text) : undefined, exported: st().exports?.has(name) ?? true };
      }
      case 'macro_definition': {
        const head = callHead(named(node).find((c) => c.type === 'signature'));
        if (!head) return null;
        return { kind: 'macro', name: head.name, signature: oneLine(`macro ${head.name}(${head.args.map((a) => a.text).join(', ')})`, 200), doc: julDoc(node), exported: st().exports?.has(head.name) ?? true, meta: { arity: head.args.length } };
      }
      case 'function_definition':
      case 'assignment': {
        const isShort = node.type === 'assignment';
        if (isShort && !isItem(node) && !ctx.inClass) return null;
        const head = callHead(isShort ? named(node)[0] : named(node).find((c) => c.type === 'signature'));
        if (!head) return null;
        // Struct fields inside a struct body are `typed_expression`, not assignments; an assignment
        // there is an inner constructor.
        const s = st();
        const key = `${node.parent?.id ?? 0}|${head.name}`;
        const seen = s.methods.get(key) ?? 0;
        s.methods.set(key, seen + 1);
        if (seen > 0) return null; // another method of the same generic function: one symbol per name
        // Count every sibling method up front so the single symbol reports the real method count.
        let methods = 0;
        for (const sib of named(node.parent)) {
          if (sib.type === 'function_definition') {
            const h = callHead(named(sib).find((c) => c.type === 'signature'));
            if (h?.name === head.name) methods++;
          } else if (sib.type === 'assignment') {
            const h = callHead(named(sib)[0]);
            if (h?.name === head.name) methods++;
          }
        }
        const params = head.args.map((a) => a.text).join(', ');
        return {
          kind: ctx.inClass ? 'method' : 'function',
          name: head.name,
          signature: oneLine(`${isShort ? '' : 'function '}${head.name}(${params})`, 200),
          doc: julDoc(node),
          exported: s.exports?.has(head.name) ?? true,
          meta: { arity: head.args.length, methods: Math.max(methods, 1) },
        };
      }
      case 'typed_expression': {
        // Struct field: `id::Int` directly inside a struct body.
        if (node.parent?.type !== 'struct_definition') return null;
        const parts = named(node);
        const nm = parts[0];
        const t = parts[1];
        if (!nm || nm.type !== 'identifier') return null;
        return { kind: 'field', name: nm.text, signature: oneLine(node.text, 160), declaredType: t ? jlTypeName(t.text) : undefined, exported: true };
      }
      case 'macrocall_expression': {
        const mn = macroName(node);
        if (mn !== 'testset' && mn !== 'testitem') return null;
        const args = named(node).find((c) => c.type === 'macro_argument_list');
        const title = stringContent(named(args)[0]) || mn;
        return { kind: 'test', name: title, signature: oneLine(`@${mn} "${title}"`), meta: { framework: 'Test', title }, exported: false };
      }
    }
    return null;
  },

  imports(node): Import[] | null {
    const line = node.startPosition.row + 1;
    if (node.type === 'using_statement' || node.type === 'import_statement') {
      const out: Import[] = [];
      const kind = node.type === 'import_statement' ? 'static' : 'static';
      for (const c of named(node)) {
        if (c.type === 'selected_import') {
          const parts = named(c);
          const mod = parts[0];
          if (!mod) continue;
          const names: Import['names'] = [];
          for (const n of parts.slice(1)) {
            if (n.type === 'import_alias') {
              const a = named(n);
              names.push({ name: a[0]?.text ?? '', alias: a[1]?.text ?? a[0]?.text ?? '' });
            } else if (n.type === 'identifier' || n.type === 'operator' || n.type === 'macro_identifier') {
              names.push({ name: n.text, alias: n.text });
            }
          }
          out.push({ source: mod.text, names, namespace: names.length === 0, alias: '', kind, line });
        } else if (c.type === 'identifier' || c.type === 'scoped_identifier' || c.type === 'import_path') {
          const src = c.text;
          out.push({ source: src, names: [], namespace: true, alias: src.slice(src.lastIndexOf('.') + 1), kind, line });
        } else if (c.type === 'import_alias') {
          const a = named(c);
          const src = a[0]?.text ?? '';
          if (src) out.push({ source: src, names: [], namespace: true, alias: a[1]?.text ?? src, kind, line });
        }
      }
      return out;
    }
    if (node.type === 'call_expression') {
      const fn = named(node)[0];
      if (fn?.type !== 'identifier' || fn.text !== 'include') return null;
      const args = named(node).find((c) => c.type === 'argument_list');
      const path = stringContent(named(args)[0]);
      if (!path) return null;
      return [{ source: path, names: [], namespace: true, alias: '', kind: 'static', line }];
    }
    return null;
  },

  references(node, ctx) {
    switch (node.type) {
      case 'using_statement':
      case 'import_statement':
      case 'export_statement':
        return true;
      case 'call_expression': {
        if (isDeclHead(node)) return;
        const fn = named(node)[0];
        const args = named(node).find((c) => c.type === 'argument_list');
        const arity = named(args).length;
        if (!fn) return;
        if (fn.type === 'identifier') {
          const name = fn.text;
          if (name === 'get' || name === 'get!') {
            const a = named(args);
            if (a[0]?.text === 'ENV') {
              const key = stringContent(a[1]);
              if (key) ctx.emitRef({ kind: 'config', name: key }, a[1]!);
            }
          }
          const isNew = /^[A-Z]/.test(name);
          if (!SKIP_CALLS.has(name) && !(isNew && BUILTIN_TYPES.has(name))) ctx.emitRef({ kind: isNew ? 'new' : 'call', name, arity }, fn);
        } else if (fn.type === 'field_expression') {
          const parts = named(fn);
          const last = parts[parts.length - 1]!;
          const qual = fn.text.slice(0, fn.text.lastIndexOf('.'));
          if (qual === 'ENV' || (qual === 'Base' && last.text === 'get')) {
            const key = stringContent(named(args)[0]);
            if (key) ctx.emitRef({ kind: 'config', name: key }, last);
          }
          ctx.emitRef({ kind: /^[A-Z]/.test(last.text) ? 'new' : 'call', name: last.text, qualifier: qual, arity }, last);
        } else if (fn.type === 'parametrized_type_expression') {
          const base = named(fn)[0];
          const tn = base ? jlTypeName(base.text) : '';
          if (base && tn && !BUILTIN_TYPES.has(tn)) ctx.emitRef({ kind: 'new', name: tn, arity }, base);
        }
        return;
      }
      case 'index_expression': {
        const v = named(node)[0];
        if (v?.type === 'identifier' && v.text === 'ENV') {
          const idx = named(node)[1];
          const key = stringContent(idx?.type === 'vector_expression' ? named(idx)[0] : idx);
          if (key) ctx.emitRef({ kind: 'config', name: key }, idx ?? node);
        }
        return;
      }
      case 'macrocall_expression': {
        const mn = macroName(node);
        if (mn && !TEST_MACROS.has(mn)) ctx.emitRef({ kind: 'decorator', name: mn }, node);
        return;
      }
      case 'typed_expression':
      case 'unary_typed_expression': {
        const parts = named(node);
        const nm = parts.length > 1 ? parts[0] : null;
        const t = parts.length > 1 ? parts[1] : parts[0];
        if (t) {
          const base = t.type === 'parametrized_type_expression' ? named(t)[0] : t;
          const tn = jlTypeName(base?.text ?? t.text);
          if (tn && !BUILTIN_TYPES.has(tn)) ctx.emitRef({ kind: 'type', name: tn }, base ?? t);
          if (nm && nm.type === 'identifier' && node.parent?.type !== 'struct_definition') ctx.emitLocalType({ name: nm.text, type: tn, via: 'annotation' });
        }
        return;
      }
      case 'parametrized_type_expression': {
        if (node.parent?.type === 'call_expression' && named(node.parent)[0]?.equals(node)) return;
        const base = named(node)[0];
        if (base) {
          const tn = jlTypeName(base.text);
          if (tn && !BUILTIN_TYPES.has(tn)) ctx.emitRef({ kind: 'type', name: tn }, base);
        }
        return;
      }
      case 'field_expression': {
        const p = node.parent;
        if (p?.type === 'call_expression' && named(p)[0]?.equals(node)) return true;
        const parts = named(node);
        const last = parts[parts.length - 1]!;
        ctx.emitRef({ kind: 'value', name: last.text, qualifier: node.text.slice(0, node.text.lastIndexOf('.')) }, last);
        return true;
      }
    }
    return;
  },

  resolveModule(source, fromPath) {
    // `include("rel/path.jl")`
    if (/\.jl$/.test(source)) {
      const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
      const parts = (dir ? `${dir}/${source}` : source).split('/');
      const out: string[] = [];
      for (const seg of parts) {
        if (seg === '.' || seg === '') continue;
        if (seg === '..') out.pop();
        else out.push(seg);
      }
      return [out.join('/'), source];
    }
    const segs = source.split('.').filter(Boolean);
    if (!segs.length) return [];
    const first = segs[0]!;
    const last = segs[segs.length - 1]!;
    const out: string[] = [];
    for (const root of ['src', '', 'lib', 'test']) {
      const p = root ? `${root}/` : '';
      out.push(`${p}${segs.join('/')}.jl`, `${p}${last}.jl`, `${p}${first}.jl`);
    }
    out.push(`${first}/src/${first}.jl`, `packages/${first}/src/${first}.jl`);
    return [...new Set(out)];
  },
};
