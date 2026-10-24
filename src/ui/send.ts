import { formatBytes, formatDuration } from '../core/bytes';
import type { Manifest } from '../core/frame';
import type { Ecc } from '../core/qr';
import type { SendIn, SendOut, SentFrame } from '../workers/protocol';
import { $, applyTheme, compressionName, setStats } from './common';

const worker = new Worker(new URL('../workers/send.worker.ts', import.meta.url), { type: 'module' });
const send = (m: SendIn) => worker.postMessage(m);

const stage = $<HTMLCanvasElement>('#stage');
const ctx = stage.getContext('2d', { alpha: false })!;
const code = document.createElement('canvas');
const codeCtx = code.getContext('2d')!;

const ui = {
  file: $<HTMLInputElement>('#file'),
  S: $<HTMLSelectElement>('#S'),
  ecc: $<HTMLSelectElement>('#ecc'),
  hold: $<HTMLInputElement>('#hold'),
  codeSize: $<HTMLInputElement>('#codeSize'),
  manifestEvery: $<HTMLInputElement>('#manifestEvery'),
  theme: $<HTMLSelectElement>('#theme'),
  compression: $<HTMLSelectElement>('#compression'),
  start: $<HTMLButtonElement>('#start'),
  stop: $<HTMLButtonElement>('#stop'),
  info: $<HTMLElement>('#info'),
  status: $<HTMLElement>('#status'),
  controls: $<HTMLElement>('#controls'),
  toggle: $<HTMLButtonElement>('#toggle'),
};

let manifest: Manifest | null = null;
let session = '';
let qrVersion = 0;
let generation = -1;
let queue: SentFrame[] = [];
let requesting = false;
let running = false;
let current: SentFrame | null = null;
let refreshes = 0;
let shown = 0;
let dataShown = 0;
let underruns = 0;
let startedAt = 0;
const shownTimes: number[] = [];

function theme() {
  return ui.theme.value as 'dark' | 'light';
}

function colors() {
  // Dark theme dims the light modules a little to reduce bloom/moiré on the camera side.
  return theme() === 'dark' ? { page: '#0e0e0f', light: [216, 216, 216], dark: [0, 0, 0] } : { page: '#f4f4f2', light: [255, 255, 255], dark: [0, 0, 0] };
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  stage.width = Math.round(window.innerWidth * dpr);
  stage.height = Math.round(window.innerHeight * dpr);
  draw();
}

const QUIET = 4;

function draw() {
  const c = colors();
  ctx.fillStyle = c.page;
  ctx.fillRect(0, 0, stage.width, stage.height);
  const f = current;
  if (!f) return;
  const dim = f.size + QUIET * 2;
  if (code.width !== dim) code.width = code.height = dim;
  const img = codeCtx.createImageData(dim, dim);
  const d = img.data;
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      const mx = x - QUIET;
      const my = y - QUIET;
      const on = mx >= 0 && my >= 0 && mx < f.size && my < f.size && f.modules[my * f.size + mx] === 1;
      const col = on ? c.dark : c.light;
      const o = (y * dim + x) * 4;
      d[o] = col[0];
      d[o + 1] = col[1];
      d[o + 2] = col[2];
      d[o + 3] = 255;
    }
  }
  codeCtx.putImageData(img, 0, 0);
  // Integer device pixels per module keeps every module edge crisp.
  const dpr = window.devicePixelRatio || 1;
  const wanted = Number(ui.codeSize.value) > 0 ? Number(ui.codeSize.value) * dpr : Math.min(stage.width, stage.height) * 0.96;
  const px = Math.max(1, Math.floor(wanted / dim));
  const side = px * dim;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(code, 0, 0, dim, dim, Math.floor((stage.width - side) / 2), Math.floor((stage.height - side) / 2), side, side);
}

function refill() {
  if (requesting || !manifest || queue.length >= 30) return;
  requesting = true;
  send({ type: 'frames', n: 30 });
}

function tick() {
  if (!running) return;
  requestAnimationFrame(tick);
  const hold = Math.max(1, Number(ui.hold.value) || 1);
  if (refreshes++ % hold !== 0) return;
  const next = queue.shift();
  refill();
  if (!next) {
    underruns++;
    return;
  }
  current = next;
  shown++;
  if (next.kind === 'data') dataShown++;
  const now = performance.now();
  shownTimes.push(now);
  while (shownTimes.length && now - shownTimes[0] > 2000) shownTimes.shift();
  draw();
}

function startStop(on: boolean) {
  if (on === running || !manifest) return;
  running = on;
  ui.start.disabled = on;
  ui.stop.disabled = !on;
  if (on) {
    startedAt = performance.now();
    refreshes = 0;
    ui.controls.classList.add('hidden');
    refill();
    requestAnimationFrame(tick);
  } else {
    current = null;
    draw();
  }
}

function renderInfo() {
  if (!manifest) return setStats(ui.info, []);
  setStats(ui.info, [
    ['File', manifest.fileName],
    ['Size', `${formatBytes(manifest.originalSize)} → ${formatBytes(manifest.compressedSize)} (${compressionName(manifest.compression)})`],
    ['Blocks', `K = ${manifest.K} × S = ${manifest.S} B`],
    ['QR', `version ${qrVersion} (${17 + 4 * qrVersion}² modules)`],
    ['Session', session],
  ]);
}

function renderStatus() {
  const rate = shownTimes.length > 1 ? ((shownTimes.length - 1) * 1000) / (shownTimes[shownTimes.length - 1] - shownTimes[0]) : 0;
  const target = manifest ? Math.ceil(manifest.K * 1.1) : 0;
  const dataRate = rate * (1 - 1 / Math.max(2, Number(ui.manifestEvery.value)));
  const parts: [string, string][] = [
    ['state', running ? 'sending' : manifest ? 'stopped' : 'no file'],
    ['frames', String(shown)],
    ['codes/s', rate.toFixed(1)],
    ['throughput', manifest ? `${formatBytes(Math.round(dataRate * manifest.S))}/s` : '—'],
    ['symbols', manifest ? `${dataShown} / ${target} (K×1.1) · ${Math.min(100, (dataShown / target) * 100).toFixed(0)}%` : '—'],
    ['ETA (K×1.1)', manifest && running && dataRate > 0 ? formatDuration(Math.max(0, target - dataShown) / dataRate) : '—'],
    ['elapsed', running ? formatDuration((performance.now() - startedAt) / 1000) : '—'],
    ['underruns', String(underruns)],
  ];
  ui.status.innerHTML = parts.map(([k, v]) => `<span>${k} <b class="mono">${v}</b></span>`).join('');
}

worker.onmessage = (ev: MessageEvent<SendOut>) => {
  const m = ev.data;
  switch (m.type) {
    case 'progress':
      setStats(ui.info, [['Reading', `${formatBytes(m.read)} / ${formatBytes(m.total)}`]]);
      break;
    case 'ready': {
      const newSession = m.session !== session;
      manifest = m.manifest;
      session = m.session;
      qrVersion = m.version;
      generation = m.generation;
      queue = [];
      requesting = false; // any in-flight batch is from the old generation and will be dropped
      if (newSession) {
        shown = dataShown = underruns = 0;
      }
      ui.start.disabled = running;
      renderInfo();
      refill();
      break;
    }
    case 'frames':
      requesting = false;
      if (m.generation < generation) break;
      generation = m.generation;
      queue.push(...m.frames);
      refill();
      break;
    case 'error':
      setStats(ui.info, [['Error', m.message]]);
      break;
  }
};

ui.file.onchange = () => {
  const file = ui.file.files?.[0];
  if (!file) return;
  startStop(false);
  manifest = null;
  ui.start.disabled = true;
  generation = -1;
  send({
    type: 'load',
    file,
    S: Number(ui.S.value),
    ecc: ui.ecc.value as Ecc,
    manifestEvery: Number(ui.manifestEvery.value),
    compression: ui.compression.value as 'auto' | 'gzip' | 'none',
  });
};
ui.S.onchange = () => send({ type: 'config', S: Number(ui.S.value) });
ui.ecc.onchange = () => send({ type: 'config', ecc: ui.ecc.value as Ecc });
ui.manifestEvery.onchange = () => send({ type: 'config', manifestEvery: Number(ui.manifestEvery.value) });
ui.compression.onchange = () => ui.file.dispatchEvent(new Event('change'));
ui.theme.onchange = () => {
  applyTheme(theme());
  draw();
};
ui.codeSize.oninput = draw;
ui.start.onclick = () => startStop(true);
ui.stop.onclick = () => startStop(false);
ui.toggle.onclick = () => ui.controls.classList.toggle('hidden');
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === ' ') {
    e.preventDefault();
    startStop(!running);
  } else if (e.key === 'Escape') ui.controls.classList.toggle('hidden');
});
window.addEventListener('resize', resize);
setInterval(renderStatus, 250);
applyTheme(theme());
resize();
renderStatus();
