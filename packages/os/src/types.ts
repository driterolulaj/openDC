// SPDX-License-Identifier: AGPL-3.0-only
/**
 * OS abstraction layer (ADR-0008, docs/design/os-adapter.ts). Phase 1 implements the facts and the actions
 * the Phase 1 agent operations need; the remaining action groups arrive with the phases that use them.
 *
 *  - OsFacts   read-only. Usable anywhere (API planning, pre-flight, templates).
 *  - OsActions state-changing. Only instantiated inside opendc-agent (root).
 */
import type { NodeRole } from '@opendc/shared/manifest';

export type AdapterId = 'debian' | 'rhel' | 'suse' | 'arch' | 'alpine';
export type Arch = 'x86_64' | 'arm64';
export type SupportTier = 1 | 2 | 'unsupported';

export interface OsRelease {
  id: string;
  idLike: string[];
  versionId: string;
  versionCodename?: string;
  prettyName: string;
  arch: Arch;
}

export interface SupportReason {
  code: string;
  messageKey: string;
  fixKey?: string;
  params?: Record<string, string>;
}

export interface SupportVerdict {
  tier: SupportTier;
  sambaMode: 'native' | 'container' | 'n/a';
  reasons: SupportReason[];
}

export interface SambaVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

export interface PlatformPaths {
  etc: string;
  secrets: string;
  lib: string;
  state: string;
  run: string;
  /** Resolve a manifest pathKey to an absolute path; throws PlatformError(os.unknown-path-key). */
  managedFile(pathKey: string): string;
  /** Roots that managed writes must stay inside after realpath(). Never includes the secrets dir. */
  managedRoots(): readonly string[];
}

export type LogicalBinary =
  | 'samba'
  | 'samba-tool'
  | 'smbcontrol'
  | 'testparm'
  | 'net'
  | 'wbinfo'
  | 'kinit'
  | 'klist'
  | 'openssl'
  | 'chronyc'
  | 'systemctl'
  | 'journalctl'
  | 'hostname'
  | 'ip'
  | 'ss';

export interface BinaryLocator {
  /** Absolute path, or throws PlatformError(os.binary-missing) naming the package to install. */
  resolve(name: LogicalBinary): Promise<string>;
}

export interface SambaFacts {
  mode(): Promise<'native' | 'container' | 'absent'>;
  version(): Promise<SambaVersion | null>;
  paths(): { smbConf: string; privateDir: string; sysvol: string; stateDir: string; tlsDir: string };
}

export interface OsFacts {
  readonly adapter: AdapterId;
  readonly release: OsRelease;
  readonly paths: PlatformPaths;
  readonly binaries: BinaryLocator;
  readonly samba: SambaFacts;
  /** Logical unit id -> systemd unit name. */
  unitName(unit: string): string;
  /** Logical package -> distro package names. */
  packageNames(logical: string): string[];
  macKind(): Promise<'selinux' | 'apparmor' | 'none'>;
  resolverKind(): Promise<'systemd-resolved' | 'resolv.conf' | 'networkmanager'>;
  networkKind(): Promise<'netplan' | 'networkmanager' | 'ifupdown' | 'systemd-networkd' | 'unknown'>;
  /** Support matrix for a role on this host. Uses the detected Samba version for DC roles. */
  support(role: NodeRole): Promise<SupportVerdict>;
}

export interface ServiceStatus {
  active: string;
  sub: string;
  enabled: boolean;
  since?: string;
}

export interface ServiceActions {
  status(unit: string): Promise<ServiceStatus>;
  start(unit: string): Promise<void>;
  stop(unit: string): Promise<void>;
  restart(unit: string): Promise<void>;
  reload(unit: string): Promise<void>;
}

export interface WriteResult {
  changed: boolean;
  sha256: string;
  previousSha256: string | null;
}

export interface FileActions {
  /**
   * Atomic write (temp file in the same dir, fsync, rename, fsync dir) that keeps the previous version as
   * `<path>.opendc-prev`. The parent's realpath must be inside managedRoots(); the final path component must
   * not be a symlink.
   */
  writeManaged(
    path: string,
    content: string,
    owner: { uid: number; gid: number } | null,
    mode: number,
  ): Promise<WriteResult>;
  readManaged(path: string): Promise<{ content: string; sha256: string } | null>;
  restorePrevious(path: string): Promise<{ restored: boolean; sha256: string | null }>;
}

export interface SystemInfo {
  hostname: string;
  fqdn: string;
  kernel: string;
  uptimeSec: number;
  memTotal: number;
  cpus: number;
}

export interface SystemActions {
  info(): Promise<SystemInfo>;
}

export interface OsActions {
  readonly facts: OsFacts;
  readonly services: ServiceActions;
  readonly files: FileActions;
  readonly system: SystemActions;
}
