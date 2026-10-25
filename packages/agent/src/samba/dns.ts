// SPDX-License-Identifier: AGPL-3.0-only
/**
 * DNS operations (agent-operations.md §3.4, Spike S3): `samba-tool dns … -P` against this DC's own DNS server
 * with the machine account. Every argument is validated by the operation's schema; record data is rendered by
 * `sambaToolData` (one argv element). The zones Active Directory needs can't be deleted here.
 */
import { PlatformError } from '@opendc/shared';
import type { OpParsedArgs, OpResult } from '@opendc/shared/agent';
import { sambaToolData, type RecordData } from '@opendc/shared/dns';
import { first } from './ldif.ts';
import type { SambaLocal } from './local.ts';

const SERVER = 'localhost';

/** The zones of the domain itself (the domain zone and the forest's _msdcs zone). */
async function adZones(samba: SambaLocal): Promise<string[]> {
  const dse = await samba.rootDse();
  const toDns = (dn: string | null): string =>
    (dn ?? '')
      .split(',')
      .filter((p) => /^dc=/i.test(p))
      .map((p) => p.slice(3))
      .join('.')
      .toLowerCase();
  const domain = toDns(first(dse, 'defaultNamingContext'));
  const forest = toDns((first(dse, 'configurationNamingContext') ?? '').replace(/^CN=Configuration,/i, ''));
  return [domain, `_msdcs.${forest}`];
}

/** Runs samba-tool dns and turns its WERR codes into catalogue errors. */
async function dns(samba: SambaLocal, argv: string[], ctx: { zone: string; what: string }): Promise<string> {
  try {
    return await samba.tool(['dns', ...argv, '-P']);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/RECORD_ALREADY_EXISTS|ZONE_ALREADY_EXISTS/.test(msg))
      throw new PlatformError('dns.record-exists', { record: ctx.what, zone: ctx.zone }, { cause: e });
    if (/RECORD_DOES_NOT_EXIST|ZONE_DOES_NOT_EXIST|NAME_DOES_NOT_EXIST|Record does not exist/i.test(msg))
      throw new PlatformError('dns.not-found', { what: ctx.what }, { cause: e });
    throw new PlatformError(
      'dns.failed',
      { reason: msg.split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 200) ?? '?' },
      { cause: e },
    );
  }
}

const describe = (name: string, r: RecordData): string => `${name} ${r.type} ${sambaToolData(r)}`;

export async function zoneList(samba: SambaLocal): Promise<OpResult<'dns.zone.list'>> {
  const out = await dns(samba, ['zonelist', SERVER], { zone: '-', what: 'zones' });
  const zones: OpResult<'dns.zone.list'>['zones'] = [];
  for (const block of out.split(/\n\s*\n/)) {
    const name = /pszZoneName\s*:\s*(\S+)/.exec(block)?.[1];
    if (!name) continue;
    zones.push({ name, reverse: /in-addr\.arpa$|ip6\.arpa$/i.test(name) || /REVERSE/.test(block) });
  }
  return { zones };
}

export async function zoneCreate(
  samba: SambaLocal,
  a: OpParsedArgs<'dns.zone.create'>,
): Promise<OpResult<'dns.zone.create'>> {
  await dns(samba, ['zonecreate', SERVER, a.zone], { zone: a.zone, what: `Zone ${a.zone}` });
  return { zone: a.zone };
}

export async function zoneDelete(
  samba: SambaLocal,
  a: OpParsedArgs<'dns.zone.delete'>,
): Promise<OpResult<'dns.zone.delete'>> {
  if ((await adZones(samba)).includes(a.zone.toLowerCase()))
    throw new PlatformError('dns.protected', { what: `Zone ${a.zone}` });
  await dns(samba, ['zonedelete', SERVER, a.zone], { zone: a.zone, what: `Zone ${a.zone}` });
  return { zone: a.zone };
}

export async function recordAdd(
  samba: SambaLocal,
  a: OpParsedArgs<'dns.record.add'>,
): Promise<OpResult<'dns.record.add'>> {
  const r = a.record;
  await dns(samba, ['add', SERVER, a.zone, a.name, r.type, sambaToolData(r)], {
    zone: a.zone,
    what: describe(a.name, r),
  });
  return { zone: a.zone, name: a.name };
}

export async function recordUpdate(
  samba: SambaLocal,
  a: OpParsedArgs<'dns.record.update'>,
): Promise<OpResult<'dns.record.update'>> {
  const from = a.from;
  const to = a.to;
  if (from.type !== to.type) throw new PlatformError('validation.invalid', { issues: "a record's type can't change" });
  await dns(samba, ['update', SERVER, a.zone, a.name, from.type, sambaToolData(from), sambaToolData(to)], {
    zone: a.zone,
    what: describe(a.name, from),
  });
  return { zone: a.zone, name: a.name };
}

export async function recordDelete(
  samba: SambaLocal,
  a: OpParsedArgs<'dns.record.delete'>,
): Promise<OpResult<'dns.record.delete'>> {
  const r = a.record;
  await dns(samba, ['delete', SERVER, a.zone, a.name, r.type, sambaToolData(r)], {
    zone: a.zone,
    what: describe(a.name, r),
  });
  return { zone: a.zone, name: a.name };
}

export async function zoneSetAging(
  samba: SambaLocal,
  a: OpParsedArgs<'dns.zone.setAging'>,
): Promise<OpResult<'dns.zone.setAging'>> {
  await dns(
    samba,
    [
      'zoneoptions',
      SERVER,
      a.zone,
      `--aging=${a.aging ? '1' : '0'}`,
      `--refreshinterval=${String(a.refreshHours)}`,
      `--norefreshinterval=${String(a.noRefreshHours)}`,
    ],
    { zone: a.zone, what: `Zone ${a.zone}` },
  );
  return { zone: a.zone };
}
