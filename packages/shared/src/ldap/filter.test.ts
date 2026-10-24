// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  and,
  bitAnd,
  bitOr,
  contains,
  eq,
  filter,
  filterTree,
  ge,
  inChain,
  isLdapFilter,
  le,
  not,
  or,
  parseFilter,
  present,
  staticFilter,
  substring,
  FilterSyntaxError,
} from './filter.ts';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

test('builders produce escaped filters', () => {
  assert.equal(eq('sAMAccountName', 'a*b').text, '(sAMAccountName=a\\2ab)');
  assert.equal(ge('uSNChanged', 1234).text, '(uSNChanged>=1234)');
  assert.equal(le('pwdLastSet', 99n).text, '(pwdLastSet<=99)');
  assert.equal(present('mail').text, '(mail=*)');
  assert.equal(eq('objectGUID', Uint8Array.from([1, 0xff])).text, '(objectGUID=\\01\\ff)');
  assert.equal(String(eq('cn', 'x')), '(cn=x)');
  assert.ok(isLdapFilter(eq('cn', 'x')));
  assert.ok(!isLdapFilter('(cn=x)'));
});

test('and/or/not compose; single child collapses; empty throws', () => {
  const f = and(eq('objectClass', 'user'), or(eq('cn', 'a'), not(eq('cn', 'b'))));
  assert.equal(f.text, '(&(objectClass=user)(|(cn=a)(!(cn=b))))');
  assert.equal(and(eq('cn', 'x')).text, '(cn=x)');
  assert.throws(() => and(), TypeError);
  assert.throws(() => or(), TypeError);
});

test('substring and contains escape user text, including "*"', () => {
  assert.equal(substring('cn', { initial: 'ab', any: ['c*d'], final: 'e' }).text, '(cn=ab*c\\2ad*e)');
  assert.equal(substring('cn', {}).text, '(cn=*)');
  assert.equal(substring('cn', { initial: 'x' }).text, '(cn=x*)');
  assert.equal(contains('displayName', '(evil)').text, '(displayName=*\\28evil\\29*)');
});

test('matching-rule helpers validate their inputs', () => {
  assert.equal(bitAnd('userAccountControl', 2).text, '(userAccountControl:1.2.840.113556.1.4.803:=2)');
  assert.equal(bitOr('groupType', 6).text, '(groupType:1.2.840.113556.1.4.804:=6)');
  assert.equal(inChain('memberOf', 'CN=G(1),DC=x').text, '(memberOf:1.2.840.113556.1.4.1941:=CN=G\\281\\29,DC=x)');
  assert.throws(() => bitAnd('userAccountControl', -1), TypeError);
  assert.throws(() => bitOr('userAccountControl', 1.5), TypeError);
  assert.throws(() => eq('bad attr', 'x'), TypeError);
});

test('tagged template escapes values and embeds sub-filters', () => {
  const name = 'x)(objectClass=*';
  const sub = eq('cn', 'y');
  const f = filter`(&(objectClass=user)(sAMAccountName=${name})${sub})`;
  assert.equal(f.text, '(&(objectClass=user)(sAMAccountName=x\\29\\28objectClass=\\2a)(cn=y))');
  assert.equal(filter`(uSNChanged>=${42})`.text, '(uSNChanged>=42)');
  assert.throws(() => filter`(&(cn=a)`, FilterSyntaxError);
});

test('staticFilter accepts well-formed manifest filters only', () => {
  assert.equal(staticFilter('(objectClass=msDS-App-Configuration)').text, '(objectClass=msDS-App-Configuration)');
  for (const bad of ['objectClass=x', '(cn=a', '(cn=a))', '(cn=a(b)', '((cn=a))', '(&)', '(cn=a)(cn=b)', '(=x)', '(cn~x)']) {
    assert.throws(() => staticFilter(bad), TypeError, bad);
  }
});

test('parser: every filter type, byte-exact values', () => {
  assert.deepEqual(parseFilter('(cn=a\\28b)'), { type: 'eq', attr: 'cn', value: bytes('a(b') });
  assert.deepEqual(parseFilter('(cn~=x)'), { type: 'approx', attr: 'cn', value: bytes('x') });
  assert.deepEqual(parseFilter('(n>=1)'), { type: 'ge', attr: 'n', value: bytes('1') });
  assert.deepEqual(parseFilter('(n<=1)'), { type: 'le', attr: 'n', value: bytes('1') });
  assert.deepEqual(parseFilter('(cn=*)'), { type: 'present', attr: 'cn' });
  assert.deepEqual(parseFilter('(cn=Lu\\c4\\8di)'), { type: 'eq', attr: 'cn', value: bytes('Luči') });
  assert.deepEqual(parseFilter('(cn=Luči)'), { type: 'eq', attr: 'cn', value: bytes('Luči') });
  assert.deepEqual(parseFilter('(cn=😀)'), { type: 'eq', attr: 'cn', value: bytes('😀') });
  assert.deepEqual(parseFilter('(objectGUID=\\ff\\00)'), { type: 'eq', attr: 'objectGUID', value: Uint8Array.from([0xff, 0]) });
  assert.deepEqual(parseFilter('(cn=a*b*c)'), {
    type: 'substring',
    attr: 'cn',
    initial: bytes('a'),
    any: [bytes('b')],
    final: bytes('c'),
  });
  assert.deepEqual(parseFilter('(cn=*b*)'), { type: 'substring', attr: 'cn', any: [bytes('b')] });
  assert.deepEqual(parseFilter('(uac:1.2.840.113556.1.4.803:=2)'), {
    type: 'ext',
    attr: 'uac',
    rule: '1.2.840.113556.1.4.803',
    dnAttributes: false,
    value: bytes('2'),
  });
  assert.deepEqual(parseFilter('(:dn:2.5.13.5:=x)'), { type: 'ext', rule: '2.5.13.5', dnAttributes: true, value: bytes('x') });
  assert.deepEqual(parseFilter('(cn:dn:=x)'), { type: 'ext', attr: 'cn', dnAttributes: true, value: bytes('x') });
  assert.deepEqual(parseFilter('(!(cn=a))'), { type: 'not', child: { type: 'eq', attr: 'cn', value: bytes('a') } });
  assert.deepEqual(filterTree(and(eq('a', '1'), eq('b', '2'))), {
    type: 'and',
    children: [
      { type: 'eq', attr: 'a', value: bytes('1') },
      { type: 'eq', attr: 'b', value: bytes('2') },
    ],
  });
});

test('parser rejects malformed input with a position', () => {
  for (const bad of [
    '',
    'cn=a',
    '(cn=a',
    '(cn=a\\zz)',
    '(cn=a\\2)',
    '(cn=(a)',
    '(cn=a**b)',
    '(:=x)',
    '(cn:=x',
    '(cn:rule=x)',
    '(cn>x)',
    '(1bad=x)',
    '(cn=a) ',
    '(|)',
  ]) {
    assert.throws(() => parseFilter(bad), FilterSyntaxError, JSON.stringify(bad));
  }
  assert.throws(() => parseFilter('(cn=a'), /position 5/);
});
