import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport } from './types.js';
import { oneLine, cleanComment, named, simpleTypeName } from '../parse/walk.js';

/** BCL / FSharp.Core names that add no signal as call edges. */
const SKIP_CALLS = new Set([
  'ignore', 'failwith', 'failwithf', 'raise', 'printfn', 'printf', 'sprintf', 'eprintfn', 'string',
  'int', 'float', 'bool', 'not', 'fst', 'snd', 'id', 'compare', 'min', 'max', 'abs', 'box', 'unbox',
  'typeof', 'nameof', 'sizeof', 'defaultArg', 'ref', 'incr', 'decr', 'async', 'task', 'seq', 'lazy',
]);
/** Attributes that mark a test. */
const TEST_ATTRS = new Set(['Test', 'Fact', 'Theory', 'TestCase', 'TestCaseSource', 'Property', 'TestMethod', 'Benchmark', 'SetUp', 'TearDown', 'TestFixture']);
/** Primitive type names not worth a type reference. */
const PRIMITIVES = new Set(['int', 'int64', 'int32', 'int16', 'byte', 'sbyte', 'uint', 'uint32', 'uint64', 'float', 'float32', 'double', 'decimal', 'string', 'bool', 'char', 'unit', 'obj', 'exn', 'nativeint', 'option', 'list', 'array', 'seq', 'voption']);
/** Nodes that make their subtree a binding pattern rather than an expression. */
const PATTERN_CTX = new Set(['value_declaration_left', 'function_declaration_left', 'argument_patterns', 'primary_constr_args', 'paren_pattern', 'record_pattern', 'array_pattern', 'list_pattern', 'as_pattern', 'optional_pattern', 'attribute_pattern', 'type_check_pattern', 'typed_pattern', 'identifier_pattern', 'named_field_pattern', 'rules', 'rule']);

function inPatternCtx(n: Node): boolean {
  let p = n.parent;
  for (let i = 0; p && i < 8; i++) {
    if (p.type.endsWith('_expression') || p.type === 'function_or_value_defn' || p.type === 'member_defn' || p.type === 'declaration_expression') return false;
    if (PATTERN_CTX.has(p.type)) return true;
    p = p.parent;
  }
  return false;
}

/** Wrapper nodes that carry a declaration's xml doc on their own preceding sibling. */
const DOC_CLIMBERS = new Set(['type_definition', 'declaration_expression', 'type_extension_elements']);

/** The trailing `xml_doc` the grammar parks at the end of the previous declaration. */
function trailingXmlDoc(n: Node | null): Node | null {
  let cur: Node | null = n;
  while (cur) {
    if (cur.type === 'xml_doc') return cur;
    cur = cur.lastChild;
  }
  return null;
}

function cleanXml(parts: string[]): string {
  return cleanComment(parts.join('\n'));
}

function fsharpDoc(node: Node): string {
  let target = node;
  while (target.parent && DOC_CLIMBERS.has(target.parent.type)) target = target.parent;
  const parts: string[] = [];
  let prev = target.previousSibling;
  let lastStart = target.startPosition.row;
  while (prev && (prev.type === 'xml_doc' || prev.type === 'attributes' || prev.type === 'line_comment')) {
    if (lastStart - prev.endPosition.row > 1) break;
    if (prev.type === 'xml_doc') parts.unshift(prev.text);
    lastStart = prev.startPosition.row;
    prev = prev.previousSibling;
  }
  if (!parts.length) {
    const trailing = trailingXmlDoc(target.previousSibling);
    if (trailing && target.startPosition.row - trailing.endPosition.row <= 1) parts.push(trailing.text);
  }
  return parts.length ? cleanXml(parts) : '';
}

/** `[<Test; Fact>]` attribute names attached to a declaration. */
function attributesOf(node: Node): string[] {
  let target = node;
  while (target.parent && DOC_CLIMBERS.has(target.parent.type)) target = target.parent;
  const out: string[] = [];
  const collect = (n: Node) => {
    for (const a of named(n)) if (a.type === 'attribute') out.push(simpleTypeName(a.text.replace(/\(.*$/s, '')));
  };
  for (const c of named(target)) if (c.type === 'attributes') collect(c);
  let prev = target.previousSibling;
  while (prev && (prev.type === 'attributes' || prev.type === 'xml_doc' || prev.type === 'line_comment')) {
    if (prev.type === 'attributes') collect(prev);
    prev = prev.previousSibling;
  }
  return out;
}

/** The `type_name` of a `*_type_defn`. */
function typeNameOf(node: Node): { name: string; generics: string } | null {
  const tn = named(node).find((c) => c.type === 'type_name');
  if (!tn) return null;
  const id = tn.childForFieldName('type_name') ?? named(tn)[0];
  if (!id) return null;
  const args = named(tn).find((c) => c.type === 'type_argument_defn' || c.type === 'type_arguments');
  return { name: id.text, generics: args ? args.text : '' };
}

/** `inherit B()` / `interface I with` inside a type body. */
function supertypesOf(node: Node): NonNullable<DefSpec['supertypes']> {
  const out: NonNullable<DefSpec['supertypes']> = [];
  const scan = (n: Node) => {
    for (const c of named(n)) {
      if (c.type === 'class_inherits_decl') {
        const t = named(c).find((x) => x.type === 'simple_type' || x.type === 'generic_type' || x.type === 'long_identifier');
        if (t) out.push({ name: t.text, kind: 'extends' });
      } else if (c.type === 'interface_implementation') {
        const t = named(c).find((x) => x.type === 'simple_type' || x.type === 'generic_type' || x.type === 'long_identifier');
        if (t) out.push({ name: t.text, kind: 'implements' });
      } else if (c.type === 'type_extension_elements') scan(c);
    }
  };
  scan(node);
  return out;
}

function hasAbstractMember(node: Node): boolean {
  const scan = (n: Node): boolean => {
    for (const c of named(n)) {
      if (c.type === 'member_defn' && c.children.some((k) => k?.type === 'abstract')) return true;
      if (c.type === 'type_extension_elements' && scan(c)) return true;
    }
    return false;
  };
  return scan(node);
}

function stringText(n: Node | null | undefined): string {
  if (!n) return '';
  const s = n.type === 'const' ? named(n)[0] : n;
  if (!s || (s.type !== 'string' && s.type !== 'verbatim_string' && s.type !== 'triple_quoted_string')) return '';
  return s.text.replace(/^@?"+/, '').replace(/"+$/, '');
}

/** Head callee and argument count of a curried `application_expression` chain. */
function appSpine(node: Node): { head: Node | null; arity: number; args: Node[] } {
  let n = node;
  let arity = 0;
  let head: Node | null = null;
  for (;;) {
    const cs = named(n);
    if (!cs.length) break;
    arity += cs.length - 1;
    const first = cs[0]!;
    if (first.type === 'application_expression') {
      n = first;
      continue;
    }
    head = first;
    break;
  }
  const args = named(node).slice(1);
  if (args.length === 1 && args[0]!.type === 'unit') arity -= 1;
  return { head, arity, args };
}

function isInnerApp(node: Node): boolean {
  const p = node.parent;
  return p?.type === 'application_expression' && !!named(p)[0]?.equals(node);
}

/** `Map.tryFind` → { qualifier: 'Map', name: 'tryFind' } */
function splitPath(text: string): { qualifier: string; name: string } {
  const t = text.trim();
  const i = t.lastIndexOf('.');
  return i < 0 ? { qualifier: '', name: t } : { qualifier: t.slice(0, i), name: t.slice(i + 1) };
}

function stripTicks(s: string): string {
  return s.startsWith('``') && s.endsWith('``') ? s.slice(2, -2) : s;
}

export const fsharp: LanguageSupport = {
  id: 'fsharp',
  grammar: 'fsharp',
  extensions: ['.fs', '.fsx', '.fsi'],
  classLike: new Set(['record_type_defn', 'union_type_defn', 'anon_type_defn', 'enum_type_defn', 'interface_type_defn', 'type_extension', 'object_expression']),
  skip: new Set(['line_comment', 'block_comment', 'string', 'verbatim_string', 'triple_quoted_string', 'format_string', 'xml_doc']),

  isTestFile(path) {
    return /(^|\/)(test|tests)\//i.test(path) || /(Tests?|Spec)\.fsx?$/.test(path);
  },

  doc(node) {
    return fsharpDoc(node);
  },

  moduleDoc(root) {
    const first = root.firstChild;
    const scan = first?.type === 'namespace' || first?.type === 'named_module' ? first : root;
    for (const c of named(scan)) {
      if (c.type === 'xml_doc') return cleanXml([c.text]);
      if (c.type !== 'long_identifier' && c.type !== 'identifier') break;
    }
    return '';
  },

  definition(node, ctx): DefSpec | null {
    switch (node.type) {
      case 'namespace':
      case 'named_module':
      case 'module_defn': {
        const nm = node.childForFieldName('name') ?? named(node).find((c) => c.type === 'long_identifier' || c.type === 'identifier');
        if (!nm) return null;
        const kw = node.type === 'module_defn' || node.type === 'named_module' ? 'module' : 'namespace';
        return { kind: 'namespace', name: nm.text, signature: oneLine(`${kw} ${nm.text}`), doc: fsharpDoc(node), exported: true };
      }
      case 'record_type_defn':
      case 'union_type_defn':
      case 'enum_type_defn':
      case 'interface_type_defn':
      case 'anon_type_defn':
      case 'type_abbrev_defn':
      case 'delegate_type_defn':
      case 'type_extension': {
        const tn = typeNameOf(node);
        if (!tn) return null;
        const attrs = attributesOf(node);
        let kind: DefSpec['kind'] = 'class';
        if (node.type === 'record_type_defn') kind = 'struct';
        else if (node.type === 'union_type_defn' || node.type === 'enum_type_defn') kind = 'enum';
        else if (node.type === 'type_abbrev_defn' || node.type === 'delegate_type_defn') kind = 'type_alias';
        else if (node.type === 'interface_type_defn') kind = 'interface';
        else if (node.type === 'anon_type_defn') kind = hasAbstractMember(node) ? 'interface' : 'class';
        const ctorArgs = named(node).find((c) => c.type === 'primary_constr_args');
        const meta: DefSpec['meta'] = {};
        if (node.type === 'type_extension') meta.extension = true;
        if (attrs.length) meta.attributes = attrs.join(',');
        return {
          kind,
          name: tn.name,
          signature: oneLine(`type ${tn.name}${tn.generics}${ctorArgs ? ctorArgs.text : ''}`, 200),
          doc: fsharpDoc(node),
          exported: true,
          supertypes: supertypesOf(node),
          modifiers: attrs,
          meta: Object.keys(meta).length ? meta : undefined,
        };
      }
      case 'record_field': {
        const id = named(node).find((c) => c.type === 'identifier');
        if (!id) return null;
        const t = named(node).find((c) => c.type === 'simple_type' || c.type === 'generic_type' || c.type === 'postfix_type' || c.type === 'list_type');
        return { kind: 'field', name: id.text, signature: oneLine(node.text, 160), declaredType: t ? simpleTypeName(t.text) : undefined, doc: fsharpDoc(node), exported: true };
      }
      case 'union_type_case': {
        const id = named(node).find((c) => c.type === 'identifier');
        if (!id) return null;
        return { kind: 'enum_member', name: id.text, signature: oneLine(node.text, 160), doc: fsharpDoc(node), exported: true };
      }
      case 'enum_type_case': {
        const id = named(node).find((c) => c.type === 'identifier');
        if (!id) return null;
        return { kind: 'enum_member', name: id.text, signature: oneLine(node.text, 160), exported: true };
      }
      case 'member_defn': {
        const isAbstract = node.children.some((c) => c?.type === 'abstract');
        const isStatic = node.children.some((c) => c?.type === 'static');
        const attrs = attributesOf(node);
        const sigNode = named(node).find((c) => c.type === 'member_signature');
        if (sigNode) {
          const id = named(sigNode).find((c) => c.type === 'identifier');
          if (!id) return null;
          const modifiers = ['abstract', ...attrs];
          if (isStatic) modifiers.push('static');
          return { kind: 'method', name: stripTicks(id.text), signature: oneLine(node.text, 200), doc: fsharpDoc(node), modifiers, exported: true, meta: { prototype: true } };
        }
        const mp = named(node).find((c) => c.type === 'method_or_prop_defn');
        if (!mp) return null;
        const nameNode = mp.childForFieldName('name');
        const method = nameNode?.childForFieldName('method') ?? nameNode;
        const rawName = method ? stripTicks(method.text) : '';
        if (!rawName) return null;
        const args = mp.childForFieldName('args');
        const accessor = named(mp).find((c) => c.type === 'property_accessor');
        const isNew = rawName === 'new' || mp.children.some((c) => c?.type === 'new');
        const modifiers = [...attrs];
        if (isStatic) modifiers.push('static');
        const kind: DefSpec['kind'] = isNew ? 'constructor' : args || accessor ? 'method' : 'property';
        return {
          kind,
          name: rawName,
          body: mp,
          signature: oneLine(`member ${nameNode?.text ?? rawName}${args ? ' ' + args.text : ''}`, 200),
          doc: fsharpDoc(node),
          modifiers,
          exported: true,
        };
      }
      case 'additional_constr_defn': {
        return { kind: 'constructor', name: 'new', signature: oneLine(node.text, 160), doc: fsharpDoc(node), exported: true };
      }
      case 'function_or_value_defn': {
        // Nested `let` bindings inside a function body are locals, not declarations.
        const owner = ctx.scopeDef;
        if (owner && !['namespace', 'class', 'struct', 'enum', 'interface', 'trait'].includes(owner.kind)) return null;
        const fdl = named(node).find((c) => c.type === 'function_declaration_left');
        const vdl = named(node).find((c) => c.type === 'value_declaration_left');
        const decl = fdl ?? vdl;
        if (!decl) return null;
        const id = named(decl).find((c) => c.type === 'identifier') ?? named(decl).find((c) => c.type === 'identifier_pattern');
        if (!id) return null;
        const name = stripTicks(id.type === 'identifier_pattern' ? id.text : id.text);
        if (!name) return null;
        const attrs = attributesOf(node);
        const isRec = node.children.some((c) => c?.type === 'rec');
        const isMutable = decl.children.some((c) => c?.type === 'mutable');
        const isInline = node.children.some((c) => c?.type === 'inline');
        const argPats = fdl ? named(fdl).find((c) => c.type === 'argument_patterns') : null;
        const modifiers = [...attrs];
        if (isRec) modifiers.push('rec');
        if (isMutable) modifiers.push('mutable');
        if (isInline) modifiers.push('inline');
        let kind: DefSpec['kind'];
        if (fdl) kind = ctx.inClass ? 'method' : 'function';
        else kind = ctx.inClass ? 'field' : 'constant';
        if (attrs.some((a) => TEST_ATTRS.has(a)) && !ctx.inClass) kind = 'test';
        const meta: DefSpec['meta'] = {};
        if (attrs.length) meta.attributes = attrs.join(',');
        const framework = attrs.find((a) => TEST_ATTRS.has(a));
        if (framework) meta.framework = framework;
        return {
          kind,
          name,
          body: node.childForFieldName('body'),
          signature: oneLine(`let ${isRec ? 'rec ' : ''}${decl.text}`, 200),
          doc: fsharpDoc(node),
          modifiers,
          exported: !ctx.inClass && !name.startsWith('_'),
          meta: Object.keys(meta).length ? meta : undefined,
        };
      }
    }
    return null;
  },

  imports(node): Import[] | null {
    if (node.type !== 'import_decl') return null;
    const id = named(node).find((c) => c.type === 'long_identifier');
    if (!id) return [];
    const source = id.text.replace(/\s+/g, '');
    return [{ source, names: [], namespace: true, alias: source.slice(source.lastIndexOf('.') + 1), kind: 'static', line: node.startPosition.row + 1 }];
  },

  references(node, ctx) {
    switch (node.type) {
      case 'import_decl':
        return true;
      case 'attributes': {
        for (const a of named(node)) {
          if (a.type !== 'attribute') continue;
          const nm = simpleTypeName(a.text.replace(/\(.*$/s, ''));
          if (nm) ctx.emitRef({ kind: 'decorator', name: nm }, a);
        }
        return true;
      }
      case 'application_expression': {
        if (isInnerApp(node)) return;
        const { head, arity, args } = appSpine(node);
        if (!head) return;
        if (head.type === 'long_identifier_or_op' || head.type === 'long_identifier') {
          const { qualifier, name } = splitPath(head.text);
          if (/^(Environment|System\.Environment)$/.test(qualifier) && /^GetEnvironmentVariable/.test(name)) {
            const key = stringText(args[0]);
            if (key) ctx.emitRef({ kind: 'config', name: key }, args[0]!);
          }
          if (!SKIP_CALLS.has(name)) {
            ctx.emitRef({ kind: /^[A-Z]/.test(name) && !qualifier ? 'new' : 'call', name, qualifier, arity }, head);
          }
        }
        return;
      }
      case 'generic_new_expression': {
        const t = named(node).find((c) => c.type === 'simple_type' || c.type === 'generic_type' || c.type === 'long_identifier');
        if (t) ctx.emitRef({ kind: 'new', name: simpleTypeName(t.text) }, t);
        return true;
      }
      case 'long_identifier_or_op': {
        const p = node.parent;
        if (p?.type === 'application_expression' && named(p)[0]?.equals(node)) return true;
        if (inPatternCtx(node)) return true;
        const { qualifier, name } = splitPath(node.text);
        if (!SKIP_CALLS.has(name)) ctx.emitRef({ kind: 'value', name, qualifier }, node);
        return true;
      }
      case 'simple_type': {
        const nm = simpleTypeName(node.text);
        if (nm && !PRIMITIVES.has(nm)) ctx.emitRef({ kind: 'type', name: nm }, node);
        return true;
      }
      case 'generic_type': {
        const base = named(node)[0];
        if (base) {
          const nm = simpleTypeName(base.text);
          if (nm && !PRIMITIVES.has(nm)) ctx.emitRef({ kind: 'type', name: nm }, base);
        }
        return;
      }
      case 'long_identifier':
        return true;
      case 'typed_pattern': {
        const pat = named(node)[0];
        const t = named(node).find((c) => c.type === 'simple_type' || c.type === 'generic_type' || c.type === 'postfix_type');
        if (pat && t) ctx.emitLocalType({ name: simpleTypeName(pat.text), type: simpleTypeName(t.text), via: 'annotation' });
        return;
      }
    }
    return;
  },

  resolveModule(source) {
    const segs = source.split('.').filter(Boolean);
    if (!segs.length) return [];
    const joined = segs.join('/');
    const last = segs[segs.length - 1]!;
    const out: string[] = [];
    for (const ext of ['.fs', '.fsi', '.fsx']) {
      for (const root of ['', 'src', 'lib', 'test', 'tests']) {
        const p = root ? `${root}/` : '';
        out.push(`${p}${joined}${ext}`, `${p}${last}${ext}`);
        if (segs.length > 1) out.push(`${p}${segs.slice(1).join('/')}${ext}`);
      }
    }
    return [...new Set(out)];
  },
};
