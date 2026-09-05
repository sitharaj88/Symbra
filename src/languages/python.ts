import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, simpleTypeName, precedingComments, named, kids } from '../parse/walk.js';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'route', 'api_route', 'websocket']);
const COMMENTS = new Set(['comment']);

function docstring(body: Node | null | undefined): string {
  if (!body) return '';
  const first = named(body)[0];
  if (first?.type === 'expression_statement') {
    const s = named(first)[0];
    if (s?.type === 'string') {
      let t = s.text.trim();
      t = t.replace(/^[rRuUbB]*("""|'''|"|')/, '').replace(/("""|'''|"|')$/, '');
      const lines = t.split('\n').map((l) => l.trim());
      return lines.join('\n').trim();
    }
  }
  return '';
}

function decoratorsOf(node: Node): Node[] {
  // decorated_definition -> (decorator+ definition)
  if (node.parent?.type === 'decorated_definition') {
    return named(node.parent).filter((c) => c.type === 'decorator');
  }
  return [];
}

function decoratorName(d: Node): { full: string; last: string; call: Node | null } {
  // decorator: '@' expression
  const expr = named(d)[0];
  if (!expr) return { full: '', last: '', call: null };
  if (expr.type === 'call') {
    const fn = expr.childForFieldName('function');
    const full = fn?.text ?? '';
    return { full, last: simpleTypeName(full), call: expr };
  }
  const full = expr.text;
  return { full, last: simpleTypeName(full), call: null };
}

function routeFromDecorator(d: Node): { method: string; path: string } | null {
  const { full, call } = decoratorName(d);
  if (!call) return null;
  const parts = full.split('.');
  const method = parts[parts.length - 1] ?? '';
  if (!HTTP_METHODS.has(method)) return null;
  const args = call.childForFieldName('arguments');
  const first = named(args)[0];
  if (!first || first.type !== 'string') return null;
  const path = first.text.replace(/^[rRfFuUbB]*["']|["']$/g, '');
  let verb = method.toUpperCase();
  if (method === 'route' || method === 'api_route') {
    const m = args?.text.match(/methods\s*=\s*\[([^\]]*)\]/);
    verb = m ? m[1]!.replace(/["'\s]/g, '').toUpperCase() : 'GET';
  }
  if (method === 'websocket') verb = 'WS';
  return { method: verb, path };
}

function baseClasses(node: Node): NonNullable<DefSpec["supertypes"]> {
  const sup = node.childForFieldName('superclasses');
  if (!sup) return [];
  const out: NonNullable<DefSpec["supertypes"]> = [];
  for (const c of named(sup)) {
    if (c.type === 'keyword_argument') continue; // metaclass=...
    if (c.type === 'identifier' || c.type === 'attribute') out.push({ name: c.text, kind: 'extends' });
    else if (c.type === 'subscript') {
      const v = c.childForFieldName('value');
      if (v) out.push({ name: v.text, kind: 'extends' });
    }
  }
  return out;
}

function isConstantName(n: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(n) && n.length > 1;
}

export const python: LanguageSupport = {
  id: 'python',
  grammar: 'python',
  extensions: ['.py', '.pyi'],
  classLike: new Set(['class_definition']),
  skip: new Set(['string', 'comment']),

  isTestFile(path) {
    return /(^|\/)(tests?|testing)\//.test(path) || /(^|\/)test_[^/]*\.py$/.test(path) || /_test\.py$/.test(path) || /(^|\/)conftest\.py$/.test(path);
  },

  doc(node) {
    return docstring(node.childForFieldName('body'));
  },

  moduleDoc(root) {
    return docstring(root);
  },

  definition(node, ctx): DefSpec | null {
    switch (node.type) {
      case 'function_definition': {
        const nameNode = node.childForFieldName('name');
        const name = nameNode?.text ?? '';
        if (!name) return null;
        const decs = decoratorsOf(node);
        const decNames = decs.map((d) => decoratorName(d).last);
        const modifiers: string[] = [];
        if (kids(node).some((c) => c.type === "async")) modifiers.push("async");
        let kind: DefSpec['kind'] = ctx.inClass ? 'method' : 'function';
        if (ctx.inClass && name === '__init__') kind = 'constructor';
        if (decNames.includes('property') || decNames.includes('cached_property') || decNames.some((d) => d.endsWith('.setter'))) kind = 'property';
        if (decNames.includes('staticmethod')) modifiers.push('static');
        if (decNames.includes('classmethod')) modifiers.push('classmethod');
        if (decNames.includes('abstractmethod')) modifiers.push('abstract');
        if (decNames.includes('overload')) modifiers.push('overload');
        if (name.startsWith('_') && !name.startsWith('__')) modifiers.push('private');
        const isTest = !ctx.inClass || ctx.scopeDef?.name.startsWith('Test');
        if (name.startsWith('test_') && isTest) kind = 'test';
        const params = node.childForFieldName('parameters')?.text ?? '()';
        const ret = node.childForFieldName('return_type');
        const signature = oneLine(`${modifiers.includes('async') ? 'async ' : ''}def ${name}${params}${ret ? ' -> ' + ret.text : ''}`);
        const body = node.childForFieldName('body');
        // Routes from decorators
        for (const d of decs) {
          const r = ctx.inTest ? null : routeFromDecorator(d);
          if (r) {
            const ord = ctx.emitDef({ kind: 'route', name: `${r.method} ${r.path}`, meta: { method: r.method, path: r.path, handler: name }, signature: `${r.method} ${r.path}` }, d, -1);
            void ord;
          }
        }
        const meta: DefSpec['meta'] = {};
        if (decNames.some((d) => d === 'fixture')) meta.fixture = true;
        return { kind, name, body, signature, doc: docstring(body), modifiers, exported: !name.startsWith('_'), meta: Object.keys(meta).length ? meta : undefined };
      }
      case 'class_definition': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const sup = baseClasses(node);
        const decNames = decoratorsOf(node).map((d) => decoratorName(d).last);
        const modifiers: string[] = [];
        if (decNames.includes('dataclass')) modifiers.push('dataclass');
        const body = node.childForFieldName('body');
        const supText = node.childForFieldName('superclasses')?.text ?? '';
        let kind: DefSpec['kind'] = 'class';
        if (sup.some((s) => /Protocol|ABC$/.test(s.name))) kind = 'interface';
        if (sup.some((s) => /Enum$/.test(simpleTypeName(s.name)))) kind = 'enum';
        return { kind, name, body, signature: oneLine(`class ${name}${supText}`), doc: docstring(body), modifiers, exported: !name.startsWith('_'), supertypes: sup };
      }
      case 'assignment': {
        // Module-level or class-level simple assignment: NAME = value / NAME: T = value
        const parentStmt = node.parent;
        const container = parentStmt?.parent; // block or module
        if (!parentStmt || parentStmt.type !== 'expression_statement' || !container) return null;
        const owner = container.parent;
        const topLevel = container.type === 'module';
        const inClassBody = container.type === 'block' && owner?.type === 'class_definition';
        if (!topLevel && !inClassBody) return null;
        const left = node.childForFieldName('left');
        if (!left || left.type !== 'identifier') return null;
        const name = left.text;
        if (name === '__all__' || name === '__slots__') return null;
        const typeNode = node.childForFieldName('type');
        const right = node.childForFieldName('right');
        let declaredType = typeNode ? simpleTypeName(typeNode.text) : undefined;
        if (!declaredType && right?.type === 'call') {
          const fn = right.childForFieldName('function');
          const callee = simpleTypeName(fn?.text ?? '');
          if (/^[A-Z]/.test(callee)) declaredType = callee;
        }
        const kind: DefSpec['kind'] = inClassBody ? (ctx.scopeDef?.kind === 'enum' ? 'enum_member' : 'field') : isConstantName(name) ? 'constant' : 'variable';
        if (topLevel && isConstantName(name)) {
          /* constant */
        }
        const sig = oneLine(`${name}${typeNode ? ': ' + typeNode.text : ''} = ${right?.text ?? '...'}`, 160);
        return { kind, name, signature: sig, declaredType, exported: !name.startsWith('_'), doc: precedingComments(parentStmt, COMMENTS) };
      }
      case 'type_alias_statement': {
        const name = named(node)[0]?.text ?? '';
        if (!name) return null;
        return { kind: 'type_alias', name, signature: oneLine(node.text, 160), exported: true };
      }
    }
    return null;
  },

  imports(node, ctx): Import[] | null {
    const line = node.startPosition.row + 1;
    if (node.type === 'import_statement') {
      const out: Import[] = [];
      for (const c of named(node)) {
        if (c.type === 'dotted_name') {
          out.push({ source: c.text, names: [], namespace: true, alias: c.text.split('.')[0]!, kind: 'static', line });
        } else if (c.type === 'aliased_import') {
          const nm = c.childForFieldName('name')?.text ?? '';
          const al = c.childForFieldName('alias')?.text ?? nm;
          out.push({ source: nm, names: [], namespace: true, alias: al, kind: 'static', line });
        }
      }
      return out;
    }
    if (node.type === 'import_from_statement' || node.type === 'future_import_statement') {
      if (node.type === 'future_import_statement') return [];
      const mod = node.childForFieldName('module_name');
      let source = '';
      let relativeLevel = 0;
      if (mod?.type === 'relative_import') {
        const prefix = named(mod).find((c) => c.type === 'import_prefix');
        relativeLevel = prefix ? prefix.text.length : 0;
        const dn = named(mod).find((c) => c.type === 'dotted_name');
        source = dn?.text ?? '';
      } else source = mod?.text ?? '';
      const names: Import['names'] = [];
      let wildcard = false;
      for (const c of named(node)) {
        if (c === mod) continue;
        if (c.type === 'dotted_name') names.push({ name: c.text, alias: c.text });
        else if (c.type === 'aliased_import') {
          const nm = c.childForFieldName('name')?.text ?? '';
          names.push({ name: nm, alias: c.childForFieldName('alias')?.text ?? nm });
        } else if (c.type === 'wildcard_import') wildcard = true;
      }
      const isType = ctx.text(node.parent?.parent?.childForFieldName?.('condition') ?? null).includes('TYPE_CHECKING');
      return [{ source, names, namespace: wildcard, alias: '', kind: isType ? 'type' : 'static', line, relativeLevel }];
    }
    return null;
  },

  references(node, ctx) {
    switch (node.type) {
      case 'call': {
        const fn = node.childForFieldName('function');
        const args = node.childForFieldName('arguments');
        const arity = named(args).length ?? 0;
        if (!fn) return;
        if (fn.type === 'identifier') {
          // os.getenv / getenv
          ctx.emitRef({ kind: /^[A-Z]/.test(fn.text) ? 'new' : 'call', name: fn.text, arity }, fn);
        } else if (fn.type === 'attribute') {
          const obj = fn.childForFieldName('object');
          const attr = fn.childForFieldName('attribute');
          if (attr) {
            let q = obj?.text ?? '';
            if (/^super\(.*\)$/.test(q)) q = 'super';
            if ((q === 'os' && (attr.text === 'getenv' || attr.text === 'environ')) || q === 'os.environ') {
              const first = named(args)[0];
              if (first?.type === 'string') ctx.emitRef({ kind: 'config', name: first.text.replace(/^["']|["']$/g, '') }, first);
            }
            ctx.emitRef({ kind: 'call', name: attr.text, qualifier: q, arity }, attr);
          }
        }
        return;
      }
      case 'subscript': {
        // os.environ["X"]
        const v = node.childForFieldName('value');
        const s = node.childForFieldName('subscript');
        if (v?.text === 'os.environ' && s?.type === 'string') {
          ctx.emitRef({ kind: 'config', name: s.text.replace(/^["']|["']$/g, '') }, s);
        }
        return;
      }
      case 'decorator': {
        const { full, last } = decoratorName(node);
        if (last) ctx.emitRef({ kind: 'decorator', name: last, qualifier: full.includes('.') ? full.slice(0, full.lastIndexOf('.')) : '' }, node);
        return true;
      }
      case 'typed_parameter':
      case 'typed_default_parameter': {
        const nm = named(node)[0];
        const t = node.childForFieldName('type');
        if (nm?.type === 'identifier' && t) {
          ctx.emitLocalType({ name: nm.text, type: simpleTypeName(t.text), via: 'annotation' });
          emitTypeRefs(t, ctx);
        }
        return true;
      }
      case 'type': {
        emitTypeRefs(node, ctx);
        return true;
      }
      case 'assignment': {
        // local: x = Foo(...) / x: T = ...
        const left = node.childForFieldName('left');
        const t = node.childForFieldName('type');
        const right = node.childForFieldName('right');
        if (left && (left.type === 'identifier' || left.type === 'attribute')) {
          const name = left.text; // may be self.x
          if (t) ctx.emitLocalType({ name, type: simpleTypeName(t.text), via: 'annotation' });
          else if (right?.type === 'call') {
            const callee = simpleTypeName(right.childForFieldName('function')?.text ?? '');
            if (/^[A-Z]/.test(callee)) ctx.emitLocalType({ name, type: callee, via: 'constructor_call' });
          }
        }
        return;
      }
      case 'identifier': {
        // bare name in value position: call argument, keyword value, list element, dict value
        const p = node.parent;
        if (!p) return;
        const inArgs = p.type === 'argument_list' || p.type === 'list' || ((p.type === 'keyword_argument' || p.type === 'pair') && p.childForFieldName('value')?.id === node.id);
        if (inArgs && !/^(None|True|False|self|cls)$/.test(node.text)) ctx.emitRef({ kind: 'value', name: node.text }, node);
        return;
      }
    }
    return;
  },

  resolveModule(source, fromPath, imp, project) {
    const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
    const candidates: string[] = [];
    const lvl = imp.relativeLevel ?? 0;
    const modPath = source.replace(/\./g, '/');
    if (lvl > 0) {
      let base = fromDir;
      for (let i = 1; i < lvl; i++) base = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
      const p = base ? (modPath ? `${base}/${modPath}` : base) : modPath;
      candidates.push(`${p}.py`, `${p}/__init__.py`);
      // from . import X  -> X might be a submodule
      for (const n of imp.names) candidates.push(`${p}/${n.name}.py`, `${p}/${n.name}/__init__.py`);
      return candidates;
    }
    const roots = ['', ...(project.pythonRoots ?? [])];
    for (const r of roots) {
      const p = r ? `${r}/${modPath}` : modPath;
      candidates.push(`${p}.py`, `${p}/__init__.py`);
      for (const n of imp.names) candidates.push(`${p}/${n.name}.py`, `${p}/${n.name}/__init__.py`);
    }
    return candidates;
  },
};

function emitTypeRefs(t: Node, ctx: WalkContext) {
  const stack: Node[] = [t];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'identifier') {
      if (/^[A-Z]/.test(n.text)) ctx.emitRef({ kind: 'type', name: n.text }, n);
    } else if (n.type === 'attribute') {
      const attr = n.childForFieldName('attribute');
      const obj = n.childForFieldName('object');
      if (attr && /^[A-Z]/.test(attr.text)) ctx.emitRef({ kind: 'type', name: attr.text, qualifier: obj?.text ?? '' }, attr);
      continue;
    } else if (n.type === 'string') continue;
    for (const c of named(n)) stack.push(c);
  }
}
