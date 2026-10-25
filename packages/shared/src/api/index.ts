// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Public API contract (/api/v1). Zod only, so the web console imports exactly the types the server validates
 * against (ADR-0011). Browser-safe: no Node imports in this subtree.
 */
import { z } from 'zod';
import { joinArgs, provisionArgs } from '../domain/setup.ts';

export const errorBody = z.object({
  code: z.string(),
  message: z.string(),
  fix: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type ApiError = z.infer<typeof errorBody>;

export const loginRequest = z.strictObject({
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(1024),
});

export const scope = z.union([
  z.object({ kind: z.literal('domain') }),
  z.object({ kind: z.literal('subtree'), dn: z.string() }),
  z.object({ kind: z.literal('node'), nodeGuid: z.string() }),
]);

export const sessionInfo = z.object({
  user: z.object({
    sid: z.string(),
    guid: z.string(),
    username: z.string(),
    displayName: z.string().nullable(),
    dn: z.string(),
  }),
  csrfToken: z.string(),
  expiresAt: z.string(),
  idleTimeoutSec: z.number(),
});
export type SessionInfo = z.infer<typeof sessionInfo>;

export const permissionsResponse = z.object({
  permissions: z.array(z.object({ permission: z.string(), scopes: z.array(scope), tier0: z.boolean() })),
});
export type PermissionsResponse = z.infer<typeof permissionsResponse>;

export const nodeInfo = z.object({
  hostname: z.string(),
  fqdn: z.string(),
  role: z.string(),
  os: z.object({ id: z.string(), versionId: z.string(), prettyName: z.string(), adapter: z.string() }),
  kernel: z.string(),
  uptimeSec: z.number(),
  cpus: z.number(),
  memTotal: z.number(),
  samba: z.string().nullable(),
  platformVersion: z.string(),
});
export type NodeInfo = z.infer<typeof nodeInfo>;

export const auditEntry = z.object({
  originNodeId: z.string(),
  seq: z.number(),
  ts: z.string(),
  actor: z.string(),
  actorSid: z.string().nullable(),
  sourceIp: z.string().nullable(),
  action: z.string(),
  result: z.string(),
  targetGuid: z.string().nullable(),
  targetDn: z.string().nullable(),
  requestId: z.string().nullable(),
});
export const auditQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  before: z.string().max(40).optional(),
});
export const auditList = z.object({ entries: z.array(auditEntry) });

export const job = z.object({
  id: z.string(),
  type: z.string(),
  actor: z.string(),
  status: z.enum(['running', 'succeeded', 'failed']),
  createdAt: z.string(),
  updatedAt: z.string(),
  result: z.unknown(),
  error: z.unknown(),
});
export type Job = z.infer<typeof job>;
export const jobParams = z.strictObject({ id: z.uuid() });

export const health = z.object({ status: z.literal('ok'), version: z.string() });
export const empty = z.object({});

// ---- Setup (Phase 2): the wizard's API, authorised by the one-time setup token (header X-Setup-Token)
export {
  preflightArgs as setupPreflightRequest,
  preflightResult as setupPreflightResponse,
  setupState as setupStatusResponse,
} from '../domain/setup.ts';

/** The typed confirmation: the user types the domain name (confirmationPhrase). */
const confirmField = { confirm: z.string().max(253) };
export const setupProvisionRequest = provisionArgs.extend(confirmField);
export const setupJoinRequest = joinArgs.extend(confirmField);
export const setupJobParams = z.strictObject({ id: z.uuid() });
export const setupJobResponse = z.object({
  job,
  events: z.array(z.object({ n: z.number(), kind: z.string(), data: z.unknown() })),
});
export const SETUP_TOKEN_HEADER = 'x-setup-token';
export * from './directory.ts';
export * from './rbac.ts';
