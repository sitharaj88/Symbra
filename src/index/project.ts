import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ModuleResolutionContext } from '../languages/types.js';

/**
 * Strip `//` and block comments plus trailing commas, skipping over string literals so that a
 * URL or a comment-looking substring inside a JSON string survives untouched.
 */
export function stripJsonc(raw: string): string {
  let out = '';
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const c = raw[i]!;
    if (c === '"') {
      const start = i++;
      while (i < n) {
        if (raw[i] === '\\') {
          i += 2;
          continue;
        }
        if (raw[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      out += raw.slice(start, i);
      continue;
    }
    if (c === '/' && raw[i + 1] === '/') {
      while (i < n && raw[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && raw[i + 1] === '*') {
      i += 2;
      while (i < n && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '}' || c === ']') out = out.replace(/,\s*$/, '');
    out += c;
    i++;
  }
  return out;
}

/**
 * Read a JSON or JSONC file. Strict `JSON.parse` first so a valid document is never reshaped by
 * the lenient reader; only a real syntax error falls through to comment stripping. Throws when
 * neither parse succeeds — callers must not overwrite a file they could not read.
 */
export function readJsonc(path: string): unknown {
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    /* not strict JSON: try the JSONC reader below */
  }
  return JSON.parse(stripJsonc(raw));
}

/** Swift manifest target declarations (`.target(name:"X", path:"Y")`). */
export function parseSwiftPackage(text: string): { name: string; path: string | null }[] {
  const src = stripJsonc(text);
  const out: { name: string; path: string | null }[] = [];
  const call = /\.(?:target|testTarget|executableTarget|macro|plugin|systemLibrary|binaryTarget)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(src))) {
    const open = m.index + m[0].length - 1;
    const body = balancedCall(src, open);
    const name = /\bname\s*:\s*"([^"]+)"/.exec(body)?.[1];
    if (!name) continue;
    out.push({ name, path: /\bpath\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? null });
  }
  return out;
}

/** Text between `(` at `open` and its matching `)`, skipping string literals. */
function balancedCall(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

function relDir(p: string): string {
  return p.replace(/^\.\//, '').replace(/^\/+|\/+$/g, '').replace(/^\.$/, '');
}

function under(file: string, root: string): boolean {
  return root === '' || file.startsWith(root + '/');
}

/**
 * Map every Swift file to the target (module) that owns it. Targets come from `Package.swift`
 * when there is one; files no manifest target covers (Xcode projects, examples) fall back to the
 * `Sources/<X>` / top-level-directory heuristic. Files of one target share a scope with no imports.
 */
export function detectSwiftTargets(root: string, files: Set<string>): Map<string, string> {
  const swiftFiles: string[] = [];
  for (const f of files) if (f.endsWith('.swift') && !/(^|\/)Package(@[^/]*)?\.swift$/.test(f)) swiftFiles.push(f);
  const targetOf = new Map<string, string>();
  if (!swiftFiles.length) return targetOf;
  swiftFiles.sort();
  const dirs = new Set<string>();
  for (const f of swiftFiles) {
    let d = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    for (;;) {
      dirs.add(d);
      if (!d) break;
      d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
    }
  }
  const roots: { name: string; root: string }[] = [];
  const add = (name: string, r: string) => {
    if (roots.some((x) => x.root === r)) return;
    roots.push({ name: roots.some((x) => x.name === name) ? r || name : name, root: r });
  };
  const manifest = join(root, 'Package.swift');
  if (existsSync(manifest)) {
    try {
      for (const t of parseSwiftPackage(readFileSync(manifest, 'utf8'))) {
        const cands = t.path ? [t.path] : [`Sources/${t.name}`, `Source/${t.name}`, `src/${t.name}`, `Tests/${t.name}`, t.name];
        const hit = cands.map(relDir).find((c) => dirs.has(c));
        if (hit !== undefined) add(t.name, hit);
      }
    } catch {
      /* unreadable manifest: fall through to the directory heuristic */
    }
  }
  for (const f of swiftFiles) {
    if (roots.some((r) => under(f, r.root))) continue;
    const parts = f.split('/');
    if (parts.length >= 3 && /^(?:Sources|Source|src|Tests|Test)$/i.test(parts[0]!)) add(parts[1]!, `${parts[0]}/${parts[1]}`);
    else if (parts.length >= 2) add(parts[0]!, parts[0]!);
    else add('main', '');
  }
  const byDepth = [...roots].sort((a, b) => b.root.length - a.root.length);
  for (const f of swiftFiles) {
    const r = byDepth.find((x) => under(f, x.root));
    if (r) targetOf.set(f, r.name);
  }
  return targetOf;
}

/** compilerOptions {baseUrl, paths} of one tsconfig/jsconfig, repo-relative, `extends` followed. */
interface TsPaths { baseUrl: string; paths: Record<string, string[]> }

function relFrom(root: string, abs: string): string {
  const r = abs.slice(root.length).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return r;
}

/** Join a repo-relative dir with a config-relative path, normalising `./` and `../`. */
function joinRel(dir: string, rel: string): string {
  const parts = (dir ? dir.split('/') : []).concat(rel.replace(/\\/g, '/').split('/'));
  const stack: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') stack.pop();
    else stack.push(p);
  }
  return stack.join('/');
}

/**
 * Read `baseUrl`/`paths` out of one tsconfig, following relative `extends` (deepest base first,
 * the extending file winning). `paths` are anchored on the config that declares them when it
 * declares no `baseUrl`, which is how TypeScript itself resolves them.
 */
function readTsConfig(root: string, absPath: string, depth = 0): TsPaths | null {
  if (depth > 8 || !existsSync(absPath)) return null;
  let j: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> }; extends?: string | string[] };
  try {
    j = readJsonc(absPath) as typeof j;
  } catch {
    return null;
  }
  const dir = relFrom(root, dirname(absPath));
  const own = j.compilerOptions ?? {};
  const bases: TsPaths[] = [];
  const exts = Array.isArray(j.extends) ? j.extends : j.extends ? [j.extends] : [];
  for (const e of exts) {
    if (typeof e !== 'string' || !e.startsWith('.')) continue; // package `extends`: not on disk here
    const ep = join(dirname(absPath), e.endsWith('.json') ? e : e + '.json');
    const base = readTsConfig(root, ep, depth + 1);
    if (base) bases.push(base);
  }
  let inherited: TsPaths | null = null;
  for (const base of bases) inherited = { baseUrl: base.baseUrl, paths: { ...(inherited ? inherited.paths : {}), ...base.paths } };
  if (own.paths || own.baseUrl !== undefined) {
    const baseUrl = own.baseUrl !== undefined ? joinRel(dir, own.baseUrl) : own.paths ? dir : (inherited?.baseUrl ?? dir);
    return { baseUrl, paths: { ...(inherited?.paths ?? {}), ...(own.paths ?? {}) } };
  }
  return inherited;
}

const TS_CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json', 'tsconfig.base.json'];

/**
 * Nearest tsconfig/jsconfig walking up from a file's directory, cached per directory. A monorepo
 * gives each package (and `web/`, `editors/vscode/`, ...) its own `@/*` alias; only the config
 * closest to the importer describes it.
 */
function makeTsPathsFor(root: string, rootPaths: TsPaths | null): (fromPath: string) => TsPaths | null {
  const cache = new Map<string, TsPaths | null>();
  return (fromPath: string) => {
    let dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
    const chain: string[] = [];
    for (;;) {
      const hit = cache.get(dir);
      if (hit !== undefined) {
        for (const d of chain) cache.set(d, hit);
        return hit;
      }
      chain.push(dir);
      let found: TsPaths | null = null;
      for (const name of TS_CONFIG_NAMES) {
        found = readTsConfig(root, join(root, dir, name));
        if (found) break;
      }
      if (found) {
        for (const d of chain) cache.set(d, found);
        return found;
      }
      if (dir === '') break;
      dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    }
    for (const d of chain) cache.set(d, rootPaths);
    return rootPaths;
  };
}

/** `packages:` globs of a pnpm-workspace.yaml (a flat string list; no full YAML parse needed). */
export function parsePnpmWorkspace(text: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      const inline = line.slice(line.indexOf(':') + 1).trim();
      if (inline.startsWith('[')) {
        for (const m of inline.matchAll(/["']?([^,'"\[\]\s]+)["']?/g)) if (m[1]) out.push(m[1]);
        inPackages = false;
      }
      continue;
    }
    if (!inPackages) continue;
    const m = /^\s+-\s*["']?([^"'#]+?)["']?\s*$/.exec(line);
    if (m) out.push(m[1]!);
    else if (/^\S/.test(line)) inPackages = false;
  }
  return out;
}

/** Expand a workspace glob (`packages/*`, `apps/**`, `tools/a`) to existing repo-relative dirs. */
function expandWorkspaceGlob(root: string, glob: string): string[] {
  const parts = glob.replace(/^\.\//, '').replace(/\/+$/, '').split('/').filter((p) => p !== '' && p !== '.');
  let dirs = [''];
  for (const part of parts) {
    if (part === '*' || part === '**') {
      const next: string[] = [];
      for (const d of dirs) {
        let entries: string[];
        try {
          entries = readdirSync(join(root, d), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map((e) => e.name);
        } catch {
          continue;
        }
        for (const e of entries) {
          const child = d ? `${d}/${e}` : e;
          next.push(child);
          if (part === '**') dirs.push(child); // keep descending for `**`
        }
      }
      dirs = next;
    } else {
      dirs = dirs.map((d) => (d ? `${d}/${part}` : part)).filter((d) => existsSync(join(root, d)));
    }
    if (!dirs.length) return [];
  }
  return dirs;
}

/**
 * Workspace package name -> directory. pnpm-workspace.yaml and the root package.json `workspaces`
 * field are authoritative; `packages/*` and `apps/*` are the fallback for a repo that declares its
 * workspaces somewhere we do not read (lerna, nx, turbo without pnpm).
 */
export function detectWorkspaces(root: string): Map<string, string> {
  const globs: string[] = [];
  const pnpm = join(root, 'pnpm-workspace.yaml');
  if (existsSync(pnpm)) {
    try {
      globs.push(...parsePnpmWorkspace(readFileSync(pnpm, 'utf8')));
    } catch {
      /* unreadable manifest */
    }
  }
  const rootPkg = join(root, 'package.json');
  if (existsSync(rootPkg)) {
    try {
      const j = readJsonc(rootPkg) as { workspaces?: string[] | { packages?: string[] } };
      const w = Array.isArray(j.workspaces) ? j.workspaces : j.workspaces?.packages;
      if (Array.isArray(w)) globs.push(...w.filter((g) => typeof g === 'string'));
    } catch {
      /* unreadable manifest */
    }
  }
  if (!globs.length) globs.push('packages/*', 'apps/*');
  const out = new Map<string, string>();
  const seen = new Set<string>();
  for (const g of globs) {
    if (g.startsWith('!')) continue;
    for (const dir of expandWorkspaceGlob(root, g)) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      const pkg = join(root, dir, 'package.json');
      if (!existsSync(pkg)) continue;
      try {
        const name = (readJsonc(pkg) as { name?: string }).name;
        if (typeof name === 'string' && name && !out.has(name)) out.set(name, dir);
      } catch {
        /* unreadable manifest */
      }
    }
  }
  return out;
}

export function detectProject(root: string, files: Set<string>): ModuleResolutionContext {
  let tsPaths: ModuleResolutionContext['tsPaths'] = null;
  for (const cfg of TS_CONFIG_NAMES) {
    tsPaths = readTsConfig(root, join(root, cfg));
    if (tsPaths) break;
  }
  const tsPathsFor = makeTsPathsFor(root, tsPaths);
  const workspaces = detectWorkspaces(root);
  let goModule: string | null = null;
  const gomod = join(root, 'go.mod');
  if (existsSync(gomod)) {
    const m = readFileSync(gomod, 'utf8').match(/^module\s+(\S+)/m);
    if (m) goModule = m[1]!;
  }
  const pythonRoots: string[] = [];
  for (const r of ['src', 'lib', 'python', 'app']) {
    for (const f of files) {
      if (f.startsWith(r + '/') && f.endsWith('.py')) {
        pythonRoots.push(r);
        break;
      }
    }
  }
  // JVM source roots: `src/<sourceSet>/<lang>`, where the source set is `main`/`test` for Gradle
  // and Maven and anything else for a Kotlin Multiplatform target (commonMain, androidMain,
  // iosMain, jvmMain, desktopMain, jsMain, wasmJsMain, commonTest, ...).
  const jvmRoots: string[] = [];
  for (const f of files) {
    const m = f.match(/^(.*?src\/[^/]+\/(?:java|kotlin|scala))\//);
    if (m && !jvmRoots.includes(m[1]!)) jvmRoots.push(m[1]!);
  }
  const swiftTargetOf = detectSwiftTargets(root, files);
  return {
    hasFile: (p) => files.has(p),
    tsPaths,
    tsPathsFor,
    workspaces,
    goModule,
    pythonRoots,
    jvmRoots,
    swiftTargetOf: (p) => swiftTargetOf.get(p) ?? null,
    swiftTargets: new Set(swiftTargetOf.values()),
  };
}
