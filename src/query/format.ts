import type { SymbolRow } from '../store/db.js';

/**
 * Rough token estimate. Source code tokenises far denser than prose - punctuation, indentation and
 * camel-cased identifiers each split - so chars/3.2 tracks real tokenisers much more closely than the
 * chars/3.6 that suits English, and keeps a packed context inside the budget it promised.
 */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3.2);
}

export function indent(s: string, pad: string): string {
  return s
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

export function fmtSymbolLine(s: SymbolRow): string {
  const loc = s.kind === 'module' ? s.file : s.kind === 'config_key' ? 'env' : `${s.file}:${s.start_line}${s.end_line > s.start_line ? '-' + s.end_line : ''}`;
  const mods = s.modifiers ? ` ${s.modifiers}` : '';
  return `[${s.kind}${mods}] ${s.fqn}  ${loc}`;
}

export function fmtSymbolShort(s: SymbolRow): string {
  return `${s.fqn} (${s.file}:${s.start_line})`;
}
