// SPDX-License-Identifier: AGPL-3.0-only
/**
 * This node's Kea configuration ("what should be", ADR-0004 §5): every change under CN=DHCP or to a DHCP policy
 * recomputes it from the directory: the services this node serves, their subnets and reservations, an HA peer if
 * the service has two servers, and server-wide options from the DHCP policies for this node. The agent renders,
 * checks and reloads it (no restart); a node that serves nothing stops Kea.
 */
import { lookup } from 'node:dns/promises';
import {
  dhcpReservation,
  dhcpService,
  dhcpSubnet,
  keaSubnetId,
  type DhcpReservation,
  type DhcpService,
  type DhcpSubnet,
  type KeaApplyArgs,
} from '@opendc/shared/dhcp';
import { childDn, eq, guidFromBytes } from '@opendc/shared/ldap';
import type { WatchContext, WatchHandler } from '@opendc/shared/manifest';
import type { z } from 'zod';
import { nodePolicyValues } from '../../policies/watchers/registry-policy.ts';

const PREFIX = 'opendc:v1:';

async function load<S extends z.ZodType>(
  ctx: WatchContext,
  container: string,
  kind: string,
  schema: S,
): Promise<{ id: string; data: z.output<S> }[]> {
  const base = childDn(childDn(ctx.platformDn, 'CN', 'DHCP'), 'CN', container);
  const entries = await ctx.ldap
    .search(base, {
      scope: 'one',
      filter: eq('objectClass', 'msDS-App-Configuration'),
      attributes: ['cn', 'msDS-Settings'],
    })
    .catch(() => []);
  const out: { id: string; data: z.output<S> }[] = [];
  for (const e of entries) {
    const raw = typeof e['msDS-Settings'] === 'string' ? e['msDS-Settings'] : '';
    if (!raw.startsWith(PREFIX)) continue;
    try {
      const env = JSON.parse(raw.slice(PREFIX.length)) as { kind?: string; data?: unknown };
      if (env.kind !== kind) continue;
      const r = schema.safeParse(env.data);
      if (r.success) out.push({ id: typeof e.cn === 'string' ? e.cn : '', data: r.data });
      else ctx.log('warn', 'DHCP object ignored (invalid)', { kind, dn: e.dn });
    } catch {
      ctx.log('warn', 'DHCP object ignored (unreadable)', { kind, dn: e.dn });
    }
  }
  return out;
}

async function myGuid(ctx: WatchContext): Promise<string | null> {
  const host = (ctx.node.hostname.split('.')[0] ?? '').toUpperCase();
  const [me] = await ctx.ldap.search(ctx.domainDn, {
    scope: 'sub',
    filter: eq('sAMAccountName', `${host}$`),
    attributes: ['objectGUID'],
    buffers: ['objectGUID'],
  });
  return me && Buffer.isBuffer(me.objectGUID) ? guidFromBytes(me.objectGUID) : null;
}

const handler: WatchHandler = {
  async onChange(_batch, ctx) {
    const guid = await myGuid(ctx);
    if (!guid) {
      ctx.log('warn', 'this node has no computer object; DHCP left as it is');
      return;
    }
    const services: { id: string; data: DhcpService }[] = await load(ctx, 'Services', 'dhcp.service', dhcpService);
    const mine = services.filter((s) => s.data.servers.some((x) => x.nodeGuid.toLowerCase() === guid));
    if (!mine.length) {
      const r = await ctx.agent('dhcp.apply', { enabled: false });
      if (r.changed) ctx.log('info', 'DHCP stopped (this node serves no DHCP service)');
      return;
    }
    const subnets: { id: string; data: DhcpSubnet }[] = (await load(ctx, 'Subnets', 'dhcp.subnet', dhcpSubnet)).filter(
      (s) => mine.some((m) => m.id === s.data.serviceId),
    );
    const reservations: { id: string; data: DhcpReservation }[] = await load(
      ctx,
      'Reservations',
      'dhcp.reservation',
      dhcpReservation,
    );
    const policy = (await nodePolicyValues(ctx, 'dhcp')) ?? {};
    const first = mine[0]?.data;
    // an HA pair: the first server is the primary
    let ha = null;
    if (first && first.servers.length === 2) {
      const peers: NonNullable<KeaApplyArgs['ha']>['peers'] = [];
      for (const [i, s] of first.servers.entries()) {
        const address = (await lookup(s.host, { family: 4 }).catch(() => null))?.address;
        if (!address) throw new Error(`HA peer ${s.host} has no IPv4 address`);
        peers.push({
          name: s.host,
          address,
          role: i === 0 ? 'primary' : first.mode === 'hot-standby' ? 'standby' : 'secondary',
        });
      }
      const self = first.servers.find((s) => s.nodeGuid.toLowerCase() === guid);
      ha = { mode: first.mode, thisServer: self?.host ?? '', peers };
    }
    const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
    const r = await ctx.agent('dhcp.apply', {
      enabled: true,
      interfaces: [...new Set(mine.flatMap((m) => m.data.interfaces))],
      leaseSeconds: typeof policy.leaseSeconds === 'number' ? policy.leaseSeconds : (first?.leaseSeconds ?? 86_400),
      globals: {
        dnsServers: asList(policy.dnsServers),
        domainName: typeof policy.domainName === 'string' ? policy.domainName : null,
        ntpServers: asList(policy.ntpServers),
      },
      subnets: subnets.map((s) => ({
        id: keaSubnetId(s.id),
        cidr: s.data.cidr,
        pools: s.data.pools,
        routers: s.data.routers,
        dnsServers: s.data.dnsServers,
        domainName: s.data.domainName,
        ntpServers: s.data.ntpServers,
        reservations: reservations
          .filter((x) => x.data.subnetId === s.id)
          .map((x) => ({ mac: x.data.mac, ip: x.data.ip, hostname: x.data.hostname })),
      })),
      ha,
    });
    if (r.changed)
      ctx.log('info', 'DHCP configuration applied', {
        action: r.action,
        subnets: subnets.length,
        reservations: reservations.length,
      });
  },
};
export default handler;
