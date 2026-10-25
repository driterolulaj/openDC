// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Password policies (ROADMAP Phase 2): the domain default policy and fine-grained password policies (PSOs)
 * applied directly to users and groups. OU-linked policies arrive with Phase 3 (shadow groups). Browser-safe.
 */
import { z } from 'zod';

export const passwordSettings = z.strictObject({
  complexity: z.boolean(),
  minLength: z.number().int().min(0).max(255),
  historyLength: z.number().int().min(0).max(24),
  minAgeDays: z.number().int().min(0).max(998),
  /** 0 = passwords never expire */
  maxAgeDays: z.number().int().min(0).max(999),
  /** 0 = accounts never lock */
  lockoutThreshold: z.number().int().min(0).max(999),
  lockoutDurationMinutes: z.number().int().min(0).max(99_999),
  lockoutWindowMinutes: z.number().int().min(0).max(99_999),
});
export type PasswordSettings = z.infer<typeof passwordSettings>;

const psoName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, 'letters, digits, space, dot, underscore, hyphen');

export const pso = z.object({
  name: z.string(),
  guid: z.string(),
  precedence: z.number(),
  settings: passwordSettings,
  appliesTo: z.array(z.object({ guid: z.string(), dn: z.string(), name: z.string() })),
});
export type Pso = z.infer<typeof pso>;

export const passwordPolicies = z.object({ default: passwordSettings, psos: z.array(pso) });
export type PasswordPolicies = z.infer<typeof passwordPolicies>;

export const passwordPolicyChange = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('default'), settings: passwordSettings }),
  z.strictObject({
    kind: z.literal('pso'),
    name: psoName,
    precedence: z.number().int().min(1).max(2_147_483_647),
    settings: passwordSettings,
    /** objectGUIDs of users and groups the PSO applies to (replaces the current list). */
    appliesTo: z.array(z.uuid()).max(200),
  }),
  z.strictObject({ kind: z.literal('psoDelete'), name: psoName }),
]);
export type PasswordPolicyChange = z.input<typeof passwordPolicyChange>;
