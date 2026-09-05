export { indexRepo } from './index/indexer.js';
export type { IndexOptions, IndexStats } from './index/indexer.js';
export { extractFile } from './index/extract.js';
export { Store, defaultDbPath } from './store/db.js';
export { embedRepo, semanticSearch, hasVectors, searchHybrid, exploreHybrid, loadEmbedder, DEFAULT_EMBED_KINDS } from './embed/index.js';
export type { EmbedOptions, EmbedStats, Embedder } from './embed/index.js';
export type * from './ir/types.js';
export { importScip } from './scip/import.js';
export type { ScipImportOptions, ScipImportStats } from './scip/import.js';
