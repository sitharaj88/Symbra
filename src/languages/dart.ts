import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, simpleTypeName, precedingComments, named, kids } from '../parse/walk.js';

const COMMENTS = new Set(['documentation_comment', 'comment']);
const TEST_FNS = new Set(['test', 'group', 'testWidgets']);
const KEYWORDS = new Set(['abstract', 'static', 'async', 'external', 'late', 'factory', 'const', 'final', 'var', 'get', 'set', 'covariant', 'base', 'sealed', 'interface', 'mixin', 'sync', 'operator']);
/** Sibling node types that precede a top-level / class-level variable list. */
const TYPE_PREFIX = new Set(['const_builtin', 'final_builtin', 'type_identifier', 'type_arguments', 'inferred_type', 'void_type', 'function_type', 'ERROR']);
const BUILTIN_TYPES = new Set(['String', 'List', 'Map', 'Set', 'Future', 'Stream', 'Object', 'Iterable', 'Function', 'Null', 'Never', 'Type', 'Symbol', 'Duration', 'DateTime', 'Uri', 'Exception', 'Error', 'BigInt', 'Comparable', 'Iterator', 'FutureOr', 'StreamSubscription', 'Completer', 'Timer', 'RegExp', 'StringBuffer', 'Random', 'Key', 'BuildContext', 'Widget', 'State', 'StatelessWidget', 'StatefulWidget']);

function fieldChildren(node: Node, field: string): Node[] {
  const out: Node[] = [];
  const cs = node.children;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (c && node.fieldNameForChild(i) === field) out.push(c);
  }
  return out;
}

function keywordsOf(nodes: Node[]): string[] {
  const out: string[] = [];
  for (const c of nodes) {
    if (!c.isNamed && KEYWORDS.has(c.type)) out.push(c.type);
    else if (c.type === 'const_builtin' || c.type === 'final_builtin') out.push(c.text);
  }
  return out;
}

/** Hop backwards over type/keyword/annotation siblings to the start of a declaration. */
function declStart(node: Node): Node {
  let n = node;
  for (;;) {
    const p = n.previousSibling;
    if (!p) break;
    if (TYPE_PREFIX.has(p.type) || (!p.isNamed && (KEYWORDS.has(p.type) || p.type === '?')) || p.type === 'marker_annotation' || p.type === 'annotation') n = p;
    else break;
  }
  return n;
}

function docFor(node: Node): string {
  return precedingComments(declStart(node), COMMENTS);
}

function annotationsOf(node: Node): string[] {
  const out: string[] = [];
  let p = declStart(node);
  // declStart already hopped over annotations; walk forward to node collecting them
  while (p && p !== node) {
    if (p.type === 'marker_annotation' || p.type === 'annotation') out.push(p.childForFieldName('name')?.text ?? named(p)[0]?.text ?? '');
    p = p.nextSibling!;
    if (!p) break;
  }
  return out.filter(Boolean);
}

function stringValue(n: Node | null | undefined): string | null {
  if (!n || n.type !== 'string_literal') return null;
  return n.text.replace(/^r?(['"]{1,3})/, '').replace(/(['"]{1,3})$/, '');
}

function typeIds(n: Node | null | undefined): string[] {
  return named(n).filter((c) => c.type === 'type_identifier').map((c) => c.text);
}

/** Text of a node range without going through the source (index units stay consistent). */
function textBetween(parent: Node, from: Node, toExclusive: Node): string {
  return parent.text.slice(from.startIndex - parent.startIndex, toExclusive.startIndex - parent.startIndex);
}

/** The head of a `primary (selector)*` chain that `sel` belongs to. */
function chainHead(sel: Node): Node | null {
  let h: Node | null = sel;
  while (h && h.previousNamedSibling?.type === 'selector') h = h.previousNamedSibling;
  return h?.previousNamedSibling ?? null;
}

/** `Foo(...)` / `Foo.named(...)` value → constructed type name, else undefined. */
function ctorType(values: Node[]): string | undefined {
  const head = values[0];
  if (!head || head.type !== 'identifier' || !/^[A-Z]/.test(head.text)) return undefined;
  const rest = values.slice(1);
  if (!rest.some((s) => s.type === 'selector' && named(s)[0]?.type === 'argument_part')) return undefined;
  // Foo.bar(...) where bar is lowercase and Foo is a class: treat as constructor only if the member is capitalised or absent
  const member = rest[0]?.type === 'selector' ? named(rest[0]!)[0] : null;
  if (member?.type === 'unconditional_assignable_selector') {
    const id = named(member).find((c) => c.type === 'identifier');
    if (id && rest.length > 2) return undefined; // Foo.x.y(...)
    if (id && !/^[A-Z]/.test(id.text) && !/^(named|from|of|create|internal|_)/.test(id.text) && id.text !== 'new') return undefined;
  }
  return head.text;
}

/**
 * A pseudo-node spanning two sibling nodes, for `DefSpec.rangeNode`: the walker only reads
 * start/end position and index from it. Dart splits `method_signature` and `function_body`
 * into siblings, so a definition's range has to cover both.
 */
function spanNode(a: Node, b: Node): Node {
  return { startPosition: a.startPosition, endPosition: b.endPosition, startIndex: a.startIndex, endIndex: b.endIndex } as unknown as Node;
}

function headText(node: Node): string {
  return oneLine(node.text.replace(/\{\s*$/, ''));
}

function supertypesOf(node: Node): NonNullable<DefSpec['supertypes']> {
  const out: NonNullable<DefSpec['supertypes']> = [];
  const sup = node.childForFieldName('superclass');
  if (sup) {
    const base = named(sup).find((c) => c.type === 'type_identifier');
    if (base) out.push({ name: base.text, kind: 'extends' });
    for (const m of named(sup).filter((c) => c.type === 'mixins')) for (const t of typeIds(m)) out.push({ name: t, kind: 'implements' });
  }
  for (const t of typeIds(node.childForFieldName('interfaces'))) out.push({ name: t, kind: 'implements' });
  return out;
}

function memberSignatureNode(node: Node): Node | null {
  // method_signature -> (function_signature | getter_signature | setter_signature | constructor_signature | factory_constructor_signature | ...)
  return named(node).find((c) => c.type.endsWith('_signature')) ?? null;
}

function memberDef(sig: Node, wrapper: Node, ctx: WalkContext, body: Node | null): DefSpec | null {
  const kws = keywordsOf([...kids(wrapper), ...kids(sig)]);
  const annos = annotationsOf(wrapper);
  const mods = kws.filter((k) => k !== 'get' && k !== 'set' && k !== 'factory');
  if (annos.includes('override')) mods.push('override');
  if (body && kids(body).some((c) => c.type === 'async')) mods.push('async');
  const doc = docFor(wrapper);
  const exportedName = (n: string) => !n.startsWith('_');
  switch (sig.type) {
    case 'function_signature': {
      const name = sig.childForFieldName('name')?.text ?? '';
      if (!name) return null;
      if (name.startsWith('_')) mods.push('private');
      const ret = named(sig).find((c) => c.type === 'type_identifier' || c.type === 'void_type' || c.type === 'function_type');
      const params = named(sig).find((c) => c.type === 'formal_parameter_list');
      const inClass = ctx.inClass;
      const kind: DefSpec['kind'] = inClass ? 'method' : 'function';
      const retText = ret && ret.startIndex < (sig.childForFieldName('name')?.startIndex ?? 0) ? ret.text + (named(sig).find((c) => c.type === 'type_arguments' && c.startIndex < (sig.childForFieldName('name')?.startIndex ?? 0))?.text ?? '') + ' ' : '';
      const prefix = mods.filter((m) => m !== 'override' && m !== 'private' && m !== 'async');
      return { kind, name, body, signature: oneLine(`${prefix.join(' ')}${prefix.length ? ' ' : ''}${retText}${name}${params?.text ?? '()'}${mods.includes('async') ? ' async' : ''}`), doc, modifiers: mods, exported: exportedName(name), meta: annos.length ? { annotations: annos.join(',') } : undefined };
    }
    case 'getter_signature':
    case 'setter_signature': {
      const name = sig.childForFieldName('name')?.text ?? '';
      if (!name) return null;
      if (name.startsWith('_')) mods.push('private');
      mods.push(sig.type === 'getter_signature' ? 'get' : 'set');
      const ret = named(sig).find((c) => c.type === 'type_identifier');
      return { kind: 'property', name, body, signature: headText(sig), doc, modifiers: mods, exported: exportedName(name), declaredType: ret ? simpleTypeName(ret.text) : undefined };
    }
    case 'constructor_signature':
    case 'constant_constructor_signature':
    case 'factory_constructor_signature':
    case 'redirecting_factory_constructor_signature': {
      const ids = named(sig).filter((c) => c.type === 'identifier').map((c) => c.text);
      const name = ids.join('.');
      if (!name) return null;
      if (sig.type.includes('factory')) mods.push('factory');
      if (sig.type === 'constant_constructor_signature') mods.push('const');
      return { kind: 'constructor', name, body, signature: headText(sig), doc, modifiers: mods, exported: !ids.some((i) => i.startsWith('_')) };
    }
    case 'operator_signature': {
      const op = kids(sig).find((c) => !c.isNamed && c.type !== 'operator')?.text ?? '';
      return { kind: 'method', name: `operator ${op}`.trim(), body, signature: headText(sig), doc, modifiers: mods, exported: true };
    }
  }
  return null;
}

function variableDef(node: Node, ctx: WalkContext): DefSpec | null {
  // node: initialized_identifier | static_final_declaration
  const list = node.parent;
  const holder = list?.parent;
  if (!list || !holder) return null;
  const inClass = holder.type === 'declaration' && ctx.inClass;
  const top = holder.type === 'program';
  if (!inClass && !top) return null;
  const nameNode = named(node)[0];
  if (!nameNode || nameNode.type !== 'identifier') return null;
  const name = nameNode.text;
  const values = named(node).slice(1);
  // type + keywords: siblings before the list
  const prefix: Node[] = [];
  let p = list.previousSibling;
  while (p && (TYPE_PREFIX.has(p.type) || (!p.isNamed && (KEYWORDS.has(p.type) || p.type === '?')))) {
    prefix.unshift(p);
    p = p.previousSibling;
  }
  const kws = keywordsOf(prefix);
  const typeNode = prefix.find((c) => c.type === 'type_identifier');
  const declaredType = typeNode ? simpleTypeName(typeNode.text) : ctorType(values);
  const mods = [...kws];
  if (name.startsWith('_')) mods.push('private');
  const isConst = kws.includes('const') || kws.includes('final');
  const kind: DefSpec['kind'] = inClass ? 'field' : isConst ? 'constant' : 'variable';
  const typeText = prefix.filter((c) => c.type === 'type_identifier' || c.type === 'type_arguments' || c.type === '?').map((c) => c.text).join('');
  const valueText = values.map((v) => v.text).join('');
  const sig = oneLine(`${kws.join(' ')}${kws.length ? ' ' : ''}${typeText}${typeText ? ' ' : ''}${name}${valueText ? ' = ' + valueText : ''}`, 160);
  return { kind, name, signature: sig, doc: docFor(list), modifiers: mods, exported: !name.startsWith('_'), declaredType };
}

export const dart: LanguageSupport = {
  id: 'dart',
  grammar: 'dart',
  extensions: ['.dart'],
  classLike: new Set(['class_definition', 'mixin_declaration', 'extension_declaration', 'enum_declaration']),
  skip: new Set(['documentation_comment', 'comment']),

  isTestFile(path) {
    return /(^|\/)(test|integration_test|test_driver)\//.test(path) || /_test\.dart$/.test(path);
  },

  doc(node) {
    return docFor(node);
  },

  moduleDoc(root) {
    const first = named(root)[0];
    if (first?.type === 'documentation_comment' || first?.type === 'comment') {
      const parts: string[] = [];
      let n: Node | null = first;
      while (n && (n.type === 'documentation_comment' || n.type === 'comment')) {
        parts.push(n.text);
        n = n.nextNamedSibling;
      }
      // Only treat as module doc when not immediately attached to the next declaration
      if (n && parts.length && n.startPosition.row - (n.previousNamedSibling?.endPosition.row ?? 0) <= 1) return '';
      const cleaned = parts.map((l) => l.replace(/^\s*\/\/\/?\s?/, '').trimEnd()).join('\n').trim();
      return cleaned;
    }
    return '';
  },

  definition(node, ctx): DefSpec | null {
    switch (node.type) {
      case 'class_definition': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const body = node.childForFieldName('body');
        const mods = keywordsOf(kids(node)).filter((k) => k !== 'mixin' && k !== 'interface');
        const supertypes = supertypesOf(node);
        const head = body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text;
        return { kind: 'class', name, body, signature: oneLine(head.replace(/\{\s*$/, '')), doc: docFor(node), modifiers: mods, exported: !name.startsWith('_'), supertypes };
      }
      case 'mixin_declaration': {
        const nameNode = named(node).find((c) => c.type === 'identifier');
        const name = nameNode?.text ?? '';
        if (!name) return null;
        const body = named(node).find((c) => c.type === 'class_body');
        const on = named(node).filter((c) => c.type === 'type_identifier').map((c) => ({ name: c.text, kind: 'implements' as const }));
        return { kind: 'trait', name, body, signature: oneLine(body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text), doc: docFor(node), exported: !name.startsWith('_'), supertypes: on };
      }
      case 'enum_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        return { kind: 'enum', name, body: node.childForFieldName('body'), signature: `enum ${name}`, doc: docFor(node), exported: !name.startsWith('_'), supertypes: supertypesOf(node) };
      }
      case 'enum_constant': {
        const name = node.childForFieldName('name')?.text ?? '';
        return name ? { kind: 'enum_member', name, signature: oneLine(node.text, 120), doc: docFor(node), exported: true } : null;
      }
      case 'extension_declaration': {
        const extName = node.childForFieldName('name')?.text ?? '';
        const on = node.childForFieldName('class');
        const target = on ? simpleTypeName(on.text) : '';
        const name = target || extName;
        if (!name) return null;
        const body = node.childForFieldName('body');
        return { kind: 'class', name, body, signature: oneLine(body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text), doc: docFor(node), exported: !extName.startsWith('_'), meta: { extension: true, extensionName: extName } };
      }
      case 'type_alias': {
        const name = named(node).find((c) => c.type === 'type_identifier')?.text ?? '';
        if (!name) return null;
        return { kind: 'type_alias', name, signature: oneLine(node.text, 200), doc: docFor(node), exported: !name.startsWith('_') };
      }
      case 'method_signature': {
        // A following `function_body` sibling holds the body: the definition is registered there
        // (see the `function_body` case) so that references inside the body get the method's scope.
        if (node.nextNamedSibling?.type === 'function_body') return null;
        const sig = memberSignatureNode(node);
        return sig ? memberDef(sig, node, ctx, null) : null;
      }
      case 'function_body': {
        const prev = node.previousNamedSibling;
        if (!prev) return null;
        let d: DefSpec | null = null;
        if (prev.type === 'method_signature') {
          const sig = memberSignatureNode(prev);
          d = sig ? memberDef(sig, prev, ctx, node) : null;
        } else if (prev.type === 'function_signature' && prev.parent?.type === 'program') {
          d = memberDef(prev, prev, ctx, node);
        }
        if (d) d.rangeNode = spanNode(prev, node);
        return d;
      }
      case 'declaration': {
        // abstract methods / body-less constructors inside a class body
        const sig = named(node).find((c) => c.type.endsWith('_signature'));
        if (!sig || sig.type === 'getter_signature' || sig.type === 'setter_signature') return sig ? memberDef(sig, node, ctx, null) : null;
        const d = memberDef(sig, node, ctx, null);
        if (d && sig.type === 'function_signature' && !d.modifiers?.includes('external')) d.modifiers = [...(d.modifiers ?? []), 'abstract'];
        return d;
      }
      case 'function_signature': {
        if (node.parent?.type !== 'program' || node.nextNamedSibling?.type === 'function_body') return null;
        return memberDef(node, node, ctx, null);
      }
      case 'initialized_identifier':
      case 'static_final_declaration':
        return variableDef(node, ctx);
      case 'expression_statement': {
        // test('name', () { ... }) / group('name', () { ... })
        const head = named(node)[0];
        const sel = named(node)[1];
        if (head?.type !== 'identifier' || !TEST_FNS.has(head.text) || sel?.type !== 'selector') return null;
        const args = named(named(sel)[0] ?? null).find((c) => c.type === 'arguments');
        if (!args) return null;
        const argNodes = named(args).map((a) => (a.type === 'argument' ? named(a)[0] ?? a : a));
        const title = stringValue(argNodes[0]);
        const cb = argNodes.find((a) => a?.type === 'function_expression');
        if (title === null || !cb) return null;
        return { kind: 'test', name: `${head.text} ${title}`, body: cb.childForFieldName('body'), signature: oneLine(`${head.text}('${title}')`), exported: false };
      }
    }
    return null;
  },

  imports(node): Import[] | null {
    const line = node.startPosition.row + 1;
    if (node.type === 'import_or_export') {
      const inner = named(node)[0];
      if (!inner) return [];
      const uriNode = inner.descendantsOfType('string_literal')[0];
      const source = stringValue(uriNode) ?? '';
      if (!source) return [];
      const spec = inner.type === 'library_import' ? named(inner).find((c) => c.type === 'import_specification') ?? inner : inner;
      const alias = named(spec).find((c) => c.type === 'identifier')?.text ?? '';
      const shows: string[] = [];
      for (const c of named(spec).filter((x) => x.type === 'combinator')) {
        const kw = kids(c)[0]?.type;
        if (kw === 'show') for (const id of named(c)) if (id.type === 'identifier') shows.push(id.text);
      }
      const names = shows.map((n) => ({ name: n, alias: n }));
      if (inner.type === 'library_export') return [{ source, names, namespace: names.length === 0, alias: '', kind: 'reexport', line }];
      return [{ source, names, namespace: !!alias || names.length === 0, alias, kind: 'static', line }];
    }
    if (node.type === 'part_directive') {
      const source = stringValue(node.descendantsOfType('string_literal')[0]) ?? '';
      return source ? [{ source, names: [], namespace: true, alias: '', kind: 'static', line }] : [];
    }
    return null;
  },

  references(node, ctx) {
    switch (node.type) {
      case 'selector': {
        const inner = named(node)[0];
        const parent = node.parent;
        if (!inner || !parent) return;
        if (inner.type === 'argument_part') {
          const args = named(inner).find((c) => c.type === 'arguments');
          const arity = named(args).length;
          const prev = node.previousNamedSibling;
          if (!prev) return;
          if (prev.type === 'selector') {
            const sel = named(prev)[0];
            if (!sel || (sel.type !== 'unconditional_assignable_selector' && sel.type !== 'conditional_assignable_selector')) return;
            const id = named(sel).find((c) => c.type === 'identifier');
            if (!id) return;
            const head = chainHead(prev);
            if (!head) return;
            const qualifier = textBetween(parent, head, prev).replace(/[\s?!.]+$/, '');
            const name = id.text;
            if (qualifier === 'String' && name === 'fromEnvironment') {
              const first = named(args)[0];
              const key = stringValue(first?.type === 'argument' ? named(first)[0] : first);
              if (key) ctx.emitRef({ kind: 'config', name: key }, id);
            }
            ctx.emitRef({ kind: /^[A-Z]/.test(name) ? 'new' : 'call', name, qualifier, arity }, id);
          } else if (prev.type === 'identifier') {
            ctx.emitRef({ kind: /^[A-Z]/.test(prev.text) ? 'new' : 'call', name: prev.text, arity }, prev);
          }
          return;
        }
        if (inner.type === 'unconditional_assignable_selector') {
          // Platform.environment['KEY']
          const s = named(inner).find((c) => c.type === 'string_literal');
          if (s) {
            const head = chainHead(node);
            const prev = node.previousNamedSibling;
            if (head && prev && /environment$/.test(textBetween(parent, head, node))) {
              const key = stringValue(s);
              if (key) ctx.emitRef({ kind: 'config', name: key }, s);
            }
          }
        }
        return;
      }
      case 'new_expression':
      case 'const_object_expression': {
        const t = named(node).find((c) => c.type === 'type_identifier' || c.type === 'identifier');
        if (!t) return;
        const args = named(node).find((c) => c.type === 'arguments');
        ctx.emitRef({ kind: 'new', name: simpleTypeName(t.text), arity: named(args).length }, t);
        return;
      }
      case 'type_identifier': {
        const p = node.parent?.type ?? '';
        if (p === 'superclass' || p === 'interfaces' || p === 'mixins' || p === 'type_parameter' || p === 'mixin_declaration') return;
        if (p === 'type_alias' && node.previousNamedSibling === null) return;
        if (BUILTIN_TYPES.has(node.text) || /^[a-z]/.test(node.text)) return;
        ctx.emitRef({ kind: 'type', name: node.text }, node);
        return;
      }
      case 'formal_parameter': {
        const nameNode = node.childForFieldName('name');
        const t = named(node).find((c) => c.type === 'type_identifier');
        if (nameNode && t) ctx.emitLocalType({ name: nameNode.text, type: simpleTypeName(t.text), via: 'annotation' });
        return;
      }
      case 'initialized_variable_definition': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return;
        const t = named(node).find((c) => c.type === 'type_identifier');
        if (t) {
          ctx.emitLocalType({ name: nameNode.text, type: simpleTypeName(t.text), via: 'annotation' });
          return;
        }
        const ct = ctorType(fieldChildren(node, 'value'));
        if (ct) ctx.emitLocalType({ name: nameNode.text, type: ct, via: 'constructor_call' });
        return;
      }
      case 'identifier': {
        // bare name in value position: call argument or list element
        const p = node.parent;
        if (p && (p.type === 'argument' || p.type === 'list_literal') && !/^(this|null|true|false)$/.test(node.text)) ctx.emitRef({ kind: 'value', name: node.text }, node);
        return;
      }
    }
    return;
  },

  resolveModule(source, fromPath) {
    if (source.startsWith('dart:')) return [];
    const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
    if (source.startsWith('package:')) {
      const rest = source.slice('package:'.length);
      const slash = rest.indexOf('/');
      if (slash < 0) return [];
      const pkg = rest.slice(0, slash);
      const path = rest.slice(slash + 1);
      const out = [`lib/${path}`];
      const libIdx = fromPath.indexOf('/lib/');
      if (libIdx >= 0) out.push(`${fromPath.slice(0, libIdx)}/lib/${path}`);
      const libIdx2 = fromPath.lastIndexOf('/lib/');
      if (libIdx2 >= 0 && libIdx2 !== libIdx) out.push(`${fromPath.slice(0, libIdx2)}/lib/${path}`);
      out.push(`packages/${pkg}/lib/${path}`, `${pkg}/lib/${path}`, `apps/${pkg}/lib/${path}`);
      return out;
    }
    return [joinPath(fromDir, source)];
  },
};

function joinPath(dir: string, rel: string): string {
  const parts = (dir ? dir.split('/') : []).concat(rel.split('/'));
  const stack: string[] = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') stack.pop();
    else stack.push(p);
  }
  return stack.join('/');
}
