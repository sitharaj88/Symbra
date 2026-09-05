import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, cleanComment, named, simpleTypeName } from '../parse/walk.js';

/** Stdlib names that add no signal as call edges. */
const SKIP_CALLS = new Set([
  'ignore', 'raise', 'failwith', 'invalid_arg', 'print_string', 'print_endline', 'print_int',
  'prerr_endline', 'string_of_int', 'int_of_string', 'string_of_float', 'float_of_string', 'fst',
  'snd', 'compare', 'min', 'max', 'succ', 'pred', 'abs', 'not', 'incr', 'decr', 'ref', 'fun',
]);
/** Alcotest / OUnit test-case builders. */
const TEST_FNS = new Set(['test_case', 'test_list', '>::', '>:::', 'test_suite']);
/** ppx attributes that turn a `let` into a test. */
const TEST_ATTRS = new Set(['test', 'test_unit', 'test_module', 'expect', 'expect_test', 'bench']);

/** Containers whose `value_definition` / `type_definition` children are top-level declarations. */
const ITEM_CONTAINERS = new Set(['compilation_unit', 'structure', 'signature']);

function lowerFirst(s: string): string {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/** Binding nodes whose doc comment sits on the enclosing `*_definition` item instead. */
const DOC_CLIMBERS = new Set(['let_binding', 'type_binding', 'module_binding', 'class_binding', 'class_type_binding']);

/** `(** … *)` doc comment(s) immediately preceding a node, skipping ordinary `(* … *)`. */
function ocamlDoc(node: Node): string {
  let target: Node = node;
  if (DOC_CLIMBERS.has(node.type)) {
    while (target.parent && !ITEM_CONTAINERS.has(target.parent.type) && target.parent.type !== 'object_expression') target = target.parent;
  }
  const parts: string[] = [];
  let prev = target.previousSibling;
  let lastStart = target.startPosition.row;
  while (prev && prev.type === 'comment') {
    if (lastStart - prev.endPosition.row > 1) break;
    if (!prev.text.startsWith('(**')) break;
    parts.unshift(prev.text);
    lastStart = prev.startPosition.row;
    prev = prev.previousSibling;
  }
  if (!parts.length) return '';
  return cleanComment(parts.join('\n').replace(/^\(\*\*/gm, '/**').replace(/\*\)$/gm, '*/'));
}

function stringText(n: Node | null | undefined): string {
  if (!n || n.type !== 'string') return '';
  const c = named(n).find((x) => x.type === 'string_content');
  return c ? c.text : n.text.replace(/^"|"$/g, '');
}

/** ppx extension name on a `let%test` / `type%foo` item. */
function extensionName(node: Node): string {
  for (const c of node.children) {
    if (c?.type === 'attribute_id') return c.text;
  }
  return '';
}

/** True when this binding is a top-level / module-level item rather than a `let … in` local. */
function isItemBinding(node: Node): boolean {
  const p = node.parent;
  if (!p) return false;
  const g = p.parent;
  return !!g && ITEM_CONTAINERS.has(g.type);
}

function parametersOf(node: Node): Node[] {
  return node.children.filter((c): c is Node => !!c && c.type === 'parameter');
}

/** `Hashtbl.find_opt` → { qualifier: 'Hashtbl', name: 'find_opt' } */
function valuePathParts(vp: Node): { qualifier: string; name: string; nameNode: Node } | null {
  const kidsOf = named(vp);
  const last = kidsOf[kidsOf.length - 1];
  if (!last) return null;
  const mod = kidsOf.length > 1 ? kidsOf[0]! : null;
  return { qualifier: mod ? mod.text : '', name: last.text, nameNode: last };
}

function applicationArgs(node: Node): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < node.childCount; i++) {
    if (node.fieldNameForChild(i) === 'argument') {
      const c = node.child(i);
      if (c) out.push(c);
    }
  }
  return out;
}

function makeOcaml(id: string, grammar: string, extensions: string[], iface: boolean): LanguageSupport {
  return {
    id,
    grammar,
    extensions,
    classLike: new Set(['class_binding', 'object_expression', 'type_binding', 'signature', 'module_type_definition']),
    skip: new Set(['comment', 'string', 'quoted_string', 'character', 'attribute', 'item_attribute', 'floating_attribute']),

    isTestFile(path) {
      return /(^|\/)(test|tests)\//.test(path) || /(^|\/)test_[^/]*\.mli?$/.test(path) || /_test\.mli?$/.test(path);
    },

    doc(node) {
      return ocamlDoc(node);
    },

    moduleDoc(root) {
      const first = root.firstChild;
      if (first?.type === 'comment' && first.text.startsWith('(**')) {
        return cleanComment(first.text.replace(/^\(\*\*/, '/**').replace(/\*\)$/, '*/'));
      }
      return '';
    },

    definition(node, ctx): DefSpec | null {
      switch (node.type) {
        case 'let_binding': {
          if (!isItemBinding(node)) return null;
          const owner = node.parent!;
          const ext = extensionName(owner);
          const pat = node.childForFieldName('pattern');
          if (ext && TEST_ATTRS.has(ext)) {
            const title = stringText(pat) || (pat?.text ?? ext);
            return { kind: 'test', name: title, body: node.childForFieldName('body'), signature: oneLine(`let%${ext} "${title}"`), meta: { framework: 'ppx_inline_test', attribute: ext }, exported: false };
          }
          if (!pat || pat.type !== 'value_name') return null;
          const name = pat.text;
          const params = parametersOf(node);
          const typeNode = node.childForFieldName('type');
          const isRec = owner.children.some((c) => c?.type === 'rec');
          const modifiers: string[] = [];
          if (isRec) modifiers.push('rec');
          let kind: DefSpec['kind'] = params.length ? (ctx.inClass ? 'method' : 'function') : 'constant';
          if (params.length && !ctx.inClass && /^test_/.test(name)) kind = 'test';
          const sig = `let ${isRec ? 'rec ' : ''}${name}${params.length ? ' ' + params.map((p) => p.text).join(' ') : ''}${typeNode ? ' : ' + typeNode.text : ''}`;
          return {
            kind,
            name,
            body: node.childForFieldName('body'),
            signature: oneLine(sig, 200),
            doc: ocamlDoc(node),
            modifiers,
            exported: !name.startsWith('_'),
            declaredType: typeNode && !typeNode.text.includes('->') ? simpleTypeName(typeNode.text) : undefined,
            meta: { arity: params.length },
          };
        }
        case 'value_specification': {
          const nm = named(node).find((c) => c.type === 'value_name');
          if (!nm) return null;
          const t = node.childForFieldName('type');
          const isFn = !!t && (t.type === 'function_type' || t.text.includes('->'));
          return {
            kind: isFn ? (ctx.inClass ? 'method' : 'function') : 'constant',
            name: nm.text,
            signature: oneLine(node.text, 200),
            doc: ocamlDoc(node),
            modifiers: ['abstract'],
            exported: true,
            declaredType: t && !isFn ? simpleTypeName(t.text) : undefined,
            meta: { prototype: true },
          };
        }
        case 'method_specification': {
          const nm = named(node).find((c) => c.type === 'method_name');
          if (!nm) return null;
          return { kind: 'method', name: nm.text, signature: oneLine(node.text, 200), doc: ocamlDoc(node), modifiers: ['abstract'], exported: true, meta: { prototype: true } };
        }
        case 'type_binding': {
          const nm = node.childForFieldName('name');
          if (!nm) return null;
          const body = node.childForFieldName('body');
          const eq = node.childForFieldName('equation');
          let kind: DefSpec['kind'] = 'type_alias';
          if (body?.type === 'record_declaration') kind = 'struct';
          else if (body?.type === 'variant_declaration') kind = 'enum';
          else if (!body && !eq) kind = 'type_alias';
          return {
            kind,
            name: nm.text,
            signature: oneLine(`type ${node.text}`, 200),
            doc: ocamlDoc(node),
            exported: true,
            meta: !body && !eq ? { abstract: true } : undefined,
          };
        }
        case 'field_declaration': {
          const nm = named(node).find((c) => c.type === 'field_name');
          if (!nm) return null;
          const t = node.childForFieldName('type');
          const mutable = node.children.some((c) => c?.type === 'mutable');
          return { kind: 'field', name: nm.text, signature: oneLine(node.text, 160), declaredType: t ? simpleTypeName(t.text) : undefined, modifiers: mutable ? ['mutable'] : [], exported: true, doc: ocamlDoc(node) };
        }
        case 'constructor_declaration': {
          const nm = named(node).find((c) => c.type === 'constructor_name');
          if (!nm) return null;
          return { kind: 'enum_member', name: nm.text, signature: oneLine(node.text, 160), exported: true, doc: ocamlDoc(node) };
        }
        case 'module_binding': {
          const nm = named(node).find((c) => c.type === 'module_name');
          if (!nm) return null;
          const body = node.childForFieldName('body');
          const sigType = named(node).find((c) => c.type === 'module_type_path' || c.type === 'parenthesized_module_type' || c.type === 'signature');
          const sup: NonNullable<DefSpec['supertypes']> = [];
          if (sigType && sigType.type === 'module_type_path') sup.push({ name: sigType.text, kind: 'implements' });
          return {
            kind: 'namespace',
            name: nm.text,
            body: body ?? null,
            signature: oneLine(`module ${nm.text}${sigType && sigType.type === 'module_type_path' ? ' : ' + sigType.text : ''}`, 200),
            doc: ocamlDoc(node),
            exported: true,
            supertypes: sup,
          };
        }
        case 'module_type_definition': {
          const nm = named(node).find((c) => c.type === 'module_type_name');
          if (!nm) return null;
          return { kind: 'interface', name: nm.text, body: node.childForFieldName('body'), signature: oneLine(`module type ${nm.text}`), doc: ocamlDoc(node), exported: true };
        }
        case 'class_binding':
        case 'class_type_binding': {
          const nm = named(node).find((c) => c.type === 'class_name' || c.type === 'class_type_name');
          if (!nm) return null;
          const params = parametersOf(node);
          return {
            kind: 'class',
            name: nm.text,
            body: node.childForFieldName('body'),
            signature: oneLine(`class ${nm.text}${params.length ? ' ' + params.map((p) => p.text).join(' ') : ''}`, 200),
            doc: ocamlDoc(node),
            exported: true,
          };
        }
        case 'method_definition': {
          const nm = named(node).find((c) => c.type === 'method_name');
          if (!nm) return null;
          const params = parametersOf(node);
          return { kind: params.length ? 'method' : 'property', name: nm.text, body: node.childForFieldName('body'), signature: oneLine(`method ${nm.text}${params.length ? ' ' + params.map((p) => p.text).join(' ') : ''}`, 200), doc: ocamlDoc(node), exported: true, meta: { arity: params.length } };
        }
        case 'instance_variable_definition':
        case 'instance_variable_specification': {
          const nm = named(node).find((c) => c.type === 'instance_variable_name');
          if (!nm) return null;
          const t = node.childForFieldName('type');
          return { kind: 'field', name: nm.text, signature: oneLine(node.text, 160), declaredType: t ? simpleTypeName(t.text) : undefined, exported: false, doc: ocamlDoc(node) };
        }
        case 'exception_definition': {
          const nm = named(node).find((c) => c.type === 'constructor_declaration');
          const cn = nm ? named(nm).find((c) => c.type === 'constructor_name') : null;
          if (!cn) return null;
          return { kind: 'struct', name: cn.text, signature: oneLine(node.text, 160), doc: ocamlDoc(node), exported: true, meta: { exception: true } };
        }
        case 'application_expression': {
          // Alcotest: `test_case "name" `Quick f`
          const fn = node.childForFieldName('function');
          if (fn?.type !== 'value_path') return null;
          const parts = valuePathParts(fn);
          if (!parts || !TEST_FNS.has(parts.name)) return null;
          const args = applicationArgs(node);
          const title = stringText(args[0]);
          if (!title) return null;
          return { kind: 'test', name: title, signature: oneLine(node.text, 160), meta: { framework: 'alcotest', title }, exported: false };
        }
      }
      return null;
    },

    imports(node): Import[] | null {
      if (node.type !== 'open_module' && node.type !== 'include_module' && node.type !== 'open_directive') return null;
      const mod = node.childForFieldName('module') ?? named(node).find((c) => c.type === 'module_path' || c.type === 'extended_module_path');
      if (!mod) return [];
      const source = mod.text.replace(/\s+/g, '');
      return [
        {
          source,
          names: [],
          namespace: true,
          alias: source.slice(source.lastIndexOf('.') + 1),
          kind: node.type === 'include_module' ? 'reexport' : 'static',
          line: node.startPosition.row + 1,
        },
      ];
    },

    references(node, ctx) {
      switch (node.type) {
        case 'open_module':
        case 'include_module':
          return true;
        case 'application_expression': {
          const fn = node.childForFieldName('function');
          const args = applicationArgs(node);
          if (fn?.type === 'value_path') {
            const parts = valuePathParts(fn);
            if (parts) {
              if (parts.qualifier === 'Sys' && (parts.name === 'getenv' || parts.name === 'getenv_opt')) {
                const key = stringText(args[0]);
                if (key) ctx.emitRef({ kind: 'config', name: key }, args[0]!);
              }
              if (!SKIP_CALLS.has(parts.name)) ctx.emitRef({ kind: 'call', name: parts.name, qualifier: parts.qualifier, arity: args.length }, parts.nameNode);
            }
          } else if (fn?.type === 'constructor_path') {
            const kidsOf = named(fn);
            const last = kidsOf[kidsOf.length - 1]!;
            ctx.emitRef({ kind: 'new', name: last.text, qualifier: kidsOf.length > 1 ? kidsOf[0]!.text : '', arity: args.length }, last);
          } else if (fn?.type === 'method_invocation') {
            const objNode = fn.childForFieldName('object') ?? named(fn)[0];
            const m = named(fn).find((c) => c.type === 'method_name');
            if (m) ctx.emitRef({ kind: 'call', name: m.text, qualifier: objNode?.text ?? '', arity: args.length }, m);
          }
          return;
        }
        case 'method_invocation': {
          if (node.parent?.type === 'application_expression' && node.parent.childForFieldName('function')?.equals(node)) return;
          const objNode = named(node)[0];
          const m = named(node).find((c) => c.type === 'method_name');
          if (m) ctx.emitRef({ kind: 'call', name: m.text, qualifier: objNode?.text ?? '', arity: 0 }, m);
          return;
        }
        case 'value_path': {
          const p = node.parent;
          if (p?.type === 'application_expression' && p.childForFieldName('function')?.equals(node)) return true;
          const parts = valuePathParts(node);
          if (parts && !SKIP_CALLS.has(parts.name)) ctx.emitRef({ kind: 'value', name: parts.name, qualifier: parts.qualifier }, parts.nameNode);
          return true;
        }
        case 'constructor_path': {
          const p = node.parent;
          if (p?.type === 'application_expression' && p.childForFieldName('function')?.equals(node)) return true;
          const kidsOf = named(node);
          const last = kidsOf[kidsOf.length - 1];
          if (last) ctx.emitRef({ kind: 'value', name: last.text, qualifier: kidsOf.length > 1 ? kidsOf[0]!.text : '' }, last);
          return true;
        }
        case 'type_constructor_path': {
          const kidsOf = named(node);
          const last = kidsOf[kidsOf.length - 1];
          if (last) ctx.emitRef({ kind: 'type', name: last.text, qualifier: kidsOf.length > 1 ? kidsOf[0]!.text : '' }, last);
          return true;
        }
        case 'module_path':
        case 'extended_module_path': {
          if (node.parent?.type === 'value_path' || node.parent?.type === 'constructor_path' || node.parent?.type === 'type_constructor_path') return true;
          ctx.emitRef({ kind: 'mention', name: node.text.slice(node.text.lastIndexOf('.') + 1) }, node);
          return true;
        }
        case 'let_binding': {
          // A `let x : T = …` local: record the annotation so member calls on `x` resolve.
          if (isItemBinding(node)) return;
          const pat = node.childForFieldName('pattern');
          const t = node.childForFieldName('type');
          if (pat?.type === 'value_name' && t) ctx.emitLocalType({ name: pat.text, type: simpleTypeName(t.text), via: 'annotation' });
          return;
        }
        case 'typed_expression':
        case 'typed_pattern': {
          const pat = node.childForFieldName('pattern') ?? named(node)[0];
          const t = node.childForFieldName('type');
          if (pat && t && (pat.type === 'value_pattern' || pat.type === 'value_name')) {
            ctx.emitLocalType({ name: pat.text, type: simpleTypeName(t.text), via: 'annotation' });
          }
          return;
        }
      }
      return;
    },

    resolveModule(source) {
      const segs = source.split('.').filter(Boolean);
      if (!segs.length) return [];
      const lower = segs.map(lowerFirst);
      const first = lower[0]!;
      const last = lower[lower.length - 1]!;
      const exts = iface ? ['.mli', '.ml'] : ['.ml', '.mli'];
      const out: string[] = [];
      for (const root of ['', 'lib', 'src', 'bin', 'test', 'tests']) {
        const p = root ? `${root}/` : '';
        for (const e of exts) {
          out.push(`${p}${first}${e}`);
          if (lower.length > 1) out.push(`${p}${lower.join('/')}${e}`, `${p}${last}${e}`);
        }
      }
      return [...new Set(out)];
    },
  };
}

export const ocaml = makeOcaml('ocaml', 'ocaml', ['.ml'], false);
export const ocamlInterface = makeOcaml('ocaml_interface', 'ocaml_interface', ['.mli'], true);
