import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport } from './types.js';
import { oneLine, named } from '../parse/walk.js';

const FN_KW = new Set(['def', 'defp', 'defmacro', 'defmacrop', 'defguard', 'defguardp', 'defdelegate']);
const MOD_KW = new Set(['defmodule', 'defprotocol', 'defimpl']);
const TEST_KW = new Set(['test', 'describe']);
const IMPORT_KW = new Set(['alias', 'import', 'require', 'use']);
const HTTP_KW = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'live']);
/** Kernel / macro names that are not project calls. */
const SKIP_CALLS = new Set(['quote', 'unquote', 'unquote_splicing', 'assert', 'refute', 'assert_raise', 'assert_receive', 'assert_received', 'raise', 'reraise', 'throw', 'send', 'spawn', 'spawn_link', 'apply', 'if', 'unless', 'case', 'cond', 'with', 'for', 'receive', 'try', 'fn', 'when', 'and', 'or', 'not', 'in', 'is_atom', 'is_binary', 'is_bitstring', 'is_boolean', 'is_float', 'is_function', 'is_integer', 'is_list', 'is_map', 'is_nil', 'is_number', 'is_pid', 'is_port', 'is_reference', 'is_tuple', 'is_struct', 'is_exception', 'length', 'hd', 'tl', 'elem', 'put_elem', 'tuple_size', 'map_size', 'byte_size', 'bit_size', 'binary_part', 'div', 'rem', 'abs', 'round', 'trunc', 'max', 'min', 'inspect', 'to_string', 'to_charlist', 'struct', 'struct!', 'update_in', 'put_in', 'get_in', 'pop_in', 'match?', 'def', 'defp', 'defmacro', 'defmacrop', 'defguard', 'defguardp', 'defdelegate', 'defmodule', 'defprotocol', 'defimpl', 'defstruct', 'defexception', 'defoverridable', 'test', 'describe', 'setup', 'setup_all', 'doctest', 'field', 'belongs_to', 'has_many', 'has_one', 'many_to_many', 'embeds_one', 'embeds_many', 'timestamps', 'schema', 'embedded_schema', 'plug', 'pipe_through', 'scope', 'pipeline', 'forward', 'socket', 'channel', 'resources', 'embed_templates', 'attr', 'slot', 'import', 'alias', 'require', 'use', 'super', 'binding', 'exit', 'self', 'node', 'make_ref', 'function_exported?', 'macro_exported?', 'is_map_key', 'sigil_r', 'sigil_s', 'sigil_w', 'var!', 'dbg', 'tap', 'then', 'render', 'assign', 'assigns', 'json', 'html', 'redirect', 'halt', 'conn', 'push_navigate', 'push_patch', 'put_flash']);
const META_ATTRS = new Set(['moduledoc', 'doc', 'spec', 'behaviour', 'impl', 'derive', 'before_compile', 'after_compile', 'on_definition', 'external_resource', 'deprecated', 'dialyzer', 'compile', 'typedoc', 'vsn', 'enforce_keys', 'optional_callbacks', 'tag', 'describetag', 'moduletag', 'since', 'doctest', 'primary_key', 'foreign_key_type', 'schema_prefix', 'timestamps_opts', 'on_load', 'after_verify', 'file', 'nifs', 'behavior', 'callback', 'macrocallback', 'type', 'typep', 'opaque', 'endpoint', 'derive', 'on_mount', 'impl']);

function callTarget(node: Node): string {
  if (node.type !== 'call') return '';
  const t = node.childForFieldName('target');
  return t?.type === 'identifier' ? t.text : '';
}

function argsOf(node: Node): Node[] {
  return named(named(node).find((c) => c.type === 'arguments'));
}

function doBlock(node: Node): Node | null {
  return named(node).find((c) => c.type === 'do_block') ?? null;
}

/** `@name args` → { name, args } */
function attrOf(node: Node): { name: string; args: Node[] } | null {
  if (node.type !== 'unary_operator' || node.childForFieldName('operator')?.text !== '@') return null;
  const op = node.childForFieldName('operand');
  if (!op || op.type !== 'call') return null;
  return { name: callTarget(op), args: argsOf(op) };
}

function stringContent(s: Node | null | undefined): string {
  if (!s) return '';
  if (s.type !== 'string' && s.type !== 'charlist' && s.type !== 'sigil') return '';
  const inner = named(s).filter((c) => c.type === 'quoted_content').map((c) => c.text).join('');
  const lines = inner.split('\n').map((l) => l.trim());
  return lines.join('\n').trim();
}

function keywordValue(args: Node[], key: string): Node | null {
  const kw = args.find((a) => a.type === 'keywords');
  for (const pair of named(kw)) {
    const k = pair.childForFieldName('key')?.text.replace(/:\s*$/, '');
    if (k === key) return pair.childForFieldName('value');
  }
  return null;
}

/** The `@doc` immediately preceding a definition (skipping @spec & co). */
function docBefore(node: Node): string {
  let prev = node.previousNamedSibling;
  while (prev) {
    const a = attrOf(prev);
    if (!a) break;
    if (a.name === 'doc') return stringContent(a.args[0]);
    if (a.name === 'moduledoc') break;
    prev = prev.previousNamedSibling;
  }
  return '';
}

function moduleDocOf(body: Node | null): string {
  for (const c of named(body)) {
    const a = attrOf(c);
    if (a?.name === 'moduledoc') return stringContent(a.args[0]);
  }
  return '';
}

/** Head of `def name(args) when guard` → the `name(args)` call or bare identifier. */
function defHead(node: Node): Node | null {
  let first = argsOf(node)[0] ?? null;
  if (first?.type === 'binary_operator' && first.childForFieldName('operator')?.text === 'when') first = first.childForFieldName('left');
  return first;
}

function isDefHead(node: Node): boolean {
  let n: Node = node;
  const p = n.parent;
  if (p?.type === 'binary_operator' && p.childForFieldName('left')?.equals(n)) n = p;
  const args = n.parent;
  const call = args?.parent;
  if (args?.type !== 'arguments' || call?.type !== 'call') return false;
  const kw = callTarget(call);
  const first = named(args)[0];
  return (FN_KW.has(kw) || kw === 'callback') && !!first && first.equals(n);
}

/** Inside `@spec` / `@type` / `@doc` …: those are annotations, not calls. */
function insideAttribute(node: Node): boolean {
  let p = node.parent;
  while (p) {
    if (p.type === 'unary_operator' && p.childForFieldName('operator')?.text === '@') return true;
    if (p.type === 'do_block' || p.type === 'source') return false;
    p = p.parent;
  }
  return false;
}

function lastSegment(alias: string): string {
  return alias.slice(alias.lastIndexOf('.') + 1);
}

function underscore(s: string): string {
  return s.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase();
}

export const elixir: LanguageSupport = {
  id: 'elixir',
  grammar: 'elixir',
  extensions: ['.ex', '.exs'],
  classLike: new Set(),
  skip: new Set(['comment', 'string', 'charlist', 'sigil']),

  isTestFile(path) {
    return /(^|\/)test\//.test(path) || /_test\.exs$/.test(path);
  },

  doc(node) {
    return docBefore(node);
  },

  moduleDoc(root) {
    const first = named(root).find((c) => c.type === 'call' && callTarget(c) === 'defmodule');
    return first ? moduleDocOf(doBlock(first)) : '';
  },

  definition(node, ctx): DefSpec | null {
    if (node.type === 'unary_operator') {
      const a = attrOf(node);
      if (!a || !a.args.length || ctx.scopeDef?.kind !== 'namespace') return null;
      if (a.name === 'type' || a.name === 'typep' || a.name === 'opaque') {
        const spec = a.args[0];
        const left = spec?.type === 'binary_operator' ? spec.childForFieldName('left') : spec;
        const name = left ? (left.type === 'call' ? callTarget(left) : left.type === 'identifier' ? left.text : '') : '';
        if (!name) return null;
        return { kind: 'type_alias', name, signature: oneLine(node.text, 200), exported: a.name !== 'typep', modifiers: a.name === 'typep' ? ['private'] : [] };
      }
      if (a.name === 'callback' || a.name === 'macrocallback') {
        const spec = a.args[0];
        const left = spec?.type === 'binary_operator' ? spec.childForFieldName('left') : spec;
        const name = left ? (left.type === 'call' ? callTarget(left) : left.type === 'identifier' ? left.text : '') : '';
        if (!name) return null;
        return { kind: a.name === 'callback' ? 'function' : 'macro', name, signature: oneLine(node.text, 200), doc: docBefore(node), exported: true, modifiers: ['callback', 'abstract'] };
      }
      if (META_ATTRS.has(a.name)) return null;
      return { kind: 'constant', name: `@${a.name}`, signature: oneLine(node.text, 160), exported: false, modifiers: ['attribute'] };
    }
    if (node.type !== 'call') return null;
    const kw = callTarget(node);
    if (MOD_KW.has(kw)) {
      const args = argsOf(node);
      const first = args[0];
      if (!first || first.type !== 'alias') return null;
      const body = doBlock(node);
      const meta: DefSpec['meta'] = {};
      if (kw === 'defprotocol') meta.protocol = true;
      if (kw === 'defimpl') {
        meta.impl = true;
        const forV = keywordValue(args, 'for');
        if (forV) meta.for = forV.text;
      }
      const name = kw === 'defimpl' ? `${first.text}.${keywordValue(args, 'for')?.text ?? 'Any'}` : first.text;
      return { kind: 'namespace', name, body, signature: oneLine(`${kw} ${first.text}${kw === 'defimpl' ? ', for: ' + (keywordValue(args, 'for')?.text ?? '') : ''}`), doc: moduleDocOf(body), exported: true, meta: Object.keys(meta).length ? meta : undefined, supertypes: kw === 'defimpl' ? [{ name: first.text, kind: 'implements' }] : [] };
    }
    if (FN_KW.has(kw)) {
      const head = defHead(node);
      if (!head) return null;
      const name = head.type === 'call' ? callTarget(head) : head.type === 'identifier' ? head.text : '';
      if (!name) return null;
      const params = head.type === 'call' ? argsOf(head) : [];
      const isPrivate = kw.endsWith('p') && kw !== 'defprotocol';
      const kind: DefSpec['kind'] = kw.startsWith('defmacro') ? 'macro' : 'function';
      const modifiers: string[] = [];
      if (isPrivate) modifiers.push('private');
      if (kw.startsWith('defguard')) modifiers.push('guard');
      if (kw === 'defdelegate') modifiers.push('delegate');
      const headText = argsOf(node)[0]?.text ?? head.text;
      return { kind, name, body: doBlock(node), signature: oneLine(`${kw} ${headText}`), doc: docBefore(node), modifiers, exported: !isPrivate, meta: { arity: params.length } };
    }
    if (TEST_KW.has(kw)) {
      const title = stringContent(argsOf(node)[0]);
      if (!title) return null;
      return { kind: 'test', name: `${kw} ${title}`, body: doBlock(node), signature: oneLine(`${kw} "${title}"`), exported: false };
    }
    if (kw === 'defstruct' || kw === 'defexception') {
      return { kind: 'struct', name: kw === 'defstruct' ? '__struct__' : '__exception__', signature: oneLine(node.text, 160), exported: true };
    }
    if (HTTP_KW.has(kw) && !ctx.inTest && ctx.scopeDef?.kind === 'namespace') {
      const args = argsOf(node);
      const path = stringContent(args[0]);
      if (!path.startsWith('/')) return null;
      const ctrl = args[1]?.type === 'alias' ? args[1].text : '';
      const action = args[2]?.type === 'atom' ? args[2].text.slice(1) : '';
      if (!ctrl) return null;
      const method = kw === 'live' ? 'LIVE' : kw.toUpperCase();
      return { kind: 'route', name: `${method} ${path}`, signature: oneLine(node.text, 160), meta: { method, path, handler: action ? `${ctrl}.${action}` : ctrl }, exported: false };
    }
    return null;
  },

  imports(node, ctx): Import[] | null {
    if (node.type !== 'call') return null;
    const kw = callTarget(node);
    if (!IMPORT_KW.has(kw)) return null;
    const line = node.startPosition.row + 1;
    const args = argsOf(node);
    const first = args[0];
    if (!first) return [];
    const asV = keywordValue(args, 'as');
    const out: Import[] = [];
    const targets: string[] = [];
    if (first.type === 'alias') targets.push(first.text);
    else if (first.type === 'dot') {
      const left = first.childForFieldName('left');
      const right = first.childForFieldName('right');
      if (left?.type === 'alias' && right?.type === 'tuple') for (const a of named(right)) if (a.type === 'alias') targets.push(`${left.text}.${a.text}`);
    }
    if (!targets.length) return [];
    for (const source of targets) {
      if (kw === 'import') {
        const only = keywordValue(args, 'only');
        const names: Import['names'] = [];
        for (const pair of named(named(only).find((c) => c.type === 'keywords'))) {
          const k = pair.childForFieldName('key')?.text.replace(/:\s*$/, '');
          if (k) names.push({ name: k, alias: k });
        }
        out.push({ source, names, namespace: names.length === 0, alias: '', kind: 'static', line });
        continue;
      }
      const alias = asV?.type === 'alias' ? asV.text : lastSegment(source);
      out.push({ source, names: [], namespace: true, alias, kind: 'static', line });
      if (kw === 'use') ctx.emitRef({ kind: 'implements', name: lastSegment(source), qualifier: source.includes('.') ? source.slice(0, source.lastIndexOf('.')) : '' }, first);
    }
    return out;
  },

  references(node, ctx) {
    switch (node.type) {
      case 'call': {
        const target = node.childForFieldName('target');
        if (!target) return;
        if (insideAttribute(node)) return true;
        const piped = node.parent?.type === 'binary_operator' && node.parent.childForFieldName('operator')?.text === '|>' && !!node.parent.childForFieldName('right')?.equals(node);
        const arity = argsOf(node).length + (piped ? 1 : 0);
        if (target.type === 'identifier') {
          const name = target.text;
          if (SKIP_CALLS.has(name) || IMPORT_KW.has(name) || isDefHead(node)) return;
          ctx.emitRef({ kind: 'call', name, arity }, target);
          return;
        }
        if (target.type === 'dot') {
          const left = target.childForFieldName('left');
          const right = target.childForFieldName('right');
          if (!left || right?.type !== 'identifier') return;
          let q = left.text;
          if (q === '__MODULE__') q = 'self';
          const name = right.text;
          if (q === 'System' && /^(get_env|fetch_env!?)$/.test(name)) {
            const key = stringContent(argsOf(node)[0]);
            if (key) ctx.emitRef({ kind: 'config', name: key }, right);
          }
          ctx.emitRef({ kind: 'call', name, qualifier: q, arity }, right);
        }
        return;
      }
      case 'struct': {
        const a = named(node)[0];
        if (a?.type === 'alias') ctx.emitRef({ kind: 'new', name: lastSegment(a.text), qualifier: a.text.includes('.') ? a.text.slice(0, a.text.lastIndexOf('.')) : '' }, a);
        return true;
      }
    }
    return;
  },

  resolveModule(source) {
    const segs = source.split('.').filter(Boolean);
    if (!segs.length) return [];
    const snake = segs.map(underscore);
    const last = snake[snake.length - 1]!;
    const out = [`lib/${snake.join('/')}.ex`, `lib/${snake.join('/')}/${last}.ex`];
    if (snake.length > 1) {
      out.push(`lib/${snake.slice(1).join('/')}.ex`, `test/support/${snake.slice(1).join('/')}.ex`);
      if (snake.length === 2) for (const d of ['controllers', 'live', 'views', 'components', 'channels', 'plugs', 'schemas', 'workers', 'contexts', 'jobs']) out.push(`lib/${snake[0]}/${d}/${last}.ex`);
    }
    out.push(`test/support/${last}.ex`, `lib/${snake.join('_')}.ex`, `lib/${snake.join('/')}.exs`);
    return out;
  },
};
