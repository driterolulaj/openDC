// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Directory-stored RBAC (directory-object-model.md §2/§3): roles under CN=Roles and assignments under
 * CN=Assignments of CN=RBAC,CN=OpenDC,CN=System, one msDS-App-Configuration object each, payload in
 * msDS-Settings ("opendc:v1:" + JSON envelope). Updates are compare-and-swap (delete the old value and add the
 * new one in one modify), so concurrent edits on different DCs fail instead of overwriting each other.
 *
 * The RBAC engine needs a synchronous view, so the store keeps a snapshot that is refreshed in the background
 * and right after every write.
 */
import { randomUUID } from 'node:crypto';
import type { Entry } from 'ldapts';
import { z } from 'zod';
import { PlatformError } from '@opendc/shared';
import { childDn, eq, guidBase } from '@opendc/shared/ldap';
import type { DirectoryService } from '../directory/service.ts';
import { guidOf, sidOf, str, typeOf } from '../directory/model.ts';
import type { Assignment, Role, Scope } from './engine.ts';

export const PAYLOAD_PREFIX = 'opendc:v1:';
const ROLE_SCHEMA = 1;
const ASSIGNMENT_SCHEMA = 1;

const envelope = <T extends z.ZodType>(data: T) =>
  z.object({
    schemaVersion: z.number().int(),
    kind: z.string(),
    rev: z.number().int(),
    updatedBy: z.object({ sid: z.string(), name: z.string(), nodeGuid: z.string() }),
    updatedAt: z.string(),
    data,
  });

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
  raw: string;
  dn: string;
  schemaVersion: number;
}
export interface StoredAssignment extends Assignment {
  description: string | null;
  principalRefs: { sid: string; guid: string }[];
  scopeRefs: ({ kind: 'domain' } | { kind: 'subtree'; guid: string; dn: string })[];
  raw: string;
  dn: string;
  schemaVersion: number;
}

export interface RbacSnapshot {
  roles: StoredRole[];
  assignments: StoredAssignment[];
  loadedAt: number;
  version: number;
}

export interface Actor {
  sid: string;
  name: string;
}

function parse<T extends z.ZodType>(raw: string | null, schema: T): z.infer<ReturnType<typeof envelope<T>>> | null {
  if (!raw?.startsWith(PAYLOAD_PREFIX)) return null;
  try {
    const r = envelope(schema).safeParse(JSON.parse(raw.slice(PAYLOAD_PREFIX.length)));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export class RbacStore {
  readonly #dir: () => DirectoryService;
  #snap: RbacSnapshot = { roles: [], assignments: [], loadedAt: 0, version: 0 };
  #loading: Promise<RbacSnapshot> | null = null;
  readonly #ttlMs: number;

  constructor(dir: () => DirectoryService, ttlMs = 30_000) {
    this.#dir = dir;
    this.#ttlMs = ttlMs;
  }

  /** The current snapshot (possibly empty before the first load); triggers a refresh when stale. */
  snapshot(): RbacSnapshot {
    if (Date.now() - this.#snap.loadedAt > this.#ttlMs) void this.refresh().catch(() => undefined);
    return this.#snap;
  }

  #containers(): { roles: string; assignments: string } {
    const rbac = childDn(this.#dir().platformDn, 'CN', 'RBAC');
    return { roles: childDn(rbac, 'CN', 'Roles'), assignments: childDn(rbac, 'CN', 'Assignments') };
  }

  async refresh(): Promise<RbacSnapshot> {
    this.#loading ??= this.#load().finally(() => {
      this.#loading = null;
    });
    return this.#loading;
  }

  async #load(): Promise<RbacSnapshot> {
    const dir = this.#dir();
    const c = this.#containers();
    const attrs = ['cn', 'msDS-Settings'];
    const [roleEntries, assignmentEntries] = await Promise.all([
      dir.ldap.search(c.roles, {
        scope: 'one',
        filter: eq('objectClass', 'msDS-App-Configuration'),
        attributes: attrs,
      }),
      dir.ldap.search(c.assignments, {
        scope: 'one',
        filter: eq('objectClass', 'msDS-App-Configuration'),
        attributes: attrs,
      }),
    ]);
    const roles: StoredRole[] = [];
    for (const e of roleEntries) {
      const raw = str(e, 'msDS-Settings');
      const p = parse(raw, roleData);
      if (!p || !raw) continue;
      roles.push({
        id: str(e, 'cn') ?? '',
        name: p.data.name,
        description: p.data.description,
        permissions: p.data.permissions,
        tier0: p.data.tier0,
        builtin: false,
        raw,
        dn: e.dn,
        schemaVersion: p.schemaVersion,
      });
    }
    const assignments: StoredAssignment[] = [];
    for (const e of assignmentEntries) {
      const raw = str(e, 'msDS-Settings');
      const p = parse(raw, assignmentData);
      if (!p || !raw) continue;
      // scopes by GUID: resolve the current DN; a deleted OU drops out of the scope list
      const scopeRefs: StoredAssignment['scopeRefs'] = [];
      for (const s of p.data.scopes) {
        if (s.kind === 'domain') scopeRefs.push(s);
        else {
          const [o] = await dir.ldap.search(guidBase(s.guid), { scope: 'base', attributes: ['objectGUID'] });
          if (o) scopeRefs.push({ kind: 'subtree', guid: s.guid, dn: o.dn });
        }
      }
      assignments.push({
        id: str(e, 'cn') ?? '',
        roleId: p.data.roleId,
        description: p.data.description,
        principals: p.data.principals.map((x) => x.sid),
        principalRefs: p.data.principals,
        scopes: scopeRefs.map((s): Scope => (s.kind === 'domain' ? s : { kind: 'subtree', dn: s.dn })),
        scopeRefs,
        raw,
        dn: e.dn,
        schemaVersion: p.schemaVersion,
      });
    }
    this.#snap = { roles, assignments, loadedAt: Date.now(), version: this.#snap.version + 1 };
    return this.#snap;
  }

  #payload(kind: string, schemaVersion: number, rev: number, actor: Actor, data: unknown): string {
    return (
      PAYLOAD_PREFIX +
      JSON.stringify({
        schemaVersion,
        kind,
        rev,
        updatedBy: { sid: actor.sid, name: actor.name, nodeGuid: '' },
        updatedAt: new Date().toISOString(),
        data,
      })
    );
  }

  async #create(
    container: string,
    kind: string,
    schema: number,
    actor: Actor,
    data: unknown,
    name: string,
  ): Promise<string> {
    const id = randomUUID();
    await this.#dir().ldap.add(childDn(container, 'CN', id), {
      objectClass: ['top', 'msDS-App-Configuration'],
      displayName: [name],
      'msDS-Settings': [this.#payload(kind, schema, 1, actor, data)],
    });
    await this.refresh();
    return id;
  }

  /** Compare-and-swap update: fails with request.conflict if the stored value changed meanwhile. */
  async #update(
    current: { dn: string; raw: string; schemaVersion: number },
    kind: string,
    schema: number,
    actor: Actor,
    data: unknown,
    name: string,
  ): Promise<void> {
    if (current.schemaVersion > schema)
      throw new PlatformError('request.conflict', { what: `${name} (written by a newer OpenDC version)` });
    const rev = (parse(current.raw, z.unknown())?.rev ?? 0) + 1;
    try {
      await this.#dir().ldap.modify(current.dn, [
        { op: 'delete', attr: 'msDS-Settings', values: [current.raw] },
        { op: 'add', attr: 'msDS-Settings', values: [this.#payload(kind, schema, rev, actor, data)] },
        { op: 'replace', attr: 'displayName', values: [name] },
      ]);
    } catch (e) {
      if (e instanceof PlatformError && (e.code === 'directory.invalid' || e.code === 'ldap.operation-failed'))
        throw new PlatformError('request.conflict', { what: name }, { cause: e });
      throw e;
    }
    await this.refresh();
  }

  async createRole(actor: Actor, data: z.input<typeof roleData>): Promise<string> {
    return this.#create(this.#containers().roles, 'rbac.role', ROLE_SCHEMA, actor, data, data.name);
  }

  async updateRole(actor: Actor, id: string, data: z.input<typeof roleData>): Promise<void> {
    const cur = (await this.refresh()).roles.find((r) => r.id === id);
    if (!cur) throw new PlatformError('request.not-found', { what: `Role ${id}` });
    await this.#update(cur, 'rbac.role', ROLE_SCHEMA, actor, data, data.name);
  }

  async deleteRole(id: string): Promise<void> {
    const snap = await this.refresh();
    const cur = snap.roles.find((r) => r.id === id);
    if (!cur) throw new PlatformError('request.not-found', { what: `Role ${id}` });
    if (snap.assignments.some((a) => a.roleId === id))
      throw new PlatformError('directory.not-empty', { what: `Role ${cur.name} (still assigned)` });
    await this.#dir().ldap.del(cur.dn);
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
    return this.#create(this.#containers().assignments, 'rbac.assignment', ASSIGNMENT_SCHEMA, actor, data, data.roleId);
  }

  async updateAssignment(actor: Actor, id: string, data: z.input<typeof assignmentData>): Promise<void> {
    const cur = (await this.refresh()).assignments.find((a) => a.id === id);
    if (!cur) throw new PlatformError('request.not-found', { what: `Assignment ${id}` });
    await this.#update(cur, 'rbac.assignment', ASSIGNMENT_SCHEMA, actor, data, data.roleId);
  }

  async deleteAssignment(id: string): Promise<void> {
    const cur = (await this.refresh()).assignments.find((a) => a.id === id);
    if (!cur) throw new PlatformError('request.not-found', { what: `Assignment ${id}` });
    await this.#dir().ldap.del(cur.dn);
    await this.refresh();
  }

  /** Display names of principals (best effort). */
  async names(guids: string[]): Promise<Map<string, { name: string; type: 'user' | 'group' | 'other' }>> {
    const out = new Map<string, { name: string; type: 'user' | 'group' | 'other' }>();
    for (const g of new Set(guids)) {
      const [e]: Entry[] = await this.#dir()
        .ldap.search(guidBase(g), { scope: 'base', attributes: ['name', 'objectClass', 'objectGUID'] })
        .catch(() => []);
      if (!e) continue;
      const t = typeOf(e);
      out.set(g, { name: str(e, 'name') ?? e.dn, type: t === 'user' || t === 'group' ? t : 'other' });
    }
    return out;
  }
}
