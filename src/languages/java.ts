import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext, ModuleResolutionContext } from './types.js';
import { oneLine, simpleTypeName, precedingComments, named, kids } from '../parse/walk.js';

const COMMENTS = new Set(['block_comment', 'line_comment']);
const TEST_ANNOTATIONS = new Set(['Test', 'ParameterizedTest', 'RepeatedTest', 'TestFactory', 'TestTemplate']);
const TYPE_DECLS = new Set(['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration', 'annotation_type_declaration']);
const LEADING = new Set(['modifiers']);
const BODIES = new Set(['class_body', 'interface_body', 'enum_body', 'annotation_type_body', 'block', 'constructor_body']);

// ------------------------------------------------------------------ shared JVM helpers (also used by kotlin.ts / scala.ts)

export const JVM_EXTS = ['.java', '.kt', '.kts', '.scala', '.sc'];

export function isConstantName(n: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(n) && n.length > 1;
}

/** `Foo` / `HttpClient` look like type names; `TODO` / `MAX` do not. */
export function looksLikeType(n: string): boolean {
  return /^[A-Z]/.test(n) && !/^[A-Z0-9_]+$/.test(n);
}

/** Strip a leading `` ` `` / `"` pair. */
export function unquote(s: string): string {
  return s.replace(/^["'`]|["'`]$/g, '');
}

/**
 * One-line signature: text of `node` from after the leading modifier/annotation children up to the body,
 * prefixed with the plain modifier keywords.
 */
export function headerText(node: Node, mods: string[], leading: Set<string>, bodyTypes: Set<string>): string {
  const cs = kids(node);
  let start = 0;
  for (const c of cs) {
    if (!leading.has(c.type)) break;
    start = c.endIndex - node.startIndex;
  }
  const body = node.childForFieldName('body') ?? cs.find((c) => bodyTypes.has(c.type));
  const end = body ? body.startIndex - node.startIndex : node.text.length;
  const s = node.text
    .slice(start, end)
    .trim()
    .replace(/[=;:]\s*$/, '')
    .trim();
  return oneLine(mods.length ? `${mods.join(' ')} ${s}` : s);
}

/** Preceding `/** … *\/` doc comment (or a run of `//` comments) as plain text. */
export function docComment(node: Node, comments: Set<string>): string {
  let n: Node = node;
  // record-component / declarator style defs: the comment sits before the enclosing statement
  while (n.parent && (n.parent.type === 'field_declaration' || n.parent.type === 'constant_declaration' || n.parent.type === 'property_declaration')) n = n.parent;
  const prev = n.previousSibling;
  if (!prev || !comments.has(prev.type)) return '';
  if (prev.text.startsWith('/*') && !prev.text.startsWith('/**')) return '';
  return precedingComments(n, comments);
}

/** Module doc: a leading `/** … *\/` comment that is not a license header. */
export function fileDoc(root: Node, comments: Set<string>): string {
  const first = named(root)[0];
  if (!first || !comments.has(first.type) || !first.text.startsWith('/**')) return '';
  if (/copyright|licen[cs]e/i.test(first.text)) return '';
  return precedingComments(named(root)[1] ?? first, comments) || '';
}

export const SPRING_MAPPINGS: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
  RequestMapping: 'ANY',
};
export const JAXRS_VERBS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

export interface AnnotationInfo {
  /** Simple name (`GetMapping`). */
  name: string;
  /** Raw argument text including parentheses, or ''. */
  args: string;
}

/** Path from annotation arguments: `("/x")`, `(value = "/x")`, `(path = {"/x", "/y"})`, `(value = ["/x"])`. */
export function annotationPath(args: string): string {
  const m = args.match(/\b(?:value|path)\s*=\s*[[{]?\s*"([^"]*)"/) ?? args.match(/^\(\s*[[{]?\s*"([^"]*)"/);
  return m ? m[1]! : '';
}

export function joinRoutePath(prefix: string, path: string): string {
  const p = `${prefix.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`.replace(/\/+/g, '/');
  return p === '' || p === '/' ? '/' : p.replace(/\/$/, '');
}

/** Route prefix declared on a class: `@RequestMapping("/api")` / `@Path("/api")`. */
export function routePrefix(anns: AnnotationInfo[]): string {
  for (const a of anns) if (a.name === 'RequestMapping' || a.name === 'Path') return annotationPath(a.args);
  return '';
}

/** Spring MVC / JAX-RS routes declared by a method's annotations. */
export function routesFromAnnotations(anns: AnnotationInfo[], prefix: string): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  let jaxPath: string | null = null;
  const verbs: string[] = [];
  for (const a of anns) {
    const spring = SPRING_MAPPINGS[a.name];
    if (spring) {
      let method = spring;
      if (a.name === 'RequestMapping') {
        const m = a.args.match(/\bmethod\s*=\s*[[{]?\s*(?:RequestMethod\.)?([A-Z]+)/);
        method = m ? m[1]! : 'ANY';
      }
      out.push({ method, path: joinRoutePath(prefix, annotationPath(a.args)) });
    } else if (a.name === 'Path') jaxPath = annotationPath(a.args);
    else if (JAXRS_VERBS.has(a.name)) verbs.push(a.name);
  }
  for (const v of verbs) out.push({ method: v, path: joinRoutePath(prefix, jaxPath ?? '') });
  return out;
}

export function emitRoutes(ctx: WalkContext, routes: { method: string; path: string }[], handler: string, node: Node) {
  if (ctx.inTest) return;
  for (const r of routes) {
    ctx.emitDef({ kind: 'route', name: `${r.method} ${r.path}`, signature: `${r.method} ${r.path}`, meta: { method: r.method, path: r.path, handler } }, node, -1);
  }
}

/**
 * Candidate files for a JVM import `a.b.C`: `<root>/a/b/C.<ext>` for every source root (closest root first),
 * then the bare package path, then a same-directory file for unqualified (Scala-style relative) imports.
 * Wildcard imports map to `<pkg>/index.<ext>` and are not expected to resolve.
 */
export function jvmResolveModule(source: string, fromPath: string, imp: Import, project: ModuleResolutionContext, preferredExt: string): string[] {
  const exts = [preferredExt, ...JVM_EXTS.filter((e) => e !== preferredExt)];
  const segs = source.split('.').filter(Boolean);
  if (!segs.length) return [];
  const bases: string[] = [];
  if (imp.namespace) bases.push(`${segs.join('/')}/index`);
  else {
    bases.push(segs.join('/'));
    // nested type `a.b.Outer.Inner` -> Outer's file
    if (segs.length >= 2 && /^[A-Z]/.test(segs[segs.length - 2]!)) bases.push(segs.slice(0, -1).join('/'));
  }
  const common = (a: string, b: string) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };
  const roots = [...(project.jvmRoots ?? [])].sort((a, b) => common(b, fromPath) - common(a, fromPath));
  const out: string[] = [];
  for (const b of bases) {
    for (const r of roots) for (const e of exts) out.push(`${r}/${b}${e}`);
    for (const e of exts) out.push(`${b}${e}`);
  }
  // `import Foo._` / `import Foo.bar` where Foo lives in the same package directory
  if (/^[A-Z]/.test(segs[0]!)) {
    const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
    for (const e of exts) out.push(fromDir ? `${fromDir}/${segs[0]}${e}` : `${segs[0]}${e}`);
  }
  return out;
}

// ------------------------------------------------------------------ Java

function modifiersNode(node: Node): Node | null {
  return kids(node).find((c) => c.type === 'modifiers') ?? null;
}

function modifiersOf(node: Node): string[] {
  const m = modifiersNode(node);
  if (!m) return [];
  return kids(m)
    .filter((c) => !c.isNamed)
    .map((c) => c.type);
}

function annotationsOf(node: Node): AnnotationInfo[] {
  const m = modifiersNode(node);
  if (!m) return [];
  const out: AnnotationInfo[] = [];
  for (const a of named(m)) {
    if (a.type !== 'annotation' && a.type !== 'marker_annotation') continue;
    const name = simpleTypeName(a.childForFieldName('name')?.text ?? '');
    out.push({ name, args: a.childForFieldName('arguments')?.text ?? '' });
  }
  return out;
}

function typeListNames(n: Node | null | undefined): string[] {
  if (!n) return [];
  const list = named(n).find((c) => c.type === 'type_list') ?? n;
  return named(list)
    .filter((c) => c.type !== 'type_list')
    .map((c) => c.text);
}

function supertypesOf(node: Node): NonNullable<DefSpec['supertypes']> {
  const out: NonNullable<DefSpec['supertypes']> = [];
  const sc = node.childForFieldName('superclass');
  if (sc) for (const t of named(sc)) out.push({ name: t.text, kind: 'extends' });
  for (const t of typeListNames(node.childForFieldName('interfaces'))) out.push({ name: t, kind: 'implements' });
  const ei = kids(node).find((c) => c.type === 'extends_interfaces');
  for (const t of typeListNames(ei)) out.push({ name: t, kind: 'extends' });
  return out;
}

/** Members of interfaces / annotation types are implicitly public. */
function inInterface(node: Node): boolean {
  const p = node.parent;
  return p?.type === 'interface_body' || p?.type === 'annotation_type_body';
}

function isPublic(node: Node, mods: string[]): boolean {
  return mods.includes('public') || inInterface(node);
}

function javadoc(node: Node): string {
  return docComment(node, COMMENTS);
}

/** Type node for local/param declarations, honouring `var x = new T()`. */
function declaredTypeOf(typeNode: Node | null, value: Node | null): { type: string; via: 'annotation' | 'new' } | null {
  if (typeNode && typeNode.text !== 'var') return { type: simpleTypeName(typeNode.text), via: 'annotation' };
  if (value?.type === 'object_creation_expression') {
    const t = value.childForFieldName('type');
    if (t) return { type: simpleTypeName(t.text), via: 'new' };
  }
  return null;
}

/** Is this type node the `type` of an object_creation_expression (already emitted as a `new` ref)? */
function underNewExpression(n: Node): boolean {
  let p = n.parent;
  if (p?.type === 'generic_type') p = p.parent;
  return p?.type === 'object_creation_expression' && p.childForFieldName('type') !== null && (p.childForFieldName('type')!.equals(n) || p.childForFieldName('type')!.equals(n.parent!));
}

function stringArg(args: Node | null | undefined): Node | null {
  const first = named(args)[0];
  return first?.type === 'string_literal' ? first : null;
}

function stringValue(lit: Node): string {
  return lit.text.replace(/^"""|"""$/g, '').replace(/^"|"$/g, '');
}

export const java: LanguageSupport = {
  id: 'java',
  grammar: 'java',
  extensions: ['.java'],
  classLike: new Set(['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration', 'annotation_type_declaration']),
  skip: new Set(['line_comment', 'block_comment', 'string_literal']),

  isTestFile(path) {
    return /\/src\/test\//.test(path) || /(Test|Tests|IT)\.java$/.test(path);
  },

  doc(node) {
    return javadoc(node);
  },

  moduleDoc(root) {
    return fileDoc(root, COMMENTS);
  },

  definition(node, ctx): DefSpec | null {
    if (TYPE_DECLS.has(node.type)) {
      const name = node.childForFieldName('name')?.text ?? '';
      if (!name) return null;
      const mods = modifiersOf(node);
      const body = node.childForFieldName('body');
      const supertypes = supertypesOf(node);
      let kind: DefSpec['kind'] = 'class';
      const meta: DefSpec['meta'] = {};
      if (node.type === 'interface_declaration') kind = 'interface';
      else if (node.type === 'enum_declaration') kind = 'enum';
      else if (node.type === 'record_declaration') meta.record = true;
      else if (node.type === 'annotation_type_declaration') {
        kind = 'interface';
        meta.annotation = true;
      }
      return {
        kind,
        name,
        body,
        signature: headerText(node, mods, LEADING, BODIES),
        doc: javadoc(node),
        modifiers: mods,
        exported: isPublic(node, mods),
        supertypes,
        meta: Object.keys(meta).length ? meta : undefined,
      };
    }
    switch (node.type) {
      case 'method_declaration':
      case 'annotation_type_element_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const mods = modifiersOf(node);
        const anns = annotationsOf(node);
        let kind: DefSpec['kind'] = 'method';
        const annNames = anns.map((a) => a.name);
        if (annNames.some((a) => TEST_ANNOTATIONS.has(a))) kind = 'test';
        else if (java.isTestFile!(ctx.path) && /^test[A-Z_]/.test(name)) kind = 'test';
        // Spring / JAX-RS routes (class-level prefix + method-level mapping)
        const owner = node.parent?.parent;
        const prefix = owner && TYPE_DECLS.has(owner.type) ? routePrefix(annotationsOf(owner)) : '';
        emitRoutes(ctx, routesFromAnnotations(anns, prefix), name, node);
        const ret = node.childForFieldName('type');
        return {
          kind,
          name,
          body: node.childForFieldName('body'),
          signature: headerText(node, mods, LEADING, BODIES),
          doc: javadoc(node),
          modifiers: mods,
          exported: isPublic(node, mods),
          declaredType: ret && ret.type !== 'void_type' ? simpleTypeName(ret.text) : undefined,
        };
      }
      case 'constructor_declaration':
      case 'compact_constructor_declaration': {
        const name = node.childForFieldName('name')?.text ?? ctx.scopeDef?.name ?? '';
        if (!name) return null;
        const mods = modifiersOf(node);
        return { kind: 'constructor', name, body: node.childForFieldName('body'), signature: headerText(node, mods, LEADING, BODIES), doc: javadoc(node), modifiers: mods, exported: isPublic(node, mods) };
      }
      case 'variable_declarator': {
        const decl = node.parent;
        if (!decl || (decl.type !== 'field_declaration' && decl.type !== 'constant_declaration')) return null;
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const mods = modifiersOf(decl);
        const typeNode = decl.childForFieldName('type');
        const declaredType = typeNode ? simpleTypeName(typeNode.text) : undefined;
        const isConst = decl.type === 'constant_declaration' || inInterface(decl) || (mods.includes('static') && mods.includes('final'));
        const single = named(decl).filter((c) => c.type === 'variable_declarator').length === 1;
        if (declaredType) ctx.emitLocalType({ name, type: declaredType, via: 'field' });
        const value = node.childForFieldName('value');
        const sig = `${mods.length ? mods.join(' ') + ' ' : ''}${typeNode?.text ?? ''} ${name}${value ? ' = ' + value.text : ''}`;
        return {
          kind: isConst ? 'constant' : 'field',
          name,
          signature: oneLine(sig, 160),
          doc: javadoc(decl),
          modifiers: mods,
          exported: isPublic(decl, mods),
          declaredType,
          rangeNode: single ? decl : undefined,
        };
      }
      case 'enum_constant': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        return { kind: 'enum_member', name, body: node.childForFieldName('body'), signature: oneLine(node.text, 80), doc: javadoc(node), exported: true };
      }
      case 'formal_parameter': {
        // record components are fields
        if (node.parent?.type !== 'formal_parameters' || node.parent.parent?.type !== 'record_declaration') return null;
        const name = node.childForFieldName('name')?.text ?? '';
        const t = node.childForFieldName('type');
        if (!name || !t) return null;
        const declaredType = simpleTypeName(t.text);
        ctx.emitLocalType({ name, type: declaredType, via: 'field' });
        return { kind: 'field', name, signature: oneLine(node.text, 80), declaredType, exported: true, modifiers: ['final'] };
      }
    }
    return null;
  },

  imports(node): Import[] | null {
    if (node.type !== 'import_declaration') return null;
    const line = node.startPosition.row + 1;
    const pathNode = named(node).find((c) => c.type === 'scoped_identifier' || c.type === 'identifier');
    if (!pathNode) return [];
    const full = pathNode.text;
    const isStatic = kids(node).some((c) => c.type === 'static');
    const star = named(node).some((c) => c.type === 'asterisk');
    if (star) return [{ source: full, names: [], namespace: true, alias: '', kind: 'static', line }];
    const dot = full.lastIndexOf('.');
    const last = dot >= 0 ? full.slice(dot + 1) : full;
    const source = isStatic && dot >= 0 ? full.slice(0, dot) : full;
    return [{ source, names: [{ name: last, alias: last }], namespace: false, alias: '', kind: 'static', line }];
  },

  references(node, ctx) {
    switch (node.type) {
      case 'method_invocation': {
        const obj = node.childForFieldName('object');
        const nm = node.childForFieldName('name');
        const args = node.childForFieldName('arguments');
        if (!nm) return;
        const arity = named(args).length;
        const q = obj?.text ?? '';
        if (q === 'System' && nm.text === 'getenv') {
          const s = stringArg(args);
          if (s) ctx.emitRef({ kind: 'config', name: stringValue(s) }, s);
        }
        ctx.emitRef({ kind: 'call', name: nm.text, qualifier: q, arity }, nm);
        return;
      }
      case 'object_creation_expression': {
        const t = node.childForFieldName('type');
        const args = node.childForFieldName('arguments');
        if (t) {
          const raw = t.type === 'generic_type' ? (named(t)[0]?.text ?? t.text) : t.text;
          const name = simpleTypeName(raw);
          const q = raw.includes('.') ? raw.slice(0, raw.lastIndexOf('.')) : '';
          ctx.emitRef({ kind: 'new', name, qualifier: q, arity: named(args).length }, t);
        }
        return;
      }
      case 'method_reference': {
        const parts = named(node);
        const first = parts[0];
        if (!first) return true;
        if (node.text.endsWith('::new')) ctx.emitRef({ kind: 'new', name: simpleTypeName(first.text), qualifier: first.text.includes('.') ? first.text.slice(0, first.text.lastIndexOf('.')) : '' }, first);
        else if (parts.length >= 2) ctx.emitRef({ kind: 'value', name: parts[parts.length - 1]!.text, qualifier: first.text }, parts[parts.length - 1]!);
        return true;
      }
      case 'marker_annotation':
      case 'annotation': {
        const nm = node.childForFieldName('name');
        if (!nm) return true;
        const full = nm.text;
        ctx.emitRef({ kind: 'decorator', name: simpleTypeName(full), qualifier: full.includes('.') ? full.slice(0, full.lastIndexOf('.')) : '' }, nm);
        if (simpleTypeName(full) === 'Value') {
          // Spring `@Value("${app.key:default}")`
          const m = node.childForFieldName('arguments')?.text.match(/"\$\{([^}:]+)/);
          if (m) ctx.emitRef({ kind: 'config', name: m[1]!.trim() }, node);
        }
        return true;
      }
      case 'field_access': {
        const obj = node.childForFieldName('object');
        const fld = node.childForFieldName('field');
        if (obj && fld && (obj.type === 'this' || obj.type === 'super' || (obj.type === 'identifier' && /^[A-Z]/.test(obj.text)))) {
          ctx.emitRef({ kind: 'value', name: fld.text, qualifier: obj.text }, fld);
        }
        return;
      }
      case 'type_identifier': {
        if (node.text === 'var' || underNewExpression(node)) return true;
        ctx.emitRef({ kind: 'type', name: node.text }, node);
        return true;
      }
      case 'scoped_type_identifier': {
        if (underNewExpression(node)) return true;
        const parts = named(node).filter((c) => c.type === 'type_identifier' || c.type === 'scoped_type_identifier');
        const last = parts[parts.length - 1];
        if (last) ctx.emitRef({ kind: 'type', name: last.text, qualifier: node.text.slice(0, Math.max(0, node.text.length - last.text.length - 1)) }, last);
        return true;
      }
      case 'formal_parameter':
      case 'spread_parameter':
      case 'enhanced_for_statement': {
        if (node.parent?.parent?.type === 'record_declaration') return; // record component: fact emitted with the field def
        const nameNode = node.childForFieldName('name') ?? named(node).find((c) => c.type === 'variable_declarator')?.childForFieldName('name');
        const t = node.childForFieldName('type') ?? named(node).find((c) => /type$/.test(c.type) || c.type === 'generic_type' || c.type === 'type_identifier');
        if (nameNode && t) {
          const d = declaredTypeOf(t, null);
          if (d) ctx.emitLocalType({ name: nameNode.text, type: d.type, via: 'annotation' });
        }
        return;
      }
      case 'local_variable_declaration': {
        const t = node.childForFieldName('type');
        for (const d of named(node)) {
          if (d.type !== 'variable_declarator') continue;
          const nm = d.childForFieldName('name');
          const dt = declaredTypeOf(t, d.childForFieldName('value'));
          if (nm && dt) ctx.emitLocalType({ name: nm.text, type: dt.type, via: dt.via });
        }
        return;
      }
      case 'superclass':
      case 'super_interfaces':
      case 'extends_interfaces':
      case 'permits':
      case 'type_parameters':
      case 'package_declaration':
        return true;
      case 'identifier': {
        // bare name in value position: call argument or array initializer element
        const p = node.parent;
        if (p && (p.type === 'argument_list' || p.type === 'array_initializer') && !/^(this|super|null|true|false)$/.test(node.text)) ctx.emitRef({ kind: 'value', name: node.text }, node);
        return;
      }
    }
    return;
  },

  resolveModule(source, fromPath, imp, project) {
    return jvmResolveModule(source, fromPath, imp, project, '.java');
  },
};
