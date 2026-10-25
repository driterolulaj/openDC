// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Console RBAC administration (ROADMAP Phase 2): roles (sets of permissions) and assignments (role ×
 * principals × scopes). Stored in the directory under CN=RBAC,CN=OpenDC,CN=System, so they replicate to
 * every DC. Browser-safe.
 */
import { z } from 'zod';

const permissionName = z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-zA-Z0-9-]+)+$|^\*$/);

export const rbacRole = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  permissions: z.array(z.string()),
  /** Tier-0 roles may hold tier-0 permissions and act on protected objects. */
  tier0: z.boolean(),
  builtin: z.boolean(),
});
export type RbacRole = z.infer<typeof rbacRole>;

export const rbacRoleInput = z.strictObject({
  name: z.string().min(1).max(64),
  description: z.string().max(512).nullable().default(null),
  permissions: z.array(permissionName).min(1).max(500),
  tier0: z.boolean().default(false),
});

export const rbacPrincipal = z.object({
  sid: z.string(),
  guid: z.string(),
  name: z.string(),
  type: z.enum(['user', 'group', 'other']),
});

export const rbacScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('domain') }),
  /** An OU or container; the DN is resolved from the GUID on every load, so renames and moves follow. */
  z.object({ kind: z.literal('subtree'), guid: z.string(), dn: z.string() }),
]);

export const rbacAssignment = z.object({
  id: z.string(),
  roleId: z.string(),
  roleName: z.string(),
  description: z.string().nullable(),
  principals: z.array(rbacPrincipal),
  scopes: z.array(rbacScope),
  builtin: z.boolean(),
});
export type RbacAssignment = z.infer<typeof rbacAssignment>;

export const rbacAssignmentInput = z.strictObject({
  roleId: z.string().min(1).max(64),
  description: z.string().max(512).nullable().default(null),
  /** User or group objectGUIDs. */
  principals: z.array(z.uuid()).min(1).max(100),
  scopes: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('domain') }),
        z.strictObject({ kind: z.literal('subtree'), guid: z.uuid() }),
      ]),
    )
    .min(1)
    .max(50),
});

export const rbacRoles = z.object({ roles: z.array(rbacRole) });
export const rbacAssignments = z.object({ assignments: z.array(rbacAssignment) });
export const rbacPermissions = z.object({
  permissions: z.array(
    z.object({
      name: z.string(),
      /** i18n key of the permission's title ("<module>:perm.<key>"). */
      title: z.string(),
      module: z.string(),
      scope: z.enum(['ou', 'node', 'global']),
      tier0: z.boolean(),
      implies: z.array(z.string()),
    }),
  ),
});
export const idParams = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/) });
