// SPDX-License-Identifier: AGPL-3.0-only
/** `npm run openapi` writes packages/api/openapi.json from the route table; `--check` fails if it is stale. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '@opendc/shared/db';
import { PlatformError } from '@opendc/shared';
import { apiMigrations } from '../db.ts';
import { buildApi } from '../server.ts';
import { buildOpenApi } from '../http/openapi.ts';

const out = resolve(import.meta.dirname, '../../openapi.json');
const api = await buildApi({
  db: openDb(':memory:', apiMigrations),
  directory: { authenticate: () => Promise.reject(new PlatformError('internal', { requestId: 'openapi' })) },
  agent: null,
  nodeId: 'openapi',
  csrfKey: Buffer.alloc(32),
  idleMinutes: 30,
  absoluteHours: 12,
  webDir: null,
  validateResponses: false,
});
const doc = JSON.stringify(buildOpenApi(api.routes.routes), null, 2) + '\n';
await api.app.close();

if (process.argv.includes('--check')) {
  if (!existsSync(out) || readFileSync(out, 'utf8') !== doc) {
    console.error('packages/api/openapi.json is stale; run npm run openapi and review the API diff.');
    process.exit(1);
  }
  console.log('openapi.json is up to date');
} else {
  writeFileSync(out, doc);
  console.log(`wrote ${out}`);
}
