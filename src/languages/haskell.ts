import type { Node } from 'web-tree-sitter';
import type { Import } from '../ir/types.js';
import type { DefSpec, LanguageSupport, WalkContext } from './types.js';
import { oneLine, cleanComment, named, simpleTypeName, reparentReopenedBlocks } from '../parse/walk.js';

const COMMENTS = new Set(['haddock', 'comment']);
/** Prelude / base names that are noise as call edges. */
const SKIP_CALLS = new Set([
  'return', 'pure', 'fmap', 'map', 'mapM', 'mapM_', 'forM', 'forM_', 'when', 'unless', 'show', 'read',
  'print', 'putStr', 'putStrLn', 'error', 'undefined', 'id', 'const', 'flip', 'not', 'null', 'length',
  'head', 'tail', 'init', 'last', 'reverse', 'concat', 'concatMap', 'filter', 'foldr', 'foldl', 'foldl\'',
  'elem', 'notElem', 'lookup', 'zip', 'zipWith', 'unzip', 'fst', 'snd', 'curry', 'uncurry', 'maybe',
  'either', 'fromIntegral', 'realToFrac', 'succ', 'pred', 'min', 'max', 'abs', 'signum', 'div', 'mod',
  'seq', 'otherwise', 'and', 'or', 'any', 'all', 'sum', 'product', 'take', 'drop', 'span', 'lines',
  'words', 'unlines', 'unwords', 'liftIO', 'lift', 'traverse', 'sequence', 'sequence_', 'replicate',
]);
/** hspec / tasty / QuickCheck block builders. */
const TEST_FNS = new Set(['describe', 'context', 'it', 'specify', 'testCase', 'testProperty', 'testGroup', 'prop']);
const ENV_FNS = new Set(['getEnv', 'lookupEnv', 'getEnvironment']);
/** Nodes whose subtree is a pattern, not an expression. */
const PATTERN_PARENTS = new Set(['patterns', 'field_pattern', 'alternative']);

interface State {
  /** Names listed in the module export list, or null when there is no explicit list. */
  exports: Set<string> | null;
  /** `${containerId}|${name}` of value definitions already emitted (equations collapse). */
  emitted: Set<string>;
}

const states = new WeakMap<WalkContext, State>();

function rootOf(node: Node): Node {
  let n = node;
  while (n.parent) n = n.parent;
  return n;
}

function stateFor(node: Node, ctx: WalkContext): State {
  let s = states.get(ctx);
  if (s) return s;
  const root = rootOf(node);
  const header = named(root).find((c) => c.type === 'header');
  const exportsNode = header?.childForFieldName('exports');
  let exports: Set<string> | null = null;
  if (exportsNode) {
    exports = new Set<string>();
    for (const e of named(exportsNode)) {
      if (e.type !== 'export') continue;
      const nm = e.childForFieldName('variable') ?? e.childForFieldName('type') ?? named(e)[0];
      if (nm) exports.add(nm.text);
    }
  }
  s = { exports, emitted: new Set() };
  states.set(ctx, s);
  return s;
}

function isExported(name: string, node: Node, ctx: WalkContext): boolean {
  const s = stateFor(node, ctx);
  return s.exports === null ? true : s.exports.has(name);
}

/**
 * Haddock preceding a declaration. The grammar attaches the haddock that sits between the import
 * block and the first declaration to the `imports` node, so fall back to the previous sibling of
 * the enclosing `declarations` list.
 */
function haskellDoc(node: Node): string {
  const parts: string[] = [];
  let prev = node.previousSibling;
  let lastStart = node.startPosition.row;
  while (prev && COMMENTS.has(prev.type)) {
    if (lastStart - prev.endPosition.row > 1) break;
    parts.unshift(prev.text);
    lastStart = prev.startPosition.row;
    prev = prev.previousSibling;
  }
  if (!parts.length && !node.previousSibling && node.parent?.type === 'declarations') {
    const before = node.parent.previousSibling;
    const last = before ? before.lastChild : null;
    if (last && COMMENTS.has(last.type) && node.startPosition.row - last.endPosition.row <= 1) parts.push(last.text);
  }
  if (!parts.length) return '';
  const raw = parts.join('\n');
  if (!/^(--\s*\||\{-\s*\|)/.test(raw.trim())) return '';
  return cleanComment(raw.replace(/^\{-\s*\|/, '/**').replace(/-\}$/, '*/').replace(/^--\s*\|/gm, '--'));
}

/** `Map.` -> `Map` */
function qualifierOf(q: Node): string {
  return (q.childForFieldName('module')?.text ?? '').replace(/\.$/, '');
}

/** Spine of a curried application: the head callee plus the number of arguments. */
function applySpine(node: Node): { fn: Node | null; arity: number; args: Node[] } {
  let fn: Node | null = node.childForFieldName('function');
  const args: Node[] = [];
  const first = node.childForFieldName('argument');
  if (first) args.unshift(first);
  while (fn?.type === 'apply') {
    const a = fn.childForFieldName('argument');
    if (a) args.unshift(a);
    fn = fn.childForFieldName('function');
  }
  return { fn, arity: args.length, args };
}

/** True when this `apply` is the callee of an enclosing `apply` (so the outer node owns the call). */
function isInnerApply(node: Node): boolean {
  const p = node.parent;
  return p?.type === 'apply' && !!p.childForFieldName('function')?.equals(node);
}

function stringText(n: Node | null | undefined): string {
  if (!n) return '';
  const s = n.type === 'literal' ? named(n)[0] : n;
  if (!s || s.type !== 'string') return '';
  return s.text.replace(/^"|"$/g, '');
}

function inPattern(node: Node): boolean {
  let p: Node | null = node.parent;
  while (p) {
    if (PATTERN_PARENTS.has(p.type)) return true;
    if (p.type === 'match' || p.type === 'do' || p.type === 'declarations') return false;
    p = p.parent;
  }
  return false;
}

/** The name bound by a `signature` / `function` / `bind` declaration. */
function declName(node: Node): string {
  const n = node.childForFieldName('name');
  if (!n) return '';
  if (n.type === 'variable' || n.type === 'name' || n.type === 'operator') return n.text;
  return n.text;
}

/** The `signature` declared for `name` earlier in the same declaration list. */
function signatureFor(node: Node, name: string): Node | null {
  const parent = node.parent;
  if (!parent) return null;
  for (const c of named(parent)) {
    if (c.equals(node)) break;
    if (c.type === 'signature' && declName(c) === name) return c;
  }
  return null;
}

/** True when a later sibling supplies an equation for this signature. */
function hasEquation(node: Node, name: string): boolean {
  const parent = node.parent;
  if (!parent) return false;
  let seen = false;
  for (const c of named(parent)) {
    if (c.equals(node)) {
      seen = true;
      continue;
    }
    if (!seen) continue;
    if ((c.type === 'function' || c.type === 'bind') && declName(c) === name) return true;
  }
  return false;
}

function isTestName(name: string): boolean {
  return /^(test_|prop_|spec_|case_|unit_)/.test(name) || name === 'spec' || name === 'tests';
}

/** `describe "…" $ do …` / `it "…" $ …` — returns the block title. */
function testHead(fn: Node | null, args: Node[]): { kw: string; title: string } | null {
  if (!fn || fn.type !== 'variable' || !TEST_FNS.has(fn.text)) return null;
  const title = stringText(args[0]);
  if (!title) return null;
  return { kw: fn.text, title };
}

/** Declared type of a value binding: only recorded when it is not a function type. */
function valueType(t: Node | null | undefined): string | undefined {
  if (!t) return undefined;
  if (t.type === 'function' || t.text.includes('->')) return undefined;
  return simpleTypeName(t.text) || undefined;
}

function constructorNameOf(dc: Node): Node | null {
  const inner = dc.childForFieldName('constructor') ?? named(dc)[0];
  if (!inner) return null;
  if (inner.type === 'constructor') return inner;
  return inner.childForFieldName('name') ?? null;
}

export const haskell: LanguageSupport = {
  id: 'haskell',
  grammar: 'haskell',
  extensions: ['.hs'],
  classLike: new Set(['class', 'instance', 'data_type', 'newtype']),
  skip: new Set(['comment', 'haddock', 'string', 'quasiquote_body', 'pragma']),

  isTestFile(path) {
    return /(^|\/)(test|tests|spec)\//i.test(path) || /(Spec|Test)\.hs$/.test(path);
  },

  doc(node) {
    return haskellDoc(node);
  },

  moduleDoc(root) {
    const first = root.firstChild;
    if (first && COMMENTS.has(first.type)) {
      const raw = first.text;
      if (/^(--\s*\||\{-\s*\|)/.test(raw.trim())) return cleanComment(raw.replace(/^\{-\s*\|/, '/**').replace(/-\}$/, '*/').replace(/^--\s*\|/gm, '--'));
    }
    return '';
  },

  definition(node, ctx): DefSpec | null {
    switch (node.type) {
      case 'header': {
        const mod = node.childForFieldName('module');
        if (!mod) return null;
        return { kind: 'namespace', name: mod.text, signature: oneLine(`module ${mod.text}`), exported: true, doc: '' };
      }
      case 'data_type':
      case 'newtype': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const ctors = node.type === 'newtype' ? 1 : named(node.childForFieldName('constructors')).filter((c) => c.type === 'data_constructor' || c.type === 'gadt_constructor').length;
        const kind: DefSpec['kind'] = ctors > 1 ? 'enum' : 'struct';
        const deriv = node.childForFieldName('deriving')?.text ?? '';
        const meta: DefSpec['meta'] = { constructors: ctors };
        if (node.type === 'newtype') meta.newtype = true;
        return {
          kind,
          name,
          signature: oneLine(`${node.type === 'newtype' ? 'newtype' : 'data'} ${name}${deriv ? ' ' + deriv : ''}`, 200),
          doc: haskellDoc(node),
          exported: isExported(name, node, ctx),
          meta,
        };
      }
      case 'data_constructor':
      case 'gadt_constructor':
      case 'newtype_constructor': {
        const nm = node.type === 'newtype_constructor' ? node.childForFieldName('name') : constructorNameOf(node);
        if (!nm) return null;
        return { kind: 'enum_member', name: nm.text, signature: oneLine(node.text, 160), doc: haskellDoc(node), exported: true, rangeNode: node };
      }
      case 'field': {
        const nm = node.childForFieldName('name');
        if (!nm || nm.type !== 'field_name') return null;
        const t = node.childForFieldName('type');
        return { kind: 'field', name: nm.text, signature: oneLine(node.text, 160), declaredType: t ? oneLine(t.text, 80) : undefined, exported: true, doc: haskellDoc(node) };
      }
      case 'type_synomym': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        return { kind: 'type_alias', name, signature: oneLine(node.text, 200), doc: haskellDoc(node), exported: isExported(name, node, ctx) };
      }
      case 'class': {
        const name = node.childForFieldName('name')?.text ?? '';
        if (!name) return null;
        const params = node.childForFieldName('patterns')?.text ?? '';
        const ctxNode = node.childForFieldName('context');
        const sup: NonNullable<DefSpec['supertypes']> = [];
        for (const m of (ctxNode?.text ?? '').matchAll(/\b([A-Z][A-Za-z0-9_']*)\b/g)) sup.push({ name: m[1]!, kind: 'extends' });
        return {
          kind: 'trait',
          name,
          body: node.childForFieldName('declarations'),
          signature: oneLine(`class ${ctxNode ? ctxNode.text + ' => ' : ''}${name} ${params}`, 200),
          doc: haskellDoc(node),
          exported: isExported(name, node, ctx),
          supertypes: sup,
        };
      }
      case 'instance': {
        const cls = node.childForFieldName('name')?.text ?? '';
        const pats = node.childForFieldName('patterns');
        const headType = pats ? (named(pats)[0]?.text ?? pats.text) : '';
        const typeName = headType.replace(/^\(|\)$/g, '').trim().split(/\s+/)[0] ?? '';
        const name = typeName || cls;
        if (!name) return null;
        const sup: NonNullable<DefSpec['supertypes']> = [];
        if (cls) sup.push({ name: cls, kind: 'implements' });
        if (typeName && typeName !== cls) sup.push({ name: typeName, kind: 'extends' });
        return {
          kind: 'class',
          name,
          body: node.childForFieldName('declarations'),
          signature: oneLine(`instance ${cls} ${headType}`, 200),
          doc: haskellDoc(node),
          exported: false,
          supertypes: sup,
          meta: { impl: true, class: cls, for: typeName },
        };
      }
      case 'signature': {
        const name = declName(node);
        if (!name) return null;
        if (hasEquation(node, name)) return null; // the equation owns the symbol
        const st = stateFor(node, ctx);
        const key = `${node.parent?.id ?? 0}|${name}`;
        if (st.emitted.has(key)) return null;
        st.emitted.add(key);
        const t = node.childForFieldName('type');
        return {
          kind: ctx.inClass ? 'method' : 'function',
          name,
          signature: oneLine(node.text, 200),
          doc: haskellDoc(node),
          modifiers: ctx.inClass ? ['abstract'] : [],
          exported: ctx.inClass || isExported(name, node, ctx),
          declaredType: valueType(t),
        };
      }
      case 'function':
      case 'bind': {
        const name = declName(node);
        if (!name || /^[^A-Za-z_]/.test(name)) return null; // operator definitions
        const st = stateFor(node, ctx);
        const key = `${node.parent?.id ?? 0}|${name}`;
        const sig = signatureFor(node, name);
        if (st.emitted.has(key)) return null; // extra equation of the same function
        st.emitted.add(key);
        const params = node.childForFieldName('patterns');
        const arity = params ? named(params).length : 0;
        const isValue = node.type === 'bind' && arity === 0;
        let kind: DefSpec['kind'] = ctx.inClass ? 'method' : isValue ? 'constant' : 'function';
        if (!ctx.inClass && isTestName(name)) kind = 'test';
        const head = params ? `${name} ${params.text}` : name;
        return {
          kind,
          name,
          body: node.childForFieldName('match'),
          signature: oneLine(sig ? sig.text : head, 200),
          doc: haskellDoc(sig ?? node),
          exported: ctx.inClass || isExported(name, node, ctx),
          declaredType: arity ? undefined : valueType(sig?.childForFieldName('type')),
          meta: { arity },
          rangeNode: node,
        };
      }
      case 'infix': {
        // `describe "…" $ do …`
        const op = node.childForFieldName('operator')?.text ?? '';
        if (op !== '$') return null;
        const left = node.childForFieldName('left_operand');
        if (left?.type !== 'apply') return null;
        const { fn, args } = applySpine(left);
        const t = testHead(fn, args);
        if (!t) return null;
        return { kind: 'test', name: `${t.kw} ${t.title}`, body: node.childForFieldName('right_operand'), signature: oneLine(`${t.kw} "${t.title}"`), meta: { framework: 'hspec', title: t.title }, exported: false };
      }
      case 'apply': {
        // `describe "…" (do …)` — two or more arguments, so the bare `describe "…"` head does not match.
        if (isInnerApply(node)) return null;
        const { fn, args } = applySpine(node);
        const t = testHead(fn, args);
        if (!t || args.length < 2) return null;
        return { kind: 'test', name: `${t.kw} ${t.title}`, body: args[args.length - 1], signature: oneLine(`${t.kw} "${t.title}"`), meta: { framework: 'hspec', title: t.title }, exported: false };
      }
    }
    return null;
  },

  imports(node): Import[] | null {
    if (node.type !== 'import') return null;
    const line = node.startPosition.row + 1;
    const mod = node.childForFieldName('module');
    if (!mod) return [];
    const source = mod.text.replace(/\s+/g, '');
    const aliasNode = node.childForFieldName('alias');
    const list = node.childForFieldName('names');
    const hiding = node.children.some((c) => c?.type === 'hiding');
    const names: Import['names'] = [];
    if (list && !hiding) {
      for (const n of named(list)) {
        if (n.type !== 'import_name') continue;
        const inner = n.childForFieldName('variable') ?? n.childForFieldName('type') ?? named(n)[0];
        if (inner) names.push({ name: inner.text, alias: inner.text });
        // `Type(..)` also brings the constructors; the resolver falls back to the module for those.
      }
    }
    const alias = aliasNode ? aliasNode.text.replace(/\s+/g, '') : '';
    const namespace = names.length === 0;
    return [{ source, names, namespace, alias: alias || (namespace ? source.slice(source.lastIndexOf('.') + 1) : ''), kind: 'static', line }];
  },

  references(node, ctx) {
    switch (node.type) {
      case 'header':
      case 'exports':
      case 'deriving':
        return true;
      case 'apply': {
        if (isInnerApply(node)) return;
        const { fn, arity, args } = applySpine(node);
        if (!fn) return;
        if (fn.type === 'variable') {
          const name = fn.text;
          if (ENV_FNS.has(name)) {
            const key = stringText(args[0]);
            if (key) ctx.emitRef({ kind: 'config', name: key }, args[0]!);
          }
          if (!SKIP_CALLS.has(name) && !TEST_FNS.has(name) && !inPattern(node)) ctx.emitRef({ kind: 'call', name, arity }, fn);
        } else if (fn.type === 'qualified') {
          const id = fn.childForFieldName('id');
          const q = qualifierOf(fn);
          if (id?.type === 'variable') {
            if (ENV_FNS.has(id.text)) {
              const key = stringText(args[0]);
              if (key) ctx.emitRef({ kind: 'config', name: key }, args[0]!);
            }
            ctx.emitRef({ kind: 'call', name: id.text, qualifier: q, arity }, id);
          } else if (id?.type === 'name') {
            ctx.emitRef({ kind: 'new', name: id.text, qualifier: q, arity }, id);
          }
        } else if (fn.type === 'constructor') {
          if (!inPattern(node)) ctx.emitRef({ kind: 'new', name: fn.text, arity }, fn);
        }
        return;
      }
      case 'qualified': {
        const p = node.parent;
        if (p?.type === 'apply' && p.childForFieldName('function')?.equals(node)) return true;
        const id = node.childForFieldName('id');
        const q = qualifierOf(node);
        if (id?.type === 'name') ctx.emitRef({ kind: 'type', name: id.text, qualifier: q }, id);
        else if (id?.type === 'variable' && !SKIP_CALLS.has(id.text)) ctx.emitRef({ kind: 'value', name: id.text, qualifier: q }, id);
        return true;
      }
      case 'name': {
        // Type-position name. Declaration names carry the `name` field of their parent.
        const p = node.parent;
        if (p && p.childForFieldName('name')?.equals(node)) return true;
        if (p?.type === 'export' || p?.type === 'import_name') return true;
        ctx.emitRef({ kind: 'type', name: node.text }, node);
        return true;
      }
      case 'constructor': {
        const p = node.parent;
        if (p && p.childForFieldName('name')?.equals(node)) return true;
        if (p?.type === 'apply' && p.childForFieldName('function')?.equals(node)) return true;
        if (inPattern(node)) return true;
        ctx.emitRef({ kind: 'value', name: node.text }, node);
        return true;
      }
      case 'variable': {
        const p = node.parent;
        if (!p) return;
        if (p.childForFieldName('name')?.equals(node)) return true;
        if (p.type === 'apply' && p.childForFieldName('function')?.equals(node)) return true;
        if (p.type === 'field_name' || p.type === 'import_name' || p.type === 'export') return true;
        if (inPattern(node)) return true;
        if (p.type === 'apply' || p.type === 'parens' || p.type === 'exp') {
          if (!SKIP_CALLS.has(node.text)) ctx.emitRef({ kind: 'value', name: node.text }, node);
        }
        return true;
      }
    }
    return;
  },

  postWalk(defs) {
    // A single-constructor `data`/`newtype` reads as a record: hang its fields off the type itself
    // rather than off the (usually identically named) constructor.
    for (const d of defs) {
      if (d.kind !== 'field') continue;
      const ctor = d.parent >= 0 ? defs[d.parent] : undefined;
      if (!ctor || ctor.kind !== 'enum_member') continue;
      const type = ctor.parent >= 0 ? defs[ctor.parent] : undefined;
      if (!type || type.meta?.constructors !== 1) continue;
      d.parent = type.ordinal;
      d.fqn = `${type.fqn}.${d.name}`;
    }
    reparentReopenedBlocks(defs);
  },

  resolveModule(source) {
    const segs = source.split('.').filter(Boolean);
    if (!segs.length) return [];
    const p = segs.join('/');
    const out: string[] = [];
    for (const root of ['src', '', 'lib', 'app', 'test', 'tests', 'exe', 'bench']) {
      out.push(root ? `${root}/${p}.hs` : `${p}.hs`);
    }
    for (const root of ['src', 'lib']) out.push(`${root}/${p}.lhs`);
    return [...new Set(out)];
  },
};
