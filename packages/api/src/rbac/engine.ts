// SPDX-License-Identifier: AGPL-3.0-only
/**
 * RBAC engine (SECURITY.md §5): roles grant permissions, assignments bind roles to principals (user or
 * group SIDs, resolved through tokenGroups) within scopes. Pure and synchronous; the API's preHandler and
 * object-level checks call it.
 *
 *  - Permissions expand through `implies`.
 *  - A tier-0 permission only counts in a role flagged tier0.
 *  - Tier-0 guard: a protected target (adminCount=1, protected groups) needs a tier0 role, whatever the scope.
 *  - "ou" permissions are scoped by DN subtree (normalised RDN comparison); "node" by node GUID; "global" by
 *    nothing.
 */
import { isWithin } from '@opendc/shared/ldap';

export interface PermissionMeta {
  name: string;
  scope: 'ou' | 'node' | 'global';
  tier0?: boolean;
  implies?: readonly string[];
}

export interface Role {
  id: string;
  name: string;
  /** Permission names; "*" grants every permission. */
  permissions: readonly string[];
  tier0: boolean;
  builtin: boolean;
}

export type Scope = { kind: 'domain' } | { kind: 'subtree'; dn: string } | { kind: 'node'; nodeGuid: string };

export interface Assignment {
  id: string;
  roleId: string;
  /** User or group SIDs. */
  principals: readonly string[];
  scopes: readonly Scope[];
}

export interface Subject {
  sid: string;
  /** Transitive group SIDs (tokenGroups). */
  groupSids: readonly string[];
}

export interface Target {
  dn?: string;
  nodeGuid?: string;
  /** adminCount=1 or member of a protected group. */
  protected?: boolean;
}

export type Denial = 'no-permission' | 'out-of-scope' | 'tier0';
export type Decision = { allow: true; via: string[] } | { allow: false; reason: Denial };

export interface EffectivePermission {
  permission: string;
  scopes: Scope[];
  tier0: boolean;
}

export class RbacEngine {
  readonly #perms: ReadonlyMap<string, PermissionMeta>;
  readonly #roles: ReadonlyMap<string, Role>;
  readonly #assignments: readonly Assignment[];
  readonly #expanded = new Map<string, ReadonlySet<string>>();

  constructor(permissions: readonly PermissionMeta[], roles: readonly Role[], assignments: readonly Assignment[]) {
    this.#perms = new Map(permissions.map((p) => [p.name, p]));
    this.#roles = new Map(roles.map((r) => [r.id, r]));
    this.#assignments = assignments;
    for (const r of roles) {
      for (const p of r.permissions)
        if (p !== '*' && !this.#perms.has(p)) throw new TypeError(`Role ${r.id} grants unknown permission ${p}`);
    }
    for (const a of assignments)
      if (!this.#roles.has(a.roleId)) throw new TypeError(`Assignment ${a.id} references unknown role ${a.roleId}`);
  }

  meta(permission: string): PermissionMeta {
    const m = this.#perms.get(permission);
    if (!m) throw new TypeError(`Unknown permission ${permission}`);
    return m;
  }

  /** Permissions a role effectively grants (implies closure; tier-0 permissions only for tier0 roles). */
  rolePermissions(role: Role): ReadonlySet<string> {
    const cached = this.#expanded.get(role.id);
    if (cached) return cached;
    const out = new Set<string>();
    const queue = role.permissions.includes('*') ? [...this.#perms.keys()] : [...role.permissions];
    while (queue.length) {
      const p = queue.pop() as string;
      if (out.has(p)) continue;
      const m = this.#perms.get(p);
      if (!m || (m.tier0 && !role.tier0)) continue;
      out.add(p);
      queue.push(...(m.implies ?? []));
    }
    this.#expanded.set(role.id, out);
    return out;
  }

  #matching(subject: Subject): { a: Assignment; role: Role }[] {
    const sids = new Set([subject.sid, ...subject.groupSids]);
    const out: { a: Assignment; role: Role }[] = [];
    for (const a of this.#assignments) {
      if (!a.principals.some((p) => sids.has(p))) continue;
      const role = this.#roles.get(a.roleId);
      if (role) out.push({ a, role });
    }
    return out;
  }

  /**
   * Is `subject` allowed `permission` on `target`? Without a target, answers "anywhere at all" (used to
   * decide whether a route or menu entry is reachable; object-level checks must pass the target).
   */
  can(subject: Subject, permission: string, target?: Target): Decision {
    const meta = this.meta(permission);
    let best: Denial = 'no-permission';
    const via: string[] = [];
    for (const { a, role } of this.#matching(subject)) {
      if (!this.rolePermissions(role).has(permission)) continue;
      if (target?.protected && !role.tier0) {
        best = 'tier0';
        continue;
      }
      if (target && !inScope(meta.scope, a.scopes, target)) {
        if (best === 'no-permission') best = 'out-of-scope';
        continue;
      }
      via.push(a.id);
    }
    return via.length ? { allow: true, via } : { allow: false, reason: best };
  }

  /** Everything the subject may do, with scopes (for /session/permissions and the UI). */
  effective(subject: Subject): EffectivePermission[] {
    const out = new Map<string, EffectivePermission>();
    for (const { a, role } of this.#matching(subject)) {
      for (const p of this.rolePermissions(role)) {
        const e = out.get(p) ?? { permission: p, scopes: [], tier0: false };
        e.scopes.push(...a.scopes);
        e.tier0 ||= role.tier0;
        out.set(p, e);
      }
    }
    return [...out.values()].sort((x, y) => x.permission.localeCompare(y.permission));
  }
}

function inScope(kind: PermissionMeta['scope'], scopes: readonly Scope[], target: Target): boolean {
  if (kind === 'global') return true;
  return scopes.some((s) => {
    if (s.kind === 'domain') return true;
    if (kind === 'ou' && s.kind === 'subtree') return target.dn !== undefined && isWithin(target.dn, s.dn);
    if (kind === 'node' && s.kind === 'node')
      return target.nodeGuid !== undefined && target.nodeGuid.toLowerCase() === s.nodeGuid.toLowerCase();
    return false;
  });
}
