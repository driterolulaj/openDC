// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Policies (directory-object-model.md §3.1): typed settings linked to OUs, containers or the domain head, with
 * enforced links and priorities. Browser-safe.
 */
import { z } from 'zod';
import { passwordSettings } from '../domain/password-policy.ts';

export const policyTypes = ['password', 'registry', 'dhcp'] as const;
export type PolicyType = (typeof policyTypes)[number];

export const policyLink = z.strictObject({
  targetGuid: z.uuid(),
  enforced: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

export const policyFilter = z.strictObject({
  groupGuids: z.array(z.uuid()).max(50).optional(),
  nodeRoles: z
    .array(z.enum(['primary-dc', 'dc', 'rodc', 'member', 'managed-node']))
    .max(5)
    .optional(),
});

const common = {
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._()-]*$/u, 'letters, digits, space and . _ ( ) -'),
  description: z.string().max(512).nullable().default(null),
  /** lower wins among links at the same level */
  priority: z.number().int().min(0).max(999).default(100),
  links: z.array(policyLink).max(100).default([]),
  filter: policyFilter.optional(),
};

/** Registry keys a policy may set (registry keys with policySettable: true; values checked by the API). */
const registrySettings = z.record(z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-zA-Z0-9-]+)+$/), z.unknown());

/** DHCP servers in the linked OUs: server-wide options (subnets can override them). */
export const dhcpPolicySettings = z.strictObject({
  dnsServers: z.array(z.ipv4()).max(4).optional(),
  domainName: z
    .string()
    .regex(/^(?=.{1,253}$)([A-Za-z0-9-]{1,63}\.)*[A-Za-z0-9-]{1,63}$/)
    .optional(),
  ntpServers: z.array(z.ipv4()).max(4).optional(),
  leaseSeconds: z.number().int().min(300).max(31_536_000).optional(),
});

export const policyInput = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('password'), ...common, settings: passwordSettings }),
  z.strictObject({ type: z.literal('registry'), ...common, settings: registrySettings }),
  z.strictObject({ type: z.literal('dhcp'), ...common, settings: dhcpPolicySettings }),
]);
export type PolicyInput = z.input<typeof policyInput>;
export type PolicyData = z.output<typeof policyInput>;

const linkView = policyLink.extend({ dn: z.string().nullable() });

export const policyView = z.object({
  id: z.string(),
  type: z.enum(policyTypes),
  name: z.string(),
  description: z.string().nullable(),
  priority: z.number(),
  links: z.array(linkView),
  filter: policyFilter.optional(),
  settings: z.record(z.string(), z.unknown()),
  rev: z.number(),
  updatedAt: z.string(),
  updatedBy: z.string(),
});
export type PolicyView = z.infer<typeof policyView>;
export const policyList = z.object({ policies: z.array(policyView) });
export const policyListQuery = z.strictObject({ type: z.enum(policyTypes).optional() });

export const effectiveQuery = z.strictObject({ target: z.uuid(), type: z.enum(policyTypes) });
const level = z.object({ guid: z.string(), dn: z.string() });
export const effectivePolicy = z.object({
  target: z.object({ guid: z.string(), dn: z.string() }),
  type: z.enum(policyTypes),
  chain: z.array(level),
  /** winner first */
  applicable: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      priority: z.number(),
      level,
      depth: z.number(),
      enforced: z.boolean(),
    }),
  ),
  /** per key: value and where it came from (registry); the winner's settings (password) */
  settings: z.record(
    z.string(),
    z.object({ value: z.unknown(), policyId: z.string(), policyName: z.string(), levelDn: z.string() }),
  ),
  /** whole-policy types (password): the policy that applies */
  winner: z.string().nullable(),
});
export type EffectivePolicy = z.infer<typeof effectivePolicy>;

const PAYLOAD_PREFIX = 'opendc:v1:';

/** A policy object's msDS-Settings value -> its data; null for other kinds, newer versions or damaged values. */
export function parsePolicyPayload(raw: string | null | undefined): PolicyData | null {
  if (!raw?.startsWith(PAYLOAD_PREFIX)) return null;
  try {
    const env = JSON.parse(raw.slice(PAYLOAD_PREFIX.length)) as {
      kind?: unknown;
      schemaVersion?: unknown;
      data?: unknown;
    };
    if (env.kind !== 'policy' || env.schemaVersion !== 1) return null;
    const r = policyInput.safeParse(env.data);
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
