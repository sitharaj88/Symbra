/**
 * Minimal, dependency-free protobuf wire-format decoder for SCIP indexes.
 *
 * Only what the SCIP schema (https://github.com/sourcegraph/scip/blob/main/scip.proto)
 * needs: varint, length-delimited, fixed32/fixed64, packed repeated int32, and
 * skipping of unknown fields. Field numbers below were taken from scip.proto
 * (fetched 2026-09), not guessed:
 *
 *   Index             { metadata = 1, documents = 2, external_symbols = 3 }
 *   Metadata          { version = 1, tool_info = 2, project_root = 3, text_document_encoding = 4 }
 *   ToolInfo          { name = 1, version = 2, arguments = 3 }
 *   Document          { relative_path = 1, occurrences = 2, symbols = 3, language = 4, text = 5, position_encoding = 6 }
 *   Occurrence        { range = 1 (packed int32), symbol = 2, symbol_roles = 3, override_documentation = 4,
 *                       syntax_kind = 5, diagnostics = 6, enclosing_range = 7 (packed int32),
 *                       single_line_range = 8, multi_line_range = 9,
 *                       single_line_enclosing_range = 10, multi_line_enclosing_range = 11 }
 *   SingleLineRange   { line = 1, start_character = 2, end_character = 3 }
 *   MultiLineRange    { start_line = 1, start_character = 2, end_line = 3, end_character = 4 }
 *   SymbolInformation { symbol = 1, documentation = 3, relationships = 4, kind = 5, display_name = 6,
 *                       signature_documentation = 7, enclosing_symbol = 8 }
 *   Relationship      { symbol = 1, is_reference = 2, is_implementation = 3, is_type_definition = 4, is_definition = 5 }
 *   Signature         { occurrences = 2, language = 4, text = 5 }   (used for signature_documentation)
 *
 * The whole index is read into one Buffer (Node caps a single Buffer at ~4 GB and
 * readFileSync at 2 GB; SCIP indexes for very large monorepos can exceed that,
 * see `MAX_INDEX_BYTES`). Documents are decoded one at a time from that buffer so
 * only one decoded document lives on the heap at once.
 */

import { readFileSync, statSync } from 'node:fs';

/** Hard cap for readFileSync; bigger indexes need a streaming reader, which we do not ship. */
export const MAX_INDEX_BYTES = 2 * 1024 * 1024 * 1024 - 1;

export enum WireType {
  Varint = 0,
  Fixed64 = 1,
  LengthDelimited = 2,
  StartGroup = 3,
  EndGroup = 4,
  Fixed32 = 5,
}

/** SymbolRole bit flags (scip.proto `enum SymbolRole`). */
export const SymbolRole = {
  Definition: 0x1,
  Import: 0x2,
  WriteAccess: 0x4,
  ReadAccess: 0x8,
  Generated: 0x10,
  Test: 0x20,
  ForwardDefinition: 0x40,
} as const;

/** The SyntaxKind values we care about (scip.proto `enum SyntaxKind`). */
export const SyntaxKind = {
  Unspecified: 0,
  Identifier: 6,
  IdentifierNamespace: 14,
  IdentifierFunction: 15,
  IdentifierFunctionDefinition: 16,
  IdentifierMacro: 17,
  IdentifierMacroDefinition: 18,
  IdentifierType: 19,
} as const;

/** SymbolInformation.Kind values (scip.proto), only those we map. */
export const ScipKind = {
  UnspecifiedKind: 0,
  AssociatedType: 3,
  Attribute: 4,
  Class: 7,
  Constant: 8,
  Constructor: 9,
  Enum: 11,
  EnumMember: 12,
  Event: 13,
  Field: 15,
  File: 16,
  Function: 17,
  Getter: 18,
  Interface: 21,
  Macro: 25,
  Method: 26,
  Module: 29,
  Namespace: 30,
  Object: 33,
  Package: 35,
  PackageObject: 36,
  Parameter: 37,
  Property: 41,
  Protocol: 42,
  Setter: 45,
  Struct: 49,
  Trait: 53,
  Type: 54,
  TypeAlias: 55,
  TypeClass: 56,
  TypeParameter: 58,
  Variable: 61,
  AbstractMethod: 66,
  MethodSpecification: 67,
  ProtocolMethod: 68,
  PureVirtualMethod: 69,
  TraitMethod: 70,
  TypeClassMethod: 71,
  Accessor: 72,
  Delegate: 73,
  MethodAlias: 74,
  SingletonClass: 75,
  SingletonMethod: 76,
  StaticDataMember: 77,
  StaticEvent: 78,
  StaticField: 79,
  StaticMethod: 80,
  StaticProperty: 81,
  StaticVariable: 82,
  Extension: 84,
  Mixin: 85,
} as const;

export interface ScipRange {
  /** 0-based */
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

export interface ScipOccurrence {
  range: ScipRange;
  symbol: string;
  symbolRoles: number;
  syntaxKind: number;
  enclosingRange: ScipRange | null;
}

export interface ScipRelationship {
  symbol: string;
  isReference: boolean;
  isImplementation: boolean;
  isTypeDefinition: boolean;
  isDefinition: boolean;
}

export interface ScipSymbolInformation {
  symbol: string;
  documentation: string[];
  relationships: ScipRelationship[];
  kind: number;
  displayName: string;
  /** `Signature.text` of `signature_documentation`, or ''. */
  signature: string;
  enclosingSymbol: string;
}

export interface ScipDocument {
  language: string;
  relativePath: string;
  occurrences: ScipOccurrence[];
  symbols: ScipSymbolInformation[];
  /** 0 unspecified, 1 UTF-8 units, 2 UTF-16 units, 3 UTF-32 units (Document.position_encoding). */
  positionEncoding: number;
}

export interface ScipMetadata {
  version: number;
  toolName: string;
  toolVersion: string;
  toolArguments: string[];
  projectRoot: string;
  textDocumentEncoding: number;
}

// ---------------------------------------------------------------- reader

/** Cursor over a Buffer with protobuf primitive readers. */
export class Reader {
  pos: number;
  readonly end: number;

  constructor(
    readonly buf: Uint8Array,
    start = 0,
    end = buf.length,
  ) {
    this.pos = start;
    this.end = end;
  }

  eof(): boolean {
    return this.pos >= this.end;
  }

  /** Unsigned varint as a JS number. Values above 2^53 lose precision (never the case for SCIP fields). */
  varint(): number {
    let shift = 0;
    let result = 0;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error(`protobuf: truncated varint at ${this.pos}`);
      const b = this.buf[this.pos++]!;
      if (shift < 28) result += (b & 0x7f) << shift;
      else result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
    }
    throw new Error(`protobuf: varint longer than 10 bytes at ${this.pos}`);
  }

  /**
   * Varint decoded as int32. Negative values are encoded as sign-extended 10-byte
   * varints whose unsigned value exceeds 2^53, so `varint()` cannot represent them
   * exactly; those are re-read from the raw bytes as a BigInt.
   */
  int32(): number {
    const start = this.pos;
    const v = this.varint();
    if (this.pos - start >= 9) {
      let r = 0n;
      let shift = 0n;
      for (let i = start; i < this.pos; i++) {
        r |= BigInt(this.buf[i]! & 0x7f) << shift;
        shift += 7n;
      }
      return Number(BigInt.asIntN(32, r));
    }
    return v | 0;
  }

  bool(): boolean {
    return this.varint() !== 0;
  }

  fixed32(): number {
    if (this.pos + 4 > this.end) throw new Error(`protobuf: truncated fixed32 at ${this.pos}`);
    const b = this.buf;
    const p = this.pos;
    this.pos += 4;
    return (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0;
  }

  fixed64(): bigint {
    if (this.pos + 8 > this.end) throw new Error(`protobuf: truncated fixed64 at ${this.pos}`);
    const lo = BigInt(this.fixed32());
    const hi = BigInt(this.fixed32());
    return (hi << 32n) | lo;
  }

  /** Length-delimited payload as a sub-range [start, end). */
  bytes(): { start: number; end: number } {
    const len = this.varint();
    const start = this.pos;
    const end = start + len;
    if (end > this.end) throw new Error(`protobuf: length ${len} overruns buffer at ${start}`);
    this.pos = end;
    return { start, end };
  }

  string(): string {
    const { start, end } = this.bytes();
    return utf8(this.buf, start, end);
  }

  /** Field tag: returns [fieldNumber, wireType]. */
  tag(): [number, WireType] {
    const t = this.varint();
    return [t >>> 3, (t & 7) as WireType];
  }

  skip(wt: WireType) {
    switch (wt) {
      case WireType.Varint:
        this.varint();
        return;
      case WireType.Fixed64:
        this.pos += 8;
        if (this.pos > this.end) throw new Error('protobuf: skip overran buffer');
        return;
      case WireType.LengthDelimited:
        this.bytes();
        return;
      case WireType.Fixed32:
        this.pos += 4;
        if (this.pos > this.end) throw new Error('protobuf: skip overran buffer');
        return;
      case WireType.StartGroup: {
        // deprecated groups: skip nested fields until the matching EndGroup
        for (;;) {
          if (this.eof()) throw new Error('protobuf: unterminated group');
          const [, w] = this.tag();
          if (w === WireType.EndGroup) return;
          this.skip(w);
        }
      }
      case WireType.EndGroup:
        return;
      default:
        throw new Error(`protobuf: unknown wire type ${wt} at ${this.pos}`);
    }
  }

  /** Packed or unpacked repeated int32 field body. */
  packedInt32s(wt: WireType, into: number[]) {
    if (wt === WireType.LengthDelimited) {
      const { start, end } = this.bytes();
      const sub = new Reader(this.buf, start, end);
      while (!sub.eof()) into.push(sub.int32());
    } else if (wt === WireType.Varint) {
      into.push(this.int32());
    } else {
      this.skip(wt);
    }
  }
}

const decoder = new TextDecoder('utf-8');
function utf8(buf: Uint8Array, start: number, end: number): string {
  // Fast path for short ASCII strings avoids TextDecoder overhead on millions of symbol strings.
  const n = end - start;
  if (n < 64) {
    let ascii = true;
    for (let i = start; i < end; i++)
      if (buf[i]! > 0x7f) {
        ascii = false;
        break;
      }
    if (ascii) {
      let s = '';
      for (let i = start; i < end; i++) s += String.fromCharCode(buf[i]!);
      return s;
    }
  }
  return decoder.decode(buf.subarray(start, end));
}

// ---------------------------------------------------------------- messages

function rangeFromInts(ints: number[]): ScipRange | null {
  if (ints.length === 3) return { startLine: ints[0]!, startChar: ints[1]!, endLine: ints[0]!, endChar: ints[2]! };
  if (ints.length === 4) return { startLine: ints[0]!, startChar: ints[1]!, endLine: ints[2]!, endChar: ints[3]! };
  return null;
}

function decodeSingleLineRange(r: Reader): ScipRange {
  let line = 0;
  let sc = 0;
  let ec = 0;
  while (!r.eof()) {
    const [f, w] = r.tag();
    if (f === 1 && w === WireType.Varint) line = r.int32();
    else if (f === 2 && w === WireType.Varint) sc = r.int32();
    else if (f === 3 && w === WireType.Varint) ec = r.int32();
    else r.skip(w);
  }
  return { startLine: line, startChar: sc, endLine: line, endChar: ec };
}

function decodeMultiLineRange(r: Reader): ScipRange {
  const o: ScipRange = { startLine: 0, startChar: 0, endLine: 0, endChar: 0 };
  while (!r.eof()) {
    const [f, w] = r.tag();
    if (w !== WireType.Varint) {
      r.skip(w);
      continue;
    }
    const v = r.int32();
    if (f === 1) o.startLine = v;
    else if (f === 2) o.startChar = v;
    else if (f === 3) o.endLine = v;
    else if (f === 4) o.endChar = v;
  }
  return o;
}

export function decodeOccurrence(r: Reader): ScipOccurrence {
  const rangeInts: number[] = [];
  const enclosingInts: number[] = [];
  let typed: ScipRange | null = null;
  let typedEnclosing: ScipRange | null = null;
  const o: ScipOccurrence = { range: { startLine: 0, startChar: 0, endLine: 0, endChar: 0 }, symbol: '', symbolRoles: 0, syntaxKind: 0, enclosingRange: null };
  while (!r.eof()) {
    const [f, w] = r.tag();
    switch (f) {
      case 1:
        r.packedInt32s(w, rangeInts);
        break;
      case 2:
        o.symbol = r.string();
        break;
      case 3:
        o.symbolRoles = r.int32();
        break;
      case 5:
        o.syntaxKind = r.int32();
        break;
      case 7:
        r.packedInt32s(w, enclosingInts);
        break;
      case 8: {
        const { start, end } = r.bytes();
        typed = decodeSingleLineRange(new Reader(r.buf, start, end));
        break;
      }
      case 9: {
        const { start, end } = r.bytes();
        typed = decodeMultiLineRange(new Reader(r.buf, start, end));
        break;
      }
      case 10: {
        const { start, end } = r.bytes();
        typedEnclosing = decodeSingleLineRange(new Reader(r.buf, start, end));
        break;
      }
      case 11: {
        const { start, end } = r.bytes();
        typedEnclosing = decodeMultiLineRange(new Reader(r.buf, start, end));
        break;
      }
      default:
        r.skip(w);
    }
  }
  // scip.proto: when both the typed and the deprecated `repeated int32` form are set,
  // the typed form wins.
  o.range = typed ?? rangeFromInts(rangeInts) ?? o.range;
  o.enclosingRange = typedEnclosing ?? rangeFromInts(enclosingInts);
  return o;
}

function decodeRelationship(r: Reader): ScipRelationship {
  const rel: ScipRelationship = { symbol: '', isReference: false, isImplementation: false, isTypeDefinition: false, isDefinition: false };
  while (!r.eof()) {
    const [f, w] = r.tag();
    if (f === 1 && w === WireType.LengthDelimited) rel.symbol = r.string();
    else if (f === 2 && w === WireType.Varint) rel.isReference = r.bool();
    else if (f === 3 && w === WireType.Varint) rel.isImplementation = r.bool();
    else if (f === 4 && w === WireType.Varint) rel.isTypeDefinition = r.bool();
    else if (f === 5 && w === WireType.Varint) rel.isDefinition = r.bool();
    else r.skip(w);
  }
  return rel;
}

function decodeSignatureText(r: Reader): string {
  let text = '';
  while (!r.eof()) {
    const [f, w] = r.tag();
    if (f === 5 && w === WireType.LengthDelimited) text = r.string();
    else r.skip(w);
  }
  return text;
}

export function decodeSymbolInformation(r: Reader): ScipSymbolInformation {
  const s: ScipSymbolInformation = { symbol: '', documentation: [], relationships: [], kind: 0, displayName: '', signature: '', enclosingSymbol: '' };
  while (!r.eof()) {
    const [f, w] = r.tag();
    switch (f) {
      case 1:
        s.symbol = r.string();
        break;
      case 3:
        s.documentation.push(r.string());
        break;
      case 4: {
        const { start, end } = r.bytes();
        s.relationships.push(decodeRelationship(new Reader(r.buf, start, end)));
        break;
      }
      case 5:
        s.kind = r.int32();
        break;
      case 6:
        s.displayName = r.string();
        break;
      case 7: {
        const { start, end } = r.bytes();
        s.signature = decodeSignatureText(new Reader(r.buf, start, end));
        break;
      }
      case 8:
        s.enclosingSymbol = r.string();
        break;
      default:
        r.skip(w);
    }
  }
  return s;
}

export function decodeDocument(r: Reader): ScipDocument {
  const d: ScipDocument = { language: '', relativePath: '', occurrences: [], symbols: [], positionEncoding: 0 };
  while (!r.eof()) {
    const [f, w] = r.tag();
    switch (f) {
      case 1:
        d.relativePath = r.string();
        break;
      case 2: {
        const { start, end } = r.bytes();
        d.occurrences.push(decodeOccurrence(new Reader(r.buf, start, end)));
        break;
      }
      case 3: {
        const { start, end } = r.bytes();
        d.symbols.push(decodeSymbolInformation(new Reader(r.buf, start, end)));
        break;
      }
      case 4:
        d.language = r.string();
        break;
      case 6:
        d.positionEncoding = r.int32();
        break;
      default:
        r.skip(w); // text (5) is skipped: we read the source from disk
    }
  }
  return d;
}

function decodeToolInfo(r: Reader, m: ScipMetadata) {
  while (!r.eof()) {
    const [f, w] = r.tag();
    if (f === 1 && w === WireType.LengthDelimited) m.toolName = r.string();
    else if (f === 2 && w === WireType.LengthDelimited) m.toolVersion = r.string();
    else if (f === 3 && w === WireType.LengthDelimited) m.toolArguments.push(r.string());
    else r.skip(w);
  }
}

export function decodeMetadata(r: Reader): ScipMetadata {
  const m: ScipMetadata = { version: 0, toolName: '', toolVersion: '', toolArguments: [], projectRoot: '', textDocumentEncoding: 0 };
  while (!r.eof()) {
    const [f, w] = r.tag();
    if (f === 1 && w === WireType.Varint) m.version = r.int32();
    else if (f === 2 && w === WireType.LengthDelimited) {
      const { start, end } = r.bytes();
      decodeToolInfo(new Reader(r.buf, start, end), m);
    } else if (f === 3 && w === WireType.LengthDelimited) m.projectRoot = r.string();
    else if (f === 4 && w === WireType.Varint) m.textDocumentEncoding = r.int32();
    else r.skip(w);
  }
  return m;
}

// ---------------------------------------------------------------- index

/**
 * Walk the top-level Index message. Documents are decoded lazily and handed to
 * `onDocument` one at a time; external symbols to `onExternalSymbol`. Either
 * callback may return `false` to stop early.
 */
export function walkIndex(
  buf: Uint8Array,
  handlers: {
    onMetadata?: (m: ScipMetadata) => void;
    onDocument?: (d: ScipDocument, index: number) => void | boolean;
    onExternalSymbol?: (s: ScipSymbolInformation) => void | boolean;
  },
): void {
  const r = new Reader(buf);
  let n = 0;
  while (!r.eof()) {
    const [f, w] = r.tag();
    if (w !== WireType.LengthDelimited) {
      r.skip(w);
      continue;
    }
    const { start, end } = r.bytes();
    if (f === 1) {
      handlers.onMetadata?.(decodeMetadata(new Reader(buf, start, end)));
    } else if (f === 2) {
      if (!handlers.onDocument) continue;
      if (handlers.onDocument(decodeDocument(new Reader(buf, start, end)), n++) === false) return;
    } else if (f === 3) {
      if (!handlers.onExternalSymbol) continue;
      if (handlers.onExternalSymbol(decodeSymbolInformation(new Reader(buf, start, end))) === false) return;
    }
  }
}

/** Decode a whole index eagerly. Fine for indexes up to a few hundred MB; use `walkIndex` beyond that. */
export function decodeIndex(buf: Uint8Array): { metadata: ScipMetadata | null; documents: ScipDocument[]; externalSymbols: ScipSymbolInformation[] } {
  let metadata: ScipMetadata | null = null;
  const documents: ScipDocument[] = [];
  const externalSymbols: ScipSymbolInformation[] = [];
  walkIndex(buf, {
    onMetadata: (m) => void (metadata = m),
    onDocument: (d) => void documents.push(d),
    onExternalSymbol: (s) => void externalSymbols.push(s),
  });
  return { metadata, documents, externalSymbols };
}

/** Read an index file into memory, refusing files too large for a single Buffer. */
export function readIndexFile(path: string): Buffer {
  const size = statSync(path).size;
  if (size > MAX_INDEX_BYTES) throw new Error(`SCIP index ${path} is ${(size / 1e9).toFixed(1)} GB; the in-memory decoder supports files up to 2 GB`);
  return readFileSync(path);
}
