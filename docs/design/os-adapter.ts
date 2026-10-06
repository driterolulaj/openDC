/**
 * MyUCS OS abstraction layer (ADR-0008).
 *
 * Two halves:
 *  - OsFacts   — read-only, side-effect-free. Usable anywhere (API planning, pre-flight, templates).
 *  - OsActions — state-changing. ONLY instantiated inside myucs-agent (root).
 *
 * All command execution inside actions uses execFile with argv arrays (no shell), absolute binary paths
 * from OsFacts.binaries, a fixed environment, timeouts and output limits.
 *
 * Phase 1: moves to packages/os/src/types.ts. Debian adapter first.
 */

export type AdapterId = 'debian' | 'rhel' | 'suse' | 'arch' | 'alpine';
export type Arch = 'x86_64' | 'arm64';
export type SupportTier = 1 | 2 | 'unsupported';
export type NodeRole = 'primary-dc' | 'dc' | 'rodc' | 'member' | 'managed-node';

export interface OsRelease {
  id: string; // e.g. "debian", "ubuntu", "rocky"
  idLike: string[];
  versionId: string; // e.g. "13", "24.04"
  prettyName: string;
  arch: Arch;
}

export interface SupportVerdict {
  tier: SupportTier;
  /** For DC roles. "unsupported" with a reason when refused. */
  sambaMode: 'native' | 'container' | 'n/a';
  reasons: { code: string; messageKey: string; fixKey?: string; params?: Record<string, string> }[];
}

// ---------------------------------------------------------------------------
// Facts (read-only)
// ---------------------------------------------------------------------------

export interface OsFacts {
  readonly adapter: AdapterId;
  readonly release: OsRelease;
  /** Evaluate the support matrix for a role on this host. */
  support(role: NodeRole): SupportVerdict;

  readonly paths: PlatformPaths;
  readonly binaries: BinaryLocator;
  readonly units: UnitNameMap;
  readonly packages: PackageNameMap;

  readonly samba: SambaFacts;
  readonly kerberos: KerberosFacts;
  readonly mac: MacFacts;
  readonly firewall: FirewallFacts;
  readonly resolver: ResolverFacts;
  readonly network: NetworkFacts;
  readonly containers: ContainerFacts;

  /** Pre-flight checks that are OS-specific (generic ones live in the setup module). */
  preflight(role: NodeRole): Promise<PreflightResult[]>;
}

export interface PlatformPaths {
  etc: string; // /etc/myucs
  secrets: string; // /etc/myucs/secrets
  lib: string; // /usr/lib/myucs
  state: string; // /var/lib/myucs
  run: string; // /run/myucs
  /** Resolve a manifest pathKey (e.g. "kea.dhcp4.conf") to an absolute path; throws if unknown. */
  managedFile(pathKey: string): string;
  /** Allowed roots for any managed write — the agent rejects anything outside after realpath(). */
  managedRoots(): readonly string[];
}

export interface BinaryLocator {
  /** Absolute path or throws PlatformError(code: "os.binary-missing", fix names the package). */
  resolve(name: LogicalBinary): Promise<string>;
}

export type LogicalBinary =
  | 'samba' | 'samba-tool' | 'smbcontrol' | 'testparm' | 'net' | 'wbinfo' | 'ntlm_auth'
  | 'kinit' | 'klist' | 'kvno' | 'ktutil'
  | 'kea-dhcp4' | 'kea-dhcp6' | 'kea-shell'
  | 'lpadmin' | 'lpstat' | 'cupsctl'
  | 'exportfs'
  | 'openssl'
  | 'podman' | 'docker'
  | 'chronyc'
  | 'systemctl' | 'journalctl'
  | 'nginx'
  | 'lego'
  | 'rsync' | 'ssh'
  | 'realm' | 'adcli' | 'sssctl'
  | 'setquota' | 'repquota'
  | 'ip' | 'ss';

/** Logical unit id → distro unit name (e.g. "samba-ad-dc" → "samba-ad-dc.service" / "samba.service"). */
export interface UnitNameMap {
  resolve(unit: string): string;
}

/** Logical package → distro package names (e.g. "samba-dc" → ["samba", "winbind", "krb5-user", ...]). */
export interface PackageNameMap {
  resolve(logical: string): string[];
}

export interface SambaFacts {
  mode(): 'native' | 'container' | 'absent';
  /** Parsed `samba --version` (via container exec in container mode). */
  version(): Promise<{ major: number; minor: number; patch: number; raw: string } | null>;
  kerberosFlavor(): Promise<'heimdal' | 'mit' | 'unknown'>;
  /** Paths to private dir, sysvol, smb.conf — differ between distros/container. */
  paths(): { smbConf: string; privateDir: string; sysvol: string; stateDir: string; idmapLdb: string };
  /** Whether this build supports the AD DC role at all. */
  supportsDcRole(): Promise<boolean>;
}

export interface KerberosFacts {
  krb5Conf: string;
  hostKeytab: string;
}

export interface MacFacts {
  kind: 'selinux' | 'apparmor' | 'none';
  state(): Promise<'enforcing' | 'permissive' | 'disabled' | 'complain' | 'unknown'>;
}

export interface FirewallFacts {
  kind: 'nftables' | 'firewalld' | 'ufw' | 'none';
}

export interface ResolverFacts {
  kind: 'systemd-resolved' | 'resolv.conf' | 'networkmanager';
  /** True if something already listens on :53 that would block Samba DNS (e.g. resolved stub). */
  port53Conflict(): Promise<{ conflict: boolean; owner?: string }>;
}

export interface NetworkFacts {
  kind: 'netplan' | 'networkmanager' | 'ifupdown' | 'systemd-networkd' | 'wicked' | 'unknown';
  interfaces(): Promise<{ name: string; mac: string; addresses: string[]; up: boolean }[]>;
  defaultRoute(): Promise<{ gateway: string; iface: string } | null>;
}

export interface ContainerFacts {
  available(): Promise<{ runtime: 'podman' | 'docker'; version: string; rootless: boolean }[]>;
}

export interface PreflightResult {
  id: string;
  severity: 'ok' | 'info' | 'warning' | 'error';
  messageKey: string;
  fixKey?: string;
  params?: Record<string, string | number>;
}

// ---------------------------------------------------------------------------
// Actions (agent only)
// ---------------------------------------------------------------------------

export interface OsActions {
  readonly facts: OsFacts;
  readonly packages: PackageActions;
  readonly services: ServiceActions;
  readonly files: FileActions;
  readonly firewall: FirewallActions;
  readonly samba: SambaActions;
  readonly resolver: ResolverActions;
  readonly network: NetworkActions;
  readonly time: TimeActions;
  readonly containers: ContainerActions;
  readonly mac: MacActions;
  readonly system: SystemActions;
}

export interface Progress {
  (evt: { step: string; percent?: number; line?: string }): void;
}

export interface PackageActions {
  refresh(progress?: Progress): Promise<void>;
  listUpgrades(): Promise<{ name: string; from: string; to: string; security: boolean }[]>;
  /** Installs a manifest-declared package set (resolved via PackageNameMap). Never arbitrary names. */
  installSet(setId: string, progress?: Progress): Promise<void>;
  removeSet(setId: string, progress?: Progress): Promise<void>;
  upgradeAll(opts: { securityOnly: boolean }, progress?: Progress): Promise<{ rebootRequired: boolean }>;
  rebootRequired(): Promise<boolean>;
  /** Configure the MyUCS package repository/channel (stable|testing) with its signing key. */
  configurePlatformRepo(channel: 'stable' | 'testing'): Promise<void>;
}

export interface ServiceActions {
  status(unit: string): Promise<{ active: string; sub: string; enabled: boolean; since?: string }>;
  start(unit: string): Promise<void>;
  stop(unit: string): Promise<void>;
  restart(unit: string): Promise<void>;
  reload(unit: string): Promise<void>;
  enable(unit: string, now?: boolean): Promise<void>;
  disable(unit: string, now?: boolean): Promise<void>;
  failedUnits(): Promise<string[]>;
  journal(opts: { unit: string; since?: string; lines: number; priority?: number }): Promise<string[]>;
}

export interface FileActions {
  /** Atomic write (tmp+fsync+rename), keeps previous as .myucs-prev, enforces managedRoots. */
  writeManaged(path: string, content: string, owner: { user: string; group: string }, mode: number): Promise<{ changed: boolean; sha256: string }>;
  readManaged(path: string): Promise<string | null>;
  restorePrevious(path: string): Promise<void>;
  removeManaged(path: string): Promise<void>;
}

export interface FirewallActions {
  /** Applies the full MyUCS ruleset (union of enabled port sets) in a dedicated table/zone; idempotent. */
  apply(rules: { id: string; port: number | [number, number]; proto: 'tcp' | 'udp'; sources?: string[] }[]): Promise<void>;
}

/** Same interface for native and container mode; container mode wraps calls in `podman exec`. */
export interface SambaActions {
  installImage?(imageRef: string, digest: string, progress?: Progress): Promise<void>; // container mode only
  /** Run samba-tool with an argv built by a typed agent op. Not exposed to callers directly. */
  tool(argv: readonly string[], opts?: { stdin?: string; timeoutMs?: number; progress?: Progress }): Promise<{ stdout: string; stderr: string }>;
  ldbSearch(db: 'sam' | 'idmap' | 'secrets', base: string, filter: string, attrs: string[]): Promise<string>;
  unitName(): string; // samba-ad-dc / samba / container unit
}

export interface ResolverActions {
  /** Point the host resolver at the given DNS servers / search domain (and free :53 on DCs). */
  configure(opts: { nameservers: string[]; searchDomains: string[]; freePort53: boolean }): Promise<void>;
}

export interface NetworkActions {
  /** Apply static addressing with automatic rollback if `confirm()` isn't called within timeoutSec. */
  applyWithRollback(cfg: { iface: string; addresses: string[]; gateway?: string; dns: string[] }, timeoutSec: number): Promise<{ confirm(): Promise<void> }>;
  setHostname(fqdn: string): Promise<void>;
}

export interface TimeActions {
  /** Configure chrony servers; on DCs also serve NTP with MS-SNTP signing (ntpsigndsocket). */
  configure(opts: { servers: string[]; serveClients: boolean; ntpSignSocket?: string }): Promise<void>;
  tracking(): Promise<{ offsetSec: number; stratum: number; synced: boolean }>;
}

export interface ContainerActions {
  runtime(): 'podman' | 'docker';
  pull(imageRef: string, digest: string, progress?: Progress): Promise<void>;
  create(spec: ContainerSpec): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string, timeoutSec?: number): Promise<void>;
  remove(name: string, opts: { volumes: boolean }): Promise<void>;
  logs(name: string, opts: { since?: string; lines: number }): Promise<string[]>;
  volumeSnapshot(volume: string, targetPath: string): Promise<void>;
  volumeRestore(volume: string, sourcePath: string): Promise<void>;
  /** Generate a systemd unit (quadlet for podman ≥ 4.4, otherwise a rendered unit) so containers survive reboot. */
  installUnit(name: string): Promise<string>;
}

export interface ContainerSpec {
  name: string;
  image: string; // always "repo@sha256:..." — tags are resolved to digests by the App Center
  env: Record<string, string>;
  secrets: { secretId: string; target: string }[];
  ports: { host: number; container: number; proto: 'tcp' | 'udp'; bind?: string }[];
  volumes: { name: string; target: string; readOnly?: boolean }[];
  network: 'bridge' | 'host';
  capAdd?: string[];
  user?: string;
  rootless: boolean;
}

export interface MacActions {
  /** Install/label policy modules or AppArmor profiles shipped by MyUCS for managed paths. */
  ensurePolicy(policyId: string): Promise<void>;
  relabel(path: string): Promise<void>;
}

export interface SystemActions {
  reboot(opts: { at?: string; reason: string }): Promise<void>;
  info(): Promise<{ hostname: string; fqdn: string; kernel: string; uptimeSec: number; memTotal: number; cpus: number }>;
  diskUsage(paths: string[]): Promise<{ path: string; sizeBytes: number; freeBytes: number }[]>;
}
