import type { Store } from '../store/db.js';
import { loadRows, computeMetrics } from './metrics.js';
import { computeCommunities } from './communities.js';

/**
 * Recompute PageRank/communities when indexing deferred them (meta `analysis_stale`).
 *
 * Small incremental runs only set the flag, because `loadRows()` reads every symbol and every edge.
 * The debt is paid here, on the first consumer that actually needs metrics and community labels:
 * `overview()` and `symbra viz`. Returns true when a recompute happened.
 */
export function refreshStaleAnalysis(store: Store): boolean {
  if (store.getMeta('analysis_stale') !== '1') return false;
  const rows = loadRows(store);
  computeMetrics(store, rows);
  computeCommunities(store, rows);
  store.setMeta('analyzed_at', String(Date.now()));
  store.setMeta('analysis_stale', '0');
  store.setMeta('analysis_stale_files', '0');
  return true;
}
