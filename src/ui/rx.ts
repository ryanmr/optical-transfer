import { formatBytes, formatDuration } from '../core/bytes';
import { opfsFile } from '../core/opfs';
import type { ReceiverStats } from '../core/receiver';
import type { DecodeIn, DecodeOut, DecodeReq, RecvIn, RecvOut } from '../workers/protocol';
import { compressionName, insecureContextMessage, setStats } from './common';

export interface RxElements {
  banner: HTMLElement;
  recoveredBar: HTMLElement;
  uniqueBar: HTMLElement;
  stats: HTMLElement;
  save: HTMLButtonElement;
  reset: HTMLButtonElement;
  switchBtn: HTMLButtonElement;
}

/** Owns the decode worker pool + the receive worker and renders receiver stats. Shared by /receive and /loopback. */
export class RxController {
  private recv: Worker;
  private pool: { w: Worker; busy: boolean }[] = [];
  private nextId = 0;
  stats: ReceiverStats | null = null;
  private attempts: number[] = [];
  private hits: number[] = [];
  private decodeMs = 0;
  private uniqueHistory: [number, number][] = [];
  onStats: ((s: ReceiverStats) => void) | null = null;
  onDecoded: ((id: number, count: number) => void) | null = null;

  /** False when the page isn't a secure context; nothing else works then. */
  readonly available: boolean;

  constructor(private readonly el: RxElements, root: string, decoders: number) {
    const insecure = insecureContextMessage();
    this.available = !insecure;
    if (insecure) {
      this.showBanner('bad', 'HTTPS required', insecure.text);
      if (insecure.href) {
        const a = document.createElement('a');
        a.href = insecure.href;
        a.textContent = `Open ${insecure.href}`;
        a.style.display = 'block';
        a.style.marginTop = '6px';
        el.banner.append(a);
      }
      el.reset.disabled = true;
      this.recv = null as unknown as Worker;
      return;
    }
    this.recv = new Worker(new URL('../workers/receive.worker.ts', import.meta.url), { type: 'module' });
    this.recv.onmessage = (ev: MessageEvent<RecvOut>) => {
      if (ev.data.type === 'stats') {
        this.stats = ev.data.stats;
        const now = performance.now();
        this.uniqueHistory.push([now, this.stats.unique]);
        while (this.uniqueHistory.length > 2 && now - this.uniqueHistory[0][0] > 5000) this.uniqueHistory.shift();
        this.onStats?.(this.stats);
      } else {
        this.showBanner('bad', 'Receiver error', ev.data.message);
      }
    };
    this.postRecv({ type: 'init', root });
    this.setDecoders(decoders);
    el.save.onclick = () => this.export();
    el.reset.onclick = () => {
      if (confirm('Discard the current transfer and all stored data?')) this.postRecv({ type: 'reset' });
    };
    el.switchBtn.onclick = () => {
      const f = this.stats?.foreign;
      if (f) this.postRecv({ type: 'switch', session: f.session });
    };
    setInterval(() => this.render(), 250);
  }

  setDecoders(n: number) {
    if (!this.available) return;
    while (this.pool.length > n) this.pool.pop()!.w.terminate();
    while (this.pool.length < n) {
      const w = new Worker(new URL('../workers/decode.worker.ts', import.meta.url), { type: 'module' });
      const slot = { w, busy: false };
      w.onmessage = (ev: MessageEvent<DecodeOut>) => this.onDecodedMsg(slot, ev.data);
      this.pool.push(slot);
    }
  }

  /** Discard receiver state without asking. */
  resetNow() {
    this.postRecv({ type: 'reset' });
  }

  private postRecv(m: RecvIn, transfer: Transferable[] = []) {
    this.recv.postMessage(m, transfer);
  }

  /** True if a decoder is free (callers should drop the frame otherwise). */
  get idle(): boolean {
    return this.pool.some((p) => !p.busy);
  }

  submit(msg: DecodeReq, transfer: Transferable[]): number | null {
    const slot = this.pool.find((p) => !p.busy);
    if (!slot) return null;
    slot.busy = true;
    const id = this.nextId++;
    slot.w.postMessage({ ...msg, id } as DecodeIn, transfer);
    return id;
  }

  /** Bypass QR (loopback "bytes only" mode). */
  ingestBytes(bytes: Uint8Array) {
    this.postRecv({ type: 'frame', bytes }, [bytes.buffer as ArrayBuffer]);
  }

  private onDecodedMsg(slot: { busy: boolean }, m: DecodeOut) {
    slot.busy = false;
    const now = performance.now();
    this.attempts.push(now);
    if (m.results.length) this.hits.push(now);
    this.decodeMs = this.decodeMs ? this.decodeMs * 0.9 + m.ms * 0.1 : m.ms;
    for (const bytes of m.results) this.postRecv({ type: 'frame', bytes }, [bytes.buffer as ArrayBuffer]);
    this.onDecoded?.(m.id, m.results.length);
  }

  private rate(times: number[]): number {
    const now = performance.now();
    while (times.length && now - times[0] > 2000) times.shift();
    return times.length / 2;
  }

  uniqueRate(): number {
    const h = this.uniqueHistory;
    if (h.length < 2) return 0;
    const [t0, u0] = h[0];
    const [t1, u1] = h[h.length - 1];
    return t1 > t0 ? ((u1 - u0) * 1000) / (t1 - t0) : 0;
  }

  private showBanner(kind: 'ok' | 'bad' | 'info', title: string, detail = '') {
    this.el.banner.className = `banner ${kind}`;
    this.el.banner.innerHTML = '';
    this.el.banner.append(title);
    if (detail) {
      const d = document.createElement('div');
      d.className = 'detail';
      d.textContent = detail;
      this.el.banner.append(d);
    }
  }

  render() {
    const s = this.stats;
    const el = this.el;
    const scanned = this.rate(this.attempts);
    const decoded = this.rate(this.hits);
    if (!s) return;
    const m = s.manifest;
    const K = m?.K ?? 0;
    const badFrames = s.errors.crc + s.errors.length + s.errors.magic + s.errors.version + s.errors.type + s.errors.short;
    const urate = this.uniqueRate();
    const need = K ? Math.max(0, Math.ceil(K * 1.05) - s.unique) : 0;

    switch (s.status) {
      case 'idle':
        this.showBanner('info', 'Waiting for a manifest frame…', s.buffered ? `${s.buffered} data frames buffered` : 'Point the camera at the sender screen.');
        break;
      case 'receiving': {
        const pct = Math.min(99, Math.floor((s.unique / (K * 1.05)) * 100));
        const eta = urate > 0 ? ` · about ${formatDuration(need / urate)} left` : s.unique ? ' · waiting for codes…' : '';
        this.showBanner('info', `Receiving “${m!.fileName}”${s.resumed ? ' (resumed)' : ''} — ${pct}%${eta}`);
        break;
      }
      case 'finalizing':
        this.showBanner('info', 'All blocks recovered — decompressing and verifying…');
        break;
      case 'verified':
        this.showBanner('ok', `Verified ✓ “${m!.fileName}” — BLAKE3 match`, s.computedHash ?? '');
        break;
      case 'failed':
        this.showBanner('bad', 'Verification failed — raw data kept in OPFS for debugging', s.error ?? '');
        break;
    }
    el.save.classList.toggle('hidden', s.status !== 'verified' && s.status !== 'failed');
    el.save.textContent = s.status === 'failed' ? 'Save raw output anyway' : 'Save file…';
    el.switchBtn.classList.toggle('hidden', !s.foreign);
    if (s.foreign) el.switchBtn.textContent = `Switch to “${s.foreign.fileName}”`;
    const done = s.status === 'verified';
    (el.recoveredBar.firstElementChild as HTMLElement).style.width = `${K ? (done ? 100 : (s.recovered / K) * 100) : 0}%`;
    (el.uniqueBar.firstElementChild as HTMLElement).style.width = `${K ? (done ? 100 : Math.min(100, (s.unique / (K * 1.05)) * 100)) : 0}%`;

    setStats(el.stats, [
      ['File', m ? `${m.fileName} · ${formatBytes(m.originalSize)} (${compressionName(m.compression)} ${formatBytes(m.compressedSize)})` : '—'],
      ['Blocks', m ? `K = ${K}, S = ${m.S} B` : '—'],
      ['Recovered', K ? `${s.recovered} / ${K} blocks (${((s.recovered / K) * 100).toFixed(1)}%)` : '—'],
      ['Unique symbols', K ? `${s.unique} / ${K} (${(s.unique / K).toFixed(3)}×K)` : String(s.unique)],
      ['ETA', s.status === 'receiving' && urate > 0 ? `${formatDuration(need / urate)} (≈K×1.05)` : '—'],
      ['Frames scanned/s', scanned.toFixed(1)],
      ['Codes decoded/s', decoded.toFixed(1)],
      ['New symbols/s', urate.toFixed(1) + (m ? ` · ${formatBytes(Math.round(urate * m.S))}/s` : '')],
      ['Decode time', `${this.decodeMs.toFixed(1)} ms`],
      ['CRC/format failures', `${badFrames} of ${s.framesIn} (${s.framesIn ? ((badFrames / s.framesIn) * 100).toFixed(1) : '0.0'}%)`],
      ['Duplicates', String(s.duplicates)],
      ['Manifests seen', String(s.manifestFrames)],
      ['Session', s.session ?? '—'],
      ['Other sessions', s.foreignFrames ? `${s.foreignFrames} frames ignored` : '—'],
    ]);
  }

  async export() {
    const s = this.stats;
    if (!s?.outputPath || !s.manifest) return;
    const file = await opfsFile(s.outputPath);
    const name = s.manifest.fileName || 'received.bin';
    if ('showSaveFilePicker' in window) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: name });
        const writable = await handle.createWritable();
        await file.stream().pipeTo(writable);
        return;
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return;
        console.warn('showSaveFilePicker failed, falling back to download', e);
      }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
