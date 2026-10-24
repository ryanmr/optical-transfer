/// <reference lib="webworker" />
import { prepareZXingModule, readBarcodes, type ReaderOptions } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import type { DecodeIn, DecodeOut } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

// Serve the WASM from our own origin; the library default is a CDN, which breaks offline use.
prepareZXingModule({
  overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
});

// Note on BarcodeDetector: Chrome's native detector only exposes `rawValue` as a *string*, so the
// binary frames (arbitrary bytes, incl. invalid UTF-8) can't be recovered from it reliably. zxing
// gives us the raw byte-mode payload.
const opts: ReaderOptions = {
  formats: ['QRCode'],
  maxNumberOfSymbols: 1,
  tryHarder: true,
  tryInvert: false,
  tryRotate: true,
};

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

function surface(w: number, h: number): OffscreenCanvasRenderingContext2D {
  if (!canvas || canvas.width !== w || canvas.height !== h) {
    canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  }
  return ctx!;
}

function imageFromFrame(img: VideoFrame | ImageBitmap, crop = 1): ImageData {
  const w = 'displayWidth' in img ? img.displayWidth : img.width;
  const h = 'displayHeight' in img ? img.displayHeight : img.height;
  const cw = Math.round(w * crop);
  const ch = Math.round(h * crop);
  const c = surface(cw, ch);
  c.drawImage(img, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, cw, ch);
  img.close();
  return c.getImageData(0, 0, cw, ch);
}

/** Loopback: render the module matrix to an offscreen canvas (optionally degraded) and read it back. */
function imageFromMatrix(size: number, modules: Uint8Array, scale: number, noise: number, blur: boolean): ImageData {
  const quiet = 4;
  const dim = (size + quiet * 2) * scale;
  const c = surface(dim, dim);
  c.filter = 'none';
  c.fillStyle = '#fff';
  c.fillRect(0, 0, dim, dim);
  c.fillStyle = '#000';
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) if (modules[y * size + x]) c.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
  if (blur) {
    c.filter = `blur(${Math.max(0.5, scale / 4)}px)`;
    c.drawImage(canvas!, 0, 0);
    c.filter = 'none';
  }
  const img = c.getImageData(0, 0, dim, dim);
  if (noise > 0) {
    const d = img.data;
    const amp = noise * 255;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] + (Math.random() * 2 - 1) * amp;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  return img;
}

self.onmessage = async (ev: MessageEvent<DecodeIn>) => {
  const msg = ev.data;
  const t0 = performance.now();
  const out: DecodeOut = { type: 'decoded', id: msg.id, results: [], ms: 0 };
  try {
    const img =
      msg.type === 'image'
        ? imageFromFrame(msg.image, msg.crop)
        : imageFromMatrix(msg.size, msg.modules, msg.scale, msg.noise, msg.blur);
    const res = await readBarcodes(img, opts);
    for (const r of res) if (r.isValid && r.bytes.length) out.results.push(r.bytes.slice());
  } catch (e) {
    out.error = (e as Error).message ?? String(e);
  }
  out.ms = performance.now() - t0;
  self.postMessage(out, out.results.map((b) => b.buffer as ArrayBuffer));
};
