import { describe, expect, it } from 'vitest';
import { toHex } from '../src/core/bytes';
import { Compression, encodeManifest } from '../src/core/frame';
import { blake3, collect, prepareSource } from '../src/core/pipeline';
import { Receiver } from '../src/core/receiver';
import { createSession, FrameScheduler, type SenderSession } from '../src/core/sender';
import { MemoryDir, type StorageDir } from '../src/core/storage';

function prng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

function randomFile(n: number, seed = 1): Uint8Array {
  const r = prng(seed);
  return Uint8Array.from({ length: n }, () => (r() * 256) | 0);
}

/** Compressible text-like content. */
function textFile(n: number): Uint8Array {
  const words = ['optical', 'fountain', 'camera', 'screen', 'frame', 'symbol', 'block', 'manifest'];
  const r = prng(9);
  let s = '';
  while (s.length < n) s += words[(r() * words.length) | 0] + (r() < 0.1 ? '\n' : ' ');
  return new TextEncoder().encode(s.slice(0, n));
}

function streamOf(data: Uint8Array): ReadableStream<Uint8Array> {
  let off = 0;
  return new ReadableStream({
    pull(c) {
      if (off >= data.length) return c.close();
      c.enqueue(data.slice(off, off + 50_000));
      off += 50_000;
    },
  });
}

async function makeSender(data: Uint8Array, S = 600, mode: 'auto' | 'gzip' | 'none' = 'auto') {
  const src = await prepareSource(streamOf(data), mode);
  const session = createSession(src, 'test.bin', S);
  return { session, sched: new FrameScheduler(session, 20) };
}

async function output(root: StorageDir, rx: Receiver): Promise<Uint8Array> {
  const path = rx.stats().outputPath!;
  let d = root;
  for (const seg of path.slice(0, -1)) d = await d.dir(seg);
  return (await d.readAll(path[path.length - 1]))!;
}

interface Channel {
  loss?: number;
  corrupt?: number;
  seed?: number;
}

async function pump(rx: Receiver, sched: FrameScheduler, ch: Channel, until: (rx: Receiver) => boolean, max = 100_000) {
  const r = prng(ch.seed ?? 5);
  for (let i = 0; i < max && !until(rx); i++) {
    const f = sched.next();
    if (r() < (ch.loss ?? 0)) continue;
    let bytes = f.bytes;
    if (r() < (ch.corrupt ?? 0)) {
      bytes = bytes.slice();
      bytes[(r() * bytes.length) | 0] ^= 1 + ((r() * 255) | 0);
    }
    await rx.ingest(bytes);
  }
}

const done = (rx: Receiver) => ['verified', 'failed'].includes(rx.stats().status);

describe('end to end (in-memory channel)', () => {
  it('transfers a 1 MB random file with 30% loss and 5% corruption', async () => {
    const data = randomFile(1024 * 1024);
    const { session, sched } = await makeSender(data);
    expect(session.manifest.compression).toBe(Compression.None); // random data doesn't compress
    const root = new MemoryDir();
    const rx = new Receiver(root);
    await rx.init();
    await pump(rx, sched, { loss: 0.3, corrupt: 0.05 }, done);
    const st = rx.stats();
    expect(st.status).toBe('verified');
    expect(st.errors.crc + st.errors.magic + st.errors.version + st.errors.length + st.errors.type).toBeGreaterThan(0);
    expect(st.unique / session.manifest.K).toBeLessThan(1.15);
    expect(await output(root, rx)).toEqual(data);
  });

  it('transfers gzip-compressed content', async () => {
    const data = textFile(300_000);
    const { session, sched } = await makeSender(data);
    expect(session.manifest.compression).toBe(Compression.Gzip);
    expect(session.manifest.compressedSize).toBeLessThan(data.length / 2);
    const root = new MemoryDir();
    const rx = new Receiver(root);
    await pump(rx, sched, { loss: 0.1 }, done);
    expect(rx.stats().status).toBe('verified');
    expect(await output(root, rx)).toEqual(data);
  });

  it('recovers when joining mid-stream (buffers data frames until a manifest)', async () => {
    const data = randomFile(200_000, 3);
    const { session, sched } = await makeSender(data);
    for (let i = 0; i < 5000; i++) sched.next(); // receiver wasn't looking yet
    for (let i = 0; i < 5; i++) sched.next(); // land between manifests
    const root = new MemoryDir();
    const rx = new Receiver(root);
    await rx.ingest(sched.next().bytes); // a data frame before any manifest
    expect(rx.stats().status).toBe('idle');
    expect(rx.stats().buffered).toBe(1);
    await pump(rx, sched, { loss: 0.2 }, done);
    expect(rx.stats().status).toBe('verified');
    expect(rx.stats().session).toBe(toHex(session.sessionId));
    expect(await output(root, rx)).toEqual(data);
  });

  it('handles tiny and empty files', async () => {
    for (const data of [new Uint8Array(0), new Uint8Array([42]), randomFile(599), randomFile(600), randomFile(601)]) {
      const { sched } = await makeSender(data);
      const root = new MemoryDir();
      const rx = new Receiver(root);
      await pump(rx, sched, { loss: 0.3 }, done);
      expect(rx.stats().status).toBe('verified');
      expect(await output(root, rx)).toEqual(data);
    }
  });

  it('ignores other sessions and can switch to them', async () => {
    const a = await makeSender(randomFile(50_000, 1));
    const b = await makeSender(randomFile(50_000, 2));
    const root = new MemoryDir();
    const rx = new Receiver(root);
    await rx.ingest(a.sched.next().bytes); // manifest for A -> locks on
    for (let i = 0; i < 25; i++) await rx.ingest(b.sched.next().bytes);
    const st = rx.stats();
    expect(st.session).toBe(toHex(a.session.sessionId));
    expect(st.foreignFrames).toBe(25);
    expect(st.foreign?.session).toBe(toHex(b.session.sessionId));
    await rx.switchTo(st.foreign!.session);
    await pump(rx, b.sched, {}, done);
    expect(rx.stats().status).toBe('verified');
  });

  it('reports a BLAKE3 mismatch and keeps the data', async () => {
    const data = randomFile(30_000);
    const { session } = await makeSender(data);
    const bad: SenderSession = { ...session, manifestPayload: encodeManifest({ ...session.manifest, blake3: new Uint8Array(32) }) };
    const sched = new FrameScheduler(bad, 20);
    const root = new MemoryDir();
    const rx = new Receiver(root);
    await pump(rx, sched, {}, done);
    const st = rx.stats();
    expect(st.status).toBe('failed');
    expect(st.error).toMatch(/BLAKE3 mismatch/);
    expect(st.computedHash).toBe(toHex(await blake3(data)));
    expect(await output(root, rx)).toEqual(data);
  });
});

describe('resume (persisted storage)', () => {
  it('a reloaded receiver continues where it left off', async () => {
    const data = randomFile(500_000, 11);
    const { session, sched } = await makeSender(data);
    const K = session.manifest.K;
    const root = new MemoryDir();

    const rx1 = new Receiver(root);
    await rx1.init();
    await pump(rx1, sched, { loss: 0.3 }, (rx) => rx.stats().unique >= K * 0.7);
    const before = rx1.stats();
    expect(before.status).toBe('receiving');
    rx1.close(); // tab closed

    const rx2 = new Receiver(root);
    await rx2.init();
    const after = rx2.stats();
    expect(after.resumed).toBe(true);
    expect(after.session).toBe(before.session);
    expect(after.unique).toBe(before.unique);
    expect(after.recovered).toBe(before.recovered);

    // Only ~30% more symbols should be needed, not a full restart.
    await pump(rx2, sched, { loss: 0.3, seed: 77 }, done);
    expect(rx2.stats().status).toBe('verified');
    expect(rx2.stats().unique).toBeLessThan(K * 1.15);
    expect(await output(root, rx2)).toEqual(data);

    // A third load sees the finished transfer.
    const rx3 = new Receiver(root);
    await rx3.init();
    expect(rx3.stats().status).toBe('verified');
    expect(await output(root, rx3)).toEqual(data);
  });

  it('resumes from blocks + bitmap even if the symbol log is lost', async () => {
    const data = randomFile(120_000, 12);
    const { sched } = await makeSender(data);
    const root = new MemoryDir();
    const rx1 = new Receiver(root);
    await pump(rx1, sched, {}, (rx) => rx.stats().recovered > 50);
    const recovered = rx1.stats().recovered;
    rx1.close();
    const sessionDir = await (await root.dir('sessions')).dir(rx1.stats().session!);
    await sessionDir.remove('symbols.log');
    const rx2 = new Receiver(root);
    await rx2.init();
    expect(rx2.stats().recovered).toBe(recovered);
    await pump(rx2, sched, {}, done);
    expect(await output(root, rx2)).toEqual(data);
  });

  it('reset clears persisted state', async () => {
    const { sched } = await makeSender(randomFile(10_000));
    const root = new MemoryDir();
    const rx = new Receiver(root);
    await pump(rx, sched, {}, (r) => r.stats().unique > 3);
    await rx.reset();
    const rx2 = new Receiver(root);
    await rx2.init();
    expect(rx2.stats().status).toBe('idle');
  });
});

describe('prepareSource', () => {
  it('hashes the original bytes', async () => {
    const data = textFile(10_000);
    const src = await prepareSource(streamOf(data));
    expect(src.blake3).toEqual(await blake3(data));
    expect(src.originalSize).toBe(data.length);
    const round = await collect(streamOf(src.payload).pipeThrough(new DecompressionStream('gzip') as any));
    expect(round).toEqual(data);
  });
});

