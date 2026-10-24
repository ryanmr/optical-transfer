import type { Manifest } from '../core/frame';
import type { Ecc } from '../core/qr';
import type { ReceiverStats } from '../core/receiver';

// ---- send.worker ----
export type SendIn =
  | { type: 'load'; file: File; S: number; ecc: Ecc; manifestEvery: number; compression: 'auto' | 'gzip' | 'none' }
  | { type: 'config'; S?: number; ecc?: Ecc; manifestEvery?: number; corruptRate?: number; qr?: boolean }
  | { type: 'frames'; n: number };

export interface SentFrame {
  kind: 'data' | 'manifest';
  symbolId: number;
  size: number;
  modules: Uint8Array;
  /** The (possibly corrupted) frame bytes the code encodes. */
  bytes: Uint8Array;
  corrupted: boolean;
}

export type SendOut =
  | { type: 'progress'; read: number; total: number }
  | { type: 'ready'; session: string; manifest: Manifest; version: number; frameBytes: number; generation: number }
  | { type: 'frames'; frames: SentFrame[]; generation: number }
  | { type: 'error'; message: string };

// ---- decode.worker ----
export type DecodeIn =
  | { type: 'image'; id: number; image: VideoFrame | ImageBitmap; crop?: number }
  | { type: 'matrix'; id: number; size: number; modules: Uint8Array; scale: number; noise: number; blur: boolean };

/** A decode request before the controller assigns its id. */
export type DecodeReq = DecodeIn extends infer T ? (T extends DecodeIn ? Omit<T, 'id'> : never) : never;

export interface DecodeOut {
  type: 'decoded';
  id: number;
  results: Uint8Array[];
  ms: number;
  error?: string;
}

// ---- receive.worker ----
export type RecvIn =
  | { type: 'init'; root: string }
  | { type: 'frame'; bytes: Uint8Array }
  | { type: 'reset' }
  | { type: 'switch'; session: string };

export type RecvOut = { type: 'stats'; stats: ReceiverStats } | { type: 'error'; message: string };
