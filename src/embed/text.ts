/**
 * What gets embedded for a symbol, and the hash that decides whether it needs re-embedding.
 */
import { createHash } from 'node:crypto';
import { splitIdentifier, type SymbolRow } from '../store/db.js';

/** Kinds embedded by default: definitions worth asking about, not every field or enum member. */
export const DEFAULT_EMBED_KINDS: readonly string[] = ['class', 'interface', 'struct', 'trait', 'enum', 'function', 'method', 'constructor', 'route', 'module', 'section', 'type_alias'];

const DOC_CHARS = 300;
const SIG_CHARS = 240;

function pathTail(file: string, segments = 3): string {
  const parts = file.split('/');
  return parts.slice(Math.max(0, parts.length - segments)).join('/');
}

function cleanDoc(doc: string): string {
  return doc.replace(/\s+/g, ' ').trim().slice(0, DOC_CHARS);
}

/**
 * Natural-language-ish description of a symbol: `kind name`, the split identifier,
 * signature, the first characters of the doc, the parent and the file's path tail.
 * Modules and markdown sections use their doc/heading text instead of a signature.
 */
export function symbolText(s: Pick<SymbolRow, 'kind' | 'name' | 'fqn' | 'file' | 'signature' | 'doc'>, parentFqn: string | null): string {
  const parts: string[] = [];
  if (s.kind === 'module') {
    parts.push(`module ${s.name}`);
    const words = splitIdentifier(s.file.replace(/\.[^.]+$/, ''));
    if (words && words !== s.name.toLowerCase()) parts.push(words);
    if (s.doc) parts.push(cleanDoc(s.doc));
    parts.push(s.file);
    return parts.join('. ');
  }
  parts.push(`${s.kind.replace(/_/g, ' ')} ${s.name}`);
  const words = splitIdentifier(s.name);
  if (words && words !== s.name.toLowerCase()) parts.push(words);
  if (s.signature && s.signature !== s.fqn && s.signature !== s.name) parts.push(s.signature.replace(/\s+/g, ' ').trim().slice(0, SIG_CHARS));
  if (s.doc) parts.push(cleanDoc(s.doc));
  if (parentFqn && parentFqn !== s.file) parts.push(`in ${parentFqn}`);
  parts.push(pathTail(s.file));
  return parts.join('. ');
}

/** Short stable hash of the embedded text (also covers the model id so a model change forces re-embedding). */
export function textHash(text: string, model: string): string {
  return createHash('sha1').update(model).update('\0').update(text).digest('hex').slice(0, 20);
}
