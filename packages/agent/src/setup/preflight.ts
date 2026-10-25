// SPDX-License-Identifier: AGPL-3.0-only
/**
 * setup.preflight: everything that would make provisioning or a join fail (or leave a broken DC), checked
 * before anything is changed. Read-only. Each check reports pass/warn/fail with parameters; the texts live in
 * the "setup" i18n namespace (packages/shared/src/domain/i18n.ts).
 */
import { createSocket } from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { connect } from 'node:net';
import { totalmem } from 'node:os';
import { access } from 'node:fs/promises';
import {
  dnsDomainIssue,
  hostLabelIssue,
  netbiosIssue,
  type PreflightCheck,
  type PreflightCheckId,
  type PreflightResult,
  type preflightArgs,
} from '@opendc/shared/domain';
import { MIN_DC_SAMBA, type OsActions } from '@opendc/os';
import type { z } from 'zod';

type Args = z.output<typeof preflightArgs>;
type Status = PreflightCheck['status'];

/** Ports a Samba AD DC listens on. 53 is reported separately (stub resolvers). */
export const DC_PORTS: { proto: 'tcp' | 'udp'; port: number }[] = [
  { proto: 'tcp', port: 88 },
  { proto: 'udp', port: 88 },
  { proto: 'tcp', port: 135 },
  { proto: 'tcp', port: 139 },
  { proto: 'tcp', port: 389 },
  { proto: 'udp', port: 389 },
  { proto: 'tcp', port: 445 },
  { proto: 'tcp', port: 464 },
  { proto: 'udp', port: 464 },
  { proto: 'tcp', port: 636 },
  { proto: 'tcp', port: 3268 },
  { proto: 'tcp', port: 3269 },
];
const SAMBA_PROCESSES = new Set(['samba', 'smbd', 'nmbd', 'winbindd', 'rpcd_classic', 'rpcd_lsad']);
const XATTR_FS = new Set(['ext4', 'xfs', 'btrfs', 'zfs']);
const GiB = 1024 ** 3;

function versionAtLeast(v: string, min: { major: number; minor: number }): boolean {
  // "2:4.22.11+dfsg-0+deb13u1" -> 4.22
  const m = /(?:^|:)(\d+)\.(\d+)/.exec(v);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > min.major || (major === min.major && minor >= min.minor);
}

function tcpReachable(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port, timeout: timeoutMs });
    const done = (ok: boolean): void => {
      s.destroy();
      resolve(ok);
    };
    s.once('connect', () => {
      done(true);
    });
    s.once('timeout', () => {
      done(false);
    });
    s.once('error', () => {
      done(false);
    });
  });
}

/** Offset of the local clock against an SNTP server, in seconds (positive = local clock ahead). */
export function sntpOffset(host: string, timeoutMs = 3000): Promise<number | null> {
  return new Promise((resolve) => {
    const sock = createSocket('udp4');
    const req = Buffer.alloc(48);
    req[0] = 0x1b; // LI 0, version 3, mode 3 (client)
    const t1 = Date.now();
    const timer = setTimeout(() => {
      sock.close();
      resolve(null);
    }, timeoutMs);
    sock.once('message', (msg) => {
      const t4 = Date.now();
      clearTimeout(timer);
      sock.close();
      if (msg.length < 48) {
        resolve(null);
        return;
      }
      const secs = msg.readUInt32BE(40) - 2_208_988_800;
      const frac = msg.readUInt32BE(44) / 2 ** 32;
      const server = (secs + frac) * 1000;
      resolve((t1 + t4) / 2 / 1000 - server / 1000);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      sock.close();
      resolve(null);
    });
    sock.send(req, 123, host);
  });
}

/** Samba AD DC processes, which ss reports by task name: "samba", "dns[master]", "kdc(2)", "ldap[master]", ... */
export function isSambaProcess(name: string | null): boolean {
  const base = (name ?? '').replace(/[[(].*$/, '');
  return (
    SAMBA_PROCESSES.has(base) ||
    /^(dns|kdc|ldap|cldap|kpasswd|rpc|dcesrv|nbt|drepl|wrepl|ntp_signd|s3fs|winbindd|smbd|nmbd)/.test(base)
  );
}

/**
 * `resume`: an earlier setup of this host stopped half-way (domain database present, setup token still
 * there). Then an existing database and Samba's own listening ports are expected and only reported.
 */
export async function preflight(a: Args, os: OsActions, samDb: string, resume = false): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const add = (id: PreflightCheckId, status: Status, params: Record<string, string | number> = {}): void => {
    checks.push({ id, status, params });
  };
  const role = a.role === 'primary-dc' ? 'primary-dc' : 'dc';

  // OS and Samba
  const support = await os.facts.support(role);
  add('os-support', support.tier === 'unsupported' && support.sambaMode !== 'native' ? 'fail' : 'pass', {
    os: os.facts.release.prettyName,
  });
  const samba = os.facts.packageNames('samba-dc')[0] ?? 'samba';
  const installed = await os.packages.installed(samba).catch(() => null);
  const candidate = installed ?? (await os.packages.candidate(samba).catch(() => null));
  const min = `${String(MIN_DC_SAMBA.major)}.${String(MIN_DC_SAMBA.minor)}`;
  if (!candidate) add('samba-version', 'fail', { version: '-', min });
  else add('samba-version', versionAtLeast(candidate, MIN_DC_SAMBA) ? 'pass' : 'fail', { version: candidate, min });
  const provisioned = await access(samDb).then(
    () => true,
    () => false,
  );
  add('not-provisioned', !provisioned ? 'pass' : resume ? 'warn' : 'fail', { path: samDb });

  // names
  const [host = '', ...rest] = a.fqdn.toLowerCase().split('.');
  const fqdnDomain = rest.join('.');
  const hostIssue = hostLabelIssue(host);
  add('hostname', hostIssue ? 'fail' : 'pass', { host, issue: hostIssue ?? '' });
  const domain = a.domain.toLowerCase().replace(/\.$/, '');
  const domainIssue = dnsDomainIssue(domain);
  add('fqdn-domain', domainIssue === 'mdns-local' ? 'warn' : domainIssue || fqdnDomain !== domain ? 'fail' : 'pass', {
    fqdn: a.fqdn,
    domain,
    issue: domainIssue ?? '',
  });
  if (a.role === 'primary-dc') {
    const nb = a.netbiosDomain ?? '';
    const nbIssue = netbiosIssue(nb, host);
    add('netbios', nbIssue ? 'fail' : 'pass', { netbios: nb, issue: nbIssue ?? '' });
  }

  // network
  const addrs = await os.host.addresses().catch(() => []);
  const mine = addrs.find((x) => x.address === a.hostIp);
  add('ip-assigned', mine ? 'pass' : 'fail', { ip: a.hostIp, found: addrs.map((x) => x.address).join(', ') });
  if (mine) add('ip-static', mine.dynamic ? 'warn' : 'pass', { ip: a.hostIp, iface: mine.iface });
  const listening = await os.host.listening().catch(() => []);
  const on53 = listening.filter((l) => l.port === 53 && !isSambaProcess(l.process));
  const stubOnly = on53.length > 0 && on53.every((l) => (l.process ?? '').startsWith('systemd-resolve'));
  add('port-53', on53.length === 0 ? 'pass' : stubOnly ? 'warn' : 'fail', {
    processes: [...new Set(on53.map((l) => l.process ?? '?'))].join(', '),
  });
  const busy = listening.filter(
    (l) => DC_PORTS.some((p) => p.proto === l.proto && p.port === l.port) && !isSambaProcess(l.process),
  );
  add('ports', busy.length ? 'fail' : 'pass', {
    ports: busy.map((l) => `${l.proto}/${String(l.port)} (${l.process ?? '?'})`).join(', '),
  });

  // resources
  const samba_ = os.facts.samba.paths();
  const fs = await os.host.filesystem(samba_.stateDir).catch(() => null);
  const freeGiB = fs ? Math.floor((fs.freeBytes / GiB) * 10) / 10 : 0;
  add('disk', !fs || freeGiB < 2 ? 'fail' : freeGiB < 5 ? 'warn' : 'pass', { free: freeGiB, path: samba_.stateDir });
  add('filesystem', fs && XATTR_FS.has(fs.type) ? 'pass' : 'warn', { type: fs?.type ?? '?', path: samba_.stateDir });
  const memGiB = Math.round((totalmem() / GiB) * 10) / 10;
  add('memory', memGiB < 1.5 ? 'fail' : memGiB < 2 ? 'warn' : 'pass', { memory: memGiB });
  const mac = await os.facts.macKind();
  add('mac', mac === 'selinux' ? 'warn' : 'pass', { kind: mac });

  // time
  const t = await os.host.timeSync();
  add('time', !t.synchronized ? 'warn' : Math.abs(t.offsetSec ?? 0) > 1 ? 'warn' : 'pass', {
    offset: t.offsetSec === null ? '-' : Math.round(t.offsetSec * 1000) / 1000,
    reference: t.reference ?? '-',
  });

  // upstream DNS for the new domain
  if (a.role === 'primary-dc') {
    if (!a.dnsForwarders.length) add('dns-forwarder', 'warn', { servers: '-' });
    else {
      const r = new Resolver({ timeout: 3000, tries: 1 });
      r.setServers(a.dnsForwarders);
      const ok = await r.resolve4('example.com').then(
        (x) => x.length > 0,
        () => false,
      );
      add('dns-forwarder', ok ? 'pass' : 'warn', { servers: a.dnsForwarders.join(', ') });
    }
  }

  // the existing DC (join)
  if (a.role === 'dc') {
    const dc = a.dcHost ?? '';
    const reach = await Promise.all([tcpReachable(dc, 389), tcpReachable(dc, 88), tcpReachable(dc, 445)]);
    add('dc-reachable', reach.every(Boolean) ? 'pass' : 'fail', {
      dc,
      ports: ['389', '88', '445'].filter((_, i) => !reach[i]).join(', '),
    });
    const r = new Resolver({ timeout: 3000, tries: 1 });
    const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(dc);
    if (isIp) r.setServers([dc]);
    const srv = await r.resolveSrv(`_ldap._tcp.${domain}`).then(
      (x) => x.length,
      () => 0,
    );
    add('dc-dns', srv > 0 ? 'pass' : 'fail', { dc, domain });
    const offset = await sntpOffset(dc);
    add(
      'dc-time',
      offset === null ? 'warn' : Math.abs(offset) > 240 ? 'fail' : Math.abs(offset) > 30 ? 'warn' : 'pass',
      { dc, offset: offset === null ? '-' : Math.round(offset * 10) / 10 },
    );
  }

  return { checks, ok: !checks.some((c) => c.status === 'fail') };
}
