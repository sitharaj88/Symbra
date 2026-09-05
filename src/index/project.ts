import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

export function detectProject(root: string, files: Set<string>): ModuleResolutionContext {
  let tsPaths: ModuleResolutionContext['tsPaths'] = null;
  for (const cfg of ['tsconfig.json', 'jsconfig.json', 'tsconfig.base.json']) {
    const p = join(root, cfg);
    if (!existsSync(p)) continue;
    try {
      const j = readJsonc(p) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> }; extends?: string };
      let co = j.compilerOptions ?? {};
      if (j.extends && typeof j.extends === 'string' && j.extends.startsWith('.')) {
        const ep = join(root, j.extends.endsWith('.json') ? j.extends : j.extends + '.json');
        if (existsSync(ep)) {
          const base = readJsonc(ep) as { compilerOptions?: typeof co };
          co = { ...(base.compilerOptions ?? {}), ...co };
        }
      }
      if (co.paths || co.baseUrl !== undefined) {
        tsPaths = { baseUrl: (co.baseUrl ?? '').replace(/^\.\//, '').replace(/\/$/, ''), paths: co.paths ?? {} };
        break;
      }
    } catch {
      /* ignore malformed config */
    }
  }
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
  const jvmRoots: string[] = [];
  for (const f of files) {
    const m = f.match(/^(.*?src\/(?:main|test)\/(?:java|kotlin|scala))\//);
    if (m && !jvmRoots.includes(m[1]!)) jvmRoots.push(m[1]!);
  }
  const swiftTargetOf = detectSwiftTargets(root, files);
  return {
    hasFile: (p) => files.has(p),
    tsPaths,
    goModule,
    pythonRoots,
    jvmRoots,
    swiftTargetOf: (p) => swiftTargetOf.get(p) ?? null,
    swiftTargets: new Set(swiftTargetOf.values()),
  };
}
