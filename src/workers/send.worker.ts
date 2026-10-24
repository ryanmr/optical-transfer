/// <reference lib="webworker" />
import { toHex } from '../core/bytes';
import { prepareSource, type PreparedSource } from '../core/pipeline';
import { encodeQR, type Ecc } from '../core/qr';
import { createSession, FrameScheduler, type SenderSession } from '../core/sender';
import type { SendIn, SendOut, SentFrame } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let prepared: PreparedSource | null = null;
let fileName = '';
let session: SenderSession | null = null;
let sched: FrameScheduler | null = null;
let ecc: Ecc = 'L';
let version = 0;
let corruptRate = 0;
let makeQR = true;
let generation = 0;

const post = (m: SendOut, transfer: Transferable[] = []) => self.postMessage(m, transfer);

function startSession(S: number, manifestEvery: number) {
  session = createSession(prepared!, fileName, S);
  sched = new FrameScheduler(session, manifestEvery);
  generation++;
  pickVersion();
  post({ type: 'ready', session: toHex(session.sessionId), manifest: session.manifest, version, frameBytes: S + 22, generation });
}

/** Pin the QR version to the one a data frame needs so every code (incl. manifests) has the same size. */
function pickVersion() {
  version = encodeQR(new Uint8Array(session!.manifest.S + 22), ecc).version;
}

self.onmessage = async (ev: MessageEvent<SendIn>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'load': {
        ecc = msg.ecc;
        fileName = msg.file.name;
        prepared = null;
        const total = msg.file.size;
        let last = 0;
        prepared = await prepareSource(msg.file.stream() as ReadableStream<Uint8Array>, msg.compression, (read) => {
          if (read - last > 1 << 20 || read === total) {
            last = read;
            post({ type: 'progress', read, total });
          }
        });
        startSession(msg.S, msg.manifestEvery);
        break;
      }
      case 'config': {
        if (msg.corruptRate !== undefined) corruptRate = msg.corruptRate;
        if (msg.qr !== undefined) makeQR = msg.qr;
        if (msg.manifestEvery !== undefined && sched) sched.manifestEvery = msg.manifestEvery;
        if (msg.ecc && msg.ecc !== ecc) {
          ecc = msg.ecc;
          if (session) {
            pickVersion();
            generation++;
            post({ type: 'ready', session: toHex(session.sessionId), manifest: session.manifest, version, frameBytes: session.manifest.S + 22, generation });
          }
        }
        // A new block size changes K, so it needs a new session.
        if (msg.S && prepared && session && msg.S !== session.manifest.S) startSession(msg.S, sched?.manifestEvery ?? 20);
        break;
      }
      case 'frames': {
        if (!sched) return;
        const frames: SentFrame[] = [];
        for (let i = 0; i < msg.n; i++) {
          const f = sched.next();
          let bytes = f.bytes;
          let corrupted = false;
          if (corruptRate > 0 && Math.random() < corruptRate) {
            bytes = bytes.slice();
            bytes[Math.floor(Math.random() * bytes.length)] ^= 1 + Math.floor(Math.random() * 255);
            corrupted = true;
          }
          const qr = makeQR ? encodeQR(bytes, ecc, version) : { size: 0, modules: new Uint8Array(0) };
          frames.push({ kind: f.kind, symbolId: f.symbolId, size: qr.size, modules: qr.modules, bytes, corrupted });
        }
        post({ type: 'frames', frames, generation }, frames.flatMap((f) => [f.modules.buffer as ArrayBuffer, f.bytes.buffer as ArrayBuffer]));
        break;
      }
    }
  } catch (e) {
    post({ type: 'error', message: (e as Error).message ?? String(e) });
  }
};
