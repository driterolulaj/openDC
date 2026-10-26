#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * opendc-watcher (ADR-0004): renders this node's managed files through the agent's watch socket, reports
 * drift, and follows the directory with DirSync, handing changes to the module handlers for this node's role.
 *
 * Secrets arrive as systemd credentials: ldap-watch ({dn, sam, password} of opendc-watch-<host>; empty before
 * setup, then only the registry part runs) and ldap-ca.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AgentClient } from '@opendc/shared/agent';
import { isPlatformError } from '@opendc/shared';
import { openDb } from '@opendc/shared/db';
import { ServiceLdap, type ServiceCredential } from '@opendc/shared/ldap';
import { roleMatches } from '@opendc/shared/manifest';
import { Registry, RegistryService, agentPort, parseLayer } from '@opendc/registry';
import { registryKeys, templates } from '@opendc/modules/generated/registry';
import { watchers } from '@opendc/modules/generated/watchers';
import { detectFacts } from '@opendc/os';
import { WatcherEngine, type WatcherStatus } from './engine.ts';
import { WatchedDc, writeInbox } from './directory.ts';
import { SqliteCheckpoints, watcherMigrations } from './state.ts';

const DRIFT_INTERVAL_MS = Number(process.env.OPENDC_DRIFT_INTERVAL_MS ?? 15 * 60_000);
const actor = { name: 'opendc-watcher', via: 'watcher' as const };

function log(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra }) + '\n');
}

function credential(name: string): string | null {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  if (!dir) return null;
  try {
    return readFileSync(join(dir, name), 'utf8');
  } catch {
    return null;
  }
}

const readOptional = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** Atomic, world-readable status snapshot (no secrets) for the API. */
function writeStatus(path: string, s: WatcherStatus): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(s));
    chmodSync(tmp, 0o644);
    renameSync(tmp, path);
  } catch (e) {
    log('warn', 'could not write the status file', { error: e instanceof Error ? e.message : String(e) });
  }
}

async function main(): Promise<void> {
  const socket = process.env.OPENDC_AGENT_SOCKET ?? '/run/opendc/agent-watch.sock';
  const client = new AgentClient(socket, 'watch');
  // The agent is socket-activated; retry briefly so boot ordering doesn't matter.
  let info: Awaited<ReturnType<typeof client.call<'system.info'>>> | null = null;
  for (let attempt = 1; !info; attempt++) {
    try {
      info = await client.call('system.info', {}, { actor, timeoutMs: 10_000 });
    } catch (e) {
      if (attempt >= 30) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const node = { hostname: info.hostname, fqdn: info.fqdn, role: info.role };
  const svc = new RegistryService({
    agent: agentPort(client, actor),
    keys: new Registry(registryKeys),
    templates,
    node,
    holder: 'watcher',
  });
  const report = await svc.commit();
  log('info', 'managed files rendered', { ...report });

  const drift = setInterval(() => {
    void svc
      .drift()
      .then((d) => {
        if (d.length) log('warn', 'managed file drift', { drift: d });
      })
      .catch((e: unknown) => {
        log('error', 'drift check failed', { error: e instanceof Error ? e.message : String(e) });
      });
  }, DRIFT_INTERVAL_MS);

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      clearInterval(drift);
      log('info', `stopping on ${sig}`);
      process.exit(0);
    });
  }

  // ---- directory following ----
  let cred: ServiceCredential | null = null;
  try {
    const raw = credential('ldap-watch') ?? '';
    if (raw.trim()) cred = JSON.parse(raw) as ServiceCredential;
  } catch {
    cred = null;
  }
  if (!cred?.dn) {
    log('info', 'no watch account yet (node not set up): directory following is off');
    return;
  }
  const facts = await detectFacts();
  const registry = new Registry(registryKeys)
    .withLayer(
      'domain-policy',
      parseLayer('core.registry-policy', readOptional(facts.paths.managedFile('opendc.registry.policy'))),
    )
    .withLayer(
      'local',
      parseLayer('core.registry-local', readOptional(facts.paths.managedFile('opendc.registry.local'))),
    )
    .withLayer(
      'forced',
      parseLayer('core.registry-forced', readOptional(facts.paths.managedFile('opendc.registry.forced'))),
    );
  const domainDn = registry.get<string>('core.directory.baseDn');
  const tlsServerName = registry.get<string>('core.directory.tlsServerName');
  const ldap = new ServiceLdap({
    urls: registry.get<string[]>('core.directory.ldapUrls'),
    caPem: credential('ldap-ca') || null,
    credential: cred,
    ...(tlsServerName ? { tlsServerName } : {}),
  });
  const handlers = watchers.filter((w) => roleMatches(node.role, w.roles));
  if (roleMatches(node.role, ['writable-dc'])) {
    // read access to tombstones, without which deletions are never seen (older installs lack it)
    try {
      const r = await client.call('platform.watchAccess.ensure', {}, { actor, timeoutMs: 120_000 });
      if (r.changed.length) log('info', 'watch account access completed', { changed: r.changed });
    } catch (e) {
      log('warn', 'could not check the watch account access', { error: e instanceof Error ? e.message : String(e) });
    }
  }
  const stateDir = join(facts.paths.state, 'watcher');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const state = new SqliteCheckpoints(openDb(join(stateDir, 'watcher.db'), watcherMigrations));
  const platformDn = `CN=OpenDC,CN=System,${domainDn}`;
  const auditActor = `opendc-watcher@${node.hostname}`;

  const engine = new WatcherEngine({
    domainDn,
    platformDn,
    handlers,
    dir: new WatchedDc(ldap, domainDn),
    state,
    // only a DC that watches itself can be the PDC emulator (members watch a DC)
    canLead: roleMatches(node.role, ['writable-dc']),
    log,
    context: (h, o) => ({
      domainDn,
      platformDn,
      node,
      leader: o.leader,
      since: new Date(o.since).toISOString(),
      signal: o.signal,
      ldap: { search: (base, so) => ldap.search(base, so) },
      agent: (op, args) => client.call(op, args, { actor, timeoutMs: 120_000 }),
      registry: {
        applyPolicyLayer: async (values) => {
          const r = await svc.setPolicyLayer(values);
          return r ? { changed: r.changed } : null;
        },
      },
      audit: (e) => {
        try {
          writeInbox(facts.paths.auditInbox, { ts: new Date().toISOString(), actor: auditActor, ...e });
        } catch (err) {
          log('error', 'audit entry not delivered', {
            handler: h.id,
            action: e.action,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
      log: (level, msg, extra) => {
        log(level, msg, { handler: h.id, ...extra });
      },
    }),
  });
  const pollMs = registry.get<number>('core.watcher.pollSeconds') * 1000;
  log('info', 'following the directory', {
    handlers: handlers.map((h) => h.id),
    pollSeconds: pollMs / 1000,
  });
  for (;;) {
    const s = await engine.pass();
    writeStatus(facts.paths.watcherStatus, s);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main().catch((e: unknown) => {
  log('error', 'opendc-watcher failed', {
    error: e instanceof Error ? e.message : String(e),
    ...(isPlatformError(e) ? { code: e.code, fix: e.fix } : {}),
  });
  process.exit(1);
});
