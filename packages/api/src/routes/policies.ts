// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /api/v1/policies (ROADMAP Phase 3, directory-object-model.md §3.1): policies are platform objects under
 * CN=Policies. Reading needs policies.policy.read; every change needs policies.policy.manage (tier 0: a password
 * policy at the domain head reaches Domain Admins). Links point at OUs, containers or the domain head.
 * The effective-policy view runs the same resolver as the watcher's password reconciler and registry handler.
 */
import { PlatformError } from '@opendc/shared';
import {
  effectivePolicy,
  effectiveQuery,
  empty,
  idParams,
  policyInput,
  policyList,
  policyListQuery,
  policyView,
  type PolicyData,
  type PolicyView,
} from '@opendc/shared/api';
import { sidFromBytes } from '@opendc/shared/ldap';
import { applicablePolicies, effectiveSettings, splitDn, type ResolvablePolicy } from '@opendc/shared/policy';
import { registryKeys } from '@opendc/modules/generated/registry';
import { z } from 'zod';
import type { AuditLog } from '../audit.ts';
import type { RouteContext, RouteTable } from '../http/route.ts';
import { PlatformObjects, type Stored } from '../directory/platform-objects.ts';
import type { DirectoryService } from '../directory/service.ts';
import { typeOf } from '../directory/model.ts';

type Ctx = RouteContext<unknown, unknown, unknown>;
const created = z.object({ id: z.string() });
const WHOLE = new Set(['password']);

/** Registry policies may only set policySettable keys, with values their schema accepts. */
export function validateRegistrySettings(settings: Record<string, unknown>): void {
  const issues: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    const def = registryKeys.find((k) => k.name === key);
    if (!def) issues.push(`${key}: unknown registry key`);
    else if (!def.policySettable) issues.push(`${key}: can't be set by a domain policy`);
    else if (!def.schema.safeParse(value).success) issues.push(`${key}: invalid value`);
  }
  if (issues.length) throw new PlatformError('validation.invalid', { issues: issues.join('; ') });
}

export function policyRoutes(t: RouteTable, d: { directory: () => DirectoryService; audit: AuditLog }): void {
  const store = new PlatformObjects({
    dir: d.directory,
    path: ['Policies'],
    kind: 'policy',
    schemaVersion: 1,
    data: policyInput,
    name: (x) => x.name,
  });
  const actor = (c: Ctx): { sid: string; name: string } => ({ sid: c.user.sid, name: c.user.username });
  const manage = (c: Ctx): void => {
    c.require('policies.policy.manage', { protected: true, label: 'Policies' });
  };
  const audit = (c: Ctx, action: string, id: string, before: unknown, after: unknown): void => {
    d.audit.append({
      actor: c.user.username,
      actorSid: c.user.sid,
      sourceIp: c.ip,
      action,
      result: 'success',
      targetGuid: null,
      before,
      after: after === null ? null : { id, ...(after as object) },
      requestId: c.requestId,
    });
  };

  /** Link targets exist and are OUs, containers or the domain head. */
  const checkLinks = async (p: PolicyData): Promise<void> => {
    const dir = d.directory();
    for (const l of p.links) {
      const e = await dir.entryByGuid(l.targetGuid).catch(() => null);
      const ok = e && (['ou', 'container'].includes(typeOf(e)) || e.dn.toLowerCase() === dir.domainDn.toLowerCase());
      if (!ok)
        throw new PlatformError('validation.invalid', {
          issues: `links: ${l.targetGuid} is not an OU, container or the domain`,
        });
    }
    if (p.type === 'registry') validateRegistrySettings(p.settings);
  };

  const view = async (s: Stored<PolicyData>): Promise<PolicyView> => {
    const dir = d.directory();
    const dns = new Map<string, string>();
    for (const l of s.data.links) {
      const e = await dir.entryByGuid(l.targetGuid, ['objectClass']).catch(() => null);
      if (e) dns.set(l.targetGuid, e.dn);
    }
    return {
      id: s.id,
      type: s.data.type,
      name: s.data.name,
      description: s.data.description,
      priority: s.data.priority,
      links: s.data.links.map((l) => ({ ...l, dn: dns.get(l.targetGuid) ?? null })),
      ...(s.data.filter ? { filter: s.data.filter } : {}),
      settings: s.data.settings,
      rev: s.rev,
      updatedAt: s.updatedAt,
      updatedBy: s.updatedBy.name,
    };
  };

  t.add({
    method: 'GET',
    url: '/api/v1/policies',
    operationId: 'listPolicies',
    summary: 'Policies (optionally of one type), with their links',
    tags: ['policies'],
    auth: { permission: 'policies.policy.read' },
    query: policyListQuery,
    response: policyList,
    handler: async (c) => {
      const all = (await store.list()).filter((p) => !c.query.type || p.data.type === c.query.type);
      return { policies: await Promise.all(all.map(view)) };
    },
  });

  t.add({
    method: 'GET',
    url: '/api/v1/policies/:id',
    operationId: 'getPolicy',
    summary: 'One policy',
    tags: ['policies'],
    auth: { permission: 'policies.policy.read' },
    params: idParams,
    response: policyView,
    handler: async (c) => view(await store.get(c.params.id)),
  });

  t.add({
    method: 'POST',
    url: '/api/v1/policies',
    operationId: 'createPolicy',
    summary: 'Create a policy (tier 0)',
    tags: ['policies'],
    auth: 'session',
    body: policyInput,
    response: created,
    status: 201,
    handler: async (c) => {
      manage(c);
      await checkLinks(c.body);
      const id = await store.create(actor(c), c.body);
      audit(c, 'policies.policy.create', id, null, c.body);
      return { id };
    },
  });

  t.add({
    method: 'PUT',
    url: '/api/v1/policies/:id',
    operationId: 'updatePolicy',
    summary: 'Replace a policy: settings, links, priority, filter (tier 0)',
    tags: ['policies'],
    auth: 'session',
    params: idParams,
    body: policyInput,
    response: empty,
    handler: async (c) => {
      manage(c);
      const cur = await store.get(c.params.id);
      if (cur.data.type !== c.body.type)
        throw new PlatformError('validation.invalid', { issues: "type: a policy's type can't change" });
      await checkLinks(c.body);
      await store.update(actor(c), cur, c.body);
      audit(c, 'policies.policy.update', cur.id, cur.data, c.body);
      return {};
    },
  });

  t.add({
    method: 'DELETE',
    url: '/api/v1/policies/:id',
    operationId: 'deletePolicy',
    summary: 'Delete a policy (tier 0)',
    tags: ['policies'],
    auth: 'session',
    params: idParams,
    response: empty,
    handler: async (c) => {
      manage(c);
      const cur = await store.get(c.params.id);
      await store.delete(cur);
      audit(c, 'policies.policy.delete', cur.id, cur.data, null);
      return {};
    },
  });

  t.add({
    method: 'GET',
    url: '/api/v1/policies/effective',
    operationId: 'getEffectivePolicy',
    summary: 'The policies of a type that apply to an object, winner first, and each setting with its source',
    tags: ['policies'],
    auth: { permission: 'policies.policy.read' },
    query: effectiveQuery,
    response: effectivePolicy,
    handler: async (c) => {
      const dir = d.directory();
      const target = await dir.entryByGuid(c.query.target, ['objectClass', 'objectGUID'], true);
      // containers from the target's parent up to the domain head
      const parts = splitDn(target.dn);
      const head = dir.domainDn.toLowerCase();
      const ancestors: string[] = [];
      for (let i = 1; i < parts.length; i++) {
        const dn = parts.slice(i).join(',');
        ancestors.push(dn);
        if (dn.toLowerCase() === head) break;
      }
      const refs = await dir.resolveRefs(ancestors);
      const chain = ancestors.flatMap((dn) => {
        const r = refs.get(dn.toLowerCase());
        return r ? [{ guid: r.guid, dn }] : [];
      });
      // group filters: the target's transitive groups (tokenGroups) matched by SID
      const all = (await store.list()).filter((p) => p.data.type === c.query.type);
      const filterGroups = [...new Set(all.flatMap((p) => p.data.filter?.groupGuids ?? []))];
      const tokenSids = new Set(
        (Array.isArray(target.tokenGroups) ? target.tokenGroups : [target.tokenGroups])
          .filter((b): b is Buffer => Buffer.isBuffer(b))
          .map((b) => sidFromBytes(b)),
      );
      const groupGuids: string[] = [];
      for (const g of filterGroups) {
        const e = await dir.entryByGuid(g, ['objectSid']).catch(() => null);
        const sid = e && Buffer.isBuffer(e.objectSid) ? sidFromBytes(e.objectSid) : null;
        if (sid && tokenSids.has(sid)) groupGuids.push(g);
      }
      const policies: ResolvablePolicy[] = all.map((p) => ({
        id: p.id,
        name: p.data.name,
        type: p.data.type,
        priority: p.data.priority,
        links: p.data.links,
        ...(p.data.filter ? { filter: p.data.filter } : {}),
        settings: p.data.settings,
      }));
      const applied = applicablePolicies({ chain, groupGuids }, policies, c.query.type);
      const winner = applied[0] ?? null;
      const merged = WHOLE.has(c.query.type)
        ? Object.fromEntries(
            Object.entries(winner?.policy.settings ?? {}).map(([k, v]) => [k, { value: v, source: winner }]),
          )
        : effectiveSettings(applied);
      return {
        target: { guid: c.query.target, dn: target.dn },
        type: c.query.type,
        chain,
        applicable: applied.map((a) => ({
          id: a.policy.id,
          name: a.policy.name,
          priority: a.policy.priority,
          level: a.level,
          depth: a.depth,
          enforced: a.enforced,
        })),
        settings: Object.fromEntries(
          Object.entries(merged).flatMap(([k, s]) =>
            s.source
              ? [
                  [
                    k,
                    {
                      value: s.value,
                      policyId: s.source.policy.id,
                      policyName: s.source.policy.name,
                      levelDn: s.source.level.dn,
                    },
                  ],
                ]
              : [],
          ),
        ),
        winner: WHOLE.has(c.query.type) ? (winner?.policy.id ?? null) : null,
      };
    },
  });
}
