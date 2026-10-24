import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // GitHub Pages serves from /<repo>/; everywhere else the app lives at the root.
  base: process.env.BASE_PATH ?? '/',
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        send: resolve(import.meta.dirname, 'send/index.html'),
        receive: resolve(import.meta.dirname, 'receive/index.html'),
        loopback: resolve(import.meta.dirname, 'loopback/index.html'),
      },
    },
  },
  worker: { format: 'es' },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
