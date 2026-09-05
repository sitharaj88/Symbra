import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, simpleTypeName, named, kids } from '../parse/walk.js';
import { headerText, docComment, fileDoc, isConstantName, looksLikeType, jvmResolveModule } from './java.js';

const COMMENTS = new Set(['block_comment', 'comment']);
const LEADING = new Set(['annotation', 'modifiers']);
const BODIES = new Set(['template_body', 'block', 'indented_block']);
/** ScalaTest / MUnit / specs2 registration functions: `test("…") { }`. */
const TEST_FNS = new Set(['test', 'it', 'describe', 'should', 'property', 'scenario', 'feature', 'ignore', 'behavior']);
/** ScalaTest infix DSL: `"x" should { }`, `"y" in { }`, `"z" - { }`. */
const TEST_OPS = new Set(['should', 'must', 'can', 'in', 'when', 'is', 'ignore', '-']);
const DEF_HOLDERS = new Set(['compilation_unit', 'template_body']);

function keywords(node: Node): Set<string> {
  return new Set(
    kids(node)
      .filter((c) => !c.isNamed)
      .map((c) => c.type),
  );
}

function modifiersOf(node: Node): string[] {
  const m = kids(node).find((c) => c.type === 'modifiers');
  if (!m) return [];
  return m.text
    .replace(/\[[^\]]*\]/g, '')
    .split(/\s+/)
    .filter(Boolean);
}

function scaladoc(node: Node): string {
  return docComment(node, COMMENTS);
}

function supertypesOf(node: Node): NonNullable<DefSpec['supertypes']> {
  const ext = node.childForFieldName('extend');
  if (!ext) return [];
  const out: NonNullable<DefSpec['supertypes']> = [];
  let first = true;
  for (let i = 0; i < ext.childCount; i++) {
    const c = ext.child(i);
    if (!c || !c.isNamed || ext.fieldNameForChild(i) !== 'type') continue;
    out.push({ name: c.text, kind: first ? 'extends' : 'implements' });
    first = false;
  }
  return out;
}

function stringValue(n: Node | null | undefined): string | null {
  if (!n) return null;
  if (n.type === 'string') return n.text.replace(/^"""|"""$/g, '').replace(/^"|"$/g, '');
  if (n.type === 'interpolated_string_expression') return n.text.replace(/^\w+"|"$/g, '');
  return null;
}

/** `test("name") { … }` → name; null when not a test-registration call. */
function testCall(node: Node): { name: string; body: Node | null } | null {
  if (node.type !== 'call_expression') return null;
  const fn = node.childForFieldName('function');
  const body = node.childForFieldName('arguments');
  if (!fn || fn.type !== 'call_expression' || !body || (body.type !== 'block' && body.type !== 'indented_block' && body.type !== 'arguments')) return null;
  const inner = fn.childForFieldName('function');
  if (!inner || inner.type !== 'identifier' || !TEST_FNS.has(inner.text)) return null;
  const name = stringValue(named(fn.childForFieldName('arguments'))[0]);
  if (name === null) return null;
  return { name, body };
}

/** `"x" should { … }` / `"y" in { … }` → name; the string may sit on the left of a nested infix. */
function testInfix(node: Node): { name: string; body: Node | null } | null {
  if (node.type !== 'infix_expression') return null;
  const op = node.childForFieldName('operator');
  const right = node.childForFieldName('right');
  if (!op || !right || !TEST_OPS.has(op.text) || (right.type !== 'block' && right.type !== 'indented_block')) return null;
  let left = node.childForFieldName('left');
  while (left && left.type === 'infix_expression') left = left.childForFieldName('left');
  const name = stringValue(left);
  if (name === null) return null;
  return { name, body: right };
}

/** Type name for a local binding from an annotation or `new T(...)` / `T(...)`. */
function bindingType(t: Node | null, value: Node | null): { type: string; via: 'annotation' | 'new' | 'constructor_call' } | null {
  if (t) return { type: simpleTypeName(t.text), via: 'annotation' };
  if (value?.type === 'instance_expression') {
    const tn = named(value).find((c) => /type/.test(c.type));
    if (tn) return { type: simpleTypeName(tn.text), via: 'new' };
  }
  if (value?.type === 'call_expression') {
    const fn = value.childForFieldName('function');
    if (fn?.type === 'identifier' && /^[A-Z]/.test(fn.text)) return { type: fn.text, via: 'constructor_call' };
    if (fn?.type === 'field_expression') {
      const f = fn.childForFieldName('field');
      if (f && /^[A-Z]/.test(f.text)) return { type: f.text, via: 'constructor_call' };
    }
  }
  return null;
}

function unwrapGeneric(fn: Node | null): Node | null {
  return fn?.type === 'generic_function' ? fn.childForFieldName('function') : fn;
}

function isCallee(node: Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (p.type === 'call_expression') return p.childForFieldName('function')?.equals(node) ?? false;
  if (p.type === 'generic_function') return isCallee(p);
  return false;
}

/** Is this type node the type of an instance_expression (already emitted as `new`)? */
function underNew(n: Node): boolean {
  let p = n.parent;
  if (p?.type === 'generic_type') p = p.parent;
  return p?.type === 'instance_expression';
}

function emitCallee(fn: Node, args: Node | null, ctx: WalkContext) {
  const arity = named(args).length;
  if (fn.type === 'identifier') {
    ctx.emitRef({ kind: looksLikeType(fn.text) ? 'new' : 'call', name: fn.text, arity }, fn);
  } else if (fn.type === 'field_expression') {
    const v = fn.childForFieldName('value');
    const f = fn.childForFieldName('field');
    if (!f) return;
    const q = v?.text ?? '';
    if ((q === 'System' && f.text === 'getenv') || (q === 'sys' && f.text === 'env') || (q === 'sys.env' && (f.text === 'get' || f.text === 'getOrElse' || f.text === 'apply'))) {
      const s = stringValue(named(args)[0]);
      if (s) ctx.emitRef({ kind: 'config', name: s }, named(args)[0]!);
    }
    ctx.emitRef({ kind: 'call', name: f.text, qualifier: q, arity }, f);
  }
}

export const scala: LanguageSupport = {
  id: 'scala',
  grammar: 'scala',
  extensions: ['.scala', '.sc'],
  classLike: new Set(['class_definition', 'object_definition', 'trait_definition', 'enum_definition']),
  skip: new Set(['comment', 'block_comment', 'string']),

  isTestFile(path) {
    return /\/src\/test\//.test(path) || /(Spec|Test|Suite)\.scala$/.test(path);
  },

  doc(node) {
    return scaladoc(node);
  },

  moduleDoc(root) {
    return fileDoc(root, COMMENTS);
  },

  definition(node, ctx): DefSpec | null {
    switch (node.type) {
      case 'class_definition':
      case 'object_definition':
      case 'trait_definition':
      case 'enum_definition':
      case 'package_object': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const kw = keywords(node);
        const mods = modifiersOf(node);
        let kind: DefSpec['kind'] = 'class';
        const meta: DefSpec['meta'] = {};
        if (node.type === 'trait_definition') kind = 'trait';
        else if (node.type === 'enum_definition') kind = 'enum';
        else if (node.type === 'package_object') kind = 'namespace';
        if (node.type === 'object_definition') meta.object = true;
        if (kw.has('case')) meta.case = true;
        return {
          kind,
          name,
          body: node.childForFieldName('body'),
          signature: headerText(node, mods, LEADING, BODIES),
          doc: scaladoc(node),
          modifiers: kw.has('case') ? [...mods, 'case'] : mods,
          exported: !mods.includes('private'),
          supertypes: supertypesOf(node),
          meta: Object.keys(meta).length ? meta : undefined,
        };
      }
      case 'simple_enum_case':
      case 'full_enum_case': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        return { kind: 'enum_member', name, signature: oneLine(node.text, 80), doc: scaladoc(node), exported: true, supertypes: supertypesOf(node) };
      }
      case 'function_definition':
      case 'function_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const mods = modifiersOf(node);
        const ret = node.childForFieldName('return_type');
        const inExtension = node.parent?.type === 'extension_definition';
        return {
          kind: ctx.inClass && !inExtension ? 'method' : 'function',
          name,
          body: node.childForFieldName('body'),
          signature: headerText(node, mods, LEADING, BODIES),
          doc: scaladoc(node),
          modifiers: mods,
          exported: !mods.includes('private'),
          declaredType: ret && ret.text !== 'Unit' ? simpleTypeName(ret.text) : undefined,
        };
      }
      case 'val_definition':
      case 'var_definition':
      case 'val_declaration':
      case 'var_declaration': {
        const nameNode = node.childForFieldName('pattern') ?? node.childForFieldName('name');
        if (!nameNode || nameNode.type !== 'identifier') return null;
        const name = nameNode.text;
        const t = node.childForFieldName('type');
        const value = node.childForFieldName('value');
        const bt = bindingType(t, value);
        const holder = node.parent?.type ?? '';
        if (!DEF_HOLDERS.has(holder)) {
          if (bt) ctx.emitLocalType({ name, type: bt.type, via: bt.via });
          return null;
        }
        const mods = modifiersOf(node);
        const isVal = node.type.startsWith('val');
        let kind: DefSpec['kind'] = 'field';
        if (holder === 'compilation_unit') kind = isVal && (isConstantName(name) || mods.includes('final')) ? 'constant' : 'variable';
        else if (isVal && (isConstantName(name) || mods.includes('final'))) kind = 'constant';
        if (bt) ctx.emitLocalType({ name, type: bt.type, via: 'field' });
        return { kind, name, signature: oneLine(node.text, 160), doc: scaladoc(node), modifiers: [...mods, isVal ? 'val' : 'var'], exported: !mods.includes('private'), declaredType: bt?.type };
      }
      case 'class_parameter': {
        const name = node.childForFieldName('name')?.text ?? '';
        const t = node.childForFieldName('type');
        if (!name) return null;
        const kw = keywords(node);
        const owner = node.parent?.parent;
        const isCase = owner?.type === 'class_definition' && keywords(owner).has('case');
        const declaredType = t ? simpleTypeName(t.text) : undefined;
        if (!kw.has('val') && !kw.has('var') && !isCase) {
          if (declaredType) ctx.emitLocalType({ name, type: declaredType, via: 'annotation' });
          return null;
        }
        const mods = modifiersOf(node);
        if (declaredType) ctx.emitLocalType({ name, type: declaredType, via: 'field' });
        return { kind: 'field', name, signature: oneLine(node.text, 120), modifiers: [...mods, kw.has('var') ? 'var' : 'val'], exported: !mods.includes('private'), declaredType };
      }
      case 'type_definition': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const mods = modifiersOf(node);
        return { kind: 'type_alias', name, signature: oneLine(node.text, 160), doc: scaladoc(node), modifiers: mods, exported: !mods.includes('private') };
      }
      case 'given_definition': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const ret = node.childForFieldName('return_type');
        return { kind: 'constant', name, body: node.childForFieldName('body'), signature: headerText(node, modifiersOf(node), LEADING, BODIES), doc: scaladoc(node), exported: true, declaredType: ret ? simpleTypeName(ret.text) : undefined, meta: { given: true } };
      }
      case 'call_expression': {
        const t = testCall(node);
        if (!t) return null;
        return { kind: 'test', name: t.name, body: t.body, signature: oneLine(node.childForFieldName('function')?.text ?? node.text, 120), exported: false, meta: { framework: 'scalatest' } };
      }
      case 'infix_expression': {
        const t = testInfix(node);
        if (!t) return null;
        return { kind: 'test', name: t.name, body: t.body, signature: oneLine(`"${t.name}" ${node.childForFieldName('operator')?.text ?? ''}`, 120), exported: false, meta: { framework: 'scalatest' } };
      }
    }
    return null;
  },

  imports(node): Import[] | null {
    if (node.type !== 'import_declaration') return null;
    const line = node.startPosition.row + 1;
    const path: string[] = [];
    let wildcard = false;
    let selectors: Node | null = null;
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (!c || !c.isNamed) continue;
      if (node.fieldNameForChild(i) === 'path') path.push(c.text);
      else if (c.type === 'namespace_wildcard') wildcard = true;
      else if (c.type === 'namespace_selectors') selectors = c;
    }
    if (!path.length) return [];
    const pkg = path.join('.');
    const out: Import[] = [];
    if (selectors) {
      for (const s of named(selectors)) {
        if (s.type === 'namespace_wildcard' || s.type === 'wildcard') {
          wildcard = true;
          continue;
        }
        let name = '';
        let alias = '';
        if (s.type === 'identifier') name = alias = s.text;
        else if (s.type === 'arrow_renamed_identifier' || s.type === 'as_renamed_identifier') {
          name = s.childForFieldName('name')?.text ?? '';
          alias = s.childForFieldName('alias')?.text ?? name;
        }
        if (!name || name === 'given' || alias === '_') continue;
        out.push({ source: `${pkg}.${name}`, names: [{ name, alias }], namespace: false, alias: '', kind: 'static', line });
      }
    }
    if (wildcard) out.push({ source: pkg, names: [], namespace: true, alias: '', kind: 'static', line });
    if (!selectors && !wildcard) {
      const last = path[path.length - 1]!;
      out.push({ source: pkg, names: [{ name: last, alias: last }], namespace: false, alias: '', kind: 'static', line });
    }
    return out;
  },

  references(node, ctx) {
    switch (node.type) {
      case 'call_expression': {
        if (testCall(node)) return; // test definition: children are walked by the walker
        const fn = unwrapGeneric(node.childForFieldName('function'));
        const args = node.childForFieldName('arguments');
        if (!fn) return;
        if (fn.type === 'call_expression') {
          // curried / trailing block: `f(a)(b)`; the inner call emits
          if (testCall(fn)) return;
          return;
        }
        emitCallee(fn, args, ctx);
        return;
      }
      case 'field_expression': {
        if (isCallee(node)) return;
        const v = node.childForFieldName('value');
        const f = node.childForFieldName('field');
        if (v && f && /^[A-Za-z_][\w.]*$/.test(v.text)) ctx.emitRef({ kind: 'value', name: f.text, qualifier: v.text }, f);
        return;
      }
      case 'instance_expression': {
        const tn = named(node).find((c) => c.type === 'type_identifier' || c.type === 'generic_type' || c.type === 'stable_type_identifier');
        const args = node.childForFieldName('arguments');
        if (tn) {
          const raw = tn.type === 'generic_type' ? (tn.childForFieldName('type')?.text ?? tn.text) : tn.text;
          ctx.emitRef({ kind: 'new', name: simpleTypeName(raw), qualifier: raw.includes('.') ? raw.slice(0, raw.lastIndexOf('.')) : '', arity: named(args).length }, tn);
        }
        return;
      }
      case 'infix_expression': {
        if (testInfix(node)) return;
        const op = node.childForFieldName('operator');
        const left = node.childForFieldName('left');
        if (op?.type === 'identifier' && left && /^[A-Za-z_]\w*$/.test(op.text) && !TEST_OPS.has(op.text)) {
          ctx.emitRef({ kind: 'call', name: op.text, qualifier: left.text, arity: 1 }, op);
        }
        return;
      }
      case 'annotation': {
        const nm = node.childForFieldName('name');
        if (nm) {
          const full = nm.text;
          ctx.emitRef({ kind: 'decorator', name: simpleTypeName(full), qualifier: full.includes('.') ? full.slice(0, full.lastIndexOf('.')) : '' }, nm);
        }
        return true;
      }
      case 'type_identifier': {
        const p = node.parent;
        if (p?.type === 'type_definition' && p.childForFieldName('name')?.equals(node)) return true;
        if (underNew(node)) return true;
        ctx.emitRef({ kind: 'type', name: node.text }, node);
        return true;
      }
      case 'stable_type_identifier': {
        if (underNew(node)) return true;
        const last = named(node).find((c) => c.type === 'type_identifier');
        const q = named(node).find((c) => c.type === 'stable_identifier' || c.type === 'identifier');
        if (last) ctx.emitRef({ kind: 'type', name: last.text, qualifier: q?.text ?? '' }, last);
        return true;
      }
      case 'parameter':
      case 'binding': {
        const nm = node.childForFieldName('name');
        const t = node.childForFieldName('type');
        if (nm && t) ctx.emitLocalType({ name: nm.text, type: simpleTypeName(t.text), via: 'annotation' });
        return;
      }
      case 'extends_clause':
      case 'package_clause':
        return true;
      case 'identifier': {
        // bare name in value position: call argument (`register("x", handler)`, `f(name = handler)`)
        const p = node.parent;
        if (!p) return;
        const inArgs = p.type === 'arguments' || (p.type === 'assignment_expression' && p.parent?.type === 'arguments' && p.childForFieldName('right')?.id === node.id);
        if (inArgs && !/^(this|null|true|false)$/.test(node.text)) ctx.emitRef({ kind: 'value', name: node.text }, node);
        return;
      }
    }
    return;
  },

  resolveModule(source, fromPath, imp, project) {
    return jvmResolveModule(source, fromPath, imp, project, '.scala');
  },
};
