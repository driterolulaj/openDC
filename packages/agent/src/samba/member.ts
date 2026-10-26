// SPDX-License-Identifier: AGPL-3.0-only
/**
 * samba.member.join (ROADMAP Phase 3; full node enrolment arrives in Phase 4): makes this host a domain member
 * that runs OpenDC services (e.g. Kea) and follows the directory with its own watch account.
 *
 * Trust: the admin passes the root CA fingerprint (shown on the console's Certificates page). The root is fetched
 * from the DC, pinned only if the fingerprint matches, and the DC's LDAPS chain is verified against it. The admin
 * password only goes to the LDAPS bind and to `net ads join` (environment, never argv) and is never stored.
 */
import { X509Certificate, randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { get } from 'node:https';
import { connect } from 'node:tls';
import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { PlatformError, isPlatformError } from '@opendc/shared';
import type { OpParsedArgs, OpResult } from '@opendc/shared/agent';
import { ServiceLdap, childDn, eq, sidFromBytes } from '@opendc/shared/ldap';
import { pkiIssuer } from '@opendc/shared/pki';
import { writeSystemFile, type OsActions } from '@opendc/os';
import { parseLayer, withHeader } from '@opendc/registry';
import type { NodeStateFile, SecretFiles } from '../state.ts';
import { SambaLocal } from './local.ts';
import { unicodePwd } from './ldif.ts';
import { SERVICE_OU, WATCH_GROUP } from './platform.ts';

const PREFIX = 'opendc:v1:';
const UAC_NORMAL_NO_EXPIRY = 0x200 | 0x10000;

export interface MemberDeps {
  os: OsActions;
  node: NodeStateFile;
  secrets: SecretFiles;
  progress: (step: string, percent: number) => void;
  onRole: (role: 'member') => void;
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isPlatformError(e) && (e.code.startsWith('setup.') || e.code === 'validation.invalid')) throw e;
    const reason = isPlatformError(e) ? e.message : e instanceof Error ? e.message : String(e);
    throw new PlatformError('setup.step-failed', { step: name, reason: reason.slice(-800) }, { cause: e });
  }
}

const normFp = (s: string): string => s.replace(/[^0-9a-f]/gi, '').toUpperCase();

/** The root certificate the DC publishes (https://<dc>:8443/pki/root.pem), not yet trusted. */
function fetchRoot(host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = get({ host, port: 8443, path: '/pki/root.pem', rejectUnauthorized: false, timeout: 10_000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => {
        if (res.statusCode === 200) resolve(body);
        else reject(new Error(`the DC answered ${String(res.statusCode)} for /pki/root.pem (no internal CA yet?)`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

/** The DC's host name from its LDAPS certificate, verified against the pinned root. */
function dcName(host: string, rootPem: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // the chain is verified against the pinned root; the name is what we learn here (checked on the real bind)
    const s = connect(
      {
        host,
        port: 636,
        ca: rootPem,
        rejectUnauthorized: false,
        timeout: 10_000,
        checkServerIdentity: () => undefined,
      },
      () => {
        const cert = s.getPeerCertificate();
        const authorized = s.authorized;
        s.end();
        if (!authorized) {
          reject(
            new Error(`the DC's LDAPS certificate isn't issued under the given root (${String(s.authorizationError)})`),
          );
          return;
        }
        const name = /DNS:([^,\s]+)/.exec(cert.subjectaltname ?? '')?.[1];
        if (!name) reject(new Error("the DC's LDAPS certificate names no host"));
        else resolve(name.toLowerCase());
      },
    );
    s.on('error', reject);
  });
}

export async function joinMember(
  a: OpParsedArgs<'samba.member.join'>,
  d: MemberDeps,
): Promise<OpResult<'samba.member.join'>> {
  const { os, progress } = d;
  if (await d.node.read()) throw new PlatformError('validation.invalid', { issues: 'this host is already set up' });
  const host = a.fqdn.split('.')[0]?.toLowerCase() ?? '';

  // ---- trust: the root the admin vouched for, then the DC's LDAPS chain under it
  progress('trust', 5);
  const rootPem = await step('trust', async () => {
    const pem = await fetchRoot(a.dc);
    const fp = new X509Certificate(pem).fingerprint256;
    if (normFp(fp) !== normFp(a.rootFingerprint))
      throw new PlatformError('validation.invalid', {
        issues: `the DC's root CA has the fingerprint ${fp}, not the one given; check it on the console's Certificates page`,
      });
    return pem;
  });
  const dcFqdn = await step('trust', () => dcName(a.dc, rootPem));
  const domain = dcFqdn.split('.').slice(1).join('.');
  if (!a.fqdn.toLowerCase().endsWith(`.${domain}`))
    throw new PlatformError('validation.invalid', { issues: `the host name must end in .${domain}` });
  const realm = domain.toUpperCase();

  // ---- the directory, as the admin (LDAPS to the DC's address, verified as its name)
  progress('directory', 15);
  const ldap = new ServiceLdap({
    urls: [`ldaps://${a.dc}`],
    caPem: rootPem,
    tlsServerName: dcFqdn,
    credential: { dn: `${a.username}@${domain}`, sam: a.username, password: a.password },
  });
  try {
    const [dse] = await step('directory', () =>
      ldap.search('', { scope: 'base', attributes: ['defaultNamingContext', 'configurationNamingContext'] }),
    );
    const domainDn = String(dse?.defaultNamingContext ?? '');
    const configDn = String(dse?.configurationNamingContext ?? '');
    const [head] = await ldap.search(domainDn, { scope: 'base', attributes: ['objectSid'], buffers: ['objectSid'] });
    const domainSid = Buffer.isBuffer(head?.objectSid) ? sidFromBytes(head.objectSid) : '';
    const [part] = await ldap.search(`CN=Partitions,${configDn}`, {
      scope: 'one',
      filter: eq('nCName', domainDn),
      attributes: ['nETBIOSName'],
    });
    const netbios = String(part?.nETBIOSName ?? realm.split('.')[0]);
    // the DCs (home DC first) and their addresses, as the DC's DNS knows them
    const dcs = (
      await ldap.search(`CN=Sites,${configDn}`, {
        scope: 'sub',
        filter: eq('objectClass', 'server'),
        attributes: ['dNSHostName'],
      })
    )
      .map((e) => String(e.dNSHostName ?? '').toLowerCase())
      .filter(Boolean)
      .sort((x, y) => (x === dcFqdn ? -1 : y === dcFqdn ? 1 : x.localeCompare(y)));
    const r = new Resolver({ timeout: 3000, tries: 2 });
    r.setServers([a.dc]);
    const ips: string[] = [];
    for (const n of dcs) ips.push(...(await r.resolve4(n).catch(() => [])));
    if (!ips.length) ips.push(a.dc);
    const watchGroup = childDn(childDn(domainDn, 'OU', SERVICE_OU), 'CN', WATCH_GROUP);
    if (!(await ldap.search(watchGroup, { scope: 'base', attributes: ['cn'] })).length)
      throw new PlatformError('validation.invalid', {
        issues: 'the domain has no "OpenDC Watchers" group yet; update OpenDC on the DCs first',
      });

    // ---- this host
    progress('hostname', 25);
    await step('hostname', () => os.host.setHostname(a.fqdn, a.hostIp));
    progress('resolver', 30);
    await step('resolver', () =>
      os.host.configureResolver({ nameservers: [...new Set(ips)], searchDomains: [domain], freePort53: false }),
    );
    progress('member-packages', 35);
    await step('member-packages', async () => {
      const missing: string[] = [];
      for (const p of os.facts.packageNames('samba-member')) if (!(await os.packages.installed(p))) missing.push(p);
      await os.packages.install(missing);
    });

    // ---- domain membership (machine account and keytab)
    progress('join', 55);
    const samba = new SambaLocal(os);
    await step('join', async () => {
      await writeSystemFile(
        samba.paths.smbConf,
        [
          '# Managed by OpenDC (member setup).',
          '[global]',
          `\tworkgroup = ${netbios}`,
          `\trealm = ${realm}`,
          '\tsecurity = ADS',
          '\tkerberos method = secrets and keytab',
          '\tdedicated keytab file = /etc/krb5.keytab',
          '',
        ].join('\n'),
        0o644,
      );
      await writeSystemFile(
        '/etc/krb5.conf',
        `[libdefaults]\n\tdefault_realm = ${realm}\n\tdns_lookup_realm = false\n\tdns_lookup_kdc = true\n`,
        0o644,
      );
      const net = await os.facts.binaries.resolve('net');
      // the password through the environment (Samba's credential parser reads PASSWD), never argv
      await os.exec(net, ['ads', 'join', '-U', a.username], { timeoutMs: 300_000, env: { PASSWD: a.password } });
      await os.exec(net, ['ads', 'testjoin'], { timeoutMs: 60_000 });
    });

    // ---- the watch account of this member (in the OpenDC Watchers group: DirSync and tombstones)
    progress('accounts', 75);
    const watch = await step('accounts', async () => {
      const sam = `odcw-${host}`;
      const cn = `opendc-watch-${host}`;
      const password = randomBytes(32).toString('base64');
      const found = await ldap.search(domainDn, {
        scope: 'sub',
        filter: eq('sAMAccountName', sam),
        attributes: ['cn'],
      });
      let dn = found[0]?.dn;
      if (dn) {
        await ldap.modify(dn, [
          { op: 'replace', attr: 'unicodePwd', values: [unicodePwd(password)] },
          { op: 'replace', attr: 'userAccountControl', values: [String(UAC_NORMAL_NO_EXPIRY)] },
        ]);
      } else {
        dn = childDn(childDn(domainDn, 'OU', SERVICE_OU), 'CN', cn);
        await ldap.add(dn, {
          objectClass: ['user'],
          sAMAccountName: [sam],
          displayName: [cn],
          description: [`OpenDC watcher on ${host}`],
          userAccountControl: [String(UAC_NORMAL_NO_EXPIRY)],
          unicodePwd: [unicodePwd(password)],
        });
      }
      const [g] = await ldap.search(watchGroup, { scope: 'base', attributes: ['member'] });
      const members = (Array.isArray(g?.member) ? g.member : g?.member ? [g.member] : []).map((m) =>
        String(m).toLowerCase(),
      );
      if (!members.includes(dn.toLowerCase()))
        await ldap.modify(watchGroup, [{ op: 'add', attr: 'member', values: [dn] }]);
      return { dn, sam, password };
    });

    // ---- trust anchor, CA bundle, secrets, registry, node state
    progress('config', 90);
    await step('config', async () => {
      const issuers = await ldap.search(`CN=Issuers,CN=PKI,CN=OpenDC,CN=System,${domainDn}`, {
        scope: 'one',
        attributes: ['msDS-Settings'],
      });
      const issuerPems = issuers.flatMap((e) => {
        const raw = String(e['msDS-Settings'] ?? '');
        if (!raw.startsWith(PREFIX)) return [];
        const p = pkiIssuer.safeParse((JSON.parse(raw.slice(PREFIX.length)) as { data?: unknown }).data);
        return p.success ? [p.data.certPem.trim()] : [];
      });
      const trust = join(os.facts.paths.etc, 'pki');
      await mkdir(trust, { recursive: true, mode: 0o755 });
      await chmod(trust, 0o755);
      await writeSystemFile(join(trust, 'root.pem'), rootPem, 0o644);
      const bundle = [rootPem.trim(), ...issuerPems].join('\n') + '\n';
      await writeSystemFile(join(trust, 'ca-bundle.pem'), bundle, 0o644);
      await d.secrets.put('ldap-watch', JSON.stringify({ dn: watch.dn, sam: watch.sam, password: watch.password }));
      await d.secrets.put('ldap-ca.pem', bundle);
      const fileId = 'core.registry-local';
      const path = os.facts.paths.managedFile('opendc.registry.local');
      const cur = await os.files.readManaged(path);
      const values = {
        ...parseLayer(fileId, cur?.content ?? null),
        // the home DC first; the watcher fails over to the others
        'core.directory.ldapUrls': dcs.map((n) => `ldaps://${n}`),
        'core.directory.baseDn': domainDn,
        'core.directory.tlsServerName': '',
      };
      const sorted = Object.fromEntries(Object.entries(values).sort(([x], [y]) => x.localeCompare(y)));
      await os.files.writeManaged(
        path,
        withHeader('json-field', 'core', fileId, JSON.stringify({ schemaVersion: 1, values: sorted })),
        null,
        0o644,
      );
      await d.node.write({
        schemaVersion: 1,
        role: 'member',
        domain,
        realm,
        domainDn,
        domainSid,
        fqdn: a.fqdn,
        setupAt: new Date().toISOString(),
      });
      d.onRole('member');
    });
    progress('services', 97);
    await step('services', async () => {
      await os.services.restart('opendc-watcher');
      await os.services.restart('opendc-api');
    });
    progress('done', 100);
    return { domain, dc: dcFqdn, dcs, watchAccount: watch.sam };
  } finally {
    await ldap.close();
  }
}
