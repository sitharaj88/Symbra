import type { LanguageSupport } from './types.js';
import { python } from './python.js';
import { javascript, typescript, tsx } from './javascript.js';
import { markdown } from './markdown.js';
import { java } from './java.js';
import { kotlin } from './kotlin.js';
import { scala } from './scala.js';
import { go } from './go.js';
import { rust } from './rust.js';
import { ruby } from './ruby.js';
import { php } from './php.js';
import { csharp } from './csharp.js';
import { c } from './c.js';
import { cpp } from './cpp.js';
import { swift } from './swift.js';
import { dart } from './dart.js';
import { bash } from './bash.js';
import { lua } from './lua.js';
import { elixir } from './elixir.js';
import { zig } from './zig.js';
import { solidity } from './solidity.js';
import { vue } from './vue.js';
import { svelte } from './svelte.js';
import { haskell } from './haskell.js';
import { ocaml, ocamlInterface } from './ocaml.js';
import { fsharp } from './fsharp.js';
import { julia } from './julia.js';
import { objc } from './objc.js';
import { groovy } from './groovy.js';
import { powershell } from './powershell.js';
import { terraform, hcl } from './terraform.js';
import { yaml } from './yaml.js';
import { make, isMakefilePath } from './make.js';
import { sql } from './sql.js';

const all: LanguageSupport[] = [python, javascript, typescript, tsx, markdown, java, kotlin, scala, go, rust, ruby, php, csharp, c, cpp, swift, dart, bash, lua, elixir, zig, solidity, vue, svelte, haskell, ocaml, ocamlInterface, fsharp, julia, objc, groovy, powershell, terraform, hcl, yaml, make, sql];
const byExt = new Map<string, LanguageSupport>();
const byId = new Map<string, LanguageSupport>();

export function registerLanguage(lang: LanguageSupport) {
  if (byId.has(lang.id)) return;
  byId.set(lang.id, lang);
  for (const e of lang.extensions) byExt.set(e, lang);
  all.push(lang);
}
for (const l of [...all]) {
  all.length = 0;
  registerLanguage(l);
}

export function languageForPath(path: string): LanguageSupport | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot < 0) return isMakefilePath(path) ? make : null;
  const ext = base.slice(dot).toLowerCase();
  return byExt.get(ext) ?? null;
}

/** Like languageForPath, but lets a language claim a file by content (e.g. an Objective-C `.h`). */
export function languageForContent(path: string, content: string): LanguageSupport | null {
  const byExtension = languageForPath(path);
  for (const l of byId.values()) if (l !== byExtension && l.detect?.(path, content)) return l;
  return byExtension;
}

export function languageById(id: string): LanguageSupport | null {
  return byId.get(id) ?? null;
}

export function allLanguages(): LanguageSupport[] {
  return [...byId.values()];
}

export function supportedExtensions(): string[] {
  return [...byExt.keys()];
}
