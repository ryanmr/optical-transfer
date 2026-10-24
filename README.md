# Optical Transfer

Send a file from one computer to another using only a screen and a camera. There is no network, cable or radio link. The sender loops an endless fountain-coded stream of QR codes. The receiver keeps decoding until it has enough symbols, then rebuilds the file, checks it with BLAKE3 and saves it.

**Try it:** https://ryanmr.github.io/optical-transfer/. Open **Send** on one machine and **Receive** on the other (a phone works), then point the camera at the screen. Once the page has loaded, the transfer itself needs no connection. You can turn Wi-Fi off and it still works.

## Made by robots

Every line of code and documentation in this repository was written by AI (Claude, using [Claude Code](https://claude.com/claude-code)). A human directed it and tested it. Read it with that in mind. The round-trip and loopback tests are the main reason to trust the output.

## Running it yourself

```
npm install
npm run dev      # http://localhost:5173/  →  /send/, /receive/, /loopback/
npm test         # unit + in-memory end-to-end tests
npm run build    # typecheck + static build in dist/ (set BASE_PATH to serve from a subpath)
```

Requires Node 24 or later. The camera and OPFS both need a secure context, meaning `localhost` or HTTPS. Each machine runs its own copy, either `npm run dev` or `npm run preview` on the built `dist/`, or uses the GitHub Pages site. The zxing WASM is bundled locally, so the app never touches the network at runtime.

The build is plain static files, so any HTTPS host works. Every push to `main` deploys to GitHub Pages through `.github/workflows/pages.yml`, after the tests pass.

## Docker

The app is served by Hono (`@hono/node-server`) on Node 24, which runs `server/index.ts` directly using Node's built-in type stripping.

```
docker compose up -d --build     # http://localhost:14471  (PORT=<other> docker compose up -d to change the host port)
docker compose logs -f
docker compose down
```

The image build runs `npm test` and `npm run build`. The runtime image contains only `dist/`, `server/` and the two Hono packages, runs as the `node` user with a read-only filesystem, and has a `/healthz` healthcheck. Hashed `/assets/*` files are served with immutable caching and gzip (the zxing WASM drops from 950 KB to 416 KB).

Two ports:

- **14471, HTTP.** Use it on the host itself (`localhost` counts as secure). It also serves the send page to any device, since sending needs no camera or storage.
- **14472, HTTPS.** Use it from any other device. The camera and OPFS (the browser's private storage) only work in a secure context, and over plain `http://<ip>` the receive and loopback pages say so and link here. By default this port uses a self-signed certificate. It is generated on first start with names from `TLS_SANS` in `.env` (copy `.env.example`), and kept in the `certs` volume, so browsers warn only once per device. For a certificate with no warning, set `TLS_CERT_FILE`/`TLS_KEY_FILE` (see `compose.yaml`), or use `tailscale serve`.

## Pages

- **/send/**: pick a file, then press Start (or Space). Esc toggles the settings. You can set the symbol size S, QR ECC level, hold (display refreshes per code), code size, manifest interval, theme and compression.
- **/receive/**: start the camera and aim it at the sender. The page shows live stats and a verified/failed banner, then offers Save (`showSaveFilePicker`, or a download fallback). Progress lives in OPFS, so closing and reopening the tab resumes the transfer. If another session is detected it offers a **Switch** button.
- **/loopback/**: sender and receiver in one page, with no camera. Codes are rendered to an OffscreenCanvas inside the decoder worker and read back with zxing. You can simulate frame drops, byte corruption (which the CRC catches), pixel noise and blur. A "bytes only" mode skips the QR step.

## How it works

```
SEND   File ─stream→ BLAKE3 + gzip (kept only if ≥2% smaller) → K blocks of S bytes
            → LT encoder (endless symbols) → frame (header + symbol + CRC32) → QR (byte mode)
            → <canvas>, each code held for N refreshes, manifest every 20 frames
RECV   getUserMedia → requestVideoFrameCallback → VideoFrame → decoder worker pool (zxing-wasm)
            → receive worker: CRC/magic/session check → dedupe → LT decoder
            → OPFS (sync access handles) → gunzip → BLAKE3 verify → save
```

| Path | What |
|---|---|
| `src/core/frame.ts` | Wire format v1 (data and manifest frames, little-endian, CRC32) |
| `src/core/lt.ts` | LT fountain code: robust soliton, peeling decoder, plus Gauss–Jordan fallback when peeling stalls |
| `src/core/fountain.ts` | Encoder/decoder interface, so RaptorQ or Wirehair can replace LT |
| `src/core/receiver.ts` | Receiver state machine: session lock-on, pre-manifest buffering, persistence, resume, finalize and verify |
| `src/core/storage.ts`, `opfs.ts` | Sync-file storage abstraction (OPFS in the worker, in-memory in tests) |
| `src/workers/*` | `send` (compress/encode/QR), `decode` (zxing), `receive` (Receiver on OPFS) |
| `src/ui/*` | Pages. The main thread only renders and moves messages between workers |

OPFS layout per session: `sessions/<id>/{manifest.bin, blocks.bin, bitmap.bin, symbols.log, output.bin, state.json}`. Recovered blocks are written to `blocks.bin` at `index × S`. `symbols.log` holds every unique symbol received, so a reload rebuilds the decoder's partly solved state as well as the blocks it already has.

## Design notes and deviations from the plan

- **The LT code is not systematic.** A systematic variant only wins at zero loss. Once some source blocks are missing, most low-degree repair symbols turn out to be redundant: at 30% loss the systematic variant needed about 1.34×K symbols versus about 1.02×K for the non-systematic one. Measured overhead with peeling plus the GE fallback is about 1.01–1.07×K for K between 1k and 85k, whatever the loss rate or join point.
- **The native `BarcodeDetector` is not used.** It returns `rawValue` as a *string*, which loses arbitrary binary bytes, and on Linux/Windows desktop Chrome it isn't available at all. zxing-wasm returns the raw byte-mode payload.
- The QR version is pinned to the one a data frame needs, so manifests and data codes are the same size on screen and the camera doesn't have to refocus.
- The dark theme draws light modules at #d8d8d8 rather than pure white, to reduce bloom.

## Tuning tips

- Start with S=600 and ECC L (QR version 17). Use a larger S only when the camera resolves the code comfortably. Watch "Codes decoded/s" against the sender's codes/s.
- If the receiver shows many CRC failures (torn or blended frames), increase **hold**.
- Fill the camera frame with the code. On a busy image, use "Scan region: center" to cut decode time.

## License

MIT. See [LICENSE](LICENSE).
