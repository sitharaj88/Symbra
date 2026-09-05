import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext, ModuleResolutionContext } from './types.js';
import { oneLine, simpleTypeName, precedingComments, named, kids } from '../parse/walk.js';

const COMMENTS = new Set(['comment']);
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all', 'use']);
const ROUTER_NAMES = /^(app|router|server|api|r|fastify|koa|express|route)$/i;
const TEST_FNS = new Set(['describe', 'it', 'test', 'suite', 'context', 'bench']);
const NEST_HTTP = new Set(['Get', 'Post', 'Put', 'Delete', 'Patch', 'Options', 'Head', 'All']);
const FN_TYPES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function', 'class', 'class_expression']);

function jsdoc(node: Node): string {
  // For declarations wrapped in export_statement / lexical_declaration, look at the outermost statement.
  let n: Node = node;
  while (n.parent && (n.parent.type === 'export_statement' || n.parent.type === 'lexical_declaration' || n.parent.type === 'variable_declaration' || n.parent.type === 'variable_declarator' || n.parent.type === 'expression_statement' || n.parent.type === 'assignment_expression' || n.parent.type === 'decorated_definition')) n = n.parent;
  return precedingComments(n, COMMENTS);
}

function isExported(node: Node): boolean {
  let n: Node | null = node;
  while (n) {
    if (n.type === 'export_statement') return true;
    if (n.type === 'program' || n.type === 'statement_block' || n.type === 'class_body') return false;
    n = n.parent;
  }
  return false;
}

function modifiersOf(node: Node): string[] {
  const out: string[] = [];
  for (const c of kids(node)) {
    if (!c) continue;
    if (c.type === 'accessibility_modifier' || c.type === 'override_modifier') out.push(c.text);
    else if (['static', 'async', 'readonly', 'abstract', 'declare', 'get', 'set'].includes(c.type)) out.push(c.type);
  }
  return out;
}

function paramsText(node: Node): string {
  const p = node.childForFieldName('parameters');
  return p ? p.text : '()';
}

function returnType(node: Node): string {
  const r = node.childForFieldName('return_type');
  return r ? r.text.replace(/^:\s*/, '') : '';
}

function heritage(node: Node): NonNullable<DefSpec["supertypes"]> {
  const out: NonNullable<DefSpec["supertypes"]> = [];
  for (const c of named(node)) {
    if (c.type === 'class_heritage') {
      // JS: class_heritage (expression) ; TS: class_heritage (extends_clause, implements_clause)
      for (const h of named(c)) {
        if (h.type === 'extends_clause') {
          for (const v of named(h)) if (v.type !== 'type_arguments') out.push({ name: v.text, kind: 'extends' });
        } else if (h.type === 'implements_clause') {
          for (const v of named(h)) out.push({ name: v.text, kind: 'implements' });
        } else if (h.type !== 'type_arguments') out.push({ name: h.text, kind: 'extends' });
      }
    } else if (c.type === 'extends_type_clause') {
      for (const v of named(c)) if (v.type !== 'type_arguments') out.push({ name: v.text, kind: 'extends' });
    }
  }
  return out;
}

function stringValue(n: Node | null | undefined): string | null {
  if (!n) return null;
  if (n.type === 'string') return n.text.slice(1, -1);
  if (n.type === 'template_string' && !n.text.includes('${')) return n.text.slice(1, -1);
  return null;
}

/** Emit references for every type identifier under a type annotation. */
function emitTypeRefs(t: Node, ctx: WalkContext) {
  const stack: Node[] = [t];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'type_identifier') {
      ctx.emitRef({ kind: 'type', name: n.text }, n);
      continue;
    }
    if (n.type === 'nested_type_identifier') {
      const name = n.childForFieldName('name');
      const mod = n.childForFieldName('module');
      if (name) ctx.emitRef({ kind: 'type', name: name.text, qualifier: mod?.text ?? '' }, name);
      continue;
    }
    if (n.type === 'predefined_type' || n.type === 'literal_type') continue;
    for (const c of named(n)) stack.push(c);
  }
}

function routeFromCall(node: Node, ctx: WalkContext): boolean {
  // app.get('/path', ...handlers)
  const fn = node.childForFieldName('function');
  if (!fn || fn.type !== 'member_expression') return false;
  const obj = fn.childForFieldName('object');
  const prop = fn.childForFieldName('property');
  if (!obj || !prop || !HTTP_METHODS.has(prop.text)) return false;
  const objName = obj.text.split('.').pop() ?? '';
  if (!ROUTER_NAMES.test(objName)) return false;
  const args = node.childForFieldName('arguments');
  const first = named(args)[0];
  const path = stringValue(first);
  if (path === null || !path.startsWith('/')) return false;
  if (ctx.inTest) return false;
  const method = prop.text === 'use' ? 'USE' : prop.text.toUpperCase();
  const handlers = named(args).slice(1);
  const handlerNames = handlers.filter((h) => h.type === 'identifier' || h.type === 'member_expression').map((h) => h.text);
  const ord = ctx.emitDef({ kind: 'route', name: `${method} ${path}`, signature: `${method} ${path}`, meta: { method, path, handler: handlerNames.join(',') } }, node, -1);
  void ord;
  return true;
}

function nestRoute(dec: Node): { method: string; path: string } | null {
  const expr = named(dec)[0];
  if (!expr || expr.type !== 'call_expression') return null;
  const fn = expr.childForFieldName('function');
  if (!fn || !NEST_HTTP.has(fn.text)) return null;
  const path = stringValue(named(expr.childForFieldName('arguments'))[0]) ?? '/';
  return { method: fn.text.toUpperCase(), path };
}

function functionValue(n: Node | null): Node | null {
  if (!n) return null;
  if (FN_TYPES.has(n.type)) return n;
  if (n.type === 'parenthesized_expression') return functionValue(named(n)[0] ?? null);
  if (n.type === 'call_expression') {
    // wrapped: memo(() => ...), forwardRef(function ...), wrap(fn)
    const args = n.childForFieldName('arguments');
    for (const a of named(args) ?? []) {
      const f = functionValue(a);
      if (f) return f;
    }
  }
  return null;
}

const FN_IMPL_TYPES = new Set(['function_declaration', 'generator_function_declaration']);
const METHOD_IMPL_TYPES = new Set(['method_definition']);

/** Unwrap `export function f(...)` to the statement that carries the declaration's siblings. */
function outerStatement(node: Node): Node {
  let n: Node = node;
  while (n.parent && n.parent.type === 'export_statement') n = n.parent;
  return n;
}

/** The declaration inside an `export_statement`, or the node itself. */
function innerDeclaration(node: Node): Node {
  if (node.type !== 'export_statement') return node;
  return node.childForFieldName('declaration') ?? named(node)[0] ?? node;
}

/**
 * TypeScript overload signatures are bodiless declarations sitting immediately before the
 * implementation. Emitting one symbol per signature duplicates the definition (`parse`,
 * `parse#2`, …) and gives every call site one edge per overload, so a signature is skipped
 * whenever an implementation of the same name follows it in the same container.
 */
function hasImplementationAfter(node: Node, name: string, implTypes: Set<string>): boolean {
  let sib = outerStatement(node).nextNamedSibling;
  while (sib) {
    if (sib.type === 'comment') {
      sib = sib.nextNamedSibling;
      continue;
    }
    const decl = innerDeclaration(sib);
    if (implTypes.has(decl.type) && (decl.childForFieldName('name')?.text ?? '') === name) return true;
    // Another overload of the same name keeps the search going; anything else ends it.
    if ((decl.type === 'function_signature' || decl.type === 'method_signature') && (decl.childForFieldName('name')?.text ?? '') === name) {
      sib = sib.nextNamedSibling;
      continue;
    }
    return false;
  }
  return false;
}

export function makeJs(id: string, grammar: string, extensions: string[]): LanguageSupport {
  return {
    id,
    grammar,
    extensions,
    classLike: new Set(['class_declaration', 'abstract_class_declaration', 'class', 'interface_declaration', 'object']),
    skip: new Set(['comment', 'string', 'template_string', 'regex']),

    isTestFile(path) {
      return /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || /(^|\/)(__tests__|tests?|spec)\//.test(path);
    },

    doc(node) {
      return jsdoc(node);
    },

    moduleDoc(root) {
      const first = named(root)[0];
      if (first?.type === 'comment' && first.text.startsWith('/**')) return precedingComments(named(root)[1] ?? first, COMMENTS) || first.text;
      return '';
    },

    definition(node, ctx): DefSpec | null {
      switch (node.type) {
        case 'function_declaration':
        case 'generator_function_declaration':
        case 'function_signature': {
          const name = node.childForFieldName('name')?.text ?? '';
          if (!name) return null;
          if (hasImplementationAfter(node, name, FN_IMPL_TYPES)) return null; // overload signature
          const mods = modifiersOf(node);
          const rt = returnType(node);
          return {
            kind: 'function',
            name,
            body: node.childForFieldName('body'),
            signature: oneLine(`${mods.includes('async') ? 'async ' : ''}function ${name}${node.childForFieldName('type_parameters')?.text ?? ''}${paramsText(node)}${rt ? ': ' + rt : ''}`),
            doc: jsdoc(node),
            modifiers: mods,
            exported: isExported(node),
          };
        }
        case 'class_declaration':
        case 'abstract_class_declaration': {
          const name = node.childForFieldName('name')?.text ?? '';
          if (!name) return null;
          const sup = heritage(node);
          const mods = node.type === 'abstract_class_declaration' ? ['abstract'] : [];
          return { kind: 'class', name, body: node.childForFieldName('body'), signature: oneLine(`class ${name}${sup.length ? ' ' + sup.map((s) => `${s.kind} ${s.name}`).join(' ') : ''}`), doc: jsdoc(node), modifiers: mods, exported: isExported(node), supertypes: sup };
        }
        case 'interface_declaration': {
          const name = node.childForFieldName('name')?.text ?? '';
          if (!name) return null;
          const sup = heritage(node);
          return { kind: 'interface', name, body: node.childForFieldName('body'), signature: oneLine(`interface ${name}${node.childForFieldName('type_parameters')?.text ?? ''}`), doc: jsdoc(node), exported: isExported(node), supertypes: sup };
        }
        case 'type_alias_declaration': {
          const name = node.childForFieldName('name')?.text ?? '';
          if (!name) return null;
          return { kind: 'type_alias', name, signature: oneLine(`type ${name}${node.childForFieldName('type_parameters')?.text ?? ''} = ${node.childForFieldName('value')?.text ?? ''}`, 200), doc: jsdoc(node), exported: isExported(node) };
        }
        case 'enum_declaration': {
          const name = node.childForFieldName('name')?.text ?? '';
          if (!name) return null;
          return { kind: 'enum', name, body: node.childForFieldName('body'), signature: `enum ${name}`, doc: jsdoc(node), exported: isExported(node) };
        }
        case 'enum_assignment': {
          const name = node.childForFieldName('name')?.text ?? '';
          return name ? { kind: 'enum_member', name, signature: oneLine(node.text, 80) } : null;
        }
        case 'property_identifier': {
          // bare enum member `A,` inside enum_body
          if (node.parent?.type === 'enum_body') return { kind: 'enum_member', name: node.text, signature: node.text };
          return null;
        }
        case 'internal_module': {
          const name = node.childForFieldName('name')?.text ?? '';
          if (!name) return null;
          return { kind: 'namespace', name, body: node.childForFieldName('body'), signature: `namespace ${name}`, doc: jsdoc(node), exported: isExported(node) };
        }
        case 'method_definition':
        case 'method_signature':
        case 'abstract_method_signature': {
          const nameNode = node.childForFieldName('name');
          const name = nameNode?.text ?? '';
          if (!name) return null;
          if (node.type === 'method_signature' && hasImplementationAfter(node, name, METHOD_IMPL_TYPES)) return null; // overload signature
          const mods = modifiersOf(node);
          const rt = returnType(node);
          let kind: DefSpec['kind'] = name === 'constructor' ? 'constructor' : 'method';
          if (mods.includes('get') || mods.includes('set')) kind = 'property';
          if (nameNode?.type === 'private_property_identifier') mods.push('private');
          // NestJS route decorators
          const decs = node.parent?.type === 'class_body' ? node.children.filter((c) => c?.type === 'decorator') : [];
          const meta: DefSpec['meta'] = {};
          for (const d of decs) {
            const r = d && nestRoute(d);
            if (r) ctx.emitDef({ kind: 'route', name: `${r.method} ${r.path}`, signature: `${r.method} ${r.path}`, meta: { method: r.method, path: r.path, handler: name } }, d!, -1);
          }
          void meta;
          return { kind, name, body: node.childForFieldName('body'), signature: oneLine(`${mods.join(' ')}${mods.length ? ' ' : ''}${name}${paramsText(node)}${rt ? ': ' + rt : ''}`), doc: jsdoc(node), modifiers: mods, exported: !mods.includes('private') && !name.startsWith('#') };
        }
        case 'public_field_definition':
        case 'property_signature': {
          const nameNode = node.childForFieldName('name');
          const name = nameNode?.text ?? '';
          if (!name) return null;
          const mods = modifiersOf(node);
          const t = node.childForFieldName('type');
          const value = node.childForFieldName('value');
          const fnv = functionValue(value);
          const declaredType = t ? simpleTypeName(t.text.replace(/^:\s*/, '')) : undefined;
          if (fnv) {
            return { kind: 'method', name, body: fnv.childForFieldName('body'), signature: oneLine(`${name} = ${fnv.childForFieldName('parameters')?.text ?? '()'} =>`), doc: jsdoc(node), modifiers: mods, exported: true };
          }
          return { kind: node.type === 'property_signature' ? 'property' : 'field', name, signature: oneLine(`${mods.join(' ')}${mods.length ? ' ' : ''}${name}${t ? t.text.replace(/^:/, ':') : ''}`), doc: jsdoc(node), modifiers: mods, declaredType, exported: !mods.includes('private') };
        }
        case 'variable_declarator': {
          const nameNode = node.childForFieldName('name');
          if (!nameNode || nameNode.type !== 'identifier') return null;
          const name = nameNode.text;
          const value = node.childForFieldName('value');
          const decl = node.parent; // lexical_declaration | variable_declaration
          // Only module-level / export-level / namespace-level declarators are definitions; locals are not.
          const holder = decl?.parent;
          const top = holder?.type === 'program' || holder?.type === 'export_statement' || holder?.type === 'statement_block' && holder.parent?.type === 'internal_module';
          if (!top) {
            // local with a type: record fact
            const t = node.childForFieldName('type');
            if (t) ctx.emitLocalType({ name, type: simpleTypeName(t.text.replace(/^:\s*/, '')), via: 'annotation' });
            else if (value?.type === 'new_expression') {
              const c = value.childForFieldName('constructor');
              if (c) ctx.emitLocalType({ name, type: simpleTypeName(c.text), via: 'new' });
            }
            return null;
          }
          const t = node.childForFieldName('type');
          const declaredType = t ? simpleTypeName(t.text.replace(/^:\s*/, '')) : undefined;
          const fnv = functionValue(value);
          const isConst = kids(decl)[0]?.type === 'const';
          if (fnv) {
            if (fnv.type === 'class' || fnv.type === 'class_expression') {
              return { kind: 'class', name, body: fnv.childForFieldName('body'), signature: `class ${name}`, doc: jsdoc(node), exported: isExported(node), supertypes: heritage(fnv) };
            }
            const rt = returnType(fnv);
            const isAsync = fnv.children.some((c) => c?.type === 'async');
            return { kind: 'function', name, body: fnv.childForFieldName('body'), signature: oneLine(`${isConst ? 'const' : 'let'} ${name} = ${isAsync ? 'async ' : ''}${fnv.childForFieldName('parameters')?.text ?? '()'}${rt ? ': ' + rt : ''} =>`), doc: jsdoc(node), modifiers: isAsync ? ['async'] : [], exported: isExported(node) };
          }
          if (value?.type === 'call_expression') {
            const callee = value.childForFieldName('function')?.text ?? '';
            if (callee === 'require') return null; // handled as import
          }
          if (value?.type === 'new_expression') {
            const c = value.childForFieldName('constructor');
            if (c) ctx.emitLocalType({ name, type: simpleTypeName(c.text), via: 'new' });
          }
          if (value?.type === 'object' && isExported(node)) {
            return { kind: 'constant', name, body: value, signature: oneLine(`${isConst ? 'const' : 'let'} ${name} = {…}`), doc: jsdoc(node), exported: true, declaredType };
          }
          const kind: DefSpec['kind'] = isConst ? 'constant' : 'variable';
          return { kind, name, signature: oneLine(`${isConst ? 'const' : 'let'} ${name}${t ? t.text : ''} = ${value?.text ?? ''}`, 160), doc: jsdoc(node), exported: isExported(node), declaredType };
        }
        case 'pair': {
          // methods inside an exported object literal: `export const api = { foo() {}, bar: () => {} }`
          if (ctx.scopeDef?.kind !== 'constant' || node.parent?.type !== 'object') return null;
          const key = node.childForFieldName('key');
          const value = node.childForFieldName('value');
          const fnv = functionValue(value);
          if (!key || !fnv) return null;
          return { kind: 'method', name: key.text.replace(/^["']|["']$/g, ''), body: fnv.childForFieldName('body'), signature: oneLine(`${key.text}${fnv.childForFieldName('parameters')?.text ?? '()'}`), doc: jsdoc(node), exported: true };
        }
        case 'assignment_expression': {
          // CommonJS / prototype / object-augmentation definitions:
          //   module.exports = fn | exports.x = fn | X.prototype.y = fn | app.get = fn | obj.method = fn
          const left = node.childForFieldName('left');
          const right = node.childForFieldName('right');
          if (!left || left.type !== 'member_expression') return null;
          const fnv = functionValue(right);
          const obj = left.childForFieldName('object')?.text ?? '';
          const prop = left.childForFieldName('property')?.text ?? '';
          if (!prop) return null;
          if (!fnv) {
            if (obj === 'module' && prop === 'exports' && right) {
              // module.exports = identifier -> the default export aliases a local definition
              if (right.type === 'identifier') return { kind: 'variable', name: 'module.exports', signature: oneLine(`module.exports = ${right.text}`), exported: true, meta: { default_export: true, alias_of: right.text } };
              if (right.type === 'object') return { kind: 'constant', name: 'module.exports', body: right, signature: 'module.exports = {…}', exported: true, meta: { default_export: true } };
              return null;
            }
            if (obj === 'exports' || obj === 'module.exports') {
              if (right?.type === 'identifier') {
                ctx.emitRef({ kind: 'value', name: right.text }, right);
                return null;
              }
              return { kind: 'constant', name: prop, signature: oneLine(`exports.${prop} = ${right?.text ?? ''}`, 120), doc: jsdoc(node), exported: true };
            }
            return null;
          }
          const isClass = fnv.type === 'class' || fnv.type === 'class_expression';
          const body = fnv.childForFieldName('body');
          const params = fnv.childForFieldName('parameters')?.text ?? '()';
          if (obj === 'module' && prop === 'exports') {
            const name = 'module.exports';
            return { kind: isClass ? 'class' : 'function', name, body, signature: oneLine(`module.exports = ${isClass ? 'class' : 'function'}${params}`), doc: jsdoc(node), exported: true, meta: { default_export: true } };
          }
          if (obj === 'exports' || obj === 'module.exports') {
            return { kind: isClass ? 'class' : 'function', name: prop, body, signature: oneLine(`exports.${prop} = ${isClass ? 'class' : 'function'}${params}`), doc: jsdoc(node), exported: true };
          }
          // X.prototype.method = function
          const protoMatch = obj.match(/^(.+)\.prototype$/);
          const container = protoMatch ? protoMatch[1]! : obj;
          return { kind: 'method', name: prop, body, container, signature: oneLine(`${container}.${prop} = function${params}`), doc: jsdoc(node), exported: true, meta: protoMatch ? { prototype: true } : undefined };
        }
        case 'call_expression': {
          // describe/it/test blocks
          const fn = node.childForFieldName('function');
          const callee = fn?.type === 'identifier' ? fn.text : fn?.type === 'member_expression' ? fn.childForFieldName('object')?.text ?? '' : '';
          if (fn && TEST_FNS.has(callee)) {
            const args = node.childForFieldName('arguments');
            const title = stringValue(named(args)[0]);
            const cb = named(args).find((a) => FN_TYPES.has(a.type));
            if (title !== null && cb) {
              return { kind: 'test', name: `${callee} ${title}`, body: cb.childForFieldName('body'), signature: oneLine(`${callee}("${title}")`), exported: false };
            }
          }
          return null;
        }
      }
      return null;
    },

    imports(node, ctx): Import[] | null {
      const line = node.startPosition.row + 1;
      if (node.type === 'import_statement') {
        const src = stringValue(node.childForFieldName('source'));
        if (src === null) return [];
        const isType = node.children.some((c) => c?.type === 'type');
        const clause = named(node).find((c) => c.type === 'import_clause');
        if (!clause) return [{ source: src, names: [], namespace: false, alias: '', kind: 'static', line }];
        const names: Import['names'] = [];
        let namespace = false;
        let alias = '';
        for (const c of named(clause)) {
          if (c.type === 'identifier') names.push({ name: 'default', alias: c.text });
          else if (c.type === 'namespace_import') {
            namespace = true;
            alias = named(c)[0]?.text ?? '';
          } else if (c.type === 'named_imports') {
            for (const s of named(c)) {
              if (s.type !== 'import_specifier') continue;
              const nm = s.childForFieldName('name')?.text ?? '';
              names.push({ name: nm, alias: s.childForFieldName('alias')?.text ?? nm });
            }
          }
        }
        return [{ source: src, names, namespace, alias, kind: isType ? 'type' : 'static', line }];
      }
      if (node.type === 'export_statement') {
        const src = stringValue(node.childForFieldName('source'));
        if (src !== null) {
          const names: Import['names'] = [];
          let namespace = false;
          let alias = '';
          for (const c of named(node)) {
            if (c.type === 'export_clause') {
              for (const s of named(c)) {
                if (s.type !== 'export_specifier') continue;
                const nm = s.childForFieldName('name')?.text ?? '';
                names.push({ name: nm, alias: s.childForFieldName('alias')?.text ?? nm });
              }
            } else if (c.type === 'namespace_export') {
              namespace = true;
              alias = named(c)[0]?.text ?? '';
            }
          }
          if (!names.length && !namespace) namespace = true; // export * from
          return [{ source: src, names, namespace, alias, kind: 'reexport', line }];
        }
        return null; // let walker descend to the declaration
      }
      if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
        // const x = require('y') / const {a, b} = require('y')
        const out: Import[] = [];
        for (const d of named(node)) {
          if (d.type !== 'variable_declarator') continue;
          const value = d.childForFieldName('value');
          const call = value?.type === 'call_expression' ? value : value?.type === 'member_expression' && value.childForFieldName('object')?.type === 'call_expression' ? value.childForFieldName('object') : null;
          if (!call || call.childForFieldName('function')?.text !== 'require') continue;
          const src = stringValue(named(call.childForFieldName('arguments'))[0]);
          if (src === null) continue;
          const nameNode = d.childForFieldName('name');
          if (nameNode?.type === 'identifier') {
            if (value?.type === 'member_expression') {
              const prop = value.childForFieldName('property')?.text ?? '';
              out.push({ source: src, names: [{ name: prop, alias: nameNode.text }], namespace: false, alias: '', kind: 'static', line });
            } else out.push({ source: src, names: [], namespace: true, alias: nameNode.text, kind: 'static', line });
          } else if (nameNode?.type === 'object_pattern') {
            const names: Import['names'] = [];
            for (const p of named(nameNode)) {
              if (p.type === 'shorthand_property_identifier_pattern') names.push({ name: p.text, alias: p.text });
              else if (p.type === 'pair_pattern') names.push({ name: p.childForFieldName('key')?.text ?? '', alias: p.childForFieldName('value')?.text ?? '' });
            }
            out.push({ source: src, names, namespace: false, alias: '', kind: 'static', line });
          }
        }
        return out.length ? out : null;
      }
      if (node.type === 'expression_statement') {
        // module.exports = require('./x')  -> re-export everything from ./x
        const e0 = named(node)[0];
        if (e0?.type === 'assignment_expression' && e0.childForFieldName('left')?.text === 'module.exports') {
          const r = e0.childForFieldName('right');
          if (r?.type === 'call_expression' && r.childForFieldName('function')?.text === 'require') {
            const src = stringValue(named(r.childForFieldName('arguments'))[0]);
            if (src !== null) return [{ source: src, names: [], namespace: true, alias: '', kind: 'reexport', line }];
          }
        }
        // require('side-effect')
        const e = named(node)[0];
        if (e?.type === 'call_expression' && e.childForFieldName('function')?.text === 'require') {
          const src = stringValue(named(e.childForFieldName('arguments'))[0]);
          if (src !== null) return [{ source: src, names: [], namespace: false, alias: '', kind: 'static', line }];
        }
        return null;
      }
      return null;
    },

    references(node, ctx) {
      switch (node.type) {
        case 'call_expression': {
          const fn = node.childForFieldName('function');
          const args = node.childForFieldName('arguments');
          const arity = named(args).length ?? 0;
          if (!fn) return;
          if (fn.type === 'import') {
            const src = stringValue(named(args)[0]);
            if (src !== null) ctx.emitImport({ source: src, names: [], namespace: true, alias: '', kind: 'dynamic', line: node.startPosition.row + 1 });
            return true;
          }
          if (routeFromCall(node, ctx)) {
            // still walk handlers for references
          }
          if (fn.type === 'identifier') ctx.emitRef({ kind: 'call', name: fn.text, arity }, fn);
          else if (fn.type === 'member_expression') {
            const obj = fn.childForFieldName('object');
            const prop = fn.childForFieldName('property');
            if (prop) ctx.emitRef({ kind: 'call', name: prop.text, qualifier: obj?.text ?? '', arity }, prop);
          }
          return;
        }
        case 'new_expression': {
          const c = node.childForFieldName('constructor');
          const args = node.childForFieldName('arguments');
          if (c) {
            const name = simpleTypeName(c.text);
            const q = c.type === 'member_expression' ? c.childForFieldName('object')?.text ?? '' : '';
            ctx.emitRef({ kind: 'new', name, qualifier: q, arity: named(args).length ?? 0 }, c);
          }
          return;
        }
        case 'member_expression': {
          const obj = node.childForFieldName('object');
          const prop = node.childForFieldName('property');
          if (obj?.text === 'process.env' && prop) {
            ctx.emitRef({ kind: 'config', name: prop.text }, prop);
            return true;
          }
          return;
        }
        case 'subscript_expression': {
          const obj = node.childForFieldName('object');
          const idx = node.childForFieldName('index');
          if (obj?.text === 'process.env' && idx) {
            const v = stringValue(idx);
            if (v) ctx.emitRef({ kind: 'config', name: v }, idx);
            return true;
          }
          return;
        }
        case 'decorator': {
          const expr = named(node)[0];
          const fn = expr?.type === 'call_expression' ? expr.childForFieldName('function') : expr;
          if (fn) ctx.emitRef({ kind: 'decorator', name: simpleTypeName(fn.text), qualifier: fn.text.includes('.') ? fn.text.slice(0, fn.text.lastIndexOf('.')) : '' }, fn);
          // walk args for references
          return;
        }
        case 'type_annotation':
        case 'type_arguments':
        case 'extends_type_clause':
        case 'implements_clause':
        case 'type_parameters':
        case 'as_expression':
        case 'satisfies_expression': {
          if (node.type === 'as_expression' || node.type === 'satisfies_expression') return; // descend normally
          emitTypeRefs(node, ctx);
          return true;
        }
        case 'required_parameter':
        case 'optional_parameter': {
          const pat = node.childForFieldName('pattern');
          const t = node.childForFieldName('type');
          if (pat?.type === 'identifier' && t) ctx.emitLocalType({ name: pat.text, type: simpleTypeName(t.text.replace(/^:\s*/, '')), via: 'annotation' });
          // constructor parameter properties: `constructor(private svc: Svc)` -> also a field `this.svc`
          const acc = node.children.find((c) => c?.type === 'accessibility_modifier' || c?.type === 'readonly');
          if (acc && pat?.type === 'identifier' && t) ctx.emitLocalType({ name: `this.${pat.text}`, type: simpleTypeName(t.text.replace(/^:\s*/, '')), via: 'field' });
          return;
        }
        case 'jsx_opening_element':
        case 'jsx_self_closing_element': {
          const nm = node.childForFieldName('name');
          if (nm && /^[A-Z]/.test(nm.text)) ctx.emitRef({ kind: 'value', name: simpleTypeName(nm.text), qualifier: nm.text.includes('.') ? nm.text.slice(0, nm.text.lastIndexOf('.')) : '' }, nm);
          return;
        }
        case 'identifier': {
          // bare identifier as an argument (handler passed by name) — only capitalised or inside arguments
          const p = node.parent;
          if (p && (p.type === 'arguments' || p.type === 'array' || p.type === 'pair' || p.type === 'return_statement' || p.type === 'spread_element') && !/^(undefined|null|true|false)$/.test(node.text)) {
            ctx.emitRef({ kind: 'value', name: node.text }, node);
          }
          return;
        }
      }
      return;
    },

    resolveModule(source, fromPath, _imp, project) {
      return resolveJsModule(source, fromPath, project);
    },
  };
}

const JS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'];

function withExtensions(base: string): string[] {
  const out: string[] = [];
  if (base === '') {
    for (const e of JS_EXTS) out.push(`index${e}`);
    return out;
  }
  // strip a .js extension that maps to .ts sources
  const stripped = base.replace(/\.(js|mjs|cjs|jsx)$/, (m) => (m === '.mjs' ? '.mts' : m === '.cjs' ? '.cts' : ''));
  const bases = stripped !== base ? [base, stripped] : [base];
  for (const b of bases) {
    if (/\.[cm]?[jt]sx?$/.test(b) || /\.(vue|svelte|json)$/.test(b)) out.push(b);
    for (const e of JS_EXTS) out.push(b + e);
    for (const e of JS_EXTS) out.push(`${b}/index${e}`);
  }
  return out;
}

export function resolveJsModule(source: string, fromPath: string, project: ModuleResolutionContext): string[] {
  const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  if (source.startsWith('.')) {
    const parts = (fromDir ? fromDir.split('/') : []).concat(source.split('/'));
    const stack: string[] = [];
    for (const p of parts) {
      if (p === '.' || p === '') continue;
      if (p === '..') stack.pop();
      else stack.push(p);
    }
    return withExtensions(stack.join('/'));
  }
  const out: string[] = [];
  // A workspace package (`@scope/core`, `@scope/core/sub`) is source in this repo, not a dependency.
  // Its `main`/`exports` point at `dist/`, which is never indexed, so aim straight at the sources.
  const ws = project.workspaces;
  if (ws?.size) {
    let hitName = '';
    for (const name of ws.keys()) {
      if ((source === name || source.startsWith(name + '/')) && name.length > hitName.length) hitName = name;
    }
    if (hitName) {
      const dir = ws.get(hitName)!;
      const sub = source.slice(hitName.length).replace(/^\//, '').replace(/\/$/, '');
      if (!sub) out.push(...withExtensions(`${dir}/src`), ...withExtensions(dir));
      else out.push(...withExtensions(`${dir}/src/${sub}`), ...withExtensions(`${dir}/${sub}`));
    }
  }
  const tp = project.tsPathsFor?.(fromPath) ?? project.tsPaths;
  if (tp) {
    for (const [pattern, targets] of Object.entries(tp.paths)) {
      const star = pattern.indexOf('*');
      let rest: string | null = null;
      if (star >= 0) {
        const pre = pattern.slice(0, star);
        const post = pattern.slice(star + 1);
        if (source.startsWith(pre) && source.endsWith(post) && source.length >= pre.length + post.length) rest = source.slice(pre.length, source.length - post.length);
      } else if (source === pattern) rest = '';
      if (rest === null) continue;
      for (const t of targets) {
        const target = t.replace('*', rest).replace(/^\.\//, '');
        const base = tp.baseUrl ? `${tp.baseUrl}/${target}` : target;
        out.push(...withExtensions(base.replace(/^\.\//, '')));
      }
    }
    if (tp.baseUrl !== undefined && !source.startsWith('@') && !out.length) {
      out.push(...withExtensions(tp.baseUrl ? `${tp.baseUrl}/${source}` : source));
    }
  }
  // bare specifier that matches a workspace/src path: src/foo, lib/foo
  if (source.startsWith('@/') || source.startsWith('~/')) out.push(...withExtensions('src/' + source.slice(2)));
  return out;
}

export const javascript = makeJs('javascript', 'javascript', ['.js', '.jsx', '.mjs', '.cjs']);
export const typescript = makeJs('typescript', 'typescript', ['.ts', '.mts', '.cts']);
export const tsx = makeJs('tsx', 'tsx', ['.tsx']);
