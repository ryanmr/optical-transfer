import { describe, expect, it } from 'vitest';
import { LTDecoder, LTEncoder, symbolNeighbors } from '../src/core/lt';

function randomBytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

function lossy(seed: number) {
  let x = seed;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

function run(K: number, S: number, opts: { loss: number; startId?: number; seed?: number }) {
  const src = randomBytes(K * S, opts.seed ?? 7);
  const enc = new LTEncoder(src, K, S);
  const dec = new LTDecoder(K, S);
  const rand = lossy(opts.seed ?? 3);
  let id = opts.startId ?? 0;
  let received = 0;
  while (!dec.isComplete()) {
    const sid = id++;
    if (rand() < opts.loss) continue;
    dec.addSymbol(sid, enc.symbol(sid));
    received++;
    if (received > K * 3) throw new Error('did not converge');
  }
  expect(dec.data()).toEqual(src);
  return received / K;
}

describe('LT fountain code', () => {
  it('neighbors are deterministic and in range', () => {
    for (let id = 0; id < 2000; id++) {
      const a = symbolNeighbors(1000, id);
      expect(a).toEqual(symbolNeighbors(1000, id));
      expect(new Set(a).size).toBe(a.length);
      for (const i of a) expect(i >= 0 && i < 1000).toBe(true);
    }
  });

  it('decodes with no loss', () => {
    expect(run(500, 64, { loss: 0 })).toBeLessThan(1.25);
  });

  it('decodes with 30% random symbol loss', () => {
    for (const seed of [1, 2, 3]) {
      const overhead = run(1000, 64, { loss: 0.3, seed });
      expect(overhead).toBeLessThan(1.2);
    }
  });

  it('decodes when joining mid-stream (repair symbols only) with 30% loss', () => {
    const overheads = [11, 12, 13, 14].map((seed) => run(1700, 32, { loss: 0.3, startId: 50_000 + seed * 9999, seed }));
    for (const o of overheads) expect(o).toBeLessThan(1.2);
  });

  it('handles tiny K', () => {
    expect(run(1, 16, { loss: 0.3, startId: 5 })).toBeGreaterThanOrEqual(1);
    run(2, 16, { loss: 0.3, startId: 5 });
    run(3, 16, { loss: 0.5 });
  });

  it('setBlock restores known blocks and still completes', () => {
    const K = 300, S = 48;
    const src = randomBytes(K * S, 99);
    const enc = new LTEncoder(src, K, S);
    const dec = new LTDecoder(K, S);
    for (let i = 0; i < K; i += 2) dec.setBlock(i, src.subarray(i * S, (i + 1) * S));
    let id = 10_000;
    while (!dec.isComplete()) dec.addSymbol(id, enc.symbol(id++));
    expect(dec.data()).toEqual(src);
  });
});
