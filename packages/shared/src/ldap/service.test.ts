// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AlreadyExistsError,
  ConstraintViolationError,
  InsufficientAccessError,
  InvalidDNSyntaxError,
  NoSuchObjectError,
  NotAllowedOnNonLeafError,
  UnwillingToPerformError,
  type Client,
  type ClientOptions,
} from 'ldapts';
import { DirSyncControl } from './controls.ts';
import { eq } from './filter.ts';
import { ServiceLdap, mapLdapError } from './service.ts';

interface Call {
  op: string;
  args: unknown[];
}

/** A fake ldapts client: records calls; `script` decides results per operation. */
function fakeFactory(script: Partial<Record<string, (...a: unknown[]) => unknown>> = {}) {
  const calls: Call[] = [];
  const opts: ClientOptions[] = [];
  const clients: { bound: boolean; fail: Error | null; binds: number }[] = [];
  let refuse = false;
  const factory = (o: ClientOptions) => {
    opts.push(o);
    const f = { bound: false, fail: null as Error | null, binds: 0 };
    clients.push(f);
    const rec =
      (op: string, dflt: (...a: unknown[]) => unknown = () => undefined) =>
      async (...args: unknown[]) => {
        calls.push({ op, args });
        if (f.fail) {
          const e = f.fail;
          f.fail = null;
          throw e;
        }
        return (script[op] ?? dflt)(...args);
      };
    return {
      get isBound() {
        return f.bound;
      },
      bind: async (...args: unknown[]) => {
        calls.push({ op: 'bind', args });
        if (refuse) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        if (script.bind) await script.bind(...args);
        f.binds++;
        f.bound = true;
      },
      startTLS: rec('startTLS'),
      search: rec('search', () => ({ searchEntries: [{ dn: 'CN=x' }] })),
      add: rec('add'),
      modify: rec('modify'),
      del: rec('del'),
      modifyDN: rec('modifyDN'),
      unbind: async () => {
        f.bound = false;
      },
    } as unknown as Client;
  };
  return {
    factory,
    calls,
    opts,
    clients,
    refuse: (v: boolean) => {
      refuse = v;
    },
  };
}

const cred = { dn: 'CN=svc', sam: 'svc', password: 'x' };

test('service connection: a lost or unbound connection is replaced once, shared by concurrent callers', async () => {
  const f = fakeFactory();
  const ldap = new ServiceLdap({ urls: ['ldaps://dc1.example.test'], caPem: null, credential: cred }, f.factory);
  const one = () => ldap.search('DC=example,DC=test', { scope: 'base', attributes: ['cn'] });

  assert.equal((await one()).length, 1);
  assert.equal(f.clients.length, 1);

  // the DC restarted: ldapts would reconnect anonymously; three concurrent calls share one new bound client
  f.clients[0]!.bound = false;
  const r = await Promise.all([one(), one(), one()]);
  assert.deepEqual(
    r.map((x) => x.length),
    [1, 1, 1],
  );
  assert.equal(f.clients.length, 2);
  assert.equal(f.clients[1]!.binds, 1);

  // the socket closes under a request: retried once on a fresh connection
  f.clients[1]!.fail = new Error('Connection closed before message response was received. Message type: SearchRequest');
  assert.equal((await one()).length, 1);
  assert.equal(f.clients.length, 3);

  // the DC stays down: an error, no endless retries
  f.clients[2]!.bound = false;
  f.refuse(true);
  await assert.rejects(one(), (e: { code?: string }) => e.code === 'ldap.unreachable');
  assert.ok(f.clients.length <= 5);
  f.refuse(false);
  assert.equal((await one()).length, 1);

  // a reconnected but still unbound client after the retry: an error, not an anonymous request
  const g = fakeFactory({ bind: () => undefined });
  const never = new ServiceLdap({ urls: ['ldaps://dc1'], caPem: null, credential: cred }, (o) => {
    const c = g.factory(o);
    Object.defineProperty(c, 'isBound', { get: () => false });
    return c;
  });
  await assert.rejects(never.search('', { scope: 'base', attributes: [] }), /connection lost|not reachable/);
});

test('service connection: URLs in order, StartTLS for ldap://, certificate checks, not configured', async () => {
  const f = fakeFactory({
    bind: () => {
      if (f.opts.length === 1) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    },
  });
  const ldap = new ServiceLdap(
    { urls: ['ldaps://dc1.example.test', 'ldap://dc2.example.test:389'], caPem: 'PEM', credential: cred },
    f.factory,
  );
  assert.equal(ldap.configured, true);
  await ldap.search('DC=example,DC=test', { scope: 'base', attributes: ['cn'] });
  assert.equal(f.opts.length, 2, 'dc1 refused, dc2 used');
  assert.equal(f.opts[1]?.tlsOptions?.servername, 'dc2.example.test');
  assert.equal(f.opts[1]?.tlsOptions?.ca, 'PEM');
  assert.equal(f.opts[1]?.tlsOptions?.rejectUnauthorized, true);
  assert.ok(f.calls.some((c) => c.op === 'startTLS'));

  const none = new ServiceLdap({ urls: ['ldaps://dc1'], caPem: null, credential: null }, f.factory);
  assert.equal(none.configured, false);
  await assert.rejects(none.search('', { scope: 'base', attributes: [] }), (e: { code?: string }) => {
    return e.code === 'directory.not-configured';
  });
  await ldap.close();
  await none.close();
});

test('service connection: search, add, modify, delete, rename', async () => {
  const f = fakeFactory({
    search: (base) => {
      if (base === 'CN=gone') throw new NoSuchObjectError('no such object');
      return { searchEntries: [{ dn: String(base) }] };
    },
  });
  const ldap = new ServiceLdap({ urls: ['ldaps://dc1'], caPem: null, credential: cred }, f.factory);
  assert.deepEqual(await ldap.search('CN=gone', { scope: 'base', attributes: [] }), [], 'missing base = no result');
  await assert.rejects(
    ldap.search('CN=gone', { scope: 'sub', attributes: [] }),
    (e: { code?: string }) => e.code === 'request.not-found',
  );
  await ldap.search('CN=x', { scope: 'sub', filter: eq('cn', 'a'), attributes: ['cn'], sizeLimit: 5, buffers: ['b'] });
  const s = f.calls.at(-1)?.args[1] as { paged?: unknown; sizeLimit?: number; explicitBufferAttributes: string[] };
  assert.ok(s.paged);
  assert.equal(s.sizeLimit, 5);
  assert.ok(s.explicitBufferAttributes.includes('b'));

  await ldap.add('CN=n', { cn: ['n'], empty: [] });
  const added = f.calls.at(-1)?.args[1] as { type: string }[];
  assert.deepEqual(
    added.map((a) => a.type),
    ['cn'],
  );
  await ldap.modify('CN=n', []);
  assert.notEqual(f.calls.at(-1)?.op, 'modify', 'no changes: no request');
  await ldap.modify('CN=n', [{ op: 'replace', attr: 'description', values: ['d'] }]);
  assert.equal(f.calls.at(-1)?.op, 'modify');
  await ldap.del('CN=n');
  assert.equal(f.calls.at(-1)?.args[1], undefined);
  await ldap.del('OU=t', { tree: true });
  assert.equal((f.calls.at(-1)?.args[1] as { type: string }).type, '1.2.840.113556.1.4.805');
  await ldap.rename('CN=n', 'CN=m');
  assert.deepEqual(f.calls.at(-1)?.args, ['CN=n', 'CN=m']);
});

test('service connection: DirSync follows moreResults and returns the last cookie', async () => {
  let round = 0;
  const f = fakeFactory({
    search: (_b, _o, ctl) => {
      const c = ctl as DirSyncControl;
      round++;
      c.response = { moreResults: round < 3, cookie: Buffer.from(`c${String(round)}`) };
      return { searchEntries: [{ dn: `CN=${String(round)}` }] };
    },
  });
  const ldap = new ServiceLdap({ urls: ['ldaps://dc1'], caPem: null, credential: cred }, f.factory);
  const r = await ldap.dirsync('DC=example,DC=test', {
    filter: '(objectClass=user)',
    attributes: ['cn'],
    cookie: Buffer.from('c0'),
  });
  assert.equal(r.entries.length, 3);
  assert.equal(r.cookie.toString(), 'c3');
  const first = f.calls.find((c) => c.op === 'search');
  assert.equal((first?.args[2] as DirSyncControl).cookie.toString(), 'c0');
  assert.equal((first?.args[1] as { filter: string }).filter, '(objectClass=user)');

  await ldap.dirsync('DC=example,DC=test', { filter: eq('cn', 'x'), attributes: [], cookie: Buffer.alloc(0) });
  const g = fakeFactory({ search: () => ({ searchEntries: [] }) });
  const broken = new ServiceLdap({ urls: ['ldaps://dc1'], caPem: null, credential: cred }, g.factory);
  await assert.rejects(
    broken.dirsync('DC=x', { filter: '(a=b)', attributes: [], cookie: Buffer.alloc(0) }),
    /no DirSync response/,
  );
});

test('LDAP errors map to the platform catalogue', () => {
  const code = (e: unknown) => mapLdapError(e, 'CN=x').code;
  assert.equal(code(new InsufficientAccessError()), 'directory.access-denied');
  assert.equal(code(new AlreadyExistsError()), 'directory.exists');
  assert.equal(code(new NoSuchObjectError()), 'request.not-found');
  assert.equal(code(new NotAllowedOnNonLeafError()), 'directory.not-empty');
  assert.equal(code(new ConstraintViolationError('check_password_restrictions')), 'directory.password-rejected');
  assert.equal(code(new UnwillingToPerformError('nope')), 'directory.invalid');
  assert.equal(code(new InvalidDNSyntaxError()), 'directory.invalid');
  assert.equal(code(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), 'ldap.unreachable');
  const other = mapLdapError(Object.assign(new Error('weird'), { code: 80 }), 'CN=x');
  assert.equal(other.code, 'ldap.operation-failed');
  assert.equal(other.params.ldapCode, '80');
  assert.equal(mapLdapError('text', 'CN=x').params.ldapCode, '?');
  const pe = mapLdapError(new InsufficientAccessError(), 'x');
  assert.equal(mapLdapError(pe, 'y'), pe);
});
