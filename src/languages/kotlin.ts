import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, simpleTypeName, named, kids } from '../parse/walk.js';
import { headerText, docComment, fileDoc, isConstantName, looksLikeType, unquote, jvmResolveModule, routesFromAnnotations, routePrefix, emitRoutes, type AnnotationInfo } from './java.js';

const COMMENTS = new Set(['multiline_comment', 'line_comment']);
const TEST_ANNOTATIONS = new Set(['Test', 'ParameterizedTest', 'RepeatedTest', 'TestFactory', 'BeforeEach', 'AfterEach']);
const KTOR_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'route', 'webSocket']);
const LEADING = new Set(['modifiers']);
const BODIES = new Set(['class_body', 'enum_class_body', 'function_body']);
const TYPE_NODES = new Set(['user_type', 'nullable_type', 'not_nullable_type', 'function_type', 'parenthesized_type']);
const DEF_HOLDERS = new Set(['source_file', 'class_body', 'enum_class_body']);

function keywords(node: Node): Set<string> {
  return new Set(
    kids(node)
      .filter((c) => !c.isNamed)
      .map((c) => c.type),
  );
}

/** `val` / `var` of a property or constructor parameter (a named `binding_pattern_kind` child), or ''. */
function bindingKind(node: Node): 'val' | 'var' | '' {
  const b = named(node).find((c) => c.type === 'binding_pattern_kind');
  return b?.text === 'val' ? 'val' : b?.text === 'var' ? 'var' : '';
}

function modifiersNode(node: Node): Node | null {
  return kids(node).find((c) => c.type === 'modifiers') ?? null;
}

function modifiersOf(node: Node): string[] {
  const m = modifiersNode(node);
  if (!m) return [];
  return named(m)
    .filter((c) => c.type !== 'annotation')
    .map((c) => c.text);
}

function annotationInfo(a: Node): AnnotationInfo | null {
  const ci = named(a).find((c) => c.type === 'constructor_invocation');
  const ut = ci ? named(ci).find((c) => c.type === 'user_type') : named(a).find((c) => c.type === 'user_type');
  if (!ut) return null;
  const args = ci ? (named(ci).find((c) => c.type === 'value_arguments')?.text ?? '') : '';
  return { name: simpleTypeName(ut.text), args };
}

function annotationsOf(node: Node): AnnotationInfo[] {
  const m = modifiersNode(node);
  if (!m) return [];
  const out: AnnotationInfo[] = [];
  for (const a of named(m)) {
    if (a.type !== 'annotation') continue;
    const info = annotationInfo(a);
    if (info) out.push(info);
  }
  return out;
}

function supertypesOf(node: Node, allExtends: boolean): NonNullable<DefSpec['supertypes']> {
  const out: NonNullable<DefSpec['supertypes']> = [];
  for (const d of named(node)) {
    if (d.type !== 'delegation_specifier') continue;
    const inner = named(d)[0];
    if (!inner) continue;
    if (inner.type === 'constructor_invocation') {
      const ut = named(inner).find((c) => c.type === 'user_type');
      out.push({ name: ut?.text ?? inner.text, kind: 'extends' });
    } else if (inner.type === 'explicit_delegation') {
      const ut = named(inner).find((c) => c.type === 'user_type');
      out.push({ name: ut?.text ?? inner.text, kind: 'implements' });
    } else {
      out.push({ name: inner.text, kind: allExtends ? 'extends' : 'implements' });
    }
  }
  return out;
}

function typeChild(node: Node): Node | null {
  return named(node).find((c) => TYPE_NODES.has(c.type)) ?? null;
}

function kdoc(node: Node): string {
  return docComment(node, COMMENTS);
}

/** `Foo(...)` bare capitalised call -> constructor-ish type name. */
function constructorCallType(value: Node | null | undefined): string | null {
  if (!value || value.type !== 'call_expression') return null;
  const callee = named(value)[0];
  if (callee?.type === 'simple_identifier' && /^[A-Z]/.test(callee.text)) return callee.text;
  if (callee?.type === 'navigation_expression') {
    const last = named(named(callee).find((c) => c.type === 'navigation_suffix'))[0];
    if (last && /^[A-Z]/.test(last.text)) return last.text;
  }
  return null;
}

function stringContent(n: Node | null | undefined): string | null {
  if (!n) return null;
  if (n.type === 'value_argument') n = named(n)[0] ?? null;
  if (!n || n.type !== 'string_literal') return null;
  return named(n)
    .filter((c) => c.type === 'string_content')
    .map((c) => c.text)
    .join('');
}

function callParts(node: Node): { callee: Node | null; args: Node | null; lambda: Node | null } {
  const callee = named(node)[0] ?? null;
  const suffix = named(node).find((c) => c.type === 'call_suffix');
  const args = named(suffix).find((c) => c.type === 'value_arguments') ?? null;
  const lambda = named(suffix).find((c) => c.type === 'annotated_lambda') ?? null;
  return { callee, args, lambda };
}

function enclosingFunctionName(ctx: WalkContext): string {
  const d = ctx.scopeDef;
  return d && (d.kind === 'function' || d.kind === 'method' || d.kind === 'test') ? d.name : '';
}

export const kotlin: LanguageSupport = {
  id: 'kotlin',
  grammar: 'kotlin',
  extensions: ['.kt', '.kts'],
  classLike: new Set(['class_declaration', 'object_declaration', 'companion_object', 'object_literal']),
  skip: new Set(['multiline_comment', 'line_comment', 'string_literal']),

  isTestFile(path) {
    return /\/src\/test\//.test(path) || /(Test|Tests|Spec)\.kt$/.test(path);
  },

  doc(node) {
    return kdoc(node);
  },

  moduleDoc(root) {
    return fileDoc(root, COMMENTS);
  },

  definition(node, ctx): DefSpec | null {
    switch (node.type) {
      case 'class_declaration':
      case 'object_declaration':
      case 'companion_object': {
        const nameNode = named(node).find((c) => c.type === 'type_identifier');
        const name = nameNode?.text ?? (node.type === 'companion_object' ? 'Companion' : '');
        if (!name) return null;
        const kw = keywords(node);
        const mods = modifiersOf(node);
        let kind: DefSpec['kind'] = 'class';
        const meta: DefSpec['meta'] = {};
        if (kw.has('interface')) kind = 'interface';
        else if (kw.has('enum')) kind = 'enum';
        if (mods.includes('annotation')) {
          kind = 'interface';
          meta.annotation = true;
        }
        if (mods.includes('data')) meta.data = true;
        if (node.type === 'object_declaration') meta.object = true;
        if (node.type === 'companion_object') meta.companion = true;
        const body = named(node).find((c) => c.type === 'class_body' || c.type === 'enum_class_body') ?? null;
        return {
          kind,
          name,
          body,
          signature: headerText(node, mods, LEADING, BODIES),
          doc: kdoc(node),
          modifiers: mods,
          exported: !mods.includes('private'),
          supertypes: supertypesOf(node, kind === 'interface'),
          meta: Object.keys(meta).length ? meta : undefined,
        };
      }
      case 'function_declaration': {
        const nameNode = named(node).find((c) => c.type === 'simple_identifier');
        if (!nameNode) return null;
        const name = unquote(nameNode.text);
        const mods = modifiersOf(node);
        const anns = annotationsOf(node);
        let kind: DefSpec['kind'] = ctx.inClass ? 'method' : 'function';
        if (anns.some((a) => TEST_ANNOTATIONS.has(a.name))) kind = 'test';
        const owner = node.parent?.parent;
        const prefix = owner && (owner.type === 'class_declaration' || owner.type === 'object_declaration') ? routePrefix(annotationsOf(owner)) : '';
        emitRoutes(ctx, routesFromAnnotations(anns, prefix), name, node);
        // extension receiver precedes the name; return type follows the parameters
        const cs = named(node);
        const nameIdx = cs.indexOf(nameNode);
        const paramsIdx = cs.findIndex((c) => c.type === 'function_value_parameters');
        const receiver = cs.slice(0, nameIdx).find((c) => TYPE_NODES.has(c.type));
        const ret = paramsIdx >= 0 ? cs.slice(paramsIdx + 1).find((c) => TYPE_NODES.has(c.type)) : undefined;
        const meta: DefSpec['meta'] = {};
        if (receiver) meta.receiver = simpleTypeName(receiver.text);
        return {
          kind,
          name,
          body: named(node).find((c) => c.type === 'function_body') ?? null,
          signature: headerText(node, mods, LEADING, BODIES),
          doc: kdoc(node),
          modifiers: mods,
          exported: !mods.includes('private'),
          declaredType: ret ? simpleTypeName(ret.text) : undefined,
          meta: Object.keys(meta).length ? meta : undefined,
        };
      }
      case 'secondary_constructor': {
        const name = ctx.scopeDef?.name ?? '';
        if (!name) return null;
        const mods = modifiersOf(node);
        return { kind: 'constructor', name, signature: headerText(node, mods, LEADING, new Set(['statements', 'constructor_delegation_call'])), doc: kdoc(node), modifiers: mods, exported: !mods.includes('private') };
      }
      case 'class_parameter': {
        const binding = bindingKind(node);
        const nameNode = named(node).find((c) => c.type === 'simple_identifier');
        const t = typeChild(node);
        if (!nameNode) return null;
        const declaredType = t ? simpleTypeName(t.text) : undefined;
        if (!binding) {
          // plain constructor parameter: visible in initialisers, not a member
          if (declaredType) ctx.emitLocalType({ name: nameNode.text, type: declaredType, via: 'annotation' });
          return null;
        }
        const mods = modifiersOf(node);
        if (declaredType) ctx.emitLocalType({ name: nameNode.text, type: declaredType, via: 'field' });
        return { kind: 'field', name: nameNode.text, signature: oneLine(node.text, 120), doc: kdoc(node), modifiers: [...mods, binding], exported: !mods.includes('private'), declaredType };
      }
      case 'property_declaration': {
        const holder = node.parent?.type ?? '';
        const vd = named(node).find((c) => c.type === 'variable_declaration');
        const nameNode = named(vd)[0];
        if (!vd || !nameNode || nameNode.type !== 'simple_identifier') return null;
        const name = nameNode.text;
        const mods = modifiersOf(node);
        const t = typeChild(vd);
        const cs = named(node);
        const value = cs[cs.indexOf(vd) + 1] ?? null;
        let declaredType = t ? simpleTypeName(t.text) : undefined;
        if (!declaredType) {
          const ct = constructorCallType(value);
          if (ct) declaredType = ct;
        }
        if (!DEF_HOLDERS.has(holder)) {
          if (declaredType) ctx.emitLocalType({ name, type: declaredType, via: t ? 'annotation' : 'constructor_call' });
          return null;
        }
        if (declaredType) ctx.emitLocalType({ name, type: declaredType, via: 'field' });
        const isVal = bindingKind(node) === 'val';
        let kind: DefSpec['kind'];
        if (mods.includes('const') || (holder === 'source_file' && isVal && isConstantName(name))) kind = 'constant';
        else if (holder === 'source_file') kind = 'variable';
        else {
          const next = node.nextNamedSibling;
          kind = next && (next.type === 'getter' || next.type === 'setter') ? 'property' : 'field';
        }
        return { kind, name, signature: oneLine(node.text, 160), doc: kdoc(node), modifiers: [...mods, isVal ? 'val' : 'var'], exported: !mods.includes('private'), declaredType };
      }
      case 'enum_entry': {
        const nameNode = named(node).find((c) => c.type === 'simple_identifier');
        if (!nameNode) return null;
        return { kind: 'enum_member', name: nameNode.text, body: named(node).find((c) => c.type === 'class_body') ?? null, signature: oneLine(node.text, 80), doc: kdoc(node), exported: true };
      }
      case 'type_alias': {
        const nameNode = named(node).find((c) => c.type === 'type_identifier');
        if (!nameNode) return null;
        const mods = modifiersOf(node);
        return { kind: 'type_alias', name: nameNode.text, signature: oneLine(node.text, 160), doc: kdoc(node), modifiers: mods, exported: !mods.includes('private') };
      }
    }
    return null;
  },

  imports(node): Import[] | null {
    if (node.type !== 'import_header') return null;
    const line = node.startPosition.row + 1;
    const id = named(node).find((c) => c.type === 'identifier');
    if (!id) return [];
    const full = id.text;
    const star = named(node).some((c) => c.type === 'wildcard_import');
    if (star) return [{ source: full, names: [], namespace: true, alias: '', kind: 'static', line }];
    const aliasNode = named(node).find((c) => c.type === 'import_alias');
    const alias = aliasNode ? (named(aliasNode)[0]?.text ?? '') : '';
    const last = full.slice(full.lastIndexOf('.') + 1);
    return [{ source: full, names: [{ name: last, alias: alias || last }], namespace: false, alias: '', kind: 'static', line }];
  },

  references(node, ctx) {
    switch (node.type) {
      case 'call_expression': {
        const { callee, args, lambda } = callParts(node);
        if (!callee) return;
        const arity = named(args).length + (lambda ? 1 : 0);
        if (callee.type === 'simple_identifier') {
          const name = callee.text;
          if (KTOR_VERBS.has(name) && !ctx.inTest) {
            const path = stringContent(named(args)[0]);
            const parentSuffix = node.parent?.type === 'call_expression' && named(node.parent)[0]?.equals(node) ? named(node.parent).find((c) => c.type === 'call_suffix') : null;
            const trailing = lambda || (parentSuffix && named(parentSuffix).some((c) => c.type === 'annotated_lambda'));
            if (path !== null && path.startsWith('/') && trailing) {
              const method = name === 'route' ? 'USE' : name === 'webSocket' ? 'WS' : name.toUpperCase();
              emitRoutes(ctx, [{ method, path }], enclosingFunctionName(ctx), node);
            }
          }
          ctx.emitRef({ kind: looksLikeType(name) ? 'new' : 'call', name, arity }, callee);
        } else if (callee.type === 'navigation_expression') {
          const cs = named(callee);
          const suffix = cs.find((c) => c.type === 'navigation_suffix');
          const nm = named(suffix)[0];
          const q = cs[0] && cs[0] !== suffix ? cs[0].text : '';
          if (nm) {
            if (q === 'System' && nm.text === 'getenv') {
              const s = stringContent(named(args)[0]);
              if (s) ctx.emitRef({ kind: 'config', name: s }, named(args)[0]!);
            }
            ctx.emitRef({ kind: 'call', name: nm.text, qualifier: q, arity }, nm);
          }
        }
        return;
      }
      case 'navigation_expression': {
        // property access `Foo.BAR` / `this.x`; member calls are handled by call_expression
        const p = node.parent;
        if (p?.type === 'call_expression' && named(p)[0]?.equals(node)) return;
        const cs = named(node);
        const suffix = cs.find((c) => c.type === 'navigation_suffix');
        const nm = named(suffix)[0];
        const q = cs[0];
        if (nm && q && q !== suffix && (q.type === 'this_expression' || q.type === 'super_expression' || (q.type === 'simple_identifier' && /^[A-Z]/.test(q.text)))) {
          ctx.emitRef({ kind: 'value', name: nm.text, qualifier: q.text }, nm);
        }
        return;
      }
      case 'callable_reference': {
        const parts = named(node);
        const last = parts[parts.length - 1];
        if (!last) return true;
        const q = parts.length > 1 ? parts[0]!.text : '';
        if (!q && /^[A-Z]/.test(last.text)) ctx.emitRef({ kind: 'new', name: last.text }, last);
        else ctx.emitRef({ kind: 'value', name: last.text, qualifier: q }, last);
        return true;
      }
      case 'annotation': {
        const ci = named(node).find((c) => c.type === 'constructor_invocation');
        const ut = ci ? named(ci).find((c) => c.type === 'user_type') : named(node).find((c) => c.type === 'user_type');
        if (ut) {
          const full = ut.text.replace(/<.*$/, '');
          ctx.emitRef({ kind: 'decorator', name: simpleTypeName(full), qualifier: full.includes('.') ? full.slice(0, full.lastIndexOf('.')) : '' }, ut);
          if (simpleTypeName(full) === 'Value') {
            const m = ci?.text.match(/"\\?\$\{([^}:]+)/);
            if (m) ctx.emitRef({ kind: 'config', name: m[1]!.trim() }, node);
          }
        }
        return true;
      }
      case 'user_type': {
        const ids = named(node).filter((c) => c.type === 'type_identifier');
        const last = ids[ids.length - 1];
        if (last) ctx.emitRef({ kind: 'type', name: last.text, qualifier: ids.slice(0, -1).map((c) => c.text).join('.') }, last);
        return; // descend into type_arguments
      }
      case 'delegation_specifier': {
        if (node.parent?.type === 'object_literal') {
          const inner = named(node)[0];
          const ut = inner?.type === 'constructor_invocation' ? named(inner).find((c) => c.type === 'user_type') : inner;
          if (ut) ctx.emitRef({ kind: inner?.type === 'constructor_invocation' ? 'new' : 'type', name: simpleTypeName(ut.text) }, ut);
        }
        return true; // supertypes are emitted by the walker for declarations
      }
      case 'parameter': {
        const nm = named(node).find((c) => c.type === 'simple_identifier');
        const t = typeChild(node);
        if (nm && t) ctx.emitLocalType({ name: nm.text, type: simpleTypeName(t.text), via: 'annotation' });
        return;
      }
      case 'variable_declaration': {
        // lambda / for-loop bindings with an explicit type
        if (node.parent?.type === 'property_declaration') return;
        const nm = named(node)[0];
        const t = typeChild(node);
        if (nm?.type === 'simple_identifier' && t) ctx.emitLocalType({ name: nm.text, type: simpleTypeName(t.text), via: 'annotation' });
        return;
      }
      case 'type_parameters':
      case 'package_header':
        return true;
      case 'simple_identifier': {
        // bare name in value position: call argument (`register("x", handler)`, `f(name = handler)`)
        const p = node.parent;
        if (p?.type === 'value_argument') {
          const last = named(p)[named(p).length - 1];
          if (last?.id === node.id && !/^(this|null|true|false|it)$/.test(node.text)) ctx.emitRef({ kind: 'value', name: node.text }, node);
        }
        return;
      }
    }
    return;
  },

  resolveModule(source, fromPath, imp, project) {
    return jvmResolveModule(source, fromPath, imp, project, '.kt');
  },
};
