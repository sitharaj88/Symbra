import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, simpleTypeName, precedingComments, named, kids } from '../parse/walk.js';

const COMMENTS = new Set(['comment']);
const VISIBILITY = new Set(['public', 'external', 'internal', 'private']);
const MUTABILITY = new Set(['pure', 'view', 'payable', 'constant']);
/** Foundry cheatcode receivers whose `env*` calls read configuration. */
const CHEAT_RECEIVERS = new Set(['vm', 'cheats', 'cheatCodes']);

/** Unwrap the grammar's generic `expression` / `statement` wrappers. */
function unwrap(n: Node | null | undefined): Node | null {
  let cur: Node | null | undefined = n;
  while (cur && (cur.type === 'expression' || cur.type === 'statement')) {
    const inner = named(cur);
    if (inner.length !== 1) break;
    cur = inner[0];
  }
  return cur ?? null;
}

function natspec(node: Node): string {
  return precedingComments(node, COMMENTS);
}

/** Simplify a `type_name` to a single name usable for receiver typing. */
function typeText(t: Node | null | undefined): string {
  if (!t) return '';
  const raw = t.text.trim();
  // mapping(K => V) / mapping(K => mapping(K2 => V)) -> the innermost value type
  if (raw.startsWith('mapping')) {
    let cur: Node = t;
    for (let guard = 0; guard < 8; guard++) {
      const v = cur.childForFieldName('value_type');
      if (!v) break;
      cur = v;
    }
    return cur === t ? raw : typeText(cur);
  }
  return simpleTypeName(raw.replace(/\s+/g, ' '));
}

function paramsText(node: Node): string {
  const ps = kids(node).filter((c) => c.type === 'parameter');
  return `(${ps.map((p) => oneLine(p.text)).join(', ')})`;
}

function funcModifiers(node: Node): string[] {
  const out: string[] = [];
  for (const c of kids(node)) {
    if (c.type === 'visibility' || c.type === 'state_mutability') out.push(c.text.trim());
    else if (c.type === 'virtual' || c.text === 'virtual') out.push('virtual');
    else if (c.type === 'override_specifier') out.push('override');
  }
  return [...new Set(out.filter((m) => VISIBILITY.has(m) || MUTABILITY.has(m) || m === 'virtual' || m === 'override'))];
}

function isTestPath(path: string): boolean {
  return /(\.t|Test|\.test)\.sol$/i.test(path) || /(^|\/)test\//i.test(path);
}

/** A Foundry test lives in a test file or in a contract named `*Test` / inheriting `Test`. */
function inTestContract(ctx: WalkContext): boolean {
  const owner = ctx.scopeDef;
  if (!owner) return false;
  if (/Test$/.test(owner.name)) return true;
  return owner.supertypes.some((s) => /^(Test|DSTest|StdCheats|TestBase)$/.test(s.name));
}

function inheritance(node: Node): { name: string; kind: 'extends' | 'implements' }[] {
  const out: { name: string; kind: 'extends' | 'implements' }[] = [];
  for (const c of kids(node)) {
    if (c.type !== 'inheritance_specifier') continue;
    const a = c.childForFieldName('ancestor');
    const name = simpleTypeName(a?.text ?? c.text);
    if (name) out.push({ name, kind: 'extends' });
  }
  return out;
}

function stringArg(call: Node, index = 0): string | null {
  const args = kids(call).filter((c) => c.type === 'call_argument');
  const a = unwrap(named(args[index])[0] ?? null);
  if (!a) return null;
  if (a.type !== 'string_literal') return null;
  return a.text.replace(/^['"]|['"]$/g, '');
}

export const solidity: LanguageSupport = {
  id: 'solidity',
  grammar: 'solidity',
  extensions: ['.sol'],
  classLike: new Set(['contract_declaration', 'interface_declaration', 'library_declaration', 'struct_declaration', 'enum_declaration']),
  skip: new Set(['comment', 'string_literal', 'hex_string_literal', 'unicode_string_literal']),

  isTestFile: isTestPath,

  doc(node) {
    return natspec(node);
  },

  moduleDoc(root) {
    for (const c of named(root)) {
      if (c.type !== 'comment') continue;
      if (/SPDX-License-Identifier/.test(c.text)) continue;
      // Only a leading block comment counts as file documentation.
      if (c.text.startsWith('/**')) return precedingComments(c.nextSibling ?? c, COMMENTS) || oneLine(c.text);
      return '';
    }
    return '';
  },

  definition(node, ctx): DefSpec | null {
    switch (node.type) {
      case 'contract_declaration':
      case 'interface_declaration':
      case 'library_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const sup = inheritance(node);
        const isAbstract = kids(node).some((c) => c.text === 'abstract' && !c.isNamed);
        const keyword = node.type === 'interface_declaration' ? 'interface' : node.type === 'library_declaration' ? 'library' : `${isAbstract ? 'abstract ' : ''}contract`;
        const meta: Record<string, string | boolean> = {};
        if (node.type === 'library_declaration') meta.library = true;
        if (isAbstract) meta.abstract = true;
        return {
          kind: node.type === 'interface_declaration' ? 'interface' : 'class',
          name,
          body: node.childForFieldName('body'),
          signature: oneLine(`${keyword} ${name}${sup.length ? ' is ' + sup.map((s) => s.name).join(', ') : ''}`),
          doc: natspec(node),
          modifiers: isAbstract ? ['abstract'] : [],
          exported: true,
          supertypes: sup,
          meta: Object.keys(meta).length ? meta : undefined,
        };
      }
      case 'function_definition': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const mods = funcModifiers(node);
        const ret = node.childForFieldName('return_type')?.text ?? '';
        const isTest = /^(test|invariant|statefulFuzz)/.test(name) && (isTestPath(ctx.path) || inTestContract(ctx));
        return {
          kind: isTest ? 'test' : ctx.inClass ? 'method' : 'function',
          name,
          body: node.childForFieldName('body'),
          signature: oneLine(`function ${name}${paramsText(node)}${mods.length ? ' ' + mods.join(' ') : ''}${ret ? ' ' + ret : ''}`),
          doc: natspec(node),
          modifiers: mods,
          exported: mods.includes('public') || mods.includes('external') || !ctx.inClass,
          meta: isTest ? { test: true, framework: 'foundry' } : undefined,
        };
      }
      case 'constructor_definition': {
        return {
          kind: 'constructor',
          name: 'constructor',
          body: node.childForFieldName('body'),
          signature: oneLine(`constructor${paramsText(node)}`),
          doc: natspec(node),
          modifiers: funcModifiers(node),
          exported: true,
        };
      }
      case 'fallback_receive_definition': {
        const kw = kids(node).find((c) => c.text === 'fallback' || c.text === 'receive');
        const name = kw?.text ?? 'fallback';
        return {
          kind: 'method',
          name,
          body: node.childForFieldName('body'),
          signature: oneLine(`${name}()${funcModifiers(node).length ? ' ' + funcModifiers(node).join(' ') : ''}`),
          doc: natspec(node),
          modifiers: funcModifiers(node),
          exported: true,
        };
      }
      case 'modifier_definition': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        return {
          kind: 'function',
          name,
          body: node.childForFieldName('body'),
          signature: oneLine(`modifier ${name}${paramsText(node)}`),
          doc: natspec(node),
          exported: true,
          meta: { modifier: true },
        };
      }
      case 'event_definition': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const ps = kids(node).filter((c) => c.type === 'event_parameter');
        return {
          kind: 'type_alias',
          name,
          signature: oneLine(`event ${name}(${ps.map((p) => oneLine(p.text)).join(', ')})`),
          doc: natspec(node),
          exported: true,
          meta: { event: true },
        };
      }
      case 'error_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const ps = kids(node).filter((c) => c.type === 'error_parameter');
        return {
          kind: 'type_alias',
          name,
          signature: oneLine(`error ${name}(${ps.map((p) => oneLine(p.text)).join(', ')})`),
          doc: natspec(node),
          exported: true,
          meta: { error: true },
        };
      }
      case 'struct_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        return { kind: 'struct', name, body: node.childForFieldName('body'), signature: oneLine(`struct ${name}`), doc: natspec(node), exported: true };
      }
      case 'struct_member': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const t = node.childForFieldName('type');
        return { kind: 'field', name, signature: oneLine(node.text.replace(/;$/, '')), doc: natspec(node), exported: true, declaredType: typeText(t) || undefined };
      }
      case 'enum_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        return { kind: 'enum', name, body: node.childForFieldName('body'), signature: oneLine(`enum ${name}`), doc: natspec(node), exported: true };
      }
      case 'enum_value': {
        return { kind: 'enum_member', name: node.text.trim(), signature: node.text.trim(), exported: true };
      }
      case 'state_variable_declaration':
      case 'constant_variable_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const t = node.childForFieldName('type');
        const vis = kids(node).find((c) => c.type === 'visibility')?.text.trim() ?? '';
        const extra = kids(node)
          .filter((c) => ['constant', 'immutable', 'transient'].includes(c.text) && !c.isNamed)
          .map((c) => c.text);
        const mods = [vis, ...extra].filter(Boolean);
        const isConst = extra.includes('constant') || node.type === 'constant_variable_declaration';
        return {
          kind: isConst ? 'constant' : 'field',
          name,
          signature: oneLine(node.text.replace(/;$/, '')),
          doc: natspec(node),
          modifiers: mods,
          exported: vis === 'public' || vis === 'external' || node.type === 'constant_variable_declaration',
          declaredType: typeText(t) || undefined,
        };
      }
      case 'user_defined_type_definition': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        return { kind: 'type_alias', name, signature: oneLine(node.text.replace(/;$/, '')), doc: natspec(node), exported: true };
      }
    }
    return null;
  },

  imports(node): Import[] | null {
    if (node.type !== 'import_directive') return null;
    const src = node.childForFieldName('source')?.text ?? '';
    const source = src.replace(/^['"]|['"]$/g, '');
    if (!source) return null;
    const line = node.startPosition.row + 1;
    const names: { name: string; alias: string }[] = [];
    let namespaceAlias = '';
    let star = false;
    const cs = kids(node);
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i]!;
      if (c.text === '*' && !c.isNamed) star = true;
      const field = node.fieldNameForChild(i);
      if (field === 'import_name') {
        // `{A as B}`: the alias is the next `alias` field sibling when `as` follows.
        let alias = c.text;
        const next = cs[i + 1];
        if (next && next.text === 'as' && !next.isNamed) {
          const aliasNode = cs[i + 2];
          if (aliasNode) alias = aliasNode.text;
        }
        names.push({ name: c.text, alias });
      } else if (field === 'alias' && (star || names.length === 0)) {
        namespaceAlias = c.text;
      }
    }
    if (names.length) return [{ source, names, namespace: false, alias: '', kind: 'static', line }];
    // `import "./X.sol";` and `import * as M from "./X.sol";` both pull in the whole unit.
    return [{ source, names: [], namespace: true, alias: namespaceAlias, kind: 'static', line }];
  },

  references(node, ctx): boolean | void {
    switch (node.type) {
      case 'call_expression': {
        const fn = unwrap(node.childForFieldName('function'));
        if (!fn) return;
        const arity = kids(node).filter((c) => c.type === 'call_argument').length;
        if (fn.type === 'new_expression') {
          const t = fn.childForFieldName('name');
          const name = simpleTypeName(t?.text ?? '');
          if (name) ctx.emitRef({ kind: 'new', name, arity, node: fn }, fn);
          return;
        }
        if (fn.type === 'member_expression') {
          const obj = unwrap(fn.childForFieldName('object'));
          const prop = fn.childForFieldName('property');
          if (!prop) return;
          const qualifier = obj?.text ?? '';
          if (CHEAT_RECEIVERS.has(qualifier) && /^env/.test(prop.text)) {
            const key = stringArg(node);
            if (key) {
              ctx.emitRef({ kind: 'config', name: key, qualifier: 'env', node: prop }, prop);
              return;
            }
          }
          ctx.emitRef({ kind: 'call', name: prop.text, qualifier, arity, node: prop }, prop);
          return;
        }
        if (fn.type === 'identifier') {
          ctx.emitRef({ kind: 'call', name: fn.text, arity, node: fn }, fn);
        }
        return;
      }
      case 'new_expression':
        // Emitted by the enclosing call_expression (which knows the arity); don't double count.
        return true;
      case 'emit_statement': {
        const nm = unwrap(node.childForFieldName('name'));
        if (nm) ctx.emitRef({ kind: 'value', name: simpleTypeName(nm.text), qualifier: nm.text.includes('.') ? nm.text.slice(0, nm.text.lastIndexOf('.')) : '', node: nm }, nm);
        return;
      }
      case 'revert_statement': {
        const err = kids(node).find((c) => c.type === 'revert_arguments' || c.type === 'expression' || c.type === 'identifier');
        const inner = unwrap(err);
        if (inner && /^[A-Za-z_$]/.test(inner.text)) {
          const nameNode = inner.type === 'call_expression' ? unwrap(inner.childForFieldName('function')) : inner;
          if (nameNode?.type === 'identifier') ctx.emitRef({ kind: 'value', name: nameNode.text, node: nameNode }, nameNode);
        }
        return;
      }
      case 'modifier_invocation': {
        const nm = named(node)[0];
        if (nm) ctx.emitRef({ kind: 'decorator', name: simpleTypeName(nm.text), node: nm }, nm);
        return true;
      }
      case 'using_directive': {
        const lib = kids(node).find((c) => c.type === 'type_alias' || c.type === 'using_alias');
        if (lib) ctx.emitRef({ kind: 'type', name: simpleTypeName(lib.text), node: lib }, lib);
        return;
      }
      case 'user_defined_type': {
        if (node.parent?.type === 'inheritance_specifier') return true; // already emitted as a supertype
        ctx.emitRef({ kind: 'type', name: simpleTypeName(node.text), qualifier: node.text.includes('.') ? node.text.slice(0, node.text.lastIndexOf('.')) : '' }, node);
        return true;
      }
      case 'variable_declaration':
      case 'parameter': {
        const name = node.childForFieldName('name')?.text;
        const t = node.childForFieldName('type');
        if (name && t) {
          const ty = typeText(t);
          if (ty && /^[A-Z]/.test(ty)) ctx.emitLocalType({ name, type: ty, via: 'annotation' });
        }
        return;
      }
      case 'identifier': {
        // A bare identifier passed as a call argument: a value reference (constant, contract, handler).
        const p = node.parent;
        if (p?.type === 'expression' && p.parent?.type === 'call_argument') ctx.emitRef({ kind: 'value', name: node.text }, node);
        return;
      }
    }
    return;
  },

  resolveModule(source, fromPath) {
    if (source.startsWith('@')) return []; // npm-scoped package (OpenZeppelin, solmate): external
    if (source.startsWith('.')) {
      const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
      const parts = (fromDir ? fromDir.split('/') : []).concat(source.split('/'));
      const stack: string[] = [];
      for (const p of parts) {
        if (p === '.' || p === '') continue;
        if (p === '..') stack.pop();
        else stack.push(p);
      }
      return [stack.join('/')];
    }
    // Bare specifier: could be a Foundry remapping (`forge-std/Test.sol`) or a repo-root path.
    return [source, `src/${source}`, `contracts/${source}`, `lib/${source}`];
  },
};
