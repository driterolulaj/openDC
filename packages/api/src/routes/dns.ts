// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /api/v1/dns (ROADMAP Phase 3, Spike S3): zones and records are read over LDAP from the DNS partitions and
 * decoded here; changes go through the agent (`samba-tool dns` on this DC). Records that domain controllers
 * register for themselves (SRV, _msdcs, their A records) can only be changed with a tier-0 role. The diagnostics
 * ask every DC's DNS server for the records every writable DC needs (Samba's dns_update_list) and offer to
 * re-create missing ones.
 */
import { Resolver, lookup } from 'node:dns/promises';
import { PlatformError } from '@opendc/shared';
import { mintConfirmation, type AgentClient } from '@opendc/shared/agent';
import {
  dnsDiagnostics,
  dnsRecords,
  dnsRepair,
  dnsRepairResult,
  dnsZones,
  empty,
  recordAdd,
  recordAdded,
  recordDelete,
  recordUpdate,
  zoneAging,
  zoneCreate,
  zoneDelete,
  zoneParams,
  type DnsDiagnostics,
} from '@opendc/shared/api';
import {
  decodeDnsRecord,
  expectedDcRecords,
  isDcRecordName,
  ownerName,
  sambaToolData,
  type DcFacts,
  type ExpectedRecord,
  type RecordData,
} from '@opendc/shared/dns';
import { eq, guidFromBytes } from '@opendc/shared/ldap';
import type { Entry } from 'ldapts';
import type { AuditLog } from '../audit.ts';
import type { RouteContext, RouteTable } from '../http/route.ts';
import type { DirectoryService } from '../directory/service.ts';

type Ctx = RouteContext<unknown, unknown, unknown>;
const first = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? '') : typeof v === 'string' ? v : '');
const lower = (s: string): string => s.toLowerCase();
const dnsName = (dn: string): string =>
  dn
    .split(',')
    .filter((p) => /^dc=/i.test(p))
    .map((p) => p.slice(3))
    .join('.');

interface Forest {
  domainDn: string;
  forestDn: string;
  configDn: string;
  dnsDomain: string;
  dnsForest: string;
}

export function dnsRoutes(
  t: RouteTable,
  d: {
    directory: () => DirectoryService;
    agent: () => Pick<AgentClient, 'call'>;
    audit: AuditLog;
    confirmKey: Buffer;
    /** resolves DC host names (the system resolver on a DC asks the DC itself) */
    resolveHost?: (name: string) => Promise<string[]>;
    /** a resolver that asks one DNS server */
    resolverFor?: (
      server: string,
    ) => Pick<Resolver, 'resolveSrv' | 'resolve4' | 'resolve6' | 'resolveCname' | 'resolveNs'>;
  },
): void {
  const resolveHost =
    d.resolveHost ??
    (async (name: string) => (await lookup(name, { all: true }).catch(() => [])).map((a) => a.address));
  const resolverFor =
    d.resolverFor ??
    ((server: string) => {
      const r = new Resolver({ timeout: 2000, tries: 1 });
      r.setServers([server]);
      return r;
    });

  const forest = async (): Promise<Forest> => {
    const dir = d.directory();
    const [dse] = await dir.ldap.search('', {
      scope: 'base',
      attributes: ['rootDomainNamingContext', 'configurationNamingContext'],
    });
    const forestDn = first(dse?.rootDomainNamingContext) || dir.domainDn;
    return {
      domainDn: dir.domainDn,
      forestDn,
      configDn: first(dse?.configurationNamingContext) || `CN=Configuration,${forestDn}`,
      dnsDomain: dnsName(dir.domainDn),
      dnsForest: dnsName(forestDn),
    };
  };
  const partitions = (f: Forest) => [
    { partition: 'domain' as const, dn: `CN=MicrosoftDNS,DC=DomainDnsZones,${f.domainDn}` },
    { partition: 'forest' as const, dn: `CN=MicrosoftDNS,DC=ForestDnsZones,${f.forestDn}` },
  ];

  const listZones = async (f: Forest) => {
    const dir = d.directory();
    const ad = new Set([lower(f.dnsDomain), lower(`_msdcs.${f.dnsForest}`)]);
    const zones: { name: string; dn: string; partition: 'domain' | 'forest'; reverse: boolean; ad: boolean }[] = [];
    for (const p of partitions(f)) {
      const found = await dir.ldap
        .search(p.dn, { scope: 'one', filter: eq('objectClass', 'dnsZone'), attributes: ['name'] })
        .catch(() => [] as Entry[]);
      for (const e of found) {
        const name = first(e.name);
        if (!name || name === 'RootDNSServers' || name.startsWith('..')) continue;
        zones.push({
          name,
          dn: e.dn,
          partition: p.partition,
          reverse: /\.(in-addr|ip6)\.arpa$/i.test(name),
          ad: ad.has(lower(name)),
        });
      }
    }
    return zones;
  };
  const zoneOf = async (f: Forest, name: string) => {
    const z = (await listZones(f)).find((x) => lower(x.name) === lower(name));
    if (!z) throw new PlatformError('dns.not-found', { what: `Zone ${name}` });
    return z;
  };

  const dcHostnames = async (f: Forest): Promise<string[]> =>
    (
      await d.directory().ldap.search(`CN=Sites,${f.configDn}`, {
        scope: 'sub',
        filter: eq('objectClass', 'server'),
        attributes: ['dNSHostName'],
      })
    )
      .map((e) => first(e.dNSHostName))
      .filter(Boolean);

  const audit = (c: Ctx, action: string, after: unknown, before: unknown = null): void => {
    d.audit.append({
      actor: c.user.username,
      actorSid: c.user.sid,
      sourceIp: c.ip,
      action,
      result: 'success',
      before,
      after,
      requestId: c.requestId,
    });
  };
  const actor = (c: Ctx) => ({ name: c.user.username, sid: c.user.sid, via: 'api' as const });

  /** Records DCs register for themselves need a tier-0 role (they steer logons). */
  const requireWrite = async (c: Ctx, f: Forest, zone: string, name: string): Promise<void> => {
    const owner = ownerName(name, zone);
    const prot = isDcRecordName(owner, {
      dnsDomain: f.dnsDomain,
      dnsForest: f.dnsForest,
      dcHostnames: await dcHostnames(f),
    });
    c.require('dns.records.write', prot ? { protected: true, label: owner } : undefined);
  };

  // ---------------------------------------------------------------- zones

  t.add({
    method: 'GET',
    url: '/api/v1/dns/zones',
    operationId: 'listDnsZones',
    summary: 'DNS zones in the domain and forest DNS partitions',
    tags: ['dns'],
    auth: { permission: 'dns.zones.read' },
    response: dnsZones,
    handler: async () => ({
      zones: (await listZones(await forest())).map(({ dn: _dn, ...z }) => z),
    }),
  });

  t.add({
    method: 'POST',
    url: '/api/v1/dns/zones',
    operationId: 'createDnsZone',
    summary: 'Create a forward or reverse zone (AD-integrated, domain partition)',
    tags: ['dns'],
    auth: { permission: 'dns.zones.manage' },
    body: zoneCreate,
    response: empty,
    status: 201,
    handler: async (c) => {
      await d.agent().call('dns.zone.create', { zone: c.body.zone }, { actor: actor(c) });
      audit(c, 'dns.zone.create', { zone: c.body.zone });
      return {};
    },
  });

  t.add({
    method: 'DELETE',
    url: '/api/v1/dns/zones/:zone',
    operationId: 'deleteDnsZone',
    summary: 'Delete a zone and all its records (type the zone name to confirm)',
    tags: ['dns'],
    auth: { permission: 'dns.zones.manage' },
    params: zoneParams,
    body: zoneDelete,
    response: empty,
    handler: async (c) => {
      const f = await forest();
      const z = await zoneOf(f, c.params.zone);
      if (z.ad) throw new PlatformError('dns.protected', { what: `Zone ${z.name}` });
      if (lower(c.body.confirm.trim()) !== lower(z.name))
        throw new PlatformError('agent.confirmation-required', { op: 'dns.zone.delete' });
      const args = { zone: z.name };
      const confirmation = mintConfirmation(d.confirmKey, { op: 'dns.zone.delete', args, actor: c.user.sid });
      await d.agent().call('dns.zone.delete', args, { actor: actor(c), confirmation });
      audit(c, 'dns.zone.delete', null, { zone: z.name });
      return {};
    },
  });

  t.add({
    method: 'PUT',
    url: '/api/v1/dns/zones/:zone/aging',
    operationId: 'setDnsZoneAging',
    summary: 'Aging and scavenging of dynamically registered records',
    tags: ['dns'],
    auth: { permission: 'dns.zones.manage' },
    params: zoneParams,
    body: zoneAging,
    response: empty,
    handler: async (c) => {
      const z = await zoneOf(await forest(), c.params.zone);
      await d.agent().call('dns.zone.setAging', { zone: z.name, ...c.body }, { actor: actor(c) });
      audit(c, 'dns.zone.aging', { zone: z.name, ...c.body });
      return {};
    },
  });

  // ---------------------------------------------------------------- records

  t.add({
    method: 'GET',
    url: '/api/v1/dns/zones/:zone/records',
    operationId: 'listDnsRecords',
    summary: 'The records of a zone (tombstoned ones left out)',
    tags: ['dns'],
    auth: { permission: 'dns.zones.read' },
    params: zoneParams,
    response: dnsRecords,
    handler: async (c) => {
      const f = await forest();
      const z = await zoneOf(f, c.params.zone);
      const hosts = await dcHostnames(f);
      const nodes = await d.directory().ldap.search(z.dn, {
        scope: 'one',
        filter: eq('objectClass', 'dnsNode'),
        attributes: ['name', 'dnsRecord', 'dNSTombstoned'],
        buffers: ['dnsRecord'],
      });
      const records = nodes.flatMap((n) => {
        if (first(n.dNSTombstoned).toUpperCase() === 'TRUE') return [];
        const name = first(n.name);
        const blobs = (Array.isArray(n.dnsRecord) ? n.dnsRecord : [n.dnsRecord]).filter((b): b is Buffer =>
          Buffer.isBuffer(b),
        );
        const prot = isDcRecordName(ownerName(name, z.name), {
          dnsDomain: f.dnsDomain,
          dnsForest: f.dnsForest,
          dcHostnames: hosts,
        });
        return blobs.flatMap((b) => {
          const r = decodeDnsRecord(b);
          if (!r) return [];
          const { ttl, dynamic, ...record } = r;
          return [{ name, record, ttl, dynamic, protected: prot }];
        });
      });
      records.sort((a, b) => (a.name === '@' ? -1 : b.name === '@' ? 1 : a.name.localeCompare(b.name)));
      return { zone: z.name, records };
    },
  });

  /** The reverse zone and name for an address, if such a zone exists. */
  const reverseOf = async (f: Forest, r: RecordData): Promise<{ zone: string; name: string } | null> => {
    if (r.type !== 'A') return null;
    const labels = r.address.split('.').reverse();
    const zones = (await listZones(f)).filter((z) => z.reverse);
    for (let keep = 1; keep < 4; keep++) {
      const zone = `${labels.slice(keep).join('.')}.in-addr.arpa`;
      if (zones.some((z) => lower(z.name) === zone)) return { zone, name: labels.slice(0, keep).join('.') };
    }
    return null;
  };

  t.add({
    method: 'POST',
    url: '/api/v1/dns/zones/:zone/records',
    operationId: 'addDnsRecord',
    summary: 'Add a record (A records optionally with their PTR record)',
    tags: ['dns'],
    auth: 'session',
    params: zoneParams,
    body: recordAdd,
    response: recordAdded,
    status: 201,
    handler: async (c) => {
      const f = await forest();
      const z = await zoneOf(f, c.params.zone);
      await requireWrite(c, f, z.name, c.body.name);
      await d
        .agent()
        .call('dns.record.add', { zone: z.name, name: c.body.name, record: c.body.record }, { actor: actor(c) });
      let ptr: string | null = null;
      if (c.body.ptr) {
        const rev = await reverseOf(f, c.body.record);
        if (rev) {
          const target = ownerName(c.body.name, z.name);
          await d
            .agent()
            .call(
              'dns.record.add',
              { zone: rev.zone, name: rev.name, record: { type: 'PTR', target } },
              { actor: actor(c) },
            )
            .catch((e: unknown) => {
              // an existing PTR is fine; anything else is reported
              if (!(e instanceof PlatformError && e.code === 'dns.record-exists')) throw e;
            });
          ptr = `${rev.name}.${rev.zone}`;
        }
      }
      audit(c, 'dns.record.add', {
        zone: z.name,
        name: c.body.name,
        data: sambaToolData(c.body.record),
        type: c.body.record.type,
        ptr,
      });
      return { ptr };
    },
  });

  t.add({
    method: 'PUT',
    url: '/api/v1/dns/zones/:zone/records',
    operationId: 'updateDnsRecord',
    summary: 'Change a record (same name and type)',
    tags: ['dns'],
    auth: 'session',
    params: zoneParams,
    body: recordUpdate,
    response: empty,
    handler: async (c) => {
      const f = await forest();
      const z = await zoneOf(f, c.params.zone);
      await requireWrite(c, f, z.name, c.body.name);
      await d
        .agent()
        .call(
          'dns.record.update',
          { zone: z.name, name: c.body.name, from: c.body.from, to: c.body.to },
          { actor: actor(c) },
        );
      audit(
        c,
        'dns.record.update',
        { zone: z.name, name: c.body.name, data: sambaToolData(c.body.to) },
        { data: sambaToolData(c.body.from) },
      );
      return {};
    },
  });

  t.add({
    method: 'DELETE',
    url: '/api/v1/dns/zones/:zone/records',
    operationId: 'deleteDnsRecord',
    summary: 'Delete a record',
    tags: ['dns'],
    auth: 'session',
    params: zoneParams,
    body: recordDelete,
    response: empty,
    handler: async (c) => {
      const f = await forest();
      const z = await zoneOf(f, c.params.zone);
      await requireWrite(c, f, z.name, c.body.name);
      await d
        .agent()
        .call('dns.record.delete', { zone: z.name, name: c.body.name, record: c.body.record }, { actor: actor(c) });
      audit(c, 'dns.record.delete', null, {
        zone: z.name,
        name: c.body.name,
        type: c.body.record.type,
        data: sambaToolData(c.body.record),
      });
      return {};
    },
  });

  // ---------------------------------------------------------------- diagnostics

  /** Writable DCs: host name, NTDS GUID, site, PDC, GC (from the configuration NC). */
  const dcFacts = async (f: Forest): Promise<Omit<DcFacts, 'addresses'>[]> => {
    const dir = d.directory();
    const ntds = await dir.ldap.search(`CN=Sites,${f.configDn}`, {
      scope: 'sub',
      filter: eq('objectClass', 'nTDSDSA'),
      attributes: ['objectGUID', 'options', 'objectCategory'],
      buffers: ['objectGUID'],
    });
    const [head] = await dir.ldap.search(f.domainDn, { scope: 'base', attributes: ['fSMORoleOwner'] });
    const pdc = lower(first(head?.fSMORoleOwner));
    const out: Omit<DcFacts, 'addresses'>[] = [];
    for (const n of ntds) {
      if (/NTDS-DSA-RO/i.test(first(n.objectCategory))) continue; // RODCs register less (Phase 4)
      const serverDn = n.dn.slice(n.dn.indexOf(',') + 1);
      const [server] = await dir.ldap.search(serverDn, { scope: 'base', attributes: ['dNSHostName'] });
      const hostname = first(server?.dNSHostName);
      const site = /CN=Servers,CN=([^,]+),CN=Sites/i.exec(n.dn)?.[1] ?? 'Default-First-Site-Name';
      const g = n.objectGUID;
      if (!hostname || !Buffer.isBuffer(g)) continue;
      out.push({
        hostname,
        ntdsGuid: guidFromBytes(g),
        site,
        pdc: lower(n.dn) === pdc,
        gc: (Number(first(n.options)) & 1) === 1,
      });
    }
    return out;
  };

  const has = async (r: ReturnType<typeof resolverFor>, e: ExpectedRecord): Promise<boolean> => {
    const n = (s: string): string => lower(s).replace(/\.$/, '');
    const rec = e.record;
    try {
      switch (rec.type) {
        case 'SRV':
          return (await r.resolveSrv(e.name)).some((x) => n(x.name) === n(rec.target) && x.port === rec.port);
        case 'A':
          return (await r.resolve4(e.name)).includes(rec.address);
        case 'AAAA':
          return (await r.resolve6(e.name)).some((a) => n(a) === n(rec.address));
        case 'CNAME':
          return (await r.resolveCname(e.name)).some((x) => n(x) === n(rec.target));
        case 'NS':
          return (await r.resolveNs(e.name)).some((x) => n(x) === n(rec.target));
        default:
          return true;
      }
    } catch {
      return false;
    }
  };

  const diagnose = async (): Promise<DnsDiagnostics> => {
    const f = await forest();
    const [head] = await d.directory().ldap.search(f.domainDn, {
      scope: 'base',
      attributes: ['objectGUID'],
      buffers: ['objectGUID'],
    });
    const domainGuid = Buffer.isBuffer(head?.objectGUID) ? guidFromBytes(head.objectGUID) : '';
    const dcs = await dcFacts(f);
    const servers: { dc: string; address: string | null }[] = [];
    const facts: DcFacts[] = [];
    const checks: DnsDiagnostics['checks'] = [];
    for (const dc of dcs) {
      const addresses = (await resolveHost(dc.hostname)).filter((a) => !a.startsWith('127.') && a !== '::1');
      servers.push({ dc: dc.hostname, address: addresses.find((a) => !a.includes(':')) ?? addresses[0] ?? null });
      facts.push({ ...dc, addresses });
      if (!addresses.length)
        checks.push({
          kind: 'address',
          status: 'fail',
          dc: dc.hostname,
          name: dc.hostname,
          record: null,
          missingOn: [],
        });
    }
    const asking = servers.filter((s): s is { dc: string; address: string } => s.address !== null);
    for (const dc of facts) {
      for (const e of expectedDcRecords(dc, { dnsDomain: f.dnsDomain, dnsForest: f.dnsForest, domainGuid })) {
        const missingOn: string[] = [];
        for (const s of asking) if (!(await has(resolverFor(s.address), e))) missingOn.push(s.dc);
        checks.push({
          kind: 'record',
          status: missingOn.length === 0 ? 'pass' : missingOn.length === asking.length ? 'fail' : 'warn',
          dc: dc.hostname,
          name: e.name,
          record: e.record,
          missingOn,
        });
      }
    }
    // the DNS servers can resolve Internet names (forwarders)
    for (const s of asking) {
      const ok = await resolverFor(s.address)
        .resolve4('example.com')
        .then(
          (x) => x.length > 0,
          () => false,
        );
      checks.push({
        kind: 'forwarder',
        status: ok ? 'pass' : 'warn',
        dc: s.dc,
        name: 'example.com',
        record: null,
        missingOn: ok ? [] : [s.dc],
      });
    }
    const summary: DnsDiagnostics['summary'] = [];
    for (const ch of checks) {
      if (ch.status === 'pass') continue;
      if (ch.kind === 'record' && ch.record)
        summary.push({
          status: ch.status,
          message: `${ch.record.type} ${ch.name} → ${sambaToolData(ch.record)} (${ch.dc ?? '?'}) is missing on ${ch.missingOn.join(', ')}`,
          fix:
            ch.status === 'fail'
              ? `Re-create the record ("Repair" below), or run samba_dnsupdate --verbose on ${ch.dc ?? 'the DC'}.`
              : 'Missing on some DCs only: wait for replication (a few minutes), then check again.',
        });
      else if (ch.kind === 'address')
        summary.push({
          status: 'fail',
          message: `${ch.name} has no address in DNS`,
          fix: `Run samba_dnsupdate --verbose on ${ch.name}, or add its A record in the domain zone.`,
        });
      else if (ch.kind === 'forwarder')
        summary.push({
          status: 'warn',
          message: `The DNS server on ${ch.dc ?? '?'} doesn't resolve Internet names`,
          fix: 'Check the DNS forwarders (dns forwarder in smb.conf) and the network path to them.',
        });
    }
    return { servers, checks, summary };
  };

  t.add({
    method: 'GET',
    url: '/api/v1/dns/diagnostics',
    operationId: 'getDnsDiagnostics',
    summary: "Checks every DC's DNS server for the records each writable DC needs, and Internet resolution",
    tags: ['dns'],
    auth: { permission: 'dns.zones.read' },
    response: dnsDiagnostics,
    handler: diagnose,
  });

  t.add({
    method: 'POST',
    url: '/api/v1/dns/diagnostics/repair',
    operationId: 'repairDnsRecords',
    summary: 'Re-create missing DC records (tier 0)',
    tags: ['dns'],
    auth: 'session',
    body: dnsRepair,
    response: dnsRepairResult,
    handler: async (c) => {
      c.require('dns.records.write', { protected: true, label: 'DC DNS records' });
      const f = await forest();
      const zones = (await listZones(f)).map((z) => z.name).sort((a, b) => b.length - a.length);
      const added: string[] = [];
      const failed: { name: string; error: string }[] = [];
      for (const r of c.body.records) {
        // the longest zone that contains the name
        const zone = zones.find((z) => lower(r.name) === lower(z) || lower(r.name).endsWith(`.${lower(z)}`));
        if (!zone) {
          failed.push({ name: r.name, error: 'no zone for this name' });
          continue;
        }
        const name = lower(r.name) === lower(zone) ? '@' : r.name.slice(0, r.name.length - zone.length - 1);
        try {
          await d.agent().call('dns.record.add', { zone, name, record: r.record }, { actor: actor(c) });
          added.push(`${r.record.type} ${r.name}`);
        } catch (e) {
          if (e instanceof PlatformError && e.code === 'dns.record-exists') added.push(`${r.record.type} ${r.name}`);
          else failed.push({ name: r.name, error: e instanceof PlatformError ? e.code : 'internal' });
        }
      }
      audit(c, 'dns.repair', { added, failed });
      return { added, failed };
    },
  });
}
