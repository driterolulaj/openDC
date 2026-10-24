// SPDX-License-Identifier: AGPL-3.0-only
/** RegistryAgent backed by the agent socket (watch socket in the watcher, cli socket in the CLI). */
import type { Actor, AgentClient } from '@opendc/shared/agent';
import { LOCK_STALE_SEC, type RegistryAgent } from './commit.ts';

export function agentPort(client: AgentClient, actor: Actor): RegistryAgent {
  const o = { actor };
  return {
    read: (fileId) => client.call('file.readManaged', { fileId }, o),
    write: (fileId, content, expectedPrevSha256) =>
      client.call('file.writeManaged', { fileId, content, expectedPrevSha256 }, o),
    restore: async (fileId) => {
      await client.call('file.restorePrevious', { fileId }, o);
    },
    service: async (action, unit) => {
      await client.call(
        action === 'reload' ? 'service.reload' : 'service.restart',
        { unit },
        { ...o, timeoutMs: 120_000 },
      );
    },
    lock: (holder) => client.call('registry.commitLock', { action: 'acquire', holder, ttlSec: LOCK_STALE_SEC }, o),
    unlock: async (token) => {
      await client.call('registry.commitLock', { action: 'release', token }, o);
    },
  };
}
