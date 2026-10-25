// SPDX-License-Identifier: AGPL-3.0-only
import type { ModuleManifest } from '@opendc/shared/manifest';

/**
 * Policies (ROADMAP Phase 3, directory-object-model.md §3.1/3.2): typed settings linked to OUs, containers or the
 * domain head, the effective-policy viewer, the registry `domain-policy` layer and OU-linked password policies
 * (PSOs + shadow groups, kept up to date by the leader's watcher).
 */
export default {
  manifestVersion: 1,
  id: 'policies',
  version: '0.1.0',
  title: 'policies:module.title',
  description: 'policies:module.description',
  roles: ['any'],
  optional: false,
  permissions: [
    { name: 'policies.policy.read', title: 'policies:perm.read', scope: 'global' },
    {
      // a password policy linked at the domain head reaches Domain Admins: tier 0
      name: 'policies.policy.manage',
      title: 'policies:perm.manage',
      scope: 'global',
      tier0: true,
      implies: ['policies.policy.read'],
    },
  ],
  agentOperations: [{ op: 'policy.password.reconcile', from: ['api', 'watch', 'cli'] }],
  watchers: [
    {
      // a policy was created, changed or deleted: recompute PSOs, shadow groups and memberships
      id: 'password-policies',
      base: '{platform},CN=Policies',
      scope: 'one',
      filter: '(objectClass=msDS-App-Configuration)',
      attributes: [],
      roles: ['writable-dc'],
      leader: true,
      entry: './watchers/password-policies.ts',
      timeoutMs: 600_000,
    },
    {
      // users created or moved, OUs moved: memberships of those users (or all, for OU changes)
      id: 'password-policy-users',
      base: '',
      scope: 'sub',
      filter: '(|(&(objectCategory=person)(objectClass=user))(objectClass=organizationalUnit))',
      // DirSync reports an object only when a listed attribute changed; a move changes `name` (and parentGUID)
      attributes: ['name'],
      roles: ['writable-dc'],
      leader: true,
      entry: './watchers/password-policy-users.ts',
      timeoutMs: 600_000,
    },
  ],
  i18n: { namespaces: ['policies'] },
} satisfies ModuleManifest;
