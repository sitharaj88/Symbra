import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// dist/parse/grammar-manifest.js -> ../../grammars/manifest.json ; src/parse/grammar-manifest.ts -> ../../grammars/manifest.json
const MANIFEST_PATH = join(here, '..', '..', 'grammars', 'manifest.json');

export interface GrammarInfo {
  /** Grammar id, matching LanguageSupport.grammar and the `tree-sitter-<name>.wasm` file name. */
  name: string;
  /** Shipped in the npm package (./grammars) when true; fetched on demand into the user cache otherwise. */
  core: boolean;
  /** npm package that publishes the .wasm file. */
  pkg: string;
  /** Exact version vendored/fetched. */
  version: string;
  /** Path of the .wasm file inside the published npm tarball, relative to the package root. */
  wasmFile: string;
}

interface ManifestFile {
  grammars: GrammarInfo[];
}

function loadManifest(): GrammarInfo[] {
  const raw = readFileSync(MANIFEST_PATH, 'utf8');
  const parsed = JSON.parse(raw) as ManifestFile;
  return parsed.grammars;
}

/** Every grammar Symbra knows about, core and long-tail. */
export const grammarManifest: readonly GrammarInfo[] = loadManifest();

/** Lookup by grammar id. */
export const manifestByName: ReadonlyMap<string, GrammarInfo> = new Map(grammarManifest.map((g) => [g.name, g]));

/** Core grammars, shipped in the npm package. */
export const coreGrammars: readonly GrammarInfo[] = grammarManifest.filter((g) => g.core);

/** Long-tail grammars, fetched on demand into the user cache. */
export const optionalGrammars: readonly GrammarInfo[] = grammarManifest.filter((g) => !g.core);

export function getGrammarInfo(name: string): GrammarInfo | undefined {
  return manifestByName.get(name);
}
