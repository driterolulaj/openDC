// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Directory-stored RBAC (directory-object-model.md §2/§3): roles under CN=Roles and assignments under
 * CN=Assignments of CN=RBAC,CN=OpenDC,CN=System (platform objects, see platform-objects.ts).
 *
 * The RBAC engine needs a synchronous view, so the store keeps a snapshot that is refreshed in the background
 * and right after every write. Assignment scopes are stored by OU GUID and resolved to the current DN on
 * every load, so renames and moves follow; a deleted OU drops out of the scope list.
 */
import { z } from 'zod';
import { PlatformError } from '@opendc/shared';
import { guidBase } from '@opendc/shared/ldap';
import type { DirectoryService } from '../directory/service.ts';
import { guidOf, sidOf, str, typeOf } from '../directory/model.ts';
import { PlatformObjects, type Actor } from '../directory/platform-objects.ts';
import type { Assignment, Role, Scope } from './engine.ts';

export type { Actor };

const roleData = z.object({
  name: z.string(),
  description: z.string().nullable().default(null),
  permissions: z.array(z.string()),
  tier0: z.boolean(),
});
const assignmentData = z.object({
  roleId: z.string(),
  description: z.string().nullable().default(null),
  principals: z.array(z.object({ sid: z.string(), guid: z.string() })),
  scopes: z.array(
    z.union([z.object({ kind: z.literal('domain') }), z.object({ kind: z.literal('subtree'), guid: z.string() })]),
  ),
});

export interface StoredRole extends Role {
  description: string | null;
}
export interface StoredAssignment extends Assignment {
  description: string | null;
  principalRefs: { sid: string; guid: string }[];
  scopeRefs: ({ kind: 'domain' } | { kind: 'subtree'; guid: string; dn: string })[];
}

export interface RbacSnapshot {
  roles: StoredRole[];
  assignments: StoredAssignment[];
  loadedAt: number;
  version: number;
}

export class RbacStore {
  readonly #dir: () => DirectoryService;
  readonly #roles: PlatformObjects<typeof roleData>;
  readonly #assignments: PlatformObjects<typeof assignmentData>;
  #snap: RbacSnapshot = { roles: [], assignments: [], loadedAt: 0, version: 0 };
  #loading: Promise<RbacSnapshot> | null = null;
  readonly #ttlMs: number;

  constructor(dir: () => DirectoryService, ttlMs = 30_000) {
    this.#dir = dir;
    this.#ttlMs = ttlMs;
    this.#roles = new PlatformObjects({
      dir,
      path: ['RBAC', 'Roles'],
      kind: 'rbac.role',
      schemaVersion: 1,
      data: roleData,
      name: (d) => d.name,
    });
    this.#assignments = new PlatformObjects({
      dir,
      path: ['RBAC', 'Assignments'],
      kind: 'rbac.assignment',
      schemaVersion: 1,
      data: assignmentData,
      name: (d) => d.roleId,
    });
  }

  /** The current snapshot (possibly empty before the first load); triggers a refresh when stale. */
  snapshot(): RbacSnapshot {
    if (Date.now() - this.#snap.loadedAt > this.#ttlMs) void this.refresh().catch(() => undefined);
    return this.#snap;
  }

  async refresh(): Promise<RbacSnapshot> {
    this.#loading ??= this.#load().finally(() => {
      this.#loading = null;
    });
    return this.#loading;
  }

  async #load(): Promise<RbacSnapshot> {
    const [roleItems, assignmentItems] = await Promise.all([this.#roles.list(), this.#assignments.list()]);
    const roles: StoredRole[] = roleItems.map((r) => ({
      id: r.id,
      name: r.data.name,
      description: r.data.description,
      permissions: r.data.permissions,
      tier0: r.data.tier0,
      builtin: false,
    }));
    const assignments: StoredAssignment[] = [];
    for (const a of assignmentItems) {
      const scopeRefs: StoredAssignment['scopeRefs'] = [];
      for (const s of a.data.scopes) {
        if (s.kind === 'domain') scopeRefs.push(s);
        else {
          const [o] = await this.#dir().ldap.search(guidBase(s.guid), { scope: 'base', attributes: ['objectGUID'] });
          if (o) scopeRefs.push({ kind: 'subtree', guid: s.guid, dn: o.dn });
        }
      }
      assignments.push({
        id: a.id,
        roleId: a.data.roleId,
        description: a.data.description,
        principals: a.data.principals.map((x) => x.sid),
        principalRefs: a.data.principals,
        scopes: scopeRefs.map((s): Scope => (s.kind === 'domain' ? s : { kind: 'subtree', dn: s.dn })),
        scopeRefs,
      });
    }
    this.#snap = { roles, assignments, loadedAt: Date.now(), version: this.#snap.version + 1 };
    return this.#snap;
  }

  async createRole(actor: Actor, data: z.input<typeof roleData>): Promise<string> {
    const id = await this.#roles.create(actor, roleData.parse(data));
    await this.refresh();
    return id;
  }

  async updateRole(actor: Actor, id: string, data: z.input<typeof roleData>): Promise<void> {
    await this.#roles.update(actor, await this.#roles.get(id), roleData.parse(data));
    await this.refresh();
  }

  async deleteRole(id: string): Promise<void> {
    const cur = await this.#roles.get(id);
    if ((await this.refresh()).assignments.some((a) => a.roleId === id))
      throw new PlatformError('directory.not-empty', { what: `Role ${cur.data.name} (still assigned)` });
    await this.#roles.delete(cur);
    await this.refresh();
  }

  /** Resolves principals (GUIDs of users or groups) to SIDs. */
  async principals(guids: string[]): Promise<{ sid: string; guid: string }[]> {
    const out: { sid: string; guid: string }[] = [];
    for (const g of guids) {
      const [e] = await this.#dir().ldap.search(guidBase(g), {
        scope: 'base',
        attributes: ['objectSid', 'objectClass', 'objectGUID'],
      });
      const sid = e ? sidOf(e) : null;
      const type = e ? typeOf(e) : 'other';
      if (!e || !sid || (type !== 'user' && type !== 'group'))
        throw new PlatformError('validation.invalid', { issues: `principals: ${g} is not a user or group` });
      out.push({ sid, guid: guidOf(e) });
    }
    return out;
  }

  async createAssignment(actor: Actor, data: z.input<typeof assignmentData>): Promise<string> {
    const id = await this.#assignments.create(actor, assignmentData.parse(data));
    await this.refresh();
    return id;
  }

  async updateAssignment(actor: Actor, id: string, data: z.input<typeof assignmentData>): Promise<void> {
    await this.#assignments.update(actor, await this.#assignments.get(id), assignmentData.parse(data));
    await this.refresh();
  }

  async deleteAssignment(id: string): Promise<void> {
    await this.#assignments.delete(await this.#assignments.get(id));
    await this.refresh();
  }

  /** Display names of principals (best effort). */
  async names(guids: string[]): Promise<Map<string, { name: string; type: 'user' | 'group' | 'other' }>> {
    const out = new Map<string, { name: string; type: 'user' | 'group' | 'other' }>();
    for (const g of new Set(guids)) {
      const [e] = await this.#dir()
        .ldap.search(guidBase(g), { scope: 'base', attributes: ['name', 'objectClass', 'objectGUID'] })
        .catch(() => []);
      if (!e) continue;
      const t = typeOf(e);
      out.set(g, { name: str(e, 'name') ?? e.dn, type: t === 'user' || t === 'group' ? t : 'other' });
    }
    return out;
  }
}
