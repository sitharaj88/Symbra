import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, simpleTypeName, precedingComments, named, kids, reparentReopenedBlocks } from '../parse/walk.js';

/**
 * Objective-C extractor.
 *
 * Objective-C splits a type across `@interface` (the declaration) and `@implementation` (the
 * bodies), plus any number of categories (`@interface Foo (Cat)`) and class extensions
 * (`@interface Foo ()`). Every one of those blocks is indexed as a reopened block named after the
 * type it reopens (`meta.impl` / `meta.extension`), and `reparentReopenedBlocks` moves their
 * members onto the `@interface` when it lives in the same file — the same treatment Rust `impl`
 * and Swift `extension` blocks get, so `Foo.find:` is one symbol rather than one per block.
 *
 * Methods are named by their full selector (`find:other:`) because that, not the first keyword, is
 * what a message send identifies.
 */

const COMMENTS = new Set(['comment']);
/** Macros that declare an enum but do not parse: `typedef NS_ENUM(NSInteger, Status) { … };`. */
const ENUM_MACROS = new Set(['NS_ENUM', 'NS_OPTIONS', 'NS_CLOSED_ENUM', 'NS_ERROR_ENUM', 'CF_ENUM', 'CF_OPTIONS']);
/** C functions from the frameworks: never a symbol defined in the indexed repo. */
const BUILTIN_FUNCTIONS = new Set([
  'NSLog', 'NSAssert', 'NSCAssert', 'NSParameterAssert', 'NSCParameterAssert', 'NSStringFromClass', 'NSStringFromSelector',
  'NSStringFromRange', 'NSMakeRange', 'NSMakeSize', 'NSMakePoint', 'NSMakeRect', 'NSEqualRanges', 'NSLocalizedString',
  'NSSelectorFromString', 'NSClassFromString', 'CGRectMake', 'CGPointMake', 'CGSizeMake', 'CGRectGetWidth', 'CGRectGetHeight',
  'CGRectGetMinX', 'CGRectGetMinY', 'CGRectGetMaxX', 'CGRectGetMaxY', 'CFRelease', 'CFRetain', 'CFBridgingRelease',
  'CFBridgingRetain', 'objc_getClass', 'sizeof', 'malloc', 'free', 'memcpy', 'strlen', 'printf', 'fprintf', 'assert',
  'dispatch_async', 'dispatch_sync', 'dispatch_once', 'dispatch_get_main_queue', 'dispatch_after',
]);
/** Selectors that create an instance rather than call a method on one. */
const ALLOC_SELECTORS = new Set(['alloc', 'new', 'allocWithZone:']);
const PRIMITIVE_TYPES = new Set(['void', 'id', 'instancetype', 'SEL', 'Class', 'IMP', 'BOOL', 'int', 'char', 'float', 'double', 'long', 'short', 'unsigned', 'signed', 'bool', 'size_t', 'nil', 'Nil']);
/** Declarator wrappers between a declaration and the identifier it names. */
const DECL_WRAPPERS = new Set(['pointer_declarator', 'parenthesized_declarator', 'array_declarator', 'attributed_declarator', 'block_pointer_declarator', 'init_declarator', 'struct_declarator']);
const TOP_LEVEL = new Set(['translation_unit', 'preproc_ifdef', 'preproc_if', 'preproc_else', 'preproc_elif', 'compound_statement']);

/** Per-file scratch state, keyed on the walk context so nothing leaks between files. */
interface FileState {
  /** Name of the enum a `typedef NS_ENUM(...)` ERROR node just opened, keyed by that node's id. */
  pendingEnum: { errorId: number; name: string } | null;
  /** Locals bound to `[[NSProcessInfo processInfo] environment]`: subscripts on them read config. */
  envVars: Set<string>;
  /** Classes whose `@interface` inherits XCTestCase; `@implementation` carries no supertypes. */
  testClasses: Set<string>;
}
const states = new WeakMap<WalkContext, FileState>();
function state(ctx: WalkContext): FileState {
  let s = states.get(ctx);
  if (!s) {
    s = { pendingEnum: null, envVars: new Set(), testClasses: new Set() };
    states.set(ctx, s);
  }
  return s;
}

/** Unwrap `*(*name)[4]` / `name = init` down to the identifier it names. */
function declName(decl: Node | null | undefined): Node | null {
  let cur: Node | null = decl ?? null;
  for (let guard = 0; cur && guard < 16; guard++) {
    if (cur.type === 'identifier' || cur.type === 'field_identifier' || cur.type === 'type_identifier') return cur;
    if (cur.type === 'function_declarator' || DECL_WRAPPERS.has(cur.type)) {
      cur = cur.childForFieldName('declarator') ?? named(cur)[0] ?? null;
      continue;
    }
    return null;
  }
  return null;
}

/** The text of a `method_type` / `type_name` wrapper without its parentheses. */
function typeText(n: Node | null | undefined): string {
  if (!n) return '';
  const inner = named(n)[0];
  return oneLine((inner ?? n).text, 80);
}

/** Declaration text up to the start of its body, collapsed to one line. */
function headText(node: Node, body: Node | null | undefined): string {
  const t = body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text;
  return oneLine(t.replace(/[;{]\s*$/, ''));
}

/** `- (User *)find:(NSInteger)i other:(NSString *)b` -> `find:other:`. */
function selectorOf(node: Node): string {
  let sel = '';
  for (const c of kids(node)) {
    if (c.type === 'identifier' || c.type === 'method_identifier') sel += c.text;
    else if (c.type === 'method_parameter') sel += ':';
    else if (c.type === 'keyword_declarator') {
      const id = named(c).find((x) => x.type === 'identifier');
      sel += `${id?.text ?? ''}:`;
    }
  }
  return sel;
}

/** `[obj a:1 b:2]` -> `a:b:` plus the number of arguments. */
function messageSelector(node: Node): { selector: string; arity: number } {
  let selector = '';
  let arity = 0;
  const cs = node.children;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (!c) continue;
    if (node.fieldNameForChild(i) === 'method') selector += c.text;
    else if (c.type === ':') {
      selector += ':';
      arity++;
    }
  }
  return { selector, arity };
}

function protocolNames(node: Node): string[] {
  const list = named(node).find((c) => c.type === 'parameterized_arguments' || c.type === 'protocol_reference_list');
  if (!list) return [];
  const out: string[] = [];
  for (const c of named(list)) {
    const t = c.type === 'type_name' ? (named(c)[0]?.text ?? c.text) : c.text;
    const n = simpleTypeName(t);
    if (n) out.push(n);
  }
  return out;
}

/** True for `@interface Foo (Cat)` and the anonymous class extension `@interface Foo ()`. */
function categoryOf(node: Node): { isCategory: boolean; category: string } {
  const cat = node.childForFieldName('category');
  if (cat) return { isCategory: true, category: cat.text };
  const hasParens = kids(node).some((c) => c.type === '(');
  return { isCategory: hasParens, category: '' };
}

function stringValue(n: Node | null | undefined): string | null {
  if (!n) return null;
  if (n.type !== 'string_literal') return null;
  const content = named(n).find((c) => c.type === 'string_content');
  return content ? content.text : n.text.replace(/^@?"|"$/g, '');
}

function isTestScope(ctx: WalkContext): boolean {
  const cls = ctx.scopeDef;
  if (cls && cls.supertypes.some((s) => /XCTestCase$|TestCase$/.test(simpleTypeName(s.name)))) return true;
  // A method body lives in `@implementation`, which never repeats the superclass: ask the
  // `@interface` seen earlier in the same file.
  if (cls && state(ctx).testClasses.has(cls.name)) return true;
  return objc.isTestFile!(ctx.path);
}

/** Names declared by a `typedef NS_ENUM` body, which the grammar leaves as a bare expression list. */
function enumMacroMembers(stmt: Node, out: Node[]): void {
  for (const c of named(stmt)) {
    if (c.type === 'assignment_expression') {
      const left = c.childForFieldName('left');
      if (left?.type === 'identifier') out.push(left);
    } else if (c.type === 'identifier') out.push(c);
    else if (c.type === 'comma_expression' || c.type === 'expression_statement') enumMacroMembers(c, out);
  }
}

/** The `NS_ENUM(NSInteger, Status)` macro inside an ERROR node, if this node is one. */
function enumMacroName(node: Node): string | null {
  if (node.type !== 'ERROR') return null;
  const macro = named(node).find((c) => c.type === 'macro_type_specifier');
  if (!macro) return null;
  if (!ENUM_MACROS.has(macro.childForFieldName('name')?.text ?? '')) return null;
  // `NS_ENUM(NSInteger, Status)`: the grammar parses the base type and leaves `, Status` in an ERROR.
  const inner = named(macro).find((c) => c.type === 'ERROR');
  const id = named(inner ?? macro).filter((c) => c.type === 'identifier' || c.type === 'type_identifier').pop();
  return id?.text ?? null;
}

function emitTypeRef(t: Node, ctx: WalkContext): void {
  const name = simpleTypeName(t.text);
  if (!name || PRIMITIVE_TYPES.has(name) || !/^[A-Za-z_]/.test(name)) return;
  ctx.emitRef({ kind: 'type', name }, t);
}

export const objc: LanguageSupport = {
  id: 'objc',
  grammar: 'objc',
  // `.h` belongs to the C extractor (see registry): a header that declares `@interface` still parses
  // there, only with errors. `detect` in the report explains how to hand those files over.
  extensions: ['.m', '.mm'],
  classLike: new Set(['class_interface', 'class_implementation', 'protocol_declaration']),
  skip: new Set(['comment', 'system_lib_string']),

  detect(path, content) {
    return /\.(h|hh)$/i.test(path) && /^[ \t]*@(interface|protocol|implementation|import)\b/m.test(content);
  },

  isTestFile(path) {
    return /(^|\/)Tests?\//.test(path) || /Tests?\.mm?$/.test(path) || /Spec\.mm?$/.test(path);
  },

  doc(node) {
    return precedingComments(node, COMMENTS);
  },

  moduleDoc(root) {
    const first = kids(root)[0];
    return first?.type === 'comment' && first.text.startsWith('/*') ? precedingComments(kids(root)[1] ?? first, COMMENTS) : '';
  },

  definition(node, ctx): DefSpec | null {
    switch (node.type) {
      case 'ERROR': {
        // `typedef NS_ENUM(NSInteger, Status) { … };` does not parse; recover the enum by hand.
        const name = enumMacroName(node);
        if (!name) return null;
        state(ctx).pendingEnum = { errorId: node.id, name };
        return { kind: 'enum', name, signature: oneLine(node.text, 120), doc: precedingComments(node, COMMENTS), exported: true };
      }
      case 'class_interface': {
        const name = named(node).find((c) => c.type === 'identifier')?.text ?? '';
        if (!name) return null;
        const { isCategory, category } = categoryOf(node);
        const superclass = node.childForFieldName('superclass')?.text ?? '';
        const supertypes: NonNullable<DefSpec['supertypes']> = [];
        const protos = protocolNames(node);
        if (superclass) supertypes.push({ name: superclass, kind: 'extends' });
        for (const p of protos) supertypes.push({ name: p, kind: 'implements' });
        const meta: DefSpec['meta'] = { interface: true };
        if (isCategory) {
          meta.extension = true;
          meta.container = name;
          if (category) meta.category = category;
        }
        if (supertypes.some((t) => /XCTestCase$|TestCase$/.test(simpleTypeName(t.name)))) state(ctx).testClasses.add(name);
        const sig = `@interface ${name}${isCategory ? ` (${category})` : ''}${superclass ? ` : ${superclass}` : ''}${protos.length ? ` <${protos.join(', ')}>` : ''}`;
        return { kind: 'class', name, signature: oneLine(sig), doc: precedingComments(node, COMMENTS), exported: true, supertypes, meta };
      }
      case 'class_implementation': {
        const name = named(node).find((c) => c.type === 'identifier')?.text ?? '';
        if (!name) return null;
        const { isCategory, category } = categoryOf(node);
        const meta: DefSpec['meta'] = isCategory ? { extension: true, container: name } : { impl: true };
        if (isCategory && category) meta.category = category;
        return { kind: 'class', name, signature: oneLine(`@implementation ${name}${category ? ` (${category})` : isCategory ? ' ()' : ''}`), doc: precedingComments(node, COMMENTS), exported: true, meta };
      }
      case 'protocol_declaration': {
        const name = named(node).find((c) => c.type === 'identifier')?.text ?? '';
        if (!name) return null;
        return { kind: 'interface', name, signature: oneLine(`@protocol ${name}`), doc: precedingComments(node, COMMENTS), exported: true, supertypes: protocolNames(node).map((p) => ({ name: p, kind: 'extends' as const })) };
      }
      case 'method_declaration':
      case 'method_definition': {
        const name = selectorOf(node);
        if (!name) return null;
        const isClassMethod = kids(node)[0]?.type === '+';
        const modifiers = isClassMethod ? ['static'] : [];
        const body = named(node).find((c) => c.type === 'compound_statement');
        const ret = typeText(named(node).find((c) => c.type === 'method_type'));
        let kind: DefSpec['kind'] = ctx.inClass ? 'method' : 'function';
        if (/^test/.test(name) && node.type === 'method_definition' && isTestScope(ctx)) kind = 'test';
        const meta: DefSpec['meta'] = { selector: name };
        if (node.type === 'method_declaration') meta.declaration = true;
        return { kind, name, body, signature: headText(node, body), doc: precedingComments(node, COMMENTS), modifiers, exported: true, declaredType: ret ? simpleTypeName(ret) : undefined, meta };
      }
      case 'property_declaration': {
        const decl = named(node).find((c) => c.type === 'struct_declaration');
        const nameNode = declName(decl?.childForFieldName('declarator') ?? named(decl).find((c) => c.type === 'struct_declarator'));
        if (!nameNode) return null;
        const typeNode = named(decl).find((c) => c.type === 'type_identifier' || c.type === 'primitive_type' || c.type === 'sized_type_specifier' || c.type === 'typedefed_specifier');
        const attrs = named(node).find((c) => c.type === 'property_attributes_declaration');
        const modifiers = attrs ? named(attrs).map((a) => a.text) : [];
        return {
          kind: 'field',
          name: nameNode.text,
          signature: oneLine(node.text.replace(/;\s*$/, '')),
          doc: precedingComments(node, COMMENTS),
          modifiers,
          exported: !modifiers.includes('private'),
          declaredType: typeNode ? simpleTypeName(typeNode.text) : undefined,
          meta: { property: true },
        };
      }
      case 'instance_variable': {
        const decl = named(node).find((c) => c.type === 'struct_declaration');
        if (!decl) return null;
        const nameNode = declName(named(decl).find((c) => c.type === 'struct_declarator'));
        if (!nameNode) return null;
        const typeNode = named(decl)[0];
        return { kind: 'field', name: nameNode.text, signature: oneLine(decl.text.replace(/;\s*$/, '')), doc: precedingComments(node, COMMENTS), exported: false, declaredType: typeNode ? simpleTypeName(typeNode.text) : undefined, meta: { ivar: true } };
      }
      case 'function_definition': {
        const nameNode = declName(node.childForFieldName('declarator'));
        if (!nameNode) return null;
        const body = node.childForFieldName('body');
        const mods = named(node).filter((c) => c.type === 'storage_class_specifier').map((c) => c.text);
        return { kind: 'function', name: nameNode.text, body, signature: headText(node, body), doc: precedingComments(node, COMMENTS), modifiers: mods, exported: !mods.includes('static'), declaredType: simpleTypeName(node.childForFieldName('type')?.text ?? '') || undefined };
      }
      case 'declaration': {
        if (!TOP_LEVEL.has(node.parent?.type ?? '')) return null;
        const declarator = node.childForFieldName('declarator');
        if (declarator?.type === 'function_declarator') {
          const fnName = declName(declarator);
          if (!fnName) return null;
          return { kind: 'function', name: fnName.text, signature: headText(node, null), doc: precedingComments(node, COMMENTS), exported: true, meta: { declaration: true } };
        }
        const nameNode = declName(declarator);
        if (!nameNode) return null;
        const mods = named(node).filter((c) => c.type === 'storage_class_specifier').map((c) => c.text);
        const isConst = /\bconst\b/.test(node.text.slice(0, nameNode.startIndex - node.startIndex));
        const t = node.childForFieldName('type');
        return { kind: isConst ? 'constant' : 'variable', name: nameNode.text, signature: headText(node, null), doc: precedingComments(node, COMMENTS), modifiers: mods, exported: !mods.includes('static'), declaredType: t ? simpleTypeName(t.text) : undefined };
      }
      case 'type_definition': {
        const nameNode = declName(node.childForFieldName('declarator'));
        if (!nameNode) return null;
        return { kind: 'type_alias', name: nameNode.text, signature: oneLine(node.text.replace(/;\s*$/, ''), 160), doc: precedingComments(node, COMMENTS), exported: true };
      }
      case 'enum_specifier': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return { kind: 'enum', name: nameNode.text, signature: oneLine(`enum ${nameNode.text}`), doc: precedingComments(node, COMMENTS), exported: true };
      }
      case 'struct_specifier':
      case 'union_specifier': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode || !node.childForFieldName('body')) return null;
        return { kind: 'struct', name: nameNode.text, signature: oneLine(`${node.type === 'union_specifier' ? 'union' : 'struct'} ${nameNode.text}`), doc: precedingComments(node, COMMENTS), exported: true };
      }
      case 'enumerator': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return null;
        return { kind: 'enum_member', name: nameNode.text, signature: oneLine(node.text, 80), doc: precedingComments(node, COMMENTS), exported: true };
      }
      case 'compatibility_alias_declaration': {
        const ids = named(node).filter((c) => c.type === 'identifier');
        if (ids.length < 1) return null;
        return { kind: 'type_alias', name: ids[0]!.text, signature: oneLine(node.text), exported: true };
      }
    }
    return null;
  },

  imports(node): Import[] | null {
    const line = node.startPosition.row + 1;
    if (node.type === 'preproc_include') {
      const path = node.childForFieldName('path');
      if (!path) return [];
      // `#import <Foundation/Foundation.h>` is a framework header; `#import "Repo.h"` is local.
      if (path.type === 'system_lib_string') {
        const source = path.text.replace(/^<|>$/g, '');
        return [{ source, names: [], namespace: true, alias: simpleTypeName(source), kind: 'static', line }];
      }
      const source = stringValue(path) ?? '';
      if (!source) return [];
      return [{ source, names: [], namespace: true, alias: simpleTypeName(source), kind: 'static', line }];
    }
    if (node.type === 'module_import') {
      const source = node.childForFieldName('path')?.text ?? named(node)[0]?.text ?? '';
      if (!source) return [];
      return [{ source, names: [], namespace: true, alias: source.split('.')[0]!, kind: 'static', line }];
    }
    return null;
  },

  references(node, ctx) {
    const st = state(ctx);
    switch (node.type) {
      case 'expression_statement': {
        // Members of a recovered `typedef NS_ENUM(…) { … }` body: the block is a sibling of the
        // ERROR node that opened the enum, so attach them by fqn container rather than by parent.
        const pending = st.pendingEnum;
        const block = node.parent;
        if (pending && block?.type === 'compound_statement' && block.previousSibling?.id === pending.errorId && named(block)[0]?.id === node.id) {
          st.pendingEnum = null;
          const members: Node[] = [];
          enumMacroMembers(node, members);
          for (const m of members) ctx.emitDef({ kind: 'enum_member', name: m.text, signature: m.text, exported: true, container: pending.name, rangeNode: m }, m, -1);
          return true;
        }
        return;
      }
      case 'message_expression': {
        const receiver = node.childForFieldName('receiver');
        const { selector, arity } = messageSelector(node);
        if (!selector) return;
        const recvText = receiver ? oneLine(receiver.text, 80) : '';
        // `[[NSProcessInfo processInfo] environment]` is the env dictionary: remember the binding.
        if (selector === 'environment' && /NSProcessInfo/.test(recvText)) {
          const holder = node.parent?.type === 'init_declarator' ? declName(node.parent.childForFieldName('declarator')) : null;
          if (holder) st.envVars.add(holder.text);
          return;
        }
        if (selector === 'objectForKey:' && /NSProcessInfo|environment/.test(recvText)) {
          const key = stringValue(named(node).find((c) => c.type === 'string_literal'));
          if (key) ctx.emitRef({ kind: 'config', name: key }, node);
          return;
        }
        if (ALLOC_SELECTORS.has(selector) && receiver?.type === 'identifier' && /^[A-Z]/.test(receiver.text)) {
          ctx.emitRef({ kind: 'new', name: receiver.text }, receiver);
          return;
        }
        // `[[Foo alloc] initWithX:y]`: the construction is of Foo, and `initWithX:` is Foo's method.
        if (/^init/.test(selector) && receiver?.type === 'message_expression') {
          const inner = receiver.childForFieldName('receiver');
          const innerSel = messageSelector(receiver).selector;
          if (inner?.type === 'identifier' && ALLOC_SELECTORS.has(innerSel) && /^[A-Z]/.test(inner.text)) {
            ctx.emitRef({ kind: 'new', name: inner.text, arity }, node);
            ctx.emitRef({ kind: 'call', name: selector, qualifier: inner.text, arity }, node);
            return;
          }
        }
        const qualifier = receiver?.type === 'identifier' && receiver.text === 'self' ? 'self' : receiver?.text === 'super' ? 'super' : recvText;
        ctx.emitRef({ kind: 'call', name: selector, qualifier, arity }, node);
        return;
      }
      case 'call_expression': {
        const fn = node.childForFieldName('function');
        const args = node.childForFieldName('arguments');
        if (!fn) return;
        const arity = named(args).length;
        if (fn.type === 'identifier') {
          if (fn.text === 'getenv' || fn.text === 'secure_getenv') {
            const key = stringValue(named(args)[0]);
            if (key) ctx.emitRef({ kind: 'config', name: key }, fn);
            return;
          }
          if (BUILTIN_FUNCTIONS.has(fn.text) || /^(XCT|NSAssert|CGRect|CGPoint|CGSize)/.test(fn.text)) return;
          ctx.emitRef({ kind: 'call', name: fn.text, arity }, fn);
        } else if (fn.type === 'field_expression') {
          const field = fn.childForFieldName('field');
          const arg = fn.childForFieldName('argument');
          if (field) ctx.emitRef({ kind: 'call', name: field.text, qualifier: arg?.text ?? '', arity }, field);
        }
        return;
      }
      case 'subscript_expression': {
        // `env[@"HOME"]` where `env` came from `[[NSProcessInfo processInfo] environment]`.
        const arg = node.childForFieldName('argument');
        const index = node.childForFieldName('index');
        const holder = arg?.text ?? '';
        if (st.envVars.has(holder) || /environment\]$/.test(holder)) {
          const key = stringValue(index);
          if (key) ctx.emitRef({ kind: 'config', name: key }, index ?? node);
        }
        return;
      }
      case 'field_expression': {
        // `self.session` / `super.x`: a property read the resolver can bind through the class.
        const arg = node.childForFieldName('argument');
        const field = node.childForFieldName('field');
        if (field && (arg?.text === 'self' || arg?.text === 'super')) ctx.emitRef({ kind: 'value', name: field.text, qualifier: arg.text }, field);
        return;
      }
      case 'declaration': {
        const t = node.childForFieldName('type');
        for (const d of named(node)) {
          if (d.type !== 'init_declarator' && !DECL_WRAPPERS.has(d.type) && d.type !== 'identifier') continue;
          const nameNode = declName(d);
          if (!nameNode) continue;
          if (t) ctx.emitLocalType({ name: nameNode.text, type: simpleTypeName(t.text), via: 'annotation' });
          const value = d.type === 'init_declarator' ? d.childForFieldName('value') : null;
          if (!t && value?.type === 'message_expression') {
            const cls = allocatedClass(value);
            if (cls) ctx.emitLocalType({ name: nameNode.text, type: cls, via: 'new' });
          }
        }
        return;
      }
      case 'method_parameter': {
        const nameNode = named(node).find((c) => c.type === 'identifier');
        const t = named(node).find((c) => c.type === 'method_type');
        if (nameNode && t) {
          const type = simpleTypeName(typeText(t));
          if (type) ctx.emitLocalType({ name: nameNode.text, type, via: 'annotation' });
        }
        return;
      }
      case 'parameter_declaration': {
        const nameNode = declName(node.childForFieldName('declarator'));
        const t = node.childForFieldName('type');
        if (nameNode && t) ctx.emitLocalType({ name: nameNode.text, type: simpleTypeName(t.text), via: 'annotation' });
        return;
      }
      case 'assignment_expression': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (left && right?.type === 'message_expression') {
          const cls = allocatedClass(right);
          if (cls) ctx.emitLocalType({ name: oneLine(left.text, 80).replace(/\s+/g, ''), type: cls, via: 'new' });
        }
        return;
      }
      case 'parameterized_arguments':
      case 'protocol_reference_list':
        return true; // protocols are already recorded as supertypes
      case 'type_identifier': {
        emitTypeRef(node, ctx);
        return true;
      }
    }
    return;
  },

  postWalk: reparentReopenedBlocks,

  resolveModule(source, fromPath, imp, project) {
    // `@import Foundation;` and `#import <UIKit/UIKit.h>` name frameworks, not repo files.
    if (!/\.(h|hh|hpp|m|mm)$/.test(source)) return [];
    const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
    const out: string[] = [];
    const push = (p: string) => {
      const n = normalizePath(p);
      if (n && !out.includes(n)) out.push(n);
    };
    push(fromDir ? `${fromDir}/${source}` : source);
    push(source);
    // `#import <MyLib/MyLib.h>` inside the repo that builds MyLib: try the bare header too.
    const base = source.slice(source.lastIndexOf('/') + 1);
    if (base !== source) push(fromDir ? `${fromDir}/${base}` : base);
    // A header has no bodies; the implementation next to it is what callers actually want.
    for (const p of [...out]) {
      push(p.replace(/\.h$/, '.m'));
      push(p.replace(/\.h$/, '.mm'));
    }
    for (const root of ['include', 'src', 'Sources', 'Classes']) push(`${root}/${source}`);
    let d = fromDir;
    while (d) {
      d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
      if (d) push(`${d}/${source}`);
    }
    void imp;
    void project;
    return out;
  },
};

/** The class constructed by `[Foo alloc]` / `[[Foo alloc] init…]`, if this message is one. */
function allocatedClass(msg: Node): string | undefined {
  const receiver = msg.childForFieldName('receiver');
  const { selector } = messageSelector(msg);
  if (ALLOC_SELECTORS.has(selector) && receiver?.type === 'identifier' && /^[A-Z]/.test(receiver.text)) return receiver.text;
  if (/^init/.test(selector) && receiver?.type === 'message_expression') return allocatedClass(receiver);
  return undefined;
}

function normalizePath(p: string): string {
  const stack: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return stack.join('/');
}
