// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /api/v1/dhcp (ROADMAP Phase 3): services, subnets and reservations (IPv4 and IPv6) are platform objects under
 * CN=DHCP; the serving nodes' watchers render Kea from them. Checks across objects happen here: servers are
 * computer accounts (their host names come from the directory), subnets of a service don't overlap, a reservation's
 * address lies in its subnet and is unique there (so is its client), an IPv6 subnet names its interface when the
 * service has several, and nothing is deleted while something still refers to it. Leases are this node's (its own
 * Kea).
 */
import { PlatformError } from '@opendc/shared';
import type { AgentClient } from '@opendc/shared/agent';
import { empty, idParams } from '@opendc/shared/api';
import {
  dhcpReservation,
  dhcpReservation6,
  dhcpService,
  dhcpSubnet,
  dhcpSubnet6,
  inSubnet,
  inSubnet6,
  ip6ToBig,
  ipToInt,
  parseCidr,
  parseCidr6,
  type DhcpReservation,
  type DhcpReservation6,
  type DhcpService,
  type DhcpSubnet,
  type DhcpSubnet6,
} from '@opendc/shared/dhcp';
import { pkiCert } from '@opendc/shared/pki';
import { z } from 'zod';
import type { AuditLog } from '../audit.ts';
import type { RouteContext, RouteTable } from '../http/route.ts';
import { PlatformObjects, type Stored } from '../directory/platform-objects.ts';
import type { DirectoryService } from '../directory/service.ts';
import { typeOf } from '../directory/model.ts';

type Ctx = RouteContext<unknown, unknown, unknown>;
const created = z.object({ id: z.string() });
export const dhcpOverview = z.object({
  services: z.array(z.looseObject({ id: z.string() })),
  subnets: z.array(z.looseObject({ id: z.string() })),
  reservations: z.array(z.looseObject({ id: z.string() })),
  subnets6: z.array(z.looseObject({ id: z.string() })),
  reservations6: z.array(z.looseObject({ id: z.string() })),
});
const leases = z.object({
  leases: z.array(
    z.object({
      family: z.union([z.literal(4), z.literal(6)]),
      ip: z.string(),
      mac: z.string(),
      duid: z.string().nullable(),
      hostname: z.string().nullable(),
      subnetId: z.number(),
      expires: z.string(),
      state: z.number(),
    }),
  ),
});

export function dhcpRoutes(
  t: RouteTable,
  d: { directory: () => DirectoryService; agent: () => Pick<AgentClient, 'call'>; audit: AuditLog },
): void {
  const services = new PlatformObjects({
    dir: d.directory,
    path: ['DHCP', 'Services'],
    kind: 'dhcp.service',
    schemaVersion: 1,
    data: dhcpService,
    name: (x) => x.name,
  });
  const subnets = new PlatformObjects({
    dir: d.directory,
    path: ['DHCP', 'Subnets'],
    kind: 'dhcp.subnet',
    schemaVersion: 1,
    data: dhcpSubnet,
    name: (x) => x.cidr,
  });
  const reservations = new PlatformObjects({
    dir: d.directory,
    path: ['DHCP', 'Reservations'],
    kind: 'dhcp.reservation',
    schemaVersion: 1,
    data: dhcpReservation,
    name: (x) => `${x.ip} ${x.mac}`,
  });
  const subnets6 = new PlatformObjects({
    dir: d.directory,
    path: ['DHCP', 'Subnets6'],
    kind: 'dhcp.subnet6',
    schemaVersion: 1,
    data: dhcpSubnet6,
    name: (x) => x.prefix,
  });
  const reservations6 = new PlatformObjects({
    dir: d.directory,
    path: ['DHCP', 'Reservations6'],
    kind: 'dhcp.reservation6',
    schemaVersion: 1,
    data: dhcpReservation6,
    name: (x) => `${x.ip} ${x.duid ?? x.mac ?? ''}`,
  });
  const certs = new PlatformObjects({
    dir: d.directory,
    path: ['PKI', 'Certificates'],
    kind: 'pki.cert',
    schemaVersion: 1,
    data: pkiCert,
    name: () => 'pki.cert',
  });
  const all = async <T>(s: { list(): Promise<Stored<T>[]> }): Promise<Stored<T>[]> =>
    s.list().catch((e: unknown) => {
      // the containers appear with the first object
      if (e instanceof PlatformError && e.code === 'request.not-found') return [];
      throw e;
    });
  const write = (c: Ctx): void => {
    c.require('dhcp.write');
  };
  const actor = (c: Ctx) => ({ sid: c.user.sid, name: c.user.username });
  const audit = (c: Ctx, action: string, id: string, before: unknown, after: unknown): void => {
    d.audit.append({
      actor: c.user.username,
      actorSid: c.user.sid,
      sourceIp: c.ip,
      action,
      result: 'success',
      before,
      after: after === null ? null : { id, ...(after as object) },
      requestId: c.requestId,
    });
  };
  const invalid = (issues: string): never => {
    throw new PlatformError('validation.invalid', { issues });
  };

  /** Servers are computer accounts; their host names come from the directory. */
  const checkService = async (s: DhcpService): Promise<DhcpService> => {
    const dir = d.directory();
    const servers = [];
    for (const x of s.servers) {
      const e = await dir.entryByGuid(x.nodeGuid, ['objectClass', 'dNSHostName']).catch(() => null);
      if (!e || typeof e.dNSHostName !== 'string' || typeOf(e) !== 'computer')
        invalid(`servers: ${x.nodeGuid} is not a computer with a DNS host name`);
      servers.push({ nodeGuid: x.nodeGuid.toLowerCase(), host: String(e?.dNSHostName).toLowerCase() });
    }
    if (new Set(servers.map((x) => x.nodeGuid)).size !== servers.length) invalid('servers: the same computer twice');
    // the HA channel carries lease updates: mutual TLS with node certificates, never plain HTTP
    if (servers.length === 2) {
      const now = new Date().toISOString();
      const valid = (await all(certs)).filter(
        (c) => c.data.profile === 'node' && !c.data.revoked && c.data.notAfter > now,
      );
      for (const x of servers)
        if (!valid.some((c) => c.data.nodeGuid?.toLowerCase() === x.nodeGuid))
          invalid(
            `servers: ${x.host} has no node certificate for the HA channel (members get theirs with node enrolment)`,
          );
    }
    return { ...s, servers };
  };
  const checkSubnet = async (s: DhcpSubnet, self: string | null): Promise<void> => {
    if (!(await all(services)).some((x) => x.id === s.serviceId)) invalid(`serviceId: no DHCP service ${s.serviceId}`);
    const mine = parseCidr(s.cidr);
    const end = (n: ReturnType<typeof parseCidr>) => n.last + 1;
    for (const o of await all(subnets)) {
      if (o.id === self || o.data.serviceId !== s.serviceId) continue;
      const other = parseCidr(o.data.cidr);
      if (mine.network <= end(other) && other.network <= end(mine)) invalid(`cidr: overlaps ${o.data.cidr}`);
    }
  };
  const checkSubnet6 = async (s: DhcpSubnet6, self: string | null): Promise<void> => {
    const svc = (await all(services)).find((x) => x.id === s.serviceId);
    if (!svc) return invalid(`serviceId: no DHCP service ${s.serviceId}`);
    if (s.interface === null && svc.data.interfaces.length > 1)
      invalid(`interface: the service listens on ${svc.data.interfaces.join(', ')}; name the subnet's link`);
    if (s.interface !== null && !svc.data.interfaces.includes(s.interface))
      invalid(`interface: ${s.interface} is not one of the service's interfaces (${svc.data.interfaces.join(', ')})`);
    const mine = parseCidr6(s.prefix);
    for (const o of await all(subnets6)) {
      if (o.id === self || o.data.serviceId !== s.serviceId) continue;
      const other = parseCidr6(o.data.prefix);
      if (mine.network <= other.last && other.network <= mine.last) invalid(`prefix: overlaps ${o.data.prefix}`);
    }
  };
  const checkReservation6 = async (r: DhcpReservation6, self: string | null): Promise<void> => {
    const subnet = (await all(subnets6)).find((s) => s.id === r.subnetId);
    if (!subnet) return invalid(`subnetId: no IPv6 subnet ${r.subnetId}`);
    if (!inSubnet6(subnet.data.prefix, r.ip)) invalid(`ip: not an address of ${subnet.data.prefix}`);
    for (const o of await all(reservations6)) {
      if (o.id === self || o.data.subnetId !== r.subnetId) continue;
      if (o.data.ip === r.ip) invalid(`ip: ${r.ip} is already reserved`);
      if (r.duid && o.data.duid === r.duid) invalid(`duid: ${r.duid} already has ${o.data.ip}`);
      if (r.mac && o.data.mac === r.mac) invalid(`mac: ${r.mac} already has ${o.data.ip}`);
    }
  };
  const checkReservation = async (r: DhcpReservation, self: string | null): Promise<void> => {
    const subnet = (await all(subnets)).find((s) => s.id === r.subnetId);
    if (!subnet) return invalid(`subnetId: no DHCP subnet ${r.subnetId}`);
    if (!inSubnet(subnet.data.cidr, r.ip)) invalid(`ip: not a host address of ${subnet.data.cidr}`);
    for (const o of await all(reservations)) {
      if (o.id === self || o.data.subnetId !== r.subnetId) continue;
      if (o.data.ip === r.ip) invalid(`ip: ${r.ip} is already reserved for ${o.data.mac}`);
      if (o.data.mac === r.mac) invalid(`mac: ${r.mac} already has ${o.data.ip}`);
    }
  };

  const order6 = (a: string, b: string): number => {
    const x = ip6ToBig(a);
    const y = ip6ToBig(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };

  t.add({
    method: 'GET',
    url: '/api/v1/dhcp',
    operationId: 'getDhcp',
    summary: 'DHCP services, subnets and reservations',
    tags: ['dhcp'],
    auth: { permission: 'dhcp.read' },
    response: dhcpOverview,
    handler: async () => ({
      services: (await all(services)).map((x) => ({ id: x.id, ...x.data })),
      subnets: (await all(subnets))
        .map((x) => ({ id: x.id, ...x.data }))
        .sort((a, b) => ipToInt(a.cidr.split('/')[0] ?? '0.0.0.0') - ipToInt(b.cidr.split('/')[0] ?? '0.0.0.0')),
      reservations: (await all(reservations))
        .map((x) => ({ id: x.id, ...x.data }))
        .sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip)),
      subnets6: (await all(subnets6))
        .map((x) => ({ id: x.id, ...x.data }))
        .sort((a, b) => order6(a.prefix.split('/')[0] ?? '::', b.prefix.split('/')[0] ?? '::')),
      reservations6: (await all(reservations6))
        .map((x) => ({ id: x.id, ...x.data }))
        .sort((a, b) => order6(a.ip, b.ip)),
    }),
  });

  const crud = <S extends z.ZodType>(o: {
    path: string;
    what: string;
    store: PlatformObjects<S>;
    schema: S;
    check: (data: z.output<S>, self: string | null) => Promise<z.output<S> | undefined>;
    inUse: (id: string) => Promise<string | null>;
  }) => {
    t.add({
      method: 'POST',
      url: `/api/v1/dhcp/${o.path}`,
      operationId: `create${o.what}`,
      summary: `Create a DHCP ${o.what.toLowerCase()}`,
      tags: ['dhcp'],
      auth: 'session',
      body: o.schema,
      response: created,
      status: 201,
      handler: async (c) => {
        write(c);
        const data = ((await o.check(c.body as z.output<S>, null)) ?? c.body) as z.output<S>;
        const id = await o.store.create(actor(c), data);
        audit(c, `dhcp.${o.path}.create`, id, null, data);
        return { id };
      },
    });
    t.add({
      method: 'PUT',
      url: `/api/v1/dhcp/${o.path}/:id`,
      operationId: `update${o.what}`,
      summary: `Change a DHCP ${o.what.toLowerCase()}`,
      tags: ['dhcp'],
      auth: 'session',
      params: idParams,
      body: o.schema,
      response: empty,
      handler: async (c) => {
        write(c);
        const cur = await o.store.get(c.params.id);
        const data = ((await o.check(c.body as z.output<S>, cur.id)) ?? c.body) as z.output<S>;
        await o.store.update(actor(c), cur, data);
        audit(c, `dhcp.${o.path}.update`, cur.id, cur.data, data);
        return {};
      },
    });
    t.add({
      method: 'DELETE',
      url: `/api/v1/dhcp/${o.path}/:id`,
      operationId: `delete${o.what}`,
      summary: `Delete a DHCP ${o.what.toLowerCase()}`,
      tags: ['dhcp'],
      auth: 'session',
      params: idParams,
      response: empty,
      handler: async (c) => {
        write(c);
        const cur = await o.store.get(c.params.id);
        const used = await o.inUse(cur.id);
        if (used) invalid(`still used by ${used}`);
        await o.store.delete(cur);
        audit(c, `dhcp.${o.path}.delete`, cur.id, cur.data, null);
        return {};
      },
    });
  };

  crud({
    path: 'services',
    what: 'Service',
    store: services,
    schema: dhcpService,
    check: (s) => checkService(s),
    inUse: async (id) => {
      const n =
        (await all(subnets)).filter((s) => s.data.serviceId === id).length +
        (await all(subnets6)).filter((s) => s.data.serviceId === id).length;
      return n ? `${String(n)} subnet(s)` : null;
    },
  });
  crud({
    path: 'subnets',
    what: 'Subnet',
    store: subnets,
    schema: dhcpSubnet,
    check: async (s, self) => {
      await checkSubnet(s, self);
      return undefined;
    },
    inUse: async (id) => {
      const n = (await all(reservations)).filter((r) => r.data.subnetId === id).length;
      return n ? `${String(n)} reservation(s)` : null;
    },
  });
  crud({
    path: 'reservations',
    what: 'Reservation',
    store: reservations,
    schema: dhcpReservation,
    check: async (r, self) => {
      await checkReservation(r, self);
      return undefined;
    },
    inUse: () => Promise.resolve(null),
  });
  crud({
    path: 'subnets6',
    what: 'Subnet6',
    store: subnets6,
    schema: dhcpSubnet6,
    check: async (s, self) => {
      await checkSubnet6(s, self);
      return undefined;
    },
    inUse: async (id) => {
      const n = (await all(reservations6)).filter((r) => r.data.subnetId === id).length;
      return n ? `${String(n)} reservation(s)` : null;
    },
  });
  crud({
    path: 'reservations6',
    what: 'Reservation6',
    store: reservations6,
    schema: dhcpReservation6,
    check: async (r, self) => {
      await checkReservation6(r, self);
      return undefined;
    },
    inUse: () => Promise.resolve(null),
  });

  t.add({
    method: 'GET',
    url: '/api/v1/dhcp/leases',
    operationId: 'listDhcpLeases',
    summary: "This node's leases (its own Kea)",
    tags: ['dhcp'],
    auth: { permission: 'dhcp.read' },
    response: leases,
    handler: async (c) =>
      d.agent().call('dhcp.leases', {}, { actor: { name: c.user.username, sid: c.user.sid, via: 'api' } }),
  });
}
