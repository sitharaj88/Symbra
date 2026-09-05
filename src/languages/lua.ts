import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, simpleTypeName, named } from '../parse/walk.js';

const TEST_FNS = new Set(['describe', 'it', 'context', 'test', 'pending']);
const LUA_BUILTINS = new Set(['print', 'pairs', 'ipairs', 'type', 'tostring', 'tonumber', 'require', 'setmetatable', 'getmetatable', 'rawget', 'rawset', 'rawequal', 'rawlen', 'pcall', 'xpcall', 'error', 'assert', 'select', 'unpack', 'next', 'load', 'loadstring', 'dofile', 'loadfile', 'collectgarbage', 'module']);

/** Clean `--` / `---` / `--[[ ]]` comments. */
function cleanLua(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^--\[=*\[/, '').replace(/\]=*\]$/, '');
  const lines = s.split('\n').map((l) => l.replace(/^\s*-{2,}\s?/, '').trimEnd());
  while (lines.length && !lines[0]?.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]?.trim()) lines.pop();
  return lines.join('\n').trim();
}

function luaDoc(node: Node): string {
  const parts: string[] = [];
  let prev = node.previousSibling;
  let lastStart = node.startPosition.row;
  while (prev && prev.type === 'comment') {
    if (lastStart - prev.endPosition.row > 1) break;
    parts.unshift(prev.text);
    lastStart = prev.startPosition.row;
    prev = prev.previousSibling;
  }
  return parts.length ? cleanLua(parts.join('\n')) : '';
}

function stringValue(n: Node | null | undefined): string | null {
  if (!n || n.type !== 'string') return null;
  return n.text.replace(/^(\[=*\[|["'])/, '').replace(/(\]=*\]|["'])$/, '');
}

/** Split a `variable` node: `x` / `a.b` / `a:b`. */
function varParts(v: Node): { name: string; container: string; method: boolean } | null {
  if (v.type === 'identifier') return { name: v.text, container: '', method: false };
  if (v.type !== 'variable') return null;
  const n = v.childForFieldName('name');
  if (n) return { name: n.text, container: '', method: false };
  const table = v.childForFieldName('table');
  const field = v.childForFieldName('field');
  const method = v.childForFieldName('method');
  const name = (field ?? method)?.text ?? '';
  if (!name || !table) return null;
  return { name, container: table.text, method: !!method };
}

function argNodes(call: Node): Node[] {
  const al = call.childForFieldName('arguments');
  const first = named(al)[0];
  if (!first) return [];
  if (first.type === 'expression_list') return named(first);
  return [first];
}

function requireSource(n: Node | null | undefined): string | null {
  if (!n || n.type !== 'call') return null;
  const fn = n.childForFieldName('function');
  if (fn?.childForFieldName('name')?.text !== 'require') return null;
  return stringValue(argNodes(n)[0]);
}

/** `Widget.new()` / `Widget()` → `Widget`. */
function ctorType(val: Node | null | undefined): string | undefined {
  if (!val || val.type !== 'call') return undefined;
  const fn = val.childForFieldName('function');
  if (!fn) return undefined;
  const p = varParts(fn);
  if (!p) return undefined;
  if (!p.container && /^[A-Z]/.test(p.name)) return p.name;
  if (p.container && /^[A-Z]/.test(simpleTypeName(p.container)) && /^(new|create|init|from|of)/.test(p.name)) return simpleTypeName(p.container);
  return undefined;
}

function pairs(node: Node): { v: Node; val: Node | null }[] {
  const vars = named(named(node).find((c) => c.type === 'variable_list'));
  const vals = named(named(node).find((c) => c.type === 'expression_list'));
  return vars.map((v, i) => ({ v, val: vals[i] ?? null }));
}

function assignmentDef(v: Node, val: Node | null, local: boolean, top: boolean, node: Node, ctx: WalkContext): DefSpec | null {
  const p = varParts(v);
  if (!p || p.name.startsWith('__')) return null;
  if (val?.type === 'function_definition') {
    const params = val.childForFieldName('parameters');
    const kind: DefSpec['kind'] = p.container ? 'method' : 'function';
    return { kind, name: p.name, container: p.container || undefined, body: val.childForFieldName('body'), signature: oneLine(`${local ? 'local ' : ''}${v.text} = function(${params?.text ?? ''})`), doc: luaDoc(node), modifiers: local ? ['local'] : [], exported: !local, meta: p.method ? { self: true } : undefined };
  }
  if (!top) return null;
  const isConst = /^[A-Z][A-Z0-9_]*$/.test(p.name) && p.name.length > 1;
  const kind: DefSpec['kind'] = isConst ? 'constant' : 'variable';
  const declaredType = ctorType(val);
  const isTable = val?.type === 'table';
  void ctx;
  return { kind, name: p.name, container: p.container || undefined, body: isTable ? val : undefined, signature: oneLine(`${local ? 'local ' : ''}${v.text}${val ? ' = ' + (isTable ? '{…}' : val.text) : ''}`, 160), doc: luaDoc(node), modifiers: local ? ['local'] : [], exported: !local || isTable, declaredType };
}

export const lua: LanguageSupport = {
  id: 'lua',
  grammar: 'lua',
  extensions: ['.lua'],
  classLike: new Set(),
  skip: new Set(['comment', 'string']),

  isTestFile(path) {
    return /(^|\/)(spec|tests?)\//.test(path) || /_spec\.lua$/.test(path) || /_test\.lua$/.test(path);
  },

  doc(node) {
    return luaDoc(node);
  },

  moduleDoc(root) {
    const parts: string[] = [];
    for (const c of named(root)) {
      if (c.type === 'shebang') continue;
      if (c.type !== 'comment') break;
      parts.push(c.text);
    }
    return parts.length ? cleanLua(parts.join('\n')) : '';
  },

  definition(node, ctx): DefSpec | null {
    switch (node.type) {
      case 'function_definition_statement': {
        const nm = node.childForFieldName('name');
        if (!nm) return null;
        const p = varParts(nm);
        if (!p) return null;
        const params = node.childForFieldName('parameters');
        const kind: DefSpec['kind'] = p.container ? 'method' : 'function';
        return { kind, name: p.name, container: p.container || undefined, body: node.childForFieldName('body'), signature: oneLine(`function ${nm.text}(${params?.text ?? ''})`), doc: luaDoc(node), exported: true, meta: p.method ? { self: true } : undefined };
      }
      case 'local_function_definition_statement': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const params = node.childForFieldName('parameters');
        return { kind: 'function', name, body: node.childForFieldName('body'), signature: oneLine(`local function ${name}(${params?.text ?? ''})`), doc: luaDoc(node), modifiers: ['local'], exported: false };
      }
      case 'local_variable_declaration':
      case 'variable_assignment': {
        const local = node.type === 'local_variable_declaration';
        const top = node.parent?.type === 'chunk';
        const ps = pairs(node);
        if (ps.some(({ val }) => requireSource(val) !== null)) return null; // import
        const specs = ps.map(({ v, val }) => ({ v, spec: assignmentDef(v, val, local, top, node, ctx) }));
        const first = specs.find((s) => s.spec);
        if (!first) return null;
        for (const s of specs) if (s.spec && s !== first) ctx.emitDef(s.spec, s.v, ctx.scope);
        return first.spec;
      }
      case 'field': {
        // `local M = { foo = function() end }`
        const holder = ctx.scopeDef;
        if (!holder || (holder.kind !== 'variable' && holder.kind !== 'constant') || node.parent?.type !== 'table') return null;
        const key = node.childForFieldName('name') ?? node.childForFieldName('key');
        const value = node.childForFieldName('value');
        if (!key || key.type !== 'identifier' || value?.type !== 'function_definition') return null;
        const params = value.childForFieldName('parameters');
        return { kind: 'method', name: key.text, body: value.childForFieldName('body'), signature: oneLine(`${key.text} = function(${params?.text ?? ''})`), doc: luaDoc(node), exported: holder.exported };
      }
      case 'call': {
        // busted: describe("…", function() … end) / it("…", function() … end)
        const fn = node.childForFieldName('function');
        const callee = fn?.childForFieldName('name')?.text ?? '';
        if (!TEST_FNS.has(callee)) return null;
        const args = argNodes(node);
        const title = stringValue(args[0]);
        const cb = args.find((a) => a.type === 'function_definition');
        if (title === null || !cb) return null;
        return { kind: 'test', name: `${callee} ${title}`, body: cb.childForFieldName('body'), signature: oneLine(`${callee}("${title}")`), exported: false };
      }
    }
    return null;
  },

  imports(node): Import[] | null {
    const line = node.startPosition.row + 1;
    if (node.type === 'local_variable_declaration' || node.type === 'variable_assignment') {
      const out: Import[] = [];
      for (const { v, val } of pairs(node)) {
        const src = requireSource(val);
        if (src === null) continue;
        out.push({ source: src, names: [], namespace: true, alias: v.text, kind: 'static', line });
      }
      return out.length ? out : null;
    }
    if (node.type === 'call' && (node.parent?.type === 'chunk' || node.parent?.type === 'block')) {
      const src = requireSource(node);
      if (src !== null) return [{ source: src, names: [], namespace: false, alias: '', kind: 'static', line }];
    }
    return null;
  },

  references(node, ctx) {
    switch (node.type) {
      case 'call': {
        const fn = node.childForFieldName('function');
        if (!fn) return;
        const p = varParts(fn);
        if (!p) return;
        const arity = argNodes(node).length;
        if (!p.container) {
          if (LUA_BUILTINS.has(p.name)) return;
          ctx.emitRef({ kind: /^[A-Z]/.test(p.name) ? 'new' : 'call', name: p.name, arity }, fn.childForFieldName('name') ?? fn);
          return;
        }
        const nameNode = fn.childForFieldName('field') ?? fn.childForFieldName('method') ?? fn;
        if (p.container === 'os' && p.name === 'getenv') {
          const key = stringValue(argNodes(node)[0]);
          if (key) ctx.emitRef({ kind: 'config', name: key }, nameNode);
        }
        ctx.emitRef({ kind: 'call', name: p.name, qualifier: p.container, arity }, nameNode);
        return;
      }
      case 'local_variable_declaration':
      case 'variable_assignment': {
        if (node.parent?.type === 'chunk') return;
        for (const { v, val } of pairs(node)) {
          const t = ctorType(val);
          if (t) ctx.emitLocalType({ name: v.text, type: t, via: 'constructor_call' });
        }
        return;
      }
    }
    return;
  },

  resolveModule(source, fromPath) {
    const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
    const p = source.includes('/') ? source.replace(/\.lua$/, '') : source.replace(/\./g, '/');
    const out = [`${p}.lua`, `${p}/init.lua`];
    if (fromDir) out.push(`${fromDir}/${p}.lua`, `${fromDir}/${p}/init.lua`);
    for (const root of ['lua', 'src', 'lib']) out.push(`${root}/${p}.lua`, `${root}/${p}/init.lua`);
    return out;
  },
};
