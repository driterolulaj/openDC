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
  /** The watcher's status snapshot (JSON, no secrets), readable by the API. */
  watcherStatus: string;
  /** Audit entries from services without the audit DB (the watcher), ingested by the API (ADR-0013). */
  auditInbox: string;
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
  | 'ss'
  | 'ldbadd'
  | 'ldbmodify'
  | 'ldbsearch'
  | 'hostnamectl'
  | 'apt-get'
  | 'apt-cache'
  | 'systemd-run'
  | 'kea-dhcp4'
  | 'kea-dhcp6';

export interface BinaryLocator {
  /** Absolute path, or throws PlatformError(os.binary-missing) naming the package to install. */
  resolve(name: LogicalBinary): Promise<string>;
}

/** One Kea server daemon (DHCPv4 or DHCPv6). */
export interface KeaDaemon {
  binary: 'kea-dhcp4' | 'kea-dhcp6';
  /** logical package set (packageNames() maps it) */
  packages: string;
  configFile: string;
  leaseFile: string;
  controlSocket: string;
  /** logical unit id (unitName() maps it) */
  unit: string;
}

export interface KeaFacts {
  hooksDir: string;
  /** the account Kea runs as (owns its configuration) */
  user: string;
  v4: KeaDaemon;
  v6: KeaDaemon;
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
  /** Kea DHCPv4/v6 as the distribution packages it (paths the Kea security releases insist on). */
  kea(): Promise<KeaFacts>;
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
  enable(unit: string, now: boolean): Promise<void>;
  disable(unit: string, now: boolean): Promise<void>;
  /** Prevents a unit from being started at all (distro Samba file-server units on a DC). */
  mask(unit: string): Promise<void>;
  unmask(unit: string): Promise<void>;
  /** Starts the unit and waits until systemd reports it active (or fails). */
  startAndWait(unit: string, timeoutMs: number): Promise<void>;
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

export interface InterfaceAddress {
  iface: string;
  family: 'inet' | 'inet6';
  address: string;
  prefix: number;
  /** Assigned by DHCP/SLAAC (lease lifetime), not configured statically. */
  dynamic: boolean;
}

export interface ListeningSocket {
  proto: 'tcp' | 'udp';
  address: string;
  port: number;
  process: string | null;
}

export interface TimeSync {
  synchronized: boolean;
  /** System clock offset from the reference in seconds (positive = fast). */
  offsetSec: number | null;
  reference: string | null;
}

/**
 * Host configuration and facts that need root or know distro specifics (setup and pre-flight). The files
 * these methods write are fixed system files, never caller-supplied paths.
 */
export interface HostActions {
  /** Sets the static hostname to the first label of `fqdn` and maps `fqdn` to `ip` in /etc/hosts. */
  setHostname(fqdn: string, ip: string): Promise<{ changed: boolean }>;
  /** Writes the stub resolver configuration; `freePort53` also stops a local stub resolver on port 53. */
  configureResolver(o: { nameservers: string[]; searchDomains: string[]; freePort53: boolean }): Promise<void>;
  addresses(): Promise<InterfaceAddress[]>;
  /**
   * The real upstream DNS servers of this host (behind a local stub resolver such as systemd-resolved),
   * never loopback addresses.
   */
  upstreamNameservers(): Promise<string[]>;
  listening(): Promise<ListeningSocket[]>;
  filesystem(path: string): Promise<{ type: string; freeBytes: number }>;
  timeSync(): Promise<TimeSync>;
  /** Writes the chrony drop-in for a DC (MS-SNTP signing via Samba's ntp_signd socket). */
  configureTimeServer(o: { signdSocketDir: string; allow: string[]; upstream: string[] }): Promise<void>;
}

export interface PackageActions {
  /** Installs distro packages non-interactively. Names come from manifest package sets, never from callers. */
  install(names: readonly string[]): Promise<void>;
  /** Installed version, or null. */
  installed(name: string): Promise<string | null>;
  /** Version the package manager would install, or null when no repository offers it. */
  candidate(name: string): Promise<string | null>;
}

export interface OsActions {
  readonly facts: OsFacts;
  readonly services: ServiceActions;
  readonly files: FileActions;
  readonly system: SystemActions;
  readonly host: HostActions;
  readonly packages: PackageActions;
  /** Starts a process (argv only); exposed for typed operations that build their own argv (samba-tool). */
  readonly exec: import('./exec.ts').Exec;
}
