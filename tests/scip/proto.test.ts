import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Reader, WireType, decodeIndex, decodeOccurrence, walkIndex, SymbolRole } from '../../src/scip/proto.js';
import * as pb from './pb.js';

describe('protobuf wire decoder', () => {
  it('reads varints of every width, including sign-extended negative int32', () => {
    const cases = [0, 1, 127, 128, 300, 16383, 16384, 2 ** 31 - 1, 2 ** 32 - 1, 2 ** 53 - 1];
    for (const n of cases) {
      const r = new Reader(Uint8Array.from(pb.varint(n)));
      expect(r.varint()).toBe(n);
      expect(r.eof()).toBe(true);
    }
    const neg = new Reader(Uint8Array.from(pb.varint(-5)));
    expect(pb.varint(-5).length).toBe(10);
    expect(neg.int32()).toBe(-5);
    expect(new Reader(Uint8Array.from(pb.varint(-(2 ** 31)))).int32()).toBe(-(2 ** 31));
    expect(() => new Reader(Uint8Array.from([0x80, 0x80])).varint()).toThrow(/truncated/);
  });

  it('reads fixed32, fixed64, strings and tags', () => {
    const buf = Uint8Array.from([...pb.fixed32(1, 0xdeadbeef), ...pb.fixed64(2, 0x1122334455667788n), ...pb.str(3, 'héllo')]);
    const r = new Reader(buf);
    expect(r.tag()).toEqual([1, WireType.Fixed32]);
    expect(r.fixed32()).toBe(0xdeadbeef);
    expect(r.tag()).toEqual([2, WireType.Fixed64]);
    expect(r.fixed64()).toBe(0x1122334455667788n);
    expect(r.tag()).toEqual([3, WireType.LengthDelimited]);
    expect(r.string()).toBe('héllo');
    expect(r.eof()).toBe(true);
    expect(() => new Reader(Uint8Array.from([...pb.tag(1, 2), 200])).bytes()).toThrow(/overruns/);
  });

  it('skips unknown fields of every wire type, including groups', () => {
    // Occurrence with unknown fields 20 (varint), 21 (fixed64), 22 (bytes), 23 (fixed32), 24 (group) around known ones
    const group = [...pb.tag(24, 3), ...pb.vint(1, 7), ...pb.str(2, 'x'), ...pb.tag(24, 4)];
    const bytes = [
      ...pb.vint(20, 99),
      ...pb.packed(1, [3, 4, 3, 9]),
      ...pb.fixed64(21, 1n),
      ...pb.str(2, 'local 1'),
      ...pb.bytes(22, [1, 2, 3]),
      ...pb.vint(3, SymbolRole.Definition),
      ...pb.fixed32(23, 5),
      ...group,
      ...pb.vint(5, 15),
    ];
    const o = decodeOccurrence(new Reader(Uint8Array.from(bytes)));
    expect(o).toEqual({ range: { startLine: 3, startChar: 4, endLine: 3, endChar: 9 }, symbol: 'local 1', symbolRoles: 1, syntaxKind: 15, enclosingRange: null });
  });

  it('decodes three- and four-int ranges, unpacked ranges, and typed ranges', () => {
    const three = decodeOccurrence(new Reader(Uint8Array.from(pb.occurrence({ range: [1, 2, 8], symbol: 's' }))));
    expect(three.range).toEqual({ startLine: 1, startChar: 2, endLine: 1, endChar: 8 });
    const four = decodeOccurrence(new Reader(Uint8Array.from(pb.occurrence({ range: [1, 2, 3, 4], symbol: 's', enclosing: [0, 0, 10, 1] }))));
    expect(four.range).toEqual({ startLine: 1, startChar: 2, endLine: 3, endChar: 4 });
    expect(four.enclosingRange).toEqual({ startLine: 0, startChar: 0, endLine: 10, endChar: 1 });
    // unpacked repeated int32 (one varint field per element) is legal on the wire too
    const unpacked = [...pb.vint(1, 5), ...pb.vint(1, 0), ...pb.vint(1, 3), ...pb.str(2, 's')];
    expect(decodeOccurrence(new Reader(Uint8Array.from(unpacked))).range).toEqual({ startLine: 5, startChar: 0, endLine: 5, endChar: 3 });
    // MultiLineRange (field 9) when the deprecated `range` is absent
    const typed = [...pb.str(2, 's'), ...pb.msg(9, pb.vint(1, 2), pb.vint(2, 1), pb.vint(3, 4), pb.vint(4, 6))];
    expect(decodeOccurrence(new Reader(Uint8Array.from(typed))).range).toEqual({ startLine: 2, startChar: 1, endLine: 4, endChar: 6 });
    // SingleLineRange (field 8)
    const single = [...pb.str(2, 's'), ...pb.msg(8, pb.vint(1, 9), pb.vint(2, 3), pb.vint(3, 7))];
    expect(decodeOccurrence(new Reader(Uint8Array.from(single))).range).toEqual({ startLine: 9, startChar: 3, endLine: 9, endChar: 7 });
    // scip.proto: the typed form takes precedence over the deprecated `repeated int32` one
    const both = [...pb.packed(1, [1, 1, 2]), ...pb.str(2, 's'), ...pb.msg(8, pb.vint(1, 9), pb.vint(2, 3), pb.vint(3, 7))];
    expect(decodeOccurrence(new Reader(Uint8Array.from(both))).range).toEqual({ startLine: 9, startChar: 3, endLine: 9, endChar: 7 });
  });

  it('decodes typed enclosing ranges (fields 10 and 11) and prefers them over the deprecated field 7', () => {
    const one = [...pb.packed(1, [4, 2, 5]), ...pb.str(2, 's'), ...pb.msg(10, pb.vint(1, 4), pb.vint(2, 0), pb.vint(3, 20))];
    expect(decodeOccurrence(new Reader(Uint8Array.from(one))).enclosingRange).toEqual({ startLine: 4, startChar: 0, endLine: 4, endChar: 20 });
    const many = [...pb.packed(1, [4, 2, 5]), ...pb.str(2, 's'), ...pb.packed(7, [0, 0, 1, 1]), ...pb.msg(11, pb.vint(1, 3), pb.vint(2, 0), pb.vint(3, 8), pb.vint(4, 1))];
    expect(decodeOccurrence(new Reader(Uint8Array.from(many))).enclosingRange).toEqual({ startLine: 3, startChar: 0, endLine: 8, endChar: 1 });
  });

  it('decodes a hand-built index end to end and streams documents', () => {
    const sym = 'scip-test npm pkg 1.0.0 src/`a.ts`/f().';
    const idx = pb.index({
      metadata: pb.metadata({ projectRoot: 'file:///tmp/x', toolName: 'hand', toolVersion: '1' }),
      documents: [
        pb.document({
          relativePath: 'src/a.ts',
          language: 'typescript',
          occurrences: [pb.occurrence({ range: [0, 16, 17], symbol: sym, roles: SymbolRole.Definition, enclosing: [0, 0, 2, 1] }), pb.occurrence({ range: [5, 2, 3], symbol: sym })],
          symbols: [
            pb.symbolInformation({
              symbol: sym,
              documentation: ['Doc of f'],
              kind: 17,
              displayName: 'f',
              signature: 'function f(): void',
              relationships: [pb.relationship({ symbol: 'other', isImplementation: true })],
            }),
          ],
        }),
        pb.document({ relativePath: 'src/b.ts' }),
      ],
      externalSymbols: [pb.symbolInformation({ symbol: 'ext', kind: 7 })],
    });
    const d = decodeIndex(idx);
    expect(d.metadata).toMatchObject({ version: 1, toolName: 'hand', toolVersion: '1', projectRoot: 'file:///tmp/x' });
    expect(d.documents.map((x) => x.relativePath)).toEqual(['src/a.ts', 'src/b.ts']);
    const a = d.documents[0]!;
    expect(a.language).toBe('typescript');
    expect(a.occurrences).toHaveLength(2);
    expect(a.occurrences[0]!.symbolRoles & SymbolRole.Definition).toBeTruthy();
    expect(a.symbols[0]).toEqual({
      symbol: sym,
      documentation: ['Doc of f'],
      relationships: [{ symbol: 'other', isReference: false, isImplementation: true, isTypeDefinition: false, isDefinition: false }],
      kind: 17,
      displayName: 'f',
      signature: 'function f(): void',
      enclosingSymbol: '',
    });
    expect(d.externalSymbols[0]!.symbol).toBe('ext');
    // streaming walk with early stop
    const seen: string[] = [];
    walkIndex(idx, { onDocument: (doc) => void seen.push(doc.relativePath) || false });
    expect(seen).toEqual(['src/a.ts']);
  });

  it('decodes the committed scip-typescript index', () => {
    const buf = readFileSync(new URL('../fixtures/scip-ts/index.scip', import.meta.url));
    const d = decodeIndex(buf);
    expect(d.metadata?.toolName).toBe('scip-typescript');
    expect(d.documents.map((x) => x.relativePath).sort()).toEqual(['src/greeter.ts', 'src/main.ts']);
    const main = d.documents.find((x) => x.relativePath === 'src/main.ts')!;
    const defs = main.occurrences.filter((o) => o.symbolRoles & SymbolRole.Definition).map((o) => o.symbol);
    expect(defs.some((s) => s.endsWith('src/`main.ts`/run().'))).toBe(true);
    expect(defs.some((s) => s.endsWith('src/`main.ts`/LoudGreeter#'))).toBe(true);
    const capRef = main.occurrences.find((o) => o.symbol.endsWith('capitalize().') && !(o.symbolRoles & SymbolRole.Definition) && o.range.startLine === 6);
    expect(capRef).toBeTruthy();
  });
});
