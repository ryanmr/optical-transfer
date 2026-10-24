import { Compression } from '../core/frame';

export function $<T extends HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
}

export function applyTheme(t: 'dark' | 'light') {
  document.documentElement.dataset.theme = t;
}

export function compressionName(c: number): string {
  return c === Compression.Gzip ? 'gzip' : c === Compression.Zstd ? 'zstd' : 'none';
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function setStats(el: HTMLElement, rows: [string, string][]) {
  el.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}

/**
 * Camera and OPFS only exist in a secure context (https:// or localhost). Returns a message for
 * the user when we're not in one, or null when everything is available.
 */
export function insecureContextMessage(): { text: string; href: string | null } | null {
  if (window.isSecureContext && typeof navigator.storage?.getDirectory === 'function') return null;
  // The Docker setup serves HTTPS on the port after the HTTP one.
  const href =
    location.protocol === 'http:' && location.port
      ? `https://${location.hostname}:${Number(location.port) + 1}${location.pathname}`
      : null;
  return {
    text: 'This page needs a secure context (HTTPS or localhost): browsers hide the camera and private storage on plain http:// addresses.',
    href,
  };
}
