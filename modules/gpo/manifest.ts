// SPDX-License-Identifier: AGPL-3.0-only
import type { ModuleManifest } from '@opendc/shared/manifest';

/**
 * Group policy objects (ROADMAP Phase 3): list, create, back up, restore, link and unlink. Whatever writes SYSVOL
 * runs on the PDC emulator (ADR-0019); editing a GPO's settings stays with GPMC or `samba-tool gpo manage`.
 */
export default {
  manifestVersion: 1,
  id: 'gpo',
  version: '0.1.0',
  title: 'gpo:module.title',
  description: 'gpo:module.description',
  roles: ['writable-dc'],
  optional: false,
  permissions: [
    { name: 'gpo.read', title: 'gpo:perm.read', scope: 'global' },
    // restores and links on the domain or the Domain Controllers OU additionally need a tier-0 role
    { name: 'gpo.write', title: 'gpo:perm.write', scope: 'global', implies: ['gpo.read'] },
  ],
  agentOperations: [
    { op: 'samba.gpo.create', from: ['api', 'cli'] },
    { op: 'samba.gpo.backup', from: ['api', 'cli'] },
    { op: 'samba.gpo.backup.list', from: ['api', 'cli'] },
    { op: 'samba.gpo.backup.delete', from: ['api', 'cli'] },
    { op: 'samba.gpo.restore', from: ['api', 'cli'] },
    { op: 'samba.gpo.setlink', from: ['api', 'cli'] },
    { op: 'samba.gpo.dellink', from: ['api', 'cli'] },
  ],
  i18n: { namespaces: ['gpo'] },
} satisfies ModuleManifest;
