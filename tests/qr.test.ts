import { describe, expect, it } from 'vitest';
import { readBarcodes } from 'zxing-wasm/reader';
import { FrameType, packFrame, parseFrame } from '../src/core/frame';
import { byteCapacity, encodeQR, rasterize } from '../src/core/qr';

describe('QR byte-mode round trip (qrcode -> zxing-wasm)', () => {
  it('preserves arbitrary binary frames', async () => {
    for (const [S, ecc] of [[200, 'M'], [600, 'L'], [1200, 'L']] as const) {
      const payload = crypto.getRandomValues(new Uint8Array(S));
      payload[0] = 0x00; payload[1] = 0xff; payload[2] = 0x80; // bytes that break text decoding
      const bytes = packFrame({ type: FrameType.Data, sessionId: new Uint8Array(8).fill(9), symbolId: 7, payload });
      const qr = encodeQR(bytes, ecc);
      const img = rasterize(qr, 4, 3);
      const res = await readBarcodes({ data: img.data, width: img.width, height: img.height, colorSpace: 'srgb' } as ImageData, {
        formats: ['QRCode'],
        maxNumberOfSymbols: 1,
      });
      expect(res.length).toBe(1);
      expect(res[0].bytes).toEqual(bytes);
      expect(parseFrame(res[0].bytes).ok).toBe(true);
    }
  });

  it('knows byte capacities', () => {
    expect(byteCapacity(40, 'L')).toBe(2953);
    expect(byteCapacity(1, 'L')).toBe(17);
    expect(encodeQR(new Uint8Array(10), 'L', 10).version).toBe(10);
  });
});
