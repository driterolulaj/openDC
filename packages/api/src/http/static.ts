// SPDX-License-Identifier: AGPL-3.0-only
/** Serves the built console (packages/web/dist) with an SPA fallback. Small enough not to need a plugin. */
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export interface StaticFile {
  body: Buffer;
  type: string;
  cache: string;
}

export class StaticSite {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  /** `rel` is the path below the mount point. Unknown non-asset paths fall back to index.html. */
  async get(rel: string): Promise<StaticFile | null> {
    const clean = normalize(decodeURIComponent(rel)).replace(/^([/\\])+/, '');
    const abs = resolve(join(this.#root, clean));
    if (abs !== this.#root && !abs.startsWith(this.#root + sep)) return null;
    const file = await this.#read(abs);
    if (file) return file;
    // SPA routes (no extension) get the app shell; missing assets are a real 404.
    return extname(clean) ? null : this.#read(join(this.#root, 'index.html'));
  }

  async #read(abs: string): Promise<StaticFile | null> {
    const st = await stat(abs).catch(() => null);
    if (!st?.isFile()) return null;
    const ext = extname(abs).toLowerCase();
    const immutable = abs.includes(`${sep}assets${sep}`);
    return {
      body: await readFile(abs),
      type: TYPES[ext] ?? 'application/octet-stream',
      cache: immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
  }
}
