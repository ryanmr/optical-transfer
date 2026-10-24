import { describe, expect, it } from 'vitest';
import { crc32 } from '../src/core/crc32';
import { Compression, decodeManifest, encodeManifest, FrameType, packFrame, parseFrame, type Manifest } from '../src/core/frame';

const sid = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('frame', () => {
  it('round-trips a data frame', () => {
    const payload = crypto.getRandomValues(new Uint8Array(600));
    const bytes = packFrame({ type: FrameType.Data, sessionId: sid, symbolId: 0xdeadbeef, payload });
    expect(bytes.length).toBe(18 + 600 + 4);
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x4f, 0x54, 1, 1]);
    const r = parseFrame(bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.frame.type).toBe(FrameType.Data);
    expect(r.frame.sessionId).toEqual(sid);
    expect(r.frame.symbolId).toBe(0xdeadbeef);
    expect(r.frame.payload).toEqual(payload);
  });

  it('is little-endian on the wire', () => {
    const bytes = packFrame({ type: FrameType.Data, sessionId: sid, symbolId: 0x01020304, payload: new Uint8Array(0x0102) });
    expect(Array.from(bytes.subarray(12, 18))).toEqual([4, 3, 2, 1, 2, 1]);
  });

  it('rejects any single corrupted byte or bit', () => {
    const bytes = packFrame({ type: FrameType.Data, sessionId: sid, symbolId: 42, payload: new Uint8Array(100).fill(7) });
    for (let i = 0; i < bytes.length; i++) {
      for (const bit of [0, 3, 7]) {
        const bad = bytes.slice();
        bad[i] ^= 1 << bit;
        expect(parseFrame(bad).ok).toBe(false);
      }
    }
    const crcFlip = bytes.slice();
    crcFlip[30] ^= 0xff;
    const r = parseFrame(crcFlip);
    expect(r.ok === false && r.error).toBe('crc');
  });

  it('rejects truncated and non-OT input', () => {
    const bytes = packFrame({ type: FrameType.Data, sessionId: sid, symbolId: 1, payload: new Uint8Array(10) });
    expect(parseFrame(bytes.subarray(0, bytes.length - 1)).ok).toBe(false);
    expect(parseFrame(new TextEncoder().encode('https://example.com/hello world')).ok).toBe(false);
    expect(parseFrame(new Uint8Array(3)).ok).toBe(false);
  });

  it('round-trips a manifest', () => {
    const m: Manifest = {
      fileName: 'résumé 📄.pdf',
      originalSize: 50 * 1024 * 1024 + 3,
      compressedSize: 1234567,
      compression: Compression.Gzip,
      K: 2058,
      S: 600,
      blake3: crypto.getRandomValues(new Uint8Array(32)),
    };
    const frame = packFrame({ type: FrameType.Manifest, sessionId: sid, symbolId: 0, payload: encodeManifest(m) });
    const r = parseFrame(frame);
    expect(r.ok).toBe(true);
    if (r.ok) expect(decodeManifest(r.frame.payload)).toEqual(m);
  });

  it('truncates very long names to 255 UTF-8 bytes, keeping the extension', () => {
    const m: Manifest = { fileName: 'é'.repeat(400) + '.tar.gz', originalSize: 1, compressedSize: 1, compression: Compression.None, K: 1, S: 1, blake3: new Uint8Array(32) };
    const d = decodeManifest(encodeManifest(m))!;
    expect(new TextEncoder().encode(d.fileName).length).toBeLessThanOrEqual(255);
    expect(d.fileName.endsWith('.gz')).toBe(true);
  });
});
