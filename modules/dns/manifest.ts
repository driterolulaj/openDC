// SPDX-License-Identifier: AGPL-3.0-only
import type { ModuleManifest } from '@opendc/shared/manifest';

/**
 * DNS (ROADMAP Phase 3, Spike S3): zones and records of Samba's internal DNS, read over LDAP and changed through
 * the agent; DNS diagnostics for the records domain controllers need.
 */
export default {
  manifestVersion: 1,
  id: 'dns',
  version: '0.1.0',
  title: 'dns:module.title',
  description: 'dns:module.description',
  roles: ['any'],
  optional: false,
  permissions: [
    { name: 'dns.zones.read', title: 'dns:perm.read', scope: 'global' },
    // records DCs register for themselves additionally need a tier-0 role (checked per record)
    { name: 'dns.records.write', title: 'dns:perm.records-write', scope: 'global', implies: ['dns.zones.read'] },
    { name: 'dns.zones.manage', title: 'dns:perm.zones-manage', scope: 'global', implies: ['dns.records.write'] },
  ],
  agentOperations: [
    { op: 'dns.zone.list', from: ['api', 'cli'] },
    { op: 'dns.zone.create', from: ['api'] },
    { op: 'dns.zone.delete', from: ['api'] },
    { op: 'dns.zone.setAging', from: ['api'] },
    { op: 'dns.record.add', from: ['api'] },
    { op: 'dns.record.update', from: ['api'] },
    { op: 'dns.record.delete', from: ['api'] },
  ],
  i18n: { namespaces: ['dns'] },
} satisfies ModuleManifest;
