import type { Node, Tree } from 'web-tree-sitter';
import type { Definition, FileIR, Import, LocalTypeFact, Reference, Diagnostic } from '../ir/types.js';
import type { DefSpec, LanguageSupport, RefSpec, WalkContext } from '../languages/types.js';

export function nodeRange(n: Node) {
  return {
    startLine: n.startPosition.row + 1,
    endLine: n.endPosition.row + 1,
    startByte: n.startIndex,
    endByte: n.endIndex,
  };
}

/** Strip generics and take the last path segment: `pkg.Base<T>` -> `Base`. */
export function simpleTypeName(t: string): string {
  let s = t.trim();
  const lt = s.indexOf('<');
  if (lt > 0) s = s.slice(0, lt);
  const sq = s.indexOf('[');
  if (sq > 0) s = s.slice(0, sq);
  const cu = s.indexOf('{'); // Julia `Dict{Int,User}`, OCaml/F# object types
  if (cu > 0) s = s.slice(0, cu);
  s = s.replace(/[*&?!]+$/g, '').replace(/^[*&]+/, '');
  const parts = s.split(/::|\.|\//);
  return (parts[parts.length - 1] ?? s).trim();
}

/** Collapse whitespace in a signature line. */
export function oneLine(s: string, max = 240): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Clean a block/line comment into plain text. */
export function cleanComment(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('/**')) s = s.slice(3);
  else if (s.startsWith('/*')) s = s.slice(2);
  if (s.endsWith('*/')) s = s.slice(0, -2);
  const lines = s.split('\n').map((l) => l.replace(/^\s*(\*|\/\/\/?|#|--)\s?/, '').trimEnd());
  while (lines.length && !lines[0]?.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]?.trim()) lines.pop();
  return lines.join('\n').trim();
}

/** Collect contiguous comment siblings immediately preceding `node`. */
export function precedingComments(node: Node, commentTypes: Set<string>, maxGapLines = 1): string {
  const parts: string[] = [];
  let prev = node.previousSibling;
  let lastStart = node.startPosition.row;
  while (prev && commentTypes.has(prev.type)) {
    if (lastStart - prev.endPosition.row > maxGapLines) break;
    parts.unshift(prev.text);
    lastStart = prev.startPosition.row;
    prev = prev.previousSibling;
  }
  return parts.length ? cleanComment(parts.join('\n')) : '';
}

export interface WalkResult {
  definitions: Definition[];
  references: Reference[];
  imports: Import[];
  localTypes: LocalTypeFact[];
  diagnostics: Diagnostic[];
  doc: string;
  errorPct: number;
  /** Declared package of the file (JVM), '' when the language has none. */
  pkg: string;
}

export function walkTree(tree: Tree, source: string, path: string, lang: LanguageSupport): WalkResult {
  const definitions: Definition[] = [];
  const references: Reference[] = [];
  const imports: Import[] = [];
  const localTypes: LocalTypeFact[] = [];
  const diagnostics: Diagnostic[] = [];
  let errorBytes = 0;

  const scopeStack: number[] = [];
  const classStack: boolean[] = [];

  const ctx: WalkContext = {
    source,
    path,
    get scope() {
      return scopeStack.length ? scopeStack[scopeStack.length - 1]! : -1;
    },
    get scopeDef() {
      const s = scopeStack.length ? scopeStack[scopeStack.length - 1]! : -1;
      return s >= 0 ? definitions[s]! : null;
    },
    get inClass() {
      return classStack.length ? classStack[classStack.length - 1]! : false;
    },
    get inTest() {
      for (const s of scopeStack) if (definitions[s]!.kind === 'test') return true;
      return false;
    },
    emitRef(ref: RefSpec, node: Node) {
      const n = ref.node ?? node;
      references.push({
        kind: ref.kind,
        name: ref.name,
        qualifier: ref.qualifier ?? '',
        line: n.startPosition.row + 1,
        startByte: n.startIndex,
        scope: scopeStack.length ? scopeStack[scopeStack.length - 1]! : -1,
        arity: ref.arity,
      });
    },
    emitImport(imp: Import) {
      imports.push(imp);
    },
    emitLocalType(fact) {
      localTypes.push({ ...fact, scope: scopeStack.length ? scopeStack[scopeStack.length - 1]! : -1 });
    },
    emitDef(spec: DefSpec, node: Node, parent: number) {
      return addDefinition(spec, node, parent);
    },
    text(n) {
      return n ? n.text : '';
    },
  };

  function addDefinition(spec: DefSpec, node: Node, parent: number): number {
    const ordinal = definitions.length;
    const parentDef = parent >= 0 ? definitions[parent] : undefined;
    const prefix = spec.container ? spec.container : parentDef ? parentDef.fqn : '';
    const fqn = prefix ? `${prefix}.${spec.name}` : spec.name;
    definitions.push({
      ordinal,
      kind: spec.kind,
      name: spec.name,
      fqn,
      range: nodeRange(spec.rangeNode ?? node),
      parent,
      signature: spec.signature ?? '',
      doc: spec.doc ?? '',
      modifiers: spec.modifiers ?? [],
      exported: spec.exported ?? false,
      supertypes: spec.supertypes ?? [],
      declaredType: spec.declaredType,
      meta: spec.meta,
    });
    return ordinal;
  }

  function visit(node: Node): void {
    if (node.type === 'ERROR' || node.isMissing) {
      errorBytes += node.endIndex - node.startIndex;
      // still descend: partial trees often carry useful definitions
    }
    if (lang.skip?.has(node.type)) return;

    const def = lang.definition(node, ctx);
    if (def) {
      const parent = ctx.scope;
      const ordinal = addDefinition(def, node, parent);
      // Emit supertypes as references from the new definition's scope.
      scopeStack.push(ordinal);
      classStack.push(lang.classLike.has(node.type) || def.kind === 'class' || def.kind === 'interface' || def.kind === 'struct' || def.kind === 'enum' || def.kind === 'trait');
      for (const st of def.supertypes ?? []) {
        const qual = st.name.includes('.') ? st.name.slice(0, st.name.lastIndexOf('.')) : '';
        references.push({
          kind: st.kind,
          name: simpleTypeName(st.name),
          qualifier: qual,
          line: node.startPosition.row + 1,
          startByte: node.startIndex,
          scope: ordinal,
        });
      }
      // Walk all children except we let the language decide on references for the def node itself.
      lang.references(node, ctx);
      for (const child of node.children) if (child) visit(child);
      scopeStack.pop();
      classStack.pop();
      return;
    }

    const imps = lang.imports(node, ctx);
    if (imps) {
      for (const imp of imps) imports.push(imp);
      return;
    }

    const stop = lang.references(node, ctx);
    if (stop) return;
    for (const child of node.children) if (child) visit(child);
  }

  const root = tree.rootNode;
  for (const child of root.children) if (child) visit(child);

  lang.postWalk?.(definitions);

  const doc = lang.moduleDoc ? lang.moduleDoc(root, ctx) : '';
  const pkg = lang.modulePackage ? lang.modulePackage(root, ctx) : '';
  const errorPct = source.length ? Math.min(100, Math.round((errorBytes / source.length) * 100)) : 0;
  if (errorPct > 0) diagnostics.push({ severity: errorPct > 20 ? 'warning' : 'info', message: `parse errors cover ${errorPct}% of file` });
  return { definitions, references, imports, localTypes, diagnostics, doc, errorPct, pkg };
}

export function toFileIR(path: string, language: string, hash: string, size: number, r: WalkResult): FileIR {
  return { path, language, hash, size, ...r };
}

/** Non-null named children (web-tree-sitter types them as nullable). */
export function named(n: Node | null | undefined): Node[] {
  if (!n) return [];
  return n.namedChildren.filter((c): c is Node => c !== null);
}

/** Non-null children. */
export function kids(n: Node | null | undefined): Node[] {
  if (!n) return [];
  return n.children.filter((c): c is Node => c !== null);
}

const REOPENABLE_TYPE_KINDS = new Set(['class', 'struct', 'enum', 'interface', 'trait']);

/**
 * Reparent the members of a reopened block (`impl X` in Rust, `extension X` in Swift) onto the type
 * they extend, when that type is defined in the same file.
 *
 * The block itself is indexed as a class so that `impl Trait for X` still carries the `implements`
 * link, but its members belong to `X`: without this a Rust struct looks as if it has no methods and
 * every `X.method` hangs off an anonymous block instead. When the extended type lives in another
 * file there is nothing to attach to, so the block stays the container.
 *
 * A `postWalk` hook: languages with reopened blocks (rust, swift) install it; the rest do not.
 */
export function reparentReopenedBlocks(defs: Definition[]): void {
  const reopened = (d: Definition | undefined) => !!(d && d.meta && (d.meta.impl === true || d.meta.extension === true));
  const types = new Map<string, number>();
  for (const d of defs) if (!reopened(d) && REOPENABLE_TYPE_KINDS.has(d.kind) && !types.has(d.name)) types.set(d.name, d.ordinal);
  if (!types.size) return;
  const isDescendantOf = (ordinal: number, ancestor: number) => {
    for (let cur = ordinal, guard = 0; cur >= 0 && guard < defs.length; guard++) {
      if (cur === ancestor) return true;
      cur = defs[cur]?.parent ?? -1;
    }
    return false;
  };
  for (const d of defs) {
    const block = d.parent >= 0 ? defs[d.parent] : undefined;
    if (!reopened(block)) continue;
    const target = types.get(block!.name);
    if (target === undefined || target === d.ordinal) continue;
    if (isDescendantOf(target, d.ordinal)) continue; // the type is nested inside the member: leave it
    d.parent = target;
    const prefix = defs[target]!.fqn;
    d.fqn = prefix ? `${prefix}.${d.name}` : d.name;
    // Members of the moved member (a nested fn inside a method) keep their fqn prefix, which was
    // built from the block's fqn — identical to the type's, since the block is named after it.
  }
}
