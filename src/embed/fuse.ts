/**
 * Reciprocal-rank fusion of the lexical ranking with semantic hits. Pure; no model dependency.
 */
import type { SearchHit, SearchOptions } from '../query/search.js';

/** Semantic contribution relative to lexical (lexical is 1.0). */
export const SEMANTIC_WEIGHT = 0.8;

/**
 * Fuse two rankings: rank r (0-based) contributes weight / (r + 1), the same convention the
 * explorer uses for its PageRank fusion. A symbol on both lists adds both contributions, so
 * agreement wins; a strong semantic-only hit lands just below the top lexical hit.
 * The returned `score` is the fused value scaled by 10; `cosine` is kept for display.
 */
export function fuseHits(lexical: SearchHit[], semantic: SearchHit[], opts: SearchOptions, limit: number, weight = SEMANTIC_WEIGHT): SearchHit[] {
  const fused = new Map<string, { hit: SearchHit; value: number }>();
  lexical.forEach((h, i) => fused.set(h.symbol.id, { hit: h, value: 1 / (i + 1) }));
  let rank = 0;
  for (const h of semantic) {
    const s = h.symbol;
    if (opts.kinds?.length && !opts.kinds.includes(s.kind)) continue;
    if (opts.path && !s.file.startsWith(opts.path)) continue;
    const contribution = weight / (rank + 1);
    rank++;
    const cur = fused.get(s.id);
    if (cur) {
      cur.value += contribution;
      cur.hit = { ...cur.hit, cosine: h.cosine ?? h.score };
    } else {
      fused.set(s.id, { hit: { ...h, cosine: h.cosine ?? h.score }, value: contribution });
    }
  }
  return [...fused.values()]
    .sort((a, b) => b.value - a.value || (a.hit.symbol.fqn < b.hit.symbol.fqn ? -1 : 1))
    .slice(0, limit)
    .map(({ hit, value }) => ({ ...hit, score: value * 10 }));
}
