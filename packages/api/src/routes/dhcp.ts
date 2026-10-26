// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /api/v1/dhcp (ROADMAP Phase 3): services, subnets and reservations are platform objects under CN=DHCP; the
 * serving nodes' watchers render Kea from them. Checks across objects happen here: servers are computer accounts
 * (their host names come from the directory), subnets of a service don't overlap, a reservation's address lies in
 * its subnet and is unique there, and nothing is deleted while something still refers to it. Leases are this
 * node's (its own Kea).
 */
import { PlatformError } from '@opendc/shared';
import type { AgentClient } from '@opendc/shared/agent';
import { empty, idParams } from '@opendc/shared/api';
import {
  dhcpReservation,
  dhcpService,
  dhcpSubnet,
  inSubnet,
  ipToInt,
  parseCidr,
  type DhcpReservation,
  type DhcpService,
  type DhcpSubnet,
} from '@opendc/shared/dhcp';
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
});
const leases = z.object({
  leases: z.array(
    z.object({
      ip: z.string(),
      mac: z.string(),
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
      const n = (await all(subnets)).filter((s) => s.data.serviceId === id).length;
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
