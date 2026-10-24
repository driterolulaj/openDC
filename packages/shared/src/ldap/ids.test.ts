// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  guidBase,
  guidFilterValue,
  guidFromBytes,
  guidToBytes,
  isGuid,
  isSid,
  ridOf,
  sidBase,
  sidFromBytes,
  sidToBytes,
} from './ids.ts';

const GUID_BYTES = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

test('objectGUID uses the mixed-endian AD layout', () => {
  assert.equal(guidFromBytes(GUID_BYTES), '04030201-0605-0807-090a-0b0c0d0e0f10');
  assert.deepEqual(guidToBytes('04030201-0605-0807-090a-0b0c0d0e0f10'), GUID_BYTES);
  assert.equal(
    guidFilterValue('04030201-0605-0807-090a-0b0c0d0e0f10'),
    '\\01\\02\\03\\04\\05\\06\\07\\08\\09\\0a\\0b\\0c\\0d\\0e\\0f\\10',
  );
  assert.equal(guidBase('04030201-0605-0807-090A-0B0C0D0E0F10'), '<GUID=04030201-0605-0807-090a-0b0c0d0e0f10>');
  assert.throws(() => guidFromBytes(new Uint8Array(15)), TypeError);
  assert.throws(() => guidToBytes('nope'), TypeError);
  assert.throws(() => guidBase('x)(cn=*'), TypeError);
  assert.ok(isGuid('04030201-0605-0807-090a-0b0c0d0e0f10'));
  assert.ok(!isGuid('04030201-0605-0807-090a-0b0c0d0e0f1'));
});

test('objectSid binary round trip (domain admins of a real lab domain)', () => {
  const sid = 'S-1-5-21-1004336348-1177238915-682003330-512';
  const b = sidToBytes(sid);
  assert.equal(b.length, 8 + 5 * 4);
  assert.equal(b[0], 1);
  assert.equal(b[1], 5);
  assert.equal(b[7], 5);
  assert.equal(sidFromBytes(b), sid);
  assert.equal(sidFromBytes(sidToBytes('S-1-5-32-544')), 'S-1-5-32-544');
  assert.equal(ridOf(sid), 512);
  assert.equal(sidBase(sid), `<SID=${sid}>`);
  assert.ok(isSid(sid));
  assert.ok(!isSid('S-1-5'));
  assert.throws(() => sidFromBytes(new Uint8Array(4)), TypeError);
  assert.throws(() => sidFromBytes(Uint8Array.from([1, 2, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0])), TypeError);
  assert.throws(() => sidToBytes('S-x'), TypeError);
  assert.throws(() => sidBase('S-1-5-21)(cn=*'), TypeError);
  assert.throws(() => ridOf('nope'), TypeError);
});
