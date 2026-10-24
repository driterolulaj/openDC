// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  asDn,
  buildDn,
  childDn,
  dnEquals,
  dnFromDomain,
  domainFromDn,
  DnSyntaxError,
  formatDn,
  isWithin,
  normalizeDn,
  parentDn,
  parseDn,
} from './dn.ts';

test('parseDn: simple, escaped, hex, multi-valued, spaces', () => {
  assert.deepEqual(parseDn('CN=Users,DC=example,DC=com'), [
    [{ type: 'CN', value: 'Users' }],
    [{ type: 'DC', value: 'example' }],
    [{ type: 'DC', value: 'com' }],
  ]);
  assert.deepEqual(parseDn('CN=Sue\\, Grabbit and Runn,DC=x'), [[{ type: 'CN', value: 'Sue, Grabbit and Runn' }], [{ type: 'DC', value: 'x' }]]);
  assert.deepEqual(parseDn('CN=Lu\\C4\\8Di\\C4\\87'), [[{ type: 'CN', value: 'Lučić' }]]);
  assert.deepEqual(parseDn('1.3.6.1.4.1.1466.0=#04024869'), [[{ type: '1.3.6.1.4.1.1466.0', value: '04024869', hex: true }]]);
  assert.deepEqual(parseDn('OU=Sales+CN=J. Smith,DC=x'), [
    [
      { type: 'OU', value: 'Sales' },
      { type: 'CN', value: 'J. Smith' },
    ],
    [{ type: 'DC', value: 'x' }],
  ]);
  assert.deepEqual(parseDn('cn = a , dc = b'), [[{ type: 'cn', value: 'a' }], [{ type: 'dc', value: 'b' }]]);
  assert.deepEqual(parseDn('CN=\\ x\\ ,DC=y'), [[{ type: 'CN', value: ' x ' }], [{ type: 'DC', value: 'y' }]]);
  assert.deepEqual(parseDn('CN=a=b'), [[{ type: 'CN', value: 'a=b' }]]);
  assert.deepEqual(parseDn('CN=a;DC=b'), [[{ type: 'CN', value: 'a' }], [{ type: 'DC', value: 'b' }]]);
  assert.deepEqual(parseDn('CN='), [[{ type: 'CN', value: '' }]]);
  assert.deepEqual(parseDn(''), []);
  assert.deepEqual(parseDn('   '), []);
});

test('parseDn rejects malformed DNs', () => {
  for (const bad of ['CN', '=x', 'CN=a,', 'CN=a\\', 'C N=a', 'CN=a"b', 'CN=<x>', 'CN=#zz', 'CN=#0', 'CN=\\ff', '1cn=a', 'CN=a,,DC=b']) {
    assert.throws(() => parseDn(bad), DnSyntaxError, bad);
  }
});

test('formatDn/buildDn/childDn escape values and round-trip', () => {
  const d = buildDn(['CN', 'a,b+c'], ['OU', ' Staff '], ['DC', 'example'], ['DC', 'com']);
  assert.equal(d, 'CN=a\\,b\\+c,OU=\\ Staff\\ ,DC=example,DC=com');
  assert.equal(formatDn(parseDn(d)), d);
  assert.equal(childDn('OU=Staff,DC=x', 'CN', 'Müller, Hans'), 'CN=Müller\\, Hans,OU=Staff,DC=x');
  assert.equal(formatDn(parseDn('X=#0102')), 'X=#0102');
  assert.equal(asDn('cn=a , dc=b'), 'cn=a,dc=b');
  assert.throws(() => buildDn(['C N', 'x']), TypeError);
  assert.throws(() => childDn('DC=x', 'bad type', 'y'), TypeError);
});

test('normalisation is case-insensitive, NFC and orders multi-valued RDNs', () => {
  assert.equal(normalizeDn('CN=Users,DC=Example,DC=COM'), 'cn=users,dc=example,dc=com');
  assert.equal(normalizeDn('cn=b+ou=a'), normalizeDn('OU=A+CN=B'));
  assert.ok(dnEquals('CN=Müller,DC=x', 'cn=MÜLLER,dc=X'));
  assert.ok(dnEquals('CN=a\\,b,DC=x', 'cn=a\\2cb,dc=x'));
  assert.ok(!dnEquals('CN=a,DC=x', 'CN=a,DC=y'));
  assert.equal(normalizeDn('X=#0A0B'), 'x=#0a0b');
});

test('isWithin compares RDN sequences, not string suffixes', () => {
  const scope = 'OU=Staff,DC=example,DC=com';
  assert.ok(isWithin('CN=alice,OU=Staff,DC=example,DC=com', scope));
  assert.ok(isWithin('cn=alice,ou=STAFF,dc=Example,dc=com', scope));
  assert.ok(isWithin(scope, scope));
  assert.ok(isWithin('CN=x,OU=Sub,OU=Staff,DC=example,DC=com', scope));
  assert.ok(!isWithin('CN=alice,OU=Staff2,DC=example,DC=com', scope));
  assert.ok(!isWithin('CN=alice,OU=MyStaff,DC=example,DC=com', scope));
  // An escaped comma must not create a fake OU boundary.
  assert.ok(!isWithin('CN=x\\,OU=Staff,DC=example,DC=com', 'OU=Staff,DC=example,DC=com,DC=evil'));
  assert.ok(!isWithin('OU=x\\,OU=Staff,DC=other,DC=com', scope));
  assert.ok(!isWithin('DC=example,DC=com', scope));
});

test('parentDn, domain conversions', () => {
  assert.equal(parentDn('CN=a,OU=b,DC=c'), 'OU=b,DC=c');
  assert.equal(parentDn('DC=c'), null);
  assert.equal(domainFromDn('CN=x,DC=standard,DC=opendc,DC=test'), 'standard.opendc.test');
  assert.equal(dnFromDomain('standard.opendc.test'), 'DC=standard,DC=opendc,DC=test');
  assert.throws(() => dnFromDomain('...'), TypeError);
});
