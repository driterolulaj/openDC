// SPDX-License-Identifier: AGPL-3.0-only
/** Loads the module i18n namespaces (modules/<id>/i18n/{en,de}.json) shipped next to the code. */
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function moduleResources(): Promise<Record<'en' | 'de', Record<string, unknown>>> {
  // modules/ is resolved through the workspace package so the same lookup works from source and from dist.
  // from source: modules/generated/types.ts; installed: modules/dist/generated/types.js (i18n stays outside dist)
  let pkgDir = join(fileURLToPath(import.meta.resolve('@opendc/modules/generated/types')), '..', '..');
  if (basename(pkgDir) === 'dist') pkgDir = dirname(pkgDir);
  const out: Record<'en' | 'de', Record<string, unknown>> = { en: {}, de: {} };
  const dirs = await readdir(pkgDir, { withFileTypes: true }).catch(() => []);
  for (const d of dirs) {
    if (!d.isDirectory() || d.name === 'generated' || d.name === 'dist' || d.name === 'node_modules') continue;
    for (const lang of ['en', 'de'] as const) {
      try {
        out[lang][d.name] = JSON.parse(await readFile(join(pkgDir, d.name, 'i18n', `${lang}.json`), 'utf8')) as unknown;
      } catch {
        // module without its own namespace file
      }
    }
  }
  return out;
}
