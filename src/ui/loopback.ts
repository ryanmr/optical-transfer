import { formatBytes, formatDuration } from '../core/bytes';
import type { Manifest } from '../core/frame';
import type { Ecc } from '../core/qr';
import type { SendIn, SendOut, SentFrame } from '../workers/protocol';
import { $, setStats } from './common';
import { RxController } from './rx';

const ui = {
  file: $<HTMLInputElement>('#file'),
  random: $<HTMLButtonElement>('#random'),
  mode: $<HTMLSelectElement>('#mode'),
  S: $<HTMLSelectElement>('#S'),
  ecc: $<HTMLSelectElement>('#ecc'),
  scale: $<HTMLInputElement>('#scale'),
  drop: $<HTMLInputElement>('#drop'),
  corrupt: $<HTMLInputElement>('#corrupt'),
  noise: $<HTMLInputElement>('#noise'),
  blur: $<HTMLSelectElement>('#blur'),
  decoders: $<HTMLInputElement>('#decoders'),
  start: $<HTMLButtonElement>('#start'),
  stop: $<HTMLButtonElement>('#stop'),
  sendStats: $<HTMLElement>('#sendStats'),
  preview: $<HTMLCanvasElement>('#preview'),
};

const rx = new RxController(
  {
    banner: $('#banner'),
    recoveredBar: $('#recoveredBar'),
    uniqueBar: $('#uniqueBar'),
    stats: $('#stats'),
    save: $('#save'),
    reset: $('#reset'),
    switchBtn: $('#switch'),
  },
  'loopback',
  Number(ui.decoders.value),
);

const sender = new Worker(new URL('../workers/send.worker.ts', import.meta.url), { type: 'module' });
const send = (m: SendIn) => sender.postMessage(m);

let file: File | null = null;
let manifest: Manifest | null = null;
let generation = -1;
let queue: SentFrame[] = [];
let requesting = false;
let waiters: (() => void)[] = [];
let running = false;
let startedAt = 0;
/** Set when a run stops, so elapsed time and rate freeze at the final values. */
let stoppedAt = 0;
let sent = 0;
let dropped = 0;
let corrupted = 0;
let lastPreview: SentFrame | null = null;

const opts = () => ({ drop: Number(ui.drop.value) / 100, noise: Number(ui.noise.value), blur: ui.blur.value === '1', scale: Number(ui.scale.value) || 2, qr: ui.mode.value === 'qr' });

function refill() {
  if (requesting || !manifest || queue.length >= 60) return;
  requesting = true;
  send({ type: 'frames', n: 60 });
}

async function nextFrame(): Promise<SentFrame> {
  while (!queue.length) {
    refill();
    await new Promise<void>((r) => waiters.push(r));
  }
  const f = queue.shift()!;
  refill();
  return f;
}

let decoderFree: (() => void) | null = null;
rx.onDecoded = () => {
  decoderFree?.();
  decoderFree = null;
};

let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    await pumpLoop();
  } finally {
    pumping = false;
  }
}

async function pumpLoop() {
  while (running) {
    const st = rx.stats?.status;
    if (st === 'verified' || st === 'failed') {
      stop();
      break;
    }
    const f = await nextFrame();
    if (!running) break;
    const o = opts();
    if (Math.random() < o.drop) {
      dropped++;
      continue;
    }
    sent++;
    if (f.corrupted) corrupted++;
    if (!o.qr) {
      rx.ingestBytes(f.bytes);
      // Cap at ~2000 frames/s so the receive worker's queue doesn't balloon past completion.
      if (sent % 20 === 0) await new Promise((r) => setTimeout(r, 10));
      continue;
    }
    if (sent % 10 === 0) lastPreview = { ...f, modules: f.modules.slice() }; // the original buffer is transferred below
    while (running && !rx.idle) await new Promise<void>((r) => (decoderFree = r));
    rx.submit({ type: 'matrix', size: f.size, modules: f.modules, scale: o.scale, noise: o.noise, blur: o.blur }, [f.modules.buffer as ArrayBuffer]);
  }
}

function start() {
  if (!file || !rx.available) return;
  running = true;
  ui.start.disabled = true;
  ui.stop.disabled = false;
  sent = dropped = corrupted = 0;
  startedAt = performance.now();
  stoppedAt = 0;
  manifest = null;
  queue = [];
  rx.setDecoders(Math.max(1, Math.min(8, Number(ui.decoders.value) || 1)));
  // Fresh receiver state for every run; the reset is queued before any frame reaches the worker.
  rx.resetNow();
  send({ type: 'config', corruptRate: Number(ui.corrupt.value) / 100, qr: opts().qr });
  send({ type: 'load', file, S: Number(ui.S.value), ecc: ui.ecc.value as Ecc, manifestEvery: 20, compression: 'auto' });
}

function stop() {
  if (running) stoppedAt = performance.now();
  running = false;
  ui.start.disabled = !file;
  ui.stop.disabled = true;
  decoderFree?.();
  waiters.forEach((w) => w());
  waiters = [];
}

sender.onmessage = (ev: MessageEvent<SendOut>) => {
  const m = ev.data;
  if (m.type === 'ready') {
    manifest = m.manifest;
    generation = m.generation;
    queue = [];
    requesting = false;
    if (running) pump();
  } else if (m.type === 'frames') {
    requesting = false;
    if (m.generation < generation) return;
    queue.push(...m.frames);
    waiters.forEach((w) => w());
    waiters = [];
  } else if (m.type === 'error') {
    setStats(ui.sendStats, [['Error', m.message]]);
    stop();
  }
};

function drawPreview() {
  const f = lastPreview;
  const c = ui.preview;
  const ctx = c.getContext('2d')!;
  if (!f || !f.size) return;
  const dim = f.size + 8;
  if (c.width !== dim) c.width = c.height = dim;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, dim, dim);
  ctx.fillStyle = '#000';
  for (let y = 0; y < f.size; y++) for (let x = 0; x < f.size; x++) if (f.modules[y * f.size + x]) ctx.fillRect(x + 4, y + 4, 1, 1);
}

setInterval(() => {
  const el = ((stoppedAt || performance.now()) - startedAt) / 1000;
  setStats(ui.sendStats, [
    ['Input', file ? `${file.name} (${formatBytes(file.size)})` : '—'],
    ['Encoded', manifest ? `K = ${manifest.K}, S = ${manifest.S}, ${formatBytes(manifest.compressedSize)}` : '—'],
    ['Frames sent', `${sent} (dropped ${dropped}, corrupted ${corrupted})`],
    ['Elapsed', startedAt ? formatDuration(el) : '—'],
    ['Rate', startedAt && el > 0 ? `${(sent / el).toFixed(1)} frames/s` : '—'],
  ]);
}, 250);
setInterval(drawPreview, 200);

function setFile(f: File) {
  file = f;
  ui.start.disabled = running || !rx.available;
}
ui.file.onchange = () => ui.file.files?.[0] && setFile(ui.file.files[0]);
ui.random.onclick = () => {
  const data = new Uint8Array(1024 * 1024);
  for (let i = 0; i < data.length; i += 65536) crypto.getRandomValues(data.subarray(i, i + 65536));
  setFile(new File([data], 'random-1MB.bin', { type: 'application/octet-stream' }));
};
ui.corrupt.onchange = () => send({ type: 'config', corruptRate: Number(ui.corrupt.value) / 100 });
ui.start.onclick = start;
ui.stop.onclick = stop;
