/** Tiny protobuf wire-format encoder for building SCIP test fixtures by hand. */

export function varint(n: number | bigint): number[] {
  let v = typeof n === 'bigint' ? n : BigInt(n);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    out.push(b);
  } while (v !== 0n);
  return out;
}

export function tag(field: number, wireType: number): number[] {
  return varint((field << 3) | wireType);
}

/** int32/enum/bool field (negative numbers are sign-extended to 10 bytes like protobuf does). */
export function vint(field: number, n: number): number[] {
  return [...tag(field, 0), ...varint(n)];
}

export function fixed32(field: number, n: number): number[] {
  return [...tag(field, 5), n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

export function fixed64(field: number, n: bigint): number[] {
  const out = [...tag(field, 1)];
  for (let i = 0n; i < 8n; i++) out.push(Number((n >> (8n * i)) & 0xffn));
  return out;
}

export function bytes(field: number, payload: number[] | Uint8Array): number[] {
  return [...tag(field, 2), ...varint(payload.length), ...payload];
}

export function str(field: number, s: string): number[] {
  return bytes(field, new TextEncoder().encode(s));
}

export function msg(field: number, ...parts: number[][]): number[] {
  return bytes(field, parts.flat());
}

export function packed(field: number, ints: number[]): number[] {
  return bytes(field, ints.flatMap((i) => varint(i)));
}

// ---- SCIP messages (field numbers from scip.proto)

export function occurrence(o: { range: number[]; symbol: string; roles?: number; syntaxKind?: number; enclosing?: number[] }): number[] {
  return [
    ...packed(1, o.range),
    ...str(2, o.symbol),
    ...(o.roles ? vint(3, o.roles) : []),
    ...(o.syntaxKind ? vint(5, o.syntaxKind) : []),
    ...(o.enclosing ? packed(7, o.enclosing) : []),
  ];
}

export function relationship(r: { symbol: string; isReference?: boolean; isImplementation?: boolean; isTypeDefinition?: boolean; isDefinition?: boolean }): number[] {
  return [
    ...str(1, r.symbol),
    ...(r.isReference ? vint(2, 1) : []),
    ...(r.isImplementation ? vint(3, 1) : []),
    ...(r.isTypeDefinition ? vint(4, 1) : []),
    ...(r.isDefinition ? vint(5, 1) : []),
  ];
}

export function symbolInformation(s: { symbol: string; documentation?: string[]; relationships?: number[][]; kind?: number; displayName?: string; signature?: string; enclosingSymbol?: string }): number[] {
  return [
    ...str(1, s.symbol),
    ...(s.documentation ?? []).flatMap((d) => str(3, d)),
    ...(s.relationships ?? []).flatMap((r) => bytes(4, r)),
    ...(s.kind ? vint(5, s.kind) : []),
    ...(s.displayName ? str(6, s.displayName) : []),
    ...(s.signature ? msg(7, str(5, s.signature)) : []),
    ...(s.enclosingSymbol ? str(8, s.enclosingSymbol) : []),
  ];
}

export function document(d: { relativePath: string; language?: string; occurrences?: number[][]; symbols?: number[][]; text?: string; positionEncoding?: number }): number[] {
  return [
    ...str(1, d.relativePath),
    ...(d.occurrences ?? []).flatMap((o) => bytes(2, o)),
    ...(d.symbols ?? []).flatMap((s) => bytes(3, s)),
    ...(d.language ? str(4, d.language) : []),
    ...(d.text ? str(5, d.text) : []),
    ...(d.positionEncoding ? vint(6, d.positionEncoding) : []),
  ];
}

export function metadata(m: { projectRoot: string; toolName?: string; toolVersion?: string }): number[] {
  return [...vint(1, 1), ...msg(2, str(1, m.toolName ?? 'test-indexer'), str(2, m.toolVersion ?? '0.0.0')), ...str(3, m.projectRoot), ...vint(4, 1)];
}

export function index(i: { metadata?: number[]; documents?: number[][]; externalSymbols?: number[][] }): Uint8Array {
  return Uint8Array.from([...(i.metadata ? bytes(1, i.metadata) : []), ...(i.documents ?? []).flatMap((d) => bytes(2, d)), ...(i.externalSymbols ?? []).flatMap((s) => bytes(3, s))]);
}
