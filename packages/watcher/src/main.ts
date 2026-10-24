#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * opendc-watcher (ADR-0004). Phase 1 scope: render every managed template for this node's role through the
 * agent's watch socket at start, then report drift periodically. Directory following (DirSync/USN, Spike S2)
 * arrives in Phase 3.
 */
import { AgentClient } from '@opendc/shared/agent';
import { isPlatformError } from '@opendc/shared';
import { Registry, RegistryService, agentPort } from '@opendc/registry';
import { registryKeys, templates } from '@opendc/modules/generated/registry';

const socket = process.env.OPENDC_AGENT_SOCKET ?? '/run/opendc/agent-watch.sock';
const DRIFT_INTERVAL_MS = Number(process.env.OPENDC_DRIFT_INTERVAL_MS ?? 15 * 60_000);
const actor = { name: 'opendc-watcher', via: 'watcher' as const };

function log(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra }) + '\n');
}

async function service(client: AgentClient): Promise<RegistryService> {
  const info = await client.call('system.info', {}, { actor, timeoutMs: 10_000 });
  return new RegistryService({
    agent: agentPort(client, actor),
    keys: new Registry(registryKeys),
    templates,
    node: { hostname: info.hostname, fqdn: info.fqdn, role: info.role },
    holder: 'watcher',
  });
}

async function main(): Promise<void> {
  const client = new AgentClient(socket, 'watch');
  let svc: RegistryService | null = null;
  // The agent is socket-activated; retry briefly so boot ordering doesn't matter.
  for (let attempt = 1; !svc; attempt++) {
    try {
      svc = await service(client);
    } catch (e) {
      if (attempt >= 30) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const report = await svc.commit();
  log('info', 'managed files rendered', { ...report });

  const s = svc;
  const timer = setInterval(() => {
    void s
      .drift()
      .then((drift) => {
        if (drift.length) log('warn', 'managed file drift', { drift });
      })
      .catch((e: unknown) => {
        log('error', 'drift check failed', { error: e instanceof Error ? e.message : String(e) });
      });
  }, DRIFT_INTERVAL_MS);

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      clearInterval(timer);
      log('info', `stopping on ${sig}`);
      process.exit(0);
    });
  }
}

main().catch((e: unknown) => {
  log('error', 'opendc-watcher failed', {
    error: e instanceof Error ? e.message : String(e),
    ...(isPlatformError(e) ? { code: e.code, fix: e.fix } : {}),
  });
  process.exit(1);
});
