import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, simpleTypeName, cleanComment, named, kids } from '../parse/walk.js';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'match']);
const ROUTER_NAMES = /^(Route|Router|router|app|r|route)$/;
const DECL_TYPES = new Set(['class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration', 'function_definition', 'method_declaration', 'property_declaration', 'const_declaration']);
const NON_CLASS_TYPES = new Set(['self', 'static', 'parent', 'array', 'callable', 'iterable', 'mixed', 'void', 'null', 'never', 'object', 'int', 'integer', 'string', 'bool', 'boolean', 'float', 'double', 'false', 'true', 'resource']);
const ENV_FNS = new Set(['getenv', 'env']);
const ENV_GLOBALS = new Set(['_ENV', '_SERVER']);
/** Static factory methods that return an instance of the receiver (Laravel / singletons). */
const FACTORY_METHODS = new Set(['find', 'findOrFail', 'create', 'make', 'first', 'firstOrCreate', 'firstOrFail', 'instance', 'getInstance', 'fromArray', 'fromString']);

/** `\App\Models\User` -> `App.Models.User`. */
function dotted(text: string): string {
  return text.replace(/^\\/, '').replace(/\\/g, '.');
}

function stringValue(n: Node | null | undefined): string | null {
  if (!n) return null;
  if (n.type === 'string' || n.type === 'encapsed_string') {
    if (named(n).some((c) => c.type !== 'string_content')) return n.type === 'string' ? n.text.slice(1, -1) : null;
    return named(n).map((c) => c.text).join('');
  }
  return null;
}

/** Non-`$` name of a variable_name node. */
function varName(n: Node): string {
  return n.text.replace(/^\$/, '');
}

function argsOf(n: Node): Node[] {
  return named(n.childForFieldName('arguments') ?? kids(n).find((c) => c.type === 'arguments')).map((a) => (a.type === 'argument' ? named(a)[0] ?? a : a));
}

function namedArg(call: Node, key: string): Node | null {
  for (const a of named(call.childForFieldName('arguments') ?? kids(call).find((c) => c.type === 'arguments'))) {
    if (a.type === 'argument' && a.childForFieldName('name')?.text === key) return named(a).find((c) => c.type !== 'name') ?? null;
  }
  return null;
}

/** Closest preceding `/** ... *\/` docblock (tags stripped). */
function docblock(node: Node): string {
  return cleanDoc(rawDoc(node));
}

function rawDoc(node: Node): string {
  let prev = node.previousSibling;
  let lastStart = node.startPosition.row;
  while (prev && prev.type === 'comment') {
    if (lastStart - prev.endPosition.row > 1) return '';
    if (prev.text.startsWith('/**')) return prev.text;
    lastStart = prev.startPosition.row;
    prev = prev.previousSibling;
  }
  return '';
}

function cleanDoc(raw: string): string {
  if (!raw) return '';
  const lines = cleanComment(raw)
    .split('\n')
    .filter((l) => !/^\s*@/.test(l));
  while (lines.length && !lines[lines.length - 1]?.trim()) lines.pop();
  return lines.join('\n').trim();
}

function modifiersOf(node: Node): string[] {
  const out: string[] = [];
  for (const c of kids(node)) {
    switch (c.type) {
      case 'visibility_modifier':
        out.push(c.text);
        break;
      case 'static_modifier':
        out.push('static');
        break;
      case 'abstract_modifier':
        out.push('abstract');
        break;
      case 'final_modifier':
        out.push('final');
        break;
      case 'readonly_modifier':
        out.push('readonly');
        break;
    }
  }
  return out;
}

/** Simple class name of a type node (`?Foo` -> Foo, `Foo|Bar` -> Foo, `int` -> int). */
function typeName(t: Node | null | undefined): string | undefined {
  if (!t) return undefined;
  switch (t.type) {
    case 'optional_type':
      return typeName(named(t)[0]);
    case 'union_type':
    case 'intersection_type':
    case 'disjunctive_normal_form_type':
    case 'type_list': {
      const first = named(t).find((c) => c.type === 'named_type') ?? named(t)[0];
      return typeName(first);
    }
    case 'named_type':
    case 'primitive_type':
    case 'bottom_type':
      return simpleTypeName(t.text);
    default:
      return simpleTypeName(t.text);
  }
}

function isClassType(name: string): boolean {
  return !!name && !NON_CLASS_TYPES.has(name.toLowerCase());
}

/** Emit `type` references for every class name under a type node. */
function emitTypeRefs(t: Node | null | undefined, ctx: WalkContext) {
  if (!t) return;
  const stack: Node[] = [t];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'named_type' || n.type === 'qualified_name' || n.type === 'name') {
      emitNameRef(n.type === 'named_type' ? named(n)[0] : n, 'type', ctx);
      continue;
    }
    if (n.type === 'primitive_type') continue;
    for (const c of named(n)) stack.push(c);
  }
}

/** Emit a ref for a `name` / `qualified_name` node. */
function emitNameRef(n: Node | null | undefined, kind: 'type' | 'new' | 'decorator', ctx: WalkContext, arity?: number) {
  if (!n) return;
  if (n.type === 'name') {
    if (isClassType(n.text)) ctx.emitRef({ kind, name: n.text, arity }, n);
    return;
  }
  if (n.type === 'qualified_name') {
    const last = named(n).filter((c) => c.type === 'name').pop();
    const prefix = named(n).find((c) => c.type === 'namespace_name');
    if (last) ctx.emitRef({ kind, name: last.text, qualifier: prefix ? dotted(prefix.text) : '', arity }, last);
  }
}

/** Qualifier text for a member-call object: `$this` -> this, `$this->repo` -> this.repo, `Foo::$x` -> Foo.x. */
function objQualifier(o: Node | null | undefined): string {
  if (!o) return '';
  switch (o.type) {
    case 'variable_name':
      return varName(o);
    case 'member_access_expression':
    case 'nullsafe_member_access_expression': {
      const inner = objQualifier(o.childForFieldName('object'));
      const nm = o.childForFieldName('name');
      return nm ? `${inner}.${nm.text}` : inner;
    }
    case 'scoped_property_access_expression': {
      const scope = o.childForFieldName('scope');
      const nm = o.childForFieldName('name');
      return `${scopeQualifier(scope)}.${nm ? varName(nm) : ''}`;
    }
    case 'name':
    case 'qualified_name':
    case 'relative_scope':
      return scopeQualifier(o);
    default:
      return oneLine(o.text, 80);
  }
}

/** Qualifier for `X::m()`: `self`/`static`/`parent` as written, class names simplified. */
function scopeQualifier(s: Node | null | undefined): string {
  if (!s) return '';
  if (s.type === 'relative_scope') return s.text;
  if (s.type === 'name') return s.text;
  if (s.type === 'qualified_name') return simpleTypeName(dotted(s.text));
  if (s.type === 'variable_name') return varName(s);
  return oneLine(s.text, 80);
}

/** Dotted namespace prefix for a top-level declaration following a bodiless `namespace X;`. */
function nsPrefix(node: Node): string | undefined {
  if (node.parent?.type !== 'program') return undefined;
  let prev = node.previousNamedSibling;
  while (prev) {
    if (prev.type === 'namespace_definition' && !prev.childForFieldName('body')) {
      const nm = prev.childForFieldName('name');
      return nm ? dotted(nm.text) : undefined;
    }
    prev = prev.previousNamedSibling;
  }
  return undefined;
}

function heritage(node: Node): NonNullable<DefSpec['supertypes']> {
  const out: NonNullable<DefSpec['supertypes']> = [];
  for (const c of named(node)) {
    if (c.type === 'base_clause') for (const n of named(c)) out.push({ name: dotted(n.text), kind: 'extends' });
    else if (c.type === 'class_interface_clause') for (const n of named(c)) out.push({ name: dotted(n.text), kind: 'implements' });
  }
  const body = node.childForFieldName('body');
  for (const d of named(body)) {
    if (d.type !== 'use_declaration') continue;
    for (const n of named(d)) if (n.type === 'name' || n.type === 'qualified_name') out.push({ name: dotted(n.text), kind: 'implements' });
  }
  return out;
}

function attributesOf(node: Node): Node[] {
  const list = node.childForFieldName('attributes') ?? kids(node).find((c) => c.type === 'attribute_list');
  const out: Node[] = [];
  for (const g of named(list)) for (const a of named(g)) if (a.type === 'attribute') out.push(a);
  return out;
}

function attrName(a: Node): string {
  const n = named(a)[0];
  return n ? simpleTypeName(dotted(n.text)) : '';
}

/** Symfony-style `#[Route('/x', methods: ['GET'])]`. */
function attributeRoute(a: Node): { path: string; methods: string[] } | null {
  if (attrName(a) !== 'Route') return null;
  const first = argsOf(a)[0];
  let path = stringValue(first);
  const pathArg = namedArg(a, 'path');
  if (pathArg) path = stringValue(pathArg);
  if (path === null) return null;
  const methodsArg = namedArg(a, 'methods');
  const methods = methodsArg?.type === 'array_creation_expression' ? named(methodsArg).map((e) => stringValue(named(e)[0])?.toUpperCase() ?? '').filter(Boolean) : methodsArg ? [stringValue(methodsArg)?.toUpperCase() ?? ''].filter(Boolean) : [];
  return { path, methods: methods.length ? methods : ['ANY'] };
}

/** Laravel `Route::get('/x', [Ctl::class, 'm'])` / `$router->get(...)`. */
function routeFromCall(node: Node, ctx: WalkContext, owner: string, method: string): boolean {
  if (!ROUTER_NAMES.test(owner) || !HTTP_METHODS.has(method) || ctx.inTest) return false;
  const a = argsOf(node);
  let verbs: string[] = [method === 'any' ? 'ANY' : method.toUpperCase()];
  let pathNode = a[0];
  let handlerNode = a[1];
  if (method === 'match') {
    const arr = a[0];
    verbs = arr?.type === 'array_creation_expression' ? named(arr).map((e) => stringValue(named(e)[0])?.toUpperCase() ?? '').filter(Boolean) : ['ANY'];
    pathNode = a[1];
    handlerNode = a[2];
  }
  const path = stringValue(pathNode);
  if (path === null) return false;
  let handler = '';
  if (handlerNode?.type === 'array_creation_expression') {
    const [c, m] = named(handlerNode).map((e) => named(e)[0]);
    const cls = c?.type === 'class_constant_access_expression' ? simpleTypeName(dotted(named(c)[0]?.text ?? '')) : stringValue(c) ?? '';
    const mn = stringValue(m) ?? '';
    handler = cls ? (mn ? `${cls}.${mn}` : cls) : '';
  } else if (handlerNode) {
    const s = stringValue(handlerNode);
    if (s) {
      const [cls = '', m] = s.split('@');
      handler = m ? `${simpleTypeName(dotted(cls))}.${m}` : simpleTypeName(dotted(cls));
    }
    else if (handlerNode.type === 'class_constant_access_expression') handler = simpleTypeName(dotted(named(handlerNode)[0]?.text ?? ''));
  }
  const verb = verbs.join(',');
  ctx.emitDef({ kind: 'route', name: `${verb} ${path}`, signature: `${verb} ${path}`, meta: { method: verb, path, handler } }, node, -1);
  return true;
}

function isTestMethod(name: string, node: Node): boolean {
  if (/^test[A-Z0-9_]/.test(name)) return true;
  return /@test\b/.test(rawDoc(node));
}

function paramsText(node: Node): string {
  return node.childForFieldName('parameters')?.text ?? '()';
}

function returnText(node: Node): string {
  const r = node.childForFieldName('return_type');
  return r ? `: ${r.text}` : '';
}

export const php: LanguageSupport = {
  id: 'php',
  grammar: 'php',
  extensions: ['.php'],
  classLike: new Set(['class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration', 'anonymous_class']),
  skip: new Set(['comment', 'string', 'nowdoc_body', 'heredoc_body', 'text']),

  isTestFile(path) {
    return /(^|\/)(tests?|spec|specs)\//.test(path) || /Test\.php$/.test(path) || /Spec\.php$/.test(path);
  },

  doc(node) {
    return docblock(node);
  },

  moduleDoc(root) {
    for (const c of named(root)) {
      if (c.type === 'php_tag' || c.type === 'declare_statement') continue;
      if (c.type !== 'comment') return '';
      if (!c.text.startsWith('/**')) continue;
      const next = c.nextNamedSibling;
      if (next && DECL_TYPES.has(next.type) && next.startPosition.row - c.endPosition.row <= 1) return '';
      return cleanDoc(c.text);
    }
    return '';
  },

  definition(node, ctx): DefSpec | null {
    switch (node.type) {
      case 'namespace_definition': {
        const nm = node.childForFieldName('name');
        if (!nm) return null;
        const full = dotted(nm.text);
        const name = simpleTypeName(full);
        const container = full.includes('.') ? full.slice(0, full.lastIndexOf('.')) : undefined;
        return { kind: 'namespace', name, container, body: node.childForFieldName('body'), signature: `namespace ${nm.text}`, doc: docblock(node), exported: true };
      }
      case 'class_declaration':
      case 'interface_declaration':
      case 'trait_declaration':
      case 'enum_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const mods = modifiersOf(node);
        const sup = heritage(node);
        const kind: DefSpec['kind'] = node.type === 'class_declaration' ? 'class' : node.type === 'interface_declaration' ? 'interface' : node.type === 'trait_declaration' ? 'trait' : 'enum';
        const kw = kind === 'class' ? 'class' : kind;
        const backing = kind === 'enum' ? kids(node).find((c) => c.type === 'primitive_type')?.text : undefined;
        const ext = sup.filter((s) => s.kind === 'extends').map((s) => s.name);
        const impl = named(node).filter((c) => c.type === 'class_interface_clause').flatMap((c) => named(c).map((n) => dotted(n.text)));
        const supText = `${ext.length ? ' extends ' + ext.join(', ') : ''}${impl.length ? ' implements ' + impl.join(', ') : ''}`;
        return {
          kind,
          name,
          container: nsPrefix(node),
          body: node.childForFieldName('body'),
          signature: oneLine(`${mods.length ? mods.join(' ') + ' ' : ''}${kw} ${name}${backing ? ': ' + backing : ''}${supText}`),
          doc: docblock(node),
          modifiers: mods,
          exported: true,
          supertypes: sup,
        };
      }
      case 'enum_case': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        return { kind: 'enum_member', name, signature: oneLine(node.text.replace(/;$/, ''), 80), doc: docblock(node), exported: true };
      }
      case 'function_definition': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        return { kind: 'function', name, container: nsPrefix(node), body: node.childForFieldName('body'), signature: oneLine(`function ${name}${paramsText(node)}${returnText(node)}`), doc: docblock(node), exported: true };
      }
      case 'method_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const mods = modifiersOf(node);
        let kind: DefSpec['kind'] = name === '__construct' ? 'constructor' : 'method';
        if (kind === 'method' && isTestMethod(name, node)) kind = 'test';
        // Promoted constructor properties are fields of the enclosing class.
        if (kind === 'constructor') {
          for (const p of named(node.childForFieldName('parameters'))) {
            if (p.type !== 'property_promotion_parameter') continue;
            const pn = p.childForFieldName('name');
            if (!pn) continue;
            const pmods = modifiersOf(p);
            const t = p.childForFieldName('type');
            ctx.emitDef({ kind: 'field', name: varName(pn), signature: oneLine(`${pmods.join(' ')}${pmods.length ? ' ' : ''}${t ? t.text + ' ' : ''}$${varName(pn)}`), modifiers: pmods, declaredType: typeName(t), exported: !pmods.includes('private'), meta: { promoted: true } }, p, ctx.scope);
          }
        }
        // Symfony attribute routes (with a class-level prefix when present).
        if (!ctx.inTest) {
          const classNode = node.parent?.parent;
          let prefix = '';
          if (classNode && classNode.type === 'class_declaration') {
            for (const a of attributesOf(classNode)) {
              const r = attributeRoute(a);
              if (r) prefix = r.path.replace(/\/$/, '');
            }
          }
          for (const a of attributesOf(node)) {
            const r = attributeRoute(a);
            if (!r) continue;
            const path = (prefix + r.path).replace(/\/{2,}/g, '/') || '/';
            const verb = r.methods.join(',');
            ctx.emitDef({ kind: 'route', name: `${verb} ${path}`, signature: `${verb} ${path}`, meta: { method: verb, path, handler: name } }, a, -1);
          }
        }
        return {
          kind,
          name,
          body: node.childForFieldName('body'),
          signature: oneLine(`${mods.length ? mods.join(' ') + ' ' : ''}function ${name}${paramsText(node)}${returnText(node)}`),
          doc: docblock(node),
          modifiers: mods,
          exported: !mods.includes('private'),
        };
      }
      case 'property_declaration': {
        const mods = modifiersOf(node);
        const t = node.childForFieldName('type');
        const declaredType = typeName(t);
        const elements = named(node).filter((c) => c.type === 'property_element');
        const specs: DefSpec[] = elements.map((el) => {
          const nm = el.childForFieldName('name');
          const name = nm ? varName(nm) : '';
          const dv = el.childForFieldName('default_value');
          return { kind: 'field', name, signature: oneLine(`${mods.join(' ')}${mods.length ? ' ' : ''}${t ? t.text + ' ' : ''}$${name}${dv ? ' = ' + dv.text : ''}`, 160), doc: docblock(node), modifiers: mods, declaredType, exported: !mods.includes('private') };
        });
        if (!specs.length || !specs[0]!.name) return null;
        // Extra elements are emitted first so ordinals follow source order; the last one is the node's own def.
        for (let i = 0; i < specs.length - 1; i++) ctx.emitDef(specs[i]!, elements[i]!, ctx.scope);
        return specs[specs.length - 1]!;
      }
      case 'const_declaration': {
        const mods = modifiersOf(node);
        const elements = named(node).filter((c) => c.type === 'const_element');
        const container = nsPrefix(node);
        const specs: DefSpec[] = elements.map((el) => {
          const name = named(el)[0]?.text ?? '';
          const value = named(el)[1];
          return { kind: 'constant', name, container, signature: oneLine(`${mods.join(' ')}${mods.length ? ' ' : ''}const ${name} = ${value?.text ?? ''}`, 160), doc: docblock(node), modifiers: mods, exported: !mods.includes('private') };
        });
        if (!specs.length || !specs[0]!.name) return null;
        for (let i = 0; i < specs.length - 1; i++) ctx.emitDef(specs[i]!, elements[i]!, ctx.scope);
        return specs[specs.length - 1]!;
      }
    }
    return null;
  },

  imports(node): Import[] | null {
    const line = node.startPosition.row + 1;
    if (node.type === 'namespace_use_declaration') {
      const out: Import[] = [];
      const group = node.childForFieldName('body') ?? named(node).find((c) => c.type === 'namespace_use_group');
      if (group) {
        const prefix = named(node).find((c) => c.type === 'namespace_name')?.text ?? '';
        for (const clause of named(group)) {
          if (clause.type !== 'namespace_use_clause') continue;
          const nm = named(clause).find((c) => c.type === 'name' || c.type === 'qualified_name');
          if (!nm) continue;
          const parts = nm.text.split('\\').filter(Boolean);
          const name = parts.pop() ?? '';
          const src = [prefix, ...parts].filter(Boolean).join('\\');
          out.push({ source: src, names: [{ name, alias: clause.childForFieldName('alias')?.text ?? name }], namespace: false, alias: '', kind: 'static', line });
        }
        return out;
      }
      for (const clause of named(node)) {
        if (clause.type !== 'namespace_use_clause') continue;
        const target = named(clause).find((c) => c.type === 'qualified_name' || c.type === 'name');
        if (!target) continue;
        const parts = target.text.replace(/^\\/, '').split('\\').filter(Boolean);
        const name = parts.pop() ?? '';
        out.push({ source: parts.join('\\'), names: [{ name, alias: clause.childForFieldName('alias')?.text ?? name }], namespace: false, alias: '', kind: 'static', line });
      }
      return out;
    }
    if (node.type === 'expression_statement') {
      const e = named(node)[0];
      if (!e || !/^(require|include)(_once)?_expression$/.test(e.type)) return null;
      let src: string | null = null;
      const arg = named(e)[0];
      if (arg?.type === 'binary_expression') {
        // __DIR__ . '/x.php'  /  dirname(__FILE__) . '/x.php'
        const right = arg.childForFieldName('right');
        const left = arg.childForFieldName('left');
        const s = stringValue(right);
        if (s && left && /__DIR__|dirname\(/.test(left.text)) src = '.' + (s.startsWith('/') ? s : '/' + s);
      } else src = stringValue(arg);
      if (src === null) return [];
      return [{ source: src, names: [], namespace: false, alias: '', kind: 'static', line }];
    }
    return null;
  },

  references(node, ctx) {
    switch (node.type) {
      case 'function_call_expression': {
        const fn = node.childForFieldName('function');
        const a = argsOf(node);
        if (!fn) return;
        if (fn.type === 'name') {
          if (ENV_FNS.has(fn.text)) {
            const key = stringValue(a[0]);
            if (key) ctx.emitRef({ kind: 'config', name: key }, a[0]!);
          }
          ctx.emitRef({ kind: 'call', name: fn.text, arity: a.length }, fn);
        } else if (fn.type === 'qualified_name') {
          const last = named(fn).filter((c) => c.type === 'name').pop();
          const prefix = named(fn).find((c) => c.type === 'namespace_name');
          if (last) ctx.emitRef({ kind: 'call', name: last.text, qualifier: prefix ? dotted(prefix.text) : '', arity: a.length }, last);
        }
        return;
      }
      case 'member_call_expression':
      case 'nullsafe_member_call_expression': {
        const obj = node.childForFieldName('object');
        const nm = node.childForFieldName('name');
        if (!nm || nm.type !== 'name') return;
        const q = objQualifier(obj);
        if (obj?.type === 'variable_name') routeFromCall(node, ctx, q, nm.text);
        ctx.emitRef({ kind: 'call', name: nm.text, qualifier: q, arity: argsOf(node).length }, nm);
        return;
      }
      case 'scoped_call_expression': {
        const scope = node.childForFieldName('scope');
        const nm = node.childForFieldName('name');
        if (!nm || nm.type !== 'name') return;
        const q = scopeQualifier(scope);
        routeFromCall(node, ctx, q, nm.text);
        ctx.emitRef({ kind: 'call', name: nm.text, qualifier: q, arity: argsOf(node).length }, nm);
        return;
      }
      case 'object_creation_expression': {
        const target = named(node).find((c) => c.type !== 'arguments');
        if (!target) return;
        const arity = argsOf(node).length;
        if (target.type === 'name' || target.type === 'qualified_name') emitNameRef(target, 'new', ctx, arity);
        else if (target.type === 'anonymous_class') return; // walker descends: base_clause refs come from heritage of nothing; emit extends manually
        return;
      }
      case 'anonymous_class': {
        for (const c of named(node)) {
          if (c.type === 'base_clause') for (const n of named(c)) emitNameRef(n, 'type', ctx);
          if (c.type === 'class_interface_clause') for (const n of named(c)) emitNameRef(n, 'type', ctx);
        }
        return;
      }
      case 'assignment_expression': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (!left || !right) return;
        if (left.type !== 'variable_name' && left.type !== 'member_access_expression') return;
        const name = objQualifier(left);
        if (right.type === 'object_creation_expression') {
          const target = named(right).find((c) => c.type === 'name' || c.type === 'qualified_name');
          if (target && isClassType(simpleTypeName(target.text))) ctx.emitLocalType({ name, type: simpleTypeName(dotted(target.text)), via: 'new' });
        } else if (right.type === 'scoped_call_expression') {
          const scope = right.childForFieldName('scope');
          const m = right.childForFieldName('name')?.text ?? '';
          if (scope && (scope.type === 'name' || scope.type === 'qualified_name') && FACTORY_METHODS.has(m)) ctx.emitLocalType({ name, type: simpleTypeName(dotted(scope.text)), via: 'constructor_call' });
        }
        return;
      }
      case 'simple_parameter':
      case 'variadic_parameter':
      case 'property_promotion_parameter': {
        const nm = node.childForFieldName('name');
        const t = node.childForFieldName('type');
        if (nm && t) {
          const tn = typeName(t);
          if (tn && isClassType(tn)) {
            ctx.emitLocalType({ name: varName(nm), type: tn, via: 'annotation' });
            if (node.type === 'property_promotion_parameter') ctx.emitLocalType({ name: `this.${varName(nm)}`, type: tn, via: 'field' });
          }
          emitTypeRefs(t, ctx);
        }
        const dv = node.childForFieldName('default_value');
        if (dv?.type === 'object_creation_expression') emitNameRef(named(dv)[0], 'new', ctx);
        return true;
      }
      case 'method_declaration':
      case 'function_definition':
      case 'arrow_function':
      case 'anonymous_function': {
        emitTypeRefs(node.childForFieldName('return_type'), ctx);
        return;
      }
      case 'property_declaration': {
        emitTypeRefs(node.childForFieldName('type'), ctx);
        return;
      }
      case 'catch_clause': {
        emitTypeRefs(node.childForFieldName('type') ?? named(node).find((c) => c.type === 'type_list' || c.type === 'named_type'), ctx);
        return;
      }
      case 'binary_expression': {
        if (kids(node).some((c) => c.type === 'instanceof')) {
          const r = node.childForFieldName('right');
          if (r && (r.type === 'name' || r.type === 'qualified_name')) emitNameRef(r, 'type', ctx);
        }
        return;
      }
      case 'class_constant_access_expression': {
        const [cls, member] = named(node);
        if (!cls || !member) return true;
        if (cls.type === 'name' || cls.type === 'qualified_name') {
          if (member.text === 'class') emitNameRef(cls, 'type', ctx);
          else ctx.emitRef({ kind: 'value', name: member.text, qualifier: scopeQualifier(cls) }, member);
        } else if (cls.type === 'relative_scope') ctx.emitRef({ kind: 'value', name: member.text, qualifier: cls.text }, member);
        return true;
      }
      case 'attribute': {
        const n = named(node)[0];
        emitNameRef(n, 'decorator', ctx);
        return true;
      }
      case 'subscript_expression': {
        const [obj, idx] = named(node);
        if (obj?.type === 'variable_name' && ENV_GLOBALS.has(varName(obj))) {
          const key = stringValue(idx);
          if (key) ctx.emitRef({ kind: 'config', name: key }, idx!);
          return true;
        }
        return;
      }
    }
    return;
  },

  resolveModule(source, fromPath, imp) {
    const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
    const out: string[] = [];
    const isPath = !imp.names.length && (source.startsWith('.') || source.includes('/') || /\.php$/.test(source) || source === '');
    if (isPath) {
      const rel = source.startsWith('/') && !source.startsWith('./') ? '.' + source : source;
      const parts = (rel.startsWith('.') ? (fromDir ? fromDir.split('/') : []) : []).concat(rel.split('/'));
      const stack: string[] = [];
      for (const p of parts) {
        if (p === '.' || p === '') continue;
        if (p === '..') stack.pop();
        else stack.push(p);
      }
      const p = stack.join('/');
      if (p) out.push(p, `${p}.php`);
      if (!rel.startsWith('.')) {
        const q = [...(fromDir ? fromDir.split('/') : []), ...rel.split('/')].filter((x) => x && x !== '.').join('/');
        if (q && q !== p) out.push(q);
      }
      return out;
    }
    // PSR-4 best effort: App\Models\User -> {src,app,lib,''}/Models/User.php, plus full-namespace and lowercased-dir variants.
    const segs = source.split('\\').filter(Boolean);
    for (const n of imp.names) {
      const cls = n.name;
      const relDir = segs.slice(1).join('/');
      const fullDir = segs.join('/');
      const rels = new Set<string>();
      for (const d of [relDir, fullDir, relDir.toLowerCase(), fullDir.toLowerCase()]) rels.add(d ? `${d}/${cls}.php` : `${cls}.php`);
      for (const root of ['src', 'app', 'lib', '', 'classes', 'includes']) for (const r of rels) out.push(root ? `${root}/${r}` : r);
    }
    return out;
  },
};
