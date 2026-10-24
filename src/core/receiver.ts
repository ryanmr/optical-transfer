import { createBLAKE3 } from 'hash-wasm';
import { bytesEqual, toHex } from './bytes';
import { Compression, decodeManifest, encodeManifest, FrameType, parseFrame, type Frame, type Manifest, type ParseError } from './frame';
import { LTDecoder } from './lt';
import { decompressor } from './pipeline';
import type { StorageDir, SyncFile } from './storage';

// Receiver state machine, independent of workers/DOM so it can be unit tested.
//
// OPFS layout (under the storage root):
//   current                     hex session id of the active transfer
//   sessions/<hex>/manifest.bin raw manifest payload
//   sessions/<hex>/blocks.bin   recovered source blocks at block_index * S (truncated to
//                               compressed_size when complete)
//   sessions/<hex>/bitmap.bin   1 bit per recovered block
//   sessions/<hex>/symbols.log  every unique symbol received: u32 id + S bytes, so a reload can
//                               rebuild the decoder's partially-solved state
//   sessions/<hex>/output.bin   decompressed output (absent when compression = none)
//   sessions/<hex>/state.json   {status, error?}

export type ReceiverStatus = 'idle' | 'receiving' | 'finalizing' | 'verified' | 'failed';

export interface ReceiverStats {
  status: ReceiverStatus;
  session: string | null;
  manifest: Manifest | null;
  resumed: boolean;
  framesIn: number;
  errors: Record<ParseError, number>;
  dataFrames: number;
  manifestFrames: number;
  duplicates: number;
  unique: number;
  recovered: number;
  buffered: number;
  foreignFrames: number;
  foreign: { session: string; fileName: string } | null;
  error: string | null;
  /** OPFS path of the verified (or failed, for debugging) output file. */
  outputPath: string[] | null;
  computedHash: string | null;
}

interface Active {
  hex: string;
  manifest: Manifest;
  dir: StorageDir;
  blocks: SyncFile | null;
  bitmap: SyncFile | null;
  log: SyncFile | null;
  bits: Uint8Array;
  seen: Set<number>;
  logCount: number;
  decoder: LTDecoder;
}

const MAX_SOURCE_BYTES = 2 ** 31;

export class Receiver {
  private active: Active | null = null;
  private buffered: Frame[] = [];
  private foreignManifests = new Map<string, Manifest>();
  private s: ReceiverStats = Receiver.emptyStats();
  onChange: (() => void) | null = null;

  constructor(private readonly root: StorageDir, private readonly maxBuffered = 2000) {}

  private static emptyStats(): ReceiverStats {
    return {
      status: 'idle',
      session: null,
      manifest: null,
      resumed: false,
      framesIn: 0,
      errors: { short: 0, magic: 0, version: 0, type: 0, length: 0, crc: 0 },
      dataFrames: 0,
      manifestFrames: 0,
      duplicates: 0,
      unique: 0,
      recovered: 0,
      buffered: 0,
      foreignFrames: 0,
      foreign: null,
      error: null,
      outputPath: null,
      computedHash: null,
    };
  }

  stats(): ReceiverStats {
    const a = this.active;
    return {
      ...this.s,
      errors: { ...this.s.errors },
      recovered: !a ? 0 : this.s.status === 'verified' ? a.manifest.K : a.decoder.recovered,
      unique: a ? a.seen.size : 0,
      buffered: this.buffered.length,
    };
  }

  /** Resume the persisted session, if any. */
  async init(): Promise<void> {
    const cur = await this.root.readAll('current');
    if (!cur) return;
    const hex = new TextDecoder().decode(cur).trim();
    const sessions = await this.root.dir('sessions');
    const dir = await sessions.dir(hex);
    const mp = await dir.readAll('manifest.bin');
    const manifest = mp && decodeManifest(mp);
    if (!manifest) {
      await this.root.remove('current');
      return;
    }
    const stateRaw = await dir.readAll('state.json');
    const state = stateRaw ? JSON.parse(new TextDecoder().decode(stateRaw)) : { status: 'receiving' };
    this.s.session = hex;
    this.s.manifest = manifest;
    this.s.resumed = true;
    if (state.status === 'verified' || state.status === 'failed') {
      // Finished earlier; keep it around so the user can still export (or inspect) it.
      this.active = { hex, manifest, dir, blocks: null, bitmap: null, log: null, bits: new Uint8Array(0), seen: new Set(), logCount: 0, decoder: new LTDecoder(1, 1) };
      this.s.status = state.status;
      this.s.error = state.error ?? null;
      this.s.outputPath = state.outputPath ?? null;
      this.s.computedHash = state.computedHash ?? null;
      return;
    }
    await this.openSession(hex, manifest, dir, true);
  }

  /** Feed one decoded barcode payload. */
  async ingest(bytes: Uint8Array): Promise<void> {
    this.s.framesIn++;
    const r = parseFrame(bytes);
    if (!r.ok) {
      this.s.errors[r.error]++;
      return;
    }
    const f = r.frame;
    const hex = toHex(f.sessionId);
    const a = this.active;
    if (a && a.hex === hex) {
      if (f.type === FrameType.Manifest) this.s.manifestFrames++;
      else await this.onData(a, f);
      return;
    }
    if (a) {
      this.s.foreignFrames++;
      if (f.type === FrameType.Manifest) {
        const m = decodeManifest(f.payload);
        if (m) {
          this.foreignManifests.set(hex, m);
          this.s.foreign = { session: hex, fileName: m.fileName };
        }
      }
      return;
    }
    if (f.type === FrameType.Manifest) {
      this.s.manifestFrames++;
      const m = decodeManifest(f.payload);
      if (!m || m.K * m.S > MAX_SOURCE_BYTES) {
        this.s.errors.type++;
        return;
      }
      await this.adopt(hex, m);
    } else {
      this.s.dataFrames++;
      this.buffered.push(f);
      if (this.buffered.length > this.maxBuffered) this.buffered.shift();
    }
  }

  /** Abandon the current transfer and lock on to another session seen on the wire. */
  async switchTo(hex: string): Promise<void> {
    const m = this.foreignManifests.get(hex);
    if (!m) throw new Error('unknown session');
    await this.reset();
    await this.adopt(hex, m);
  }

  /** Drop all persisted state. */
  async reset(): Promise<void> {
    this.closeHandles();
    this.active = null;
    this.buffered = [];
    await this.root.remove('current');
    await this.root.removeDir('sessions');
    const foreign = this.foreignManifests;
    this.s = Receiver.emptyStats();
    this.foreignManifests = foreign;
    this.onChange?.();
  }

  flush(): void {
    const a = this.active;
    a?.blocks?.flush();
    a?.bitmap?.flush();
    a?.log?.flush();
  }

  close(): void {
    this.flush();
    this.closeHandles();
  }

  private closeHandles(): void {
    const a = this.active;
    if (!a) return;
    for (const h of [a.blocks, a.bitmap, a.log]) h?.close();
    a.blocks = a.bitmap = a.log = null;
  }

  private async adopt(hex: string, manifest: Manifest): Promise<void> {
    const sessions = await this.root.dir('sessions');
    const dir = await sessions.dir(hex);
    await dir.writeAll('manifest.bin', encodeManifest(manifest));
    await dir.writeAll('state.json', json({ status: 'receiving' }));
    await this.root.writeAll('current', new TextEncoder().encode(hex));
    this.foreignManifests.delete(hex);
    if (this.s.foreign?.session === hex) this.s.foreign = null;
    this.s.session = hex;
    this.s.manifest = manifest;
    await this.openSession(hex, manifest, dir, false);
    const pending = this.buffered.filter((f) => toHex(f.sessionId) === hex);
    this.buffered = [];
    for (const f of pending) if (this.active) await this.onData(this.active, f, false);
  }

  private async openSession(hex: string, manifest: Manifest, dir: StorageDir, resume: boolean): Promise<void> {
    const { K, S } = manifest;
    const decoder = new LTDecoder(K, S);
    const a: Active = {
      hex,
      manifest,
      dir,
      blocks: await dir.open('blocks.bin'),
      bitmap: await dir.open('bitmap.bin'),
      log: await dir.open('symbols.log'),
      bits: new Uint8Array(Math.ceil(K / 8)),
      seen: new Set(),
      logCount: 0,
      decoder,
    };
    this.active = a;
    this.s.status = 'receiving';
    if (resume) {
      // 1) blocks already on disk
      a.bitmap!.read(a.bits, 0);
      const blk = new Uint8Array(S);
      for (let i = 0; i < K; i++) {
        if (!(a.bits[i >> 3] & (1 << (i & 7)))) continue;
        blk.fill(0);
        a.blocks!.read(blk, i * S);
        decoder.setBlock(i, blk);
      }
      // 2) replay unique symbols to rebuild the partially-solved state
      const rec = 4 + S;
      const count = Math.floor(a.log!.getSize() / rec);
      const buf = new Uint8Array(rec);
      const dv = new DataView(buf.buffer);
      for (let n = 0; n < count; n++) {
        a.log!.read(buf, n * rec);
        const id = dv.getUint32(0, true);
        if (a.seen.has(id)) continue;
        a.seen.add(id);
        decoder.addSymbol(id, buf.subarray(4));
      }
      a.logCount = count;
    }
    // Attach after the resume replay so blocks restored from disk aren't rewritten; blocks newly
    // solved by the replayed symbols are persisted below.
    decoder.onBlock = (i, data) => this.persistBlock(a, i, data);
    if (resume) for (let i = 0; i < K; i++) if (decoder.hasBlock(i) && !(a.bits[i >> 3] & (1 << (i & 7)))) this.persistBlock(a, i, decoder.block(i));
    this.flush();
    if (decoder.isComplete()) await this.finalize(a);
  }

  private persistBlock(a: Active, i: number, data: Uint8Array): void {
    a.blocks!.write(data, i * a.manifest.S);
    const byte = i >> 3;
    a.bits[byte] |= 1 << (i & 7);
    a.bitmap!.write(a.bits.subarray(byte, byte + 1), byte);
  }

  private async onData(a: Active, f: Frame, count = true): Promise<void> {
    if (count) this.s.dataFrames++;
    if (this.s.status !== 'receiving') return;
    if (f.payload.length !== a.manifest.S) {
      this.s.errors.length++;
      return;
    }
    if (a.seen.has(f.symbolId)) {
      this.s.duplicates++;
      return;
    }
    a.seen.add(f.symbolId);
    const rec = new Uint8Array(4 + a.manifest.S);
    new DataView(rec.buffer).setUint32(0, f.symbolId, true);
    rec.set(f.payload, 4);
    a.log!.write(rec, a.logCount++ * rec.length);
    a.decoder.addSymbol(f.symbolId, f.payload);
    if (a.decoder.isComplete()) await this.finalize(a);
  }

  private async finalize(a: Active): Promise<void> {
    this.s.status = 'finalizing';
    this.onChange?.();
    const m = a.manifest;
    a.blocks!.truncate(m.compressedSize);
    this.flush();
    this.closeHandles();

    const outName = m.compression === Compression.None ? 'blocks.bin' : 'output.bin';
    let error: string | null = null;
    let computed: Uint8Array | null = null;
    try {
      const hasher = await createBLAKE3();
      hasher.init();
      const input = await a.dir.stream('blocks.bin');
      const d = decompressor(m.compression);
      const stream = d ? input.pipeThrough(d) : input;
      const out = d ? await a.dir.open('output.bin') : null;
      out?.truncate(0);
      let size = 0;
      try {
        const reader = stream.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          hasher.update(value);
          out?.write(value, size);
          size += value.length;
        }
        out?.flush();
      } finally {
        out?.close();
      }
      computed = hasher.digest('binary');
      if (size !== m.originalSize) error = `size mismatch: expected ${m.originalSize} bytes, got ${size}`;
      else if (!bytesEqual(computed, m.blake3)) error = `BLAKE3 mismatch: expected ${toHex(m.blake3)}, got ${toHex(computed)}`;
    } catch (e) {
      error = `decompression failed: ${(e as Error).message ?? e}`;
    }

    this.s.status = error ? 'failed' : 'verified';
    this.s.error = error;
    this.s.outputPath = [...a.dir.path, outName];
    this.s.computedHash = computed ? toHex(computed) : null;
    await a.dir.writeAll(
      'state.json',
      json({ status: this.s.status, error, outputPath: this.s.outputPath, computedHash: this.s.computedHash }),
    );
    // The symbol log is only needed to resume; keep it on failure for debugging.
    if (!error) await a.dir.remove('symbols.log');
    this.onChange?.();
  }
}

function json(v: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(v));
}
