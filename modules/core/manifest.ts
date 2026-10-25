// SPDX-License-Identifier: AGPL-3.0-only
import type { ModuleManifest } from '@opendc/shared/manifest';

/** Core platform module: console access, node configuration, audit. Always enabled. */
export default {
  manifestVersion: 1,
  id: 'core',
  version: '0.1.0',
  title: 'core:module.title',
  description: 'core:module.description',
  roles: ['any'],
  optional: false,
  permissions: [
    { name: 'core.console.access', title: 'core:perm.console-access', scope: 'global' },
    { name: 'core.registry.read', title: 'core:perm.registry-read', scope: 'node' },
    { name: 'core.registry.write', title: 'core:perm.registry-write', scope: 'node', implies: ['core.registry.read'] },
    { name: 'core.audit.read', title: 'core:perm.audit-read', scope: 'global' },
    { name: 'core.jobs.read', title: 'core:perm.jobs-read', scope: 'global' },
    { name: 'core.node.info', title: 'core:perm.node-info', scope: 'node' },
  ],
  registry: {
    keysEntry: './registry/keys.ts',
    templates: [
      {
        fileId: 'core.demo',
        entry: './registry/templates/demo.ts',
        reads: ['core.demo.*'],
        roles: ['any'],
      },
    ],
  },
  agentOperations: [
    { op: 'system.info', from: ['api', 'watch', 'cli'] },
    { op: 'samba.version', from: ['api', 'cli'] },
    { op: 'service.status', from: ['api', 'watch', 'cli'] },
    { op: 'service.restart', from: ['cli'] },
    { op: 'service.reload', from: ['watch', 'cli'] },
    { op: 'file.writeManaged', from: ['watch', 'cli'] },
    { op: 'file.readManaged', from: ['api', 'watch', 'cli'] },
    { op: 'file.restorePrevious', from: ['watch', 'cli'] },
    { op: 'registry.commitLock', from: ['api', 'watch', 'cli'] },
  ],
  managed: {
    files: [
      { fileId: 'core.demo', pathKey: 'opendc.demo', owner: 'root', mode: '0644', comment: 'hash' },
      {
        fileId: 'core.registry-local',
        pathKey: 'opendc.registry.local',
        owner: 'root',
        mode: '0644',
        comment: 'json-field',
      },
      {
        fileId: 'core.registry-forced',
        pathKey: 'opendc.registry.forced',
        owner: 'root',
        mode: '0644',
        comment: 'json-field',
      },
      {
        // the domain-policy layer, written by the watcher (registry policies for this node)
        fileId: 'core.registry-policy',
        pathKey: 'opendc.registry.policy',
        owner: 'root',
        mode: '0644',
        comment: 'json-field',
      },
      {
        fileId: 'core.registry-rendered',
        pathKey: 'opendc.registry.rendered',
        owner: 'root',
        mode: '0644',
        comment: 'json-field',
      },
    ],
    units: [
      { unit: 'opendc-api', allowed: ['status', 'restart'] },
      { unit: 'opendc-watcher', allowed: ['status', 'restart'] },
      { unit: 'samba-ad-dc', allowed: ['status'] },
    ],
  },
  i18n: { namespaces: ['core'] },
} satisfies ModuleManifest;
