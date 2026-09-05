import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, simpleTypeName, precedingComments, named, kids } from '../parse/walk.js';

const COMMENTS = new Set(['comment']);
const HTTP_ATTRS: Record<string, string> = { HttpGet: 'GET', HttpPost: 'POST', HttpPut: 'PUT', HttpDelete: 'DELETE', HttpPatch: 'PATCH', HttpHead: 'HEAD', HttpOptions: 'OPTIONS' };
const MAP_METHODS: Record<string, string> = { MapGet: 'GET', MapPost: 'POST', MapPut: 'PUT', MapDelete: 'DELETE', MapPatch: 'PATCH', Map: 'ANY', MapMethods: 'ANY', MapFallback: 'ANY' };
const TEST_ATTRS: Record<string, string> = { Fact: 'xunit', Theory: 'xunit', SkippableFact: 'xunit', Test: 'nunit', TestCase: 'nunit', TestCaseSource: 'nunit', TestMethod: 'mstest', DataTestMethod: 'mstest' };
const EXPORT_MODS = new Set(['public', 'internal', 'protected']);
const TYPE_KEYWORDS: Record<string, string> = { class_declaration: 'class', interface_declaration: 'interface', struct_declaration: 'struct', record_declaration: 'record', enum_declaration: 'enum' };
/** Identifiers that are never meaningful method-group/delegate values when passed as an argument. */
const CSHARP_VALUE_SKIP = new Set(['this', 'base', 'null', 'true', 'false', 'var']);

interface Attr {
  name: string;
  full: string;
  node: Node;
  args: Node | null;
}

function modifiersOf(node: Node): string[] {
  return kids(node)
    .filter((c) => c.type === 'modifier')
    .map((c) => c.text);
}

function attributesOf(node: Node | null): Attr[] {
  const out: Attr[] = [];
  for (const al of kids(node)) {
    if (al.type !== 'attribute_list') continue;
    for (const a of named(al)) {
      if (a.type !== 'attribute') continue;
      const full = a.childForFieldName('name')?.text ?? '';
      out.push({ name: simpleTypeName(full), full, node: a, args: named(a).find((c) => c.type === 'attribute_argument_list') ?? null });
    }
  }
  return out;
}

function stringValue(n: Node | null | undefined): string | null {
  if (!n) return null;
  if (n.type === 'string_literal' || n.type === 'verbatim_string_literal' || n.type === 'raw_string_literal') {
    return n.text.replace(/^[@$]*"+/, '').replace(/"+$/, '');
  }
  return null;
}

function attrString(a: Attr): string | null {
  for (const arg of named(a.args)) {
    if (arg.type !== 'attribute_argument') continue;
    if (arg.childForFieldName('name')) continue; // Name = "..." named argument
    return stringValue(named(arg)[0]);
  }
  return null;
}

/** Preceding `///` XML doc comment reduced to plain text (the <summary> body when present). */
function xmlDoc(node: Node): string {
  const raw = precedingComments(node, COMMENTS);
  if (!raw) return '';
  const m = raw.match(/<summary>([\s\S]*?)<\/summary>/);
  const body = m ? m[1]! : raw;
  return body
    .replace(/<(?:see|seealso)\s+cref="[A-Z]?:?([^"]*)"\s*\/>/g, '$1')
    .replace(/<(?:paramref|typeparamref)\s+name="([^"]*)"\s*\/>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function isTopLevelDecl(node: Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (p.type === 'compilation_unit') return true;
  return p.type === 'declaration_list' && (p.parent?.type === 'namespace_declaration' || p.parent?.type === 'file_scoped_namespace_declaration');
}

function exportedOf(mods: string[], node: Node, ctx: WalkContext): boolean {
  if (mods.includes('private')) return false;
  if (mods.some((m) => EXPORT_MODS.has(m))) return true;
  if (isTopLevelDecl(node)) return true; // default accessibility for top-level types is internal
  const sk = ctx.scopeDef?.kind;
  return sk === 'interface' || sk === 'enum';
}

/** Container prefix for top-level declarations under a file-scoped namespace (`namespace X.Y;`). */
function fileScopedContainer(node: Node): string | undefined {
  const p = node.parent;
  if (!p || p.type !== 'compilation_unit') return undefined;
  const ns = kids(p).find((c) => c.type === 'file_scoped_namespace_declaration');
  const n = ns?.childForFieldName('name')?.text;
  return n || undefined;
}

/** Emit `type` references for every named type inside a type expression. */
function emitTypeRefs(t: Node | null | undefined, ctx: WalkContext): void {
  if (!t) return;
  const stack: Node[] = [t];
  while (stack.length) {
    const n = stack.pop()!;
    switch (n.type) {
      case 'identifier':
        ctx.emitRef({ kind: 'type', name: n.text }, n);
        break;
      case 'generic_name': {
        const id = named(n)[0];
        if (id?.type === 'identifier') ctx.emitRef({ kind: 'type', name: id.text }, id);
        const ta = named(n).find((c) => c.type === 'type_argument_list');
        if (ta) stack.push(ta);
        break;
      }
      case 'qualified_name': {
        const nm = n.childForFieldName('name');
        const q = n.childForFieldName('qualifier')?.text ?? '';
        if (!nm) break;
        if (nm.type === 'generic_name') {
          const id = named(nm)[0];
          if (id) ctx.emitRef({ kind: 'type', name: id.text, qualifier: q }, id);
          const ta = named(nm).find((c) => c.type === 'type_argument_list');
          if (ta) stack.push(ta);
        } else ctx.emitRef({ kind: 'type', name: nm.text, qualifier: q }, nm);
        break;
      }
      case 'alias_qualified_name': {
        const nm = n.childForFieldName('name');
        if (nm) stack.push(nm);
        break;
      }
      case 'tuple_element': {
        const tt = n.childForFieldName('type');
        if (tt) stack.push(tt);
        break;
      }
      case 'predefined_type':
      case 'implicit_type':
      case 'array_rank_specifier':
        break;
      default:
        for (const c of named(n)) stack.push(c);
    }
  }
}

/** Head type name of a type expression (`List<T>` -> List, `Ns.Foo` -> Foo with qualifier). */
function typeHead(t: Node): { name: string; qualifier: string } {
  switch (t.type) {
    case 'qualified_name': {
      const nm = t.childForFieldName('name');
      return { name: nm ? typeHead(nm).name : '', qualifier: t.childForFieldName('qualifier')?.text ?? '' };
    }
    case 'generic_name':
      return { name: named(t)[0]?.text ?? '', qualifier: '' };
    case 'nullable_type':
    case 'array_type':
    case 'pointer_type':
    case 'ref_type': {
      const inner = t.childForFieldName('type') ?? named(t)[0];
      return inner ? typeHead(inner) : { name: '', qualifier: '' };
    }
    case 'alias_qualified_name': {
      const nm = t.childForFieldName('name');
      return nm ? typeHead(nm) : { name: '', qualifier: '' };
    }
    default:
      return { name: simpleTypeName(t.text), qualifier: '' };
  }
}

function isImplicit(t: Node | null | undefined): boolean {
  return !t || t.type === 'implicit_type' || t.text === 'var';
}

function baseTypes(base: Node | null | undefined, kind: DefSpec['kind']): NonNullable<DefSpec['supertypes']> {
  const out: NonNullable<DefSpec['supertypes']> = [];
  for (const c of named(base)) {
    let t = c;
    if (c.type === 'primary_constructor_base_type') t = c.childForFieldName('type') ?? named(c)[0] ?? c;
    if (t.type === 'argument_list') continue;
    const text = t.text.replace(/<[\s\S]*$/, '').trim();
    if (!text) continue;
    const simple = simpleTypeName(text);
    const k: 'extends' | 'implements' = kind === 'interface' ? 'extends' : /^I[A-Z]/.test(simple) ? 'implements' : 'extends';
    out.push({ name: text, kind: k });
  }
  return out;
}

/** ASP.NET attribute routes on a controller action. */
function emitAttrRoutes(node: Node, name: string, ctx: WalkContext): void {
  if (ctx.inTest) return;
  const attrs = attributesOf(node);
  const http = attrs.filter((a) => HTTP_ATTRS[a.name]);
  const route = attrs.find((a) => a.name === 'Route');
  if (!http.length && !route) return;
  const cls = node.parent?.parent ?? null; // declaration_list -> class_declaration
  let prefix = '';
  let clsName = '';
  if (cls && cls.type === 'class_declaration') {
    clsName = cls.childForFieldName('name')?.text ?? '';
    const cr = attributesOf(cls).find((a) => a.name === 'Route');
    prefix = cr ? (attrString(cr) ?? '') : '';
  }
  const subst = (p: string) => p.replace(/\[controller\]/gi, clsName.replace(/Controller$/, '')).replace(/\[action\]/gi, name);
  const build = (own: string | null): string => {
    const parts = (own && /^[~/]/.test(own) ? [own.replace(/^~/, '')] : [prefix, own ?? '']).map(subst).map((s) => s.replace(/^\/+|\/+$/g, '')).filter(Boolean);
    return '/' + parts.join('/');
  };
  if (http.length) {
    for (const h of http) {
      const own = attrString(h) ?? (route ? attrString(route) : null);
      const path = build(own);
      const method = HTTP_ATTRS[h.name]!;
      ctx.emitDef({ kind: 'route', name: `${method} ${path}`, signature: `${method} ${path}`, meta: { method, path, handler: name } }, h.node, -1);
    }
  } else if (route) {
    const path = build(attrString(route));
    ctx.emitDef({ kind: 'route', name: `ANY ${path}`, signature: `ANY ${path}`, meta: { method: 'ANY', path, handler: name } }, route.node, -1);
  }
}

function typeDecl(node: Node, ctx: WalkContext): DefSpec | null {
  const name = node.childForFieldName('name')?.text ?? '';
  if (!name) return null;
  const keyword = TYPE_KEYWORDS[node.type] ?? 'class';
  let kind: DefSpec['kind'] = 'class';
  if (node.type === 'interface_declaration') kind = 'interface';
  else if (node.type === 'struct_declaration') kind = 'struct';
  else if (node.type === 'enum_declaration') kind = 'enum';
  const mods = modifiersOf(node);
  const tp = kids(node).find((c) => c.type === 'type_parameter_list')?.text ?? '';
  const base = kids(node).find((c) => c.type === 'base_list');
  const params = kids(node).find((c) => c.type === 'parameter_list')?.text ?? '';
  const meta: NonNullable<DefSpec['meta']> = {};
  if (node.type === 'record_declaration') {
    meta.record = true;
    if (kids(node).some((c) => c.type === 'struct')) meta.struct = true;
  }
  const kw = node.type === 'record_declaration' && meta.struct ? 'record struct' : keyword;
  return {
    kind,
    name,
    body: node.childForFieldName('body'),
    signature: oneLine(`${mods.join(' ')}${mods.length ? ' ' : ''}${kw} ${name}${tp}${params}${base ? ' ' + base.text : ''}`),
    doc: xmlDoc(node),
    modifiers: mods,
    exported: exportedOf(mods, node, ctx),
    supertypes: baseTypes(base, kind),
    container: fileScopedContainer(node),
    meta: Object.keys(meta).length ? meta : undefined,
  };
}

function callableDecl(node: Node, ctx: WalkContext): DefSpec | null {
  const nameNode = node.childForFieldName('name');
  let name = nameNode?.text ?? '';
  const mods = modifiersOf(node);
  const params = node.childForFieldName('parameters')?.text ?? '()';
  const tp = kids(node).find((c) => c.type === 'type_parameter_list')?.text ?? '';
  const returns = node.childForFieldName('returns') ?? node.childForFieldName('type');
  let kind: DefSpec['kind'] = 'method';
  const meta: NonNullable<DefSpec['meta']> = {};
  switch (node.type) {
    case 'constructor_declaration':
      kind = 'constructor';
      break;
    case 'destructor_declaration':
      name = `~${name}`;
      break;
    case 'operator_declaration':
      name = `operator${node.childForFieldName('operator')?.text ?? ''}`;
      break;
    case 'conversion_operator_declaration':
      name = `operator ${node.childForFieldName('type')?.text ?? ''}`;
      break;
    case 'local_function_statement':
      kind = 'function';
      break;
    case 'method_declaration': {
      kind = ctx.inClass ? 'method' : 'function';
      for (const a of attributesOf(node)) {
        const fw = TEST_ATTRS[a.name];
        if (fw) {
          kind = 'test';
          meta.framework = fw;
          break;
        }
      }
      if (kind !== 'test') emitAttrRoutes(node, name, ctx);
      break;
    }
  }
  if (!name) return null;
  const explicitIface = kids(node).find((c) => c.type === 'explicit_interface_specifier');
  if (explicitIface) meta.explicit_interface = explicitIface.text.replace(/\.$/, '');
  const signature = oneLine(`${mods.join(' ')}${mods.length ? ' ' : ''}${returns ? returns.text + ' ' : ''}${name}${tp}${params}`);
  const exported = kind === 'test' ? false : node.type === 'local_function_statement' ? node.parent?.type === 'global_statement' : exportedOf(mods, node, ctx);
  return { kind, name, body: node.childForFieldName('body'), signature, doc: xmlDoc(node), modifiers: mods, exported, meta: Object.keys(meta).length ? meta : undefined };
}

function declaratorDef(node: Node, ctx: WalkContext): DefSpec | null {
  const decl = node.parent; // variable_declaration
  const owner = decl?.parent; // field_declaration | event_field_declaration | local_declaration_statement
  if (!decl || !owner) return null;
  const nameNode = node.childForFieldName('name');
  const name = nameNode?.text ?? '';
  if (!name) return null;
  const typeNode = decl.childForFieldName('type');
  const init = named(node).find((c) => !c.equals(nameNode!));
  let declaredType = !isImplicit(typeNode) && typeNode ? typeHead(typeNode).name || undefined : undefined;
  if (!declaredType && init?.type === 'object_creation_expression') {
    const t = init.childForFieldName('type');
    if (t) declaredType = typeHead(t).name || undefined;
  }
  const mods = modifiersOf(owner);
  const isConst = mods.includes('const') || kids(owner).some((c) => c.type === 'const');
  let kind: DefSpec['kind'];
  let exported: boolean;
  if (owner.type === 'field_declaration' || owner.type === 'event_field_declaration') {
    kind = isConst ? 'constant' : 'field';
    if (owner.type === 'event_field_declaration') mods.push('event');
    exported = exportedOf(mods, owner, ctx);
  } else if (owner.type === 'local_declaration_statement' && owner.parent?.type === 'global_statement') {
    kind = isConst ? 'constant' : 'variable';
    exported = true;
  } else return null;
  const typeText = typeNode?.text ?? '';
  const signature = oneLine(`${mods.join(' ')}${mods.length ? ' ' : ''}${typeText ? typeText + ' ' : ''}${name}${init ? ' = ' + init.text : ''}`, 160);
  return { kind, name, signature, doc: xmlDoc(owner), modifiers: mods, exported, declaredType };
}

function minimalApiRoute(node: Node, fn: Node, nameNode: Node, args: Node | null, ctx: WalkContext): void {
  const verb = MAP_METHODS[nameNode.text];
  if (!verb || ctx.inTest) return;
  const a = named(args);
  const path = stringValue(named(a[0])[0]);
  if (path === null || !path.startsWith('/')) return;
  const handlerNode = named(a[1])[0];
  const handler = handlerNode && (handlerNode.type === 'identifier' || handlerNode.type === 'member_access_expression') ? handlerNode.text : '';
  ctx.emitDef({ kind: 'route', name: `${verb} ${path}`, signature: `${verb} ${path}`, meta: { method: verb, path, handler } }, node, -1);
  void fn;
}

export const csharp: LanguageSupport = {
  id: 'csharp',
  grammar: 'c_sharp',
  extensions: ['.cs'],
  classLike: new Set(['class_declaration', 'interface_declaration', 'struct_declaration', 'record_declaration', 'enum_declaration']),
  skip: new Set(['comment', 'string_literal', 'verbatim_string_literal', 'raw_string_literal', 'character_literal', 'preproc_region', 'preproc_endregion']),

  isTestFile(path) {
    return /(^|\/)tests?\//i.test(path) || /Tests?\.cs$/.test(path);
  },

  doc(node) {
    return xmlDoc(node);
  },

  definition(node, ctx): DefSpec | null {
    switch (node.type) {
      case 'namespace_declaration':
      case 'file_scoped_namespace_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        return { kind: 'namespace', name, body: node.childForFieldName('body'), signature: `namespace ${name}`, doc: xmlDoc(node), exported: true };
      }
      case 'class_declaration':
      case 'interface_declaration':
      case 'struct_declaration':
      case 'record_declaration':
      case 'enum_declaration':
        return typeDecl(node, ctx);
      case 'enum_member_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        return { kind: 'enum_member', name, signature: oneLine(node.text, 80), doc: xmlDoc(node), exported: true };
      }
      case 'delegate_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const mods = modifiersOf(node);
        return { kind: 'type_alias', name, signature: oneLine(`${mods.join(' ')}${mods.length ? ' ' : ''}delegate ${node.childForFieldName('type')?.text ?? ''} ${name}${node.childForFieldName('parameters')?.text ?? '()'}`), doc: xmlDoc(node), modifiers: mods, exported: exportedOf(mods, node, ctx), container: fileScopedContainer(node), meta: { delegate: true } };
      }
      case 'method_declaration':
      case 'constructor_declaration':
      case 'destructor_declaration':
      case 'operator_declaration':
      case 'conversion_operator_declaration':
      case 'local_function_statement':
        return callableDecl(node, ctx);
      case 'property_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const mods = modifiersOf(node);
        const t = node.childForFieldName('type');
        const acc = node.childForFieldName('accessors');
        const value = node.childForFieldName('value');
        const tail = acc ? ' ' + oneLine(acc.text, 60) : value?.type === 'arrow_expression_clause' ? ' ' + oneLine(value.text, 60) : '';
        return { kind: 'property', name, signature: oneLine(`${mods.join(' ')}${mods.length ? ' ' : ''}${t?.text ?? ''} ${name}${tail}`), doc: xmlDoc(node), modifiers: mods, exported: exportedOf(mods, node, ctx), declaredType: t ? typeHead(t).name || undefined : undefined };
      }
      case 'indexer_declaration': {
        const mods = modifiersOf(node);
        const t = node.childForFieldName('type');
        return { kind: 'property', name: 'this[]', signature: oneLine(`${mods.join(' ')}${mods.length ? ' ' : ''}${t?.text ?? ''} this${node.childForFieldName('parameters')?.text ?? '[]'}`), doc: xmlDoc(node), modifiers: mods, exported: exportedOf(mods, node, ctx), declaredType: t ? typeHead(t).name || undefined : undefined };
      }
      case 'event_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const mods = [...modifiersOf(node), 'event'];
        const t = node.childForFieldName('type');
        return { kind: 'field', name, signature: oneLine(`${mods.join(' ')} ${t?.text ?? ''} ${name}`), doc: xmlDoc(node), modifiers: mods, exported: exportedOf(mods, node, ctx), declaredType: t ? typeHead(t).name || undefined : undefined };
      }
      case 'variable_declarator':
        return declaratorDef(node, ctx);
      case 'parameter': {
        // primary constructor parameters: `record Person(string Name)` / `class Foo(int x)`
        const list = node.parent;
        const owner = list?.parent;
        if (!list || list.type !== 'parameter_list' || !owner || !(owner.type === 'record_declaration' || owner.type === 'class_declaration' || owner.type === 'struct_declaration')) return null;
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const t = node.childForFieldName('type');
        return { kind: 'field', name, signature: oneLine(node.text, 120), modifiers: ['primary_constructor'], exported: owner.type === 'record_declaration', declaredType: t ? typeHead(t).name || undefined : undefined, meta: { primary_constructor: true } };
      }
    }
    return null;
  },

  imports(node): Import[] | null {
    if (node.type !== 'using_directive') return null;
    const line = node.startPosition.row + 1;
    const alias = node.childForFieldName('name')?.text ?? '';
    const aliasNode = node.childForFieldName('name');
    const target = named(node)
      .filter((c) => c !== aliasNode && (c.type === 'identifier' || c.type === 'qualified_name' || c.type === 'alias_qualified_name' || c.type === 'generic_name'))
      .pop();
    if (!target) return [];
    const src = target.text.replace(/\s+/g, '');
    // `global using` is visible to the whole project: flagged as a reexport for the resolver.
    const kind: Import['kind'] = /^\s*global\b/.test(node.text) ? 'reexport' : 'static';
    if (/^\s*(?:global\s+)?using\s+static\b/.test(node.text)) {
      // `using static X.Y.Z` binds Z's members: modelled as the name `Z` imported from namespace `X.Y`.
      const dot = src.lastIndexOf('.');
      return [{ source: dot > 0 ? src.slice(0, dot) : '', names: [{ name: dot > 0 ? src.slice(dot + 1) : src, alias: '' }], namespace: false, alias: '', kind, line }];
    }
    return [{ source: src, names: [], namespace: true, alias, kind, line }];
  },

  references(node, ctx) {
    switch (node.type) {
      case 'invocation_expression': {
        const fn = node.childForFieldName('function');
        const args = node.childForFieldName('arguments');
        const arity = named(args).length;
        if (!fn) return;
        const first = named(named(args)[0])[0];
        if (fn.type === 'identifier') ctx.emitRef({ kind: 'call', name: fn.text, arity }, fn);
        else if (fn.type === 'generic_name') {
          const id = named(fn)[0];
          if (id) ctx.emitRef({ kind: 'call', name: id.text, arity }, id);
          emitTypeRefs(named(fn).find((c) => c.type === 'type_argument_list'), ctx);
        } else if (fn.type === 'member_access_expression') {
          const nm = fn.childForFieldName('name');
          if (!nm) return;
          const qualNode = fn.childForFieldName('expression') ?? kids(fn)[0];
          let q = qualNode && qualNode !== nm ? qualNode.text : '';
          if (q === 'base') q = 'super';
          const nameNode = nm.type === 'generic_name' ? (named(nm)[0] ?? nm) : nm;
          if (q === 'Environment' && nameNode.text === 'GetEnvironmentVariable') {
            const v = stringValue(first);
            if (v) ctx.emitRef({ kind: 'config', name: v }, first!);
          }
          minimalApiRoute(node, fn, nameNode, args, ctx);
          ctx.emitRef({ kind: 'call', name: nameNode.text, qualifier: q, arity }, nameNode);
          if (nm.type === 'generic_name') emitTypeRefs(named(nm).find((c) => c.type === 'type_argument_list'), ctx);
        } else if (fn.type === 'conditional_access_expression') {
          const cond = fn.childForFieldName('condition');
          const bind = named(fn).find((c) => c.type === 'member_binding_expression');
          const nm = bind?.childForFieldName('name');
          if (nm) ctx.emitRef({ kind: 'call', name: nm.text, qualifier: cond?.text ?? '', arity }, nm);
        }
        return;
      }
      case 'object_creation_expression': {
        const t = node.childForFieldName('type');
        if (!t) return;
        const { name, qualifier } = typeHead(t);
        if (name) ctx.emitRef({ kind: 'new', name, qualifier, arity: named(node.childForFieldName('arguments')).length }, t);
        // generic arguments are type references
        const ta = t.type === 'generic_name' ? named(t).find((c) => c.type === 'type_argument_list') : null;
        if (ta) emitTypeRefs(ta, ctx);
        return;
      }
      case 'implicit_object_creation_expression': {
        // `T x = new();` / `T Prop { get; } = new();`
        const p = node.parent;
        let t: Node | null = null;
        if (p?.type === 'variable_declarator') t = p.parent?.childForFieldName('type') ?? null;
        else if (p?.type === 'equals_value_clause' || p?.parent?.type === 'property_declaration') t = (p.parent ?? p).childForFieldName('type');
        else if (p?.type === 'property_declaration') t = p.childForFieldName('type');
        if (t && !isImplicit(t)) {
          const { name, qualifier } = typeHead(t);
          if (name) ctx.emitRef({ kind: 'new', name, qualifier, arity: named(named(node).find((c) => c.type === 'argument_list')).length }, node);
        }
        return;
      }
      case 'attribute': {
        const nm = node.childForFieldName('name');
        if (nm) ctx.emitRef({ kind: 'decorator', name: simpleTypeName(nm.text), qualifier: nm.text.includes('.') ? nm.text.slice(0, nm.text.lastIndexOf('.')) : '' }, nm);
        return;
      }
      case 'parameter': {
        const t = node.childForFieldName('type');
        const nm = node.childForFieldName('name');
        if (t && !isImplicit(t)) {
          emitTypeRefs(t, ctx);
          const head = typeHead(t).name;
          if (nm && head) ctx.emitLocalType({ name: nm.text, type: head, via: 'annotation' });
        }
        return;
      }
      case 'variable_declaration': {
        const t = node.childForFieldName('type');
        if (!isImplicit(t)) emitTypeRefs(t, ctx);
        return;
      }
      case 'variable_declarator': {
        const decl = node.parent;
        const owner = decl?.parent;
        if (!decl || !owner) return;
        if (owner.type === 'field_declaration' || owner.type === 'event_field_declaration' || owner.parent?.type === 'global_statement') return; // definitions carry declaredType
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return;
        const t = decl.childForFieldName('type');
        const init = named(node).find((c) => !c.equals(nameNode));
        if (t && !isImplicit(t)) {
          const head = typeHead(t).name;
          if (head) ctx.emitLocalType({ name: nameNode.text, type: head, via: 'annotation' });
        } else if (init?.type === 'object_creation_expression') {
          const ct = init.childForFieldName('type');
          const head = ct ? typeHead(ct).name : '';
          if (head) ctx.emitLocalType({ name: nameNode.text, type: head, via: 'new' });
        }
        return;
      }
      case 'method_declaration':
      case 'local_function_statement':
      case 'delegate_declaration':
      case 'operator_declaration':
      case 'conversion_operator_declaration':
        emitTypeRefs(node.childForFieldName('returns') ?? node.childForFieldName('type'), ctx);
        return;
      case 'property_declaration':
      case 'event_declaration':
      case 'indexer_declaration':
      case 'typeof_expression':
      case 'default_expression':
      case 'cast_expression':
      case 'array_creation_expression':
      case 'sizeof_expression':
      case 'type_pattern':
        emitTypeRefs(node.childForFieldName('type'), ctx);
        return;
      case 'as_expression':
      case 'is_expression':
        emitTypeRefs(node.childForFieldName('right'), ctx);
        return;
      case 'declaration_pattern':
      case 'catch_declaration': {
        const t = node.childForFieldName('type');
        const nm = node.childForFieldName('name');
        emitTypeRefs(t, ctx);
        if (t && nm) {
          const head = typeHead(t).name;
          if (head) ctx.emitLocalType({ name: nm.text, type: head, via: 'annotation' });
        }
        return;
      }
      case 'foreach_statement': {
        const t = node.childForFieldName('type');
        const left = node.childForFieldName('left');
        if (t && !isImplicit(t)) {
          emitTypeRefs(t, ctx);
          const head = typeHead(t).name;
          if (left?.type === 'identifier' && head) ctx.emitLocalType({ name: left.text, type: head, via: 'annotation' });
        }
        return;
      }
      case 'assignment_expression': {
        // this.x = new T();
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (left?.type === 'member_access_expression' && right?.type === 'object_creation_expression') {
          const t = right.childForFieldName('type');
          const head = t ? typeHead(t).name : '';
          if (head && left.text.startsWith('this.')) ctx.emitLocalType({ name: left.text, type: head, via: 'field' });
        }
        return;
      }
      case 'element_access_expression': {
        // Configuration["Key"] / builder.Configuration["Key"]
        const e = node.childForFieldName('expression');
        if (e && /(^|\.)Configuration$/.test(e.text)) {
          const sub = node.childForFieldName('subscript');
          const v = stringValue(named(named(sub)[0])[0]);
          if (v) ctx.emitRef({ kind: 'config', name: v }, sub ?? node);
        }
        return;
      }
      case 'identifier': {
        // handler passed by name: app.MapPost("/x", CreateUser); Bar(name: callback); a delegate
        // or method group sitting in an array/collection initializer element.
        if (CSHARP_VALUE_SKIP.has(node.text)) return;
        const p = node.parent;
        if (!p) return;
        if (p.type === 'argument') {
          const nc = named(p);
          if (nc[nc.length - 1]?.id === node.id) ctx.emitRef({ kind: 'value', name: node.text }, node);
        } else if (p.type === 'initializer_expression' || p.type === 'array_creation_expression') {
          ctx.emitRef({ kind: 'value', name: node.text }, node);
        }
        return;
      }
      case 'base_list':
      case 'type_parameter_constraints_clause':
      case 'using_directive':
        return true;
    }
    return;
  },

  resolveModule() {
    // C# namespaces do not map to files; cross-file binding relies on the unique-global tier
    // and namespace-aware resolution in the resolver.
    return [];
  },
};
