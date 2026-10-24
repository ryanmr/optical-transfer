import { encodeManifest, FrameType, packFrame, type Manifest } from './frame';
import type { FountainEncoder } from './fountain';
import { LTEncoder } from './lt';
import type { PreparedSource } from './pipeline';

export interface SenderSession {
  sessionId: Uint8Array;
  manifest: Manifest;
  manifestPayload: Uint8Array;
  encoder: FountainEncoder;
}

export function randomSessionId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(8));
}

export function createSession(src: PreparedSource, fileName: string, S: number, sessionId = randomSessionId()): SenderSession {
  const K = Math.max(1, Math.ceil(src.payload.length / S));
  const padded = new Uint8Array(K * S);
  padded.set(src.payload);
  const manifest: Manifest = {
    fileName,
    originalSize: src.originalSize,
    compressedSize: src.payload.length,
    compression: src.compression,
    K,
    S,
    blake3: src.blake3,
  };
  return { sessionId, manifest, manifestPayload: encodeManifest(manifest), encoder: new LTEncoder(padded, K, S) };
}

export interface OutFrame {
  kind: 'data' | 'manifest';
  symbolId: number;
  bytes: Uint8Array;
}

/** Produces the endless frame stream: a manifest first and then every `manifestEvery` frames. */
export class FrameScheduler {
  frameIndex = 0;
  nextSymbol = 0;
  manifestsSent = 0;

  constructor(private readonly s: SenderSession, public manifestEvery = 20) {}

  next(): OutFrame {
    const i = this.frameIndex++;
    if (i % Math.max(1, this.manifestEvery) === 0) {
      const symbolId = this.manifestsSent++;
      return {
        kind: 'manifest',
        symbolId,
        bytes: packFrame({ type: FrameType.Manifest, sessionId: this.s.sessionId, symbolId, payload: this.s.manifestPayload }),
      };
    }
    const symbolId = this.nextSymbol;
    this.nextSymbol = (this.nextSymbol + 1) >>> 0;
    return {
      kind: 'data',
      symbolId,
      bytes: packFrame({ type: FrameType.Data, sessionId: this.s.sessionId, symbolId, payload: this.s.encoder.symbol(symbolId) }),
    };
  }
}
