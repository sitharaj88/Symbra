import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { grammarManifest, coreGrammars, optionalGrammars, manifestByName } from '../../src/parse/grammar-manifest.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// --- manifest integrity: every grammar file the manifest names exists locally -------------------

describe('grammar manifest', () => {
  it('lists every core and long-tail grammar exactly once, with no name collisions', () => {
    expect(coreGrammars.length + optionalGrammars.length).toBe(grammarManifest.length);
    const names = grammarManifest.map((g) => g.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('has a local wasm file for every core grammar under ./grammars', () => {
    for (const g of coreGrammars) {
      const p = join(REPO_ROOT, 'grammars', `tree-sitter-${g.name}.wasm`);
      expect(existsSync(p), `missing ${p} for core grammar "${g.name}"`).toBe(true);
    }
  });

  it('has a local wasm file for every long-tail grammar under ./grammars-optional', () => {
    for (const g of optionalGrammars) {
      const p = join(REPO_ROOT, 'grammars-optional', `tree-sitter-${g.name}.wasm`);
      expect(existsSync(p), `missing ${p} for long-tail grammar "${g.name}"`).toBe(true);
    }
  });

  it('every entry names a package, version and wasm file', () => {
    for (const g of grammarManifest) {
      expect(g.pkg).toBeTruthy();
      expect(g.version).toBeTruthy();
      expect(g.wasmFile).toBeTruthy();
      expect(typeof g.core).toBe('boolean');
    }
  });

  it('manifestByName agrees with the array', () => {
    for (const g of grammarManifest) expect(manifestByName.get(g.name)).toEqual(g);
  });
});

// --- minimal tar reader --------------------------------------------------------------------------

/** Builds one 512-byte ustar header for `name` holding `size` bytes, ready to prepend to content. */
function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000644\0', 100, 'ascii'); // mode
  header.write('0000000\0', 108, 'ascii'); // uid
  header.write('0000000\0', 116, 'ascii'); // gid
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii'); // size
  header.write('00000000000\0', 136, 'ascii'); // mtime
  header.write('        ', 148, 'ascii'); // chksum placeholder (spaces) while computing
  header.write('0', 156, 'ascii'); // typeflag: regular file
  header.write('ustar\0', 257, 'ascii'); // magic
  header.write('00', 263, 'ascii'); // version
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return header;
}

/** Builds a minimal one-entry uncompressed tar archive, padded per the ustar spec. */
function buildTar(name: string, content: Buffer): Buffer {
  const header = tarHeader(name, content.length);
  const pad = Buffer.alloc((512 - (content.length % 512)) % 512);
  const end = Buffer.alloc(1024); // two zero blocks mark end-of-archive
  return Buffer.concat([header, content, pad, end]);
}

describe('readTarEntry', () => {
  it('extracts a named entry from a hand-built tar', async () => {
    const { readTarEntry } = await import('../../src/parse/loader.js');
    const content = Buffer.from('pretend-wasm-bytes-for-testing');
    const tar = buildTar('package/tree-sitter-test.wasm', content);
    const found = readTarEntry(tar, 'tree-sitter-test.wasm');
    expect(found?.toString()).toBe(content.toString());
  });

  it('matches a nested path by suffix, for bundle packages (out/tree-sitter-x.wasm)', async () => {
    const { readTarEntry } = await import('../../src/parse/loader.js');
    const content = Buffer.from('kotlin-wasm-bytes');
    const tar = buildTar('package/out/tree-sitter-kotlin.wasm', content);
    const found = readTarEntry(tar, 'out/tree-sitter-kotlin.wasm');
    expect(found?.toString()).toBe(content.toString());
  });

  it('returns null when no entry matches', async () => {
    const { readTarEntry } = await import('../../src/parse/loader.js');
    const tar = buildTar('package/tree-sitter-other.wasm', Buffer.from('x'));
    expect(readTarEntry(tar, 'tree-sitter-test.wasm')).toBeNull();
  });

  it('round-trips through gzip like a real npm tarball', async () => {
    const { readTarEntry } = await import('../../src/parse/loader.js');
    const content = Buffer.from('gzipped-round-trip');
    const tar = buildTar('package/tree-sitter-test.wasm', content);
    const gz = gzipSync(tar);
    const back = gunzipSync(gz);
    expect(readTarEntry(back, 'tree-sitter-test.wasm')?.toString()).toBe(content.toString());
  });
});

describe('verifyIntegrity', () => {
  it('accepts a matching sha512 dist.integrity value', async () => {
    const { verifyIntegrity } = await import('../../src/parse/loader.js');
    const buf = Buffer.from('some tarball bytes');
    const digest = createHash('sha512').update(buf).digest('base64');
    expect(verifyIntegrity(buf, `sha512-${digest}`)).toBe(true);
  });

  it('rejects a mismatched digest', async () => {
    const { verifyIntegrity } = await import('../../src/parse/loader.js');
    const buf = Buffer.from('some tarball bytes');
    expect(verifyIntegrity(buf, 'sha512-not-the-right-digest==')).toBe(false);
  });

  it('rejects a non-sha512 integrity string', async () => {
    const { verifyIntegrity } = await import('../../src/parse/loader.js');
    expect(verifyIntegrity(Buffer.from('x'), 'sha1-abcdef')).toBe(false);
  });
});

// --- cache path resolution -------------------------------------------------------------------
//
// loader.ts reads SYMBRA_CACHE_HOME / SYMBRA_GRAMMARS once at module load, so this suite
// sets them before dynamically importing a fresh copy of the module (vitest gives each dynamic
// import a distinct module instance when the resolved specifier differs, so a cache-busting
// query string forces re-evaluation with the env in place).

describe('cache path resolution', () => {
  let cacheHome: string;

  beforeAll(() => {
    cacheHome = mkdtempSync(join(tmpdir(), 'symbra-grammar-cache-'));
  });

  afterAll(() => {
    rmSync(cacheHome, { recursive: true, force: true });
  });

  it('builds a version-suffixed cache path for a known grammar, no network', async () => {
    process.env.SYMBRA_CACHE_HOME = cacheHome;
    const mod = (await import(`../../src/parse/loader.js?cache1`)) as typeof import('../../src/parse/loader.js');
    const info = manifestByName.get('dart')!;
    const p = mod.cachePathFor('dart', info);
    expect(p).toBe(join(cacheHome, 'grammars', `tree-sitter-dart-${info.version}.wasm`));
    delete process.env.SYMBRA_CACHE_HOME;
  });

  it('falls back to a plain name when the grammar is not in the manifest', async () => {
    process.env.SYMBRA_CACHE_HOME = cacheHome;
    const mod = (await import(`../../src/parse/loader.js?cache2`)) as typeof import('../../src/parse/loader.js');
    const p = mod.cachePathFor('totally-unknown-language');
    expect(p).toBe(join(cacheHome, 'grammars', 'tree-sitter-totally-unknown-language.wasm'));
    delete process.env.SYMBRA_CACHE_HOME;
  });

  it('grammarPath prefers the package dir, then dev-optional, then $SYMBRA_GRAMMARS, then the cache', async () => {
    process.env.SYMBRA_CACHE_HOME = cacheHome;
    const mod = (await import(`../../src/parse/loader.js?cache3`)) as typeof import('../../src/parse/loader.js');
    // python is a shipped core grammar: resolves to the package dir regardless of env/cache.
    expect(mod.grammarPath('python')).toBe(join(REPO_ROOT, 'grammars', 'tree-sitter-python.wasm'));
    // dart is long-tail: not in ./grammars, resolved from the dev-only grammars-optional/ sibling.
    expect(mod.grammarPath('dart')).toBe(join(REPO_ROOT, 'grammars-optional', 'tree-sitter-dart.wasm'));
    delete process.env.SYMBRA_CACHE_HOME;
  });

  it('grammarStatus reports shipped for a core grammar, and shipped for a long-tail one vendored locally for development', async () => {
    process.env.SYMBRA_CACHE_HOME = cacheHome;
    const mod = (await import(`../../src/parse/loader.js?cache4`)) as typeof import('../../src/parse/loader.js');
    expect(mod.grammarStatus('python')).toBe('shipped');
    // dart is long-tail (not in package.json `files`) but `npm run grammars` vendors it into the
    // dev-only grammars-optional/ sibling, which the loader also checks before hitting the
    // network — so a source checkout and the test suite never need network for it.
    expect(mod.grammarStatus('dart')).toBe('shipped');
    // A grammar with no local file anywhere (package, dev-optional, env, or cache) is missing.
    expect(mod.grammarStatus('not-a-real-language')).toBe('missing');
    delete process.env.SYMBRA_CACHE_HOME;
  });

  it('ensureGrammar rejects with a GRAMMAR_UNAVAILABLE marker when offline and no local copy exists', async () => {
    process.env.SYMBRA_CACHE_HOME = cacheHome;
    process.env.SYMBRA_OFFLINE = '1';
    const mod = (await import(`../../src/parse/loader.js?cache5`)) as typeof import('../../src/parse/loader.js');
    // julia ships in grammars-optional/ for local development; temporarily rename it away so
    // this exercises the "actually needs to fetch" path without ever touching the network, and
    // without racing any other test file (nothing else references the julia grammar).
    const vendored = join(REPO_ROOT, 'grammars-optional', 'tree-sitter-julia.wasm');
    const hidden = `${vendored}.hidden-for-test`;
    renameSync(vendored, hidden);
    try {
      await expect(mod.ensureGrammar('julia')).rejects.toThrow(/^GRAMMAR_UNAVAILABLE\|julia\|/);
    } finally {
      renameSync(hidden, vendored);
    }
    delete process.env.SYMBRA_CACHE_HOME;
    delete process.env.SYMBRA_OFFLINE;
  });

  it('ensureGrammar rejects with a GRAMMAR_UNAVAILABLE marker for an unknown grammar, no network', async () => {
    process.env.SYMBRA_CACHE_HOME = cacheHome;
    const mod = (await import(`../../src/parse/loader.js?cache6`)) as typeof import('../../src/parse/loader.js');
    await expect(mod.ensureGrammar('not-a-real-language')).rejects.toThrow(/^GRAMMAR_UNAVAILABLE\|not-a-real-language\|/);
    delete process.env.SYMBRA_CACHE_HOME;
  });
});
