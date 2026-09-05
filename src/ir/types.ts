/**
 * Symbra intermediate representation.
 *
 * One FileIR per source file. Definitions, references and imports are extracted
 * per file with no knowledge of other files; resolution happens later against
 * the store.
 */

export type SymbolKind =
  | 'module'
  | 'namespace'
  | 'class'
  | 'interface'
  | 'struct'
  | 'enum'
  | 'enum_member'
  | 'trait'
  | 'function'
  | 'method'
  | 'constructor'
  | 'property'
  | 'field'
  | 'variable'
  | 'constant'
  | 'type_alias'
  | 'macro'
  | 'route'
  | 'test'
  | 'section' // markdown heading
  | 'config_key';

export interface Range {
  startLine: number; // 1-based
  endLine: number; // 1-based, inclusive
  startByte: number;
  endByte: number;
}

export interface Definition {
  /** Local (per-file) ordinal used to link references to their enclosing definition. */
  ordinal: number;
  kind: SymbolKind;
  name: string;
  /** Fully qualified name within the file: Container.Member. Module prefix is added by the store. */
  fqn: string;
  range: Range;
  /** Ordinal of the enclosing definition, or -1 for top level. */
  parent: number;
  signature: string;
  doc: string;
  modifiers: string[];
  exported: boolean;
  /**
   * Declared supertypes: names as written (`Base`, `pkg.Base`, `Base<T>` stripped to `Base`).
   * Kind distinguishes extends vs implements where the language knows.
   */
  supertypes: { name: string; kind: 'extends' | 'implements' }[];
  /** Declared type of a field/variable/property/parameter when written (used for receiver typing). */
  declaredType?: string;
  /** Extra structured info: route path + method, test framework, env key, etc. */
  meta?: Record<string, string | number | boolean>;
}

export type ReferenceKind =
  | 'call'
  | 'new'
  | 'type'
  | 'value'
  | 'extends'
  | 'implements'
  | 'decorator'
  | 'mention'
  | 'config';

export interface Reference {
  kind: ReferenceKind;
  /** The simple name referenced (last segment). */
  name: string;
  /** Qualifier text before the name, e.g. `self`, `this`, `pkg`, `obj.field`, or empty. */
  qualifier: string;
  line: number;
  startByte: number;
  /** Ordinal of the enclosing definition, or -1 if at module level. */
  scope: number;
  /** Number of call arguments when kind is call, else undefined. */
  arity?: number;
}

export interface Import {
  /** Raw module specifier as written (`./util`, `httpx._models`, `github.com/x/y`). */
  source: string;
  /** Imported names; empty array with `namespace` true means `import * as`, empty without means bare/side-effect import. */
  names: { name: string; alias: string }[];
  /** True for `import * as ns` / `import pkg` style where the alias binds the whole module. */
  namespace: boolean;
  /** Local alias for a namespace import (`ns` in `import * as ns`). */
  alias: string;
  /** static | dynamic | type-only | reexport */
  kind: 'static' | 'dynamic' | 'type' | 'reexport';
  line: number;
  /** Python relative import level (number of leading dots). */
  relativeLevel?: number;
}

/** Local variable type facts for receiver-typed member call resolution. */
export interface LocalTypeFact {
  /** Ordinal of the scope (definition) in which the binding is visible. */
  scope: number;
  /** Variable / parameter / field name. */
  name: string;
  /** Type name as written, simplified to its last segment without generics. */
  type: string;
  /** How the type was learned. */
  via: 'annotation' | 'new' | 'constructor_call' | 'field';
}

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  line?: number;
}

export interface FileIR {
  path: string; // repo-relative, posix separators
  language: string;
  hash: string; // sha1 of content
  size: number;
  definitions: Definition[];
  references: Reference[];
  imports: Import[];
  localTypes: LocalTypeFact[];
  diagnostics: Diagnostic[];
  /** Module-level doc comment, if any. */
  doc: string;
  /** Percentage of the file covered by parse ERROR nodes, 0..100. */
  errorPct: number;
  /** Declared package (JVM `package a.b.c`); absent for languages without one. */
  pkg?: string;
}

export const EDGE_KINDS = [
  'calls',
  'references',
  'imports',
  'extends',
  'implements',
  'contains',
  'defines_route',
  'tests',
  'reads_config',
  'decorates',
  /** A callable passed by name (callback, handler, function-pointer table entry): src is the enclosing scope, dst the callable. */
  'passes',
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface Edge {
  src: string;
  dst: string;
  kind: EdgeKind;
  file: string;
  line: number;
  /** Which resolver tier produced this edge. */
  resolver: 'scope' | 'import' | 'receiver' | 'unique' | 'structural' | 'heuristic' | 'scip';
  confidence: number;
}
