import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FileIR, Edge, SymbolKind } from '../ir/types.js';

export const SCHEMA_VERSION = 4;

/** PRAGMA busy_timeout, in ms: how long a writer waits for another process to release the lock. */
export const BUSY_TIMEOUT_MS = 5000;

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS files(
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  language TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime REAL NOT NULL,
  indexed_at REAL NOT NULL,
  error_pct INTEGER NOT NULL DEFAULT 0,
  is_test INTEGER NOT NULL DEFAULT 0,
  doc TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS symbols(
  id TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  fqn TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_byte INTEGER NOT NULL,
  end_byte INTEGER NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  doc TEXT NOT NULL DEFAULT '',
  modifiers TEXT NOT NULL DEFAULT '',
  exported INTEGER NOT NULL DEFAULT 0,
  parent TEXT,
  declared_type TEXT,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file, ordinal);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS symbols_fqn ON symbols(fqn);
CREATE INDEX IF NOT EXISTS symbols_parent ON symbols(parent);
CREATE INDEX IF NOT EXISTS symbols_kind ON symbols(kind);

CREATE TABLE IF NOT EXISTS refs(
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  byte INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualifier TEXT NOT NULL DEFAULT '',
  scope TEXT,
  arity INTEGER
);
CREATE INDEX IF NOT EXISTS refs_file ON refs(file);
CREATE INDEX IF NOT EXISTS refs_name ON refs(name);

CREATE TABLE IF NOT EXISTS imports(
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  source TEXT NOT NULL,
  names TEXT NOT NULL DEFAULT '[]',
  namespace INTEGER NOT NULL DEFAULT 0,
  alias TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'static',
  relative_level INTEGER NOT NULL DEFAULT 0,
  resolved TEXT
);
CREATE INDEX IF NOT EXISTS imports_file ON imports(file);
CREATE INDEX IF NOT EXISTS imports_resolved ON imports(resolved);

CREATE TABLE IF NOT EXISTS local_types(
  file TEXT NOT NULL,
  scope TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  via TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS local_types_file ON local_types(file);

CREATE TABLE IF NOT EXISTS edges(
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  resolver TEXT NOT NULL,
  confidence REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);
CREATE INDEX IF NOT EXISTS edges_file ON edges(file);

CREATE TABLE IF NOT EXISTS unresolved(
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  scope TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualifier TEXT NOT NULL DEFAULT '',
  candidates TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS unresolved_file ON unresolved(file);

CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  id UNINDEXED, name, split_name, fqn, signature, doc, file, tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS metrics(
  symbol TEXT PRIMARY KEY,
  pagerank REAL NOT NULL DEFAULT 0,
  in_degree INTEGER NOT NULL DEFAULT 0,
  out_degree INTEGER NOT NULL DEFAULT 0,
  callers INTEGER NOT NULL DEFAULT 0,
  callees INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS communities(
  symbol TEXT NOT NULL,
  level INTEGER NOT NULL,
  community INTEGER NOT NULL,
  PRIMARY KEY(symbol, level)
);
CREATE INDEX IF NOT EXISTS communities_c ON communities(level, community);

CREATE TABLE IF NOT EXISTS community_labels(
  level INTEGER NOT NULL,
  community INTEGER NOT NULL,
  label TEXT NOT NULL,
  size INTEGER NOT NULL,
  top_symbols TEXT NOT NULL DEFAULT '[]',
  dirs TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(level, community)
);

-- Optional semantic tier (src/embed): one unit vector per symbol, Float32 little-endian.
CREATE TABLE IF NOT EXISTS embeddings(
  symbol TEXT PRIMARY KEY,
  file TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  text_hash TEXT NOT NULL DEFAULT '',
  vec BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS embeddings_file ON embeddings(file);
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface LooseStatement {
  run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SQLInputValue[]): any;
  all(...params: SQLInputValue[]): any[];
}

export interface SymbolRow {
  id: string;
  file: string;
  ordinal: number;
  kind: SymbolKind;
  name: string;
  fqn: string;
  start_line: number;
  end_line: number;
  start_byte: number;
  end_byte: number;
  signature: string;
  doc: string;
  modifiers: string;
  exported: number;
  parent: string | null;
  declared_type: string | null;
  meta: string | null;
}

export interface FileRow {
  path: string;
  hash: string;
  language: string;
  size: number;
  mtime: number;
  indexed_at: number;
  error_pct: number;
  is_test: number;
  doc: string;
}

/** Split an identifier into lowercase words: getUserByID -> "get user by id", snake_case too. */
export function splitIdentifier(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.$#:/]+/g, ' ')
    .toLowerCase()
    .trim();
}

export function symbolId(file: string, fqn: string): string {
  return `${file}::${fqn}`;
}

export function moduleId(file: string): string {
  return file;
}

const DATA_DIR = '.symbra';

export function defaultDbPath(root: string): string {
  return join(root, DATA_DIR, 'index.db');
}

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;
  private stmts = new Map<string, StatementSync>();

  /** Loosely typed prepared statement so callers can cast rows to their own row types. */
  

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    // `timeout` maps to PRAGMA busy_timeout: the index writer and one or more MCP servers share
    // this file across processes, and without it a concurrent write throws "database is locked".
    try {
      this.db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
    } catch {
      this.db = new DatabaseSync(path);
    }
    try {
      this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    } catch {
      /* older runtimes: the constructor option above already covers us */
    }
    this.db.exec(SCHEMA);
    const v = this.getMeta('schema_version');
    if (v && Number(v) !== SCHEMA_VERSION) {
      // A schema-version bump can change table *shapes*, which `DELETE FROM` would keep. Drop
      // everything and rebuild from SCHEMA so the store really matches this version.
      this.reset({ dropTables: true });
    }
    this.setMeta('schema_version', String(SCHEMA_VERSION));
  }

  static exists(root: string): boolean {
    return existsSync(defaultDbPath(root));
  }

  close() {
    this.db.close();
  }

  /**
   * Empty the derived tables. `dropTables` additionally drops and recreates them from SCHEMA,
   * which is what a schema-version change needs (a plain DELETE keeps the old column layout).
   */
  reset(opts: { dropTables?: boolean } = {}) {
    if (opts.dropTables) {
      // Prepared statements cached against the old tables are invalid once those tables are gone.
      this.stmts.clear();
      const names = (this.db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'").all() as { name: string; type: string }[]).map((r) => r.name);
      for (const n of names) {
        try {
          this.db.exec(`DROP TABLE IF EXISTS "${n.replace(/"/g, '""')}"`);
        } catch {
          /* fts5 shadow tables disappear with their parent */
        }
      }
      this.db.exec(SCHEMA);
      return;
    }
    // `embeddings` is deliberately excluded: symbol ids are deterministic (`file::fqn`), so a
    // `--full` re-index (the caller of this path) reproduces the same ids for unchanged symbols
    // and their vectors are still valid. `embedRepo`'s own orphan-pruning step (`DELETE ...
    // WHERE symbol NOT IN (SELECT id FROM symbols)`) cleans up anything that genuinely no
    // longer exists once re-extraction has run.
    for (const t of ['files', 'symbols', 'refs', 'imports', 'local_types', 'edges', 'unresolved', 'symbols_fts', 'metrics', 'communities', 'community_labels']) {
      this.db.exec(`DELETE FROM ${t}`);
    }
  }

  prep(sql: string): LooseStatement {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s as unknown as LooseStatement;
  }

  getMeta(key: string): string | null {
    const r = this.prep('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }

  setMeta(key: string, value: string) {
    this.prep('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- files ----

  getFile(path: string): FileRow | null {
    return (this.prep('SELECT * FROM files WHERE path = ?').get(path) as FileRow | undefined) ?? null;
  }

  allFiles(): FileRow[] {
    return this.prep('SELECT * FROM files ORDER BY path').all() as FileRow[];
  }

  fileHashes(): Map<string, { hash: string; mtime: number; size: number }> {
    const m = new Map<string, { hash: string; mtime: number; size: number }>();
    for (const r of this.prep('SELECT path, hash, mtime, size FROM files').all() as { path: string; hash: string; mtime: number; size: number }[]) m.set(r.path, r);
    return m;
  }

  /**
   * Remove everything derived from a file (symbols, refs, imports, edges from it).
   * Deliberately keeps `embeddings`: symbol ids are deterministic (`file::fqn`), so a vector
   * for a symbol that re-extracts unchanged is still valid. `embedRepo` prunes rows whose
   * symbol id no longer exists once re-extraction (if any) has run.
   */
  deleteFile(path: string) {
    // FTS5 cannot use an index for `file = ?`; narrow by a phrase MATCH on the file column, then delete by rowid.
    this.prep('DELETE FROM symbols_fts WHERE rowid IN (SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH ? AND file = ?)').run(`file:"${path.replace(/"/g, '""')}"`, path);
    this.prep('DELETE FROM symbols WHERE file = ?').run(path);
    this.prep('DELETE FROM refs WHERE file = ?').run(path);
    this.prep('DELETE FROM imports WHERE file = ?').run(path);
    this.prep('DELETE FROM local_types WHERE file = ?').run(path);
    this.prep('DELETE FROM edges WHERE file = ?').run(path);
    this.prep('DELETE FROM unresolved WHERE file = ?').run(path);
    this.prep('DELETE FROM files WHERE path = ?').run(path);
  }

  /**
   * Drop the edges and candidate sets a file's resolution produced. With `keepScip`,
   * compiler-accurate edges imported from a SCIP index survive (used when an unchanged
   * file is re-resolved only because a dependency changed).
   */
  clearEdgesFrom(path: string, keepScip = false) {
    if (keepScip) this.prep("DELETE FROM edges WHERE file = ? AND resolver != 'scip'").run(path);
    else this.prep('DELETE FROM edges WHERE file = ?').run(path);
    this.prep('DELETE FROM unresolved WHERE file = ?').run(path);
  }

  /** `src|kind|line` keys of the scip edges in a file, so heuristic re-resolution can skip those call sites. */
  scipEdgeKeys(path: string): Set<string> {
    const out = new Set<string>();
    for (const r of this.prep("SELECT src, kind, line FROM edges WHERE file = ? AND resolver = 'scip'").all(path) as { src: string; kind: string; line: number }[]) out.add(`${r.src}|${r.kind}|${r.line}`);
    return out;
  }

  countScipEdges(): number {
    return (this.prep("SELECT COUNT(*) AS n FROM edges WHERE resolver = 'scip'").get() as { n: number }).n;
  }

  /** Insert a file's IR. Caller wraps in a transaction. Returns the symbol ids by ordinal. */
  insertFileIR(ir: FileIR, mtime: number, isTest: boolean): string[] {
    if (this.getFile(ir.path)) this.deleteFile(ir.path);
    this.prep('INSERT INTO files(path, hash, language, size, mtime, indexed_at, error_pct, is_test, doc) VALUES(?,?,?,?,?,?,?,?,?)').run(
      ir.path,
      ir.hash,
      ir.language,
      ir.size,
      mtime,
      Date.now(),
      ir.errorPct,
      isTest ? 1 : 0,
      ir.doc.slice(0, 2000),
    );
    const ids: string[] = [];
    const used = new Map<string, number>();
    const insSym = this.prep(
      'INSERT INTO symbols(id, file, ordinal, kind, name, fqn, start_line, end_line, start_byte, end_byte, signature, doc, modifiers, exported, parent, declared_type, meta) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    const insFts = this.prep('INSERT INTO symbols_fts(id, name, split_name, fqn, signature, doc, file) VALUES(?,?,?,?,?,?,?)');
    // module symbol
    const modName = ir.path.slice(ir.path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
    const mid = moduleId(ir.path);
    // The declared package (JVM) rides on the module symbol's meta: the resolver builds the
    // corpus-wide package index from it, so files of one package in different directories,
    // source sets or modules still share a scope.
    const modMeta = ir.pkg ? JSON.stringify({ package: ir.pkg }) : null;
    insSym.run(mid, ir.path, -1, 'module', modName, ir.path, 1, Math.max(1, ir.definitions.reduce((m, d) => Math.max(m, d.range.endLine), 1)), 0, ir.size, ir.path, ir.doc.slice(0, 2000), '', 1, null, null, modMeta);
    insFts.run(mid, modName, splitIdentifier(modName) + ' ' + splitIdentifier(ir.path), ir.path, ir.path, ir.doc.slice(0, 2000), ir.path);
    for (const d of ir.definitions) {
      let id = symbolId(ir.path, d.fqn);
      const n = used.get(id) ?? 0;
      used.set(id, n + 1);
      if (n > 0) id = `${id}#${n + 1}`;
      ids.push(id);
      const parent = d.parent >= 0 ? ids[d.parent]! : mid;
      insSym.run(id, ir.path, d.ordinal, d.kind, d.name, d.fqn, d.range.startLine, d.range.endLine, d.range.startByte, d.range.endByte, d.signature, d.doc, d.modifiers.join(' '), d.exported ? 1 : 0, parent, d.declaredType ?? null, d.meta ? JSON.stringify(d.meta) : null);
      insFts.run(id, d.name, splitIdentifier(d.name), d.fqn.replace(/\./g, ' '), d.signature, d.doc.slice(0, 4000), ir.path);
    }
    const insRef = this.prep('INSERT INTO refs(file, line, byte, kind, name, qualifier, scope, arity) VALUES(?,?,?,?,?,?,?,?)');
    for (const r of ir.references) insRef.run(ir.path, r.line, r.startByte, r.kind, r.name, r.qualifier, r.scope >= 0 ? ids[r.scope]! : mid, r.arity ?? null);
    const insImp = this.prep('INSERT INTO imports(file, line, source, names, namespace, alias, kind, relative_level, resolved) VALUES(?,?,?,?,?,?,?,?,NULL)');
    for (const i of ir.imports) insImp.run(ir.path, i.line, i.source, JSON.stringify(i.names), i.namespace ? 1 : 0, i.alias, i.kind, i.relativeLevel ?? 0);
    const insLt = this.prep('INSERT INTO local_types(file, scope, name, type, via) VALUES(?,?,?,?,?)');
    for (const t of ir.localTypes) insLt.run(ir.path, t.scope >= 0 ? ids[t.scope]! : mid, t.name, t.type, t.via);
    return ids;
  }

  // ---- symbols ----

  getSymbol(id: string): SymbolRow | null {
    return (this.prep('SELECT * FROM symbols WHERE id = ?').get(id) as SymbolRow | undefined) ?? null;
  }

  symbolsInFile(file: string): SymbolRow[] {
    return this.prep('SELECT * FROM symbols WHERE file = ? ORDER BY ordinal').all(file) as SymbolRow[];
  }

  symbolsByName(name: string): SymbolRow[] {
    return this.prep('SELECT * FROM symbols WHERE name = ?').all(name) as SymbolRow[];
  }

  /**
   * Overwrite a symbol's doc (and optionally its meta JSON), keeping `symbols_fts` in sync so
   * BM25 scores the new text. Used by the doc-inheritance pass; re-extraction rewrites the row
   * from source, so nothing here survives an edit to the file.
   * Returns false when the symbol does not exist.
   */
  updateDoc(id: string, doc: string, meta?: string | null): boolean {
    const row = this.prep('SELECT name FROM symbols WHERE id = ?').get(id) as { name: string } | undefined;
    if (!row) return false;
    if (meta === undefined) this.prep('UPDATE symbols SET doc = ? WHERE id = ?').run(doc, id);
    else this.prep('UPDATE symbols SET doc = ?, meta = ? WHERE id = ?').run(doc, meta, id);
    try {
      // FTS5 cannot use an index for `id = ?` (UNINDEXED); narrow by a phrase MATCH on name first.
      const hit = this.prep('SELECT rowid FROM symbols_fts WHERE symbols_fts MATCH ? AND id = ?').get(`name:"${row.name.replace(/"/g, '""')}"`, id) as { rowid: number } | undefined;
      if (hit) this.prep('UPDATE symbols_fts SET doc = ? WHERE rowid = ?').run(doc.slice(0, 4000), hit.rowid);
    } catch {
      /* a name the FTS tokenizer cannot phrase-match: the symbols row is still updated */
    }
    return true;
  }

  children(id: string): SymbolRow[] {
    return this.prep('SELECT * FROM symbols WHERE parent = ? ORDER BY ordinal').all(id) as SymbolRow[];
  }

  countSymbols(): number {
    return (this.prep("SELECT COUNT(*) AS n FROM symbols WHERE kind != 'module'").get() as { n: number }).n;
  }

  countEdges(): number {
    return (this.prep('SELECT COUNT(*) AS n FROM edges').get() as { n: number }).n;
  }

  // ---- edges ----

  insertEdges(edges: Edge[]) {
    const ins = this.prep('INSERT INTO edges(src, dst, kind, file, line, resolver, confidence) VALUES(?,?,?,?,?,?,?)');
    for (const e of edges) ins.run(e.src, e.dst, e.kind, e.file, e.line, e.resolver, e.confidence);
  }

  edgesFrom(id: string): (Edge & { rowid: number })[] {
    return this.prep('SELECT rowid, * FROM edges WHERE src = ?').all(id) as (Edge & { rowid: number })[];
  }

  edgesTo(id: string): (Edge & { rowid: number })[] {
    return this.prep('SELECT rowid, * FROM edges WHERE dst = ?').all(id) as (Edge & { rowid: number })[];
  }

  importers(file: string): string[] {
    return (this.prep('SELECT DISTINCT file FROM imports WHERE resolved = ?').all(file) as { file: string }[]).map((r) => r.file);
  }
}
