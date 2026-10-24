import QRCode from 'qrcode';

export type Ecc = 'L' | 'M' | 'Q' | 'H';

export interface QRMatrix {
  size: number;
  /** size*size, 1 = dark module. */
  modules: Uint8Array;
  version: number;
}

/** Encode raw bytes as a byte-mode QR code. `version` pins the symbol size (falls back to auto if it doesn't fit). */
export function encodeQR(bytes: Uint8Array, ecc: Ecc, version?: number): QRMatrix {
  const segs = [{ data: bytes, mode: 'byte' as const }];
  let qr;
  try {
    qr = QRCode.create(segs as never, { errorCorrectionLevel: ecc, version });
  } catch (e) {
    if (version === undefined) throw e;
    qr = QRCode.create(segs as never, { errorCorrectionLevel: ecc });
  }
  const m = qr.modules as unknown as { size: number; data: Uint8Array };
  return { size: m.size, modules: Uint8Array.from(m.data, (v) => (v ? 1 : 0)), version: qr.version };
}

/** Byte-mode capacity for QR versions 1..40 (index = version). */
export function byteCapacity(version: number, ecc: Ecc): number {
  // Binary search over payload size using the encoder itself (cached).
  const key = `${version}${ecc}`;
  const hit = capCache.get(key);
  if (hit !== undefined) return hit;
  let lo = 0;
  let hi = 2953;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    try {
      QRCode.create([{ data: new Uint8Array(mid), mode: 'byte' }] as never, { errorCorrectionLevel: ecc, version });
      lo = mid;
    } catch {
      hi = mid - 1;
    }
  }
  capCache.set(key, lo);
  return lo;
}
const capCache = new Map<string, number>();

/** Rasterise at 1 px per module with a quiet zone, into RGBA. */
export function rasterize(qr: QRMatrix, quiet = 4, scale = 1, dark = 0, light = 255): { width: number; height: number; data: Uint8ClampedArray } {
  const dim = (qr.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4);
  for (let y = 0; y < dim; y++) {
    const my = Math.floor(y / scale) - quiet;
    for (let x = 0; x < dim; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const on = my >= 0 && mx >= 0 && my < qr.size && mx < qr.size && qr.modules[my * qr.size + mx];
      const v = on ? dark : light;
      const o = (y * dim + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { width: dim, height: dim, data };
}
