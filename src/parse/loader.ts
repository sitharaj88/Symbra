import { Parser, Language, Query } from 'web-tree-sitter';
import { existsSync, mkdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { manifestByName, type GrammarInfo } from './grammar-manifest.js';
import { envFlag } from '../util/env.js';

const here = dirname(fileURLToPath(import.meta.url));
// dist/parse/loader.js -> ../../grammars ; src/parse/loader.ts -> ../../grammars
const PACKAGE_GRAMMAR_DIR = join(here, '..', '..', 'grammars');
// Sibling directory `npm run grammars` vendors every long-tail grammar into for local
// development (package.json `files` never lists it, so it never reaches `npm pack`). Checking it
// before the network means a dev checkout with everything vendored, and the test suite, never
// need a network round-trip merely because a fixture exercises a long-tail language.
const DEV_OPTIONAL_GRAMMAR_DIR = join(here, '..', '..', 'grammars-optional');
const ENV_GRAMMAR_DIR = envFlag('GRAMMARS');
const CACHE_ROOT = envFlag('CACHE_HOME') ?? join(homedir(), '.cache', 'symbra');
export const CACHE_GRAMMAR_DIR = join(CACHE_ROOT, 'grammars');

let initPromise: Promise<void> | null = null;
const languages = new Map<string, Promise<Language>>();
const queries = new Map<string, Query>();
const inflightDownloads = new Map<string, Promise<string>>();

function fileName(grammar: string): string {
  return `tree-sitter-${grammar}.wasm`;
}

/** Cache path for a grammar, versioned so a manifest bump never loads a stale cached file. */
export function cachePathFor(grammar: string, info?: GrammarInfo): string {
  const g = info ?? manifestByName.get(grammar);
  const suffix = g ? `tree-sitter-${grammar}-${g.version}.wasm` : fileName(grammar);
  return join(CACHE_GRAMMAR_DIR, suffix);
}

/**
 * Best-effort local lookup, in order: the package's own `grammars/` dir, the dev-only
 * `grammars-optional/` sibling (present in a source checkout, absent from the published
 * package), `$SYMBRA_GRAMMARS`, then the user cache. Never downloads. When nothing exists yet,
 * returns the package path as the canonical "expected" location (existing callers relied on a
 * plain string, not an Option).
 */
export function grammarPath(grammar: string): string {
  const inPkg = join(PACKAGE_GRAMMAR_DIR, fileName(grammar));
  if (existsSync(inPkg)) return inPkg;
  const inDevOptional = join(DEV_OPTIONAL_GRAMMAR_DIR, fileName(grammar));
  if (existsSync(inDevOptional)) return inDevOptional;
  if (ENV_GRAMMAR_DIR) {
    const inEnv = join(ENV_GRAMMAR_DIR, fileName(grammar));
    if (existsSync(inEnv)) return inEnv;
  }
  const cached = cachePathFor(grammar);
  if (existsSync(cached)) return cached;
  return inPkg;
}

export function hasGrammar(grammar: string): boolean {
  return existsSync(grammarPath(grammar));
}

export type GrammarStatus = 'shipped' | 'cached' | 'missing';

/** Where a grammar currently lives, for `symbra grammars --list`. Never downloads. */
export function grammarStatus(grammar: string): GrammarStatus {
  const inPkg = join(PACKAGE_GRAMMAR_DIR, fileName(grammar));
  if (existsSync(inPkg)) return 'shipped';
  if (existsSync(join(DEV_OPTIONAL_GRAMMAR_DIR, fileName(grammar)))) return 'shipped';
  if (ENV_GRAMMAR_DIR && existsSync(join(ENV_GRAMMAR_DIR, fileName(grammar)))) return 'shipped';
  return existsSync(cachePathFor(grammar)) ? 'cached' : 'missing';
}

// --- On-demand download of long-tail grammars --------------------------------------------------
//
// No new dependencies: Node's built-in fetch + zlib.gunzipSync + a minimal tar reader are enough
// to pull the single .wasm file we need out of the grammar's npm tarball.

function offlineError(grammar: string): Error {
  return new Error(
    `GRAMMAR_UNAVAILABLE|${grammar}|grammar "${grammar}" is not installed and SYMBRA_OFFLINE=1 blocks fetching it ` +
      `(needs ${fileName(grammar)}). Prefetch it first: symbra grammars ${grammar}  (or: symbra grammars --all)`,
  );
}

function unknownGrammarError(grammar: string): Error {
  return new Error(`GRAMMAR_UNAVAILABLE|${grammar}|no such grammar "${grammar}" (see: symbra grammars --list)`);
}

function fetchError(grammar: string, info: GrammarInfo, detail: string): Error {
  return new Error(
    `GRAMMAR_UNAVAILABLE|${grammar}|could not fetch ${fileName(grammar)} from ${info.pkg}@${info.version}: ${detail}. ` +
      `Run: symbra grammars ${grammar}  (or: symbra grammars --all)`,
  );
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${url})`);
  return res.json();
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${url})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Verifies an npm `dist.integrity` value (e.g. "sha512-<base64>") against a downloaded buffer. */
export function verifyIntegrity(buf: Buffer, integrity: string): boolean {
  const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity);
  if (!m) return false;
  const digest = createHash('sha512').update(buf).digest('base64');
  return digest === m[1];
}

/**
 * Minimal reader for uncompressed POSIX/ustar tar streams (what `npm pack` produces after
 * gunzip). Walks 512-byte header blocks and returns the first entry whose name ends with
 * `suffix`, without extracting anything else.
 */
export function readTarEntry(tar: Buffer, suffix: string): Buffer | null {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive: two zero blocks
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim();
    const size = sizeField ? parseInt(sizeField, 8) || 0 : 0;
    const dataStart = offset + 512;
    if (name.endsWith(suffix)) return tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

interface RegistryVersionMeta {
  dist?: { integrity?: string; tarball?: string; shasum?: string };
}

async function downloadGrammar(grammar: string, info: GrammarInfo): Promise<string> {
  if (envFlag('OFFLINE') === '1') throw offlineError(grammar);
  let meta: RegistryVersionMeta;
  try {
    meta = (await fetchJson(`https://registry.npmjs.org/${info.pkg}/${info.version}`)) as RegistryVersionMeta;
  } catch (err) {
    throw fetchError(grammar, info, `registry lookup failed (${(err as Error).message})`);
  }
  const integrity = meta.dist?.integrity;
  if (!integrity) throw fetchError(grammar, info, 'registry metadata has no dist.integrity to verify against');
  const pkgBaseName = info.pkg.split('/').pop()!;
  const tarballUrl = meta.dist?.tarball ?? `https://registry.npmjs.org/${info.pkg}/-/${pkgBaseName}-${info.version}.tgz`;
  let tgz: Buffer;
  try {
    tgz = await fetchBuffer(tarballUrl);
  } catch (err) {
    throw fetchError(grammar, info, `tarball download failed (${(err as Error).message})`);
  }
  if (!verifyIntegrity(tgz, integrity)) throw fetchError(grammar, info, 'downloaded tarball failed integrity verification');
  let tar: Buffer;
  try {
    tar = gunzipSync(tgz);
  } catch (err) {
    throw fetchError(grammar, info, `gunzip failed (${(err as Error).message})`);
  }
  const wasm = readTarEntry(tar, info.wasmFile);
  if (!wasm || wasm.length === 0) throw fetchError(grammar, info, `${info.wasmFile} not found inside the tarball`);
  const dest = cachePathFor(grammar, info);
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, wasm);
  try {
    renameSync(tmp, dest); // atomic on the same filesystem
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
  return dest;
}

/**
 * Resolves a grammar to a local .wasm path, downloading it into the user cache on first use if
 * it is a known long-tail grammar not already shipped/cached. Safe to call concurrently for the
 * same grammar; the download happens once.
 */
export async function ensureGrammar(grammar: string): Promise<string> {
  const existing = grammarPath(grammar);
  if (existsSync(existing)) return existing;
  const info = manifestByName.get(grammar);
  if (!info) throw unknownGrammarError(grammar);
  let p = inflightDownloads.get(grammar);
  if (!p) {
    p = downloadGrammar(grammar, info);
    // Clear the in-flight entry on either outcome via a two-armed `then`, not `.finally`: a
    // `.finally` callback produces a derived promise that re-rejects and, left unawaited, would
    // surface as an unhandled rejection even though the caller of ensureGrammar handles `p` itself.
    p.then(
      () => inflightDownloads.delete(grammar),
      () => inflightDownloads.delete(grammar),
    );
    inflightDownloads.set(grammar, p);
  }
  return p;
}

export async function initParser(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  return initPromise;
}

export async function loadLanguage(grammar: string): Promise<Language> {
  await initParser();
  let p = languages.get(grammar);
  if (!p) {
    p = ensureGrammar(grammar).then((path) => Language.load(path));
    p.catch(() => languages.delete(grammar)); // let a failed load be retried later
    languages.set(grammar, p);
  }
  return p;
}

export async function newParser(grammar: string): Promise<Parser> {
  const lang = await loadLanguage(grammar);
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}

/** Compile and cache a query for a grammar. Throws a descriptive error on bad patterns. */
export async function getQuery(grammar: string, key: string, source: string): Promise<Query> {
  const cacheKey = `${grammar}::${key}`;
  const cached = queries.get(cacheKey);
  if (cached) return cached;
  const lang = await loadLanguage(grammar);
  let q: Query;
  try {
    q = new Query(lang, source);
  } catch (err) {
    throw new Error(`Query "${key}" failed to compile for grammar "${grammar}": ${(err as Error).message}`);
  }
  queries.set(cacheKey, q);
  return q;
}
