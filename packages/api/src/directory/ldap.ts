// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The API's directory connection (ADR-0012, tier 1): LDAPS (or StartTLS) to the local DC, bound as the
 * delegated platform account opendc-svc-<host> whose credential arrives as a systemd credential. One
 * connection is reused (ldapts multiplexes requests); it is re-established (and bound again) once when it is
 * lost. ldapts would otherwise reconnect a closed socket by itself, unauthenticated, once per concurrent
 * caller, and a request sent on one of those sockets can be orphaned and never answered.
 * Every filter is built with the escaping helpers; every LDAP error becomes a PlatformError.
 */
import {
  AlreadyExistsError,
  Attribute,
  Change,
  Client,
  ConstraintViolationError,
  Control,
  InsufficientAccessError,
  InvalidDNSyntaxError,
  InvalidSyntaxError,
  NoSuchObjectError,
  NotAllowedOnNonLeafError,
  UnwillingToPerformError,
  type ClientOptions,
  type Entry,
} from 'ldapts';
import { PlatformError } from '@opendc/shared';
import { ldaptsFilter, present, type LdapFilter } from '@opendc/shared/ldap';

export interface ServiceCredential {
  dn: string;
  sam: string;
  password: string;
}

export interface LdapConfig {
  urls: string[];
  caPem: string | null;
  tlsServerName?: string;
  credential: ServiceCredential | null;
  timeoutMs?: number;
}

export type Mod = { op: 'add' | 'replace' | 'delete'; attr: string; values: (string | Buffer)[] };

/** Tree delete (LDAP_SERVER_TREE_DELETE_OID). */
const TREE_DELETE = '1.2.840.113556.1.4.805';

/** Maps an LDAP failure to the platform's error catalogue. `what` names the object for messages. */
export function mapLdapError(e: unknown, what: string): PlatformError {
  if (e instanceof PlatformError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof InsufficientAccessError) return new PlatformError('directory.access-denied', { what }, { cause: e });
  if (e instanceof AlreadyExistsError) return new PlatformError('directory.exists', { what }, { cause: e });
  if (e instanceof NoSuchObjectError) return new PlatformError('request.not-found', { what }, { cause: e });
  if (e instanceof NotAllowedOnNonLeafError) return new PlatformError('directory.not-empty', { what }, { cause: e });
  if (e instanceof ConstraintViolationError || e instanceof UnwillingToPerformError) {
    // Samba reports password policy failures as constraint violations ("check_password_restrictions")
    if (/password|pwd/i.test(msg)) return new PlatformError('directory.password-rejected', { what }, { cause: e });
    return new PlatformError('directory.invalid', { reason: msg.slice(0, 200) }, { cause: e });
  }
  if (e instanceof InvalidSyntaxError || e instanceof InvalidDNSyntaxError)
    return new PlatformError('directory.invalid', { reason: msg.slice(0, 200) }, { cause: e });
  const code = (e as NodeJS.ErrnoException).code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code))
    return new PlatformError('ldap.unreachable', { host: '-', port: '-', reason: code }, { cause: e });
  const ldapCode = (e as { code?: unknown }).code;
  return new PlatformError(
    'ldap.operation-failed',
    {
      reason: msg.slice(0, 200),
      ldapCode: typeof ldapCode === 'number' || typeof ldapCode === 'string' ? String(ldapCode) : '?',
      host: '-',
    },
    { cause: e },
  );
}

/** The connection is gone or no longer bound (the DC restarted): worth one retry on a fresh, bound one. */
const isConnectionLost = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException).code;
  if (typeof code === 'string' && /^(ECONNRESET|EPIPE|ECONNREFUSED|ETIMEDOUT|ENOTCONN)$/.test(code)) return true;
  const msg = e instanceof Error ? e.message : '';
  // ldapts messages for a socket closed under a request, a missing socket and a request timeout; Samba's
  // 00002020 for a request on a connection that lost its bind
  return /Connection closed before message response|Socket connection not established|Operation timed out|00002020/.test(
    msg,
  );
};

export interface LdapLike {
  search(
    base: string,
    o: {
      scope: 'base' | 'one' | 'sub';
      filter?: LdapFilter;
      attributes: string[];
      sizeLimit?: number;
      buffers?: string[];
    },
  ): Promise<Entry[]>;
  add(dn: string, attrs: Record<string, (string | Buffer)[]>): Promise<void>;
  modify(dn: string, mods: Mod[]): Promise<void>;
  del(dn: string, opts?: { tree?: boolean }): Promise<void>;
  rename(dn: string, newDn: string): Promise<void>;
}

export class ServiceLdap implements LdapLike {
  readonly #cfg: LdapConfig;
  readonly #factory: (o: ClientOptions) => Client;
  #client: Promise<Client> | null = null;

  constructor(cfg: LdapConfig, factory: (o: ClientOptions) => Client = (o) => new Client(o)) {
    this.#cfg = cfg;
    this.#factory = factory;
  }

  get configured(): boolean {
    return this.#cfg.credential !== null;
  }

  async #connect(): Promise<Client> {
    const cred = this.#cfg.credential;
    if (!cred) throw new PlatformError('directory.not-configured');
    let last: unknown = null;
    for (const url of this.#cfg.urls) {
      const u = new URL(url);
      const tls = {
        ...(this.#cfg.caPem ? { ca: this.#cfg.caPem } : {}),
        servername: this.#cfg.tlsServerName || u.hostname,
        minVersion: 'TLSv1.2' as const,
        rejectUnauthorized: true,
      };
      const client = this.#factory({
        url,
        timeout: this.#cfg.timeoutMs ?? 30_000,
        connectTimeout: 5000,
        tlsOptions: tls,
      });
      try {
        if (u.protocol === 'ldap:') await client.startTLS(tls);
        await client.bind(cred.dn, cred.password);
        return client;
      } catch (e) {
        last = e;
        await client.unbind().catch(() => undefined);
      }
    }
    throw mapLdapError(last, 'directory');
  }

  async #run<T>(what: string, fn: (c: Client) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const pending = (this.#client ??= this.#connect());
      let c: Client;
      try {
        c = await pending;
      } catch (e) {
        if (this.#client === pending) this.#client = null;
        throw mapLdapError(e, what);
      }
      // never let ldapts reconnect by itself: that connection would be anonymous
      if (!c.isBound) {
        this.#drop(pending, c);
        if (attempt === 0) continue;
        throw new PlatformError('ldap.unreachable', { host: '-', port: '-', reason: 'connection lost' });
      }
      try {
        return await fn(c);
      } catch (e) {
        if (attempt === 0 && isConnectionLost(e)) {
          this.#drop(pending, c);
          continue;
        }
        throw mapLdapError(e, what);
      }
    }
  }

  /** Forgets a lost connection; concurrent callers share the one that replaces it. */
  #drop(pending: Promise<Client>, c: Client): void {
    if (this.#client === pending) this.#client = null;
    void c.unbind().catch(() => undefined);
  }

  async search(
    base: string,
    o: {
      scope: 'base' | 'one' | 'sub';
      filter?: LdapFilter;
      attributes: string[];
      sizeLimit?: number;
      buffers?: string[];
    },
  ): Promise<Entry[]> {
    return this.#run(base, async (c) => {
      try {
        const r = await c.search(base, {
          scope: o.scope,
          filter: ldaptsFilter(o.filter ?? present('objectClass')),
          attributes: o.attributes,
          explicitBufferAttributes: ['objectGUID', 'objectSid', 'tokenGroups', 'thumbnailPhoto', ...(o.buffers ?? [])],
          ...(o.scope === 'base' ? {} : { paged: { pageSize: 500 } }),
          ...(o.sizeLimit ? { sizeLimit: o.sizeLimit } : {}),
        });
        return r.searchEntries;
      } catch (e) {
        if (e instanceof NoSuchObjectError && o.scope === 'base') return [];
        throw e;
      }
    });
  }

  async add(dn: string, attrs: Record<string, (string | Buffer)[]>): Promise<void> {
    await this.#run(dn, (c) =>
      c.add(
        dn,
        Object.entries(attrs)
          .filter(([, v]) => v.length > 0)
          .map(([type, values]) => new Attribute({ type, values: values as string[] | Buffer[] })),
      ),
    );
  }

  async modify(dn: string, mods: Mod[]): Promise<void> {
    if (!mods.length) return;
    await this.#run(dn, (c) =>
      c.modify(
        dn,
        mods.map(
          (m) =>
            new Change({
              operation: m.op,
              modification: new Attribute({ type: m.attr, values: m.values as string[] | Buffer[] }),
            }),
        ),
      ),
    );
  }

  async del(dn: string, opts: { tree?: boolean } = {}): Promise<void> {
    await this.#run(dn, (c) => c.del(dn, opts.tree ? new Control(TREE_DELETE, { critical: true }) : undefined));
  }

  async rename(dn: string, newDn: string): Promise<void> {
    await this.#run(dn, (c) => c.modifyDN(dn, newDn));
  }

  async close(): Promise<void> {
    const c = this.#client;
    this.#client = null;
    if (c) await (await c.catch(() => null))?.unbind().catch(() => undefined);
  }
}
