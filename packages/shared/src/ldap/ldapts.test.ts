// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BerWriter } from 'ldapts';
import { and, bitAnd, eq, ge, le, not, or, present, substring, filter, staticFilter } from './filter.ts';
import { ldaptsFilter, toLdaptsFilter } from './ldapts.ts';
import { guidToBytes } from './ids.ts';

/** Encodes a library filter to BER, i.e. exactly what goes over the wire. */
function wire(f: ReturnType<typeof ldaptsFilter>): Buffer {
  const w = new BerWriter();
  f.write(w);
  return w.buffer;
}

test('non-ASCII equality values reach the wire as their UTF-8 bytes', () => {
  const b = wire(ldaptsFilter(eq('cn', 'Lučić')));
  assert.ok(b.includes(Buffer.from('Lučić', 'utf8')));
  // the library's own string parser would have sent Latin-1 mojibake instead
  assert.ok(!b.includes(Buffer.from('LuÄ\u008di', 'utf8')));
});

test('binary objectGUID equality is byte-exact', () => {
  const bytes = guidToBytes('04030201-0605-0807-090a-0b0c0d0e0f10');
  const b = wire(ldaptsFilter(eq('objectGUID', bytes)));
  assert.ok(b.includes(Buffer.from(bytes)));
});

test('every filter type converts and stringifies like the input', () => {
  const f = and(
    eq('objectClass', 'user'),
    or(present('mail'), not(eq('cn', 'x'))),
    ge('uSNChanged', 10),
    le('pwdLastSet', 5),
    substring('cn', { initial: 'a', any: ['b'], final: 'c' }),
    bitAnd('userAccountControl', 2),
    filter`(cn~=${'jon'})`,
    staticFilter('(:dn:2.5.13.5:=x)'),
  );
  const lib = ldaptsFilter(f);
  // ldapts prints Buffer (equality) values hex-escaped; decode them before comparing
  assert.equal(lib.toString().replace(/\\([0-9a-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), f.text);
  assert.throws(() => toLdaptsFilter({ type: 'ge', attr: 'x', value: Uint8Array.from([0xff]) }), /not valid UTF-8/);
});
