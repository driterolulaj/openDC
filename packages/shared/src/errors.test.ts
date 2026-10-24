// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorCodes, errorResources, httpStatus, interpolate, isErrorCode, PlatformError, renderError } from './errors.ts';

test('every error has en and de texts with the same placeholders', () => {
  const res = errorResources();
  const placeholders = (s: string): string[] => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? '').sort();
  for (const code of errorCodes) {
    const en = res.en[code];
    const de = res.de[code];
    assert.ok(en && de, code);
    assert.ok(en.message && en.fix && de.message && de.fix, code);
    assert.deepEqual(placeholders(de.message + de.fix), placeholders(en.message + en.fix), code);
    assert.ok(httpStatus(code) >= 400 && httpStatus(code) < 600, code);
  }
});

test('PlatformError renders message and fix, round-trips through its wire body', () => {
  const e = new PlatformError('ldap.unreachable', { host: 'dc1', reason: 'ECONNREFUSED', port: 636 });
  assert.equal(e.message, 'Domain controller dc1 is not reachable (ECONNREFUSED).');
  assert.match(e.fix, /port 636/);
  assert.equal(e.httpStatus, 503);
  const back = PlatformError.fromBody(e.toBody());
  assert.equal(back.code, 'ldap.unreachable');
  assert.equal(back.message, e.message);
  assert.equal(PlatformError.fromBody({ ...e.toBody(), code: 'nope' as never }).code, 'internal');
  assert.equal(renderError('auth.forbidden', { permission: 'core.x' }, 'de').message, 'Für diese Aktion ist die Berechtigung core.x erforderlich.');
});

test('interpolate keeps unknown placeholders and isErrorCode guards', () => {
  assert.equal(interpolate('a {{x}} {{ y }} {{z}}', { x: 1, y: 'b' }), 'a 1 b {{z}}');
  assert.ok(isErrorCode('internal'));
  assert.ok(!isErrorCode('constructor'));
  assert.ok(!isErrorCode(42));
});
