// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidCredentialsError, type ClientOptions, type Entry } from 'ldapts';
import { PlatformError } from '@opendc/shared';
import { guidToBytes, sidToBytes } from '@opendc/shared/ldap';
import { DirectoryAuth, normalizeUsername, type LdapClientLike } from './directory.ts';

const DOM = 'S-1-5-21-7-8-9';
const BASE = 'DC=small,DC=opendc,DC=test';

interface Script {
  failConnect?: string;
  bindError?: string;
  tlsError?: boolean;
}

function factory(scripts: Record<string, Script>, log: string[]) {
  return (o: ClientOptions): LdapClientLike => {
    const host = new URL(o.url).hostname;
    const s = scripts[host] ?? {};
    const net = (): void => {
      if (s.failConnect) throw Object.assign(new Error(`connect ${s.failConnect}`), { code: s.failConnect });
      if (s.tlsError) throw Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
    };
    return {
      startTLS: async (tls) => {
        log.push(`starttls ${host} servername=${String(tls.servername)}`);
        net();
      },
      bind: async (dn) => {
        net();
        log.push(`bind ${host} ${dn}`);
        if (s.bindError) throw new InvalidCredentialsError(s.bindError);
      },
      search: async (base, opts) => {
        net();
        if (base === '') return { searchEntries: [{ dn: '', defaultNamingContext: BASE } as Entry] };
        if (opts?.scope === 'base') return { searchEntries: [{ dn: base, tokenGroups: [Buffer.from(sidToBytes(`${DOM}-512`)), Buffer.from(sidToBytes(`${DOM}-513`))] } as unknown as Entry] };
        log.push(`search ${String(opts?.filter)}`);
        return {
          searchEntries: [
            {
              dn: `CN=Administrator,CN=Users,${BASE}`,
              objectGUID: Buffer.from(guidToBytes('04030201-0605-0807-090a-0b0c0d0e0f10')),
              objectSid: Buffer.from(sidToBytes(`${DOM}-500`)),
              sAMAccountName: 'Administrator',
              displayName: 'Administrator',
              adminCount: '1',
            } as unknown as Entry,
          ],
        };
      },
      unbind: async () => undefined,
    };
  };
}

const code = (c: string) => (e: unknown) => e instanceof PlatformError && e.code === c;

test('successful login: UPN bind, user and transitive groups read with the user credentials', async () => {
  const log: string[] = [];
  const d = new DirectoryAuth({ urls: ['ldaps://sdc1.small.opendc.test'], caPem: 'PEM' }, factory({}, log));
  const u = await d.authenticate(' Administrator ', 'pw');
  assert.equal(u.sid, `${DOM}-500`);
  assert.equal(u.domainSid, DOM);
  assert.equal(u.guid, '04030201-0605-0807-090a-0b0c0d0e0f10');
  assert.deepEqual(u.groupSids, [`${DOM}-512`, `${DOM}-513`]);
  assert.equal(u.adminCount, 1);
  assert.equal(u.dc, 'sdc1.small.opendc.test');
  assert.ok(log.includes('bind sdc1.small.opendc.test Administrator@small.opendc.test'));
  // the value is sent as raw bytes, which ldapts prints hex-escaped
  assert.ok(log.some((l) => l.startsWith('search (sAMAccountName=')));
});

test('ldap:// URLs use StartTLS with the configured server name', async () => {
  const log: string[] = [];
  const d = new DirectoryAuth({ urls: ['ldap://10.97.10.51'], caPem: null, tlsServerName: 'sdc1.small.opendc.test', baseDn: BASE }, factory({}, log));
  await d.authenticate('SMALL\\Administrator', 'pw');
  assert.equal(log[0], 'starttls 10.97.10.51 servername=sdc1.small.opendc.test');
  assert.equal(log[1], 'bind 10.97.10.51 SMALL\\Administrator');
});

test('AD bind sub-codes map to precise errors and never fail over', async () => {
  const cases: [string, string][] = [
    ['80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data 52e, v1db1', 'auth.invalid-credentials'],
    ['80090308: LdapErr: DSID-0C0903A9, comment: AcceptSecurityContext error, data 775, v1db1', 'auth.account-locked'],
    ['... data 533, v1db1', 'auth.account-disabled'],
    ['... data 773, v1db1', 'auth.password-expired'],
    ['... data 532, v1db1', 'auth.password-expired'],
  ];
  for (const [msg, c] of cases) {
    const log: string[] = [];
    const d = new DirectoryAuth({ urls: ['ldaps://dc1', 'ldaps://dc2'], caPem: null, baseDn: BASE }, factory({ dc1: { bindError: msg } }, log));
    await assert.rejects(d.authenticate('x', 'pw'), code(c), msg);
    assert.ok(!log.some((l) => l.includes('dc2')), 'a wrong password must not be retried on another DC');
  }
});

test('network errors fail over to the next DC; TLS errors are reported as untrusted', async () => {
  const log: string[] = [];
  const d = new DirectoryAuth({ urls: ['ldaps://dc1', 'ldaps://dc2'], caPem: null, baseDn: BASE }, factory({ dc1: { failConnect: 'ECONNREFUSED' } }, log));
  assert.equal((await d.authenticate('Administrator', 'pw')).dc, 'dc2');
  const allDown = new DirectoryAuth({ urls: ['ldaps://dc1'], caPem: null, baseDn: BASE }, factory({ dc1: { failConnect: 'ETIMEDOUT' } }, []));
  await assert.rejects(allDown.authenticate('a', 'b'), (e: unknown) => code('ldap.unreachable')(e) && (e as PlatformError).message.includes('ETIMEDOUT'));
  const tls = new DirectoryAuth({ urls: ['ldaps://dc1'], caPem: 'x', baseDn: BASE }, factory({ dc1: { tlsError: true } }, []));
  await assert.rejects(tls.authenticate('a', 'b'), code('ldap.tls-untrusted'));
  // without a configured base DN the rootDSE read is the first network call; it must fail over too
  const viaRootDse = new DirectoryAuth({ urls: ['ldaps://dc1', 'ldaps://dc2'], caPem: null }, factory({ dc1: { failConnect: 'ECONNREFUSED' } }, []));
  assert.equal((await viaRootDse.authenticate('Administrator', 'pw')).dc, 'dc2');
});

test('empty passwords and control characters are refused before any network traffic', async () => {
  const log: string[] = [];
  const d = new DirectoryAuth({ urls: ['ldaps://dc1'], caPem: null }, factory({}, log));
  await assert.rejects(d.authenticate('Administrator', ''), code('auth.invalid-credentials'));
  await assert.rejects(d.authenticate('admin\u0000x', 'pw'), code('auth.invalid-credentials'));
  await assert.rejects(d.authenticate('   ', 'pw'), code('auth.invalid-credentials'));
  assert.deepEqual(log, []);
  assert.equal(normalizeUsername(' Müller '), 'Müller');
  assert.throws(() => new DirectoryAuth({ urls: [], caPem: null }), TypeError);
});
