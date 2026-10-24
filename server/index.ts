import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { logger } from 'hono/logger';
import { generate } from 'selfsigned';

// Serves the Vite build (dist/) over HTTP on PORT and HTTPS on HTTPS_PORT. Camera + OPFS only work
// in a secure context (https:// or localhost), so other devices must use the HTTPS port.
// HTTPS uses TLS_CERT_FILE / TLS_KEY_FILE if set, otherwise a self-signed certificate that is
// generated once and kept in CERT_DIR (browsers will warn once; after "Proceed" the page counts as
// a secure context).

const port = Number(process.env.PORT ?? 14471);
const httpsPort = Number(process.env.HTTPS_PORT ?? 14472);
const root = process.env.STATIC_ROOT ?? './dist';
const certDir = process.env.CERT_DIR ?? './certs';

const app = new Hono();

app.use(logger());
app.use(compress());
app.use(async (c, next) => {
  await next();
  c.header('Permissions-Policy', 'camera=(self)');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  // Hashed build output never changes; pages must always be revalidated.
  const path = c.req.path;
  c.header('Cache-Control', path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
});

app.get('/healthz', (c) => c.json({ ok: true }));

// /send -> /send/ so relative page URLs and serveStatic's index lookup work.
for (const page of ['send', 'receive', 'loopback']) app.get(`/${page}`, (c) => c.redirect(`/${page}/`, 301));

app.use('/*', serveStatic({ root }));
app.notFound((c) => c.text('Not found', 404));

async function loadTls(): Promise<{ cert: string; key: string }> {
  const { TLS_CERT_FILE, TLS_KEY_FILE } = process.env;
  if (TLS_CERT_FILE && TLS_KEY_FILE) return { cert: readFileSync(TLS_CERT_FILE, 'utf8'), key: readFileSync(TLS_KEY_FILE, 'utf8') };
  const certPath = join(certDir, 'selfsigned-cert.pem');
  const keyPath = join(certDir, 'selfsigned-key.pem');
  if (existsSync(certPath) && existsSync(keyPath)) return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') };
  // TLS_SANS: extra host names / IPs the cert should name, comma separated.
  const names = ['localhost', '127.0.0.1', '::1', ...(process.env.TLS_SANS ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
  const pems = await generate([{ name: 'commonName', value: 'optical-transfer' }], {
    keyType: 'ec',
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 825 * 24 * 3600 * 1000),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: names.map((n) => (isIP(n) ? { type: 7 as const, ip: n } : { type: 2 as const, value: n })) },
    ],
  });
  mkdirSync(certDir, { recursive: true });
  writeFileSync(certPath, pems.cert);
  writeFileSync(keyPath, pems.private, { mode: 0o600 });
  console.log(`generated self-signed certificate for ${names.join(', ')} (sha1 ${pems.fingerprint})`);
  return { cert: pems.cert, key: pems.private };
}

const servers = [
  serve({ fetch: app.fetch, port }, (info) => console.log(`optical-transfer listening on http://0.0.0.0:${info.port}`)),
  serve({ fetch: app.fetch, port: httpsPort, createServer: createHttpsServer, serverOptions: await loadTls() }, (info) =>
    console.log(`optical-transfer listening on https://0.0.0.0:${info.port}`),
  ),
];

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    let open = servers.length;
    for (const s of servers) s.close(() => --open === 0 && process.exit(0));
  });
