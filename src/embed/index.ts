export { embedRepo, semanticSearch, hasVectors, vectorCount, loadMatrix, QUERY_PREFIX } from './embed.js';
export type { EmbedOptions, EmbedStats, SemanticOptions } from './embed.js';
export { searchHybrid, exploreHybrid, warmEmbedder } from './hybrid.js';
export { loadEmbedder, modelCacheDir, modelCached, embeddingsDisabled, embedUnavailableReason, MODEL_ID, MODEL_DIM, BACKEND_NODE, BACKEND_WASM } from './model.js';
export type { Embedder, LoadOptions } from './model.js';
export { DEFAULT_EMBED_KINDS, symbolText, textHash } from './text.js';
export { fuseHits, SEMANTIC_WEIGHT } from './fuse.js';
export { cosineTopK, buildMatrix, encodeVec, decodeVec, normalize, cosine } from './vectors.js';
export type { VectorMatrix, TopHit } from './vectors.js';
