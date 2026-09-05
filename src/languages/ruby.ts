import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, simpleTypeName, precedingComments, cleanComment, named } from '../parse/walk.js';

const COMMENTS = new Set(['comment']);
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'match', 'root']);
const RSPEC_FNS = new Set(['describe', 'context', 'it', 'specify', 'scenario', 'feature', 'example', 'shared_examples', 'shared_context', 'shared_examples_for', 'xit', 'xdescribe', 'xcontext', 'fit', 'fdescribe', 'fcontext']);
const VISIBILITY = new Set(['private', 'protected', 'public', 'module_function', 'private_class_method', 'public_class_method']);
const MIXINS = new Set(['include', 'extend', 'prepend']);
const ATTRS = new Set(['attr_reader', 'attr_writer', 'attr_accessor']);
const REQUIRES = new Set(['require', 'require_relative', 'load', 'autoload']);
/** Class methods that return an instance of the receiver (ActiveRecord & friends). */
const FACTORY_METHODS = new Set(['new', 'create', 'create!', 'build', 'find', 'find_by', 'find_by!', 'find_or_create_by', 'find_or_initialize_by', 'first', 'last', 'instance', 'allocate']);
const STRUCT_BUILDERS = new Set(['Struct', 'Class', 'Data', 'Module']);
const RESOURCE_ACTIONS: [string, string, string][] = [
  ['index', 'GET', ''],
  ['show', 'GET', '/:id'],
  ['create', 'POST', ''],
  ['update', 'PATCH', '/:id'],
  ['destroy', 'DELETE', '/:id'],
];

/** Literal text of a string / symbol node, or null. */
function literal(n: Node | null | undefined): string | null {
  if (!n) return null;
  if (n.type === 'string' || n.type === 'bare_string') {
    if (named(n).some((c) => c.type === 'interpolation')) return null;
    return named(n).map((c) => c.text).join('') || n.text.replace(/^["']|["']$/g, '');
  }
  if (n.type === 'simple_symbol') return n.text.slice(1);
  if (n.type === 'hash_key_symbol') return n.text;
  return null;
}

function methodName(call: Node): string {
  return call.childForFieldName('method')?.text ?? '';
}

function args(call: Node): Node[] {
  return named(call.childForFieldName('arguments'));
}

function blockBody(call: Node): Node | null {
  const b = call.childForFieldName('block');
  if (!b) return null;
  return b.childForFieldName('body') ?? b;
}

function same(a: Node | null | undefined, b: Node | null | undefined): boolean {
  return !!a && !!b && a.equals(b);
}

function isConstantRef(n: Node | null | undefined): boolean {
  return !!n && (n.type === 'constant' || n.type === 'scope_resolution');
}

/** `Foo::Bar` -> `Foo.Bar` (fqn-style path). */
function dotted(text: string): string {
  return text.replace(/::/g, '.').replace(/^\./, '');
}

/** Preceding `#` comments. Comments before the first statement of a body hang off the body node itself. */
function rubyDoc(node: Node): string {
  const own = precedingComments(node, COMMENTS);
  if (own) return own;
  const p = node.parent;
  if (p?.type === 'body_statement' && same(named(p)[0], node)) return precedingComments(p, COMMENTS);
  return '';
}

function isMagicComment(text: string): boolean {
  return /^#\s*(frozen_string_literal|encoding|coding|-\*-|!|typed:|rubocop|warn_indent)/.test(text) || /^#\s*-\*-/.test(text);
}

/** Visibility section a method sits in (scan previous siblings, `private def x`, and `private :x`). */
function visibilityOf(node: Node, name: string): string {
  const p = node.parent;
  // `private def x`
  if (p?.type === 'argument_list' && p.parent?.type === 'call' && !p.parent.childForFieldName('receiver')) {
    const m = methodName(p.parent);
    if (VISIBILITY.has(m)) return m;
  }
  const body = p?.type === 'argument_list' ? p.parent?.parent : p;
  if (!body) return 'public';
  // `private :x` / `private_class_method :x` anywhere in the body
  for (const s of named(body)) {
    if (s.type !== 'call' || s.childForFieldName('receiver')) continue;
    const m = methodName(s);
    if (!VISIBILITY.has(m)) continue;
    if (args(s).some((a) => a.type === 'simple_symbol' && a.text.slice(1) === name)) return m;
  }
  // bare `private` / `protected` / `module_function` markers before this node
  let prev = (p?.type === 'argument_list' ? p.parent : node)?.previousNamedSibling ?? null;
  while (prev) {
    if (prev.type === 'identifier' && VISIBILITY.has(prev.text)) return prev.text;
    if (prev.type === 'call' && !prev.childForFieldName('receiver') && VISIBILITY.has(methodName(prev)) && !args(prev).length) return methodName(prev);
    prev = prev.previousNamedSibling;
  }
  return 'public';
}

function insideSingletonClass(node: Node): boolean {
  return node.parent?.type === 'body_statement' && node.parent.parent?.type === 'singleton_class';
}

/** Is this node at module / class / module-body level (not inside a method or block)? */
function isDeclarationLevel(node: Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (p.type === 'program') return true;
  if (p.type === 'body_statement') {
    const owner = p.parent?.type;
    return owner === 'class' || owner === 'module' || owner === 'singleton_class' || owner === 'do_block';
  }
  return false;
}

function mixins(body: Node | null | undefined): NonNullable<DefSpec['supertypes']> {
  const out: NonNullable<DefSpec['supertypes']> = [];
  for (const s of named(body)) {
    if (s.type !== 'call' || s.childForFieldName('receiver')) continue;
    if (!MIXINS.has(methodName(s))) continue;
    for (const a of args(s)) if (isConstantRef(a)) out.push({ name: dotted(a.text), kind: 'implements' });
  }
  return out;
}

/** Enclosing Rails `namespace :admin do` / `scope '/x' do` prefixes for a routes DSL call. */
function routePrefix(node: Node): string {
  const parts: string[] = [];
  let cur: Node | null = node.parent;
  while (cur) {
    if (cur.type === 'call' && !cur.childForFieldName('receiver')) {
      const m = methodName(cur);
      if (m === 'namespace' || m === 'scope') {
        const a = literal(args(cur)[0]);
        if (a) parts.unshift(a.startsWith('/') ? a : '/' + a);
      }
    }
    cur = cur.parent;
  }
  return parts.join('');
}

function pairValue(call: Node, key: string): Node | null {
  for (const a of args(call)) {
    if (a.type !== 'pair') continue;
    const k = a.childForFieldName('key');
    if (k && (k.text === key || k.text === `:${key}` || k.text === `${key}:`)) return a.childForFieldName('value');
  }
  return null;
}

/** Rails / Sinatra route DSL. Returns true when the call was a route. */
function routeFromCall(node: Node, ctx: WalkContext): { emitted: boolean; body: Node | null; meta?: Record<string, string> } {
  if (node.childForFieldName('receiver')) return { emitted: false, body: null };
  const m = methodName(node);
  const a = args(node);
  const prefix = routePrefix(node);
  if (m === 'resources' || m === 'resource') {
    const name = literal(a[0]);
    if (!name) return { emitted: false, body: null };
    const only = pairValue(node, 'only');
    const except = pairValue(node, 'except');
    const onlySet = only ? new Set(named(only).map((x) => literal(x) ?? '')) : null;
    const exceptSet = except ? new Set(named(except).map((x) => literal(x) ?? '')) : new Set<string>();
    const base = `${prefix}/${name}`;
    for (const [action, verb, suffix] of RESOURCE_ACTIONS) {
      if (onlySet && !onlySet.has(action)) continue;
      if (exceptSet.has(action)) continue;
      const path = m === 'resource' ? base : `${base}${suffix}`;
      const controller = prefix ? `${prefix.slice(1)}/${name}` : name;
      ctx.emitDef({ kind: 'route', name: `${verb} ${path}`, signature: `${verb} ${path}`, meta: { method: verb, path, handler: `${controller}#${action}`, controller, action } }, node, -1);
    }
    return { emitted: true, body: null };
  }
  if (!HTTP_METHODS.has(m)) return { emitted: false, body: null };
  let path: string | null = null;
  let handler = '';
  if (m === 'root') path = '/';
  else {
    const first = a[0];
    if (first?.type === 'pair') {
      // get '/x' => 'ctrl#action'
      path = literal(first.childForFieldName('key'));
      handler = literal(first.childForFieldName('value')) ?? '';
    } else path = literal(first);
  }
  if (path === null) return { emitted: false, body: null };
  if (!path.startsWith('/')) path = '/' + path;
  path = prefix + path;
  const to = pairValue(node, 'to');
  if (to) handler = literal(to) ?? handler;
  let verb = m.toUpperCase();
  if (m === 'root') verb = 'GET';
  if (m === 'match') {
    const via = pairValue(node, 'via');
    verb = via ? (via.type === 'array' ? named(via).map((v) => (literal(v) ?? '').toUpperCase()).join(',') : (literal(via) ?? 'ANY').toUpperCase()) : 'ANY';
  }
  const meta: Record<string, string> = { method: verb, path, handler };
  const hash = handler.indexOf('#');
  if (hash > 0) {
    meta.controller = handler.slice(0, hash);
    meta.action = handler.slice(hash + 1);
  }
  return { emitted: true, body: blockBody(node), meta: { ...meta, name: `${verb} ${path}` } };
}

function receiverQualifier(r: Node | null): string {
  if (!r) return '';
  if (r.type === 'self') return 'self';
  return oneLine(r.text, 80);
}

export const ruby: LanguageSupport = {
  id: 'ruby',
  grammar: 'ruby',
  extensions: ['.rb', '.rake', '.gemspec'],
  classLike: new Set(['class', 'module']),
  skip: new Set(['comment', 'heredoc_body', 'string_content', 'regex']),

  isTestFile(path) {
    return /(^|\/)(spec|test|tests|features)\//.test(path) || /_(spec|test)\.rb$/.test(path);
  },

  doc(node) {
    return rubyDoc(node);
  },

  moduleDoc(root) {
    const kidsOfRoot = named(root);
    const lead: Node[] = [];
    let i = 0;
    for (; i < kidsOfRoot.length; i++) {
      const c = kidsOfRoot[i]!;
      if (c.type !== 'comment') break;
      if (!isMagicComment(c.text)) lead.push(c);
    }
    if (!lead.length) return '';
    const next = kidsOfRoot[i];
    const last = lead[lead.length - 1]!;
    // A comment block immediately followed by a definition is that definition's doc, not the module's.
    if (next && ['class', 'module', 'method', 'singleton_method', 'assignment'].includes(next.type) && next.startPosition.row - last.endPosition.row <= 1) return '';
    return cleanComment(lead.map((c) => c.text).join('\n'));
  },

  definition(node, ctx): DefSpec | null {
    switch (node.type) {
      case 'class': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        const full = dotted(nameNode.text);
        const name = simpleTypeName(full);
        const container = full.includes('.') ? full.slice(0, full.lastIndexOf('.')) : undefined;
        const sup = node.childForFieldName('superclass');
        const supertypes: NonNullable<DefSpec['supertypes']> = [];
        const supExpr = named(sup)[0];
        if (supExpr) {
          if (isConstantRef(supExpr)) supertypes.push({ name: dotted(supExpr.text), kind: 'extends' });
          else if (supExpr.type === 'call' && isConstantRef(supExpr.childForFieldName('receiver'))) supertypes.push({ name: dotted(supExpr.childForFieldName('receiver')!.text), kind: 'extends' });
        }
        const body = node.childForFieldName('body');
        supertypes.push(...mixins(body));
        return { kind: 'class', name, container, body, signature: oneLine(`class ${nameNode.text}${sup ? ' < ' + named(sup)[0]?.text : ''}`), doc: rubyDoc(node), exported: true, supertypes };
      }
      case 'module': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        const full = dotted(nameNode.text);
        const name = simpleTypeName(full);
        const container = full.includes('.') ? full.slice(0, full.lastIndexOf('.')) : undefined;
        const body = node.childForFieldName('body');
        return { kind: 'namespace', name, container, body, signature: `module ${nameNode.text}`, doc: rubyDoc(node), exported: true, supertypes: mixins(body) };
      }
      case 'method':
      case 'singleton_method': {
        const nameNode = node.childForFieldName('name');
        const name = nameNode?.text ?? '';
        if (!name) return null;
        const modifiers: string[] = [];
        const vis = visibilityOf(node, name);
        if (vis === 'private' || vis === 'protected') modifiers.push(vis);
        let container: string | undefined;
        if (node.type === 'singleton_method') {
          const obj = node.childForFieldName('object');
          modifiers.push('static');
          if (obj && obj.type !== 'self') container = dotted(obj.text);
        } else if (insideSingletonClass(node) || vis === 'module_function') modifiers.push('static');
        if (vis === 'private_class_method') modifiers.push('private', 'static');
        let kind: DefSpec['kind'] = ctx.inClass || container ? 'method' : 'function';
        if (ctx.inClass && name === 'initialize') kind = 'constructor';
        if (/^test_/.test(name)) kind = 'test';
        const params = node.childForFieldName('parameters')?.text ?? '';
        const recv = node.type === 'singleton_method' ? `${node.childForFieldName('object')?.text ?? 'self'}.` : '';
        return { kind, name, container, body: node.childForFieldName('body'), signature: oneLine(`def ${recv}${name}${params}`), doc: rubyDoc(node), modifiers, exported: !modifiers.includes('private') && !modifiers.includes('protected') };
      }
      case 'alias': {
        const nm = node.childForFieldName('name');
        const target = node.childForFieldName('alias');
        if (!nm || !target) return null;
        return { kind: ctx.inClass ? 'method' : 'function', name: nm.text, signature: oneLine(node.text, 80), doc: rubyDoc(node), exported: true, meta: { alias_of: target.text } };
      }
      case 'assignment': {
        const left = node.childForFieldName('left');
        if (!left || left.type !== 'constant' || !isDeclarationLevel(node)) return null;
        const name = left.text;
        const right = node.childForFieldName('right');
        // Point = Struct.new(:x, :y) do ... end  /  Klass = Class.new(Base)
        if (right?.type === 'call' && methodName(right) === 'new' && right.childForFieldName('receiver')?.type === 'constant' && STRUCT_BUILDERS.has(right.childForFieldName('receiver')!.text)) {
          const builder = right.childForFieldName('receiver')!.text;
          const supertypes: NonNullable<DefSpec['supertypes']> = [];
          if (builder === 'Class') {
            const base = args(right)[0];
            if (base && isConstantRef(base)) supertypes.push({ name: dotted(base.text), kind: 'extends' });
          } else supertypes.push({ name: builder, kind: 'extends' });
          const body = blockBody(right);
          supertypes.push(...mixins(body));
          return { kind: builder === 'Module' ? 'namespace' : 'class', name, body, signature: oneLine(`${name} = ${builder}.new${right.childForFieldName('arguments')?.text ?? ''}`, 160), doc: rubyDoc(node), exported: true, supertypes };
        }
        let declaredType: string | undefined;
        if (right?.type === 'call' && isConstantRef(right.childForFieldName('receiver')) && FACTORY_METHODS.has(methodName(right))) declaredType = simpleTypeName(right.childForFieldName('receiver')!.text);
        return { kind: 'constant', name, signature: oneLine(`${name} = ${right?.text ?? ''}`, 160), doc: rubyDoc(node), exported: true, declaredType };
      }
      case 'call': {
        const recv = node.childForFieldName('receiver');
        const m = methodName(node);
        // RSpec: describe / context / it ... do ... end
        if (RSPEC_FNS.has(m) && (!recv || recv.text === 'RSpec') && node.childForFieldName('block')) {
          const first = args(node)[0];
          const title = literal(first) ?? (first && isConstantRef(first) ? first.text : '');
          const label = title ? `${m} ${title}` : m;
          return { kind: 'test', name: label, body: blockBody(node), signature: oneLine(`${m}${title ? ` "${title}"` : ''}`), exported: false, meta: { framework: 'rspec' } };
        }
        if (ctx.inTest || recv) return null;
        // Sinatra `get '/x' do ... end` becomes a scoped route; Rails routes are bodiless.
        const r = routeFromCall(node, ctx);
        if (r.emitted && r.meta) {
          const { name = '', ...meta } = r.meta;
          if (r.body) return { kind: 'route', name, body: r.body, signature: name, meta };
          ctx.emitDef({ kind: 'route', name, signature: name, meta }, node, -1);
        }
        return null;
      }
    }
    return null;
  },

  imports(node): Import[] | null {
    if (node.type !== 'call' || node.childForFieldName('receiver')) return null;
    const m = methodName(node);
    if (!REQUIRES.has(m)) return null;
    const line = node.startPosition.row + 1;
    const a = args(node);
    if (m === 'autoload') {
      const sym = literal(a[0]);
      const src = literal(a[1]);
      if (!sym || !src) return [];
      return [{ source: src, names: [{ name: sym, alias: sym }], namespace: false, alias: '', kind: 'dynamic', line }];
    }
    const src = literal(a[0]);
    if (!src) return [];
    return [{ source: src, names: [], namespace: true, alias: '', kind: 'static', line, relativeLevel: m === 'require_relative' ? 1 : 0 }];
  },

  references(node, ctx) {
    switch (node.type) {
      case 'call': {
        const recv = node.childForFieldName('receiver');
        const mNode = node.childForFieldName('method');
        const m = mNode?.text ?? '';
        const a = args(node);
        const arity = a.length;
        if (!recv) {
          if (REQUIRES.has(m) || MIXINS.has(m)) return true;
          if (ATTRS.has(m)) {
            if (ctx.inClass) {
              for (const s of a) {
                const nm = literal(s);
                if (nm && s.type === 'simple_symbol') ctx.emitDef({ kind: 'property', name: nm, signature: `${m} :${nm}`, doc: rubyDoc(node), exported: true, modifiers: m === 'attr_reader' ? ['readonly'] : [] }, s, ctx.scope);
              }
            }
            return true;
          }
          if (VISIBILITY.has(m)) return; // `private def x` / `private :x`: descend for the nested def
          if (RSPEC_FNS.has(m) || HTTP_METHODS.has(m) || m === 'resources' || m === 'resource') return; // DSL, handled as definitions
          if (m === 'super') {
            const fn = ctx.scopeDef;
            if (fn && (fn.kind === 'method' || fn.kind === 'constructor')) ctx.emitRef({ kind: 'call', name: fn.name, qualifier: 'super', arity }, mNode ?? node);
            return;
          }
          if (m === 'raise' || m === 'puts' || m === 'p' || m === 'print' || m === 'require' || m === 'yield' || m === 'block_given?' || m === 'lambda' || m === 'proc' || m === 'loop') return;
          if (mNode) ctx.emitRef({ kind: 'call', name: m, arity }, mNode);
          return;
        }
        if (recv.type === 'constant' && recv.text === 'ENV' && (m === 'fetch' || m === '[]')) {
          const key = literal(a[0]);
          if (key) ctx.emitRef({ kind: 'config', name: key }, a[0]!);
          return true;
        }
        if (m === 'new' && isConstantRef(recv)) {
          const q = recv.type === 'scope_resolution' ? recv.childForFieldName('scope')?.text ?? '' : '';
          ctx.emitRef({ kind: 'new', name: simpleTypeName(recv.text), qualifier: q, arity }, recv);
          return;
        }
        if (RSPEC_FNS.has(m) && recv.text === 'RSpec') return;
        if (mNode) ctx.emitRef({ kind: 'call', name: m, qualifier: receiverQualifier(recv), arity }, mNode);
        return;
      }
      case 'super': {
        const fn = ctx.scopeDef;
        if (fn && (fn.kind === 'method' || fn.kind === 'constructor')) ctx.emitRef({ kind: 'call', name: fn.name, qualifier: 'super' }, node);
        return true;
      }
      case 'element_reference': {
        const obj = node.childForFieldName('object');
        if (obj?.type === 'constant' && obj.text === 'ENV') {
          const key = literal(named(node)[1]);
          if (key) ctx.emitRef({ kind: 'config', name: key }, named(node)[1]!);
          return true;
        }
        return;
      }
      case 'assignment': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (left && right?.type === 'call' && ['identifier', 'instance_variable', 'class_variable', 'global_variable'].includes(left.type)) {
          const recv = right.childForFieldName('receiver');
          const m = methodName(right);
          if (isConstantRef(recv) && FACTORY_METHODS.has(m)) ctx.emitLocalType({ name: left.text, type: simpleTypeName(recv!.text), via: m === 'new' ? 'new' : 'constructor_call' });
        }
        return;
      }
      case 'scope_resolution': {
        const p = node.parent;
        if (p?.type === 'call' && same(p.childForFieldName('receiver'), node)) return true;
        if (p && (p.type === 'class' || p.type === 'module' || p.type === 'superclass' || p.type === 'scope_resolution')) return true;
        if (p?.type === 'assignment' && same(p.childForFieldName('left'), node)) return true;
        const nm = node.childForFieldName('name');
        if (nm) ctx.emitRef({ kind: 'type', name: nm.text, qualifier: node.childForFieldName('scope')?.text ?? '' }, nm);
        return true;
      }
      case 'constant': {
        const p = node.parent;
        if (!p) return;
        if (p.type === 'call' && same(p.childForFieldName('receiver'), node)) return;
        if (p.type === 'class' || p.type === 'module' || p.type === 'superclass' || p.type === 'scope_resolution') return;
        if (p.type === 'assignment' && same(p.childForFieldName('left'), node)) return;
        if (p.type === 'argument_list' && p.parent?.type === 'call') {
          const call = p.parent;
          const m = methodName(call);
          if (MIXINS.has(m) || RSPEC_FNS.has(m)) return;
          // `Klass = Class.new(Base)`: Base is already the class's supertype
          const recv = call.childForFieldName('receiver');
          if (m === 'new' && recv?.type === 'constant' && STRUCT_BUILDERS.has(recv.text)) return;
        }
        if (node.text === 'ENV') return;
        ctx.emitRef({ kind: 'type', name: node.text }, node);
        return;
      }
      case 'identifier': {
        // bare name in value position: call argument, array element, hash value
        const p = node.parent;
        if (!p) return;
        const inArgs = p.type === 'argument_list' || p.type === 'array' || (p.type === 'pair' && p.childForFieldName('value')?.id === node.id);
        if (inArgs && !/^(self|nil|true|false)$/.test(node.text)) ctx.emitRef({ kind: 'value', name: node.text }, node);
        return;
      }
    }
    return;
  },

  resolveModule(source, fromPath, imp) {
    const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
    const base = source.replace(/\.rb$/, '');
    const out: string[] = [];
    if ((imp.relativeLevel ?? 0) > 0 || base.startsWith('.')) {
      const parts = (fromDir ? fromDir.split('/') : []).concat(base.split('/'));
      const stack: string[] = [];
      for (const p of parts) {
        if (p === '.' || p === '') continue;
        if (p === '..') stack.pop();
        else stack.push(p);
      }
      const p = stack.join('/');
      out.push(`${p}.rb`, `${p}/${stack[stack.length - 1] ?? ''}.rb`);
      return out;
    }
    for (const root of ['lib', '', 'app/models', 'app/services', 'app/controllers', 'app/lib', 'app/helpers', 'app/jobs', 'app/mailers', 'src']) {
      out.push(root ? `${root}/${base}.rb` : `${base}.rb`);
    }
    // gem-style layout: `require 'foo/bar'` -> lib/foo/bar.rb (already covered) or lib/foo/bar/bar.rb is rare; also try lib/<name>/<name>.rb
    return out;
  },
};
