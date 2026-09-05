/**
 * Doc inheritance: implementations rarely carry documentation — the doc lives on the interface
 * or the base class. `Mediator.Send` has no `<summary>`; `ISender.Send` has it. Without this
 * pass the implementation is invisible to both BM25 and the embedder, because neither its FTS
 * row nor its embedded text contains a single word of the prose that describes what it does.
 *
 * Runs after resolution (it needs `extends`/`implements` edges) and before embedding, so the
 * inherited text is part of the symbol's `text_hash` and gets re-embedded automatically.
 */
import type { Store } from '../store/db.js';

/** Members that inherit a doc from a same-named member of a supertype. */
const MEMBER_KINDS = ['method', 'property', 'constructor', 'function'] as const;
/** Declarations that can sit in an `extends`/`implements` chain. */
const TYPE_KINDS = ['class', 'interface', 'struct', 'trait', 'enum'] as const;
/** How far up the supertype chain to look. Deep hierarchies rarely say anything more useful. */
const MAX_DEPTH = 6;

export interface InheritDocsOptions {
  /**
   * Repo-relative paths that changed. When given, only symbols in those files and members of
   * types that (transitively) extend/implement a type declared in them are considered.
   * Omit for a full pass.
   */
  files?: Iterable<string>;
  log?: (msg: string) => void;
}

interface MemberRow {
  id: string;
  name: string;
  kind: string;
  doc: string;
  ordinal: number;
  meta: string | null;
}

interface TypeRow {
  id: string;
  doc: string;
  meta: string | null;
}

function parseMeta(meta: string | null): Record<string, unknown> {
  if (!meta) return {};
  try {
    const parsed: unknown = JSON.parse(meta);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* not JSON (shouldn't happen): start fresh rather than lose the doc */
  }
  return {};
}

/** The symbol id an inherited doc came from, or null when the doc is the symbol's own. */
function docFrom(meta: string | null): string | null {
  const v = parseMeta(meta).doc_from;
  return typeof v === 'string' ? v : null;
}

/** Merge `doc_from` into a symbol's existing meta JSON without dropping the other keys. */
function withProvenance(meta: string | null, from: string | null): string | null {
  const obj = parseMeta(meta);
  if (from === null) delete obj.doc_from;
  else obj.doc_from = from;
  return Object.keys(obj).length ? JSON.stringify(obj) : null;
}

/**
 * Copy documentation down the type hierarchy: an undocumented member takes the doc of the
 * first same-named member found walking its type's supertypes breadth-first, and an
 * undocumented class that implements exactly one documented interface takes that interface's.
 *
 * Only symbols whose own doc is empty are touched, which makes the pass idempotent: a second
 * run finds nothing, and re-extraction (which rewrites the row from source) always wins.
 *
 * @returns the number of symbols whose doc was filled in.
 */
export function inheritDocs(store: Store, opts: InheritDocsOptions = {}): number {
  const supers = new Map<string, string[]>();
  const subs = new Map<string, string[]>();
  const implementsOnly = new Map<string, string[]>();
  for (const e of store
    .prep("SELECT src, dst, kind FROM edges WHERE kind IN ('extends','implements') ORDER BY src, kind, dst")
    .all() as { src: string; dst: string; kind: string }[]) {
    if (e.src === e.dst) continue;
    const s = supers.get(e.src);
    if (s) {
      if (!s.includes(e.dst)) s.push(e.dst);
    } else supers.set(e.src, [e.dst]);
    const b = subs.get(e.dst);
    if (b) {
      if (!b.includes(e.src)) b.push(e.src);
    } else subs.set(e.dst, [e.src]);
    if (e.kind === 'implements') {
      const i = implementsOnly.get(e.src);
      if (i) {
        if (!i.includes(e.dst)) i.push(e.dst);
      } else implementsOnly.set(e.src, [e.dst]);
    }
  }
  if (!supers.size) return 0;

  const typePlaceholders = TYPE_KINDS.map(() => '?').join(',');
  const memberPlaceholders = MEMBER_KINDS.map(() => '?').join(',');

  // Which types to consider. A full pass takes every type that has a supertype; an incremental
  // one takes the types declared in the changed files plus everything below them, since a doc
  // added to a base has to reach subclasses whose own files did not change.
  let targets: string[];
  if (opts.files) {
    const changed = new Set(opts.files);
    const seed = new Set<string>();
    if (!changed.size) return 0;
    const byFile = store.prep(`SELECT id FROM symbols WHERE file = ? AND kind IN (${typePlaceholders})`);
    for (const f of changed) for (const r of byFile.all(f, ...TYPE_KINDS) as { id: string }[]) seed.add(r.id);
    // Types already holding a doc inherited from a changed file: their copy may now be stale
    // (the source doc was edited, or the source is gone) even though their own file is untouched.
    for (const r of store.prep("SELECT id, parent, meta FROM symbols WHERE meta IS NOT NULL AND meta LIKE '%doc_from%'").all() as { id: string; parent: string | null; meta: string | null }[]) {
      const from = docFrom(r.meta);
      if (!from) continue;
      const file = from.includes('::') ? from.slice(0, from.indexOf('::')) : from;
      if (!changed.has(file)) continue;
      seed.add(r.parent ?? r.id);
      seed.add(r.id);
    }
    // Everything that (transitively) derives from a type in a changed file.
    const queue = [...seed];
    const seen = new Set(queue);
    for (let i = 0; i < queue.length; i++) {
      for (const child of subs.get(queue[i]!) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        queue.push(child);
      }
    }
    targets = [...seen].filter((id) => supers.has(id)).sort();
  } else {
    targets = [...supers.keys()].sort();
  }
  if (!targets.length) return 0;

  const getType = store.prep(`SELECT id, doc, meta FROM symbols WHERE id = ? AND kind IN (${typePlaceholders})`);
  const getMembers = store.prep(`SELECT id, name, kind, doc, ordinal, meta FROM symbols WHERE parent = ? AND kind IN (${memberPlaceholders}) ORDER BY ordinal`);

  const typeCache = new Map<string, TypeRow | null>();
  const type = (id: string): TypeRow | null => {
    let t = typeCache.get(id);
    if (t === undefined) {
      t = (getType.get(id, ...TYPE_KINDS) as TypeRow | undefined) ?? null;
      typeCache.set(id, t);
    }
    return t;
  };
  const memberCache = new Map<string, MemberRow[]>();
  const members = (id: string): MemberRow[] => {
    let m = memberCache.get(id);
    if (!m) {
      m = getMembers.all(id, ...MEMBER_KINDS) as MemberRow[];
      memberCache.set(id, m);
    }
    return m;
  };

  /** Supertypes of `id`, breadth-first, nearest first, cycle-safe, bounded by MAX_DEPTH. */
  const ancestors = (id: string): string[] => {
    const out: string[] = [];
    const seen = new Set([id]);
    let frontier = supers.get(id) ?? [];
    for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
      const next: string[] = [];
      for (const s of frontier) {
        if (seen.has(s)) continue;
        seen.add(s);
        out.push(s);
        for (const up of supers.get(s) ?? []) if (!seen.has(up)) next.push(up);
      }
      frontier = next;
    }
    return out;
  };

  // Collect first, write second: reading a snapshot of the docs makes the result independent of
  // the order types are visited in (a doc inherited during this run never becomes a source).
  const updates: { id: string; doc: string; from: string | null; meta: string | null }[] = [];
  for (const id of targets) {
    const self = type(id);
    if (!self) continue;
    const own = members(id);
    // Eligible: no doc of its own, or a doc this pass put there before (which may now be stale).
    const undocumented = own.filter((m) => !m.doc.trim() || docFrom(m.meta));
    const needsClassDoc = !self.doc.trim() || !!docFrom(self.meta);
    if (!undocumented.length && !needsClassDoc) continue;

    const chain = ancestors(id);

    if (needsClassDoc) {
      // Only the unambiguous case: exactly one implemented interface, and it says something.
      const direct = implementsOnly.get(id) ?? [];
      const ifaces = direct.map((s) => type(s)).filter((t): t is TypeRow => !!t && !!t.doc.trim() && !docFrom(t.meta));
      const source = direct.length === 1 && ifaces.length === 1 ? ifaces[0]! : null;
      const doc = source ? source.doc : '';
      const from = source ? source.id : null;
      if (doc !== self.doc || from !== docFrom(self.meta)) updates.push({ id, doc, from, meta: self.meta });
    }

    if (undocumented.length) {
      // Overload position within the type, so `Send`/`Send#2`/`Send#3` line up with the
      // supertype's overloads instead of all collapsing onto the first one.
      const seenName = new Map<string, number>();
      const overloadIndex = new Map<string, number>();
      for (const m of own) {
        const n = seenName.get(m.name) ?? 0;
        seenName.set(m.name, n + 1);
        overloadIndex.set(m.id, n);
      }
      for (const m of undocumented) {
        const idx = overloadIndex.get(m.id) ?? 0;
        let source: MemberRow | null = null;
        for (const anc of chain) {
          // An inherited doc is never a source: every member resolves against the original.
          const sameName = members(anc).filter((x) => x.name === m.name && x.doc.trim() && !docFrom(x.meta));
          if (!sameName.length) continue;
          source = sameName[Math.min(idx, sameName.length - 1)] ?? sameName[0]!;
          break;
        }
        const doc = source ? source.doc : '';
        const from = source ? source.id : null;
        if (doc !== m.doc || from !== docFrom(m.meta)) updates.push({ id: m.id, doc, from, meta: m.meta });
      }
    }
  }

  if (!updates.length) return 0;
  store.transaction(() => {
    for (const u of updates) store.updateDoc(u.id, u.doc, withProvenance(u.meta, u.from));
  });
  opts.log?.(`inherited docs for ${updates.length} symbol(s)`);
  return updates.length;
}
