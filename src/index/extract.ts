import { createHash } from 'node:crypto';
import type { Parser } from 'web-tree-sitter';
import type { FileIR } from '../ir/types.js';
import { newParser } from '../parse/loader.js';
import { walkTree, toFileIR } from '../parse/walk.js';
import { languageForContent } from '../languages/registry.js';
import type { LanguageSupport } from '../languages/types.js';
import { extractMarkdown } from '../languages/markdown.js';
import { extractVue } from '../languages/vue.js';
import { extractSvelte } from '../languages/svelte.js';
import { extractSql } from '../languages/sql.js';

const parsers = new Map<string, Promise<Parser>>();

async function parserFor(lang: LanguageSupport): Promise<Parser> {
  let p = parsers.get(lang.grammar);
  if (!p) {
    p = newParser(lang.grammar);
    parsers.set(lang.grammar, p);
  }
  return p;
}

export function contentHash(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

/** Extract the IR for one file. Returns null when the language is unsupported. */
export async function extractFile(path: string, content: string): Promise<FileIR | null> {
  const lang = languageForContent(path, content);
  if (!lang) return null;
  if (!lang.grammar) {
    // Grammar-less languages carry their own extractor (markdown, and the SFC formats whose
    // `<script>` blocks are handed to the JS/TS module).
    if (lang.id === 'vue') return extractVue(path, content);
    if (lang.id === 'svelte') return extractSvelte(path, content);
    if (lang.id === 'sql') return extractSql(path, content);
    return extractMarkdown(path, content);
  }
  const parser = await parserFor(lang);
  const tree = parser.parse(content);
  if (!tree) return null;
  try {
    const r = walkTree(tree, content, path, lang);
    // Bytes, not chars: scan.ts records st.size in bytes and change detection compares the two.
    return toFileIR(path, lang.id, contentHash(content), Buffer.byteLength(content, 'utf8'), r);
  } finally {
    tree.delete();
  }
}
