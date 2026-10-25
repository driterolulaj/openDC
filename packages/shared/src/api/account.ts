// SPDX-License-Identifier: AGPL-3.0-only
/** Account security (SECURITY.md §4): second factor, re-authentication, API tokens. Browser-safe. */
import { z } from 'zod';

export const totpStatus = z.object({ enrolled: z.boolean(), required: z.boolean() });
export const totpBegin = z.object({
  /** base32 secret, shown once */
  secret: z.string(),
  /** otpauth:// URI for authenticator apps */
  uri: z.string(),
});
export const totpCode = z.strictObject({ code: z.string().min(6).max(32) });
export const totpConfirmed = z.object({ recoveryCodes: z.array(z.string()) });
export const reauthRequest = z.strictObject({
  password: z.string().min(1).max(1024),
  totp: z.string().max(32).optional(),
});

export const apiToken = z.object({
  id: z.string(),
  name: z.string(),
  permissions: z.array(z.string()).nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export const apiTokens = z.object({ tokens: z.array(apiToken) });
export const apiTokenInput = z.strictObject({
  name: z.string().min(1).max(64),
  days: z.number().int().min(1).max(365).default(90),
  /** Limit the token to these permissions (default: all of yours except tier-0 ones). */
  permissions: z.array(z.string().max(128)).max(200).nullable().default(null),
});
export const apiTokenCreated = z.object({ id: z.string(), token: z.string() });
export const sidParams = z.strictObject({ sid: z.string().regex(/^S-1-5-21-\d+-\d+-\d+-\d+$/) });
