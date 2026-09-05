import type { Node } from 'web-tree-sitter';
import type { Definition, Import, Reference, SymbolKind, LocalTypeFact } from '../ir/types.js';

/** What a language module tells the walker about a definition node. */
export interface DefSpec {
  kind: SymbolKind;
  name: string;
  /** Node whose children are the definition's scope (function body, class body). May be undefined. */
  body?: Node | null;
  signature?: string;
  doc?: string;
  modifiers?: string[];
  exported?: boolean;
  supertypes?: Definition['supertypes'];
  declaredType?: string;
  meta?: Definition['meta'];
  /** Container prefix for assignment-style definitions (`app.get` -> container `app`). */
  container?: string;
  /** Range override (defaults to the node's range). */
  rangeNode?: Node;
}

export interface RefSpec {
  kind: Reference['kind'];
  name: string;
  qualifier?: string;
  arity?: number;
  node?: Node;
}

export interface WalkContext {
  source: string;
  path: string;
  /** Ordinal of the innermost enclosing definition or -1. */
  scope: number;
  /** Innermost enclosing definition, if any. */
  scopeDef: Definition | null;
  /** True when inside a class-like body directly (for method/field kind decisions). */
  inClass: boolean;
  /** True when any enclosing definition is a test. */
  inTest: boolean;
  /** Emit helpers. */
  emitRef(ref: RefSpec, node: Node): void;
  emitImport(imp: Import): void;
  emitLocalType(fact: Omit<LocalTypeFact, 'scope'>): void;
  /** Emit an extra definition not tied to the walk (routes, tests). Returns ordinal. */
  emitDef(spec: DefSpec, node: Node, parent: number): number;
  text(node: Node | null | undefined): string;
}

export interface LanguageSupport {
  id: string;
  grammar: string;
  extensions: string[];
  /** Node types that open a class-like scope (methods inside become `method`). */
  classLike: Set<string>;
  /** Called for every node. Return a DefSpec to register a definition and descend into `body`. */
  definition(node: Node, ctx: WalkContext): DefSpec | null;
  /** Called for every node not claimed as a definition. Return imports to register. */
  imports(node: Node, ctx: WalkContext): Import[] | null;
  /** Called for every node. Emit references via ctx.emitRef. Return true to stop descending. */
  references(node: Node, ctx: WalkContext): boolean | void;
  /** Extract a doc comment for a node (preceding comment or docstring). */
  doc(node: Node, ctx: WalkContext): string;
  /** Module-level doc. */
  moduleDoc?(root: Node, ctx: WalkContext): string;
  /** Node types whose subtree should not be walked at all (e.g. string bodies). */
  skip?: Set<string>;
  /** Is this path a test file? */
  isTestFile?(path: string): boolean;
  /**
   * Claim a file whose extension belongs to another language. Consulted only when the extension
   * already maps somewhere, so a `.h` full of `@interface` can go to Objective-C instead of C.
   */
  detect?(path: string, content: string): boolean;
  /**
   * Called once with every definition of the file, after the walk. Lets a language rewrite the
   * definition tree with whole-file knowledge (see `reparentReopenedBlocks`).
   */
  postWalk?(defs: Definition[]): void;
  /** Resolve an import source to candidate repo-relative paths (without checking existence). */
  resolveModule(source: string, fromPath: string, imp: Import, project: ModuleResolutionContext): string[];
}

export interface ModuleResolutionContext {
  /** All indexed file paths (posix, repo-relative). */
  hasFile(path: string): boolean;
  /** tsconfig/jsconfig path aliases of the repo root: pattern -> targets. */
  tsPaths?: { baseUrl: string; paths: Record<string, string[]> } | null;
  /**
   * Path aliases of the *nearest* tsconfig/jsconfig above an importing file, falling back to the
   * root config. A monorepo gives `web/` and each package its own `@/*`, so the root config alone
   * resolves the wrong file (or none).
   */
  tsPathsFor?(fromPath: string): { baseUrl: string; paths: Record<string, string[]> } | null;
  /** JS/TS workspace package name -> repo-relative directory (pnpm/npm/yarn workspaces). */
  workspaces?: Map<string, string>;
  /** Go module path from go.mod. */
  goModule?: string | null;
  /** Python source roots (e.g. `src/`). */
  pythonRoots?: string[];
  /** Java/Kotlin source roots. */
  jvmRoots?: string[];
  /**
   * Swift: the SwiftPM/Xcode target (module) a file belongs to, or null. Every file of a target
   * shares one scope with no imports, so the resolver treats a target the way it treats a Go
   * package directory.
   */
  swiftTargetOf?(path: string): string | null;
  /** Swift: every known target name, so `import <Target>` can be recognised as internal. */
  swiftTargets?: Set<string>;
}
