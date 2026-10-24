import { crc32 } from './crc32';

// Wire format v1 (little-endian):
//   magic(2) "OT" | version(1) | type(1) | session_id(8) | symbol_id(4) | payload_len(2) | payload | crc32(4)
export const MAGIC0 = 0x4f;
export const MAGIC1 = 0x54;
export const VERSION = 1;
export const HEADER_LEN = 18;
export const TRAILER_LEN = 4;
export const FRAME_OVERHEAD = HEADER_LEN + TRAILER_LEN;

export const FrameType = { Data: 0x01, Manifest: 0x02 } as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export const Compression = { None: 0, Gzip: 1, Zstd: 2 } as const;
export type Compression = (typeof Compression)[keyof typeof Compression];

export interface Frame {
  type: FrameType;
  /** 8 raw bytes. */
  sessionId: Uint8Array;
  symbolId: number;
  payload: Uint8Array;
}

export interface Manifest {
  fileName: string;
  originalSize: number;
  compressedSize: number;
  compression: Compression;
  K: number;
  S: number;
  blake3: Uint8Array;
}

export type ParseError = 'short' | 'magic' | 'version' | 'type' | 'length' | 'crc';

export function packFrame(f: Frame): Uint8Array {
  if (f.sessionId.length !== 8) throw new Error('session_id must be 8 bytes');
  if (f.payload.length > 0xffff) throw new Error('payload too large');
  const out = new Uint8Array(FRAME_OVERHEAD + f.payload.length);
  const dv = new DataView(out.buffer);
  out[0] = MAGIC0;
  out[1] = MAGIC1;
  out[2] = VERSION;
  out[3] = f.type;
  out.set(f.sessionId, 4);
  dv.setUint32(12, f.symbolId >>> 0, true);
  dv.setUint16(16, f.payload.length, true);
  out.set(f.payload, HEADER_LEN);
  const end = HEADER_LEN + f.payload.length;
  dv.setUint32(end, crc32(out, 0, end), true);
  return out;
}

export function parseFrame(buf: Uint8Array): { ok: true; frame: Frame } | { ok: false; error: ParseError } {
  if (buf.length < FRAME_OVERHEAD) return { ok: false, error: 'short' };
  if (buf[0] !== MAGIC0 || buf[1] !== MAGIC1) return { ok: false, error: 'magic' };
  if (buf[2] !== VERSION) return { ok: false, error: 'version' };
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = dv.getUint16(16, true);
  if (buf.length !== FRAME_OVERHEAD + len) return { ok: false, error: 'length' };
  const end = HEADER_LEN + len;
  if (dv.getUint32(end, true) !== crc32(buf, 0, end)) return { ok: false, error: 'crc' };
  const type = buf[3] as FrameType;
  if (type !== FrameType.Data && type !== FrameType.Manifest) return { ok: false, error: 'type' };
  return {
    ok: true,
    frame: {
      type,
      sessionId: buf.slice(4, 12),
      symbolId: dv.getUint32(12, true),
      payload: buf.slice(HEADER_LEN, end),
    },
  };
}

const MAX_NAME_BYTES = 255;

/** Truncate a UTF-8 file name to at most MAX_NAME_BYTES without splitting a code point. */
function encodeName(name: string): Uint8Array {
  const enc = new TextEncoder();
  let bytes = enc.encode(name);
  if (bytes.length <= MAX_NAME_BYTES) return bytes;
  // Keep a short extension and trim the base name one code point at a time.
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  const base = Array.from(ext ? name.slice(0, dot) : name);
  while (bytes.length > MAX_NAME_BYTES) {
    base.pop();
    bytes = enc.encode(base.join('') + ext);
  }
  return bytes;
}

export function encodeManifest(m: Manifest): Uint8Array {
  if (m.blake3.length !== 32) throw new Error('blake3 must be 32 bytes');
  const name = encodeName(m.fileName);
  const out = new Uint8Array(1 + name.length + 8 + 8 + 1 + 4 + 2 + 32);
  const dv = new DataView(out.buffer);
  let o = 0;
  out[o++] = name.length;
  out.set(name, o);
  o += name.length;
  dv.setBigUint64(o, BigInt(m.originalSize), true);
  o += 8;
  dv.setBigUint64(o, BigInt(m.compressedSize), true);
  o += 8;
  out[o++] = m.compression;
  dv.setUint32(o, m.K, true);
  o += 4;
  dv.setUint16(o, m.S, true);
  o += 2;
  out.set(m.blake3, o);
  return out;
}

export function decodeManifest(p: Uint8Array): Manifest | null {
  if (p.length < 1) return null;
  const nameLen = p[0];
  if (p.length !== 1 + nameLen + 8 + 8 + 1 + 4 + 2 + 32) return null;
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  let o = 1;
  const fileName = new TextDecoder().decode(p.subarray(o, o + nameLen));
  o += nameLen;
  const originalSize = Number(dv.getBigUint64(o, true));
  o += 8;
  const compressedSize = Number(dv.getBigUint64(o, true));
  o += 8;
  const compression = p[o++] as Compression;
  const K = dv.getUint32(o, true);
  o += 4;
  const S = dv.getUint16(o, true);
  o += 2;
  const blake3 = p.slice(o, o + 32);
  if (compression > 2 || S === 0 || K === 0 || K * S < compressedSize) return null;
  return { fileName, originalSize, compressedSize, compression, K, S, blake3 };
}
