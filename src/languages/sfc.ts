/**
 * Shared machinery for single-file component formats (Vue SFC, Svelte).
 *
 * Neither format has a usable vendored grammar, and both are really "HTML with an embedded
 * script". So instead of parsing the whole file we locate the `<script>` blocks with a small tag
 * scanner, hand their text to the existing JavaScript/TypeScript language module, and shift every
 * position the walk produced back into the coordinates of the outer `.vue` / `.svelte` file.
 */

import type { Parser, Tree } from 'web-tree-sitter';
import type { Definition, FileIR, Reference, Import, LocalTypeFact, Diagnostic } from '../ir/types.js';
import { newParser } from '../parse/loader.js';
import { walkTree, type WalkResult } from '../parse/walk.js';
import { javascript, typescript } from './javascript.js';
import type { LanguageSupport } from './types.js';

export interface TagBlock {
  /** Attribute text of the opening tag (everything between the tag name and `>`). */
  attrs: string;
  /** Inner text of the block. */
  content: string;
  /** String index of the first character of `content` within the whole file. */
  startIndex: number;
  /** 1-based line of the first character of `content`. */
  startLine: number;
}

/** Locate every `<tag …>…</tag>` block in `source`. Blocks may not nest (true for script/style). */
export function scanBlocks(source: string, tag: string): TagBlock[] {
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi');
  const out: TagBlock[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const attrs = m[1] ?? '';
    const content = m[2] ?? '';
    const startIndex = m.index + m[0].length - content.length - `</${tag}>`.length;
    out.push({ attrs, content, startIndex, startLine: lineAt(source, startIndex) });
  }
  return out;
}

/** 1-based line number of a string index. */
export function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/** Blank out a region, preserving newlines so every later index and line stays correct. */
export function blankRegion(source: string, start: number, end: number): string {
  const region = source.slice(start, end).replace(/[^\n]/g, ' ');
  return source.slice(0, start) + region + source.slice(end);
}

/** Replace every `<tag>…</tag>` block (and HTML comments) with blanks, keeping offsets stable. */
export function blankBlocks(source: string, tags: string[]): string {
  let out = source;
  for (const tag of tags) {
    for (const b of scanBlocks(out, tag)) out = blankRegion(out, b.startIndex, b.startIndex + b.content.length);
  }
  const commentRe = /<!--[\s\S]*?-->/g;
  let m: RegExpExecArray | null;
  while ((m = commentRe.exec(out))) out = blankRegion(out, m.index, m.index + m[0].length);
  return out;
}

const parsers = new Map<string, Promise<Parser>>();

function parserFor(grammar: string): Promise<Parser> {
  let p = parsers.get(grammar);
  if (!p) {
    p = newParser(grammar);
    parsers.set(grammar, p);
  }
  return p;
}

/** Pick the JS or TS language module for a `<script lang="…">` attribute list. */
export function scriptLanguage(attrs: string): LanguageSupport {
  return /\blang\s*=\s*["']?(ts|typescript)\b/i.test(attrs) ? typescript : javascript;
}

export interface ParsedScript {
  block: TagBlock;
  lang: LanguageSupport;
  tree: Tree;
  result: WalkResult;
}

/**
 * Parse one script block with the JS/TS module and shift every position into file coordinates.
 * The caller owns `tree` and must call `tree.delete()`.
 */
export async function parseScript(block: TagBlock, path: string): Promise<ParsedScript | null> {
  const lang = scriptLanguage(block.attrs);
  const parser = await parserFor(lang.grammar);
  const tree = parser.parse(block.content);
  if (!tree) return null;
  const result = walkTree(tree, block.content, path, lang);
  shiftWalkResult(result, block.startLine - 1, block.startIndex);
  return { block, lang, tree, result };
}

/** Add `lineDelta` to every line and `byteDelta` to every byte offset in a walk result. */
export function shiftWalkResult(r: WalkResult, lineDelta: number, byteDelta: number): void {
  for (const d of r.definitions) {
    d.range.startLine += lineDelta;
    d.range.endLine += lineDelta;
    d.range.startByte += byteDelta;
    d.range.endByte += byteDelta;
  }
  for (const ref of r.references) {
    ref.line += lineDelta;
    ref.startByte += byteDelta;
  }
  for (const imp of r.imports) imp.line += lineDelta;
  for (const dg of r.diagnostics) if (dg.line !== undefined) dg.line += lineDelta;
}

/**
 * Merge one script block's walk result into the accumulating file IR, renumbering ordinals so
 * they stay valid indices into `definitions` (several `<script>` blocks each start at 0).
 */
export function mergeWalkResult(
  target: { definitions: Definition[]; references: Reference[]; imports: Import[]; localTypes: LocalTypeFact[]; diagnostics: Diagnostic[] },
  r: WalkResult,
  ordinalBase: number,
): void {
  for (const d of r.definitions) {
    d.ordinal += ordinalBase;
    if (d.parent >= 0) d.parent += ordinalBase;
    target.definitions.push(d);
  }
  for (const ref of r.references) {
    if (ref.scope >= 0) ref.scope += ordinalBase;
    target.references.push(ref);
  }
  for (const t of r.localTypes) {
    if (t.scope >= 0) t.scope += ordinalBase;
    target.localTypes.push(t);
  }
  target.imports.push(...r.imports);
  target.diagnostics.push(...r.diagnostics);
}

/** `my-widget.vue` / `MyWidget.svelte` -> `MyWidget`. */
export function componentNameFor(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.(vue|svelte)$/i, '');
  return pascal(base);
}

/** `my-comp` / `my_comp` / `myComp` -> `MyComp`; already-PascalCase names pass through. */
export function pascal(name: string): string {
  if (!/[-_.\s]/.test(name)) return name.charAt(0).toUpperCase() + name.slice(1);
  return name
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

const HTML_TAGS = new Set([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite',
  'code', 'col', 'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label',
  'legend', 'li', 'link', 'main', 'map', 'mark', 'menu', 'meta', 'meter', 'nav', 'noscript', 'object', 'ol', 'optgroup', 'option', 'output', 'p', 'param',
  'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'script', 'section', 'select', 'slot', 'small', 'source', 'span', 'strong', 'style',
  'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video',
  'wbr', 'svg', 'path', 'circle', 'rect', 'g', 'line', 'polygon', 'polyline', 'text', 'defs', 'use',
]);

export interface TemplateUse {
  name: string;
  line: number;
  index: number;
}

/**
 * Component usage in template markup: `<MyComp/>`, `<my-comp>`, `<Ns.Comp>`. Both spellings are
 * normalised to PascalCase, which is how the component's own symbol is named.
 */
export function scanComponentUses(template: string, skip: ReadonlySet<string> = new Set()): TemplateUse[] {
  const re = /<([A-Za-z][A-Za-z0-9_]*(?:[-.][A-Za-z0-9_]+)*)(?=[\s/>])/g;
  const out: TemplateUse[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    const raw = m[1]!;
    if (raw.includes('.')) {
      // `<Ns.Comp>`: the last segment is the component.
      const last = raw.slice(raw.lastIndexOf('.') + 1);
      if (!/^[A-Z]/.test(last)) continue;
    } else if (!/^[A-Z]/.test(raw) && !raw.includes('-')) continue;
    const name = raw.includes('.') ? pascal(raw.slice(raw.lastIndexOf('.') + 1)) : pascal(raw);
    if (HTML_TAGS.has(raw.toLowerCase()) || skip.has(name)) continue;
    const line = lineAt(template, m.index);
    const key = `${name}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, line, index: m.index });
  }
  return out;
}

/** Build the file-level `FileIR` shell for an SFC. */
export function emptyIR(path: string, language: string, hash: string, size: number): FileIR {
  return {
    path,
    language,
    hash,
    size,
    definitions: [],
    references: [],
    imports: [],
    localTypes: [],
    diagnostics: [],
    doc: '',
    errorPct: 0,
  };
}
