import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, simpleTypeName, precedingComments, named, kids, reparentReopenedBlocks } from '../parse/walk.js';

/** Marker `resolveModule` returns for `import <Target>`; the resolver maps it to the target's files. */
export const SWIFT_TARGET_PREFIX = 'swift-target:';

const COMMENTS = new Set(['comment', 'multiline_comment']);
const TYPE_NODES = new Set(['user_type', 'optional_type', 'array_type', 'dictionary_type', 'tuple_type', 'function_type', 'metatype', 'opaque_type', 'existential_type', 'protocol_composition_type']);
const DEF_HOLDERS = new Set(['source_file', 'class_body', 'enum_class_body', 'protocol_body']);
/** Standard-library protocols that commonly appear first in an inheritance list of a class. */
const KNOWN_PROTOCOLS = new Set(['Codable', 'Decodable', 'Encodable', 'Equatable', 'Hashable', 'Comparable', 'Sendable', 'Identifiable', 'Error', 'LocalizedError', 'CustomStringConvertible', 'CustomDebugStringConvertible', 'ObservableObject', 'View', 'App', 'Scene', 'CaseIterable', 'RawRepresentable', 'Collection', 'Sequence', 'Copyable', 'AnyObject', 'Actor', 'Observable', 'Codable', 'Sendable', 'Hashable']);
/** Raw-value types of enums: not real supertypes. */
const RAW_TYPES = new Set(['String', 'Int', 'UInt', 'Int8', 'Int16', 'Int32', 'Int64', 'UInt8', 'UInt16', 'UInt32', 'UInt64', 'Double', 'Float', 'Character', 'Bool']);
/** Identifiers that are never meaningful function/closure values when passed as an argument. */
const SWIFT_VALUE_SKIP = new Set(['self', 'nil', 'true', 'false']);

/** Children carrying a given field name (a field may repeat, e.g. `enum_entry` names). */
function fieldChildren(node: Node, field: string): Node[] {
  const out: Node[] = [];
  const cs = node.children;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (c && node.fieldNameForChild(i) === field) out.push(c);
  }
  return out;
}

function modifiersOf(node: Node): { mods: string[]; attrs: string[] } {
  const mods: string[] = [];
  const attrs: string[] = [];
  for (const m of named(node).filter((c) => c.type === 'modifiers')) {
    for (const c of named(m)) {
      if (c.type === 'attribute') {
        const ut = named(c).find((x) => x.type === 'user_type');
        attrs.push(simpleTypeName(ut?.text ?? c.text.replace(/^@/, '')));
        continue;
      }
      const t = c.text.trim();
      if (t) mods.push(t);
    }
  }
  if (kids(node).some((c) => c.type === 'async')) mods.push('async');
  return { mods, attrs };
}

function isExported(mods: string[]): boolean {
  return !mods.includes('private') && !mods.includes('fileprivate');
}

/** Declaration text up to the start of its body, collapsed to one line. */
function headText(node: Node, body: Node | null | undefined): string {
  const t = body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text;
  return oneLine(t.replace(/\{\s*$/, ''));
}

function supertypesOf(node: Node, declKind: string): NonNullable<DefSpec['supertypes']> {
  const names = named(node)
    .filter((c) => c.type === 'inheritance_specifier')
    .map((c) => c.childForFieldName('inherits_from')?.text ?? c.text)
    .map((t) => t.trim())
    .filter(Boolean);
  const out: NonNullable<DefSpec['supertypes']> = [];
  names.forEach((n, i) => {
    const simple = simpleTypeName(n);
    if (declKind === 'enum' && RAW_TYPES.has(simple)) return;
    let kind: 'extends' | 'implements' = 'implements';
    if (declKind === 'protocol') kind = 'extends';
    else if ((declKind === 'class' || declKind === 'actor') && i === 0 && !KNOWN_PROTOCOLS.has(simple) && !/Protocol$|able$|Delegate$|DataSource$/.test(simple)) kind = 'extends';
    out.push({ name: n, kind });
  });
  return out;
}

function stringValue(n: Node | null | undefined): string | null {
  if (!n) return null;
  if (n.type === 'line_string_literal' || n.type === 'raw_string_literal') return n.text.replace(/^#*"|"#*$/g, '');
  return null;
}

function firstArgString(suffix: Node | null | undefined): string | null {
  const args = named(suffix).find((c) => c.type === 'value_arguments');
  const first = named(args)[0];
  return stringValue(first?.childForFieldName('value') ?? named(first)[0]);
}

function emitTypeRefs(t: Node, ctx: WalkContext) {
  const stack: Node[] = [t];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'user_type') {
      const ids = named(n).filter((c) => c.type === 'type_identifier').map((c) => c.text);
      const last = named(n).filter((c) => c.type === 'type_identifier').pop();
      if (last && ids.length) ctx.emitRef({ kind: 'type', name: ids[ids.length - 1]!, qualifier: ids.slice(0, -1).join('.') }, last);
      for (const c of named(n)) if (c.type === 'type_arguments') stack.push(c);
      continue;
    }
    for (const c of named(n)) stack.push(c);
  }
}

function isTestClass(def: { supertypes: { name: string }[] } | null): boolean {
  return !!def?.supertypes.some((s) => /XCTestCase$|TestCase$/.test(simpleTypeName(s.name)));
}

function ctorType(value: Node | null | undefined): string | undefined {
  if (value?.type !== 'call_expression') return undefined;
  const callee = named(value)[0];
  if (callee?.type === 'simple_identifier' && /^[A-Z]/.test(callee.text)) return callee.text;
  return undefined;
}

export const swift: LanguageSupport = {
  id: 'swift',
  grammar: 'swift',
  extensions: ['.swift'],
  classLike: new Set(['class_declaration', 'protocol_declaration']),
  skip: new Set(['comment', 'multiline_comment', 'line_string_literal', 'multi_line_string_literal', 'raw_string_literal', 'regex_literal']),

  isTestFile(path) {
    return /(^|\/)Tests?\//.test(path) || /Tests?\.swift$/.test(path) || /Spec\.swift$/.test(path);
  },

  doc(node) {
    return precedingComments(node, COMMENTS);
  },

  definition(node, ctx): DefSpec | null {
    switch (node.type) {
      case 'class_declaration': {
        const dk = node.childForFieldName('declaration_kind')?.text ?? 'class';
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        const name = simpleTypeName(nameNode.text);
        const body = node.childForFieldName('body');
        const { mods } = modifiersOf(node);
        const supertypes = supertypesOf(node, dk);
        const kind: DefSpec['kind'] = dk === 'struct' ? 'struct' : dk === 'enum' ? 'enum' : 'class';
        const meta: DefSpec['meta'] = {};
        if (dk === 'extension') meta.extension = true;
        if (dk === 'actor') meta.actor = true;
        return { kind, name, body, signature: headText(node, body), doc: precedingComments(node, COMMENTS), modifiers: mods, exported: isExported(mods), supertypes, meta: Object.keys(meta).length ? meta : undefined };
      }
      case 'protocol_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const body = node.childForFieldName('body');
        const { mods } = modifiersOf(node);
        return { kind: 'interface', name, body, signature: headText(node, body), doc: precedingComments(node, COMMENTS), modifiers: mods, exported: isExported(mods), supertypes: supertypesOf(node, 'protocol') };
      }
      case 'function_declaration':
      case 'protocol_function_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const { mods, attrs } = modifiersOf(node);
        const body = node.childForFieldName('body');
        let kind: DefSpec['kind'] = ctx.inClass ? 'method' : 'function';
        if ((/^test/.test(name) && (isTestClass(ctx.scopeDef) || swift.isTestFile!(ctx.path))) || attrs.includes('Test')) kind = 'test';
        if (mods.includes('class')) mods.push('static');
        return { kind, name, body, signature: headText(node, body), doc: precedingComments(node, COMMENTS), modifiers: mods, exported: isExported(mods), meta: attrs.length ? { attributes: attrs.join(',') } : undefined };
      }
      case 'init_declaration':
      case 'deinit_declaration':
      case 'subscript_declaration': {
        const { mods } = modifiersOf(node);
        const body = node.childForFieldName('body');
        const name = node.type === 'init_declaration' ? 'init' : node.type === 'deinit_declaration' ? 'deinit' : 'subscript';
        return { kind: node.type === 'init_declaration' ? 'constructor' : 'method', name, body, signature: headText(node, body), doc: precedingComments(node, COMMENTS), modifiers: mods, exported: isExported(mods) };
      }
      case 'property_declaration':
      case 'protocol_property_declaration': {
        const owner = node.parent;
        if (!owner || !DEF_HOLDERS.has(owner.type)) return null;
        const pat = node.childForFieldName('name');
        const nameNode = pat?.childForFieldName('bound_identifier') ?? named(pat).find((c) => c.type === 'simple_identifier');
        const name = nameNode?.text ?? '';
        if (!name) return null;
        const { mods, attrs } = modifiersOf(node);
        const mut = (node.descendantsOfType('value_binding_pattern')[0]?.childForFieldName('mutability')?.text ?? 'var').trim();
        const typeNode = named(node).find((c) => c.type === 'type_annotation')?.childForFieldName('name');
        const value = node.childForFieldName('value');
        const declaredType = typeNode ? simpleTypeName(typeNode.text) : ctorType(value);
        const computed = node.childForFieldName('computed_value');
        const isComputed = !!computed || node.type === 'protocol_property_declaration';
        const topLevel = owner.type === 'source_file';
        const kind: DefSpec['kind'] = topLevel ? (mut === 'let' ? 'constant' : 'variable') : isComputed ? 'property' : 'field';
        return { kind, name, body: computed, signature: headText(node, computed), doc: precedingComments(node, COMMENTS), modifiers: mods, exported: isExported(mods), declaredType, meta: attrs.length ? { attributes: attrs.join(',') } : undefined };
      }
      case 'enum_entry': {
        // `case a, b, c`: emitDef runs before the walker registers the returned spec, so emit the
        // leading names first and return the last one to keep ordinals in source order.
        const names = fieldChildren(node, 'name');
        if (!names.length) return null;
        const doc = precedingComments(node, COMMENTS);
        for (const extra of names.slice(0, -1)) ctx.emitDef({ kind: 'enum_member', name: extra.text, signature: extra.text, doc, exported: true, rangeNode: extra }, extra, ctx.scope);
        const last = names[names.length - 1]!;
        return { kind: 'enum_member', name: last.text, signature: names.length > 1 ? last.text : oneLine(node.text, 120), doc, exported: true, rangeNode: names.length > 1 ? last : undefined };
      }
      case 'typealias_declaration':
      case 'associatedtype_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const { mods } = modifiersOf(node);
        return { kind: 'type_alias', name, signature: oneLine(node.text, 200), doc: precedingComments(node, COMMENTS), modifiers: mods, exported: isExported(mods) };
      }
    }
    return null;
  },

  imports(node): Import[] | null {
    if (node.type !== 'import_declaration') return null;
    const id = named(node).find((c) => c.type === 'identifier');
    const source = id?.text ?? '';
    if (!source) return [];
    return [{ source, names: [], namespace: true, alias: source.split('.')[0]!, kind: 'static', line: node.startPosition.row + 1 }];
  },

  references(node, ctx) {
    switch (node.type) {
      case 'call_expression': {
        const callee = named(node)[0];
        const suffix = named(node).find((c) => c.type === 'call_suffix');
        if (!callee || !suffix) return;
        const isSubscript = suffix.text.startsWith('[');
        const args = named(suffix).find((c) => c.type === 'value_arguments');
        const arity = args ? named(args).length : named(suffix).some((c) => c.type === 'lambda_literal') ? 1 : 0;
        if (callee.type === 'simple_identifier') {
          if (callee.text === 'getenv') {
            const key = firstArgString(suffix);
            if (key) ctx.emitRef({ kind: 'config', name: key }, callee);
          }
          if (!isSubscript) ctx.emitRef({ kind: /^[A-Z]/.test(callee.text) && !/^XCT/.test(callee.text) ? 'new' : 'call', name: callee.text, arity }, callee);
        } else if (callee.type === 'navigation_expression') {
          const target = callee.childForFieldName('target');
          const nameNode = callee.childForFieldName('suffix')?.childForFieldName('suffix');
          if (!nameNode) return;
          const name = nameNode.text;
          const qualifier = target?.type === 'self_expression' ? 'self' : target?.type === 'super_expression' ? 'super' : (target?.text ?? '');
          if (name === 'environment' && /ProcessInfo/.test(qualifier)) {
            const key = firstArgString(suffix);
            if (key) ctx.emitRef({ kind: 'config', name: key }, nameNode);
            return;
          }
          if (!isSubscript) ctx.emitRef({ kind: /^[A-Z]/.test(name) ? 'new' : 'call', name, qualifier, arity }, nameNode);
        }
        return;
      }
      case 'user_type': {
        const p = node.parent?.type;
        if (p === 'inheritance_specifier' || p === 'attribute') return true;
        emitTypeRefs(node, ctx);
        return true;
      }
      case 'attribute': {
        const ut = named(node).find((c) => c.type === 'user_type');
        if (ut) ctx.emitRef({ kind: 'decorator', name: simpleTypeName(ut.text) }, ut);
        return true;
      }
      case 'parameter': {
        const nameNode = node.childForFieldName('name');
        const t = named(node).find((c) => TYPE_NODES.has(c.type));
        if (nameNode?.type === 'simple_identifier' && t) {
          ctx.emitLocalType({ name: nameNode.text, type: simpleTypeName(t.text), via: 'annotation' });
          emitTypeRefs(t, ctx);
        }
        return true;
      }
      case 'property_declaration': {
        // local binding inside a function body: record receiver type facts
        if (DEF_HOLDERS.has(node.parent?.type ?? '')) return;
        const pat = node.childForFieldName('name');
        const name = pat?.childForFieldName('bound_identifier')?.text ?? '';
        if (!name) return;
        const typeNode = named(node).find((c) => c.type === 'type_annotation')?.childForFieldName('name');
        if (typeNode) ctx.emitLocalType({ name, type: simpleTypeName(typeNode.text), via: 'annotation' });
        else {
          const t = ctorType(node.childForFieldName('value'));
          if (t) ctx.emitLocalType({ name, type: t, via: 'constructor_call' });
        }
        return;
      }
      case 'assignment': {
        // self.x = Foo()
        const target = node.childForFieldName('target');
        const t = ctorType(node.childForFieldName('result'));
        if (target && t) ctx.emitLocalType({ name: target.text.replace(/\s+/g, ''), type: t, via: 'constructor_call' });
        return;
      }
      case 'simple_identifier': {
        // A bare identifier passed as an argument (`retry(after: myHandler)`) or inside an array
        // literal argument (`[callback1, callback2]`) is a function/closure value being handed off,
        // not called here — record it as a `passes` edge so the resolver can still connect the
        // caller to the callback it hands to another function.
        if (SWIFT_VALUE_SKIP.has(node.text)) return;
        const p = node.parent;
        if (!p) return;
        if (p.type === 'value_argument') {
          const nc = named(p);
          if (nc[nc.length - 1]?.id === node.id) ctx.emitRef({ kind: 'value', name: node.text }, node);
        } else if (p.type === 'array_literal') {
          ctx.emitRef({ kind: 'value', name: node.text }, node);
        }
        return;
      }
    }
    return;
  },

  postWalk: reparentReopenedBlocks,

  resolveModule(source, _fromPath, _imp, project) {
    // Swift modules are targets/frameworks, not files. An import of a target built in this repo
    // resolves to the marker the resolver expands into that target's files; anything else is an
    // external framework.
    const name = source.split('.')[0]!;
    return project.swiftTargets?.has(name) ? [`${SWIFT_TARGET_PREFIX}${name}`] : [];
  },
};
