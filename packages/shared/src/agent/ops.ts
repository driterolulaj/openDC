// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Argument and result schemas of the operations the agent implements. Shared so that every caller is
 * type-checked against the same contract the agent validates. Argument schemas are strict: unknown keys
 * are rejected (ADR-0006 §3).
 */
import { z } from 'zod';
import { dnsFqdn, recordData, recordName } from '../dns/index.ts';
import { keaApplyArgs } from '../dhcp/index.ts';

const pkiLeaf = z.object({
  profile: z.enum(['node', 'web', 'ldaps']),
  serial: z.string(),
  notAfter: z.string(),
  renewed: z.boolean(),
});
import {
  memberJoinArgs,
  joinArgs,
  preflightArgs,
  preflightResult,
  provisionArgs,
  provisionResult,
  setupState,
} from '../domain/setup.ts';
import { passwordPolicies, passwordPolicyChange } from '../domain/password-policy.ts';

const MAX_MANAGED_FILE_BYTES = 1024 * 1024;

const fileId = z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-zA-Z0-9-]+)+$/, 'fileId "<module>.<name>"');
const unitId = z.string().regex(/^[a-z][a-z0-9@._-]{0,127}$/, 'logical unit id');
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const empty = z.strictObject({});
const unitResult = z.object({ unit: z.string() });
/** Attributes a tier-0 attribute edit may touch (samba.protectedObject.modify). */
export const protectedEditableAttributes = [
  'description',
  'displayName',
  'givenName',
  'sn',
  'mail',
  'telephoneNumber',
  'mobile',
  'title',
  'department',
  'company',
  'physicalDeliveryOfficeName',
] as const;
const protectedChange = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('password'),
    password: z.string().min(1).max(256),
    mustChange: z.boolean(),
    unlock: z.boolean(),
  }),
  z.strictObject({ kind: z.literal('enable') }),
  z.strictObject({ kind: z.literal('disable') }),
  z.strictObject({ kind: z.literal('unlock') }),
  z.strictObject({ kind: z.literal('memberAdd'), memberGuids: z.array(z.uuid()).min(1).max(100) }),
  z.strictObject({ kind: z.literal('memberRemove'), memberGuids: z.array(z.uuid()).min(1).max(100) }),
  z.strictObject({
    kind: z.literal('attributes'),
    values: z.partialRecord(z.enum(protectedEditableAttributes), z.string().max(1024).nullable()),
  }),
]);
const fsmoRoles = ['schema', 'naming', 'pdc', 'rid', 'infrastructure', 'domaindns', 'forestdns'] as const;
export const fsmoRole = z.enum(fsmoRoles);

export const ops = {
  'system.info': {
    v: 1,
    args: empty,
    result: z.object({
      hostname: z.string(),
      fqdn: z.string(),
      kernel: z.string(),
      uptimeSec: z.number(),
      memTotal: z.number(),
      cpus: z.number(),
      os: z.object({ id: z.string(), versionId: z.string(), prettyName: z.string(), adapter: z.string() }),
      role: z.enum(['primary-dc', 'dc', 'rodc', 'member', 'managed-node']),
      agentVersion: z.string(),
    }),
  },
  'samba.version': {
    v: 1,
    args: empty,
    result: z.object({ raw: z.string(), major: z.number(), minor: z.number(), patch: z.number() }).nullable(),
  },
  'service.status': {
    v: 1,
    args: z.strictObject({ unit: unitId }),
    result: z.object({
      unit: z.string(),
      active: z.string(),
      sub: z.string(),
      enabled: z.boolean(),
      since: z.string().optional(),
    }),
  },
  'service.start': { v: 1, args: z.strictObject({ unit: unitId }), result: z.object({ unit: z.string() }) },
  'service.stop': { v: 1, args: z.strictObject({ unit: unitId }), result: z.object({ unit: z.string() }) },
  'service.restart': { v: 1, args: z.strictObject({ unit: unitId }), result: z.object({ unit: z.string() }) },
  'service.reload': { v: 1, args: z.strictObject({ unit: unitId }), result: z.object({ unit: z.string() }) },
  'service.enable': {
    v: 1,
    args: z.strictObject({ unit: unitId, now: z.boolean().default(true) }),
    result: unitResult,
  },
  'service.disable': {
    v: 1,
    args: z.strictObject({ unit: unitId, now: z.boolean().default(true) }),
    result: unitResult,
  },
  'setup.status': { v: 1, args: empty, result: setupState },
  'setup.preflight': { v: 1, args: preflightArgs, result: preflightResult },
  'samba.provision': { v: 1, args: provisionArgs, result: provisionResult },
  'samba.join': { v: 1, args: joinArgs, result: provisionResult },
  'samba.status': {
    v: 1,
    args: empty,
    result: z.object({
      installed: z.boolean(),
      version: z.string().nullable(),
      provisioned: z.boolean(),
      serverRole: z.string().nullable(),
      realm: z.string().nullable(),
      netbiosDomain: z.string().nullable(),
      active: z.string(),
    }),
  },
  'samba.fsmo.show': {
    v: 1,
    args: empty,
    result: z.object({
      roles: z.array(z.object({ role: fsmoRole, ownerDn: z.string(), ownerServer: z.string().nullable() })),
    }),
  },
  'samba.fsmo.transfer': {
    v: 1,
    args: z.strictObject({ roles: z.array(fsmoRole).min(1).max(7) }),
    result: z.object({ roles: z.array(z.object({ role: fsmoRole, ownerServer: z.string().nullable() })) }),
  },
  'samba.fsmo.seize': {
    v: 1,
    args: z.strictObject({
      roles: z.array(fsmoRole).min(1).max(7),
      /** Seize even if the current holder answers (otherwise a transfer is tried first). */
      force: z.boolean().default(false),
    }),
    result: z.object({ roles: z.array(z.object({ role: fsmoRole, ownerServer: z.string().nullable() })) }),
  },
  'samba.level.raise': {
    v: 1,
    args: z
      .strictObject({
        domain: z.enum(['2008_R2', '2012', '2012_R2', '2016']).optional(),
        forest: z.enum(['2008_R2', '2012', '2012_R2', '2016']).optional(),
      })
      .refine((a) => a.domain !== undefined || a.forest !== undefined, 'domain or forest'),
    result: z.object({ forest: z.string().nullable(), domain: z.string().nullable(), lowestDc: z.string().nullable() }),
  },
  'samba.level.show': {
    v: 1,
    args: empty,
    result: z.object({
      forest: z.string().nullable(),
      domain: z.string().nullable(),
      lowestDc: z.string().nullable(),
    }),
  },
  'samba.protectedObject.modify': {
    v: 1,
    args: z.strictObject({ targetGuid: z.uuid(), change: protectedChange }),
    result: z.object({ dn: z.string(), sdprop: z.number() }),
  },
  'dns.zone.list': {
    v: 1,
    args: empty,
    result: z.object({ zones: z.array(z.object({ name: z.string(), reverse: z.boolean() })) }),
  },
  'dns.zone.create': { v: 1, args: z.strictObject({ zone: dnsFqdn }), result: z.object({ zone: z.string() }) },
  'dns.zone.delete': { v: 1, args: z.strictObject({ zone: dnsFqdn }), result: z.object({ zone: z.string() }) },
  'dns.record.add': {
    v: 1,
    args: z.strictObject({ zone: dnsFqdn, name: recordName, record: recordData }),
    result: z.object({ zone: z.string(), name: z.string() }),
  },
  'dns.record.update': {
    v: 1,
    args: z.strictObject({ zone: dnsFqdn, name: recordName, from: recordData, to: recordData }),
    result: z.object({ zone: z.string(), name: z.string() }),
  },
  'dns.record.delete': {
    v: 1,
    args: z.strictObject({ zone: dnsFqdn, name: recordName, record: recordData }),
    result: z.object({ zone: z.string(), name: z.string() }),
  },
  'dns.zone.setAging': {
    v: 1,
    args: z.strictObject({
      zone: dnsFqdn,
      aging: z.boolean(),
      refreshHours: z.number().int().min(1).max(8760),
      noRefreshHours: z.number().int().min(1).max(8760),
    }),
    result: z.object({ zone: z.string() }),
  },
  'dns.server.show': {
    v: 1,
    args: empty,
    result: z.object({ forwarders: z.array(z.string()), scavenging: z.boolean() }),
  },
  'dns.server.configure': {
    v: 1,
    args: z.strictObject({
      forwarders: z
        .array(z.union([z.ipv4(), z.ipv6()]))
        .max(4)
        .optional(),
      scavenging: z.boolean().optional(),
    }),
    result: z.object({ forwarders: z.array(z.string()), scavenging: z.boolean(), restarted: z.boolean() }),
  },
  'dhcp.apply': {
    v: 1,
    args: keaApplyArgs,
    result: z.object({ changed: z.boolean(), action: z.enum(['none', 'reloaded', 'started', 'stopped']) }),
  },
  'dhcp.leases': {
    v: 1,
    args: empty,
    result: z.object({
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
    }),
  },
  'samba.member.join': {
    v: 1,
    args: memberJoinArgs,
    result: z.object({ domain: z.string(), dc: z.string(), dcs: z.array(z.string()), watchAccount: z.string() }),
  },
  'ca.init': {
    v: 1,
    args: empty,
    result: z.object({ fingerprint: z.string(), issuer: z.string(), leafs: z.array(pkiLeaf) }),
  },
  'ca.issuer.create': {
    v: 1,
    args: z.strictObject({ nodeGuid: z.uuid() }),
    result: z.object({ issuer: z.string(), host: z.string() }),
  },
  'pki.maintain': {
    v: 1,
    /** renew when this fraction of the lifetime has passed (default 2/3; lower values force renewal in tests) */
    args: z.strictObject({ renewFraction: z.number().min(0).max(1).optional() }),
    result: z.object({
      state: z.enum(['no-root', 'awaiting-approval', 'ready']),
      issuer: z.string().nullable(),
      leafs: z.array(pkiLeaf),
      crl: z.boolean(),
    }),
  },
  'cert.revoke': {
    v: 1,
    args: z.strictObject({
      serial: z.string().regex(/^[0-9A-Fa-f]{2,64}$/),
      reason: z.enum(['unspecified', 'keyCompromise', 'superseded', 'cessationOfOperation']),
    }),
    result: z.object({ serial: z.string(), issuerId: z.string(), crlUpdated: z.boolean() }),
  },
  'platform.watchAccess.ensure': { v: 1, args: empty, result: z.object({ changed: z.array(z.string()) }) },
  'directory.posixIds.fill': {
    v: 1,
    args: z.strictObject({ guids: z.array(z.uuid()).min(1).max(500) }),
    result: z.object({
      results: z.array(
        z.object({
          guid: z.string(),
          dn: z.string().nullable(),
          set: z.object({ uidNumber: z.number().optional(), gidNumber: z.number().optional() }),
          /** why nothing was needed (computer, BUILTIN, already has IDs) */
          skipped: z.string().nullable(),
          /** why it couldn't be done (not found, ID already used) */
          error: z.string().nullable(),
        }),
      ),
    }),
  },
  'policy.password.reconcile': {
    v: 1,
    /** only these users' memberships (moved or new users); all users when absent */
    args: z.strictObject({ users: z.array(z.uuid()).max(5000).optional() }),
    result: z.object({
      policies: z.number(),
      /** id of the policy that sets the domain default, if any */
      domainDefault: z.string().nullable(),
      psos: z.object({ created: z.number(), updated: z.number(), removed: z.number() }),
      members: z.object({ added: z.number(), removed: z.number() }),
      users: z.number(),
    }),
  },
  'samba.passwordPolicy.show': { v: 1, args: empty, result: passwordPolicies },
  'samba.passwordPolicy.set': { v: 1, args: passwordPolicyChange, result: passwordPolicies },
  'samba.sdprop.run': {
    v: 1,
    args: empty,
    result: z.object({ checked: z.number(), updated: z.array(z.string()), skipped: z.string().nullable() }),
  },
  'time.tracking': {
    v: 1,
    args: empty,
    result: z.object({ synchronized: z.boolean(), offsetSec: z.number().nullable(), reference: z.string().nullable() }),
  },
  'file.writeManaged': {
    v: 1,
    args: z.strictObject({
      fileId,
      content: z
        .string()
        .refine((s) => Buffer.byteLength(s, 'utf8') <= MAX_MANAGED_FILE_BYTES, 'content larger than 1 MiB'),
      expectedPrevSha256: sha256.nullable().optional(),
    }),
    result: z.object({ changed: z.boolean(), sha256, previousSha256: sha256.nullable() }),
  },
  'file.readManaged': {
    v: 1,
    args: z.strictObject({ fileId }),
    result: z.object({ content: z.string().nullable(), sha256: sha256.nullable() }),
  },
  'file.restorePrevious': {
    v: 1,
    args: z.strictObject({ fileId }),
    result: z.object({ restored: z.boolean(), sha256: sha256.nullable() }),
  },
  'registry.commitLock': {
    v: 1,
    args: z.discriminatedUnion('action', [
      z.strictObject({
        action: z.literal('acquire'),
        holder: z.string().min(1).max(128),
        ttlSec: z.number().int().min(1).max(600),
      }),
      z.strictObject({ action: z.literal('release'), token: z.string().regex(/^[0-9a-f]{32}$/) }),
    ]),
    result: z.object({
      acquired: z.boolean(),
      token: z.string().optional(),
      heldBy: z.string().optional(),
      since: z.string().optional(),
    }),
  },
} as const;

export type ImplementedOp = keyof typeof ops;
export type OpArgs<O extends ImplementedOp> = z.input<(typeof ops)[O]['args']>;
/** Arguments after validation (defaults applied), as the agent's implementations receive them. */
export type OpParsedArgs<O extends ImplementedOp> = z.output<(typeof ops)[O]['args']>;
export type OpResult<O extends ImplementedOp> = z.output<(typeof ops)[O]['result']>;

export function isImplementedOp(op: string): op is ImplementedOp {
  return Object.hasOwn(ops, op);
}
