// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The registry `domain-policy` layer of this node (ADR-0005): the registry policies that apply to this node's
 * computer object, resolved like the console's viewer (its OU chain, its groups, its role), written as the
 * layer file; affected managed files are re-rendered. Runs on every node, for itself.
 * Streams: any policy change, and moves of computer objects (only this node's own matters).
 */
import { parsePolicyPayload } from '@opendc/shared/api';
import { childDn, eq, guidBase, guidFromBytes, or, sidFromBytes } from '@opendc/shared/ldap';
import type { WatchContext, WatchHandler } from '@opendc/shared/manifest';
import { applicablePolicies, effectiveSettings, splitDn, type ResolvablePolicy } from '@opendc/shared/policy';

const lower = (s: string): string => s.toLowerCase();
const buffers = (v: unknown): Buffer[] => (Array.isArray(v) ? v : [v]).filter((b): b is Buffer => Buffer.isBuffer(b));

/** The effective registry values for this node; null when its computer object isn't found. */
export async function nodePolicyValues(ctx: WatchContext): Promise<Record<string, unknown> | null> {
  const host = (ctx.node.hostname.split('.')[0] ?? '').toUpperCase();
  const [found] = await ctx.ldap.search(ctx.domainDn, {
    scope: 'sub',
    filter: eq('sAMAccountName', `${host}$`),
    attributes: ['objectGUID'],
  });
  if (!found) return null;
  const [me] = await ctx.ldap.search(found.dn, {
    scope: 'base',
    attributes: ['tokenGroups'],
    buffers: ['tokenGroups'],
  });
  const tokenSids = new Set(buffers(me?.tokenGroups).map((b) => sidFromBytes(b)));

  // the containers from this computer up to the domain head, with their GUIDs
  const parts = splitDn(found.dn);
  const ancestors: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const dn = parts.slice(i).join(',');
    ancestors.push(dn);
    if (lower(dn) === lower(ctx.domainDn)) break;
  }
  const guidOf = new Map<string, string>();
  for (const e of await ctx.ldap.search(ctx.domainDn, {
    scope: 'sub',
    filter: or(...ancestors.map((dn) => eq('distinguishedName', dn))),
    attributes: ['objectGUID'],
    buffers: ['objectGUID'],
  })) {
    const g = buffers(e.objectGUID)[0];
    if (g) guidOf.set(lower(e.dn), guidFromBytes(g));
  }
  const chain = ancestors.flatMap((dn) => {
    const guid = guidOf.get(lower(dn));
    return guid ? [{ guid, dn }] : [];
  });

  const policies: ResolvablePolicy[] = [];
  for (const e of await ctx.ldap.search(childDn(ctx.platformDn, 'CN', 'Policies'), {
    scope: 'one',
    filter: eq('objectClass', 'msDS-App-Configuration'),
    attributes: ['cn', 'msDS-Settings'],
  })) {
    const d = parsePolicyPayload(typeof e['msDS-Settings'] === 'string' ? e['msDS-Settings'] : null);
    if (d?.type !== 'registry') continue;
    policies.push({
      id: typeof e.cn === 'string' ? e.cn : '',
      name: d.name,
      type: d.type,
      priority: d.priority,
      links: d.links,
      ...(d.filter ? { filter: d.filter } : {}),
      settings: d.settings,
    });
  }
  // group filters: this computer's transitive groups, matched by SID
  const groupGuids: string[] = [];
  for (const g of new Set(policies.flatMap((p) => p.filter?.groupGuids ?? []))) {
    const [ge] = await ctx.ldap.search(guidBase(g), {
      scope: 'base',
      attributes: ['objectSid'],
      buffers: ['objectSid'],
    });
    const sid = buffers(ge?.objectSid)[0];
    if (sid && tokenSids.has(sidFromBytes(sid))) groupGuids.push(g);
  }
  const applied = applicablePolicies({ chain, groupGuids, nodeRole: ctx.node.role }, policies, 'registry');
  return Object.fromEntries(Object.entries(effectiveSettings(applied)).map(([k, s]) => [k, s.value]));
}

const handler: WatchHandler = {
  async onChange(batch, ctx) {
    if (batch.handlerId === 'registry-policy-node' && !batch.sync) {
      // a computer moved: only this node's own object matters
      const host = lower(ctx.node.hostname.split('.')[0] ?? '');
      // the first RDN of a computer is CN=<host>
      if (!batch.events.some((e) => lower(splitDn(e.dn)[0] ?? '').slice(3) === host)) return;
    }
    const values = await nodePolicyValues(ctx);
    if (values === null) {
      ctx.log('warn', 'this node has no computer object in the directory; the domain-policy layer is unchanged');
      return;
    }
    const r = await ctx.registry.applyPolicyLayer(values);
    if (r) ctx.log('info', 'domain-policy layer updated', { keys: Object.keys(values), changedFiles: r.changed });
  },
};
export default handler;
