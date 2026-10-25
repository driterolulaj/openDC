// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Argument and result schemas of the operations the agent implements. Shared so that every caller is
 * type-checked against the same contract the agent validates. Argument schemas are strict: unknown keys
 * are rejected (ADR-0006 §3).
 */
import { z } from 'zod';
import {
  joinArgs,
  preflightArgs,
  preflightResult,
  provisionArgs,
  provisionResult,
  setupState,
} from '../domain/setup.ts';

const MAX_MANAGED_FILE_BYTES = 1024 * 1024;

const fileId = z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-zA-Z0-9-]+)+$/, 'fileId "<module>.<name>"');
const unitId = z.string().regex(/^[a-z][a-z0-9@._-]{0,127}$/, 'logical unit id');
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const empty = z.strictObject({});
const unitResult = z.object({ unit: z.string() });
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
  'samba.level.show': {
    v: 1,
    args: empty,
    result: z.object({
      forest: z.string().nullable(),
      domain: z.string().nullable(),
      lowestDc: z.string().nullable(),
    }),
  },
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
