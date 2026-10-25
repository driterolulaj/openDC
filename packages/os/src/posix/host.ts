// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Host configuration and facts shared by the Linux adapters (setup and pre-flight). Every file written here
 * is a fixed system path chosen by the adapter; callers only supply validated values. Writes are atomic and
 * keep the previous version next to the file (`<path>.opendc-prev`).
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  statfs,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { PlatformError } from '@opendc/shared';
import type { Exec } from '../exec.ts';
import { PREV_SUFFIX } from './files.ts';
import type {
  BinaryLocator,
  HostActions,
  InterfaceAddress,
  ListeningSocket,
  ServiceActions,
  TimeSync,
} from '../types.ts';

export const SYSTEM_FILE_HEADER = 'Managed by OpenDC (setup). Local changes may be overwritten.';

/** Atomically replaces a fixed system file, keeping the previous content as `<path>.opendc-prev`. */
export async function writeSystemFile(
  path: string,
  content: string,
  mode: number,
  opts: { replaceSymlink?: boolean } = {},
): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const st = await lstat(path).catch(() => null);
  if (st?.isSymbolicLink()) {
    if (!opts.replaceSymlink) throw new PlatformError('os.path-outside-roots', { path, roots: '(symlink)' });
    await unlink(path);
  } else if (st?.isFile()) {
    const cur = await readFile(path, 'utf8');
    if (cur === content) return false;
    await copyFile(path, path + PREV_SUFFIX);
  }
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await fh.writeFile(content, 'utf8');
    await fh.chmod(mode);
    await fh.sync();
  } catch (e) {
    await fh.close();
    await rm(tmp, { force: true });
    throw e;
  }
  await fh.close();
  await rename(tmp, path);
  return true;
}

/** Rewrites /etc/hosts: drops lines naming the host, then maps `ip` to the FQDN and the short name. */
export function rewriteHosts(current: string, fqdn: string, ip: string): string {
  const short = fqdn.split('.')[0] ?? fqdn;
  const names = new Set([short.toLowerCase(), fqdn.toLowerCase()]);
  const kept = current
    .split('\n')
    .filter((line) => {
      const body = line.split('#')[0]?.trim() ?? '';
      if (!body) return true;
      const [, ...hostnames] = body.split(/\s+/);
      return !hostnames.some((h) => names.has(h.toLowerCase()));
    })
    .join('\n')
    .replace(/\n+$/, '');
  return `${kept}\n${ip}\t${fqdn}\t${short}\n`;
}

export function parseIpAddr(json: string): InterfaceAddress[] {
  const data = JSON.parse(json) as {
    ifname?: string;
    addr_info?: { family?: string; local?: string; prefixlen?: number; dynamic?: boolean; scope?: string }[];
  }[];
  const out: InterfaceAddress[] = [];
  for (const link of data) {
    for (const a of link.addr_info ?? []) {
      if ((a.family !== 'inet' && a.family !== 'inet6') || !a.local || a.scope === 'host') continue;
      out.push({
        iface: link.ifname ?? '?',
        family: a.family,
        address: a.local,
        prefix: a.prefixlen ?? 0,
        dynamic: a.dynamic === true,
      });
    }
  }
  return out;
}

/** Parses `ss -Hlntup` (Netid State Recv-Q Send-Q Local Peer [Process]). */
export function parseSs(text: string): ListeningSocket[] {
  const out: ListeningSocket[] = [];
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const proto = cols[0];
    if (proto !== 'tcp' && proto !== 'udp') continue;
    const local = cols[4] ?? '';
    const colon = local.lastIndexOf(':');
    const port = Number(local.slice(colon + 1));
    if (colon < 0 || !Number.isInteger(port)) continue;
    const address = local
      .slice(0, colon)
      .replace(/^\[|\]$/g, '')
      .replace(/%.*$/, '');
    const proc = /users:\(\("([^"]+)"/.exec(cols.slice(6).join(' '))?.[1] ?? null;
    out.push({ proto, address, port, process: proc });
  }
  return out;
}

/** Parses `chronyc -c tracking` (CSV; field 5 is the system time offset, the last field the leap status). */
export function parseChronyTracking(csv: string): TimeSync {
  const f = csv.trim().split(',');
  if (f.length < 14) return { synchronized: false, offsetSec: null, reference: null };
  const stratum = Number(f[2]);
  const leap = f[f.length - 1] ?? '';
  const offset = Number(f[4]);
  return {
    synchronized: stratum > 0 && stratum < 16 && !/not synchroni[sz]ed/i.test(leap),
    offsetSec: Number.isFinite(offset) ? offset : null,
    reference: f[1] || null,
  };
}

/** gid of a group from /etc/group (Node has no getgrnam). */
export async function groupId(groupFile: string, name: string): Promise<number | null> {
  const text = await readFile(groupFile, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    const [n, , gid] = line.split(':');
    if (n === name && gid !== undefined && /^\d+$/.test(gid)) return Number(gid);
  }
  return null;
}

const FS_TYPES: Record<number, string> = {
  0xef53: 'ext4',
  0x58465342: 'xfs',
  0x9123683e: 'btrfs',
  0x2fc12fc1: 'zfs',
  0x01021994: 'tmpfs',
  0x794c7630: 'overlay',
  0x6969: 'nfs',
  0xff534d42: 'cifs',
};

export interface PosixHostOptions {
  exec: Exec;
  binaries: BinaryLocator;
  services: ServiceActions;
  resolverKind: () => Promise<'systemd-resolved' | 'resolv.conf' | 'networkmanager'>;
  /** chrony drop-in file and the group chronyd runs as (it needs to read Samba's ntp_signd socket). */
  chrony: { dropIn: string; group: string; unit: string };
  /** Filesystem root for tests. */
  root?: string;
}

export class PosixHostActions implements HostActions {
  readonly #o: PosixHostOptions;
  readonly #root: string;

  constructor(o: PosixHostOptions) {
    this.#o = o;
    this.#root = o.root ?? '/';
  }

  #p(path: string): string {
    return this.#root === '/' ? path : join(this.#root, path);
  }

  async setHostname(fqdn: string, ip: string): Promise<{ changed: boolean }> {
    const short = fqdn.split('.')[0] ?? fqdn;
    // cloud-init would otherwise rewrite hosts, resolver and hostname on the next boot
    let changed = false;
    const cloud = this.#p('/etc/cloud/cloud.cfg.d');
    if (
      await access(dirname(cloud)).then(
        () => true,
        () => false,
      )
    ) {
      changed =
        (await writeSystemFile(
          join(cloud, '99-opendc.cfg'),
          `# ${SYSTEM_FILE_HEADER}\nmanage_etc_hosts: false\nmanage_resolv_conf: false\npreserve_hostname: true\n`,
          0o644,
        )) || changed;
    }
    const hostsPath = this.#p('/etc/hosts');
    const hosts = await readFile(hostsPath, 'utf8').catch(() => '127.0.0.1\tlocalhost\n');
    changed = (await writeSystemFile(hostsPath, rewriteHosts(hosts, fqdn, ip), 0o644)) || changed;
    const current = (await readFile(this.#p('/etc/hostname'), 'utf8').catch(() => '')).trim();
    if (current !== short) {
      await this.#o.exec(await this.#o.binaries.resolve('hostnamectl'), ['set-hostname', '--', short], {
        timeoutMs: 30_000,
      });
      changed = true;
    }
    return { changed };
  }

  async configureResolver(o: { nameservers: string[]; searchDomains: string[]; freePort53: boolean }): Promise<void> {
    if (o.freePort53 && (await this.#o.resolverKind()) === 'systemd-resolved') {
      await this.#o.services.disable('systemd-resolved', true);
    }
    const lines = [`# ${SYSTEM_FILE_HEADER}`];
    if (o.searchDomains.length) lines.push(`search ${o.searchDomains.join(' ')}`);
    for (const ns of o.nameservers) lines.push(`nameserver ${ns}`);
    await writeSystemFile(this.#p('/etc/resolv.conf'), lines.join('\n') + '\n', 0o644, { replaceSymlink: true });
  }

  async addresses(): Promise<InterfaceAddress[]> {
    const r = await this.#o.exec(await this.#o.binaries.resolve('ip'), ['-j', 'addr', 'show'], { timeoutMs: 10_000 });
    return parseIpAddr(r.stdout);
  }

  async listening(): Promise<ListeningSocket[]> {
    const r = await this.#o.exec(await this.#o.binaries.resolve('ss'), ['-Hlntup'], { timeoutMs: 10_000 });
    return parseSs(r.stdout);
  }

  async filesystem(path: string): Promise<{ type: string; freeBytes: number }> {
    // the nearest existing ancestor: /var/lib/samba may not exist before the packages are installed
    let p = path;
    for (;;) {
      try {
        const s = await statfs(p);
        return { type: FS_TYPES[s.type] ?? `0x${s.type.toString(16)}`, freeBytes: s.bavail * s.bsize };
      } catch {
        const parent = dirname(p);
        if (parent === p) throw new PlatformError('os.path-outside-roots', { path, roots: '/' });
        p = parent;
      }
    }
  }

  async timeSync(): Promise<TimeSync> {
    try {
      const r = await this.#o.exec(await this.#o.binaries.resolve('chronyc'), ['-c', 'tracking'], {
        timeoutMs: 10_000,
      });
      return parseChronyTracking(r.stdout);
    } catch {
      return { synchronized: false, offsetSec: null, reference: null };
    }
  }

  async configureTimeServer(o: { signdSocketDir: string; allow: string[]; upstream: string[] }): Promise<void> {
    // chronyd must be able to reach Samba's signing socket
    const signd = this.#p(o.signdSocketDir);
    await mkdir(signd, { recursive: true, mode: 0o750 });
    const gid = await groupId(this.#p('/etc/group'), this.#o.chrony.group);
    if (gid !== null && process.getuid?.() === 0) await chown(signd, 0, gid);
    await chmod(signd, 0o750);
    const lines = [
      `# ${SYSTEM_FILE_HEADER}`,
      '# Domain controller: serve time to domain members and sign replies (MS-SNTP) through Samba.',
      `ntpsigndsocket ${o.signdSocketDir}`,
      ...o.upstream.map((s) => `pool ${s} iburst`),
      ...o.allow.map((a) => `allow ${a}`),
    ];
    const changed = await writeSystemFile(this.#p(this.#o.chrony.dropIn), lines.join('\n') + '\n', 0o644);
    if (changed) await this.#o.services.restart(this.#o.chrony.unit);
  }
}
