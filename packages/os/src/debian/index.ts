// SPDX-License-Identifier: AGPL-3.0-only
/** Debian family adapter: Debian 12/13, Ubuntu 24.04/26.04 (Tier 1). */
import { access, readFile, readlink, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { cpus, hostname, release as kernelRelease, totalmem, uptime } from 'node:os';
import { join } from 'node:path';
import { PlatformError } from '@opendc/shared';
import type { NodeRole } from '@opendc/shared/manifest';
import { exec as defaultExec, type Exec } from '../exec.ts';
import { PosixFileActions } from '../posix/files.ts';
import { SystemdServiceActions, runTransient } from '../posix/systemd.ts';
import { PosixHostActions } from '../posix/host.ts';
import type {
  BinaryLocator,
  LogicalBinary,
  OsActions,
  PackageActions,
  OsFacts,
  OsRelease,
  PlatformPaths,
  SambaFacts,
  SambaVersion,
  SupportReason,
  SupportVerdict,
  SystemActions,
  SystemInfo,
} from '../types.ts';

/**
 * Minimum Samba for the DC role (OPEN-QUESTIONS Q10): the oldest Samba shipped in a security-supported
 * Tier-1 distro release. Debian 12's stock 4.17 is older, so DCs on Debian 12 need bookworm-backports.
 */
export const MIN_DC_SAMBA = { major: 4, minor: 19 } as const;

/** Tier-1 releases of this family: id -> versionIds. */
const TIER1: Record<string, string[]> = { debian: ['12', '13'], ubuntu: ['24.04', '26.04'] };

const BIN_DIRS = ['/usr/sbin', '/usr/bin', '/sbin', '/bin'];
const BIN_PACKAGES: Record<LogicalBinary, string> = {
  samba: 'samba-ad-dc',
  'samba-tool': 'samba-ad-dc',
  smbcontrol: 'samba-common-bin',
  testparm: 'samba-common-bin',
  net: 'samba-common-bin',
  wbinfo: 'winbind',
  kinit: 'krb5-user',
  klist: 'krb5-user',
  openssl: 'openssl',
  chronyc: 'chrony',
  systemctl: 'systemd',
  journalctl: 'systemd',
  hostname: 'hostname',
  ip: 'iproute2',
  ss: 'iproute2',
  ldbadd: 'ldb-tools',
  ldbmodify: 'ldb-tools',
  ldbsearch: 'ldb-tools',
  hostnamectl: 'systemd',
  'apt-get': 'apt',
  'apt-cache': 'apt',
  'systemd-run': 'systemd',
};

const PACKAGES: Record<string, string[]> = {
  'samba-dc': [
    'samba',
    'samba-ad-dc',
    'samba-ad-provision',
    'winbind',
    'krb5-user',
    'libnss-winbind',
    'libpam-winbind',
    'ldb-tools',
    'smbclient',
    'dnsutils',
    'acl',
    'attr',
  ],
  chrony: ['chrony'],
};

const UNITS: Record<string, string> = {
  'samba-ad-dc': 'samba-ad-dc.service',
  chrony: 'chrony.service',
  smbd: 'smbd.service',
  nmbd: 'nmbd.service',
  winbind: 'winbind.service',
  'systemd-resolved': 'systemd-resolved.service',
};

/** chrony on Debian/Ubuntu reads drop-ins from /etc/chrony/conf.d and runs as _chrony. */
const CHRONY = { dropIn: '/etc/chrony/conf.d/opendc.conf', group: '_chrony', unit: 'chrony' };

export interface DebianOptions {
  release: OsRelease;
  exec?: Exec;
  /** Filesystem root for the platform paths (tests point this at a temp dir). */
  root?: string;
  /** Executable check used to locate binaries (tests stub it). */
  isExecutable?: (path: string) => Promise<boolean>;
}

const defaultIsExecutable = (path: string): Promise<boolean> =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  );

export function parseSambaVersion(text: string): SambaVersion | null {
  const m = /Version\s+(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw: text.trim() };
}

function atLeast(v: SambaVersion, min: { major: number; minor: number }): boolean {
  return v.major > min.major || (v.major === min.major && v.minor >= min.minor);
}

export class DebianFacts implements OsFacts {
  readonly adapter = 'debian' as const;
  readonly release: OsRelease;
  readonly paths: PlatformPaths;
  readonly binaries: BinaryLocator;
  readonly samba: SambaFacts;
  readonly #exec: Exec;

  constructor(opts: DebianOptions) {
    this.release = opts.release;
    this.#exec = opts.exec ?? defaultExec;
    const root = opts.root ?? '/';
    const p = (...parts: string[]): string => join(root, ...parts);
    const managed: Record<string, string> = {
      'opendc.demo': p('etc/opendc/generated/demo.conf'),
      'opendc.registry.local': p('etc/opendc/registry/local.json'),
      'opendc.registry.forced': p('etc/opendc/registry/forced.json'),
      'opendc.registry.rendered': p('var/lib/opendc/registry/rendered.json'),
    };
    const managedRoots = [p('etc/opendc/generated'), p('etc/opendc/registry'), p('var/lib/opendc/registry')];
    const os = this.release.prettyName;
    this.paths = {
      etc: p('etc/opendc'),
      secrets: p('etc/opendc/secrets'),
      lib: p('usr/lib/opendc'),
      state: p('var/lib/opendc'),
      run: p('run/opendc'),
      watcherStatus: p('run/opendc-watcher/status.json'),
      auditInbox: p('var/lib/opendc/audit-inbox'),
      managedFile(pathKey: string): string {
        const path = managed[pathKey];
        if (!path) throw new PlatformError('os.unknown-path-key', { pathKey, os });
        return path;
      },
      managedRoots: () => managedRoots,
    };
    const isExecutable = opts.isExecutable ?? defaultIsExecutable;
    this.binaries = {
      async resolve(name: LogicalBinary): Promise<string> {
        for (const dir of BIN_DIRS) {
          // posix join: binary paths are Linux paths even when tests run on Windows
          const candidate = `${dir}/${name}`;
          if (await isExecutable(candidate)) return candidate;
        }
        throw new PlatformError('os.binary-missing', { binary: name, package: BIN_PACKAGES[name] });
      },
    };
    const binaries = this.binaries;
    const run = this.#exec;
    this.samba = {
      async mode() {
        try {
          await binaries.resolve('samba');
          return 'native';
        } catch {
          return 'absent';
        }
      },
      async version() {
        let bin: string;
        try {
          bin = await binaries.resolve('samba');
        } catch {
          return null;
        }
        const r = await run(bin, ['--version'], { timeoutMs: 10_000 });
        return parseSambaVersion(r.stdout);
      },
      paths: () => ({
        smbConf: '/etc/samba/smb.conf',
        privateDir: '/var/lib/samba/private',
        sysvol: '/var/lib/samba/sysvol',
        stateDir: '/var/lib/samba',
        tlsDir: '/var/lib/samba/private/tls',
      }),
    };
  }

  unitName(unit: string): string {
    return UNITS[unit] ?? (unit.includes('.') ? unit : `${unit}.service`);
  }

  packageNames(logical: string): string[] {
    return PACKAGES[logical] ?? [logical];
  }

  async macKind(): Promise<'selinux' | 'apparmor' | 'none'> {
    try {
      await access('/sys/kernel/security/apparmor');
      return 'apparmor';
    } catch {
      return 'none';
    }
  }

  async resolverKind(): Promise<'systemd-resolved' | 'resolv.conf' | 'networkmanager'> {
    try {
      const target = await readlink('/etc/resolv.conf');
      if (target.includes('systemd/resolve')) return 'systemd-resolved';
      if (target.includes('NetworkManager')) return 'networkmanager';
    } catch {
      // a regular file
    }
    return 'resolv.conf';
  }

  async networkKind(): Promise<'netplan' | 'networkmanager' | 'ifupdown' | 'systemd-networkd' | 'unknown'> {
    const yaml = await readdir('/etc/netplan').catch(() => [] as string[]);
    if (yaml.some((f) => f.endsWith('.yaml'))) return 'netplan';
    const ifaces = await readFile('/etc/network/interfaces', 'utf8').catch(() => '');
    if (/^\s*iface\s+(?!lo\b)/m.test(ifaces)) return 'ifupdown';
    const networkd = await readdir('/etc/systemd/network').catch(() => [] as string[]);
    if (networkd.length > 0) return 'systemd-networkd';
    return 'unknown';
  }

  async support(role: NodeRole): Promise<SupportVerdict> {
    const reasons: SupportReason[] = [];
    const tier1 = TIER1[this.release.id]?.includes(this.release.versionId) ?? false;
    if (!tier1) {
      reasons.push({
        code: 'release-not-tier1',
        messageKey: 'os:support.release-not-tier1',
        fixKey: 'os:support.release-not-tier1-fix',
        params: { os: this.release.prettyName },
      });
      return { tier: 'unsupported', sambaMode: 'n/a', reasons };
    }
    const dcRole = role === 'primary-dc' || role === 'dc' || role === 'rodc';
    if (!dcRole) return { tier: 1, sambaMode: 'n/a', reasons };
    const v = await this.samba.version();
    const min = `${String(MIN_DC_SAMBA.major)}.${String(MIN_DC_SAMBA.minor)}`;
    if (v === null) {
      reasons.push({ code: 'samba-not-installed', messageKey: 'os:support.samba-not-installed', params: { min } });
      return { tier: 1, sambaMode: 'native', reasons };
    }
    if (!atLeast(v, MIN_DC_SAMBA)) {
      reasons.push({
        code: 'samba-too-old',
        messageKey: 'os:support.samba-too-old',
        fixKey:
          this.release.id === 'debian' && this.release.versionId === '12'
            ? 'os:support.enable-bookworm-backports'
            : 'os:support.upgrade-samba',
        params: { version: `${String(v.major)}.${String(v.minor)}.${String(v.patch)}`, min },
      });
      return { tier: 'unsupported', sambaMode: 'native', reasons };
    }
    return { tier: 1, sambaMode: 'native', reasons };
  }
}

class DebianSystem implements SystemActions {
  readonly #facts: DebianFacts;
  readonly #exec: Exec;
  constructor(facts: DebianFacts, exec: Exec) {
    this.#facts = facts;
    this.#exec = exec;
  }
  async info(): Promise<SystemInfo> {
    const short = hostname();
    let fqdn = short;
    try {
      fqdn =
        (
          await this.#exec(await this.#facts.binaries.resolve('hostname'), ['--fqdn'], { timeoutMs: 5000 })
        ).stdout.trim() || short;
    } catch {
      // keep the short name
    }
    return {
      hostname: short,
      fqdn,
      kernel: kernelRelease(),
      uptimeSec: Math.round(uptime()),
      memTotal: totalmem(),
      cpus: cpus().length,
    };
  }
}

/** Parses `apt-cache policy <pkg>` -> { installed, candidate } ("(none)" -> null). */
export function parseAptPolicy(text: string): { installed: string | null; candidate: string | null } {
  const field = (re: RegExp): string | null => {
    const v = re.exec(text)?.[1];
    return v && v !== '(none)' ? v : null;
  };
  return { installed: field(/^\s*Installed:\s*(\S+)/m), candidate: field(/^\s*Candidate:\s*(\S+)/m) };
}

const APT_ENV = { DEBIAN_FRONTEND: 'noninteractive', DEBCONF_NONINTERACTIVE_SEEN: 'true' };

class AptPackages implements PackageActions {
  readonly #facts: DebianFacts;
  readonly #exec: Exec;
  constructor(facts: DebianFacts, exec: Exec) {
    this.#facts = facts;
    this.#exec = exec;
  }

  async install(names: readonly string[]): Promise<void> {
    if (!names.length) return;
    const apt = await this.#facts.binaries.resolve('apt-get');
    const opts = ['-o', 'DPkg::Lock::Timeout=600', '-o', 'Dpkg::Options::=--force-confold'];
    // dpkg must create setuid files and restart services, which the agent's own sandbox forbids
    // (RestrictSUIDSGID=yes etc.), so apt runs as a transient unit outside it.
    await runTransient(this.#exec, await this.#facts.binaries.resolve('systemd-run'), [apt, ...opts, '-qq', 'update'], {
      env: APT_ENV,
      timeoutMs: 600_000,
    });
    await runTransient(
      this.#exec,
      await this.#facts.binaries.resolve('systemd-run'),
      [apt, ...opts, '-qq', 'install', '-y', '--', ...names],
      { env: APT_ENV, timeoutMs: 1_800_000 },
    );
  }

  async #policy(name: string): Promise<{ installed: string | null; candidate: string | null }> {
    const r = await this.#exec(await this.#facts.binaries.resolve('apt-cache'), ['policy', '--', name], {
      timeoutMs: 60_000,
    });
    return parseAptPolicy(r.stdout);
  }

  async installed(name: string): Promise<string | null> {
    return (await this.#policy(name)).installed;
  }

  async candidate(name: string): Promise<string | null> {
    return (await this.#policy(name)).candidate;
  }
}

export function debianActions(opts: DebianOptions): OsActions {
  const facts = new DebianFacts(opts);
  const run = opts.exec ?? defaultExec;
  const services = new SystemdServiceActions(
    run,
    () => facts.binaries.resolve('systemctl'),
    (u) => facts.unitName(u),
  );
  return {
    facts,
    services,
    files: new PosixFileActions(facts.paths.managedRoots()),
    system: new DebianSystem(facts, run),
    host: new PosixHostActions({
      exec: run,
      binaries: facts.binaries,
      services,
      resolverKind: () => facts.resolverKind(),
      chrony: CHRONY,
      ...(opts.root ? { root: opts.root } : {}),
    }),
    packages: new AptPackages(facts, run),
    exec: run,
  };
}
