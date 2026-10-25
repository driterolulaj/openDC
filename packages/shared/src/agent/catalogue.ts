// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The agent operation catalogue (docs/design/agent-operations.md §3) as data. This is the complete list of
 * what root can ever be asked to do. `npm run gen` rejects manifests that reference anything else, and the
 * agent refuses to start if the generated allowlist names an operation it doesn't implement.
 */
import type { AgentSocket } from '../manifest/schema.ts';

export type Risk = 'read' | 'write' | 'tier0';

export interface CatalogueEntry {
  sockets: readonly AgentSocket[];
  risk: Risk;
  confirm?: 'typed';
  /**
   * Also callable on the api socket before the domain exists, with the one-time setup token
   * (agent-operations.md §5). The token is verified by the agent, not only by the API.
   */
  setup?: true;
  /** Roadmap phase that implements it. */
  phase: number;
}

const A = 'api' as const;
const W = 'watch' as const;
const C = 'cli' as const;

export const catalogue = {
  // 3.1 System, services, files
  'system.info': { sockets: [A, W, C], risk: 'read', phase: 1 },
  'system.diskUsage': { sockets: [A, W, C], risk: 'read', phase: 1 },
  'system.reboot': { sockets: [A, C], risk: 'write', confirm: 'typed', phase: 4 },
  'system.setHostname': { sockets: [C], risk: 'write', setup: true, phase: 2 },
  'service.status': { sockets: [A, W, C], risk: 'read', phase: 1 },
  'service.start': { sockets: [A, W, C], risk: 'write', phase: 1 },
  'service.stop': { sockets: [A, W, C], risk: 'write', phase: 1 },
  'service.restart': { sockets: [A, W, C], risk: 'write', phase: 1 },
  'service.reload': { sockets: [A, W, C], risk: 'write', phase: 1 },
  'service.enable': { sockets: [A, C], risk: 'write', phase: 2 },
  'service.disable': { sockets: [A, C], risk: 'write', phase: 2 },
  'service.failedUnits': { sockets: [A, W, C], risk: 'read', phase: 4 },
  'journal.read': { sockets: [A, C], risk: 'read', phase: 4 },
  'file.writeManaged': { sockets: [W, C], risk: 'write', phase: 1 },
  'file.readManaged': { sockets: [A, W, C], risk: 'read', phase: 1 },
  'file.restorePrevious': { sockets: [W, C], risk: 'write', phase: 1 },
  'file.removeManaged': { sockets: [W, C], risk: 'write', phase: 3 },
  'registry.commitLock': { sockets: [A, W, C], risk: 'write', phase: 1 },
  // 3.11 Setup (added in Phase 2: agent-operations.md §5)
  'setup.status': { sockets: [A, C], risk: 'read', phase: 2 },
  'setup.preflight': { sockets: [C], risk: 'read', setup: true, phase: 2 },
  // 3.2 Secrets
  'secret.generate': { sockets: [A, C], risk: 'write', phase: 2 },
  'secret.rotate': { sockets: [A, C], risk: 'write', phase: 2 },
  'secret.importFromPeer': { sockets: [C], risk: 'tier0', phase: 4 },
  'secret.delete': { sockets: [A, C], risk: 'write', phase: 2 },
  'secret.deliver': { sockets: [A, C], risk: 'write', phase: 2 },
  // 3.3 Samba / domain
  'samba.status': { sockets: [A, W, C], risk: 'read', phase: 2 },
  'samba.version': { sockets: [A, W, C], risk: 'read', phase: 1 },
  'samba.testparm': { sockets: [A, C], risk: 'read', phase: 2 },
  'samba.provision': { sockets: [C], risk: 'tier0', confirm: 'typed', setup: true, phase: 2 },
  'samba.join': { sockets: [C], risk: 'tier0', confirm: 'typed', setup: true, phase: 2 },
  'samba.demote': { sockets: [A, C], risk: 'tier0', confirm: 'typed', phase: 4 },
  'samba.fsmo.show': { sockets: [A, W, C], risk: 'read', phase: 2 },
  'samba.fsmo.transfer': { sockets: [A, C], risk: 'tier0', confirm: 'typed', phase: 2 },
  'samba.fsmo.seize': { sockets: [A, C], risk: 'tier0', confirm: 'typed', phase: 2 },
  'samba.level.show': { sockets: [A, W, C], risk: 'read', phase: 2 },
  'samba.level.raise': { sockets: [A, C], risk: 'tier0', confirm: 'typed', phase: 2 },
  'samba.drs.showrepl': { sockets: [A, W, C], risk: 'read', phase: 4 },
  'samba.drs.replicate': { sockets: [A, C], risk: 'write', phase: 4 },
  'samba.drs.kcc': { sockets: [A, C], risk: 'write', phase: 4 },
  'samba.sites.create': { sockets: [A, C], risk: 'tier0', phase: 4 },
  'samba.sites.remove': { sockets: [A, C], risk: 'tier0', phase: 4 },
  'samba.sites.subnet.create': { sockets: [A, C], risk: 'tier0', phase: 4 },
  'samba.sites.subnet.remove': { sockets: [A, C], risk: 'tier0', phase: 4 },
  'samba.sites.subnet.setSite': { sockets: [A, C], risk: 'tier0', phase: 4 },
  'samba.sites.link.set': { sockets: [A, C], risk: 'tier0', phase: 4 },
  'samba.protectedObject.modify': { sockets: [A], risk: 'tier0', confirm: 'typed', phase: 2 },
  'samba.gpo.list': { sockets: [A, W, C], risk: 'read', phase: 3 },
  'samba.gpo.backup': { sockets: [A, C], risk: 'write', phase: 3 },
  'samba.gpo.restore': { sockets: [A, C], risk: 'tier0', confirm: 'typed', phase: 3 },
  'samba.gpo.setlink': { sockets: [A, C], risk: 'write', phase: 3 },
  'samba.gpo.dellink': { sockets: [A, C], risk: 'write', phase: 3 },
  'samba.gpo.create': { sockets: [A, C], risk: 'write', phase: 3 },
  'samba.dbcheck': { sockets: [A, C], risk: 'read', phase: 4 },
  'samba.ntacl.sysvolreset': { sockets: [W, C], risk: 'write', phase: 4 },
  'samba.sysvol.pull': { sockets: [W, C], risk: 'write', phase: 4 },
  'samba.idmap.export': { sockets: [C], risk: 'tier0', phase: 4 },
  'samba.idmap.import': { sockets: [C], risk: 'tier0', phase: 4 },
  'samba.backup.online': { sockets: [A, C], risk: 'write', phase: 4 },
  'samba.backup.offline': { sockets: [A, C], risk: 'write', phase: 4 },
  'samba.restore': { sockets: [C], risk: 'tier0', confirm: 'typed', phase: 4 },
  'samba.keytab.export': { sockets: [A, C], risk: 'tier0', phase: 3 },
  'samba.containerImage.install': { sockets: [C], risk: 'tier0', phase: 6 },
  'smb.reloadConfig': { sockets: [W, C], risk: 'write', phase: 6 },
  // 3.4 DNS
  'dns.zone.list': { sockets: [A, W, C], risk: 'read', phase: 3 },
  'dns.zone.create': { sockets: [A], risk: 'write', phase: 3 },
  'dns.zone.delete': { sockets: [A], risk: 'write', confirm: 'typed', phase: 3 },
  'dns.record.add': { sockets: [A, W], risk: 'write', phase: 3 },
  'dns.record.update': { sockets: [A, W], risk: 'write', phase: 3 },
  'dns.record.delete': { sockets: [A, W], risk: 'write', phase: 3 },
  'dns.zone.setAging': { sockets: [A], risk: 'write', phase: 3 },
  // 3.5 DHCP
  'kea.configTest': { sockets: [W], risk: 'read', phase: 3 },
  'kea.command': { sockets: [A, W], risk: 'write', phase: 3 },
  // 3.6 PKI
  'ca.init': { sockets: [C], risk: 'tier0', setup: true, phase: 3 },
  'ca.issuer.create': { sockets: [A, C], risk: 'tier0', confirm: 'typed', phase: 3 },
  'ca.issuer.csr': { sockets: [A, C], risk: 'tier0', phase: 4 },
  'ca.issuer.importSigned': { sockets: [A, C], risk: 'tier0', phase: 4 },
  'ca.root.export': { sockets: [C], risk: 'tier0', confirm: 'typed', phase: 4 },
  'ca.root.offline': { sockets: [C], risk: 'tier0', confirm: 'typed', phase: 4 },
  'cert.issue': { sockets: [A, W], risk: 'write', phase: 3 },
  'cert.revoke': { sockets: [A], risk: 'write', confirm: 'typed', phase: 3 },
  'cert.install': { sockets: [W], risk: 'write', phase: 3 },
  'crl.generate': { sockets: [A, W], risk: 'write', phase: 3 },
  'acme.register': { sockets: [A, W], risk: 'write', phase: 3 },
  'acme.obtain': { sockets: [A, W], risk: 'write', phase: 3 },
  'acme.renew': { sockets: [A, W], risk: 'write', phase: 3 },
  // 3.7 Packages, updates, firewall, time, network
  'pkg.refresh': { sockets: [A, W], risk: 'write', phase: 6 },
  'pkg.listUpgrades': { sockets: [A, W], risk: 'read', phase: 6 },
  'pkg.upgradeAll': { sockets: [A], risk: 'write', confirm: 'typed', phase: 6 },
  'pkg.installSet': { sockets: [A, C], risk: 'write', phase: 2 },
  'pkg.removeSet': { sockets: [A, C], risk: 'write', phase: 2 },
  'pkg.rebootRequired': { sockets: [A, W], risk: 'read', phase: 6 },
  'platform.configureRepo': { sockets: [A, C], risk: 'write', phase: 6 },
  'platform.upgrade': { sockets: [A, C], risk: 'tier0', confirm: 'typed', phase: 6 },
  'firewall.apply': { sockets: [W, C], risk: 'write', phase: 2 },
  'time.configure': { sockets: [W], risk: 'write', phase: 2 },
  'time.tracking': { sockets: [A, W], risk: 'read', phase: 2 },
  'resolver.configure': { sockets: [C], risk: 'write', setup: true, phase: 2 },
  'network.applyWithRollback': { sockets: [C], risk: 'write', confirm: 'typed', setup: true, phase: 2 },
  'network.confirm': { sockets: [C], risk: 'write', setup: true, phase: 2 },
  // 3.8 Containers / App Center
  'container.pull': { sockets: [A], risk: 'write', phase: 5 },
  'container.create': { sockets: [A], risk: 'write', phase: 5 },
  'container.start': { sockets: [A], risk: 'write', phase: 5 },
  'container.stop': { sockets: [A], risk: 'write', phase: 5 },
  'container.restart': { sockets: [A], risk: 'write', phase: 5 },
  'container.remove': { sockets: [A], risk: 'write', phase: 5 },
  'container.logs': { sockets: [A], risk: 'read', phase: 5 },
  'volume.snapshot': { sockets: [A], risk: 'write', phase: 5 },
  'volume.restore': { sockets: [A], risk: 'write', phase: 5 },
  'app.catalog.verifyAndCache': { sockets: [A], risk: 'write', phase: 5 },
  // 3.9 File, print, storage
  'share.ensureDir': { sockets: [W], risk: 'write', phase: 6 },
  'share.setAcl': { sockets: [A, W], risk: 'write', phase: 6 },
  'quota.set': { sockets: [A, W], risk: 'write', phase: 6 },
  'nfs.exportfsReload': { sockets: [W], risk: 'write', phase: 6 },
  'cups.printer.upsert': { sockets: [W], risk: 'write', phase: 6 },
  'cups.printer.delete': { sockets: [W], risk: 'write', phase: 6 },
  // 3.10 Backup, diagnostics, support, node lifecycle
  'backup.run': { sockets: [A], risk: 'write', phase: 4 },
  'backup.transfer': { sockets: [A], risk: 'write', phase: 4 },
  'backup.prune': { sockets: [A], risk: 'write', phase: 4 },
  'backup.restoreComponent': { sockets: [C], risk: 'tier0', confirm: 'typed', phase: 4 },
  'diag.run': { sockets: [A, W], risk: 'read', phase: 4 },
  'support.bundle': { sockets: [A, C], risk: 'read', phase: 7 },
  'node.enroll': { sockets: [C], risk: 'write', phase: 4 },
  'node.cert.renew': { sockets: [W], risk: 'write', phase: 4 },
  'node.leave': { sockets: [C], risk: 'write', confirm: 'typed', phase: 4 },
  'realm.joinLinux': { sockets: [C], risk: 'write', phase: 4 },
  'fleet.connect': { sockets: [A, C], risk: 'write', confirm: 'typed', phase: 7 },
  'fleet.disconnect': { sockets: [A, C], risk: 'write', confirm: 'typed', phase: 7 },
} as const satisfies Record<string, CatalogueEntry>;

export type AgentOpId = keyof typeof catalogue;

export function isCatalogued(op: string): op is AgentOpId {
  return Object.hasOwn(catalogue, op);
}

export function catalogueEntry(op: AgentOpId): CatalogueEntry {
  return catalogue[op];
}
