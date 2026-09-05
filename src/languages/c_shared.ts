import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext, ModuleResolutionContext } from './types.js';
import { oneLine, simpleTypeName, precedingComments, named, kids } from '../parse/walk.js';

/**
 * Shared extractor for the C family (C and C++). The C++ grammar is a superset of
 * the C grammar: node types that only exist in C++ (class_specifier, namespace_definition,
 * qualified_identifier, template_*) simply never appear in C trees.
 */

const COMMENTS = new Set(['comment']);
const GTEST = new Set(['TEST', 'TEST_F', 'TEST_P', 'TYPED_TEST', 'TYPED_TEST_P']);
const CATCH = new Set(['TEST_CASE', 'SCENARIO', 'TEMPLATE_TEST_CASE', 'TEST_CASE_METHOD']);
/** Parents under which a `declaration` is a definition rather than a local. */
const PREPROC_BLOCKS = new Set(['preproc_ifdef', 'preproc_if', 'preproc_else', 'preproc_elif', 'preproc_elifdef']);
const DECL_PARENTS = new Set(['translation_unit', 'preproc_ifdef', 'preproc_if', 'preproc_else', 'preproc_elif', 'preproc_elifdef', 'declaration_list', 'field_declaration_list', 'linkage_specification', 'template_declaration', 'export_block']);
const SPECIFIERS = new Set(['struct_specifier', 'union_specifier', 'enum_specifier', 'class_specifier']);
const NAME_TYPES = new Set(['identifier', 'field_identifier', 'type_identifier', 'qualified_identifier', 'destructor_name', 'operator_name', 'template_function', 'template_method']);
const WRAPPERS = new Set(['pointer_declarator', 'parenthesized_declarator', 'reference_declarator', 'attributed_declarator', 'array_declarator']);
const SMART_PTR_MAKERS = new Set(['make_unique', 'make_shared']);
/** Wrapper templates whose first argument is the type that matters for receiver typing. */
const SMART_PTRS = new Set(['unique_ptr', 'shared_ptr', 'weak_ptr', 'optional', 'reference_wrapper']);

interface Declarator {
  /** Innermost name node (identifier / field_identifier / qualified_identifier / destructor_name / operator_name). */
  name: Node | null;
  /** Innermost function_declarator (the one whose parameters belong to the named function). */
  fn: Node | null;
  /** Initializer value of an init_declarator, if any. */
  init: Node | null;
}

/** Walk a declarator chain (`*(*name)(int)`, `&name`, `name[4]`, `name = v`) down to its name. */
function unwrap(decl: Node | null | undefined): Declarator {
  let name: Node | null = null;
  let fn: Node | null = null;
  let init: Node | null = null;
  let cur: Node | null = decl ?? null;
  while (cur) {
    if (NAME_TYPES.has(cur.type)) {
      name = cur;
      break;
    }
    if (cur.type === 'function_declarator') {
      fn = cur;
      cur = cur.childForFieldName('declarator');
      continue;
    }
    if (cur.type === 'init_declarator') {
      init = cur.childForFieldName('value');
      cur = cur.childForFieldName('declarator');
      continue;
    }
    if (WRAPPERS.has(cur.type)) {
      cur = cur.childForFieldName('declarator') ?? named(cur)[0] ?? null;
      continue;
    }
    break;
  }
  return { name, fn, init };
}

/** Split `a::b::name` into its final name node and the qualifier text before it. */
function splitQualified(n: Node): { last: Node; qualifier: string } {
  let last = n;
  while (last.type === 'qualified_identifier') {
    const nm = last.childForFieldName('name');
    if (!nm) break;
    last = nm;
  }
  const qualifier = n.text.slice(0, Math.max(0, n.text.length - last.text.length)).replace(/::\s*$/, '');
  return { last, qualifier };
}

/** `ns::Box<T>` -> `ns.Box` (dots, generics stripped per segment). */
function dotted(q: string): string {
  return q
    .split('::')
    .map((s) => simpleTypeName(s))
    .filter(Boolean)
    .join('.');
}

/** Name of a type node as a simple identifier, or '' for primitives / auto. */
function typeNameOf(t: Node | null | undefined): string {
  if (!t) return '';
  switch (t.type) {
    case 'struct_specifier':
    case 'union_specifier':
    case 'enum_specifier':
    case 'class_specifier':
      return typeNameOf(t.childForFieldName('name'));
    case 'placeholder_type_specifier':
    case 'decltype':
      return '';
    case 'primitive_type':
    case 'sized_type_specifier':
      return t.text.replace(/\s+/g, ' ');
    case 'template_type': {
      const nm = t.childForFieldName('name');
      if (nm && SMART_PTRS.has(nm.text)) {
        const first = named(t.childForFieldName('arguments'))[0];
        const inner = typeNameOf(first);
        if (inner) return inner;
      }
      return typeNameOf(nm);
    }
    case 'qualified_identifier':
      return typeNameOf(t.childForFieldName('name'));
    case 'type_descriptor':
      return typeNameOf(t.childForFieldName('type'));
    default:
      return simpleTypeName(t.text);
  }
}

/**
 * Conditional-compilation blocks are transparent: a `#ifdef` inside a function body still holds
 * *local* declarations. Without this, such a declaration looked top-level, became a `variable`
 * definition, and — because the walker makes every definition the enclosing scope — took
 * ownership of the calls in its own initializer (`src/os.cc::run.file` owning `convert()`).
 */
function isTopLevel(node: Node): boolean {
  let p = node.parent;
  while (p && PREPROC_BLOCKS.has(p.type)) p = p.parent;
  return !!p && DECL_PARENTS.has(p.type);
}

function isSpecifierName(node: Node): boolean {
  const p = node.parent;
  if (!p || !SPECIFIERS.has(p.type)) return false;
  const nm = p.childForFieldName('name');
  return !!nm && nm.startIndex === node.startIndex && nm.endIndex === node.endIndex;
}

/** Node whose preceding siblings carry the doc comment (template wrapper / typedef wrapper). */
function docAnchor(node: Node): Node {
  let n = node;
  while (n.parent && (n.parent.type === 'template_declaration' || (n.parent.type === 'type_definition' && SPECIFIERS.has(n.type)))) n = n.parent;
  return n;
}

function docOf(node: Node): string {
  return precedingComments(docAnchor(node), COMMENTS);
}

function templatePrefix(node: Node): string {
  let n = node;
  const parts: string[] = [];
  while (n.parent && n.parent.type === 'template_declaration') {
    n = n.parent;
    parts.unshift(`template ${n.childForFieldName('parameters')?.text ?? '<>'}`);
  }
  return parts.length ? parts.join(' ') + ' ' : '';
}

/** Source text of a definition up to its body / initializer list, without trailing `;`. */
function headerText(node: Node, ctx: WalkContext): string {
  const body = node.childForFieldName('body');
  const init = kids(node).find((c) => c.type === 'field_initializer_list');
  const end = init ? init.startIndex : body ? body.startIndex : node.endIndex;
  const raw = ctx.source.slice(node.startIndex, end).replace(/;\s*$/, '');
  return oneLine(templatePrefix(node) + raw);
}

/** Current access level for a member of a C++ class body (scans preceding `public:` etc.). */
function accessOf(node: Node): string | null {
  let s: Node = node;
  if (s.parent?.type === 'template_declaration') s = s.parent;
  const list = s.parent;
  if (!list || list.type !== 'field_declaration_list') return null;
  let prev = s.previousSibling;
  while (prev) {
    if (prev.type === 'access_specifier') return prev.text.replace(/:\s*$/, '').trim();
    prev = prev.previousSibling;
  }
  return list.parent?.type === 'class_specifier' ? 'private' : 'public';
}

function modifiersOf(node: Node, fn: Node | null): string[] {
  const out: string[] = [];
  const scan = (n: Node) => {
    for (const c of kids(n)) {
      if (c.type === 'storage_class_specifier' || c.type === 'type_qualifier' || c.type === 'virtual_specifier') out.push(c.text);
      else if (c.type === 'explicit_function_specifier') out.push('explicit');
      else if (c.type === 'virtual') out.push('virtual');
      else if (c.type === 'default_method_clause') out.push('default');
      else if (c.type === 'delete_method_clause') out.push('deleted');
    }
  };
  scan(node);
  if (fn) scan(fn);
  if (kids(node).some((c) => c.type === 'default_value' || (c.type === 'number_literal' && c.text === '0')) && out.includes('virtual')) out.push('abstract');
  const dv = node.childForFieldName('default_value');
  if (dv && dv.text === '0' && out.includes('virtual') && !out.includes('abstract')) out.push('abstract');
  return [...new Set(out)];
}

function stringContent(n: Node | null | undefined): string | null {
  if (!n) return null;
  if (n.type === 'string_literal') {
    const c = named(n).find((x) => x.type === 'string_content');
    return c ? c.text : n.text.replace(/^L?"|"$/g, '');
  }
  if (n.type === 'system_lib_string') return n.text.replace(/^<|>$/g, '');
  if (n.type === 'concatenated_string') return named(n).map((x) => stringContent(x) ?? '').join('');
  return null;
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

export interface CFamilyOptions {
  id: string;
  grammar: string;
  extensions: string[];
  cpp: boolean;
}

export function makeCFamily(opts: CFamilyOptions): LanguageSupport {
  const { cpp } = opts;

  /** Emit type references for every type name inside a type expression subtree. */
  function emitTypeRefsIn(n: Node | null | undefined, ctx: WalkContext): void {
    if (!n) return;
    switch (n.type) {
      case 'type_identifier':
        ctx.emitRef({ kind: 'type', name: n.text }, n);
        return;
      case 'qualified_identifier': {
        const { last, qualifier } = splitQualified(n);
        const q = dotted(qualifier);
        if (last.type === 'type_identifier') ctx.emitRef({ kind: 'type', name: last.text, qualifier: q }, last);
        else if (last.type === 'template_type') {
          const nm = last.childForFieldName('name');
          if (nm) ctx.emitRef({ kind: 'type', name: nm.text, qualifier: q }, nm);
          emitTypeRefsIn(last.childForFieldName('arguments'), ctx);
        } else if (last.type === 'identifier') ctx.emitRef({ kind: 'value', name: last.text, qualifier: q }, last);
        else if (last.type === 'template_function') emitTypeRefsIn(last.childForFieldName('arguments'), ctx);
        return;
      }
      case 'template_type': {
        const nm = n.childForFieldName('name');
        if (nm) ctx.emitRef({ kind: 'type', name: nm.text }, nm);
        emitTypeRefsIn(n.childForFieldName('arguments'), ctx);
        return;
      }
      case 'struct_specifier':
      case 'union_specifier':
      case 'enum_specifier':
      case 'class_specifier':
        if (!n.childForFieldName('body')) emitTypeRefsIn(n.childForFieldName('name'), ctx);
        return;
      case 'primitive_type':
      case 'sized_type_specifier':
      case 'placeholder_type_specifier':
      case 'number_literal':
      case 'string_literal':
        return;
      default:
        for (const c of named(n)) emitTypeRefsIn(c, ctx);
    }
  }

  /** The `declaration` / `function_definition` / ... that owns a function_declarator. */
  function declaratorOwner(fn: Node): Node | null {
    let cur: Node | null = fn.parent;
    while (cur && (WRAPPERS.has(cur.type) || cur.type === 'init_declarator' || cur.type === 'function_declarator')) cur = cur.parent;
    return cur;
  }

  function isGtestMacro(fnDecl: Node | null): boolean {
    if (!fnDecl) return false;
    const d = fnDecl.childForFieldName('declarator');
    return !!d && d.type === 'identifier' && GTEST.has(d.text);
  }

  function functionDef(node: Node, ctx: WalkContext, isProto: boolean): DefSpec | null {
    const { name, fn } = unwrap(node.childForFieldName('declarator'));
    if (!name || !fn) return null;
    let nameText = name.text;
    let container: string | undefined;
    let kind: DefSpec['kind'] = 'function';
    const inClass = ctx.inClass;
    const modifiers = modifiersOf(node, fn);
    const meta: NonNullable<DefSpec['meta']> = {};

    if (name.type === 'qualified_identifier') {
      const { last, qualifier } = splitQualified(name);
      nameText = last.text;
      const scope = dotted(qualifier);
      if (scope) {
        const nsPrefix = ctx.scopeDef && ctx.scopeDef.kind === 'namespace' ? ctx.scopeDef.fqn + '.' : '';
        container = nsPrefix + scope;
        kind = 'method';
        const cls = scope.slice(scope.lastIndexOf('.') + 1);
        if (nameText === cls) kind = 'constructor';
      }
    } else if (name.type === 'template_function' || name.type === 'template_method') {
      nameText = name.childForFieldName('name')?.text ?? nameText;
    }

    if (!container && inClass) {
      kind = 'method';
      if (name.type !== 'destructor_name' && ctx.scopeDef && nameText === ctx.scopeDef.name) kind = 'constructor';
      const acc = cpp ? accessOf(node) : null;
      if (acc) modifiers.push(acc);
    }

    // gtest: TEST(Suite, Name) { ... } parses as a function definition named TEST.
    if (!isProto && !inClass && GTEST.has(nameText)) {
      const params = named(fn.childForFieldName('parameters')).map((p) => oneLine(p.text));
      const tname = params.length ? params.join('.') : nameText;
      return { kind: 'test', name: tname, body: node.childForFieldName('body'), signature: headerText(node, ctx), doc: docOf(node), exported: false, meta: { framework: 'gtest' } };
    }

    if (isProto) {
      meta.prototype = true;
      modifiers.push('declaration');
    }
    const isStatic = modifiers.includes('static');
    const exported = inClass || container ? !modifiers.includes('private') : !isStatic;
    return {
      kind,
      name: nameText,
      container,
      body: node.childForFieldName('body'),
      signature: headerText(node, ctx),
      doc: docOf(node),
      modifiers,
      exported,
      meta: Object.keys(meta).length ? meta : undefined,
    };
  }

  function variableDefs(node: Node, ctx: WalkContext): DefSpec | null {
    const typeNode = node.childForFieldName('type');
    const decls = node.childrenForFieldName('declarator').filter((d): d is Node => d !== null);
    if (!decls.length) return null;
    const mods = modifiersOf(node, null);
    const isConst = mods.includes('const') || mods.includes('constexpr');
    const declaredType = typeNameOf(typeNode) || undefined;
    const inClass = ctx.inClass;
    const acc = inClass && cpp ? accessOf(node) : null;
    if (acc) mods.push(acc);
    const specs: { spec: DefSpec; node: Node }[] = [];
    for (const d of decls) {
      const { name, fn } = unwrap(d);
      if (!name || fn) continue;
      const nm = name.type === 'qualified_identifier' ? splitQualified(name).last.text : name.text;
      const kind: DefSpec['kind'] = inClass ? 'field' : isConst ? 'constant' : 'variable';
      const meta: NonNullable<DefSpec['meta']> = {};
      if (mods.includes('extern')) meta.extern = true;
      specs.push({
        node: d,
        spec: {
          kind,
          name: nm,
          signature: oneLine(templatePrefix(node) + node.text.replace(/;\s*$/, ''), 160),
          doc: docOf(node),
          modifiers: mods,
          exported: inClass ? acc !== 'private' : !mods.includes('static'),
          declaredType,
          meta: Object.keys(meta).length ? meta : undefined,
        },
      });
    }
    if (!specs.length) return null;
    for (const extra of specs.slice(1)) ctx.emitDef(extra.spec, extra.node, ctx.scope);
    return specs[0]!.spec;
  }

  function specifierDef(node: Node, ctx: WalkContext): DefSpec | null {
    const body = node.childForFieldName('body');
    if (!body) return null;
    let nameNode = node.childForFieldName('name');
    let name = '';
    if (nameNode) name = nameNode.type === 'qualified_identifier' ? splitQualified(nameNode).last.text : typeNameOf(nameNode) || nameNode.text;
    if (!name && node.parent?.type === 'type_definition') {
      // typedef struct { ... } name_t;
      const td = unwrap(node.parent.childForFieldName('declarator'));
      if (td.name) name = td.name.text;
    }
    if (!name) return null;
    let kind: DefSpec['kind'] = 'struct';
    const meta: NonNullable<DefSpec['meta']> = {};
    if (node.type === 'class_specifier') kind = 'class';
    else if (node.type === 'enum_specifier') {
      kind = 'enum';
      if (kids(node).some((c) => c.type === 'class' || c.type === 'struct')) meta.scoped = true;
    } else if (node.type === 'union_specifier') meta.union = true;
    const supertypes: NonNullable<DefSpec['supertypes']> = [];
    const bases = kids(node).find((c) => c.type === 'base_class_clause');
    for (const b of named(bases)) {
      if (b.type === 'access_specifier') continue;
      let text = '';
      if (b.type === 'template_type') text = b.childForFieldName('name')?.text ?? '';
      else if (b.type === 'qualified_identifier') text = dotted(b.text);
      else if (b.type === 'type_identifier') text = b.text;
      if (text) supertypes.push({ name: text, kind: 'extends' });
    }
    const modifiers: string[] = [];
    if (kids(node).some((c) => c.type === 'virtual_specifier')) modifiers.push('final');
    const acc = ctx.inClass && cpp ? accessOf(node) : null;
    if (acc) modifiers.push(acc);
    return {
      kind,
      name,
      body,
      signature: headerText(node, ctx),
      doc: docOf(node),
      modifiers,
      exported: acc ? acc !== 'private' : true,
      supertypes,
      meta: Object.keys(meta).length ? meta : undefined,
    };
  }

  function fieldDef(node: Node, ctx: WalkContext): DefSpec | null {
    const typeNode = node.childForFieldName('type');
    const decls = node.childrenForFieldName('declarator').filter((d): d is Node => d !== null);
    if (!decls.length) return null;
    const acc = cpp ? accessOf(node) : null;
    const specs: { spec: DefSpec; node: Node }[] = [];
    for (const d of decls) {
      const { name, fn } = unwrap(d);
      if (!name) continue;
      const mods = modifiersOf(node, fn);
      if (acc) mods.push(acc);
      const nm = name.type === 'qualified_identifier' ? splitQualified(name).last.text : name.text;
      if (fn) {
        // method prototype inside a class body
        let kind: DefSpec['kind'] = 'method';
        if (name.type !== 'destructor_name' && ctx.scopeDef && nm === ctx.scopeDef.name) kind = 'constructor';
        mods.push('declaration');
        specs.push({ node: d, spec: { kind, name: nm, signature: headerText(node, ctx), doc: docOf(node), modifiers: mods, exported: acc !== 'private', meta: { prototype: true } } });
      } else {
        const declaredType = typeNameOf(typeNode) || undefined;
        if (declaredType) ctx.emitLocalType({ name: nm, type: declaredType, via: 'field' });
        specs.push({ node: d, spec: { kind: 'field', name: nm, signature: oneLine(node.text.replace(/;\s*$/, ''), 160), doc: docOf(node), modifiers: mods, exported: acc !== 'private', declaredType } });
      }
    }
    if (!specs.length) return null;
    for (const extra of specs.slice(1)) ctx.emitDef(extra.spec, extra.node, ctx.scope);
    return specs[0]!.spec;
  }

  /** Local type facts + `new` refs for a local `declaration`. */
  function localDeclaration(node: Node, ctx: WalkContext): void {
    const typeNode = node.childForFieldName('type');
    const type = typeNameOf(typeNode);
    for (const d of node.childrenForFieldName('declarator')) {
      if (!d) continue;
      const { name, fn, init } = unwrap(d);
      if (!name || name.type === 'qualified_identifier') continue;
      const nm = name.text;
      if (type) {
        ctx.emitLocalType({ name: nm, type, via: 'annotation' });
        if (init?.type === 'initializer_list') ctx.emitRef({ kind: 'new', name: type, arity: named(init).length }, typeNode ?? d);
        else if (fn) ctx.emitRef({ kind: 'new', name: type, arity: named(fn.childForFieldName('parameters')).length }, typeNode ?? d);
        continue;
      }
      // auto x = ...
      if (!init) continue;
      const t = constructedType(init);
      if (t) ctx.emitLocalType({ name: nm, type: t.type, via: t.via });
    }
  }

  /** Type constructed by an initializer expression, if it is recognisable. */
  function constructedType(v: Node): { type: string; via: 'new' | 'constructor_call' } | null {
    if (v.type === 'new_expression') {
      const t = typeNameOf(v.childForFieldName('type'));
      return t ? { type: t, via: 'new' } : null;
    }
    if (v.type === 'compound_literal_expression') {
      const t = typeNameOf(v.childForFieldName('type'));
      return t ? { type: t, via: 'new' } : null;
    }
    if (v.type === 'call_expression') {
      const fn = v.childForFieldName('function');
      if (!fn) return null;
      if (fn.type === 'identifier' && /^[A-Z][a-z]/.test(fn.text)) return { type: fn.text, via: 'constructor_call' };
      const last = fn.type === 'qualified_identifier' ? splitQualified(fn).last : fn;
      if (last.type === 'template_function') {
        const nm = last.childForFieldName('name')?.text ?? '';
        if (SMART_PTR_MAKERS.has(nm)) {
          const arg = named(last.childForFieldName('arguments'))[0];
          const t = typeNameOf(arg);
          if (t) return { type: t, via: 'new' };
        }
      }
      if (last.type === 'identifier' && /^[A-Z][a-z]/.test(last.text) && fn.type === 'qualified_identifier') return { type: last.text, via: 'constructor_call' };
    }
    return null;
  }

  function callRef(node: Node, ctx: WalkContext): void {
    const fn = node.childForFieldName('function');
    const args = node.childForFieldName('arguments');
    const arity = named(args).length;
    if (!fn) return;
    const first = named(args)[0];
    switch (fn.type) {
      case 'identifier': {
        const name = fn.text;
        if (CATCH.has(name)) return;
        if (name === 'getenv' || name === 'secure_getenv') {
          const v = stringContent(first);
          if (v) ctx.emitRef({ kind: 'config', name: v }, first!);
        }
        const isCtor = cpp && /^[A-Z][a-z]/.test(name);
        ctx.emitRef({ kind: isCtor ? 'new' : 'call', name, arity }, fn);
        return;
      }
      case 'field_expression': {
        const obj = fn.childForFieldName('argument');
        const field = fn.childForFieldName('field');
        if (!field) return;
        let q = obj?.text ?? '';
        if (q === 'this' || q === '(*this)') q = 'this';
        const fname = field.type === 'template_method' ? field.childForFieldName('name')?.text ?? field.text : field.text;
        ctx.emitRef({ kind: 'call', name: fname, qualifier: q, arity }, field);
        return;
      }
      case 'qualified_identifier': {
        const { last, qualifier } = splitQualified(fn);
        const q = dotted(qualifier);
        if (last.type === 'template_function') {
          const nm = last.childForFieldName('name');
          const name = nm?.text ?? '';
          if (SMART_PTR_MAKERS.has(name)) {
            const t = named(last.childForFieldName('arguments'))[0];
            const tn = typeNameOf(t);
            if (tn) {
              ctx.emitRef({ kind: 'new', name: tn, arity }, t ?? last);
              return;
            }
          }
          if (nm) ctx.emitRef({ kind: 'call', name, qualifier: q, arity }, nm);
          return;
        }
        if (last.type === 'identifier') {
          if (last.text === 'getenv' && (q === 'std' || q === '')) {
            const v = stringContent(first);
            if (v) ctx.emitRef({ kind: 'config', name: v }, first!);
          }
          const isCtor = cpp && /^[A-Z][a-z]/.test(last.text);
          ctx.emitRef({ kind: isCtor ? 'new' : 'call', name: last.text, qualifier: q, arity }, last);
        }
        return;
      }
      case 'template_function': {
        const nm = fn.childForFieldName('name');
        if (nm) ctx.emitRef({ kind: 'call', name: nm.text, arity }, nm);
        return;
      }
      default:
        return;
    }
  }

  return {
    id: opts.id,
    grammar: opts.grammar,
    extensions: opts.extensions,
    classLike: new Set(['struct_specifier', 'union_specifier', 'class_specifier', 'enum_specifier']),
    skip: new Set(['comment', 'string_literal', 'raw_string_literal', 'char_literal', 'concatenated_string', 'system_lib_string', 'preproc_arg', 'attribute_declaration', 'attribute_specifier']),

    isTestFile(path) {
      return /(^|\/)(tests?|testing|spec|__tests__)\//i.test(path) || /_tests?\.[^/]+$/.test(path) || /(^|\/)test_[^/]*$/.test(path) || /Tests?\.(cc|cpp|cxx|mm)$/.test(path);
    },

    doc(node) {
      return docOf(node);
    },

    moduleDoc(root) {
      const first = named(root)[0];
      if (first?.type === 'comment' && (first.text.startsWith('/**') || first.text.startsWith('///'))) {
        const second = named(root)[1];
        return second ? precedingComments(second, COMMENTS) || '' : '';
      }
      return '';
    },

    definition(node, ctx): DefSpec | null {
      switch (node.type) {
        case 'function_definition':
          return functionDef(node, ctx, false);
        case 'declaration': {
          if (!isTopLevel(node)) return null;
          const { fn } = unwrap(node.childForFieldName('declarator'));
          if (fn) return functionDef(node, ctx, true);
          return variableDefs(node, ctx);
        }
        case 'struct_specifier':
        case 'union_specifier':
        case 'enum_specifier':
        case 'class_specifier':
          return specifierDef(node, ctx);
        case 'enumerator': {
          const name = node.childForFieldName('name')?.text ?? '';
          if (!name) return null;
          return { kind: 'enum_member', name, signature: oneLine(node.text, 80), doc: docOf(node), exported: true };
        }
        case 'field_declaration':
          return fieldDef(node, ctx);
        case 'type_definition': {
          const t = node.childForFieldName('type');
          if (t && SPECIFIERS.has(t.type) && t.childForFieldName('body') && !t.childForFieldName('name')) return null; // anonymous struct takes the typedef name
          const { name, fn } = unwrap(node.childForFieldName('declarator'));
          if (!name) return null;
          const target = fn ? undefined : typeNameOf(t) || undefined; // function-pointer typedefs alias no nameable type
          return { kind: 'type_alias', name: name.text, signature: oneLine(node.text.replace(/;\s*$/, ''), 160), doc: docOf(node), exported: true, declaredType: target };
        }
        case 'alias_declaration': {
          const name = node.childForFieldName('name')?.text ?? '';
          if (!name) return null;
          const target = typeNameOf(node.childForFieldName('type')) || undefined;
          return { kind: 'type_alias', name, signature: oneLine(templatePrefix(node) + node.text.replace(/;\s*$/, ''), 160), doc: docOf(node), exported: true, declaredType: target };
        }
        case 'preproc_def':
        case 'preproc_function_def': {
          const name = node.childForFieldName('name')?.text ?? '';
          if (!name) return null;
          // header guard: #ifndef X / #define X
          if (node.parent?.type === 'preproc_ifdef' && node.parent.childForFieldName('name')?.text === name) return null;
          const params = node.childForFieldName('parameters')?.text ?? '';
          const value = node.childForFieldName('value')?.text ?? '';
          return { kind: 'macro', name, signature: oneLine(`#define ${name}${params}${value ? ' ' + value : ''}`, 160), doc: docOf(node), exported: true, meta: params ? { function_like: true } : undefined };
        }
        case 'namespace_definition': {
          const nm = node.childForFieldName('name');
          if (!nm) return null; // anonymous namespace: contents belong to the enclosing scope
          const name = nm.text.replace(/\s+/g, '').replace(/::/g, '.');
          if (!name) return null;
          return { kind: 'namespace', name, body: node.childForFieldName('body'), signature: `namespace ${name.replace(/\./g, '::')}`, doc: docOf(node), exported: true, modifiers: kids(node).some((c) => c.type === 'inline') ? ['inline'] : [] };
        }
        case 'compound_statement': {
          // Catch2: TEST_CASE("name") { ... } does not parse as a function; the block follows an (error) expression statement.
          if (!node.parent || (node.parent.type !== 'translation_unit' && node.parent.type !== 'declaration_list')) return null;
          let prev = node.previousSibling;
          while (prev && prev.type === 'comment') prev = prev.previousSibling;
          if (!prev || prev.type !== 'expression_statement') return null;
          const call = named(prev).find((c) => c.type === 'call_expression');
          const fn = call?.childForFieldName('function');
          if (!call || !fn || fn.type !== 'identifier' || !CATCH.has(fn.text)) return null;
          const title = stringContent(named(call.childForFieldName('arguments'))[0]) ?? fn.text;
          return { kind: 'test', name: title, body: node, signature: oneLine(prev.text), exported: false, meta: { framework: 'catch2' } };
        }
      }
      return null;
    },

    imports(node): Import[] | null {
      const line = node.startPosition.row + 1;
      if (node.type === 'preproc_include') {
        const p = node.childForFieldName('path');
        if (!p) return [];
        const src = stringContent(p);
        if (!src) return [];
        const quoted = p.type !== 'system_lib_string';
        return [{ source: src, names: [], namespace: quoted, alias: '', kind: 'static', line }];
      }
      if (node.type === 'using_declaration') {
        const isNs = kids(node).some((c) => c.type === 'namespace');
        const target = named(node).find((c) => c.type === 'qualified_identifier' || c.type === 'identifier' || c.type === 'nested_namespace_specifier');
        if (!target) return [];
        if (kids(node).some((c) => c.type === 'enum')) return [];
        if (isNs) return [{ source: target.text.replace(/\s+/g, ''), names: [], namespace: true, alias: '', kind: 'static', line }];
        if (target.type === 'qualified_identifier') {
          const { last, qualifier } = splitQualified(target);
          return [{ source: qualifier.replace(/\s+/g, ''), names: [{ name: last.text, alias: last.text }], namespace: false, alias: '', kind: 'static', line }];
        }
        return [];
      }
      if (node.type === 'namespace_alias_definition') {
        const name = node.childForFieldName('name')?.text ?? '';
        const target = named(node).find((c) => c.type === 'qualified_identifier' || c.type === 'nested_namespace_specifier' || c.type === 'namespace_identifier');
        if (!name || !target) return [];
        return [{ source: target.text.replace(/\s+/g, ''), names: [], namespace: true, alias: name, kind: 'static', line }];
      }
      return null;
    },

    references(node, ctx) {
      switch (node.type) {
        case 'call_expression':
          callRef(node, ctx);
          return;
        case 'new_expression': {
          const t = node.childForFieldName('type');
          const name = typeNameOf(t);
          if (name) {
            const q = t?.type === 'qualified_identifier' ? dotted(splitQualified(t).qualifier) : '';
            ctx.emitRef({ kind: 'new', name, qualifier: q, arity: named(node.childForFieldName('arguments')).length }, t ?? node);
            if (t) emitTypeRefsIn(t.type === 'template_type' ? t.childForFieldName('arguments') : null, ctx);
          }
          return;
        }
        case 'compound_literal_expression': {
          const t = node.childForFieldName('type');
          const name = typeNameOf(t);
          if (name && cpp) ctx.emitRef({ kind: 'new', name, arity: named(node.childForFieldName('value')).length }, t ?? node);
          else if (t) emitTypeRefsIn(t, ctx);
          return;
        }
        case 'declaration':
          if (!isTopLevel(node)) localDeclaration(node, ctx);
          return;
        case 'for_range_loop': {
          const type = typeNameOf(node.childForFieldName('type'));
          const { name } = unwrap(node.childForFieldName('declarator'));
          if (type && name) ctx.emitLocalType({ name: name.text, type, via: 'annotation' });
          return;
        }
        case 'parameter_declaration':
        case 'optional_parameter_declaration':
        case 'variadic_parameter_declaration': {
          const list = node.parent;
          const fnDecl = list?.parent?.type === 'function_declarator' ? list.parent : null;
          if (fnDecl) {
            if (isGtestMacro(fnDecl)) return true;
            const owner = declaratorOwner(fnDecl);
            // `Session sess(name_);` is a constructor call, not a prototype: do not treat `name_` as a parameter type.
            if (owner?.type === 'declaration' && !isTopLevel(owner)) return true;
          }
          const type = typeNameOf(node.childForFieldName('type'));
          const { name } = unwrap(node.childForFieldName('declarator'));
          if (type && name && name.type === 'identifier') ctx.emitLocalType({ name: name.text, type, via: 'annotation' });
          return;
        }
        case 'type_identifier': {
          const p = node.parent;
          if (!p) return;
          if (isSpecifierName(node) && p.childForFieldName('body')) return true;
          if (p.type === 'type_definition' || p.type === 'alias_declaration' || p.type === 'type_parameter_declaration' || p.type === 'template_type' || p.type === 'qualified_identifier' || p.type === 'base_class_clause' || p.type === 'new_expression' || p.type === 'compound_literal_expression' || WRAPPERS.has(p.type) || p.type === 'function_declarator') return true;
          ctx.emitRef({ kind: 'type', name: node.text }, node);
          return true;
        }
        case 'qualified_identifier': {
          const p = node.parent;
          if (!p) return true;
          if (p.type === 'function_declarator' || p.type === 'qualified_identifier') return p.type === 'function_declarator' ? true : undefined;
          if (p.type === 'call_expression' && p.childForFieldName('function')?.startIndex === node.startIndex) return; // handled by callRef; descend for template args
          if (isSpecifierName(node) && p.childForFieldName('body')) return true;
          emitTypeRefsIn(node, ctx);
          return true;
        }
        case 'template_type':
          emitTypeRefsIn(node, ctx);
          return true;
        case 'struct_specifier':
        case 'union_specifier':
        case 'enum_specifier':
        case 'class_specifier':
          if (!node.childForFieldName('body')) {
            emitTypeRefsIn(node.childForFieldName('name'), ctx);
            return true;
          }
          return;
        case 'base_class_clause':
        case 'friend_declaration':
        case 'preproc_def':
        case 'preproc_function_def':
        case 'preproc_include':
          return true;
        case 'identifier': {
          const p = node.parent;
          if (p && (p.type === 'argument_list' || p.type === 'initializer_list' || p.type === 'initializer_pair')) ctx.emitRef({ kind: 'value', name: node.text }, node);
          return;
        }
      }
      return;
    },

    resolveModule(source, fromPath, imp, project: ModuleResolutionContext) {
      if (!imp.namespace) return []; // <system> include
      if (source.includes('::') || !/[./]/.test(source)) return []; // `using namespace x::y;` — namespaces are not files
      const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
      const out: string[] = [];
      const push = (p: string) => {
        const n = normalizePath(p);
        if (n && !out.includes(n)) out.push(n);
      };
      push(fromDir ? `${fromDir}/${source}` : source);
      push(source);
      for (const root of ['include', 'src', 'inc', 'lib', 'src/include']) push(`${root}/${source}`);
      // walk up from the including file's directory: sibling include/ and src/ trees
      let d = fromDir;
      while (d) {
        push(`${d}/include/${source}`);
        push(`${d}/src/${source}`);
        d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
        if (d) push(`${d}/${source}`);
      }
      void project;
      return out;
    },
  };
}
