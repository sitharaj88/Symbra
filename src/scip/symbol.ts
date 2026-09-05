/**
 * SCIP symbol strings and their mapping onto Symbra symbols.
 *
 * Grammar (scip.proto, `message Symbol`):
 *
 *   <symbol>     ::= <scheme> ' ' <manager> ' ' <package-name> ' ' <version> ' ' (<descriptor>)+ | 'local ' <local-id>
 *   <descriptor> ::= <name> '/'            namespace
 *                  | <name> '#'            type
 *                  | <name> '.'            term
 *                  | <name> '(' <disambiguator>? ').'   method
 *                  | '[' <name> ']'        type parameter
 *                  | '(' <name> ')'        parameter
 *                  | <name> ':'            meta
 *                  | <name> '!'            macro
 *   <name>       ::= simple identifier ([A-Za-z0-9_+$-]+) | '`' escaped (backtick doubled) '`'
 *   scheme/manager/package/version escape spaces as double spaces; '.' means empty.
 */

import type { SymbolKind } from '../ir/types.js';
import type { Store, SymbolRow } from '../store/db.js';
import { moduleId, symbolId, splitIdentifier } from '../store/db.js';
import { ScipKind } from './proto.js';

export type DescriptorSuffix = 'namespace' | 'type' | 'term' | 'method' | 'type_parameter' | 'parameter' | 'meta' | 'macro';

export interface Descriptor {
  name: string;
  suffix: DescriptorSuffix;
  /** Method overload disambiguator, e.g. `+1` in `foo(+1).`. */
  disambiguator: string;
}

export interface ParsedSymbol {
  /** True for `local N` symbols (document-local variables, parameters, …). */
  local: boolean;
  localId: string;
  scheme: string;
  manager: string;
  package: string;
  version: string;
  descriptors: Descriptor[];
}

function isIdentChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 43 || c === 45 || c === 36;
}

/** Parse the space-separated head: returns the field and the index after the separating space. */
function readSpaceField(s: string, pos: number): [string, number] {
  let out = '';
  let i = pos;
  while (i < s.length) {
    const c = s[i]!;
    if (c === ' ') {
      if (s[i + 1] === ' ') {
        out += ' ';
        i += 2;
        continue;
      }
      return [out, i + 1];
    }
    out += c;
    i++;
  }
  return [out, i];
}

/** Read a <name> at pos: simple or backtick-escaped. Returns [name, nextPos]. */
function readName(s: string, pos: number): [string, number] {
  if (s[pos] === '`') {
    let out = '';
    let i = pos + 1;
    while (i < s.length) {
      const c = s[i]!;
      if (c === '`') {
        if (s[i + 1] === '`') {
          out += '`';
          i += 2;
          continue;
        }
        return [out, i + 1];
      }
      out += c;
      i++;
    }
    throw new Error(`scip symbol: unterminated escaped identifier at ${pos} in ${JSON.stringify(s)}`);
  }
  let i = pos;
  while (i < s.length && isIdentChar(s.charCodeAt(i))) i++;
  if (i === pos) throw new Error(`scip symbol: expected identifier at ${pos} in ${JSON.stringify(s)}`);
  return [s.slice(pos, i), i];
}

export function parseDescriptors(s: string, pos = 0): Descriptor[] {
  const out: Descriptor[] = [];
  let i = pos;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '[') {
      const [name, next] = readName(s, i + 1);
      if (s[next] !== ']') throw new Error(`scip symbol: expected ']' at ${next} in ${JSON.stringify(s)}`);
      out.push({ name, suffix: 'type_parameter', disambiguator: '' });
      i = next + 1;
      continue;
    }
    if (c === '(') {
      const [name, next] = readName(s, i + 1);
      if (s[next] !== ')') throw new Error(`scip symbol: expected ')' at ${next} in ${JSON.stringify(s)}`);
      out.push({ name, suffix: 'parameter', disambiguator: '' });
      i = next + 1;
      continue;
    }
    const [name, next] = readName(s, i);
    const suf = s[next];
    i = next + 1;
    switch (suf) {
      case '/':
        out.push({ name, suffix: 'namespace', disambiguator: '' });
        break;
      case '#':
        out.push({ name, suffix: 'type', disambiguator: '' });
        break;
      case '.':
        out.push({ name, suffix: 'term', disambiguator: '' });
        break;
      case ':':
        out.push({ name, suffix: 'meta', disambiguator: '' });
        break;
      case '!':
        out.push({ name, suffix: 'macro', disambiguator: '' });
        break;
      case '(': {
        // method: name '(' disambiguator? ').'
        let j = i;
        while (j < s.length && isIdentChar(s.charCodeAt(j))) j++;
        const disambiguator = s.slice(i, j);
        if (s[j] !== ')' || s[j + 1] !== '.') throw new Error(`scip symbol: malformed method descriptor at ${next} in ${JSON.stringify(s)}`);
        out.push({ name, suffix: 'method', disambiguator });
        i = j + 2;
        break;
      }
      default:
        throw new Error(`scip symbol: unexpected ${JSON.stringify(suf ?? 'end')} after name ${JSON.stringify(name)} in ${JSON.stringify(s)}`);
    }
  }
  return out;
}

const cache = new Map<string, ParsedSymbol>();

export function parseSymbol(s: string): ParsedSymbol {
  const hit = cache.get(s);
  if (hit) return hit;
  let r: ParsedSymbol;
  if (s.startsWith('local ')) {
    r = { local: true, localId: s.slice(6), scheme: 'local', manager: '', package: '', version: '', descriptors: [] };
  } else {
    let pos = 0;
    let scheme: string, manager: string, pkg: string, version: string;
    [scheme, pos] = readSpaceField(s, pos);
    [manager, pos] = readSpaceField(s, pos);
    [pkg, pos] = readSpaceField(s, pos);
    [version, pos] = readSpaceField(s, pos);
    if (!scheme) throw new Error(`scip symbol: empty scheme in ${JSON.stringify(s)}`);
    const norm = (x: string) => (x === '.' ? '' : x);
    r = { local: false, localId: '', scheme, manager: norm(manager), package: norm(pkg), version: norm(version), descriptors: parseDescriptors(s, pos) };
  }
  if (cache.size > 200_000) cache.clear();
  cache.set(s, r);
  return r;
}

/** The simple name of the entity a symbol denotes (last descriptor's name). */
export function symbolName(p: ParsedSymbol): string {
  const d = p.descriptors[p.descriptors.length - 1];
  return d ? d.name : p.localId;
}

/** True when the symbol denotes something Symbra never stores as a node (parameters, type params, locals). */
export function isSubSymbol(p: ParsedSymbol): boolean {
  if (p.local) return true;
  const d = p.descriptors[p.descriptors.length - 1];
  return !d || d.suffix === 'parameter' || d.suffix === 'type_parameter';
}

/**
 * Symbra-style fqn for the symbol inside its file: the names of the descriptors
 * after the last namespace (module/package/file) descriptor, joined by '.'.
 * `src/`greeter.ts`/Greeter#greet().` -> `Greeter.greet`.
 */
export function symbolFqn(p: ParsedSymbol): string {
  const ds = p.descriptors;
  let start = 0;
  for (let i = ds.length - 1; i >= 0; i--) {
    if (ds[i]!.suffix === 'namespace') {
      start = i + 1;
      break;
    }
  }
  const names = ds.slice(start).map((d) => d.name);
  if (!names.length) return ds.length ? ds[ds.length - 1]!.name : p.localId;
  return names.join('.');
}

// ---------------------------------------------------------------- kinds

const CALLABLE: ReadonlySet<SymbolKind> = new Set<SymbolKind>(['function', 'method', 'constructor', 'macro']);
const CLASS_LIKE: ReadonlySet<SymbolKind> = new Set<SymbolKind>(['class', 'interface', 'struct', 'enum', 'trait']);

export function isCallableKind(k: SymbolKind): boolean {
  return CALLABLE.has(k);
}

export function isClassLikeKind(k: SymbolKind): boolean {
  return CLASS_LIKE.has(k);
}

/** Map SymbolInformation.Kind (with the descriptor as fallback) onto a Symbra kind. */
export function mapKind(kind: number, p: ParsedSymbol): SymbolKind {
  switch (kind) {
    case ScipKind.Class:
    case ScipKind.SingletonClass:
    case ScipKind.Mixin:
      return 'class';
    case ScipKind.Interface:
      return 'interface';
    case ScipKind.Struct:
      return 'struct';
    case ScipKind.Enum:
      return 'enum';
    case ScipKind.EnumMember:
      return 'enum_member';
    case ScipKind.Trait:
    case ScipKind.Protocol:
    case ScipKind.TypeClass:
      return 'trait';
    case ScipKind.Function:
      return 'function';
    case ScipKind.Method:
    case ScipKind.AbstractMethod:
    case ScipKind.StaticMethod:
    case ScipKind.MethodSpecification:
    case ScipKind.ProtocolMethod:
    case ScipKind.PureVirtualMethod:
    case ScipKind.TraitMethod:
    case ScipKind.TypeClassMethod:
    case ScipKind.SingletonMethod:
    case ScipKind.MethodAlias:
      return 'method';
    case ScipKind.Constructor:
      return 'constructor';
    case ScipKind.Property:
    case ScipKind.StaticProperty:
    case ScipKind.Getter:
    case ScipKind.Setter:
    case ScipKind.Accessor:
      return 'property';
    case ScipKind.Field:
    case ScipKind.StaticField:
    case ScipKind.StaticDataMember:
    case ScipKind.Event:
    case ScipKind.StaticEvent:
      return 'field';
    case ScipKind.Variable:
    case ScipKind.StaticVariable:
    case ScipKind.Object:
    case ScipKind.Attribute:
      return 'variable';
    case ScipKind.Constant:
      return 'constant';
    case ScipKind.TypeAlias:
    case ScipKind.Type:
    case ScipKind.AssociatedType:
    case ScipKind.Delegate:
      return 'type_alias';
    case ScipKind.Macro:
      return 'macro';
    case ScipKind.Module:
    case ScipKind.Namespace:
    case ScipKind.Package:
    case ScipKind.PackageObject:
    case ScipKind.Extension:
    case ScipKind.File:
      return 'namespace';
    default:
      break;
  }
  // Kind unspecified (scip-typescript < 0.4 and several other indexers): infer from the descriptor.
  const ds = p.descriptors;
  const d = ds[ds.length - 1];
  if (!d) return 'variable';
  const parent = ds[ds.length - 2];
  const inType = parent?.suffix === 'type';
  switch (d.suffix) {
    case 'type':
      return 'class';
    case 'method':
      return d.name === '<constructor>' || d.name === '__init__' ? 'constructor' : inType ? 'method' : 'function';
    case 'term':
      return inType ? 'field' : 'variable';
    case 'namespace':
      return 'namespace';
    case 'macro':
      return 'macro';
    case 'meta':
      return 'variable';
    default:
      return 'variable';
  }
}

/** Coarse category used to decide whether a Symbra symbol and a SCIP symbol can be the same entity. */
function category(k: SymbolKind): 'callable' | 'type' | 'value' | 'container' | 'other' {
  if (CALLABLE.has(k)) return 'callable';
  if (CLASS_LIKE.has(k) || k === 'type_alias') return 'type';
  if (k === 'property' || k === 'field' || k === 'variable' || k === 'constant' || k === 'enum_member' || k === 'config_key') return 'value';
  if (k === 'module' || k === 'namespace') return 'container';
  return 'other';
}

/** Names Symbra's extractors give constructors, per language. */
const CTOR_NAMES = new Set(['constructor', '<constructor>', '__init__', '__new__', 'new', 'init', '<init>', 'initialize', '__construct']);

function namesMatch(scipName: string, row: SymbolRow): boolean {
  if (scipName === row.name) return true;
  if (row.kind === 'constructor' && CTOR_NAMES.has(scipName)) return true;
  if (CTOR_NAMES.has(scipName) && CTOR_NAMES.has(row.name)) return true;
  // Symbra names a method `Class.method` in fqn but `method` in name; SCIP disambiguated overloads keep the plain name.
  return false;
}

// ---------------------------------------------------------------- file symbol index

/** True for a symbol row this importer created (meta `{"scip": true}`). */
export function isScipCreated(row: { meta: string | null }): boolean {
  if (!row.meta || !row.meta.includes('"scip"')) return false;
  try {
    return (JSON.parse(row.meta) as { scip?: unknown }).scip === true;
  } catch {
    return false;
  }
}

/**
 * Per-file lookup: innermost Symbra symbol at a line, and the chain of range-containing
 * ancestors. Built once per document from the symbols table.
 *
 * Rows this importer created are addressable by id but never act as an enclosing scope:
 * Symbra's own extractors own the containment tree, and letting a synthesised row (usually a
 * one-line `var`) become the innermost symbol at its line would both attribute call sites to a
 * variable and make a second import of the same index produce different edges from the first.
 */
export class FileSymbolIndex {
  readonly moduleId: string;
  private readonly byId = new Map<string, SymbolRow>();
  /** innermost symbol per 1-based line, null when only the module contains it */
  private readonly lineMap: (SymbolRow | null)[];

  constructor(
    readonly file: string,
    rows: SymbolRow[],
  ) {
    this.moduleId = moduleId(file);
    let maxLine = 1;
    for (const r of rows) {
      this.byId.set(r.id, r);
      if (r.end_line > maxLine) maxLine = r.end_line;
    }
    this.lineMap = new Array<SymbolRow | null>(maxLine + 2).fill(null);
    // paint wider spans first so narrower (inner) ones overwrite them
    const sorted = rows.filter((r) => r.kind !== 'module' && !isScipCreated(r)).sort((a, b) => b.end_line - b.start_line - (a.end_line - a.start_line) || a.start_line - b.start_line);
    for (const r of sorted) for (let l = Math.max(1, r.start_line); l <= r.end_line; l++) this.lineMap[l] = r;
  }

  get(id: string): SymbolRow | undefined {
    return this.byId.get(id);
  }

  /** Register a row created during this import. It is findable by id, never an enclosing scope. */
  add(row: SymbolRow) {
    this.byId.set(row.id, row);
  }

  /** Innermost non-module symbol whose range contains the 1-based line, or null. */
  innermost(line: number): SymbolRow | null {
    return this.lineMap[line] ?? null;
  }

  /** Symbol id to use as the source of an edge at this line: innermost symbol, else the module. */
  scopeAt(line: number): string {
    return this.innermost(line)?.id ?? this.moduleId;
  }

  /** Symbols containing the line, innermost first, following parent links while the range still contains it. */
  containing(line: number): SymbolRow[] {
    const out: SymbolRow[] = [];
    let cur = this.innermost(line);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.push(cur);
      const p = cur.parent ? this.byId.get(cur.parent) : undefined;
      cur = p && p.kind !== 'module' && p.start_line <= line && p.end_line >= line ? p : null;
    }
    return out;
  }
}

// ---------------------------------------------------------------- mapping

export interface DefinitionSite {
  file: string;
  /** 1-based line of the definition occurrence (the name token). */
  line: number;
  /** 1-based inclusive range of the whole definition when the indexer emitted enclosing_range. */
  startLine: number;
  endLine: number;
  info: { kind: number; documentation: string[]; signature: string; displayName: string } | null;
}

export interface MappingResult {
  id: string;
  created: boolean;
}

/**
 * Map a SCIP definition to a Symbra symbol in the same file.
 *
 * 1. A symbol whose range contains the definition line and whose name equals the
 *    descriptor's name (constructor aliases allowed), innermost first.
 * 2. The innermost containing symbol when it *starts* on the definition line and is
 *    of a compatible category (handles renamed defaults, `<constructor>`, etc.).
 * 3. The file's module symbol for the document's own namespace descriptor.
 * 4. Otherwise a new symbol row is created (kind, range, doc, signature from SCIP)
 *    with meta `{"scip": true}`.
 */
export function mapDefinition(store: Store, idx: FileSymbolIndex, sym: string, site: DefinitionSite, opts: { includeVariables?: boolean } = {}): MappingResult | null {
  const p = parseSymbol(sym);
  if (isSubSymbol(p)) return null;
  const name = symbolName(p);
  const kind = mapKind(site.info?.kind ?? 0, p);
  const cat = category(kind);

  const containing = idx.containing(site.line);
  for (const row of containing) if (namesMatch(name, row)) return { id: row.id, created: false };
  const inner = containing[0];
  if (inner && inner.start_line === site.line) {
    const ic = category(inner.kind);
    if (ic === cat || ic === 'other' || cat === 'other') return { id: inner.id, created: false };
    // `new Foo()` in Symbra binds to the class; a SCIP constructor on the class line is the same entity
    if (kind === 'constructor' && ic === 'type') return { id: inner.id, created: false };
  }
  const last = p.descriptors[p.descriptors.length - 1];
  if (last?.suffix === 'namespace' && !inner) {
    const base = idx.file.slice(idx.file.lastIndexOf('/') + 1);
    if (last.name === base || last.name === base.replace(/\.[^.]+$/, '') || p.descriptors.every((d) => d.suffix === 'namespace')) return { id: idx.moduleId, created: false };
  }
  if (kind === 'namespace' && cat === 'container' && !inner && site.line <= 1) return { id: idx.moduleId, created: false };

  // create
  // A SCIP index names every top-level binding, including the ones Symbra deliberately does not
  // extract: module-scope consts, destructured locals, re-export aliases. Creating a `variable` row
  // for each buries the real symbols in search and in the graph, so by default we only create rows
  // for definitions with structure (functions, methods, types). References to variables Symbra
  // *did* extract still resolve, because those matched above and never reach here.
  if (kind === 'variable' && !opts.includeVariables) return null;
  const fqn = symbolFqn(p);
  const id = symbolId(idx.file, fqn);
  const existing = idx.get(id) ?? store.getSymbol(id);
  if (existing) return { id: existing.id, created: false };
  const parent = inner?.id ?? idx.moduleId;
  const docs = site.info?.documentation ?? [];
  // scip-typescript puts the signature in documentation[0] as a fenced code block; keep prose only in doc
  const isCode = (s: string) => /^```/.test(s.trim());
  let signature = site.info?.signature ?? '';
  if (!signature) {
    const codeDoc = docs.find(isCode);
    if (codeDoc) signature = codeDoc.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  const doc = docs
    .filter((d) => !isCode(d))
    .join('\n\n')
    .trim()
    .slice(0, 4000);
  const startLine = Math.max(1, site.startLine);
  const endLine = Math.max(startLine, site.endLine);
  const ordinal = 1_000_000 + (store.prep('SELECT COUNT(*) AS n FROM symbols WHERE file = ? AND ordinal >= 1000000').get(idx.file) as { n: number }).n;
  store
    .prep('INSERT INTO symbols(id, file, ordinal, kind, name, fqn, start_line, end_line, start_byte, end_byte, signature, doc, modifiers, exported, parent, declared_type, meta) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, idx.file, ordinal, kind, name, fqn, startLine, endLine, 0, 0, signature.slice(0, 2000), doc, '', 1, parent, null, JSON.stringify({ scip: true }));
  store.prep('INSERT INTO symbols_fts(id, name, split_name, fqn, signature, doc, file) VALUES(?,?,?,?,?,?,?)').run(id, name, splitIdentifier(name), fqn.replace(/\./g, ' '), signature.slice(0, 2000), doc, idx.file);
  const row = store.getSymbol(id)!;
  idx.add(row);
  return { id, created: true };
}
