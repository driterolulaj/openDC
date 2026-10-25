// SPDX-License-Identifier: AGPL-3.0-only
/**
 * DNS (ROADMAP Phase 3, Spike S3): record schemas, the arguments `samba-tool dns` takes for each type, a decoder
 * for the `dnsRecord` attribute (MS-DNSP 2.3.2.2) the API reads over LDAP, and the records a writable DC needs
 * (Samba's dns_update_list), which the diagnostics check. Browser-safe except `decodeDnsRecord` (Buffer).
 */
import { z } from 'zod';

const LABEL = /^(?!-)[A-Za-z0-9_-]{1,63}(?<!-)$/;

/** A zone or host name: dot-separated labels, ≤ 253 characters, no trailing dot. */
export const dnsFqdn = z
  .string()
  .min(1)
  .max(253)
  .refine((s) => s.split('.').every((l) => LABEL.test(l)), 'a DNS name: labels of letters, digits, - and _');

/** A record name relative to its zone: "@" for the zone itself, a leading "*" label for wildcards. */
export const recordName = z
  .string()
  .min(1)
  .max(253)
  .refine(
    (s) => s === '@' || s.split('.').every((l, i) => (i === 0 && l === '*') || LABEL.test(l)),
    'a name relative to the zone ("@" for the zone itself)',
  );

const ipv4 = z.ipv4();
const ipv6 = z.ipv6();
const u16 = z.number().int().min(0).max(65535);
// TXT strings reach samba-tool as one argument inside double quotes: no quotes or backslashes in them
const txt = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x20-\x7e]*$/)
  .refine((s) => !/["\\]/.test(s), 'no " or \\');

export const recordData = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('A'), address: ipv4 }),
  z.strictObject({ type: z.literal('AAAA'), address: ipv6 }),
  z.strictObject({ type: z.literal('CNAME'), target: dnsFqdn }),
  z.strictObject({ type: z.literal('NS'), target: dnsFqdn }),
  z.strictObject({ type: z.literal('PTR'), target: dnsFqdn }),
  z.strictObject({ type: z.literal('MX'), exchange: dnsFqdn, preference: u16 }),
  z.strictObject({ type: z.literal('SRV'), target: dnsFqdn, port: u16, priority: u16, weight: u16 }),
  z.strictObject({ type: z.literal('TXT'), strings: z.array(txt).min(1).max(16) }),
]);
export type RecordData = z.infer<typeof recordData>;
export type RecordType = RecordData['type'];
export const recordTypes = ['A', 'AAAA', 'CNAME', 'NS', 'PTR', 'MX', 'SRV', 'TXT'] as const;

/** The data argument `samba-tool dns add/delete/update` expects for a record (one argv element). */
export function sambaToolData(r: RecordData): string {
  switch (r.type) {
    case 'A':
    case 'AAAA':
      return r.address;
    case 'CNAME':
    case 'NS':
    case 'PTR':
      return r.target;
    case 'MX':
      return `${r.exchange} ${String(r.preference)}`;
    case 'SRV':
      return `${r.target} ${String(r.port)} ${String(r.priority)} ${String(r.weight)}`;
    case 'TXT':
      return r.strings.map((s) => `"${s}"`).join(' ');
  }
}

/** Same record (names compared without case and trailing dots). */
export function sameRecord(a: RecordData, b: RecordData): boolean {
  const n = (s: string): string => s.toLowerCase().replace(/\.$/, '');
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'A':
    case 'AAAA':
      return a.address === (b as typeof a).address;
    case 'CNAME':
    case 'NS':
    case 'PTR':
      return n(a.target) === n((b as typeof a).target);
    case 'MX':
      return n(a.exchange) === n((b as typeof a).exchange) && a.preference === (b as typeof a).preference;
    case 'SRV': {
      const c = b as typeof a;
      return n(a.target) === n(c.target) && a.port === c.port && a.priority === c.priority && a.weight === c.weight;
    }
    case 'TXT':
      return a.strings.join('\u0000') === (b as typeof a).strings.join('\u0000');
  }
}

// ---------------------------------------------------------------- dnsRecord (MS-DNSP 2.3.2.2)

const TYPE_CODES: Record<number, RecordType | 'SOA'> = {
  1: 'A',
  2: 'NS',
  5: 'CNAME',
  6: 'SOA',
  12: 'PTR',
  15: 'MX',
  16: 'TXT',
  28: 'AAAA',
  33: 'SRV',
};

export type DecodedRecord =
  | (RecordData & { ttl: number; dynamic: boolean })
  | {
      type: 'SOA';
      serial: number;
      primary: string;
      admin: string;
      refresh: number;
      retry: number;
      expire: number;
      minimum: number;
      ttl: number;
      dynamic: boolean;
    };

/** DNS_COUNT_NAME: total length, label count, length-prefixed labels, terminating 0. */
function countName(b: Buffer, at: number): string {
  const labels = b.readUInt8(at + 1);
  const out: string[] = [];
  let p = at + 2;
  for (let i = 0; i < labels; i++) {
    const len = b.readUInt8(p);
    out.push(b.subarray(p + 1, p + 1 + len).toString('latin1'));
    p += 1 + len;
  }
  return out.join('.');
}

function ipv6Text(b: Buffer): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(b.readUInt16BE(i).toString(16));
  // collapse the longest run of zero groups
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > bestLen && j - i > 1) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (best < 0) return groups.join(':');
  return `${groups.slice(0, best).join(':')}::${groups.slice(best + bestLen).join(':')}`;
}

/** One dnsRecord value; null for tombstones, unknown types and damaged values. */
export function decodeDnsRecord(b: Buffer): DecodedRecord | null {
  if (b.length < 24) return null;
  const len = b.readUInt16LE(0);
  const type = TYPE_CODES[b.readUInt16LE(2)];
  if (!type || b.length < 24 + len) return null;
  const ttl = b.readUInt32BE(12);
  const dynamic = b.readUInt32LE(20) !== 0;
  const d = b.subarray(24, 24 + len);
  try {
    switch (type) {
      case 'A':
        return { type, address: [...d.subarray(0, 4)].join('.'), ttl, dynamic };
      case 'AAAA':
        return { type, address: ipv6Text(d.subarray(0, 16)), ttl, dynamic };
      case 'CNAME':
      case 'NS':
      case 'PTR':
        return { type, target: countName(d, 0), ttl, dynamic };
      case 'MX':
        return { type, preference: d.readUInt16BE(0), exchange: countName(d, 2), ttl, dynamic };
      case 'SRV':
        return {
          type,
          priority: d.readUInt16BE(0),
          weight: d.readUInt16BE(2),
          port: d.readUInt16BE(4),
          target: countName(d, 6),
          ttl,
          dynamic,
        };
      case 'TXT': {
        const strings: string[] = [];
        for (let p = 0; p < d.length;) {
          const l = d.readUInt8(p);
          strings.push(d.subarray(p + 1, p + 1 + l).toString('utf8'));
          p += 1 + l;
        }
        return { type, strings, ttl, dynamic };
      }
      case 'SOA': {
        const primary = countName(d, 20);
        // DNS_COUNT_NAME: length byte (of the raw name), label count, raw name
        const admin = countName(d, 20 + 2 + d.readUInt8(20));
        return {
          type,
          serial: d.readUInt32BE(0),
          refresh: d.readUInt32BE(4),
          retry: d.readUInt32BE(8),
          expire: d.readUInt32BE(12),
          minimum: d.readUInt32BE(16),
          primary,
          admin,
          ttl,
          dynamic,
        };
      }
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- what a DC registers (dns_update_list)

export interface DcFacts {
  /** fully qualified host name */
  hostname: string;
  ntdsGuid: string;
  site: string;
  pdc: boolean;
  gc: boolean;
  addresses: string[];
}

export interface ExpectedRecord {
  /** fully qualified owner name */
  name: string;
  record: RecordData;
  dc: string;
}

/** The records a writable DC with its own DNS registers (Samba's dns_update_list, writable DC and DNS). */
export function expectedDcRecords(
  dc: DcFacts,
  o: { dnsDomain: string; dnsForest: string; domainGuid: string },
): ExpectedRecord[] {
  const D = o.dnsDomain;
  const F = o.dnsForest;
  const H = dc.hostname;
  const S = dc.site;
  const out: ExpectedRecord[] = [];
  const srv = (name: string, port: number): void => {
    out.push({ name, dc: H, record: { type: 'SRV', target: H, port, priority: 0, weight: 100 } });
  };
  const addr = (name: string): void => {
    for (const a of dc.addresses)
      out.push({ name, dc: H, record: a.includes(':') ? { type: 'AAAA', address: a } : { type: 'A', address: a } });
  };
  addr(H);
  out.push({ name: `${dc.ntdsGuid}._msdcs.${F}`, dc: H, record: { type: 'CNAME', target: H } });
  out.push({ name: D, dc: H, record: { type: 'NS', target: H } });
  if (F !== D) out.push({ name: F, dc: H, record: { type: 'NS', target: H } });
  out.push({ name: `_msdcs.${F}`, dc: H, record: { type: 'NS', target: H } });
  addr(D);
  srv(`_ldap._tcp.${D}`, 389);
  srv(`_ldap._tcp.dc._msdcs.${D}`, 389);
  srv(`_ldap._tcp.${o.domainGuid}.domains._msdcs.${F}`, 389);
  srv(`_kerberos._tcp.${D}`, 88);
  srv(`_kerberos._udp.${D}`, 88);
  srv(`_kerberos._tcp.dc._msdcs.${D}`, 88);
  srv(`_kpasswd._tcp.${D}`, 464);
  srv(`_kpasswd._udp.${D}`, 464);
  srv(`_ldap._tcp.${S}._sites.${D}`, 389);
  srv(`_ldap._tcp.${S}._sites.dc._msdcs.${D}`, 389);
  srv(`_kerberos._tcp.${S}._sites.${D}`, 88);
  srv(`_kerberos._tcp.${S}._sites.dc._msdcs.${D}`, 88);
  if (dc.pdc) srv(`_ldap._tcp.pdc._msdcs.${D}`, 389);
  if (dc.gc) {
    addr(`gc._msdcs.${F}`);
    srv(`_gc._tcp.${F}`, 3268);
    srv(`_ldap._tcp.gc._msdcs.${F}`, 3268);
    srv(`_gc._tcp.${S}._sites.${F}`, 3268);
    srv(`_ldap._tcp.${S}._sites.gc._msdcs.${F}`, 3268);
  }
  addr(`DomainDnsZones.${D}`);
  srv(`_ldap._tcp.DomainDnsZones.${D}`, 389);
  srv(`_ldap._tcp.${S}._sites.DomainDnsZones.${D}`, 389);
  addr(`ForestDnsZones.${F}`);
  srv(`_ldap._tcp.ForestDnsZones.${F}`, 389);
  srv(`_ldap._tcp.${S}._sites.ForestDnsZones.${F}`, 389);
  return out;
}

/** Names a DC registers for itself: changing them needs a tier-0 permission (they steer logons). */
export function isDcRecordName(
  fqdn: string,
  o: { dnsDomain: string; dnsForest: string; dcHostnames: string[] },
): boolean {
  const n = fqdn.toLowerCase().replace(/\.$/, '');
  const D = o.dnsDomain.toLowerCase();
  const F = o.dnsForest.toLowerCase();
  if (n === D || n === F) return true;
  if (o.dcHostnames.some((h) => h.toLowerCase() === n)) return true;
  if (n.endsWith(`._msdcs.${F}`) || n === `_msdcs.${F}`) return true;
  if (/^_(ldap|kerberos|kpasswd|gc)\._(tcp|udp)\./.test(n)) return true;
  return /^(domaindnszones|forestdnszones)\./.test(n);
}

/** The owner name of a record: "@" means the zone itself. */
export function ownerName(name: string, zone: string): string {
  return name === '@' ? zone : `${name}.${zone}`;
}
