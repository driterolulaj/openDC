// SPDX-License-Identifier: AGPL-3.0-only
/** DNS zones, records and diagnostics (ROADMAP Phase 3, Spike S3). Browser-safe. */
import { z } from 'zod';
import { dnsFqdn, recordData, recordName } from '../dns/index.ts';

export const dnsZone = z.object({
  name: z.string(),
  /** domain: DomainDnsZones (this domain's DCs), forest: ForestDnsZones (all DCs of the forest) */
  partition: z.enum(['domain', 'forest']),
  reverse: z.boolean(),
  /** a zone Active Directory needs (the domain zone, _msdcs): can't be deleted */
  ad: z.boolean(),
});
export const dnsZones = z.object({ zones: z.array(dnsZone) });
export const zoneParams = z.strictObject({ zone: dnsFqdn });
export const zoneCreate = z.strictObject({ zone: dnsFqdn });
export const zoneDelete = z.strictObject({ confirm: z.string().max(253) });
export const zoneAging = z.strictObject({
  aging: z.boolean(),
  refreshHours: z.number().int().min(1).max(8760).default(168),
  noRefreshHours: z.number().int().min(1).max(8760).default(168),
});

const decoded = z.union([
  recordData,
  z.object({
    type: z.literal('SOA'),
    serial: z.number(),
    primary: z.string(),
    admin: z.string(),
    refresh: z.number(),
    retry: z.number(),
    expire: z.number(),
    minimum: z.number(),
  }),
]);
export const dnsRecordView = z.object({
  name: z.string(),
  record: decoded,
  ttl: z.number(),
  /** registered dynamically (aging applies) */
  dynamic: z.boolean(),
  /** a record domain controllers register for themselves: changing it needs a tier-0 permission */
  protected: z.boolean(),
});
export const dnsRecords = z.object({ zone: z.string(), records: z.array(dnsRecordView) });
export const recordAdd = z.strictObject({
  name: recordName,
  record: recordData,
  /** A/AAAA: also add the PTR record when a matching reverse zone exists */
  ptr: z.boolean().default(false),
});
/** the PTR record that was added with an A record, if any */
export const recordAdded = z.object({ ptr: z.string().nullable() });
export const recordUpdate = z.strictObject({ name: recordName, from: recordData, to: recordData });
export const recordDelete = z.strictObject({ name: recordName, record: recordData });

export const dnsCheck = z.object({
  /** e.g. "record", "address", "forwarder" */
  kind: z.string(),
  status: z.enum(['pass', 'warn', 'fail']),
  dc: z.string().nullable(),
  name: z.string(),
  record: recordData.nullable(),
  /** DNS servers (DC host names) that don't answer with the record */
  missingOn: z.array(z.string()),
});
export const dnsDiagnostics = z.object({
  servers: z.array(z.object({ dc: z.string(), address: z.string().nullable() })),
  checks: z.array(dnsCheck),
  /** checks that failed or warned, as one line each with what to do */
  summary: z.array(z.object({ status: z.enum(['warn', 'fail']), message: z.string(), fix: z.string() })),
});
export type DnsDiagnostics = z.infer<typeof dnsDiagnostics>;
export const dnsRepair = z.strictObject({
  records: z
    .array(z.strictObject({ name: dnsFqdn, record: recordData }))
    .min(1)
    .max(200),
});
export const dnsRepairResult = z.object({
  added: z.array(z.string()),
  failed: z.array(z.object({ name: z.string(), error: z.string() })),
});

/** This DC's DNS server: forwarders and scavenging (smb.conf; a change restarts Samba on this DC). */
export const dnsServer = z.object({ forwarders: z.array(z.string()), scavenging: z.boolean() });
export const dnsServerUpdate = z.strictObject({
  forwarders: z
    .array(z.union([z.ipv4(), z.ipv6()]))
    .max(4)
    .optional(),
  scavenging: z.boolean().optional(),
});
export const dnsServerResult = dnsServer.extend({ restarted: z.boolean() });
