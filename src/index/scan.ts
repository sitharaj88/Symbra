import { readdirSync, readFileSync, realpathSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { languageForPath } from '../languages/registry.js';

export const DEFAULT_IGNORES = [
  '.git/',
  '.hg/',
  '.svn/',
  'node_modules/',
  'bower_components/',
  'vendor/',
  'dist/',
  'build/',
  'out/',
  'target/',
  '.next/',
  '.nuxt/',
  '.output/',
  '.turbo/',
  '.cache/',
  'coverage/',
  '__pycache__/',
  '.venv/',
  'venv/',
  'env/',
  '.tox/',
  '.mypy_cache/',
  '.pytest_cache/',
  '.ruff_cache/',
  '.idea/',
  '.vscode/',
  '.symbra/',
  'graphify-out/',
  'site/assets/',
  'public/assets/',
  'static/js/',
  'storybook-static/',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.bundle.js',
  '*.bundle.css',
  'vendor.js',
  '*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '*.generated.*',
  '*.pb.go',
  '*_pb2.py',
  '*.d.ts',
];

export interface ScannedFile {
  path: string; // repo-relative posix
  abs: string;
  size: number;
  mtime: number;
  language: string;
}

export interface ScanOptions {
  root: string;
  maxFileBytes?: number;
  extraIgnores?: string[];
  includeDocs?: boolean;
  log?: (msg: string) => void;
  /** Called once per file skipped by the generated-filename heuristic (see `isGeneratedFilename`). */
  onGeneratedSkip?: (path: string) => void;
}

// --- Generated / built-bundle filename detection -------------------------------------------
//
// Bundlers stamp output with a content hash (`index-DrLLgu_7.js`, `main.a1b2c3d4.js`) or a
// well-known chunk name (`chunk-XYZ.js`, `vendor.js`). Those files are huge, minified, and their
// one-letter locals become spurious PageRank hubs, so they're skipped before extraction even
// though nothing in DEFAULT_IGNORES (a plain gitignore matcher) can express "hash-looking
// suffix". A `.symbraignore` negation (`!path/to/file.js`) always forces a match back in.
const GENERATED_EXT_RE = /\.(m?js|cjs|css)$/i;
const HASH_SUFFIX_RE = /[.-]([A-Za-z0-9_-]{6,})\.(m?js|cjs|css)$/i;
const KNOWN_GENERATED_PREFIX_RE = /^(chunk|vendors?|runtime|polyfills?)[-.]/i;

/** True when a suffix looks like a content hash rather than an English word (`utils`, `config`). */
function looksLikeHash(s: string): boolean {
  if (/^[a-z]+$/i.test(s)) return false; // a single-case run of letters reads as a real word
  return true; // has a digit, an underscore, or mixed case: hash-shaped
}

/** True for a built/minified bundle name: hashed output, known chunk names, `.min.`/`.bundle.` files. */
export function isGeneratedFilename(name: string): boolean {
  if (!GENERATED_EXT_RE.test(name)) return false;
  if (/\.min\.\w+$/i.test(name)) return true;
  if (/\.bundle\.\w+$/i.test(name)) return true;
  if (KNOWN_GENERATED_PREFIX_RE.test(name)) return true;
  const m = name.match(HASH_SUFFIX_RE);
  return !!m && looksLikeHash(m[1]!);
}

/** Lines starting with `!` (a gitignore negation), unwrapped, from one ignore-file's contents. */
function negationsOf(source: string): string[] {
  return source.split(/\r?\n/).filter((l) => l.startsWith('!') && !l.startsWith('!!')).map((l) => l.slice(1));
}

/** Matcher built from just the negation (`!...`) lines, so `.symbraignore` can force-include a
 *  file the name/content heuristics would otherwise drop — those heuristics aren't gitignore
 *  patterns, so the normal `ig.ignores()` negation machinery never sees them. */
function buildForceInclude(root: string, extraIgnores?: string[]): Ignore {
  const lines: string[] = [];
  if (extraIgnores?.length) lines.push(...negationsOf(extraIgnores.join('\n')));
  for (const f of ['.gitignore', '.symbraignore', '.graphifyignore']) {
    const p = join(root, f);
    if (existsSync(p)) {
      try {
        lines.push(...negationsOf(readFileSync(p, 'utf8')));
      } catch {
        /* unreadable: no force-includes from this file */
      }
    }
  }
  return ignore().add(lines);
}

const DOC_EXT = new Set(['.md', '.mdx', '.markdown']);

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/**
 * The repo-wide ignore matcher: built-in ignores plus the root `.gitignore`, `.symbraignore`,
 * `.graphifyignore` and `.git/info/exclude`. Exported so the
 * watcher filters events with exactly the same rules the scanner used.
 */
export function buildRootIgnore(root: string, extraIgnores?: string[]): Ignore {
  const ig = ignore().add(DEFAULT_IGNORES);
  if (extraIgnores?.length) ig.add(extraIgnores);
  for (const f of ['.gitignore', '.symbraignore', '.graphifyignore']) {
    const p = join(root, f);
    if (existsSync(p)) {
      try {
        ig.add(readFileSync(p, 'utf8'));
      } catch {
        /* unreadable ignore file: fall back to the built-ins */
      }
    }
  }
  const gitInfoExclude = join(root, '.git', 'info', 'exclude');
  if (existsSync(gitInfoExclude)) {
    try {
      ig.add(readFileSync(gitInfoExclude, 'utf8'));
    } catch {
      /* ignore */
    }
  }
  return ig;
}

/** A `.gitignore` and the directory its patterns are relative to. */
interface ScopedIgnore {
  ig: Ignore;
  /** Repo-relative posix directory, '' for the root. */
  base: string;
}

/** Walk the tree honoring .gitignore at every level plus built-in ignores. */
export function scanRepo(opts: ScanOptions): ScannedFile[] {
  const root = opts.root;
  const maxBytes = opts.maxFileBytes ?? 1_500_000;
  const out: ScannedFile[] = [];
  const rootIg = buildRootIgnore(root, opts.extraIgnores);
  const forceInclude = buildForceInclude(root, opts.extraIgnores);
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    rootReal = root;
  }
  let skippedLinks = 0;

  /** True when any ancestor `.gitignore` matches the path, each tested against its own base. */
  function ignoredByAncestors(igs: ScopedIgnore[], relPath: string, isDir: boolean): boolean {
    for (const { ig, base } of igs) {
      const rel = base ? (relPath.startsWith(base + '/') ? relPath.slice(base.length + 1) : null) : relPath;
      if (!rel) continue;
      if (ig.ignores(isDir ? rel + '/' : rel)) return true;
    }
    return false;
  }

  /** Resolve a symlink: the target must be a regular file inside the repository. */
  function followLink(abs: string): { size: number; mtime: number } | null {
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return null; // broken link
    }
    if (real !== rootReal && !real.startsWith(rootReal + sep)) return null; // escapes the repo
    try {
      const st = statSync(real);
      if (!st.isFile()) return null; // directory links would let the walk cycle
      return { size: st.size, mtime: st.mtimeMs };
    } catch {
      return null;
    }
  }

  function walk(dir: string, rel: string, igs: ScopedIgnore[]) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // nested .gitignore: remember the directory it came from so its patterns are matched relatively
    let localIgs = igs;
    const nested = join(dir, '.gitignore');
    if (rel && existsSync(nested)) {
      try {
        localIgs = [...igs, { ig: ignore().add(readFileSync(nested, 'utf8')), base: rel }];
      } catch {
        /* unreadable: keep the inherited set */
      }
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const name = e.name;
      const relPath = rel ? `${rel}/${name}` : name;
      const abs = join(dir, name);
      const link = e.isSymbolicLink();
      let linked: { size: number; mtime: number } | null = null;
      if (link) {
        linked = followLink(abs);
        if (!linked) {
          skippedLinks++;
          continue;
        }
      }
      const isDir = link ? false : e.isDirectory();
      const probe = isDir ? relPath + '/' : relPath;
      if (rootIg.ignores(probe)) continue;
      if (ignoredByAncestors(localIgs, relPath, isDir)) continue;
      if (isDir) {
        walk(abs, relPath, localIgs);
        continue;
      }
      if (!link && !e.isFile()) continue;
      const lang = languageForPath(relPath);
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
      const isDoc = opts.includeDocs !== false && DOC_EXT.has(ext);
      if (!lang && !isDoc) continue;
      if (isGeneratedFilename(name) && !forceInclude.ignores(relPath)) {
        opts.onGeneratedSkip?.(relPath);
        continue;
      }
      let size: number;
      let mtime: number;
      if (linked) {
        size = linked.size;
        mtime = linked.mtime;
      } else {
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        size = st.size;
        mtime = st.mtimeMs;
      }
      if (size > maxBytes || size === 0) continue;
      out.push({ path: toPosix(relPath), abs, size, mtime, language: lang ? lang.id : 'markdown' });
    }
  }
  walk(root, '', [{ ig: rootIg, base: '' }]);
  if (skippedLinks && opts.log) opts.log(`skipped ${skippedLinks} symlink${skippedLinks === 1 ? '' : 's'} (broken, or pointing outside the repository, or to a directory)`);
  return out;
}

export function relPosix(root: string, abs: string): string {
  return toPosix(relative(root, abs));
}
