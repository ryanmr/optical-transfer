export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** dst ^= src (over src.length bytes). Uses 32-bit words when both are aligned. */
export function xorInto(dst: Uint8Array, src: Uint8Array): void {
  const n = src.length;
  let i = 0;
  if ((dst.byteOffset & 3) === 0 && (src.byteOffset & 3) === 0) {
    const words = n >> 2;
    const d32 = new Uint32Array(dst.buffer, dst.byteOffset, words);
    const s32 = new Uint32Array(src.buffer, src.byteOffset, words);
    for (let w = 0; w < words; w++) d32[w] ^= s32[w];
    i = words << 2;
  }
  for (; i < n; i++) dst[i] ^= src[i];
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDuration(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '—';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}
