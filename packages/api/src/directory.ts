// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Console login against the directory (ADR-0020): LDAPS simple bind (or StartTLS) to a DC whose certificate
 * is verified against the configured CA. The password exists only for the bind call. After the bind the
 * user's own entry and transitive groups (tokenGroups) are read with the user's credentials.
 */
import { Client, InvalidCredentialsError, type ClientOptions, type Entry } from 'ldapts';
import { PlatformError } from '@opendc/shared';
import { eq, guidFromBytes, ldaptsFilter, present, sidFromBytes, domainFromDn } from '@opendc/shared/ldap';
import type { SessionUser } from './sessions.ts';

export interface DirectoryConfig {
  urls: string[];
  /** PEM CA bundle that DC certificates must chain to. */
  caPem: string | null;
  /** Name to verify in the certificate; default: host of each URL. */
  tlsServerName?: string;
  /** Domain base DN; default: defaultNamingContext from the rootDSE. */
  baseDn?: string;
  timeoutMs?: number;
}

export interface LdapClientLike {
  startTLS(options: NonNullable<ClientOptions['tlsOptions']>): Promise<void>;
  bind(dn: string, password: string): Promise<void>;
  search(base: string, options: Parameters<Client['search']>[1]): Promise<{ searchEntries: Entry[] }>;
  unbind(): Promise<void>;
}

export type ClientFactory = (options: ClientOptions) => LdapClientLike;

export interface AuthenticatedUser extends SessionUser {
  upn: string | null;
  adminCount: number | null;
  /** The DC that verified the credentials. */
  dc: string;
}

/** AD bind sub-codes ("data 52e") -> our error codes. */
function bindFailure(message: string): PlatformError {
  const code = /data ([0-9a-f]{3,4})/i.exec(message)?.[1]?.toLowerCase();
  switch (code) {
    case '775':
      return new PlatformError('auth.account-locked');
    case '533':
    case '701':
      return new PlatformError('auth.account-disabled');
    case '532':
    case '773':
      return new PlatformError('auth.password-expired');
    default:
      return new PlatformError('auth.invalid-credentials');
  }
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

function first(e: Entry, attr: string): string | null {
  const v = e[attr];
  const x = Array.isArray(v) ? v[0] : v;
  return x === undefined ? null : Buffer.isBuffer(x) ? x.toString('utf8') : x;
}

function buffers(e: Entry, attr: string): Buffer[] {
  const v = e[attr];
  const arr = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return arr.filter((x): x is Buffer => Buffer.isBuffer(x));
}

export function normalizeUsername(input: string): string {
  const u = input.normalize('NFC').trim();
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (!u || u.length > 256 || /[\u0000-\u001f\u007f]/.test(u)) throw new PlatformError('auth.invalid-credentials');
  return u;
}

export class DirectoryAuth {
  readonly #cfg: DirectoryConfig;
  readonly #factory: ClientFactory;

  constructor(cfg: DirectoryConfig, factory: ClientFactory = (o) => new Client(o)) {
    if (cfg.urls.length === 0) throw new TypeError('DirectoryAuth needs at least one LDAP URL');
    this.#cfg = cfg;
    this.#factory = factory;
  }

  #tls(host: string): NonNullable<ClientOptions['tlsOptions']> {
    return {
      ...(this.#cfg.caPem ? { ca: this.#cfg.caPem } : {}),
      servername: this.#cfg.tlsServerName || host,
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
    };
  }

  async authenticate(username: string, password: string): Promise<AuthenticatedUser> {
    const user = normalizeUsername(username);
    // An empty password is an unauthenticated ("anonymous") bind in AD and would "succeed".
    if (password.length === 0 || password.length > 1024) throw new PlatformError('auth.invalid-credentials');

    let lastNetworkError: PlatformError | null = null;
    for (const url of this.#cfg.urls) {
      const u = new URL(url);
      const host = u.hostname;
      const port = u.port || (u.protocol === 'ldaps:' ? '636' : '389');
      const client = this.#factory({
        url,
        timeout: this.#cfg.timeoutMs ?? 10_000,
        connectTimeout: 5_000,
        tlsOptions: this.#tls(host),
      });
      try {
        if (u.protocol === 'ldap:') await client.startTLS(this.#tls(host));
        const baseDn = this.#cfg.baseDn || (await this.#defaultNamingContext(client));
        const domain = domainFromDn(baseDn);
        // Samba's simple bind accepts a DN or a UPN, not the down-level "DOMAIN\user" form, so that form is
        // bound as user@<DNS domain> (one forest, one domain: the mapping is exact).
        const sam = user.includes('\\') ? user.slice(user.indexOf('\\') + 1) : user;
        const bindName = sam.includes('@') ? sam : `${sam}@${domain}`;
        try {
          await client.bind(bindName, password);
        } catch (e) {
          if (e instanceof InvalidCredentialsError) throw bindFailure(e.message);
          throw e;
        }
        return await this.#readUser(client, baseDn, user, host);
      } catch (e) {
        if (e instanceof PlatformError) throw e;
        const err = e as NodeJS.ErrnoException & { code?: string | number };
        const msg = err.message || String(e);
        if (typeof err.code === 'string' && NETWORK_CODES.has(err.code)) {
          lastNetworkError = new PlatformError('ldap.unreachable', { host, port, reason: err.code }, { cause: e });
          continue;
        }
        if (
          /certificate|self[- ]signed|altnames|CERT_|unable to verify/i.test(msg) ||
          (typeof err.code === 'string' && err.code.includes('CERT'))
        ) {
          lastNetworkError = new PlatformError('ldap.tls-untrusted', { host, reason: msg.slice(0, 200) }, { cause: e });
          continue;
        }
        if (/timeout|timed out/i.test(msg)) {
          lastNetworkError = new PlatformError('ldap.unreachable', { host, port, reason: 'timeout' }, { cause: e });
          continue;
        }
        throw new PlatformError(
          'ldap.operation-failed',
          { reason: msg.slice(0, 200), ldapCode: err.code ?? '?', host },
          { cause: e },
        );
      } finally {
        await client.unbind().catch(() => undefined);
      }
    }
    throw (
      lastNetworkError ??
      new PlatformError('ldap.unreachable', { host: this.#cfg.urls.join(', '), port: '?', reason: 'no DC answered' })
    );
  }

  async #defaultNamingContext(client: LdapClientLike): Promise<string> {
    const r = await client.search('', {
      scope: 'base',
      filter: ldaptsFilter(present('objectClass')),
      attributes: ['defaultNamingContext'],
    });
    const nc = r.searchEntries[0] ? first(r.searchEntries[0], 'defaultNamingContext') : null;
    if (!nc)
      throw new PlatformError('ldap.operation-failed', {
        reason: 'rootDSE has no defaultNamingContext; set core.directory.baseDn',
        ldapCode: '-',
        host: '-',
      });
    return nc;
  }

  async #readUser(client: LdapClientLike, baseDn: string, user: string, host: string): Promise<AuthenticatedUser> {
    const name = user.includes('\\') ? (user.split('\\')[1] ?? user) : user;
    const f = name.includes('@') ? eq('userPrincipalName', name) : eq('sAMAccountName', name);
    const attrs = [
      'objectGUID',
      'objectSid',
      'sAMAccountName',
      'displayName',
      'userPrincipalName',
      'adminCount',
      'distinguishedName',
    ];
    const found = await client.search(baseDn, {
      scope: 'sub',
      filter: ldaptsFilter(f),
      attributes: attrs,
      explicitBufferAttributes: ['objectGUID', 'objectSid'],
      sizeLimit: 2,
    });
    const entry = found.searchEntries[0];
    if (!entry || found.searchEntries.length !== 1) throw new PlatformError('auth.invalid-credentials');
    const [guidBuf] = buffers(entry, 'objectGUID');
    const [sidBuf] = buffers(entry, 'objectSid');
    if (!guidBuf || !sidBuf)
      throw new PlatformError('ldap.operation-failed', {
        reason: 'user entry lacks objectGUID/objectSid',
        ldapCode: '-',
        host,
      });
    const sid = sidFromBytes(sidBuf);
    const tg = await client.search(entry.dn, {
      scope: 'base',
      filter: ldaptsFilter(present('objectClass')),
      attributes: ['tokenGroups'],
      explicitBufferAttributes: ['tokenGroups'],
    });
    const groupSids = tg.searchEntries[0]
      ? buffers(tg.searchEntries[0], 'tokenGroups').map((b) => sidFromBytes(b))
      : [];
    const adminCount = first(entry, 'adminCount');
    return {
      sid,
      guid: guidFromBytes(guidBuf),
      username: first(entry, 'sAMAccountName') ?? name,
      displayName: first(entry, 'displayName'),
      upn: first(entry, 'userPrincipalName'),
      dn: entry.dn,
      domainSid: sid.split('-').slice(0, -1).join('-'),
      groupSids,
      adminCount: adminCount === null ? null : Number(adminCount),
      dc: host,
    };
  }
}
