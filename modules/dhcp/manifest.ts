// SPDX-License-Identifier: AGPL-3.0-only
import type { ModuleManifest } from '@opendc/shared/manifest';

/**
 * DHCPv4 with Kea (ROADMAP Phase 3, Spike S4): services (one server or an HA pair), subnets with pools and options,
 * reservations, DHCP policies for server-wide options; the serving node renders Kea's configuration from the
 * directory and reloads it without a restart.
 */
export default {
  manifestVersion: 1,
  id: 'dhcp',
  version: '0.1.0',
  title: 'dhcp:module.title',
  description: 'dhcp:module.description',
  roles: ['any'],
  optional: true,
  permissions: [
    { name: 'dhcp.read', title: 'dhcp:perm.read', scope: 'global' },
    { name: 'dhcp.write', title: 'dhcp:perm.write', scope: 'global', implies: ['dhcp.read'] },
  ],
  agentOperations: [
    { op: 'dhcp.apply', from: ['watch', 'cli'] },
    { op: 'dhcp.leases', from: ['api', 'cli'] },
  ],
  managed: {
    packageSets: [{ id: 'kea', logicalPackages: ['kea'], roles: ['any'] }],
  },
  watchers: [
    {
      // services, subnets, reservations: this node's Kea configuration
      id: 'kea',
      base: '{platform},CN=DHCP',
      scope: 'sub',
      filter: '(objectClass=msDS-App-Configuration)',
      attributes: [],
      roles: ['any'],
      entry: './watchers/kea.ts',
      timeoutMs: 600_000,
    },
    {
      // DHCP policies: server-wide options of this node
      id: 'kea-policies',
      base: '{platform},CN=Policies',
      scope: 'one',
      filter: '(objectClass=msDS-App-Configuration)',
      attributes: [],
      roles: ['any'],
      entry: './watchers/kea.ts',
      timeoutMs: 600_000,
    },
  ],
  i18n: { namespaces: ['dhcp'] },
} satisfies ModuleManifest;
