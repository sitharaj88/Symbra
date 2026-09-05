import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, simpleTypeName, precedingComments, named, kids } from '../parse/walk.js';

const COMMENTS = new Set(['comment']);
const BUILTIN_TYPES = new Set(['int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'float32', 'float64', 'complex64', 'complex128', 'string', 'bool', 'byte', 'rune', 'error', 'any', 'comparable']);
const BUILTIN_FUNCS = new Set(['append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete', 'imag', 'len', 'make', 'max', 'min', 'new', 'panic', 'print', 'println', 'real', 'recover']);
/** Router method name -> HTTP verb (net/http, gorilla/mux, chi, gin, echo, fiber, httprouter). */
const ROUTE_METHODS: Record<string, string> = {
  Handle: 'ANY', HandleFunc: 'ANY', Any: 'ANY', ANY: 'ANY', All: 'ANY',
  GET: 'GET', POST: 'POST', PUT: 'PUT', DELETE: 'DELETE', PATCH: 'PATCH', OPTIONS: 'OPTIONS', HEAD: 'HEAD', CONNECT: 'CONNECT', TRACE: 'TRACE',
  Get: 'GET', Post: 'POST', Put: 'PUT', Delete: 'DELETE', Patch: 'PATCH', Options: 'OPTIONS', Head: 'HEAD', Connect: 'CONNECT', Trace: 'TRACE',
};
const ENV_FUNCS = new Set(['Getenv', 'LookupEnv']);
const TEST_NAME = /^(Test|Benchmark|Example|Fuzz)(?:[A-Z_0-9]|$)/;
/** Common Go file names tried when an import path maps to a package directory. */
const PACKAGE_FILES = ['doc.go', 'main.go', 'types.go', 'client.go', 'server.go', 'api.go', 'handler.go', 'handlers.go', 'service.go', 'store.go', 'model.go', 'models.go', 'config.go', 'errors.go', 'util.go', 'utils.go', 'helpers.go', 'interfaces.go', 'common.go', 'init.go'];

function isExportedName(name: string): boolean {
  return /^\p{Lu}/u.test(name);
}

function stringValue(n: Node | null | undefined): string | null {
  if (!n) return null;
  if (n.type === 'interpreted_string_literal' || n.type === 'raw_string_literal') return n.text.slice(1, -1);
  return null;
}

/** Strip pointer/paren/generic wrappers and return the named type as written (`*pkg.T[X]` -> `pkg.T`), or '' for slices/maps/funcs. */
function goTypeName(t: Node | null | undefined): string {
  let n: Node | null | undefined = t;
  while (n) {
    switch (n.type) {
      case 'pointer_type':
      case 'parenthesized_type':
        n = named(n)[0];
        continue;
      case 'generic_type':
        n = n.childForFieldName('type');
        continue;
      case 'type_identifier':
        return BUILTIN_TYPES.has(n.text) ? '' : n.text;
      case 'qualified_type':
        return n.text;
      default:
        return '';
    }
  }
  return '';
}

function stripDirectives(doc: string): string {
  return doc
    .split('\n')
    .filter((l) => !/^(go:|\+build|nolint|lint:)/.test(l.trim()))
    .join('\n')
    .trim();
}

/** Doc comment for a declaration: its own preceding comments, else the comments before a single-spec parent declaration. */
function goDoc(node: Node): string {
  const own = precedingComments(node, COMMENTS);
  if (own) return stripDirectives(own);
  let p = node.parent;
  if (p?.type === 'var_spec_list') p = p.parent;
  if (p && /^(type|const|var)_declaration$/.test(p.type) && countSpecs(p) === 1) return stripDirectives(precedingComments(p, COMMENTS));
  return '';
}

function countSpecs(decl: Node): number {
  let n = 0;
  for (const c of named(decl)) {
    if (c.type === 'var_spec_list') n += named(c).filter((s) => s.type === 'var_spec').length;
    else if (/_spec$|^type_alias$/.test(c.type)) n++;
  }
  return n;
}

function isTopLevelSpec(node: Node): boolean {
  let p = node.parent;
  if (p?.type === 'var_spec_list') p = p.parent;
  return p?.parent?.type === 'source_file';
}

function namesOf(node: Node): Node[] {
  return node.childrenForFieldName('name').filter((c): c is Node => c !== null);
}

/** Infer a type from an initializer expression: `T{}`, `&T{}`, `new(T)`, `NewT()`, `pkg.NewT()`, `T(x)`. */
function inferType(expr: Node | null | undefined): { type: string; via: 'new' | 'constructor_call' } | null {
  if (!expr) return null;
  if (expr.type === 'unary_expression') return inferType(expr.childForFieldName('operand'));
  if (expr.type === 'composite_literal') {
    const t = goTypeName(expr.childForFieldName('type'));
    return t ? { type: t, via: 'new' } : null;
  }
  if (expr.type === 'type_conversion_expression') {
    const t = goTypeName(expr.childForFieldName('type'));
    return t ? { type: t, via: 'new' } : null;
  }
  if (expr.type === 'call_expression') {
    const fn = expr.childForFieldName('function');
    if (!fn) return null;
    if (fn.type === 'identifier' && fn.text === 'new') {
      const t = goTypeName(named(expr.childForFieldName('arguments'))[0]);
      return t ? { type: t, via: 'new' } : null;
    }
    let callee = '';
    let qual = '';
    if (fn.type === 'identifier') callee = fn.text;
    else if (fn.type === 'selector_expression') {
      callee = fn.childForFieldName('field')?.text ?? '';
      qual = fn.childForFieldName('operand')?.text ?? '';
    }
    const m = callee.match(/^New(\p{Lu}\w*)$/u);
    if (m) return { type: qual && /^\p{Ll}\w*$/u.test(qual) ? `${qual}.${m[1]}` : m[1]!, via: 'constructor_call' };
  }
  return null;
}

function emitTypeRefs(t: Node | null | undefined, ctx: WalkContext) {
  if (!t) return;
  const stack: Node[] = [t];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'type_identifier') {
      if (!BUILTIN_TYPES.has(n.text)) ctx.emitRef({ kind: 'type', name: n.text }, n);
      continue;
    }
    if (n.type === 'qualified_type') {
      const name = n.childForFieldName('name');
      if (name) ctx.emitRef({ kind: 'type', name: name.text, qualifier: n.childForFieldName('package')?.text ?? '' }, name);
      continue;
    }
    for (const c of named(n)) stack.push(c);
  }
}

function embeddedSupertypes(structType: Node): NonNullable<DefSpec['supertypes']> {
  const out: NonNullable<DefSpec['supertypes']> = [];
  const list = named(structType).find((c) => c.type === 'field_declaration_list');
  for (const f of named(list)) {
    if (f.type !== 'field_declaration' || namesOf(f).length) continue;
    const t = goTypeName(f.childForFieldName('type'));
    if (t) out.push({ name: t, kind: 'extends' });
  }
  return out;
}

function interfaceSupertypes(ifaceType: Node): NonNullable<DefSpec['supertypes']> {
  const out: NonNullable<DefSpec['supertypes']> = [];
  for (const el of named(ifaceType)) {
    if (el.type !== 'type_elem') continue;
    const parts = named(el);
    if (parts.length !== 1) continue; // union constraint `~int | string`
    const t = goTypeName(parts[0]);
    if (t) out.push({ name: t, kind: 'extends' });
  }
  return out;
}

function handlerName(arg: Node): string {
  if (arg.type === 'identifier' || arg.type === 'selector_expression') return arg.text;
  if (arg.type === 'call_expression') {
    // http.HandlerFunc(h), middleware(h)
    for (const a of named(arg.childForFieldName('arguments'))) {
      const h = handlerName(a);
      if (h) return h;
    }
  }
  return '';
}

/** `http.HandleFunc("/p", h)`, `r.GET("/p", h)`, `mux.HandleFunc("GET /p", h)` ... */
function routeFromCall(node: Node, ctx: WalkContext): boolean {
  const fn = node.childForFieldName('function');
  if (!fn || fn.type !== 'selector_expression') return false;
  const field = fn.childForFieldName('field')?.text ?? '';
  let method = ROUTE_METHODS[field];
  if (!method) return false;
  const args = named(node.childForFieldName('arguments'));
  if (args.length < 2) return false;
  let path = stringValue(args[0]);
  if (path === null) return false;
  const m = path.match(/^([A-Z]+) (\/\S*)$/);
  if (m) {
    method = m[1]!;
    path = m[2]!;
  }
  if (!path.startsWith('/')) return false;
  if (ctx.inTest) return false;
  const handlers = args.slice(1).map(handlerName).filter(Boolean);
  ctx.emitDef({ kind: 'route', name: `${method} ${path}`, signature: `${method} ${path}`, meta: { method, path, handler: handlers.join(',') } }, node, -1);
  return true;
}

function packageAlias(path: string): string {
  const segs = path.split('/').filter(Boolean);
  let last = segs[segs.length - 1] ?? path;
  if (/^v\d+$/.test(last) && segs.length > 1) last = segs[segs.length - 2]!;
  last = last.replace(/\.v\d+$/, '').replace(/\.git$/, '').replace(/^go-/, '').replace(/-go$/, '');
  return last.replace(/[^\w]/g, '_');
}

export const go: LanguageSupport = {
  id: 'go',
  grammar: 'go',
  extensions: ['.go'],
  // struct/interface scopes are opened by the `type_spec` definition's kind, not by node type.
  classLike: new Set<string>(),
  skip: new Set(['comment', 'interpreted_string_literal', 'raw_string_literal']),

  isTestFile(path) {
    return /_test\.go$/.test(path);
  },

  doc(node) {
    return goDoc(node);
  },

  moduleDoc(root) {
    const pkg = named(root).find((c) => c.type === 'package_clause');
    if (!pkg) return '';
    return stripDirectives(precedingComments(pkg, COMMENTS));
  },

  definition(node, ctx): DefSpec | null {
    switch (node.type) {
      case 'function_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const tp = node.childForFieldName('type_parameters')?.text ?? '';
        const params = node.childForFieldName('parameters')?.text ?? '()';
        const result = node.childForFieldName('result');
        const kind: DefSpec['kind'] = TEST_NAME.test(name) && node.parent?.type === 'source_file' ? 'test' : 'function';
        return {
          kind,
          name,
          body: node.childForFieldName('body'),
          signature: oneLine(`func ${name}${tp}${params}${result ? ' ' + result.text : ''}`),
          doc: goDoc(node),
          exported: isExportedName(name),
        };
      }
      case 'method_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const recv = named(node.childForFieldName('receiver')).find((c) => c.type === 'parameter_declaration');
        const recvType = simpleTypeName(goTypeName(recv?.childForFieldName('type')) || recv?.childForFieldName('type')?.text || '');
        const params = node.childForFieldName('parameters')?.text ?? '()';
        const result = node.childForFieldName('result');
        return {
          kind: 'method',
          name,
          container: recvType || undefined,
          body: node.childForFieldName('body'),
          signature: oneLine(`func ${node.childForFieldName('receiver')?.text ?? ''} ${name}${params}${result ? ' ' + result.text : ''}`),
          doc: goDoc(node),
          exported: isExportedName(name),
          meta: recvType ? { receiver: recvType } : undefined,
        };
      }
      case 'type_spec': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const tp = node.childForFieldName('type_parameters')?.text ?? '';
        const t = node.childForFieldName('type');
        const doc = goDoc(node);
        const exported = isExportedName(name);
        if (t?.type === 'struct_type') {
          const sup = embeddedSupertypes(t);
          return { kind: 'struct', name, body: t, signature: oneLine(`type ${name}${tp} struct`), doc, exported, supertypes: sup };
        }
        if (t?.type === 'interface_type') {
          return { kind: 'interface', name, body: t, signature: oneLine(`type ${name}${tp} interface`), doc, exported, supertypes: interfaceSupertypes(t) };
        }
        return { kind: 'type_alias', name, signature: oneLine(`type ${name}${tp} ${t?.text ?? ''}`, 200), doc, exported, declaredType: goTypeName(t) || undefined };
      }
      case 'type_alias': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const t = node.childForFieldName('type');
        return { kind: 'type_alias', name, signature: oneLine(`type ${name} = ${t?.text ?? ''}`, 200), doc: goDoc(node), exported: isExportedName(name), declaredType: goTypeName(t) || undefined };
      }
      case 'field_declaration': {
        // Named struct fields of a declared struct type; embedded fields are supertypes of the struct.
        if (!ctx.inClass || ctx.scopeDef?.kind !== 'struct') return null;
        const names = namesOf(node);
        if (!names.length) return null;
        const t = node.childForFieldName('type');
        const tag = stringValue(node.childForFieldName('tag'));
        const declaredType = goTypeName(t) || undefined;
        const doc = goDoc(node);
        const mk = (n: Node): DefSpec => ({
          kind: 'field',
          name: n.text,
          signature: oneLine(`${n.text} ${t?.text ?? ''}`, 160),
          doc,
          exported: isExportedName(n.text),
          declaredType,
          meta: tag ? { tag } : undefined,
          rangeNode: node,
        });
        // extra names are registered before the returned spec, so return the last one to keep source order
        for (const extra of names.slice(0, -1)) ctx.emitDef(mk(extra), node, ctx.scope);
        return mk(names[names.length - 1]!);
      }
      case 'method_elem': {
        if (ctx.scopeDef?.kind !== 'interface') return null;
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const params = node.childForFieldName('parameters')?.text ?? '()';
        const result = node.childForFieldName('result');
        return { kind: 'method', name, signature: oneLine(`${name}${params}${result ? ' ' + result.text : ''}`), doc: precedingComments(node, COMMENTS), exported: isExportedName(name), modifiers: ['abstract'] };
      }
      case 'const_spec':
      case 'var_spec': {
        if (!isTopLevelSpec(node)) return null;
        const names = namesOf(node);
        if (!names.length) return null;
        const t = node.childForFieldName('type');
        const values = named(node.childForFieldName('value'));
        const isConst = node.type === 'const_spec';
        const doc = goDoc(node);
        const mk = (n: Node, i: number): DefSpec => {
          const value = values[i] ?? (values.length === 1 ? values[0] : undefined);
          const declaredType = goTypeName(t) || inferType(value)?.type || undefined;
          return {
            kind: isConst ? 'constant' : 'variable',
            name: n.text,
            signature: oneLine(`${isConst ? 'const' : 'var'} ${n.text}${t ? ' ' + t.text : ''}${value ? ' = ' + value.text : ''}`, 160),
            doc,
            exported: isExportedName(n.text),
            declaredType,
            rangeNode: node,
          };
        };
        names.slice(0, -1).forEach((extra, i) => ctx.emitDef(mk(extra, i), node, ctx.scope));
        return mk(names[names.length - 1]!, names.length - 1);
      }
    }
    return null;
  },

  imports(node): Import[] | null {
    if (node.type !== 'import_declaration') return null;
    const specs: Node[] = [];
    for (const c of named(node)) {
      if (c.type === 'import_spec') specs.push(c);
      else if (c.type === 'import_spec_list') for (const s of named(c)) if (s.type === 'import_spec') specs.push(s);
    }
    const out: Import[] = [];
    for (const s of specs) {
      const source = stringValue(s.childForFieldName('path'));
      if (source === null) continue;
      const line = s.startPosition.row + 1;
      const nameNode = s.childForFieldName('name');
      if (nameNode?.type === 'blank_identifier') out.push({ source, names: [], namespace: false, alias: '', kind: 'static', line });
      else if (nameNode?.type === 'dot') out.push({ source, names: [], namespace: true, alias: '', kind: 'static', line });
      else out.push({ source, names: [], namespace: true, alias: nameNode?.text || packageAlias(source), kind: 'static', line });
    }
    return out;
  },

  references(node, ctx) {
    switch (node.type) {
      case 'call_expression': {
        const fn = node.childForFieldName('function');
        const args = named(node.childForFieldName('arguments'));
        const arity = args.length;
        if (!fn) return;
        if (fn.type === 'identifier') {
          if (fn.text === 'new') {
            const t = goTypeName(args[0]);
            if (t) ctx.emitRef({ kind: 'new', name: simpleTypeName(t), qualifier: t.includes('.') ? t.slice(0, t.lastIndexOf('.')) : '', arity: 0 }, fn);
            return true;
          }
          if (!BUILTIN_FUNCS.has(fn.text)) ctx.emitRef({ kind: 'call', name: fn.text, arity }, fn);
        } else if (fn.type === 'selector_expression') {
          const operand = fn.childForFieldName('operand');
          const field = fn.childForFieldName('field');
          if (field) {
            const q = operand?.text ?? '';
            if (q === 'os' && ENV_FUNCS.has(field.text)) {
              const key = stringValue(args[0]);
              if (key !== null && args[0]) ctx.emitRef({ kind: 'config', name: key }, args[0]);
            }
            routeFromCall(node, ctx);
            ctx.emitRef({ kind: 'call', name: field.text, qualifier: q, arity }, field);
          }
        }
        return;
      }
      case 'composite_literal': {
        const t = goTypeName(node.childForFieldName('type'));
        if (t) ctx.emitRef({ kind: 'new', name: simpleTypeName(t), qualifier: t.includes('.') ? t.slice(0, t.lastIndexOf('.')) : '', arity: named(node.childForFieldName('body')).length }, node.childForFieldName('type') ?? node);
        return;
      }
      case 'type_identifier': {
        const p = node.parent;
        if (!p) return true;
        if (p.type === 'type_spec' || p.type === 'type_alias' || p.type === 'composite_literal') return true;
        if (p.type === 'generic_type' && p.parent?.type === 'composite_literal') return true;
        if (!BUILTIN_TYPES.has(node.text)) ctx.emitRef({ kind: 'type', name: node.text }, node);
        return true;
      }
      case 'qualified_type': {
        if (node.parent?.type === 'composite_literal') return true;
        emitTypeRefs(node, ctx);
        return true;
      }
      case 'field_declaration': {
        // embedded field: already recorded as a supertype of the struct
        if (!namesOf(node).length && ctx.scopeDef?.kind === 'struct') return true;
        return;
      }
      case 'parameter_declaration':
      case 'variadic_parameter_declaration': {
        const t = goTypeName(node.childForFieldName('type'));
        if (t) for (const n of namesOf(node)) ctx.emitLocalType({ name: n.text, type: t, via: 'annotation' });
        return;
      }
      case 'var_spec': {
        if (isTopLevelSpec(node)) return;
        const t = goTypeName(node.childForFieldName('type'));
        const values = named(node.childForFieldName('value'));
        namesOf(node).forEach((n, i) => {
          if (t) ctx.emitLocalType({ name: n.text, type: t, via: 'annotation' });
          else {
            const inf = inferType(values[i] ?? (values.length === 1 ? values[0] : undefined));
            if (inf) ctx.emitLocalType({ name: n.text, type: inf.type, via: inf.via });
          }
        });
        return;
      }
      case 'short_var_declaration':
      case 'assignment_statement': {
        const left = named(node.childForFieldName('left'));
        const right = named(node.childForFieldName('right'));
        left.forEach((l, i) => {
          if (l.type !== 'identifier' && l.type !== 'selector_expression') return;
          const inf = inferType(right[i] ?? (right.length === 1 && i === 0 ? right[0] : undefined));
          if (inf) ctx.emitLocalType({ name: l.text, type: inf.type, via: inf.via });
        });
        return;
      }
      case 'identifier': {
        // bare name in value position: call argument or composite-literal element (`{"err": handler}`)
        const p = node.parent;
        if (p && (p.type === 'argument_list' || p.type === 'literal_element') && !BUILTIN_FUNCS.has(node.text) && !/^(nil|true|false|_)$/.test(node.text)) ctx.emitRef({ kind: 'value', name: node.text }, node);
        return;
      }
    }
    return;
  },

  resolveModule(source, _fromPath, _imp, project) {
    const segs = source.split('/').filter(Boolean);
    const dirs: string[] = [];
    const mod = project.goModule ?? null;
    if (mod) {
      if (source === mod) dirs.push('');
      else if (source.startsWith(mod + '/')) dirs.push(source.slice(mod.length + 1));
    }
    if (!dirs.length) {
      // Unknown module root: try progressively shorter suffixes (drop host/org/repo, or a bare module name).
      const domainLike = (segs[0] ?? '').includes('.');
      const maxDrop = domainLike ? Math.min(3, segs.length - 1) : Math.min(1, segs.length - 1);
      for (let drop = 0; drop <= maxDrop; drop++) {
        const rest = segs.slice(drop).join('/');
        if (rest && !(domainLike && drop === 0)) dirs.push(rest);
      }
    }
    const out: string[] = [];
    for (const dir of dirs) {
      const last = dir ? dir.slice(dir.lastIndexOf('/') + 1) : mod ? packageAlias(mod) : '';
      const pre = dir ? dir + '/' : '';
      if (last) out.push(`${pre}${last}.go`, `${pre}${packageAlias(last)}.go`);
      for (const f of PACKAGE_FILES) out.push(`${pre}${f}`);
    }
    return [...new Set(out)];
  },
};
