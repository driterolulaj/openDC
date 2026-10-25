// SPDX-License-Identifier: AGPL-3.0-only
/**
 * samba.provision / samba.join (agent-operations.md §3.3): turns this host into the first DC of a new domain,
 * or into an additional writable DC. Each run goes through the same steps and skips what is already done,
 * so a failed setup can simply be run again:
 *
 *   hostname -> resolver -> packages -> Samba units -> provision|join -> Administrator password (provision)
 *   -> krb5.conf -> start samba-ad-dc -> resolver to self -> DNS SRV check -> time server (ntpsigned)
 *   -> platform objects and service accounts -> secrets -> registry + node.json -> destroy setup token
 */
import { Resolver } from 'node:dns/promises';
import { copyFile, readFile, rename, stat } from 'node:fs/promises';
import { PlatformError, isPlatformError } from '@opendc/shared';
import type { ProvisionResult, joinArgs, provisionArgs } from '@opendc/shared/domain';
import { dnFromDomain } from '@opendc/shared/ldap';
import type { z } from 'zod';
import { writeSystemFile, type OsActions } from '@opendc/os';
import { parseLayer, withHeader } from '@opendc/registry';
import { modifyRecord, unicodePwd, first } from './ldif.ts';
import { SambaLocal } from './local.ts';
import { PlatformBootstrap } from './platform.ts';
import { withDnsForwarder } from './smbconf.ts';
import { runSdPropIfPdc } from './sdprop.ts';
import type { NodeStateFile, SecretFiles } from '../state.ts';
import { servicePassword } from '../state.ts';
import type { SetupToken } from '../setup/token.ts';

type Provision = z.output<typeof provisionArgs>;
type Join = z.output<typeof joinArgs>;

export interface SetupDeps {
  os: OsActions;
  node: NodeStateFile;
  secrets: SecretFiles;
  token: SetupToken;
  progress: (step: string, percent: number) => void;
  /** Called once the node has its new role, so the agent applies role-based rules right away. */
  onRole: (role: 'primary-dc' | 'dc') => void;
  /** Refreshes node secrets that depend on the new identity (console certificate, LDAPS CA). */
  afterSetup: () => Promise<void>;
}

/** Distro Samba units that must not run on an AD DC (samba-ad-dc starts its own smbd/winbindd). */
const FILE_SERVER_UNITS = ['smbd', 'nmbd', 'winbind'];
const DOMAIN_FUNCTIONALITY: Record<string, string> = { '4': '2008_R2', '5': '2012', '6': '2012_R2', '7': '2016' };

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isPlatformError(e) && e.code.startsWith('setup.')) throw e;
    const reason = isPlatformError(e) ? e.message : e instanceof Error ? e.message : String(e);
    throw new PlatformError('setup.step-failed', { step: name, reason: reason.slice(-800) }, { cause: e });
  }
}

/** smb.conf text with `dns forwarder` in [global] set to `forwarders` (removed when empty). */
export { withDnsForwarder, withGlobalParam, globalParam } from './smbconf.ts';

/** Network address of `ip` within its interface prefix, as CIDR (default `ntpAllow`). */
export function networkOf(ip: string, prefix: number): string {
  const n = ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const net = (n & mask) >>> 0;
  return `${[24, 16, 8, 0].map((s) => String((net >>> s) & 255)).join('.')}/${String(prefix)}`;
}

async function waitForSrv(domain: string, server: string, timeoutMs: number): Promise<void> {
  const r = new Resolver({ timeout: 2000, tries: 1 });
  r.setServers([server]);
  const until = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < until) {
    try {
      if ((await r.resolveSrv(`_ldap._tcp.${domain}`)).length > 0) return;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(`_ldap._tcp.${domain} did not resolve on ${server} within ${String(timeoutMs / 1000)} s (${last})`);
}

class Setup {
  readonly d: SetupDeps;
  readonly samba: SambaLocal;

  constructor(d: SetupDeps) {
    this.d = d;
    this.samba = new SambaLocal(d.os);
  }

  async guardNotDone(domain: string): Promise<void> {
    const state = await this.d.node.read();
    if (state && !(await this.d.token.read())) {
      throw new PlatformError('setup.already-provisioned', { domain: state.domain });
    }
    if (state && state.domain !== domain)
      throw new PlatformError('setup.already-provisioned', { domain: state.domain });
  }

  async base(a: { fqdn: string; hostIp: string; dnsForwarders: string[] }, resolverFor: string[]): Promise<void> {
    const { os, progress } = this.d;
    progress('hostname', 3);
    await step('hostname', () => os.host.setHostname(a.fqdn, a.hostIp));
    if (resolverFor.length) {
      progress('resolver', 6);
      await step('resolver', () =>
        os.host.configureResolver({
          nameservers: resolverFor,
          searchDomains: [a.fqdn.split('.').slice(1).join('.')],
          freePort53: true,
        }),
      );
    }
    progress('packages', 10);
    await step('packages', async () => {
      const wanted = [...os.facts.packageNames('samba-dc'), ...os.facts.packageNames('chrony')];
      const missing: string[] = [];
      for (const p of wanted) if (!(await os.packages.installed(p))) missing.push(p);
      await os.packages.install(missing);
    });
    progress('samba-units', 40);
    await step('samba-units', async () => {
      for (const u of FILE_SERVER_UNITS) {
        await os.services.disable(u, true);
        await os.services.mask(u).catch(() => undefined);
      }
    });
  }

  /** Moves the package's default smb.conf out of the way (provision/join refuse to overwrite it). */
  async clearSmbConf(): Promise<void> {
    const conf = this.samba.paths.smbConf;
    if (
      await stat(conf).then(
        () => true,
        () => false,
      )
    )
      await rename(conf, `${conf}.opendc-prev`);
  }

  /** Sets `dns forwarder` in smb.conf's [global] section (resumed runs, and loopback values from provision). */
  async setForwarders(forwarders: string[]): Promise<void> {
    const conf = this.samba.paths.smbConf;
    const text = await readFile(conf, 'utf8').catch(() => null);
    if (text === null) return;
    const next = withDnsForwarder(text, forwarders);
    if (next !== text) await writeSystemFile(conf, next, 0o644);
  }

  async startDc(selfIp: string, domain: string, extraNameservers: string[]): Promise<void> {
    const { os, progress } = this.d;
    progress('krb5', 66);
    await step('krb5', () => copyFile(`${this.samba.paths.privateDir}/krb5.conf`, '/etc/krb5.conf'));
    // before Samba starts: a stub resolver on 127.0.0.53:53 would keep its DNS from binding 0.0.0.0:53
    progress('resolver-self', 68);
    await step('resolver-self', () =>
      os.host.configureResolver({
        nameservers: [selfIp, ...extraNameservers],
        searchDomains: [domain],
        freePort53: true,
      }),
    );
    progress('start', 70);
    await step('start', async () => {
      await os.services.unmask('samba-ad-dc');
      await os.services.enable('samba-ad-dc', false);
      // a resumed run restarts it, so changed configuration and freed ports take effect
      if ((await os.services.status('samba-ad-dc')).active === 'active') await os.services.restart('samba-ad-dc');
      await os.services.startAndWait('samba-ad-dc', 180_000);
    });
    progress('dns', 76);
    await step('dns', () => waitForSrv(domain, selfIp, 180_000));
  }

  async timeServer(a: { hostIp: string; ntpAllow: string[]; ntpServers: string[] }): Promise<void> {
    const { os, progress } = this.d;
    progress('time', 80);
    await step('time', async () => {
      let allow = a.ntpAllow;
      if (!allow.length) {
        const addr = (await os.host.addresses()).find((x) => x.address === a.hostIp);
        allow = addr ? [networkOf(addr.address, addr.prefix)] : [];
      }
      await os.host.configureTimeServer({
        signdSocketDir: `${this.samba.paths.stateDir}/ntp_signd`,
        allow,
        upstream: a.ntpServers,
      });
    });
  }

  async finish(o: {
    role: 'primary-dc' | 'dc';
    domain: string;
    fqdn: string;
    idBase: number | null;
  }): Promise<ProvisionResult> {
    const { os, progress, secrets } = this.d;
    const domainDn = await step('read-domain', () => this.samba.domainDn());
    const sid = await step('read-domain', async () => {
      const s = first(await this.samba.get(domainDn, ['objectSid']), 'objectSid');
      if (!s) throw new Error(`${domainDn} has no objectSid`);
      return s;
    });
    const platform = new PlatformBootstrap(this.samba, domainDn);
    progress('platform', 85);
    if (o.idBase !== null) {
      const idBase = o.idBase;
      await step('platform', () => platform.domainObjects({ idBase, provisionedAt: new Date().toISOString() }));
    }
    const host = o.fqdn.split('.')[0] ?? o.fqdn;
    const accounts = await step('service-accounts', () =>
      platform.dcAccounts(host, { svc: servicePassword(), watch: servicePassword() }),
    );
    // protect tier-0 accounts from the delegation just granted (Samba has no SDProp)
    await step('sdprop', () => runSdPropIfPdc(this.samba, host));
    progress('secrets', 92);
    await step('secrets', async () => {
      const [svc, watch] = accounts;
      if (!svc || !watch) throw new Error('service accounts missing');
      await secrets.put('ldap-svc', JSON.stringify({ dn: svc.dn, sam: svc.sam, password: svc.password }));
      await secrets.put('ldap-watch', JSON.stringify({ dn: watch.dn, sam: watch.sam, password: watch.password }));
      const ca = await this.#readTlsCa();
      if (ca) await secrets.put('ldap-ca.pem', ca);
    });
    progress('config', 95);
    await step('config', async () => {
      const fileId = 'core.registry-local';
      const path = os.facts.paths.managedFile('opendc.registry.local');
      const cur = await os.files.readManaged(path);
      const values = {
        ...parseLayer(fileId, cur?.content ?? null),
        'core.directory.ldapUrls': [`ldaps://${o.fqdn}`],
        'core.directory.baseDn': domainDn,
        'core.directory.tlsServerName': o.fqdn,
      };
      const sorted = Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
      await os.files.writeManaged(
        path,
        withHeader('json-field', 'core', fileId, JSON.stringify({ schemaVersion: 1, values: sorted })),
        null,
        0o644,
      );
      await this.d.node.write({
        schemaVersion: 1,
        role: o.role,
        domain: o.domain,
        realm: o.domain.toUpperCase(),
        domainDn,
        domainSid: sid,
        fqdn: o.fqdn,
        setupAt: new Date().toISOString(),
      });
      this.d.onRole(o.role);
    });
    await step('certificate', () => this.d.afterSetup());
    progress('done', 100);
    await this.d.token.destroy();
    return {
      domain: o.domain,
      realm: o.domain.toUpperCase(),
      domainDn,
      domainSid: sid,
      dcFqdn: o.fqdn,
      serviceAccounts: accounts.map(({ name, sam, guid }) => ({ name, sam, guid })),
    };
  }

  /** Samba creates its self-signed TLS CA on the first start; it may take a moment to appear. */
  async #readTlsCa(): Promise<Buffer | null> {
    const path = `${this.samba.paths.tlsDir}/ca.pem`;
    for (let i = 0; i < 30; i++) {
      const buf = await readFile(path).catch(() => null);
      if (buf?.length) return buf;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  }
}

export async function provision(a: Provision, d: SetupDeps): Promise<ProvisionResult> {
  const s = new Setup(d);
  await s.guardNotDone(a.domain);
  const realm = a.domain.toUpperCase();
  // no forwarders given: the host's real upstream resolvers (Samba would otherwise copy a 127.0.0.53 stub)
  const forwarders = a.dnsForwarders.length ? a.dnsForwarders : await d.os.host.upstreamNameservers();
  await s.base(a, forwarders);
  if (!(await s.samba.provisioned())) {
    d.progress('provision', 45);
    await step('provision', async () => {
      await s.clearSmbConf();
      const host = a.fqdn.split('.')[0] ?? a.fqdn;
      const argv = [
        'domain',
        'provision',
        `--realm=${realm}`,
        `--domain=${a.netbiosDomain}`,
        '--server-role=dc',
        `--dns-backend=${a.dnsBackend}`,
        '--use-rfc2307',
        `--host-name=${host}`,
        `--host-ip=${a.hostIp}`,
        `--site=${a.siteName}`,
        `--base-schema=${a.baseSchema}`,
        `--function-level=${a.functionalLevel}`,
      ];
      if (forwarders.length) argv.push(`--option=dns forwarder = ${forwarders.join(' ')}`);
      if (a.functionalLevel === '2016') argv.push('--option=ad dc functional level = 2016');
      // no --adminpass: Samba picks a random one; the real password is set below through stdin
      await s.samba.tool(argv, { timeoutMs: 900_000 });
    });
  } else {
    const dn = await s.samba.domainDn();
    if (dn.toLowerCase() !== dnFromDomain(a.domain).toLowerCase()) {
      throw new PlatformError('setup.already-provisioned', { domain: dn });
    }
  }
  await step('forwarders', () => s.setForwarders(forwarders));
  d.progress('admin-password', 64);
  await step('admin-password', async () => {
    const domainDn = dnFromDomain(a.domain);
    await s.samba.modify(
      modifyRecord(`CN=Administrator,CN=Users,${domainDn}`, [
        { op: 'replace', attr: 'unicodePwd', values: [unicodePwd(a.adminPassword)] },
      ]),
    );
  });
  await s.startDc(a.hostIp, a.domain, []);
  await s.timeServer(a);
  return s.finish({ role: 'primary-dc', domain: a.domain, fqdn: a.fqdn, idBase: a.idBase });
}

export async function join(a: Join, d: SetupDeps): Promise<ProvisionResult> {
  const s = new Setup(d);
  await s.guardNotDone(a.domain);
  const realm = a.domain.toUpperCase();
  const dcIp = await step('resolve-dc', async () => {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(a.dcHost)) return a.dcHost;
    const r = new Resolver({ timeout: 3000, tries: 2 });
    if (a.dnsForwarders.length) r.setServers(a.dnsForwarders);
    const [ip] = await r.resolve4(a.dcHost);
    if (!ip) throw new Error(`${a.dcHost} has no IPv4 address`);
    return ip;
  });
  const forwarders = a.dnsForwarders.length ? a.dnsForwarders : await d.os.host.upstreamNameservers();
  // the existing DC is the only DNS server that knows the domain
  await s.base(a, [dcIp]);
  if (!(await s.samba.provisioned())) {
    d.progress('join', 45);
    await step('join', async () => {
      await s.clearSmbConf();
      await writeSystemFile(
        '/etc/krb5.conf',
        `[libdefaults]\n\tdefault_realm = ${realm}\n\tdns_lookup_realm = false\n\tdns_lookup_kdc = true\n`,
        0o644,
      );
      const root = await s.samba.rootDse(`ldap://${dcIp}`);
      const level = DOMAIN_FUNCTIONALITY[first(root, 'domainFunctionality') ?? ''] ?? null;
      const user = a.username.includes('@') || a.username.includes('\\') ? a.username : `${a.username}@${realm}`;
      const argv = [
        'domain',
        'join',
        realm,
        'DC',
        `--username=${user}`,
        `--server=${dcIp}`,
        `--dns-backend=SAMBA_INTERNAL`,
        `--site=${a.siteName}`,
        '--option=idmap_ldb:use rfc2307 = yes',
      ];
      if (forwarders.length) argv.push(`--option=dns forwarder = ${forwarders.join(' ')}`);
      if (level === '2016') argv.push('--option=ad dc functional level = 2016');
      // the password goes through the environment (Samba's credential parser reads PASSWD), not argv
      await s.samba.tool(argv, { timeoutMs: 1_800_000, env: { PASSWD: a.password } });
    });
  }
  await step('forwarders', () => s.setForwarders(forwarders));
  await s.startDc(a.hostIp, a.domain, [dcIp]);
  await s.timeServer(a);
  return s.finish({ role: 'dc', domain: a.domain, fqdn: a.fqdn, idBase: null });
}
