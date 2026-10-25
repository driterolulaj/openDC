// SPDX-License-Identifier: AGPL-3.0-only
/** Second factor, tier-0 re-authentication and API tokens (SECURITY.md §4). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlatformError } from '@opendc/shared';
import { openDb } from '@opendc/shared/db';
import { base32Decode, base32Encode, hotp, totpStep, verifyTotp } from './mfa.ts';
import { apiMigrations } from './db.ts';
import { buildApi, type ApiDeps } from './server.ts';
import type { AuthenticatedUser } from './directory.ts';
import type { SessionUser } from './sessions.ts';
import type { TokenData } from './tokens.ts';

test('RFC 4226 HOTP vectors and base32 round trip', () => {
  const secret = Buffer.from('12345678901234567890');
  assert.deepEqual(
    [0, 1, 2, 3, 9].map((c) => hotp(secret, c)),
    ['755224', '287082', '359152', '969429', '520489'],
  );
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.deepEqual(base32Decode('mzxw 6ytb oi=='), Buffer.from('foobar'));
  const now = Date.UTC(2026, 9, 25, 12, 0, 0);
  const code = hotp(secret, totpStep(now));
  assert.equal(verifyTotp(secret, code, now), totpStep(now));
  assert.equal(verifyTotp(secret, code, now + 30_000), totpStep(now), 'one step of drift is accepted');
  assert.equal(verifyTotp(secret, code, now + 90_000), null);
  assert.equal(verifyTotp(secret, 'abcdef', now), null);
});

const DOM = 'S-1-5-21-9-9-9';
const admin: AuthenticatedUser = {
  sid: `${DOM}-500`,
  guid: '11111111-2222-3333-4444-555555555555',
  username: 'Administrator',
  displayName: null,
  upn: null,
  dn: 'CN=Administrator,CN=Users,DC=x,DC=test',
  domainSid: DOM,
  groupSids: [`${DOM}-512`],
  adminCount: 1,
  dc: 'dc1',
};
const ORIGIN = { origin: 'https://dc1:8443', host: 'dc1:8443' };

function fakeTotp() {
  const enrolled = new Set<string>();
  return {
    enrolled,
    store: {
      enrolled: async (sid: string) => enrolled.has(sid),
      begin: async () => 'SECRET',
      confirm: async (sid: string, code: string) => {
        if (code !== '123456') return null;
        enrolled.add(sid);
        return ['recovery1'];
      },
      check: async (_sid: string, code: string) => code === '654321',
      remove: async (sid: string) => {
        enrolled.delete(sid);
      },
    },
  };
}

function fakeTokens() {
  const items = new Map<string, TokenData>();
  return {
    create: async (u: SessionUser, o: { name: string; days: number; permissions: string[] | null }) => {
      const id = '00000000-0000-0000-0000-00000000000' + String(items.size + 1);
      items.set(id, {
        name: o.name,
        secretHash: '',
        user: { ...u },
        permissions: o.permissions,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      return { id, token: `odc_${id}_${'a'.repeat(43)}` };
    },
    verify: async (token: string) => {
      const id = token.split('_')[1] ?? '';
      const data = items.get(id);
      return data
        ? { id, dn: '', raw: '', schemaVersion: 1, rev: 1, updatedBy: { sid: '', name: '' }, updatedAt: '', data }
        : null;
    },
    listFor: async () => [],
    revoke: async () => true,
  };
}

async function api(extra: Partial<ApiDeps>) {
  const a = await buildApi({
    db: openDb(':memory:', apiMigrations),
    directory: {
      authenticate: async (u: string, p: string) => {
        if (u === 'Administrator' && p === 'pw') return admin;
        throw new PlatformError('auth.invalid-credentials');
      },
    },
    agent: null,
    nodeId: 'dc1',
    csrfKey: Buffer.alloc(32, 1),
    idleMinutes: 30,
    absoluteHours: 12,
    webDir: null,
    validateResponses: true,
    ...extra,
  });
  await a.app.ready();
  return a;
}

async function login(a: Awaited<ReturnType<typeof api>>, body: Record<string, string>) {
  const r = await a.app.inject({ method: 'POST', url: '/api/v1/session', headers: ORIGIN, payload: body });
  const cookie = r.cookies.find((c) => c.name === '__Host-opendc_sid');
  const json = r.json<{ csrfToken?: string; mfaSetupRequired?: boolean; code?: string }>();
  return {
    r,
    json,
    headers: { ...ORIGIN, cookie: `__Host-opendc_sid=${cookie?.value ?? ''}`, 'x-csrf-token': json.csrfToken ?? '' },
  };
}

test('a tier-0 user without a second factor must enrol before anything else', async () => {
  const totp = fakeTotp();
  const a = await api({ totp: totp.store, tokens: fakeTokens() });
  const s = await login(a, { username: 'Administrator', password: 'pw' });
  assert.equal(s.json.mfaSetupRequired, true);
  const blocked = await a.app.inject({ method: 'GET', url: '/api/v1/audit', headers: s.headers });
  assert.equal(blocked.json<{ code: string }>().code, 'auth.mfa-setup-required');
  assert.equal((await a.app.inject({ method: 'GET', url: '/api/v1/session', headers: s.headers })).statusCode, 200);
  assert.equal(
    (await a.app.inject({ method: 'POST', url: '/api/v1/session/totp/begin', headers: s.headers })).statusCode,
    200,
  );
  const bad = await a.app.inject({
    method: 'POST',
    url: '/api/v1/session/totp/confirm',
    headers: s.headers,
    payload: { code: '000000' },
  });
  assert.equal(bad.json<{ code: string }>().code, 'auth.totp-invalid');
  const ok = await a.app.inject({
    method: 'POST',
    url: '/api/v1/session/totp/confirm',
    headers: s.headers,
    payload: { code: '123456' },
  });
  assert.deepEqual(ok.json(), { recoveryCodes: ['recovery1'] });
  assert.equal((await a.app.inject({ method: 'GET', url: '/api/v1/audit', headers: s.headers })).statusCode, 200);

  // next login asks for the code
  const again = await login(a, { username: 'Administrator', password: 'pw' });
  assert.equal(again.json.code, 'auth.totp-required');
  const wrong = await login(a, { username: 'Administrator', password: 'pw', totp: '111111' });
  assert.equal(wrong.json.code, 'auth.totp-invalid');
  const right = await login(a, { username: 'Administrator', password: 'pw', totp: '654321' });
  assert.equal(right.r.statusCode, 200);
  assert.equal(right.json.mfaSetupRequired, false);
});

test('tier-0 actions need a sign-in younger than 5 minutes; re-authentication renews it', async () => {
  const totp = fakeTotp();
  totp.enrolled.add(admin.sid);
  const db = openDb(':memory:', apiMigrations);
  const a = await api({ db, totp: totp.store, tokens: fakeTokens() });
  const s = await login(a, { username: 'Administrator', password: 'pw', totp: '654321' });
  const tier0 = async () =>
    (
      await a.app.inject({
        method: 'POST',
        url: '/api/v1/rbac/roles',
        headers: s.headers,
        payload: { name: 'x', permissions: ['core.console.access'] },
      })
    ).json<{ code: string }>().code;
  // fresh sign-in: the tier-0 checks pass (the request then fails later: no directory in this test)
  assert.equal(await tier0(), 'directory.not-configured');
  db.run('UPDATE sessions SET auth_at = ?', [Date.now() - 6 * 60_000]);
  assert.equal(await tier0(), 'auth.reauth-required');
  const reauth = (body: Record<string, string>) =>
    a.app.inject({ method: 'POST', url: '/api/v1/session/reauth', headers: s.headers, payload: body });
  assert.equal((await reauth({ password: 'nope', totp: '654321' })).statusCode, 401);
  assert.equal((await reauth({ password: 'pw' })).json<{ code: string }>().code, 'auth.totp-required');
  assert.equal((await reauth({ password: 'pw', totp: '654321' })).statusCode, 200);
  assert.equal(await tier0(), 'directory.not-configured');
});

test('API tokens: bearer auth without cookie/CSRF/Origin, never tier 0, optionally fewer permissions', async () => {
  const totp = fakeTotp();
  totp.enrolled.add(admin.sid);
  const a = await api({ totp: totp.store, tokens: fakeTokens() });
  const s = await login(a, { username: 'Administrator', password: 'pw', totp: '654321' });
  const full = (
    await a.app.inject({ method: 'POST', url: '/api/v1/session/tokens', headers: s.headers, payload: { name: 'ci' } })
  ).json<{ token: string }>().token;
  const limited = (
    await a.app.inject({
      method: 'POST',
      url: '/api/v1/session/tokens',
      headers: s.headers,
      payload: { name: 'ro', permissions: ['core.console.access'] },
    })
  ).json<{ token: string }>().token;
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  assert.equal((await a.app.inject({ method: 'GET', url: '/api/v1/audit', headers: bearer(full) })).statusCode, 200);
  assert.equal((await a.app.inject({ method: 'GET', url: '/api/v1/audit', headers: bearer(limited) })).statusCode, 403);
  // tier-0 permission (domain.rbac.write) is never available to a token, even for a Domain Admin
  const t0 = await a.app.inject({
    method: 'POST',
    url: '/api/v1/rbac/roles',
    headers: bearer(full),
    payload: { name: 'x', permissions: ['core.console.access'] },
  });
  assert.equal(t0.statusCode, 403);
  const bad = await a.app.inject({ method: 'GET', url: '/api/v1/audit', headers: bearer('odc_nope') });
  assert.equal(bad.json<{ code: string }>().code, 'auth.token-invalid');
  // a token can't mint tokens or enrol factors
  const mint = await a.app.inject({
    method: 'POST',
    url: '/api/v1/session/tokens',
    headers: bearer(full),
    payload: { name: 'y' },
  });
  assert.equal(mint.statusCode, 403);
});
