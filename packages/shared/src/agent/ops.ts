// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Argument and result schemas of the operations the agent implements. Shared so that every caller is
 * type-checked against the same contract the agent validates. Argument schemas are strict: unknown keys
 * are rejected (ADR-0006 §3).
 */
import { z } from 'zod';

const MAX_MANAGED_FILE_BYTES = 1024 * 1024;

const fileId = z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-zA-Z0-9-]+)+$/, 'fileId "<module>.<name>"');
const unitId = z.string().regex(/^[a-z][a-z0-9@._-]{0,127}$/, 'logical unit id');
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const empty = z.strictObject({});

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
      agentVersion: z.string(),
    }),
  },
  'samba.version': {
    v: 1,
    args: empty,
    result: z
      .object({ raw: z.string(), major: z.number(), minor: z.number(), patch: z.number() })
      .nullable(),
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
      z.strictObject({ action: z.literal('acquire'), holder: z.string().min(1).max(128), ttlSec: z.number().int().min(1).max(600) }),
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
export type OpResult<O extends ImplementedOp> = z.output<(typeof ops)[O]['result']>;

export function isImplementedOp(op: string): op is ImplementedOp {
  return Object.hasOwn(ops, op);
}
