#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * opendc-api entry point. Configuration comes from the Config Registry layers (read-only here), secrets
 * from systemd credentials (LoadCredential=): tls-cert, tls-key, ldap-ca, api-hmac.
 *
 * Development: OPENDC_DEV=1 serves plain HTTP on 127.0.0.1 and reads OPENDC_LDAP_URLS / OPENDC_LDAP_CA /
 * OPENDC_AGENT_SOCKET / OPENDC_STATE_DIR / OPENDC_WEB_DIR from the environment.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformVersion } from '@opendc/shared';
import { AgentClient } from '@opendc/shared/agent';
import { openDb } from '@opendc/shared/db';
import { Registry, parseLayer } from '@opendc/registry';
import { registryKeys } from '@opendc/modules/generated/registry';
import { detectFacts } from '@opendc/os';
import { apiMigrations } from './db.ts';
import { DirectoryAuth } from './directory.ts';
import { buildApi } from './server.ts';

const dev = process.env.OPENDC_DEV === '1';

function credential(name: string): Buffer | null {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  if (!dir) return null;
  try {
    return readFileSync(join(dir, name));
  } catch {
    return null;
  }
}

function readOptional(path: string | undefined): string | null {
  if (!path) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const facts = dev ? null : await detectFacts();
  const layerPath = (k: string): string | undefined => facts?.paths.managedFile(k);
  const registry = new Registry(registryKeys)
    .withLayer('local', parseLayer('core.registry-local', readOptional(layerPath('opendc.registry.local'))))
    .withLayer('forced', parseLayer('core.registry-forced', readOptional(layerPath('opendc.registry.forced'))));

  const stateDir = process.env.OPENDC_STATE_DIR ?? (facts ? join(facts.paths.state, 'api') : resolve('.opendc-dev'));
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const db = openDb(join(stateDir, 'platform.db'), apiMigrations);

  const agentSocket = process.env.OPENDC_AGENT_SOCKET ?? (facts ? join(facts.paths.run, 'agent-api.sock') : null);
  const agent = agentSocket ? new AgentClient(agentSocket, 'api') : null;
  let nodeId = hostname();
  if (agent) {
    try {
      nodeId = (await agent.call('system.info', {}, { actor: { name: 'opendc-api', via: 'api' }, timeoutMs: 5000 }))
        .fqdn;
    } catch {
      // the agent may start later; the hostname is a stable fallback for the audit origin
    }
  }

  const urls =
    process.env.OPENDC_LDAP_URLS?.split(',').filter(Boolean) ?? registry.get<string[]>('core.directory.ldapUrls');
  const caPem = credential('ldap-ca')?.toString('utf8') ?? readOptional(process.env.OPENDC_LDAP_CA);
  const tlsServerName = registry.get<string>('core.directory.tlsServerName');
  const baseDn = registry.get<string>('core.directory.baseDn');
  const directory = new DirectoryAuth({
    urls,
    caPem,
    ...(tlsServerName ? { tlsServerName } : {}),
    ...(baseDn ? { baseDn } : {}),
  });

  const cert = credential('tls-cert');
  const key = credential('tls-key');
  if (!dev && (!cert || !key))
    throw new Error(
      'No TLS certificate: start through opendc-api.service (LoadCredential=tls-cert/tls-key) or set OPENDC_DEV=1',
    );
  const hmac = credential('api-hmac');

  const webDir =
    process.env.OPENDC_WEB_DIR ??
    (facts ? join(facts.paths.lib, 'web') : resolve(fileURLToPath(import.meta.url), '../../../web/dist'));

  const api = await buildApi({
    db,
    directory,
    agent,
    nodeId,
    csrfKey: hmac && hmac.length >= 32 ? hmac : randomBytes(32),
    idleMinutes: registry.get<number>('core.session.idleMinutes'),
    absoluteHours: registry.get<number>('core.session.absoluteHours'),
    webDir,
    validateResponses: dev,
    https: dev ? null : { key: key ?? '', cert: cert ?? '' },
    logger: { level: process.env.OPENDC_LOG_LEVEL ?? 'info' },
  });

  const host = dev ? '127.0.0.1' : registry.get<string>('core.api.listenHost');
  const port = Number(process.env.OPENDC_PORT ?? registry.get<number>('core.api.listenPort'));
  await api.app.listen({ host, port });
  api.app.log.info({ version: platformVersion, nodeId, ldap: urls, agent: agentSocket, tls: !dev }, 'opendc-api ready');

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      void api.app.close().then(() => {
        db.close();
        process.exit(0);
      });
    });
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`opendc-api failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
