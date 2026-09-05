/**
 * Async entry points that add the semantic tier to `search()` and `explore()`.
 * When there are no vectors (or no model) they behave exactly like the sync functions.
 */
import type { Store } from '../store/db.js';
import { search, type SearchHit, type SearchOptions } from '../query/search.js';
import { explore, detectIntent, type ExploreOptions, type ContextPack } from '../query/explore.js';
import { hasVectors, loadMatrix, semanticSearch } from './embed.js';
import { loadEmbedder } from './model.js';

export async function searchHybrid(store: Store, q: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  const limit = opts.limit ?? 20;
  const semantic = opts.semantic ?? (hasVectors(store) ? await semanticSearch(store, q, Math.max(20, limit * 2)) : []);
  return search(store, q, { ...opts, semantic });
}

export async function exploreHybrid(store: Store, question: string, opts: ExploreOptions): Promise<ContextPack> {
  // Only free-form questions go through retrieval; graph intents (callers, impact, path, define) do not embed.
  const wants = opts.semantic === undefined && detectIntent(question).type === 'explore' && hasVectors(store);
  const semantic = opts.semantic ?? (wants ? await semanticSearch(store, question, 24) : []);
  return explore(store, question, { ...opts, semantic });
}

/**
 * Fire-and-forget preload of the model and the vector matrix, so the first question does not
 * pay the session-creation cost. Safe to call at server start: it does nothing when the store
 * has no vectors, never downloads, and swallows every failure (the query path re-reports it).
 */
export function warmEmbedder(store: Store): void {
  if (!hasVectors(store)) return;
  void loadEmbedder({ allowDownload: false }).then((e) => {
    if (e) loadMatrix(store);
  }, () => {});
}
