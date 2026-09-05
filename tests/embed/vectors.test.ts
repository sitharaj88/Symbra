import { describe, it, expect } from 'vitest';
import { buildMatrix, cosineTopK, decodeVec, encodeVec, normalize, cosine } from '../../src/embed/vectors.js';
import { fuseHits } from '../../src/embed/fuse.js';
import { symbolText, textHash } from '../../src/embed/text.js';
import type { SearchHit } from '../../src/query/search.js';
import type { SymbolRow } from '../../src/store/db.js';

/** Deterministic pseudo-random vectors (LCG) so failures reproduce. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000 - 0.5;
  };
}
function randomVec(dim: number, r: () => number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = r();
  return v;
}

describe('vector encoding', () => {
  it('round-trips through the little-endian Float32 blob format', () => {
    const v = Float32Array.from([0.25, -1.5, 3.75, 1e-7]);
    const blob = encodeVec(v);
    expect(blob.byteLength).toBe(16);
    // little-endian bytes of 0.25f = 00 00 80 3E
    expect([...blob.subarray(0, 4)]).toEqual([0x00, 0x00, 0x80, 0x3e]);
    expect([...decodeVec(blob, 4)!]).toEqual([...v]);
    expect(decodeVec(blob, 3)).toBeNull();
  });
  it('normalizes to unit length and leaves zero vectors alone', () => {
    const v = normalize(Float32Array.from([3, 4]));
    expect(v[0]).toBeCloseTo(0.6);
    expect(v[1]).toBeCloseTo(0.8);
    expect([...normalize(new Float32Array(2))]).toEqual([0, 0]);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBe(0);
    expect(cosine(Float32Array.from([1, 1]), Float32Array.from([2, 2]))).toBeCloseTo(1);
  });
});

describe('cosineTopK', () => {
  const dim = 32;
  const r = rng(42);
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: `s${i}`, vec: randomVec(dim, r) }));
  const m = buildMatrix(rows, dim);

  it('finds a planted near-duplicate first and matches a naive full sort', () => {
    const target = rows[123]!.vec;
    const q = Float32Array.from(target, (x) => x * 3 + 0.01); // same direction, different scale
    const top = cosineTopK(m, q, 10);
    expect(top[0]!.id).toBe('s123');
    expect(top[0]!.score).toBeCloseTo(1, 2);
    const nq = normalize(Float32Array.from(q));
    const naive = rows
      .map((row) => ({ id: row.id, score: cosine(row.vec, nq) }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, 10);
    expect(top.map((t) => t.id)).toEqual(naive.map((t) => t.id));
    for (let i = 0; i < 10; i++) expect(top[i]!.score).toBeCloseTo(naive[i]!.score, 5);
  });
  it('respects k, minScore and empty inputs', () => {
    const q = randomVec(dim, rng(7));
    expect(cosineTopK(m, q, 3)).toHaveLength(3);
    expect(cosineTopK(m, q, 0)).toEqual([]);
    expect(cosineTopK(buildMatrix([], dim), q, 5)).toEqual([]);
    expect(cosineTopK(m, q, 50, 0.99)).toEqual([]);
    const all = cosineTopK(m, q, 1000);
    expect(all).toHaveLength(500);
    for (let i = 1; i < all.length; i++) expect(all[i - 1]!.score).toBeGreaterThanOrEqual(all[i]!.score);
  });
});

function sym(id: string, kind: SymbolRow['kind'] = 'method'): SymbolRow {
  return { id, file: `src/${id}.py`, ordinal: 0, kind, name: id, fqn: id, start_line: 1, end_line: 2, start_byte: 0, end_byte: 1, signature: '', doc: '', modifiers: '', exported: 1, parent: null, declared_type: null, meta: null };
}
function hit(id: string, score: number, kind?: SymbolRow['kind']): SearchHit {
  return { symbol: sym(id, kind), score, pagerank: 0, callers: 0, community: null };
}

describe('fuseHits', () => {
  it('lets agreement win and places a strong semantic-only hit below the top lexical hit', () => {
    const lexical = [hit('A', 30), hit('B', 20), hit('C', 10)];
    const semantic = [hit('S', 0.9), hit('B', 0.8)];
    const fused = fuseHits(lexical, semantic, {}, 10);
    // B: 1/2 + 0.8/2 = 0.9 < A: 1.0 ; S: 0.8
    expect(fused.map((h) => h.symbol.id)).toEqual(['A', 'B', 'S', 'C']);
    expect(fused[1]!.cosine).toBeCloseTo(0.8);
    expect(fused[2]!.cosine).toBeCloseTo(0.9);
    const agree = fuseHits([hit('A', 30), hit('B', 20)], [hit('B', 0.9)], {}, 10);
    expect(agree[0]!.symbol.id).toBe('B'); // 0.5 + 0.8 > 1.0
  });
  it('applies kind and path filters to semantic hits and honours the limit', () => {
    const fused = fuseHits([hit('A', 1)], [hit('X', 0.9, 'class'), hit('Y', 0.8)], { kinds: ['method'] }, 2);
    expect(fused.map((h) => h.symbol.id)).toEqual(['A', 'Y']);
    const byPath = fuseHits([], [hit('X', 0.9), hit('Y', 0.8)], { path: 'src/Y' }, 5);
    expect(byPath.map((h) => h.symbol.id)).toEqual(['Y']);
  });
});

describe('symbol text', () => {
  it('describes a method with split words, signature, doc, parent and path tail', () => {
    const s = { ...sym('sendRequest'), kind: 'method' as const, fqn: 'Mediator.sendRequest', file: 'src/MediatR/Mediator.cs', signature: 'Task Send(IRequest request)', doc: 'Sends a request to a single handler.\n\nMore detail.' };
    const t = symbolText(s, 'Mediator');
    expect(t).toContain('method sendRequest');
    expect(t).toContain('send request');
    expect(t).toContain('Task Send(IRequest request)');
    expect(t).toContain('Sends a request to a single handler. More detail.');
    expect(t).toContain('in Mediator');
    expect(t).toContain('src/MediatR/Mediator.cs');
  });
  it('uses the file doc for modules and hashes deterministically per model', () => {
    const m = symbolText({ kind: 'module', name: '_client', fqn: 'httpx/_client.py', file: 'httpx/_client.py', signature: '', doc: 'HTTP client.' }, null);
    expect(m.startsWith('module _client')).toBe(true);
    expect(m).toContain('HTTP client.');
    expect(textHash('a', 'm1')).toBe(textHash('a', 'm1'));
    expect(textHash('a', 'm1')).not.toBe(textHash('a', 'm2'));
    expect(textHash('a', 'm1')).toHaveLength(20);
  });
});
