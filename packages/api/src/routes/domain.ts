// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FSMO roles and functional levels (ROADMAP Phase 2). Tier 0: the API checks domain.fsmo.manage /
 * domain.level.raise (tier-0 roles only), the user types the confirmation phrase, the API mints a typed
 * confirmation and the agent on this DC does the work. The audit entry records the owners before and after.
 */
import { PlatformError } from '@opendc/shared';
import { mintConfirmation, type AgentClient, type OpArgs } from '@opendc/shared/agent';
import { z } from 'zod';
import { passwordPolicies, passwordPolicyChange } from '@opendc/shared/domain';
import type { AuditLog } from '../audit.ts';
import type { RouteTable } from '../http/route.ts';

const fsmoRoles = ['schema', 'naming', 'pdc', 'rid', 'infrastructure', 'domaindns', 'forestdns'] as const;
const levels = ['2008_R2', '2012', '2012_R2', '2016'] as const;

export const fsmoResponse = z.object({
  roles: z.array(z.object({ role: z.enum(fsmoRoles), ownerServer: z.string().nullable(), ownerDn: z.string() })),
});
const fsmoChange = z.strictObject({
  roles: z.array(z.enum(fsmoRoles)).min(1).max(7),
  /** Seizure only: don't try a transfer first. */
  force: z.boolean().default(false),
  /** The role names, space-separated, in any order (typed by the user). */
  confirm: z.string().max(200),
});
const levelChange = z.strictObject({
  domain: z.enum(levels).optional(),
  forest: z.enum(levels).optional(),
  /** The target level, typed by the user. */
  confirm: z.string().max(20),
});
const levelResponse = z.object({
  forest: z.string().nullable(),
  domain: z.string().nullable(),
  lowestDc: z.string().nullable(),
});

/** The phrase for an FSMO change: the role names. */
export const fsmoPhrase = (roles: readonly string[]): string => [...new Set(roles)].sort().join(' ');
const samePhrase = (typed: string, roles: readonly string[]): boolean =>
  fsmoPhrase(
    typed
      .trim()
      .toLowerCase()
      .split(/[\s,]+/)
      .filter(Boolean),
  ) === fsmoPhrase(roles);

export function domainRoutes(
  t: RouteTable,
  d: { agent: Pick<AgentClient, 'call'> | null; audit: AuditLog; confirmKey: Buffer },
): void {
  const agent = (): Pick<AgentClient, 'call'> => {
    if (!d.agent)
      throw new PlatformError('agent.unreachable', { socket: '(not configured)', reason: 'no agent socket' });
    return d.agent;
  };

  t.add({
    method: 'GET',
    url: '/api/v1/domain/fsmo',
    operationId: 'getFsmo',
    summary: 'FSMO role holders',
    tags: ['domain'],
    auth: { permission: 'domain.info.read' },
    response: fsmoResponse,
    handler: async (c) =>
      agent().call('samba.fsmo.show', {}, { actor: { name: c.user.username, sid: c.user.sid, via: 'api' } }),
  });

  for (const kind of ['transfer', 'seize'] as const) {
    t.add({
      method: 'POST',
      url: `/api/v1/domain/fsmo/${kind}`,
      operationId: kind === 'transfer' ? 'transferFsmo' : 'seizeFsmo',
      summary:
        kind === 'transfer'
          ? 'Move FSMO roles to this DC from their (reachable) holder; typed confirmation'
          : 'Seize FSMO roles on this DC when the holder is gone for good; typed confirmation of the role names',
      tags: ['domain'],
      auth: { permission: 'domain.fsmo.manage' },
      body: fsmoChange,
      response: fsmoResponse,
      handler: async (c) => {
        c.require('domain.fsmo.manage', { protected: true, label: 'FSMO' });
        if (!samePhrase(c.body.confirm, c.body.roles))
          throw new PlatformError('agent.confirmation-required', { op: `samba.fsmo.${kind}` });
        const actor = { name: c.user.username, sid: c.user.sid, via: 'api' as const };
        const before = await agent().call('samba.fsmo.show', {}, { actor });
        const op = kind === 'transfer' ? ('samba.fsmo.transfer' as const) : ('samba.fsmo.seize' as const);
        const args: OpArgs<typeof op> =
          kind === 'transfer' ? { roles: c.body.roles } : { roles: c.body.roles, force: c.body.force };
        const confirmation = mintConfirmation(d.confirmKey, {
          op,
          args: kind === 'transfer' ? args : { force: false, ...args },
          actor: c.user.sid,
        });
        const owners = (r: { roles: { role: string; ownerServer: string | null }[] }): Record<string, string | null> =>
          Object.fromEntries(
            r.roles.filter((x) => c.body.roles.includes(x.role as never)).map((x) => [x.role, x.ownerServer]),
          );
        try {
          await agent().call(op, args, { actor, confirmation, timeoutMs: 1_800_000 });
        } catch (e) {
          d.audit.append({
            actor: c.user.username,
            actorSid: c.user.sid,
            sourceIp: c.ip,
            action: `domain.fsmo.${kind}`,
            result: 'failure',
            before: owners(before),
            after: { error: e instanceof PlatformError ? e.code : 'internal' },
            requestId: c.requestId,
          });
          throw e;
        }
        const after = await agent().call('samba.fsmo.show', {}, { actor });
        d.audit.append({
          actor: c.user.username,
          actorSid: c.user.sid,
          sourceIp: c.ip,
          action: `domain.fsmo.${kind}`,
          result: 'success',
          before: owners(before),
          after: { ...owners(after), ...(kind === 'seize' ? { force: c.body.force } : {}) },
          requestId: c.requestId,
        });
        return after;
      },
    });
  }

  t.add({
    method: 'POST',
    url: '/api/v1/domain/level',
    operationId: 'raiseFunctionalLevel',
    summary: 'Raise the domain and/or forest functional level (irreversible); typed confirmation of the level',
    tags: ['domain'],
    auth: { permission: 'domain.level.raise' },
    body: levelChange,
    response: levelResponse,
    handler: async (c) => {
      c.require('domain.level.raise', { protected: true, label: 'functional level' });
      const target = c.body.forest ?? c.body.domain;
      if (!target) throw new PlatformError('validation.invalid', { issues: 'domain or forest' });
      if (c.body.confirm.trim() !== target)
        throw new PlatformError('agent.confirmation-required', { op: 'samba.level.raise' });
      const actor = { name: c.user.username, sid: c.user.sid, via: 'api' as const };
      const before = await agent().call('samba.level.show', {}, { actor });
      const args = {
        ...(c.body.domain ? { domain: c.body.domain } : {}),
        ...(c.body.forest ? { forest: c.body.forest } : {}),
      };
      const confirmation = mintConfirmation(d.confirmKey, { op: 'samba.level.raise', args, actor: c.user.sid });
      const after = await agent().call('samba.level.raise', args, { actor, confirmation, timeoutMs: 600_000 });
      d.audit.append({
        actor: c.user.username,
        actorSid: c.user.sid,
        sourceIp: c.ip,
        action: 'domain.level.raise',
        result: 'success',
        before,
        after,
        requestId: c.requestId,
      });
      return after;
    },
  });

  t.add({
    method: 'GET',
    url: '/api/v1/domain/password-policies',
    operationId: 'getPasswordPolicies',
    summary: 'The default domain password policy and the fine-grained policies (PSOs)',
    tags: ['domain'],
    auth: { permission: 'domain.passwordPolicy.read' },
    response: passwordPolicies,
    handler: async (c) =>
      agent().call('samba.passwordPolicy.show', {}, { actor: { name: c.user.username, sid: c.user.sid, via: 'api' } }),
  });

  t.add({
    method: 'PUT',
    url: '/api/v1/domain/password-policies',
    operationId: 'setPasswordPolicy',
    summary: 'Change the default policy, create/update a PSO (with its users and groups) or delete a PSO',
    tags: ['domain'],
    auth: { permission: 'domain.passwordPolicy.write' },
    body: passwordPolicyChange,
    response: passwordPolicies,
    handler: async (c) => {
      c.require('domain.passwordPolicy.write', { protected: true, label: 'password policy' });
      const actor = { name: c.user.username, sid: c.user.sid, via: 'api' as const };
      const before = await agent().call('samba.passwordPolicy.show', {}, { actor });
      const after = await agent().call('samba.passwordPolicy.set', c.body, { actor, timeoutMs: 300_000 });
      const pick = (p: z.infer<typeof passwordPolicies>): unknown =>
        c.body.kind === 'default'
          ? p.default
          : (p.psos.find((x) => x.name.toLowerCase() === (c.body as { name: string }).name.toLowerCase()) ?? null);
      d.audit.append({
        actor: c.user.username,
        actorSid: c.user.sid,
        sourceIp: c.ip,
        action: `domain.password-policy.${c.body.kind}`,
        result: 'success',
        before: pick(before),
        after: pick(after),
        requestId: c.requestId,
      });
      return after;
    },
  });
}
