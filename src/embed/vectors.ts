/**
 * Pure vector math for the semantic tier: encoding vectors as little-endian
 * Float32 blobs, an in-memory matrix, and brute-force cosine top-k.
 * No model dependency; safe to import anywhere.
 */

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Encode a vector as a little-endian Float32 blob (the on-disk format of `embeddings.vec`). */
export function encodeVec(v: Float32Array): Uint8Array {
  if (LITTLE_ENDIAN) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
  const out = new Uint8Array(v.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < v.length; i++) dv.setFloat32(i * 4, v[i]!, true);
  return out;
}

/** Decode a little-endian Float32 blob. Returns null when the byte length does not match `dim`. */
export function decodeVec(blob: Uint8Array, dim: number): Float32Array | null {
  if (blob.byteLength !== dim * 4) return null;
  if (LITTLE_ENDIAN) {
    // Copy so the result is 4-byte aligned regardless of the blob's offset.
    const out = new Float32Array(dim);
    new Uint8Array(out.buffer).set(blob);
    return out;
  }
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

/** L2-normalise in place; returns the same array. Zero vectors are left untouched. */
export function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  if (s === 0) return v;
  const inv = 1 / Math.sqrt(s);
  for (let i = 0; i < v.length; i++) v[i] = v[i]! * inv;
  return v;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const na = Math.sqrt(dot(a, a));
  const nb = Math.sqrt(dot(b, b));
  return na && nb ? dot(a, b) / (na * nb) : 0;
}

/** Row-major matrix of unit vectors: row i of `data` (length dim) belongs to `ids[i]`. */
export interface VectorMatrix {
  ids: string[];
  dim: number;
  data: Float32Array;
}

export function buildMatrix(rows: { id: string; vec: Float32Array }[], dim: number): VectorMatrix {
  const data = new Float32Array(rows.length * dim);
  const ids: string[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    ids[i] = r.id;
    data.set(normalize(Float32Array.from(r.vec.subarray(0, dim))), i * dim);
  }
  return { ids, dim, data };
}

export interface TopHit {
  id: string;
  score: number;
}

/**
 * Brute-force cosine similarity of a query against every row; rows and query are unit
 * length so this is a dot product. Returns the best `k` rows sorted by score descending,
 * ties broken by id for determinism.
 */
export function cosineTopK(m: VectorMatrix, query: Float32Array, k: number, minScore = -Infinity): TopHit[] {
  const n = m.ids.length;
  if (!n || k <= 0) return [];
  const q = normalize(Float32Array.from(query.subarray(0, m.dim)));
  const dim = m.dim;
  const data = m.data;
  // Small sorted buffer of the current best k (k is tens, n may be tens of thousands).
  const bestScore = new Float64Array(k).fill(-Infinity);
  const bestIdx = new Int32Array(k).fill(-1);
  let filled = 0;
  for (let i = 0; i < n; i++) {
    const off = i * dim;
    let s = 0;
    for (let j = 0; j < dim; j++) s += data[off + j]! * q[j]!;
    if (s < minScore) continue;
    if (filled === k && s <= bestScore[k - 1]!) continue;
    // insertion into the sorted buffer
    let pos = filled < k ? filled : k - 1;
    while (pos > 0 && bestScore[pos - 1]! < s) {
      bestScore[pos] = bestScore[pos - 1]!;
      bestIdx[pos] = bestIdx[pos - 1]!;
      pos--;
    }
    bestScore[pos] = s;
    bestIdx[pos] = i;
    if (filled < k) filled++;
  }
  const out: TopHit[] = [];
  for (let i = 0; i < filled; i++) out.push({ id: m.ids[bestIdx[i]!]!, score: bestScore[i]! });
  out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
