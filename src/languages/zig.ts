import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, simpleTypeName, precedingComments, named, kids } from '../parse/walk.js';

const COMMENTS = new Set(['comment']);
const CONTAINERS = new Set(['struct_declaration', 'enum_declaration', 'union_declaration', 'opaque_declaration']);
const KEYWORDS = new Set(['pub', 'const', 'var', 'extern', 'export', 'inline', 'noinline', 'comptime', 'threadlocal', 'packed', 'usingnamespace']);
const ENV_FNS = /^(getenv|getEnvVarOwned|getEnvMap|hasEnvVar|hasEnvVarConstant|getenvZ)$/;

function keywordsOf(node: Node): string[] {
  return kids(node).filter((c) => !c.isNamed && KEYWORDS.has(c.type)).map((c) => c.type);
}

/** `*const Foo`, `?[]const u8`, `std.mem.Allocator` → `Foo`, `u8`, `Allocator`. */
function zigType(t: string): string {
  let s = t.trim();
  for (;;) {
    const n = s.replace(/^(\?|\*|\[[^\]]*\]|const\s+|volatile\s+|allowzero\s+|!|anyerror!|\banytype\b)/, '');
    if (n === s) break;
    s = n;
  }
  const paren = s.indexOf('(');
  if (paren > 0) s = s.slice(0, paren);
  return simpleTypeName(s);
}

function builtinName(n: Node | null | undefined): string {
  if (!n || n.type !== 'builtin_function') return '';
  return named(n).find((c) => c.type === 'builtin_identifier')?.text ?? '';
}

function stringContent(n: Node | null | undefined): string | null {
  if (!n || n.type !== 'string') return null;
  return named(n).filter((c) => c.type === 'string_content').map((c) => c.text).join('') || n.text.replace(/^"|"$/g, '');
}

function importSource(value: Node | null | undefined): string | null {
  if (builtinName(value) !== '@import') return null;
  const args = named(value).find((c) => c.type === 'arguments');
  return stringContent(named(args)[0]);
}

/** Parts of a `variable_declaration`: name, declared type, value expression. */
function declParts(node: Node): { nameNode: Node | null; typeNode: Node | null; value: Node | null } {
  const nameNode = named(node).find((c) => c.type === 'identifier') ?? null;
  const typeNode = node.childForFieldName('type');
  const rest = named(node).filter((c) => !(nameNode && c.equals(nameNode)) && !(typeNode && c.equals(typeNode)) && c.type !== 'comment');
  return { nameNode, typeNode, value: rest[rest.length - 1] ?? null };
}

/** `Foo.init(...)` / `Foo{ … }` / `std.ArrayList(u8).init(a)` → `Foo` / `ArrayList`. */
function ctorType(value: Node | null): string | undefined {
  if (!value) return undefined;
  if (value.type === 'struct_initializer') {
    const t = named(value)[0];
    if (t && (t.type === 'identifier' || t.type === 'field_expression')) return zigType(t.text);
    return undefined;
  }
  if (value.type === 'call_expression') {
    const fn = value.childForFieldName('function');
    if (fn?.type === 'field_expression') {
      const obj = fn.childForFieldName('object');
      const member = fn.childForFieldName('member')?.text ?? '';
      if (obj && /^(init|create|new|from|open|initCapacity|fromOwnedSlice|parse)/.test(member)) {
        const t = zigType(obj.text);
        if (/^[A-Z]/.test(t)) return t;
      }
    }
  }
  return undefined;
}

function emitTypeRefs(t: Node | null | undefined, ctx: WalkContext) {
  if (!t) return;
  const stack: Node[] = [t];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'identifier') {
      if (/^[A-Z]/.test(n.text)) ctx.emitRef({ kind: 'type', name: n.text }, n);
      continue;
    }
    if (n.type === 'field_expression') {
      const member = n.childForFieldName('member');
      const obj = n.childForFieldName('object');
      if (member && /^[A-Z]/.test(member.text)) ctx.emitRef({ kind: 'type', name: member.text, qualifier: obj?.text ?? '' }, member);
      continue;
    }
    if (n.type === 'builtin_type' || n.type === 'string' || n.type === 'integer') continue;
    if (n.type === 'call_expression') {
      const fn = n.childForFieldName('function');
      if (fn) stack.push(fn);
      continue;
    }
    for (const c of named(n)) stack.push(c);
  }
}

function isTopLevel(node: Node): boolean {
  const p = node.parent?.type ?? '';
  return p === 'source_file' || CONTAINERS.has(p);
}

function headText(node: Node, body: Node | null | undefined): string {
  return oneLine((body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text).replace(/[{;]\s*$/, ''));
}

function joinPath(dir: string, rel: string): string {
  const parts = (dir ? dir.split('/') : []).concat(rel.split('/'));
  const stack: string[] = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') stack.pop();
    else stack.push(p);
  }
  return stack.join('/');
}

export const zig: LanguageSupport = {
  id: 'zig',
  grammar: 'zig',
  extensions: ['.zig'],
  classLike: new Set(CONTAINERS),
  skip: new Set(['comment', 'string', 'multiline_string']),

  isTestFile(path) {
    return /(^|\/)tests?\//.test(path) || /_test\.zig$/.test(path) || /(^|\/)test_[^/]*\.zig$/.test(path) || /(^|\/)tests?\.zig$/.test(path);
  },

  doc(node) {
    return precedingComments(node, COMMENTS);
  },

  moduleDoc(root) {
    const parts: string[] = [];
    for (const c of named(root)) {
      if (c.type !== 'comment' || !c.text.startsWith('//!')) break;
      parts.push(c.text.replace(/^\/\/!\s?/, '').trimEnd());
    }
    return parts.join('\n').trim();
  },

  definition(node, ctx): DefSpec | null {
    switch (node.type) {
      case 'variable_declaration': {
        const { nameNode, typeNode, value } = declParts(node);
        const name = nameNode?.text ?? '';
        if (!name || name === '_') return null;
        if (importSource(value) !== null) return null; // import
        const ks = keywordsOf(node);
        const isPub = ks.includes('pub');
        const mods = ks.filter((k) => k !== 'const' && k !== 'var');
        const doc = precedingComments(node, COMMENTS);
        if (value && CONTAINERS.has(value.type)) {
          const vk = kids(value).filter((c) => !c.isNamed).map((c) => c.type);
          const meta: DefSpec['meta'] = {};
          let kind: DefSpec['kind'] = 'struct';
          if (value.type === 'enum_declaration') kind = 'enum';
          if (value.type === 'union_declaration') meta.union = true;
          if (value.type === 'opaque_declaration') meta.opaque = true;
          if (vk.includes('packed')) mods.push('packed');
          if (vk.includes('extern')) mods.push('extern');
          const kwText = value.type.replace('_declaration', '');
          return { kind, name, body: value, signature: oneLine(`${isPub ? 'pub ' : ''}const ${name} = ${mods.filter((m) => m !== 'pub').join(' ')}${mods.length > (isPub ? 1 : 0) ? ' ' : ''}${kwText}`), doc, modifiers: mods, exported: isPub, meta: Object.keys(meta).length ? meta : undefined };
        }
        if (value?.type === 'error_set_declaration') {
          return { kind: 'enum', name, body: value, signature: oneLine(node.text, 120), doc, modifiers: mods, exported: isPub, meta: { error_set: true } };
        }
        if (!isTopLevel(node)) return null; // locals are recorded as type facts in references()
        if (/^[A-Z]/.test(name) && value && (value.type === 'identifier' || value.type === 'field_expression' || value.type === 'call_expression') && !typeNode) {
          // `const Allocator = std.mem.Allocator;` / `const List = std.ArrayList(u8);`
          return { kind: 'type_alias', name, signature: oneLine(node.text, 160), doc, modifiers: mods, exported: isPub, declaredType: zigType(value.text) };
        }
        const declaredType = typeNode ? zigType(typeNode.text) : ctorType(value);
        return { kind: ks.includes('var') ? 'variable' : 'constant', name, signature: oneLine(node.text, 160), doc, modifiers: mods, exported: isPub, declaredType };
      }
      case 'function_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const ks = keywordsOf(node);
        const body = node.childForFieldName('body');
        return { kind: ctx.inClass ? 'method' : 'function', name, body, signature: headText(node, body), doc: precedingComments(node, COMMENTS), modifiers: ks, exported: ks.includes('pub') || ks.includes('export') };
      }
      case 'test_declaration': {
        const s = named(node).find((c) => c.type === 'string');
        const title = stringContent(s) ?? (named(node).find((c) => c.type === 'identifier')?.text ?? '');
        const name = title || `test:${node.startPosition.row + 1}`;
        return { kind: 'test', name, body: named(node).find((c) => c.type === 'block'), signature: oneLine(`test "${name}"`), doc: precedingComments(node, COMMENTS), exported: false };
      }
      case 'container_field': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const t = node.childForFieldName('type');
        const inEnum = node.parent?.type === 'enum_declaration';
        return { kind: inEnum ? 'enum_member' : 'field', name, signature: oneLine(node.text, 120), doc: precedingComments(node, COMMENTS), exported: true, declaredType: t ? zigType(t.text) : undefined };
      }
      case 'identifier': {
        if (node.parent?.type === 'error_set_declaration') return { kind: 'enum_member', name: node.text, signature: node.text, exported: true };
        return null;
      }
    }
    return null;
  },

  imports(node): Import[] | null {
    if (node.type !== 'variable_declaration') return null;
    const { nameNode, value } = declParts(node);
    const source = importSource(value);
    if (source === null) return null;
    return [{ source, names: [], namespace: true, alias: nameNode?.text ?? '', kind: 'static', line: node.startPosition.row + 1 }];
  },

  references(node, ctx) {
    switch (node.type) {
      case 'call_expression': {
        const fn = node.childForFieldName('function');
        if (!fn) return;
        const arity = Math.max(0, named(node).length - 1);
        if (fn.type === 'identifier') {
          ctx.emitRef({ kind: 'call', name: fn.text, arity }, fn);
        } else if (fn.type === 'field_expression') {
          const obj = fn.childForFieldName('object');
          const member = fn.childForFieldName('member');
          if (!member) return;
          const q = obj?.text ?? '';
          if (/^std\.(os|posix|process)$/.test(q) && ENV_FNS.test(member.text)) {
            const key = stringContent(named(node).find((c) => c.type === 'string'));
            if (key) ctx.emitRef({ kind: 'config', name: key }, member);
          }
          ctx.emitRef({ kind: 'call', name: member.text, qualifier: q, arity }, member);
        }
        return;
      }
      case 'struct_initializer': {
        const t = named(node)[0];
        if (t && (t.type === 'identifier' || t.type === 'field_expression')) {
          const q = t.type === 'field_expression' ? (t.childForFieldName('object')?.text ?? '') : '';
          ctx.emitRef({ kind: 'new', name: zigType(t.text), qualifier: q }, t);
        }
        return;
      }
      case 'builtin_function': {
        if (builtinName(node) === '@import' && node.parent?.type !== 'variable_declaration') {
          const src = importSource(node);
          if (src !== null) ctx.emitImport({ source: src, names: [], namespace: true, alias: '', kind: node.parent?.type === 'using_namespace_declaration' ? 'reexport' : 'static', line: node.startPosition.row + 1 });
          return true;
        }
        return;
      }
      case 'parameter': {
        const nameNode = node.childForFieldName('name');
        const t = node.childForFieldName('type');
        if (nameNode && t) ctx.emitLocalType({ name: nameNode.text, type: zigType(t.text), via: 'annotation' });
        emitTypeRefs(t, ctx);
        return true;
      }
      case 'variable_declaration': {
        const { nameNode, typeNode, value } = declParts(node);
        emitTypeRefs(typeNode, ctx);
        if (!nameNode || nameNode.text === '_') return;
        if (isTopLevel(node)) {
          // `const Allocator = std.mem.Allocator;` — the alias target is a type reference
          if (/^[A-Z]/.test(nameNode.text) && value && (value.type === 'identifier' || value.type === 'field_expression' || value.type === 'call_expression')) emitTypeRefs(value, ctx);
          return;
        }
        if (typeNode) ctx.emitLocalType({ name: nameNode.text, type: zigType(typeNode.text), via: 'annotation' });
        else {
          const t = ctorType(value);
          if (t) ctx.emitLocalType({ name: nameNode.text, type: t, via: 'constructor_call' });
        }
        return;
      }
      case 'function_declaration':
      case 'container_field': {
        emitTypeRefs(node.childForFieldName('type'), ctx);
        return;
      }
    }
    return;
  },

  resolveModule(source, fromPath) {
    if (/^(std|builtin|root)$/.test(source)) return [];
    const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
    if (source.endsWith('.zig') || source.includes('/')) return [joinPath(fromDir, source), joinPath('', source)];
    return [`${source}.zig`, `src/${source}.zig`, `${source}/src/root.zig`, `${source}/src/main.zig`, `${source}/src/${source}.zig`, `${source}/${source}.zig`, `lib/${source}/src/root.zig`, `lib/${source}.zig`, `deps/${source}/src/root.zig`, `vendor/${source}/src/root.zig`];
  },
};
