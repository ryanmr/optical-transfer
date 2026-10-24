import { createBLAKE3 } from 'hash-wasm';
import { Compression } from './frame';

export async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  return concat(chunks, total);
}

export function concat(chunks: Uint8Array[], total = chunks.reduce((a, c) => a + c.length, 0)): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export async function blake3(data: Uint8Array): Promise<Uint8Array> {
  const h = await createBLAKE3();
  h.init();
  h.update(data);
  return h.digest('binary');
}

export function decompressor(c: Compression): TransformStream<Uint8Array, Uint8Array> | null {
  switch (c) {
    case Compression.None:
      return null;
    case Compression.Gzip:
      return new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>;
    default:
      throw new Error(`unsupported compression ${c}`);
  }
}

export interface PreparedSource {
  originalSize: number;
  compression: Compression;
  /** Payload that gets fountain-coded (compressed or raw). */
  payload: Uint8Array;
  blake3: Uint8Array;
}

/**
 * Stream the original file once: hash it with BLAKE3 and gzip it. If gzip does not save at least
 * 2%, fall back to sending it uncompressed.
 */
export async function prepareSource(
  input: ReadableStream<Uint8Array>,
  mode: 'auto' | 'gzip' | 'none' = 'auto',
  onProgress?: (bytesRead: number) => void,
): Promise<PreparedSource> {
  const hasher = await createBLAKE3();
  hasher.init();
  const raw: Uint8Array[] = [];
  let originalSize = 0;
  const gz = mode === 'none' ? null : new CompressionStream('gzip');
  const gzWriter = gz?.writable.getWriter();
  const gzOut = gz ? collect(gz.readable as ReadableStream<Uint8Array>) : null;
  const reader = input.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    hasher.update(value);
    originalSize += value.length;
    if (mode !== 'gzip') raw.push(value);
    if (gzWriter) await gzWriter.write(value as Uint8Array<ArrayBuffer>);
    onProgress?.(originalSize);
  }
  await gzWriter?.close();
  const compressed = gzOut ? await gzOut : null;
  const digest = hasher.digest('binary');
  if (compressed && (mode === 'gzip' || compressed.length < originalSize * 0.98)) {
    return { originalSize, compression: Compression.Gzip, payload: compressed, blake3: digest };
  }
  return { originalSize, compression: Compression.None, payload: concat(raw, originalSize), blake3: digest };
}
