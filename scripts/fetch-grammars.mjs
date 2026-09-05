#!/usr/bin/env node
// Vendors prebuilt tree-sitter WASM grammars, reading grammars/manifest.json as the single
// source of truth (also read at runtime by src/parse/grammar-manifest.ts).
// Source 1: the official grammar npm packages (ship a .wasm since 0.23+).
// Source 2: the tree-sitter-wasms bundle for grammars whose npm package has no .wasm.
// Every grammar is MIT-licensed; see grammars/LICENSES.md.
//
// Core grammars (manifest `core: true`) are vendored into ./grammars and shipped in the npm
// package (package.json `files`). Long-tail grammars go into ./grammars-optional, a sibling
// directory `files` does not list, so it never reaches `npm pack`; they're fetched on demand at
// runtime into the user's cache instead (see src/parse/loader.ts). Both directories are
// populated for local development so every grammar is available without a network round-trip
// while hacking on Symbra.
import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, copyFileSync, writeFileSync, existsSync, rmSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, '..', 'grammars', 'manifest.json'), 'utf8')).grammars;

const CORE_OUT = resolve('grammars');
const OPTIONAL_OUT = resolve('grammars-optional');
mkdirSync(CORE_OUT, { recursive: true });
mkdirSync(OPTIONAL_OUT, { recursive: true });
const work = join(tmpdir(), 'symbra-grammars-' + process.pid);
mkdirSync(work, { recursive: true });

/** Extracts one npm package tarball once per (pkg, version) pair, memoized on disk under `work`. */
function packageDir(pkg, version) {
  const dir = join(work, `${pkg.replace('@', '').replace('/', '-')}-${version}`);
  if (existsSync(dir)) return dir;
  execSync(`npm pack ${pkg}@${version} --pack-destination "${work}" --silent`, { stdio: 'pipe' });
  const pkgBase = pkg.replace('@', '').replace('/', '-');
  const tgz = readdirSync(work).find((f) => f.startsWith(pkgBase) && f.endsWith(`-${version}.tgz`));
  mkdirSync(dir, { recursive: true });
  execSync(`tar xzf "${join(work, tgz)}" -C "${dir}"`);
  return dir;
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const wanted = only.length ? new Set(only) : null;

const licenses = ['# Grammar licenses', '', 'All vendored grammars are MIT licensed by their respective authors.', ''];
for (const g of manifest) {
  if (wanted && !wanted.has(g.name)) continue;
  const out = g.core ? CORE_OUT : OPTIONAL_OUT;
  const dest = join(out, `tree-sitter-${g.name}.wasm`);
  const label = g.core ? '' : ' (optional)';
  if (existsSync(dest) && statSync(dest).size > 1000) {
    console.log('have', g.name + label);
    licenses.push(`- ${g.name}: ${g.pkg}@${g.version}${g.core ? '' : ' (optional, not shipped)'}`);
    continue;
  }
  const dir = packageDir(g.pkg, g.version);
  copyFileSync(join(dir, 'package', g.wasmFile), dest);
  console.log('vendored', g.name + label, 'from', `${g.pkg}@${g.version}`);
  licenses.push(`- ${g.name}: ${g.pkg}@${g.version}${g.core ? '' : ' (optional, not shipped)'}`);
}
if (!wanted) writeFileSync(join(CORE_OUT, 'LICENSES.md'), licenses.join('\n') + '\n');
rmSync(work, { recursive: true, force: true });
console.log('done ->', CORE_OUT, '+', OPTIONAL_OUT);
