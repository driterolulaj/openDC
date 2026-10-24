// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Built-in roles (ROADMAP Phase 2 lists Domain Admin / Helpdesk / Read-only Auditor). Phase 1 binds only
 * "Domain Admin" to the AD admin groups; directory-stored roles and assignments (CN=RBAC) arrive with the
 * Phase 2 RBAC UI and are merged in by the caller.
 */
import { PROTECTED_BUILTIN_SIDS, WELL_KNOWN_RIDS } from '@opendc/shared/ldap';
import type { Assignment, Role } from './engine.ts';

export const BUILTIN_ROLES: readonly Role[] = [
  { id: 'builtin.domain-admin', name: 'Domain Admin', permissions: ['*'], tier0: true, builtin: true },
  {
    id: 'builtin.auditor',
    name: 'Read-only Auditor',
    permissions: ['core.console.access', 'core.audit.read', 'core.jobs.read', 'core.node.info', 'core.registry.read'],
    tier0: false,
    builtin: true,
  },
  {
    id: 'builtin.helpdesk',
    name: 'Helpdesk',
    permissions: ['core.console.access', 'core.jobs.read'],
    tier0: false,
    builtin: true,
  },
];

/** Assignments that need no configuration: the domain's own administrators get Domain Admin everywhere. */
export function builtinAssignments(domainSid: string): Assignment[] {
  return [
    {
      id: 'builtin.domain-admins',
      roleId: 'builtin.domain-admin',
      principals: [
        `${domainSid}-${String(WELL_KNOWN_RIDS.domainAdmins)}`,
        `${domainSid}-${String(WELL_KNOWN_RIDS.enterpriseAdmins)}`,
        'S-1-5-32-544', // BUILTIN\Administrators
      ],
      scopes: [{ kind: 'domain' }],
    },
  ];
}

/** Tier-0 guard input: is this object protected (AdminSDHolder territory)? */
export function isProtected(
  o: { adminCount?: number | null; sid?: string | null; groupSids?: readonly string[] },
  domainSid: string,
): boolean {
  if (o.adminCount === 1) return true;
  const protectedRids = [
    WELL_KNOWN_RIDS.administrator,
    WELL_KNOWN_RIDS.krbtgt,
    WELL_KNOWN_RIDS.domainAdmins,
    WELL_KNOWN_RIDS.domainControllers,
    WELL_KNOWN_RIDS.schemaAdmins,
    WELL_KNOWN_RIDS.enterpriseAdmins,
    WELL_KNOWN_RIDS.readOnlyDomainControllers,
  ].map((rid) => `${domainSid}-${String(rid)}`);
  const sids = [...(o.sid ? [o.sid] : []), ...(o.groupSids ?? [])];
  return sids.some((s) => protectedRids.includes(s) || (PROTECTED_BUILTIN_SIDS as readonly string[]).includes(s));
}
