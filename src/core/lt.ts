import { xorInto } from './bytes';
import type { FountainDecoder, FountainEncoder } from './fountain';

// LT code with a robust soliton degree distribution. Every symbol's neighbours are derived from a
// PRNG seeded by (id, K), so any ~K(1+ε) distinct symbols decode regardless of which were lost or
// where the receiver joined the stream. (A systematic variant was tried: it wins only at zero loss
// and wastes most low-degree repair symbols once a few source blocks are missing.)
// The decoder peels (belief propagation) and falls back to Gaussian elimination over GF(2) when
// peeling stalls near the end.

export const LT_C = 0.03;
export const LT_DELTA = 0.5;

function mix32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cdfCache = new Map<number, Float64Array>();

/** Cumulative robust soliton distribution; cdf[d] = P(degree <= d), d in 1..K. */
export function robustSolitonCdf(K: number, c = LT_C, delta = LT_DELTA): Float64Array {
  const cached = c === LT_C && delta === LT_DELTA ? cdfCache.get(K) : undefined;
  if (cached) return cached;
  const mu = new Float64Array(K + 1);
  const R = c * Math.log(K / delta) * Math.sqrt(K);
  const spike = Math.max(1, Math.min(K, Math.floor(K / R)));
  mu[1] = 1 / K;
  for (let d = 2; d <= K; d++) mu[d] = 1 / (d * (d - 1));
  if (R > 0) {
    for (let d = 1; d < spike; d++) mu[d] += R / (d * K);
    mu[spike] += (R * Math.log(R / delta)) / K > 0 ? (R * Math.log(R / delta)) / K : 0;
  }
  let sum = 0;
  for (let d = 1; d <= K; d++) sum += mu[d];
  const cdf = new Float64Array(K + 1);
  let acc = 0;
  for (let d = 1; d <= K; d++) {
    acc += mu[d] / sum;
    cdf[d] = acc;
  }
  cdf[K] = 1;
  if (c === LT_C && delta === LT_DELTA) cdfCache.set(K, cdf);
  return cdf;
}

/** Source block indices combined into symbol `id`. */
export function symbolNeighbors(K: number, id: number): number[] {
  if (K === 1) return [0];
  const rand = rng(mix32(id ^ 0x9e3779b9) ^ mix32(K));
  const cdf = robustSolitonCdf(K);
  const u = rand();
  let lo = 1;
  let hi = K;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  const d = lo;
  if (d * 2 > K) {
    // Dense: partial Fisher-Yates.
    const all = Array.from({ length: K }, (_, i) => i);
    for (let i = 0; i < d; i++) {
      const j = i + Math.floor(rand() * (K - i));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all.slice(0, d);
  }
  const picked = new Set<number>();
  while (picked.size < d) picked.add(Math.floor(rand() * K));
  return Array.from(picked);
}

export class LTEncoder implements FountainEncoder {
  readonly K: number;
  readonly S: number;
  private readonly src: Uint8Array;

  /** `source` is K*S bytes (caller pads the last block). */
  constructor(source: Uint8Array, K: number, S: number) {
    if (source.length !== K * S) throw new Error(`source must be K*S = ${K * S} bytes, got ${source.length}`);
    this.K = K;
    this.S = S;
    // Copy into a 4-byte aligned buffer for fast XOR.
    this.src = new Uint8Array(K * S);
    this.src.set(source);
  }

  symbol(id: number): Uint8Array {
    const out = new Uint8Array(this.S);
    for (const i of symbolNeighbors(this.K, id)) xorInto(out, this.src.subarray(i * this.S, (i + 1) * this.S));
    return out;
  }
}

interface PendingSymbol {
  data: Uint8Array;
  /** Neighbours that were unknown when the symbol arrived. */
  idxs: Int32Array;
  /** Number of neighbours whose data has not been XORed out yet. */
  remaining: number;
  /** XOR of those neighbour indices; equals the last one when remaining == 1. */
  unknownXor: number;
  dead: boolean;
}

export interface LTDecoderOptions {
  /** Max unknown blocks for which Gaussian elimination is attempted when peeling stalls. */
  maxGaussian?: number;
}

export class LTDecoder implements FountainDecoder {
  readonly K: number;
  readonly S: number;
  onBlock: ((index: number, data: Uint8Array) => void) | null = null;
  private readonly blocks: Uint8Array;
  private readonly known: Uint8Array;
  private readonly refs: (PendingSymbol[] | undefined)[];
  private live = 0;
  private recoveredCount = 0;
  private readonly maxGaussian: number;
  private symbolsSinceGaussian = 0;
  private readonly stack: number[] = [];

  constructor(K: number, S: number, opts: LTDecoderOptions = {}) {
    this.K = K;
    this.S = S;
    this.blocks = new Uint8Array(K * S);
    this.known = new Uint8Array(K);
    this.refs = new Array(K);
    this.maxGaussian = opts.maxGaussian ?? 1500;
  }

  get recovered(): number {
    return this.recoveredCount;
  }

  isComplete(): boolean {
    return this.recoveredCount === this.K;
  }

  hasBlock(index: number): boolean {
    return this.known[index] === 1;
  }

  block(index: number): Uint8Array {
    return this.blocks.subarray(index * this.S, (index + 1) * this.S);
  }

  /** All K*S bytes (only meaningful once complete). */
  data(): Uint8Array {
    return this.blocks;
  }

  setBlock(index: number, data: Uint8Array): number {
    if (this.known[index]) return 0;
    const before = this.recoveredCount;
    this.recover(index, data);
    this.propagate();
    return this.recoveredCount - before;
  }

  addSymbol(id: number, data: Uint8Array): number {
    if (this.isComplete()) return 0;
    if (data.length !== this.S) throw new Error('bad symbol length');
    const before = this.recoveredCount;
    const nb = symbolNeighbors(this.K, id);
    const buf = new Uint8Array(this.S);
    buf.set(data);
    const unknown: number[] = [];
    for (const i of nb) {
      if (this.known[i]) xorInto(buf, this.block(i));
      else unknown.push(i);
    }
    if (unknown.length === 1) {
      this.recover(unknown[0], buf);
      this.propagate();
    } else if (unknown.length > 1) {
      const sym: PendingSymbol = {
        data: buf,
        idxs: Int32Array.from(unknown),
        remaining: unknown.length,
        unknownXor: unknown.reduce((a, b) => a ^ b, 0),
        dead: false,
      };
      for (const i of unknown) (this.refs[i] ??= []).push(sym);
      this.live++;
    }
    this.symbolsSinceGaussian++;
    if (!this.isComplete()) this.maybeGaussian();
    return this.recoveredCount - before;
  }

  private recover(index: number, data: Uint8Array): void {
    this.blocks.set(data.subarray(0, this.S), index * this.S);
    this.known[index] = 1;
    this.recoveredCount++;
    this.stack.push(index);
    this.onBlock?.(index, this.block(index));
  }

  private propagate(): void {
    const stack = this.stack;
    while (stack.length) {
      const b = stack.pop()!;
      const list = this.refs[b];
      this.refs[b] = undefined;
      if (!list) continue;
      const blk = this.block(b);
      for (const sym of list) {
        if (sym.dead) continue;
        xorInto(sym.data, blk);
        sym.remaining--;
        sym.unknownXor ^= b;
        if (sym.remaining === 0) {
          sym.dead = true;
          this.live--;
        } else if (sym.remaining === 1) {
          const target = sym.unknownXor;
          // If target is already known its XOR is still queued; this symbol will just die then.
          if (!this.known[target]) {
            sym.dead = true;
            this.live--;
            this.recover(target, sym.data);
          }
        }
      }
    }
  }

  private maybeGaussian(): void {
    const unknownCount = this.K - this.recoveredCount;
    if (unknownCount > this.maxGaussian) return;
    if (this.live < unknownCount) return;
    // Rate-limit: each attempt costs O(u^2 * S); wait for a few more symbols between failures.
    if (this.symbolsSinceGaussian < Math.max(2, Math.ceil(unknownCount * 0.03))) return;
    this.symbolsSinceGaussian = 0;
    this.gaussian();
  }

  /** Gauss-Jordan over the live pending symbols; recovers every block that becomes determined. */
  private gaussian(): void {
    const cols: number[] = [];
    const colOf = new Int32Array(this.K).fill(-1);
    for (let i = 0; i < this.K; i++) if (!this.known[i]) colOf[i] = cols.push(i) - 1;
    const u = cols.length;
    const words = (u + 31) >>> 5;
    const rowsBits: Uint32Array[] = [];
    const rowsData: Uint8Array[] = [];
    const seen = new Set<PendingSymbol>();
    for (const c of cols) {
      for (const sym of this.refs[c] ?? []) {
        if (sym.dead || seen.has(sym)) continue;
        seen.add(sym);
        const bits = new Uint32Array(words);
        for (const i of sym.idxs) if (!this.known[i]) bits[colOf[i] >>> 5] ^= 1 << (colOf[i] & 31);
        rowsBits.push(bits);
        rowsData.push(sym.data.slice());
      }
    }
    const n = rowsBits.length;
    let r = 0;
    const pivotRowOfCol = new Int32Array(u).fill(-1);
    for (let c = 0; c < u && r < n; c++) {
      const w = c >>> 5;
      const m = 1 << (c & 31);
      let p = -1;
      for (let i = r; i < n; i++) if (rowsBits[i][w] & m) { p = i; break; }
      if (p < 0) continue;
      [rowsBits[r], rowsBits[p]] = [rowsBits[p], rowsBits[r]];
      [rowsData[r], rowsData[p]] = [rowsData[p], rowsData[r]];
      const pb = rowsBits[r];
      const pd = rowsData[r];
      for (let i = 0; i < n; i++) {
        if (i === r || !(rowsBits[i][w] & m)) continue;
        const rb = rowsBits[i];
        for (let k = 0; k < words; k++) rb[k] ^= pb[k];
        xorInto(rowsData[i], pd);
      }
      pivotRowOfCol[c] = r;
      r++;
    }
    let found = false;
    for (let c = 0; c < u; c++) {
      const row = pivotRowOfCol[c];
      if (row < 0) continue;
      // Row is determined iff the pivot is its only set bit.
      const bits = rowsBits[row];
      let single = true;
      for (let k = 0; k < words && single; k++) {
        const v = k === c >>> 5 ? bits[k] & ~(1 << (c & 31)) : bits[k];
        if (v !== 0) single = false;
      }
      if (single && !this.known[cols[c]]) {
        this.recover(cols[c], rowsData[row]);
        found = true;
      }
    }
    if (found) this.propagate();
  }
}
