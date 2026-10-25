// SPDX-License-Identifier: AGPL-3.0-only
import type { ModuleManifest } from '@opendc/shared/manifest';

/**
 * Internal PKI (ADR-0007): root and issuing CAs, node/console/LDAPS certificates with automatic renewal,
 * revocation and CRLs. Approving a DC's issuing CA and revoking certificates are tier-0 actions.
 */
export default {
  manifestVersion: 1,
  id: 'pki',
  version: '0.1.0',
  title: 'pki:module.title',
  description: 'pki:module.description',
  roles: ['any'],
  optional: false,
  permissions: [
    { name: 'pki.read', title: 'pki:perm.read', scope: 'global' },
    { name: 'pki.manage', title: 'pki:perm.manage', scope: 'global', tier0: true, implies: ['pki.read'] },
  ],
  agentOperations: [
    { op: 'ca.init', from: ['cli'] },
    { op: 'ca.issuer.create', from: ['api', 'cli'] },
    { op: 'pki.maintain', from: ['watch', 'cli'] },
    { op: 'cert.revoke', from: ['api'] },
  ],
  watchers: [
    {
      // an issuing CA approved, a certificate revoked: install it / regenerate this DC's CRL
      id: 'pki-changes',
      base: '{platform},CN=PKI',
      scope: 'sub',
      filter: '(objectClass=msDS-App-Configuration)',
      attributes: [],
      roles: ['writable-dc'],
      entry: './watchers/pki-changes.ts',
      timeoutMs: 300_000,
    },
  ],
  i18n: { namespaces: ['pki'] },
} satisfies ModuleManifest;
