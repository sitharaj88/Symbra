import type { FileIR, Definition, Reference, Import } from '../ir/types.js';
import { contentHash } from '../index/extract.js';

/**
 * Deterministic markdown extraction: headings become `section` symbols, links become imports
 * (resolved to files) and backticked identifiers become `mention` references so docs link to code.
 */
export function extractMarkdown(path: string, content: string): FileIR {
  const lines = content.split('\n');
  const definitions: Definition[] = [];
  const references: Reference[] = [];
  const imports: Import[] = [];
  const stack: { level: number; ordinal: number }[] = [];
  let inFence = false;
  let byte = 0;
  let title = '';
  const seenMention = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence) {
      const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (h) {
        const level = h[1]!.length;
        const text = h[2]!.replace(/[*_`]/g, '').trim();
        while (stack.length && stack[stack.length - 1]!.level >= level) {
          const done = stack.pop()!;
          definitions[done.ordinal]!.range.endLine = lineNo - 1;
        }
        const parent = stack.length ? stack[stack.length - 1]!.ordinal : -1;
        const ordinal = definitions.length;
        const parentFqn = parent >= 0 ? definitions[parent]!.fqn : '';
        definitions.push({
          ordinal,
          kind: 'section',
          name: text,
          fqn: parentFqn ? `${parentFqn} > ${text}` : text,
          range: { startLine: lineNo, endLine: lines.length, startByte: byte, endByte: byte + line.length },
          parent,
          signature: `${'#'.repeat(level)} ${text}`,
          doc: '',
          modifiers: [],
          exported: true,
          supertypes: [],
        });
        stack.push({ level, ordinal });
        if (!title && level === 1) title = text;
      }
      const scope = stack.length ? stack[stack.length - 1]!.ordinal : -1;
      // links to other files
      const linkRe = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
      let m: RegExpExecArray | null;
      while ((m = linkRe.exec(line))) {
        const target = m[2]!;
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        imports.push({ source: target.split('#')[0]!, names: [], namespace: true, alias: '', kind: 'static', line: lineNo });
      }
      const wikiRe = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
      while ((m = wikiRe.exec(line))) imports.push({ source: m[1]!.trim(), names: [], namespace: true, alias: '', kind: 'static', line: lineNo });
      // inline code identifiers -> mentions of code symbols
      const codeRe = /`([A-Za-z_$][\w$.]*)(?:\(\))?`/g;
      while ((m = codeRe.exec(line))) {
        const ident = m[1]!;
        if (ident.length < 3) continue;
        const key = `${scope}:${ident}`;
        if (seenMention.has(key)) continue;
        seenMention.add(key);
        const name = ident.includes('.') ? ident.slice(ident.lastIndexOf('.') + 1) : ident;
        const qualifier = ident.includes('.') ? ident.slice(0, ident.lastIndexOf('.')) : '';
        references.push({ kind: 'mention', name, qualifier, line: lineNo, startByte: byte + m.index, scope });
      }
    }
    byte += line.length + 1;
  }
  while (stack.length) {
    const done = stack.pop()!;
    definitions[done.ordinal]!.range.endLine = lines.length;
  }
  // first paragraph as doc
  let doc = '';
  for (const l of lines.slice(0, 40)) {
    const t = l.trim();
    if (!t || t.startsWith('#') || t.startsWith('<') || t.startsWith('[!') || t.startsWith('|') || t.startsWith('```') || t.startsWith('---')) continue;
    doc = t.replace(/[*_`\[\]]/g, '').slice(0, 300);
    break;
  }
  return {
    path,
    language: 'markdown',
    hash: contentHash(content),
    size: Buffer.byteLength(content, 'utf8'),
    definitions,
    references,
    imports,
    localTypes: [],
    diagnostics: [],
    doc: title ? `${title}${doc ? ': ' + doc : ''}` : doc,
    errorPct: 0,
  };
}

/** Resolve a markdown link relative to the file; returns candidate repo-relative paths. */
export function resolveMarkdownLink(source: string, fromPath: string): string[] {
  const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const parts = (source.startsWith('/') ? [] : fromDir ? fromDir.split('/') : []).concat(source.replace(/^\//, '').split('/'));
  const stack: string[] = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') stack.pop();
    else stack.push(p);
  }
  const base = stack.join('/');
  const out = [base];
  if (!/\.\w+$/.test(base)) out.push(`${base}.md`, `${base}/README.md`, `${base}/index.md`);
  return out;
}

import type { LanguageSupport } from './types.js';

/** Registry entry: no grammar; extraction is handled by extractMarkdown. */
export const markdown: LanguageSupport = {
  id: 'markdown',
  grammar: '',
  extensions: ['.md', '.mdx', '.markdown'],
  classLike: new Set(),
  definition: () => null,
  imports: () => null,
  references: () => undefined,
  doc: () => '',
  resolveModule(source, fromPath) {
    return resolveMarkdownLink(source, fromPath);
  },
};
