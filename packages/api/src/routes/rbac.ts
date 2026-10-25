// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /api/v1/rbac: console roles and assignments (ROADMAP Phase 2). Reading needs domain.rbac.read; every change
 * needs domain.rbac.write, a tier-0 permission (only tier-0 roles hold it), because whoever edits roles can
 * grant themselves anything. Built-in roles and the built-in Domain Admins assignment are read-only.
 */
import { PlatformError, permissions as catalogue } from '@opendc/shared';
import {
  empty,
  idParams,
  rbacAssignmentInput,
  rbacAssignments,
  rbacPermissions,
  rbacRoleInput,
  rbacRoles,
  type RbacAssignment,
} from '@opendc/shared/api';
import { z } from 'zod';
import type { AuditLog } from '../audit.ts';
import type { RouteContext, RouteTable } from '../http/route.ts';
import { BUILTIN_ROLES, builtinAssignments } from '../rbac/builtin.ts';
import type { RbacStore } from '../rbac/store.ts';
import type { DirectoryService } from '../directory/service.ts';

type Ctx = RouteContext<unknown, unknown, unknown>;

const created = z.object({ id: z.string() });

export function rbacRoutes(
  t: RouteTable,
  d: { store: () => RbacStore; directory: () => DirectoryService; audit: AuditLog },
): void {
  const audit = (c: Ctx, action: string, id: string, before: unknown, after: unknown): void => {
    d.audit.append({
      actor: c.user.username,
      actorSid: c.user.sid,
      sourceIp: c.ip,
      action,
      result: 'success',
      targetGuid: id,
      before,
      after,
      requestId: c.requestId,
    });
  };
  const actor = (c: Ctx): { sid: string; name: string } => ({ sid: c.user.sid, name: c.user.username });
  const tier0Write = (c: Ctx): void => {
    c.require('domain.rbac.write', { protected: true, label: 'RBAC' });
  };

  /** Permission names exist; a non-tier-0 role may not list tier-0 permissions (they would be ignored). */
  const validateRole = (r: z.output<typeof rbacRoleInput>): void => {
    const known = new Map<string, boolean>(catalogue.map((p) => [p.name, 'tier0' in p && p.tier0]));
    const unknown = r.permissions.filter((p) => p !== '*' && !known.has(p));
    if (unknown.length)
      throw new PlatformError('validation.invalid', { issues: `permissions: unknown ${unknown.join(', ')}` });
    if (!r.tier0) {
      const t0 = r.permissions.filter((p) => p === '*' || known.get(p) === true);
      if (t0.length)
        throw new PlatformError('validation.invalid', {
          issues: `permissions: ${t0.join(', ')} need a tier-0 role (set tier0)`,
        });
    }
  };

  t.add({
    method: 'GET',
    url: '/api/v1/rbac/permissions',
    operationId: 'listPermissions',
    summary: 'The permission catalogue (from the module manifests)',
    tags: ['rbac'],
    auth: { permission: 'domain.rbac.read' },
    response: rbacPermissions,
    handler: async () =>
      Promise.resolve({
        permissions: catalogue.map((p) => {
          const x = p as {
            name: string;
            title: string;
            module: string;
            scope: 'ou' | 'node' | 'global';
            tier0?: boolean;
            implies?: readonly string[];
          };
          return {
            name: x.name,
            title: x.title,
            module: x.module,
            scope: x.scope,
            tier0: x.tier0 === true,
            implies: [...(x.implies ?? [])],
          };
        }),
      }),
  });

  t.add({
    method: 'GET',
    url: '/api/v1/rbac/roles',
    operationId: 'listRoles',
    summary: 'Built-in and custom roles',
    tags: ['rbac'],
    auth: { permission: 'domain.rbac.read' },
    response: rbacRoles,
    handler: async () => {
      const snap = await d.store().refresh();
      return {
        roles: [
          ...BUILTIN_ROLES.map((r) => ({ ...r, permissions: [...r.permissions], description: null })),
          ...snap.roles.map(({ id, name, description, permissions, tier0 }) => ({
            id,
            name,
            description,
            permissions: [...permissions],
            tier0,
            builtin: false,
          })),
        ],
      };
    },
  });

  t.add({
    method: 'POST',
    url: '/api/v1/rbac/roles',
    operationId: 'createRole',
    summary: 'Create a custom role',
    tags: ['rbac'],
    auth: { permission: 'domain.rbac.write' },
    body: rbacRoleInput,
    response: created,
    status: 201,
    handler: async (c) => {
      tier0Write(c);
      validateRole(c.body);
      const id = await d.store().createRole(actor(c), c.body);
      audit(c, 'rbac.role.create', id, undefined, c.body);
      return { id };
    },
  });

  t.add({
    method: 'PUT',
    url: '/api/v1/rbac/roles/:id',
    operationId: 'updateRole',
    summary: 'Replace a custom role',
    tags: ['rbac'],
    auth: { permission: 'domain.rbac.write' },
    params: idParams,
    body: rbacRoleInput,
    response: empty,
    handler: async (c) => {
      tier0Write(c);
      if (c.params.id.startsWith('builtin.'))
        throw new PlatformError('directory.unsupported', { what: 'Changing a built-in role' });
      validateRole(c.body);
      const before = (await d.store().refresh()).roles.find((r) => r.id === c.params.id);
      await d.store().updateRole(actor(c), c.params.id, c.body);
      audit(
        c,
        'rbac.role.update',
        c.params.id,
        before && { name: before.name, permissions: before.permissions, tier0: before.tier0 },
        c.body,
      );
      return {};
    },
  });

  t.add({
    method: 'DELETE',
    url: '/api/v1/rbac/roles/:id',
    operationId: 'deleteRole',
    summary: 'Delete a custom role that is no longer assigned',
    tags: ['rbac'],
    auth: { permission: 'domain.rbac.write' },
    params: idParams,
    response: empty,
    handler: async (c) => {
      tier0Write(c);
      if (c.params.id.startsWith('builtin.'))
        throw new PlatformError('directory.unsupported', { what: 'Deleting a built-in role' });
      await d.store().deleteRole(c.params.id);
      audit(c, 'rbac.role.delete', c.params.id, { id: c.params.id }, undefined);
      return {};
    },
  });

  t.add({
    method: 'GET',
    url: '/api/v1/rbac/assignments',
    operationId: 'listAssignments',
    summary: 'Role assignments (principals × scopes)',
    tags: ['rbac'],
    auth: { permission: 'domain.rbac.read' },
    response: rbacAssignments,
    handler: async (c) => {
      const store = d.store();
      const snap = await store.refresh();
      const roleName = new Map([...BUILTIN_ROLES, ...snap.roles].map((r) => [r.id, r.name]));
      const names = await store.names(snap.assignments.flatMap((a) => a.principalRefs.map((p) => p.guid)));
      const builtin: RbacAssignment[] = builtinAssignments(c.user.domainSid).map((a) => ({
        id: a.id,
        roleId: a.roleId,
        roleName: roleName.get(a.roleId) ?? a.roleId,
        description: null,
        principals: a.principals.map((sid) => ({ sid, guid: '', name: sid, type: 'group' as const })),
        scopes: [{ kind: 'domain' as const }],
        builtin: true,
      }));
      return {
        assignments: [
          ...builtin,
          ...snap.assignments.map((a) => ({
            id: a.id,
            roleId: a.roleId,
            roleName: roleName.get(a.roleId) ?? a.roleId,
            description: a.description,
            principals: a.principalRefs.map((p) => ({
              sid: p.sid,
              guid: p.guid,
              name: names.get(p.guid)?.name ?? p.sid,
              type: names.get(p.guid)?.type ?? ('other' as const),
            })),
            scopes: a.scopeRefs,
            builtin: false,
          })),
        ],
      };
    },
  });

  const assignmentData = async (body: z.output<typeof rbacAssignmentInput>) => {
    const snap = await d.store().refresh();
    if (!BUILTIN_ROLES.some((r) => r.id === body.roleId) && !snap.roles.some((r) => r.id === body.roleId))
      throw new PlatformError('validation.invalid', { issues: `roleId: unknown role ${body.roleId}` });
    // subtree scopes must be OUs or containers (containerDn throws otherwise)
    for (const s of body.scopes) if (s.kind === 'subtree') await d.directory().containerDn(s.guid);
    return {
      roleId: body.roleId,
      description: body.description,
      principals: await d.store().principals(body.principals),
      scopes: body.scopes,
    };
  };

  t.add({
    method: 'POST',
    url: '/api/v1/rbac/assignments',
    operationId: 'createAssignment',
    summary: 'Assign a role to users/groups within scopes',
    tags: ['rbac'],
    auth: { permission: 'domain.rbac.write' },
    body: rbacAssignmentInput,
    response: created,
    status: 201,
    handler: async (c) => {
      tier0Write(c);
      const data = await assignmentData(c.body);
      const id = await d.store().createAssignment(actor(c), data);
      audit(c, 'rbac.assignment.create', id, undefined, data);
      return { id };
    },
  });

  t.add({
    method: 'PUT',
    url: '/api/v1/rbac/assignments/:id',
    operationId: 'updateAssignment',
    summary: 'Replace an assignment',
    tags: ['rbac'],
    auth: { permission: 'domain.rbac.write' },
    params: idParams,
    body: rbacAssignmentInput,
    response: empty,
    handler: async (c) => {
      tier0Write(c);
      if (c.params.id.startsWith('builtin.'))
        throw new PlatformError('directory.unsupported', { what: 'Changing a built-in assignment' });
      const data = await assignmentData(c.body);
      await d.store().updateAssignment(actor(c), c.params.id, data);
      audit(c, 'rbac.assignment.update', c.params.id, undefined, data);
      return {};
    },
  });

  t.add({
    method: 'DELETE',
    url: '/api/v1/rbac/assignments/:id',
    operationId: 'deleteAssignment',
    summary: 'Remove an assignment',
    tags: ['rbac'],
    auth: { permission: 'domain.rbac.write' },
    params: idParams,
    response: empty,
    handler: async (c) => {
      tier0Write(c);
      if (c.params.id.startsWith('builtin.'))
        throw new PlatformError('directory.unsupported', { what: 'Removing the built-in Domain Admins assignment' });
      await d.store().deleteAssignment(c.params.id);
      audit(c, 'rbac.assignment.delete', c.params.id, { id: c.params.id }, undefined);
      return {};
    },
  });
}
