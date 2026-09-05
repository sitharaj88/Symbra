import type { Definition, FileIR, Import, Reference, SymbolKind } from '../ir/types.js';
import type { LanguageSupport } from './types.js';
import { contentHash } from '../index/extract.js';
import { oneLine, cleanComment } from '../parse/walk.js';

/**
 * SQL extraction without a grammar.
 *
 * No tree-sitter SQL grammar ships as WASM, so this is a small scanner: mask comments, string
 * literals and dollar-quoted bodies, split the file into statements, then match each statement
 * head against the DDL shapes worth indexing. Masking runs first so that quoting never confuses
 * statement splitting, and every offset in the masked text lines up 1:1 with the original — the
 * masked copy is the same length as the source, so ranges and docs can always be read back from
 * the real text.
 */

// --- lexical scaffolding ------------------------------------------------------------------------

const IDENT = String.raw`(?:"[^"\n]*"|\`[^\`\n]*\`|\[[^\]\n]*\]|[A-Za-z_][A-Za-z0-9_$]*)`;
const QNAME = String.raw`${IDENT}(?:\s*\.\s*${IDENT}){0,2}`;

/** Words that end a column's type and start its constraints. */
const COLUMN_CONSTRAINT_START = new Set([
  'NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'CHECK', 'GENERATED', 'COLLATE',
  'CONSTRAINT', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'IDENTITY', 'COMMENT', 'AS', 'STORED',
  'VIRTUAL', 'ENCODE', 'ENCRYPTED', 'SPARSE', 'FILESTREAM', 'ROWGUIDCOL', 'MASKED', 'ON',
  'DEFERRABLE', 'INVISIBLE', 'SRID', 'CHARACTER_SET', 'COLUMN_FORMAT', 'STORAGE',
]);
/** Table-constraint items inside `CREATE TABLE (...)` — not columns. */
const TABLE_CONSTRAINT_START = new Set([
  'CONSTRAINT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'EXCLUDE', 'KEY', 'INDEX', 'FULLTEXT',
  'SPATIAL', 'PERIOD', 'LIKE', 'INHERITS', 'PARTITION',
]);
/** Never a table name after FROM/JOIN. */
const NOT_A_TABLE = new Set([
  'SELECT', 'LATERAL', 'VALUES', 'DUAL', 'ONLY', 'UNNEST', 'GENERATE_SERIES', 'JSON_TABLE',
  'OPENJSON', 'TABLE', 'ROWS', 'WITH', 'AS', 'SET', 'WHERE',
]);
/** Functions and keywords that must not become call references. */
const SQL_BUILTINS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'exists', 'between', 'like', 'ilike', 'is',
  'null', 'case', 'when', 'then', 'else', 'end', 'if', 'group', 'order', 'by', 'having', 'limit',
  'offset', 'union', 'intersect', 'except', 'join', 'inner', 'left', 'right', 'full', 'outer',
  'cross', 'on', 'using', 'as', 'distinct', 'all', 'into', 'values', 'set', 'update', 'delete',
  'insert', 'returning', 'with', 'recursive', 'over', 'partition', 'window', 'filter', 'within',
  'cast', 'coalesce', 'nullif', 'greatest', 'least', 'count', 'sum', 'avg', 'min', 'max', 'abs',
  'round', 'ceil', 'ceiling', 'floor', 'mod', 'power', 'sqrt', 'exp', 'ln', 'log', 'random',
  'length', 'char_length', 'character_length', 'lower', 'upper', 'initcap', 'trim', 'ltrim',
  'rtrim', 'lpad', 'rpad', 'substr', 'substring', 'position', 'replace', 'split_part', 'concat',
  'concat_ws', 'format', 'to_char', 'to_date', 'to_number', 'to_timestamp', 'date_trunc',
  'date_part', 'extract', 'age', 'now', 'current_date', 'current_time', 'current_timestamp',
  'localtime', 'localtimestamp', 'array', 'array_agg', 'string_agg', 'json_agg', 'jsonb_agg',
  'json_build_object', 'jsonb_build_object', 'row_number', 'rank', 'dense_rank', 'ntile', 'lag',
  'lead', 'first_value', 'last_value', 'nth_value', 'generate_series', 'unnest', 'exists',
  'char', 'varchar', 'text', 'int', 'integer', 'bigint', 'smallint', 'decimal', 'numeric', 'real',
  'double', 'float', 'boolean', 'bool', 'date', 'time', 'timestamp', 'timestamptz', 'interval',
  'uuid', 'json', 'jsonb', 'bytea', 'blob', 'clob', 'enum', 'serial', 'bigserial', 'money',
  'nvarchar', 'nchar', 'binary', 'varbinary', 'returns', 'return', 'begin', 'declare', 'raise',
  'commit', 'rollback', 'grant', 'revoke', 'references', 'primary', 'foreign', 'unique', 'check',
  'default', 'constraint', 'table', 'index', 'view', 'trigger', 'function', 'procedure', 'language',
  'for', 'loop', 'while', 'perform', 'execute', 'call', 'do', 'immutable', 'stable', 'volatile',
  'strict', 'security', 'definer', 'invoker', 'setof', 'out', 'inout', 'variadic', 'nextval',
  'currval', 'setval', 'md5', 'encode', 'decode', 'convert', 'try_cast', 'iif', 'isnull', 'nvl',
]);

interface Masked {
  /** Same length as the source; comments and literals replaced by spaces. */
  text: string;
  /** Byte ranges of dollar-quoted bodies, so `;` inside a function body never splits. */
  dollarRanges: [number, number][];
  /** Line index (0-based) -> true when the whole line is a comment. */
  commentLine: boolean[];
}

function isIdentChar(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}

/** Replace comments, string literals and dollar-quote delimiters with spaces, newlines kept. */
function maskSql(src: string): Masked {
  const out = src.split('');
  const dollarRanges: [number, number][] = [];
  const lineCount = src.split('\n').length;
  const commentLine: boolean[] = new Array(lineCount).fill(false);
  const nonComment: boolean[] = new Array(lineCount).fill(false);
  let line = 0;
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < src.length; i++) if (src[i] !== '\n') out[i] = ' ';
  };
  const markComment = (from: number, to: number): void => {
    let l = line;
    for (let i = from; i < to && i < src.length; i++) {
      if (src[i] === '\n') l++;
      else commentLine[l] ||= true;
    }
  };
  let dollarTag: string | null = null;
  let dollarStart = 0;

  for (let i = 0; i < src.length; ) {
    const c = src[i]!;
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (dollarTag) {
      if (src.startsWith(dollarTag, i)) {
        dollarRanges.push([dollarStart, i]);
        blank(i, i + dollarTag.length);
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
    }
    if (c === '-' && src[i + 1] === '-') {
      const nl = src.indexOf('\n', i);
      const end = nl < 0 ? src.length : nl;
      markComment(i, end);
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '#' && (i === 0 || src[i - 1] === '\n')) {
      // MySQL line comment.
      const nl = src.indexOf('\n', i);
      const end = nl < 0 ? src.length : nl;
      markComment(i, end);
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (src[j] === '*' && src[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      markComment(i, j);
      blank(i, j);
      for (let k = i; k < j && k < src.length; k++) if (src[k] === '\n') line++;
      i = j;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\' && src[j + 1]) j += 2;
        else if (src[j] === "'" && src[j + 1] === "'") j += 2;
        else if (src[j] === "'") {
          j++;
          break;
        } else {
          if (src[j] === '\n') line++;
          j++;
        }
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === '`') {
      // Quoted identifier: keep the text, just skip past it.
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\n') line++;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === '$' && !dollarTag) {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(src.slice(i, i + 64));
      if (m) {
        dollarTag = m[0];
        blank(i, i + dollarTag.length);
        i += dollarTag.length;
        dollarStart = i;
        continue;
      }
    }
    nonComment[line] = true;
    i++;
  }
  if (dollarTag) dollarRanges.push([dollarStart, src.length]);
  for (let l = 0; l < lineCount; l++) if (nonComment[l]) commentLine[l] = false;
  return { text: out.join(''), dollarRanges, commentLine };
}

/** Statement byte ranges, honouring parens, `BEGIN … END` bodies and dollar-quoted regions. */
function splitStatements(m: Masked): [number, number][] {
  const src = m.text;
  const out: [number, number][] = [];
  let start = 0;
  let paren = 0;
  let beginDepth = 0;
  let caseDepth = 0;
  let word = '';
  let wordStart = 0;
  const dollar = m.dollarRanges;
  let di = 0;

  const flushWord = (): void => {
    if (!word) return;
    const w = word.toUpperCase();
    if (w === 'CASE') caseDepth++;
    else if (w === 'BEGIN') {
      // `BEGIN;` / `BEGIN TRANSACTION` opens no block.
      const after = src.slice(wordStart + word.length, wordStart + word.length + 20).trim().toUpperCase();
      if (!/^(;|TRANSACTION|WORK|ISOLATION|$)/.test(after)) beginDepth++;
    } else if (w === 'END') {
      if (caseDepth > 0) caseDepth--;
      else if (beginDepth > 0) beginDepth--;
    }
    word = '';
  };

  for (let i = 0; i < src.length; i++) {
    while (di < dollar.length && dollar[di]![1] <= i) di++;
    const region = dollar[di];
    if (region && i >= region[0] && i < region[1]) {
      flushWord();
      continue; // body text: never a statement boundary
    }
    const c = src[i]!;
    if (isIdentChar(c)) {
      if (!word) wordStart = i;
      word += c;
      continue;
    }
    flushWord();
    if (c === '(') paren++;
    else if (c === ')') paren = Math.max(0, paren - 1);
    else if (c === ';' && paren === 0 && beginDepth === 0) {
      if (src.slice(start, i).trim()) out.push([start, i]);
      start = i + 1;
      caseDepth = 0;
    }
  }
  if (src.slice(start).trim()) out.push([start, src.length]);
  return out;
}

function unquoteIdent(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const a = t[0]!;
    const b = t[t.length - 1]!;
    if ((a === '"' && b === '"') || (a === '`' && b === '`') || (a === '[' && b === ']')) return t.slice(1, -1);
  }
  return t;
}

/** `public"."users` style qualified names -> `{ name, qualifier }`. */
function splitQName(raw: string): { name: string; qualifier: string } {
  const parts = raw.split('.').map((p) => unquoteIdent(p));
  const name = parts[parts.length - 1] ?? '';
  const qualifier = parts.slice(0, -1).join('.');
  return { name, qualifier };
}

/** Index of the matching `)` for the `(` at `open`, or -1. */
function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a parenthesised list on top-level commas; returns [start, end) offsets into `text`. */
function splitTopLevel(text: string, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push([start, i]);
      start = i + 1;
    }
  }
  if (text.slice(start, to).trim()) out.push([start, to]);
  return out;
}

/** Strip a column definition's trailing constraints, leaving the declared type. */
function typeOfColumn(rest: string): string {
  let depth = 0;
  let word = '';
  let cut = rest.length;
  for (let i = 0; i <= rest.length; i++) {
    const c = i < rest.length ? rest[i]! : ' ';
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (depth === 0 && isIdentChar(c)) {
      if (!word) word = c;
      else word += c;
      continue;
    }
    if (word) {
      if (depth === 0 && COLUMN_CONSTRAINT_START.has(word.toUpperCase())) {
        cut = i - word.length;
        break;
      }
      word = '';
    }
  }
  return oneLine(rest.slice(0, cut).trim(), 80);
}

// --- extraction ---------------------------------------------------------------------------------

const CREATE_RE = new RegExp(
  String.raw`^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL|TEMPORARY|TEMP|UNLOGGED|MATERIALIZED|UNIQUE|CLUSTERED|NONCLUSTERED|FULLTEXT|SPATIAL|VIRTUAL|EXTERNAL|SECURE|RECURSIVE|CONCURRENTLY|ALGORITHM\s*=\s*\w+|DEFINER\s*=\s*\S+|SQL\s+SECURITY\s+\w+)\s+)*` +
    String.raw`(TABLE|VIEW|INDEX|FUNCTION|PROCEDURE|TRIGGER|TYPE|SEQUENCE|SCHEMA)\b\s*(?:IF\s+NOT\s+EXISTS\s+)?(${QNAME})?`,
  'i',
);
const ALTER_RE = new RegExp(String.raw`^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QNAME})`, 'i');
const COMMENT_RE = new RegExp(
  String.raw`^\s*COMMENT\s+ON\s+(TABLE|COLUMN|VIEW|FUNCTION|PROCEDURE|TYPE|SCHEMA|INDEX)\s+(${QNAME})\s+IS\b`,
  'i',
);
const TABLE_REF_RE = new RegExp(String.raw`\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:ONLY\s+)?(${QNAME})`, 'gi');
const REFERENCES_RE = new RegExp(String.raw`\bREFERENCES\s+(${QNAME})`, 'gi');
const CALL_RE = /\b([A-Za-z_][A-Za-z0-9_$]*)\s*\(/g;

const OBJECT_KIND: Record<string, SymbolKind> = {
  TABLE: 'struct',
  VIEW: 'struct',
  INDEX: 'variable',
  FUNCTION: 'function',
  PROCEDURE: 'function',
  TRIGGER: 'function',
  TYPE: 'type_alias',
  SEQUENCE: 'variable',
  SCHEMA: 'namespace',
};

export function extractSql(path: string, content: string): FileIR {
  const masked = maskSql(content);
  const mtext = masked.text;
  const definitions: Definition[] = [];
  const references: Reference[] = [];

  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') lineStarts.push(i + 1);
  const lineAt = (byte: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= byte) lo = mid;
      else hi = mid - 1;
    }
    return lo; // 0-based
  };

  interface DefOpts {
    signature?: string;
    doc?: string;
    declaredType?: string;
    meta?: Definition['meta'];
    modifiers?: string[];
  }
  const addDef = (kind: SymbolKind, name: string, parent: number, start: number, end: number, opts: DefOpts = {}): number => {
    const ordinal = definitions.length;
    const parentFqn = parent >= 0 ? definitions[parent]!.fqn : '';
    definitions.push({
      ordinal,
      kind,
      name,
      fqn: parentFqn ? `${parentFqn}.${name}` : name,
      range: { startLine: lineAt(start) + 1, endLine: lineAt(Math.max(start, end - 1)) + 1, startByte: start, endByte: end },
      parent,
      signature: opts.signature ?? '',
      doc: opts.doc ?? '',
      modifiers: opts.modifiers ?? [],
      exported: true,
      supertypes: [],
      declaredType: opts.declaredType,
      meta: opts.meta,
    });
    return ordinal;
  };
  const addRef = (kind: Reference['kind'], name: string, qualifier: string, byte: number, scope: number): void => {
    if (!name) return;
    references.push({ kind, name, qualifier, line: lineAt(byte) + 1, startByte: byte, scope });
  };

  /** Contiguous full-line comments immediately above a statement. */
  const docAbove = (start: number): string => {
    const first = lineAt(start);
    const parts: string[] = [];
    for (let l = first - 1; l >= 0; l--) {
      if (!masked.commentLine[l]) break;
      const from = lineStarts[l]!;
      const to = l + 1 < lineStarts.length ? lineStarts[l + 1]! - 1 : content.length;
      parts.unshift(content.slice(from, to));
    }
    return parts.length ? cleanComment(parts.join('\n')) : '';
  };

  /** Tables and functions a body reads. */
  const scanBody = (from: number, to: number, scope: number, ownName: string): void => {
    const body = mtext.slice(from, to);
    let m: RegExpExecArray | null;
    /** Offsets already claimed as table names, so `INSERT INTO t (…)` is not also a call. */
    const tableAt = new Set<number>();
    TABLE_REF_RE.lastIndex = 0;
    while ((m = TABLE_REF_RE.exec(body))) {
      const raw = m[1]!;
      const at = m.index + m[0].length - raw.length;
      const { name, qualifier } = splitQName(raw);
      tableAt.add(at);
      if (!name || NOT_A_TABLE.has(name.toUpperCase())) continue;
      if (name === ownName) continue;
      addRef('value', name, qualifier, from + at, scope);
    }
    CALL_RE.lastIndex = 0;
    while ((m = CALL_RE.exec(body))) {
      const name = m[1]!;
      if (tableAt.has(m.index)) continue;
      if (SQL_BUILTINS.has(name.toLowerCase())) continue;
      if (name === ownName) continue;
      addRef('call', name, '', from + m.index, scope);
    }
  };

  const byName = new Map<string, number>();
  const rememberDef = (name: string, ordinal: number): void => {
    if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), ordinal);
  };

  for (const [rawStart, end] of splitStatements(masked)) {
    const lead = mtext.slice(rawStart, end);
    // Skip the whitespace the previous `;` left behind so ranges start on the real first line.
    const start = rawStart + (lead.length - lead.trimStart().length);
    const stmt = mtext.slice(start, end);
    const doc = docAbove(start);

    const create = CREATE_RE.exec(stmt);
    if (create) {
      const objectWord = create[1]!.toUpperCase();
      const rawName = create[2] ?? '';
      const { name, qualifier } = splitQName(rawName);
      const headEnd = create.index + create[0].length;
      const signature = oneLine(stmt.slice(0, Math.min(stmt.length, headEnd + 40)).trim(), 160);
      const meta: NonNullable<Definition['meta']> = { sql: objectWord.toLowerCase() };
      if (qualifier) meta.schema = qualifier;

      if (objectWord === 'TABLE') {
        if (!name) continue;
        const ordinal = addDef('struct', name, -1, start, end, { signature, doc, meta });
        rememberDef(name, ordinal);
        const open = mtext.indexOf('(', start + headEnd - 1);
        const close = open >= 0 && open < end ? matchParen(mtext, open) : -1;
        if (open >= 0 && close > open && close <= end) {
          for (const [a, b] of splitTopLevel(mtext, open + 1, close)) {
            const item = mtext.slice(a, b);
            const trimmed = item.trim();
            if (!trimmed) continue;
            const firstWord = /^([A-Za-z_]\w*)/.exec(trimmed)?.[1]?.toUpperCase() ?? '';
            if (TABLE_CONSTRAINT_START.has(firstWord)) continue;
            const cm = new RegExp(String.raw`^\s*(${IDENT})\s+([\s\S]+)$`).exec(item);
            if (!cm) continue;
            const colName = unquoteIdent(cm[1]!);
            const declaredType = typeOfColumn(cm[2]!);
            const colStart = a + item.indexOf(cm[1]!);
            addDef('field', colName, ordinal, colStart, b, {
              signature: oneLine(trimmed, 120),
              declaredType,
              meta: /\bPRIMARY\s+KEY\b/i.test(item) ? { primaryKey: true } : undefined,
            });
            // A column typed with a user-defined type (an enum, a domain, a composite) links to it.
            const baseType = declaredType.replace(/\s*\(.*$/, '').replace(/\[\s*\]$/, '').trim();
            if (baseType && /^[A-Za-z_][\w.]*$/.test(baseType) && !SQL_BUILTINS.has(baseType.toLowerCase())) {
              const t = splitQName(baseType);
              addRef('type', t.name, t.qualifier, colStart, ordinal);
            }
          }
          // Every REFERENCES in the table body is an edge from this table to the target table.
          REFERENCES_RE.lastIndex = 0;
          let r: RegExpExecArray | null;
          const bodyText = mtext.slice(open, close);
          while ((r = REFERENCES_RE.exec(bodyText))) {
            const target = splitQName(r[1]!);
            if (target.name && target.name.toLowerCase() !== name.toLowerCase()) {
              addRef('value', target.name, target.qualifier, open + r.index, ordinal);
            }
          }
        } else {
          // CREATE TABLE … AS SELECT …
          scanBody(start + headEnd, end, ordinal, name);
        }
        continue;
      }

      if (objectWord === 'VIEW') {
        if (!name) continue;
        const ordinal = addDef('struct', name, -1, start, end, { signature, doc, meta: { ...meta, view: true } });
        rememberDef(name, ordinal);
        const asAt = /\bAS\b/i.exec(stmt.slice(headEnd));
        const bodyFrom = asAt ? start + headEnd + asAt.index + 2 : start + headEnd;
        scanBody(bodyFrom, end, ordinal, name);
        continue;
      }

      if (objectWord === 'INDEX') {
        const onMatch = new RegExp(String.raw`\bON\s+(?:ONLY\s+)?(${QNAME})`, 'i').exec(stmt);
        const target = onMatch ? splitQName(onMatch[1]!) : null;
        // `CREATE INDEX ON t (…)` has no index name.
        const indexName = name && name.toUpperCase() !== 'ON' ? name : '';
        const idxMeta: NonNullable<Definition['meta']> = { ...meta };
        if (target?.name) idxMeta.table = target.name;
        if (/\bUNIQUE\b/i.test(stmt.slice(0, create.index + create[0].length))) idxMeta.unique = true;
        const parent = target ? byName.get(target.name.toLowerCase()) ?? -1 : -1;
        const ordinal = indexName ? addDef('variable', indexName, parent, start, end, { signature, doc, meta: idxMeta }) : parent;
        if (target?.name) addRef('value', target.name, target.qualifier, start + (onMatch?.index ?? 0), ordinal);
        continue;
      }

      if (objectWord === 'FUNCTION' || objectWord === 'PROCEDURE') {
        if (!name) continue;
        const ordinal = addDef('function', name, -1, start, end, { signature, doc, meta });
        rememberDef(name, ordinal);
        const returns = /\bRETURNS\s+((?:SETOF\s+|TABLE\s*)?[A-Za-z_][\w.]*(?:\s*\([^)]*\))?)/i.exec(stmt);
        if (returns) definitions[ordinal]!.declaredType = oneLine(returns[1]!.trim(), 80);
        scanBody(start + headEnd, end, ordinal, name);
        continue;
      }

      if (objectWord === 'TRIGGER') {
        if (!name) continue;
        const onMatch = new RegExp(String.raw`\bON\s+(${QNAME})`, 'i').exec(stmt);
        const target = onMatch ? splitQName(onMatch[1]!) : null;
        const trigMeta: NonNullable<Definition['meta']> = { ...meta };
        if (target?.name) trigMeta.table = target.name;
        const timing = /\b(BEFORE|AFTER|INSTEAD\s+OF)\s+([A-Z ,]*?)\s+ON\b/i.exec(stmt);
        if (timing) trigMeta.event = oneLine(`${timing[1]} ${timing[2]}`, 60);
        const ordinal = addDef('function', name, -1, start, end, { signature, doc, meta: trigMeta });
        rememberDef(name, ordinal);
        if (target?.name) addRef('value', target.name, target.qualifier, start + (onMatch?.index ?? 0), ordinal);
        const exec = new RegExp(String.raw`\bEXECUTE\s+(?:PROCEDURE|FUNCTION)\s+(${QNAME})`, 'i').exec(stmt);
        if (exec) {
          const fn = splitQName(exec[1]!);
          addRef('call', fn.name, fn.qualifier, start + exec.index, ordinal);
        }
        continue;
      }

      if (objectWord === 'TYPE') {
        if (!name) continue;
        const open = mtext.indexOf('(', start + headEnd - 1);
        const close = open >= 0 && open < end ? matchParen(mtext, open) : -1;
        const isEnum = /\bAS\s+ENUM\b/i.test(stmt);
        if (isEnum && open >= 0 && close > open) {
          const ordinal = addDef('enum', name, -1, start, end, { signature, doc, meta });
          rememberDef(name, ordinal);
          // Values were masked out; read them back from the original text.
          const raw = content.slice(open + 1, close);
          const valRe = /'((?:[^']|'')*)'/g;
          let v: RegExpExecArray | null;
          while ((v = valRe.exec(raw))) {
            const label = v[1]!.replace(/''/g, "'");
            addDef('enum_member', label, ordinal, open + 1 + v.index, open + 1 + v.index + v[0].length, { signature: label });
          }
          continue;
        }
        if (open >= 0 && close > open) {
          const ordinal = addDef('struct', name, -1, start, end, { signature, doc, meta });
          rememberDef(name, ordinal);
          for (const [a, b] of splitTopLevel(mtext, open + 1, close)) {
            const cm = new RegExp(String.raw`^\s*(${IDENT})\s+([\s\S]+)$`).exec(mtext.slice(a, b));
            if (!cm) continue;
            addDef('field', unquoteIdent(cm[1]!), ordinal, a, b, {
              signature: oneLine(mtext.slice(a, b).trim(), 120),
              declaredType: typeOfColumn(cm[2]!),
            });
          }
          continue;
        }
        const ordinal = addDef('type_alias', name, -1, start, end, { signature, doc, meta });
        rememberDef(name, ordinal);
        continue;
      }

      if (name) {
        const kind = OBJECT_KIND[objectWord] ?? 'variable';
        rememberDef(name, addDef(kind, name, -1, start, end, { signature, doc, meta }));
      }
      continue;
    }

    const alter = ALTER_RE.exec(stmt);
    if (alter) {
      const target = splitQName(alter[1]!);
      const scope = byName.get(target.name.toLowerCase()) ?? -1;
      REFERENCES_RE.lastIndex = 0;
      let r: RegExpExecArray | null;
      while ((r = REFERENCES_RE.exec(stmt))) {
        const to = splitQName(r[1]!);
        if (to.name.toLowerCase() !== target.name.toLowerCase()) addRef('value', to.name, to.qualifier, start + r.index, scope);
      }
      if (scope < 0) addRef('value', target.name, target.qualifier, start + alter.index, -1);
      // `ALTER TABLE t ADD COLUMN x type` extends a table defined in this file.
      const add = new RegExp(String.raw`\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s+([\s\S]+)$`, 'i').exec(stmt);
      if (scope >= 0 && add && !TABLE_CONSTRAINT_START.has(unquoteIdent(add[1]!).toUpperCase())) {
        addDef('field', unquoteIdent(add[1]!), scope, start + add.index, end, {
          signature: oneLine(stmt.trim(), 120),
          declaredType: typeOfColumn(add[2]!),
        });
      }
      continue;
    }

    const comment = COMMENT_RE.exec(stmt);
    if (comment) {
      const raw = content.slice(start + comment.index + comment[0].length, end);
      const lit = /'((?:[^']|'')*)'/.exec(raw);
      if (lit) {
        const text = lit[1]!.replace(/''/g, "'");
        const target = splitQName(comment[2]!);
        if (comment[1]!.toUpperCase() === 'COLUMN') {
          const parts = comment[2]!.split('.').map(unquoteIdent);
          const col = parts[parts.length - 1]!;
          const tbl = parts[parts.length - 2] ?? '';
          const owner = byName.get(tbl.toLowerCase());
          const field = definitions.find((d) => d.kind === 'field' && d.name === col && d.parent === owner);
          if (field) field.doc = text;
        } else {
          const d = definitions[byName.get(target.name.toLowerCase()) ?? -1];
          if (d) d.doc = text;
        }
      }
      continue;
    }

    // DML in migration scripts still tells us which tables the file touches.
    if (/^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|SELECT|WITH|DROP|GRANT|REVOKE)\b/i.test(stmt)) {
      const drop = new RegExp(String.raw`^\s*DROP\s+(?:TABLE|VIEW|INDEX|TYPE|FUNCTION|PROCEDURE|TRIGGER|SEQUENCE)\s+(?:IF\s+EXISTS\s+)?(${QNAME})`, 'i').exec(stmt);
      if (drop) {
        const t = splitQName(drop[1]!);
        addRef('value', t.name, t.qualifier, start + drop.index, -1);
        continue;
      }
      const truncate = new RegExp(String.raw`^\s*TRUNCATE\s+(?:TABLE\s+)?(${QNAME})`, 'i').exec(stmt);
      if (truncate) {
        const t = splitQName(truncate[1]!);
        addRef('value', t.name, t.qualifier, start + truncate.index, -1);
        continue;
      }
      scanBody(start, end, -1, '');
    }
  }

  // Module doc: the comment block at the top of the file.
  const docLines: string[] = [];
  for (let l = 0; l < masked.commentLine.length; l++) {
    const from = lineStarts[l]!;
    const to = l + 1 < lineStarts.length ? lineStarts[l + 1]! - 1 : content.length;
    const raw = content.slice(from, to);
    if (masked.commentLine[l]) docLines.push(raw);
    else if (raw.trim()) break;
    else if (docLines.length) break;
  }

  return {
    path,
    language: 'sql',
    hash: contentHash(content),
    size: Buffer.byteLength(content, 'utf8'),
    definitions,
    references,
    imports: [] as Import[],
    localTypes: [],
    diagnostics: [],
    doc: docLines.length ? oneLine(cleanComment(docLines.join('\n')), 300) : '',
    errorPct: 0,
  };
}

/** Registry entry: no grammar; extraction is handled by extractSql. */
export const sql: LanguageSupport = {
  id: 'sql',
  grammar: '',
  extensions: ['.sql', '.ddl', '.pgsql'],
  classLike: new Set(),
  definition: () => null,
  imports: () => null,
  references: () => undefined,
  doc: () => '',
  isTestFile: () => false,
  resolveModule: () => [],
};
