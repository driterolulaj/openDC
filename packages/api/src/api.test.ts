// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformError } from '@opendc/shared';
import { openDb } from '@opendc/shared/db';
import { apiMigrations } from './db.ts';
import { buildApi, type ApiDeps } from './server.ts';
import { buildOpenApi } from './http/openapi.ts';
import type { AuthenticatedUser } from './directory.ts';

const DOM = 'S-1-5-21-100-200-300';
const users: Record<string, { password: string; user: AuthenticatedUser }> = {
  admin: {
    password: 'Secret-1',
    user: {
      sid: `${DOM}-500`,
      guid: '11111111-2222-3333-4444-555555555555',
      username: 'Administrator',
      displayName: 'Admin',
      upn: null,
      dn: 'CN=Administrator,CN=Users,DC=small,DC=opendc,DC=test',
      domainSid: DOM,
      groupSids: [`${DOM}-512`, `${DOM}-513`],
      adminCount: 1,
      dc: 'sdc1',
    },
  },
  alice: {
    password: 'Alice-1',
    user: {
      sid: `${DOM}-1105`,
      guid: '21111111-2222-3333-4444-555555555555',
      username: 'alice',
      displayName: 'Alice',
      upn: null,
      dn: 'CN=alice,CN=Users,DC=small,DC=opendc,DC=test',
      domainSid: DOM,
      groupSids: [`${DOM}-513`],
      adminCount: null,
      dc: 'sdc1',
    },
  },
};

const directory = {
  authenticate: async (u: string, p: string): Promise<AuthenticatedUser> => {
    const e = users[u];
    if (!e || e.password !== p || p === '') throw new PlatformError('auth.invalid-credentials');
    return e.user;
  },
};

const agent = {
  call: (async (op: string) => {
    if (op === 'system.info') {
      return {
        hostname: 'sdc1',
        fqdn: 'sdc1.small.opendc.test',
        kernel: '6.12',
        uptimeSec: 10,
        memTotal: 4e9,
        cpus: 2,
        os: { id: 'debian', versionId: '13', prettyName: 'Debian 13', adapter: 'debian' },
        role: 'primary-dc',
        agentVersion: '0.1.0-dev',
      };
    }
    if (op === 'samba.version') return { raw: 'Version 4.22.11', major: 4, minor: 22, patch: 11 };
    throw new Error(op);
  }) as ApiDeps['agent'] extends infer A ? (A extends { call: infer C } ? C : never) : never,
};

async function api(extra: Partial<ApiDeps> = {}) {
  const db = openDb(':memory:', apiMigrations);
  const a = await buildApi({
    db,
    directory,
    agent,
    nodeId: 'sdc1.small.opendc.test',
    csrfKey: Buffer.alloc(32, 3),
    idleMinutes: 30,
    absoluteHours: 12,
    webDir: null,
    validateResponses: true,
    // the second-factor policy has its own tests (mfa.test.ts)
    requireTotpForTier0: false,
    totp: {
      enrolled: async () => false,
      begin: async () => '',
      confirm: async () => null,
      check: async () => false,
      remove: async () => undefined,
    },
    ...extra,
  });
  await a.app.ready();
  return a;
}

const ORIGIN = { origin: 'https://sdc1:8443', host: 'sdc1:8443' };

async function login(a: Awaited<ReturnType<typeof api>>, username: string, password: string) {
  const r = await a.app.inject({
    method: 'POST',
    url: '/api/v1/session',
    headers: ORIGIN,
    payload: { username, password },
  });
  const cookie = r.cookies.find((c) => c.name === '__Host-opendc_sid');
  return { r, cookie, body: r.json<{ csrfToken: string; user: { username: string } }>() };
}

test('login: success sets a hardened cookie, returns a CSRF token and is audited', async () => {
  const a = await api();
  const { r, cookie, body } = await login(a, 'admin', 'Secret-1');
  assert.equal(r.statusCode, 200);
  assert.equal(body.user.username, 'Administrator');
  assert.ok(cookie?.httpOnly && cookie.secure && cookie.sameSite === 'Strict' && cookie.path === '/');
  assert.match(body.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  const audit = a.audit.list();
  assert.equal(audit[0]?.action, 'session.login');
  assert.equal(audit[0]?.result, 'success');
  assert.equal(audit[0]?.actorSid, `${DOM}-500`);
  // security headers
  assert.match(String(r.headers['content-security-policy']), /script-src 'self'/);
  assert.match(String(r.headers['strict-transport-security']), /max-age=31536000/);
});

test('login failures are audited without the password; empty passwords never reach the directory', async () => {
  const a = await api();
  const bad = await login(a, 'admin', 'wrong');
  assert.equal(bad.r.statusCode, 401);
  assert.equal(bad.r.json<{ code: string }>().code, 'auth.invalid-credentials');
  const empty = await a.app.inject({
    method: 'POST',
    url: '/api/v1/session',
    headers: ORIGIN,
    payload: { username: 'admin', password: '' },
  });
  assert.equal(empty.statusCode, 400);
  const entries = a.audit.list();
  assert.equal(entries[0]?.result, 'failure');
  assert.ok(!JSON.stringify(entries).includes('wrong'));
});

test('a user without console access is refused at login (and that is audited)', async () => {
  const a = await api();
  const { r } = await login(a, 'alice', 'Alice-1');
  assert.equal(r.statusCode, 403);
  assert.equal(r.json<{ code: string }>().code, 'auth.forbidden');
  assert.equal(a.audit.list()[0]?.result, 'denied');
});

test('login requires a same-origin request (login CSRF)', async () => {
  const a = await api();
  for (const headers of [
    { host: 'sdc1:8443' },
    { origin: 'https://evil.example', host: 'sdc1:8443' },
    { origin: 'not a url', host: 'sdc1:8443' },
  ]) {
    const r = await a.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers,
      payload: { username: 'admin', password: 'Secret-1' },
    });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json<{ code: string }>().code, 'auth.csrf');
  }
});

test('session, permissions, node info; CSRF required for state changes; logout', async () => {
  const a = await api();
  const { cookie, body } = await login(a, 'admin', 'Secret-1');
  const cookies = { '__Host-opendc_sid': cookie?.value ?? '' };
  const s = await a.app.inject({ method: 'GET', url: '/api/v1/session', cookies });
  assert.equal(s.statusCode, 200);
  assert.equal(s.json<{ csrfToken: string }>().csrfToken, body.csrfToken);
  const perms = await a.app.inject({ method: 'GET', url: '/api/v1/session/permissions', cookies });
  assert.ok(
    perms.json<{ permissions: { permission: string }[] }>().permissions.some((p) => p.permission === 'core.audit.read'),
  );
  const node = await a.app.inject({ method: 'GET', url: '/api/v1/node', cookies });
  assert.equal(node.json<{ samba: string }>().samba, '4.22.11');

  const noCsrf = await a.app.inject({ method: 'DELETE', url: '/api/v1/session', cookies, headers: ORIGIN });
  assert.equal(noCsrf.statusCode, 403);
  const wrongCsrf = await a.app.inject({
    method: 'DELETE',
    url: '/api/v1/session',
    cookies,
    headers: { ...ORIGIN, 'x-csrf-token': 'x'.repeat(43) },
  });
  assert.equal(wrongCsrf.statusCode, 403);
  const out = await a.app.inject({
    method: 'DELETE',
    url: '/api/v1/session',
    cookies,
    headers: { ...ORIGIN, 'x-csrf-token': body.csrfToken },
  });
  assert.equal(out.statusCode, 200);
  assert.equal((await a.app.inject({ method: 'GET', url: '/api/v1/session', cookies })).statusCode, 401);
});

test('no session -> 401; insufficient permission -> 403 and an audited denial', async () => {
  const a = await api();
  assert.equal((await a.app.inject({ method: 'GET', url: '/api/v1/node' })).statusCode, 401);
  // Give alice console access through an extra directory role so she can log in, but nothing else.
  const b = await api({
    roles: [{ id: 'viewer', name: 'Viewer', permissions: ['core.console.access'], tier0: false, builtin: false }],
    assignments: [{ id: 'a1', roleId: 'viewer', principals: [`${DOM}-513`], scopes: [{ kind: 'domain' }] }],
  });
  const { cookie } = await login(b, 'alice', 'Alice-1');
  const r = await b.app.inject({
    method: 'GET',
    url: '/api/v1/audit',
    cookies: { '__Host-opendc_sid': cookie?.value ?? '' },
  });
  assert.equal(r.statusCode, 403);
  assert.equal(r.json<{ code: string; params: { permission: string } }>().params.permission, 'core.audit.read');
  const denials = b.audit.list().filter((e) => e.result === 'denied');
  assert.equal(denials[0]?.action, 'access.core.audit.read');
});

test('audit list and the hash chain', async () => {
  const a = await api();
  const { cookie } = await login(a, 'admin', 'Secret-1');
  await login(a, 'admin', 'nope');
  const r = await a.app.inject({
    method: 'GET',
    url: '/api/v1/audit?limit=10',
    cookies: { '__Host-opendc_sid': cookie?.value ?? '' },
  });
  const entries = r.json<{ entries: { action: string; result: string; after: unknown }[] }>().entries;
  assert.equal(entries.length, 2);
  // newest first; what happened is part of the entry
  assert.deepEqual(entries[0]?.after, { reason: 'auth.invalid-credentials' });
  assert.equal(a.audit.verify(), 2);
  const bad = await a.app.inject({
    method: 'GET',
    url: '/api/v1/audit?limit=9999',
    cookies: { '__Host-opendc_sid': cookie?.value ?? '' },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json<{ code: string }>().code, 'validation.invalid');
});

test('jobs: start, poll, stream events over SSE', async () => {
  const a = await api();
  const { cookie, body } = await login(a, 'admin', 'Secret-1');
  const cookies = { '__Host-opendc_sid': cookie?.value ?? '' };
  const start = await a.app.inject({
    method: 'POST',
    url: '/api/v1/jobs/node-info',
    cookies,
    headers: { ...ORIGIN, 'x-csrf-token': body.csrfToken },
  });
  assert.equal(start.statusCode, 202);
  const id = start.json<{ id: string }>().id;
  for (let i = 0; i < 50 && a.jobs.get(id)?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
  const j = await a.app.inject({ method: 'GET', url: `/api/v1/jobs/${id}`, cookies });
  assert.equal(j.json<{ status: string; result: { samba: string } }>().result.samba, 'Version 4.22.11');
  const sse = await a.app.inject({ method: 'GET', url: `/api/v1/jobs/${id}/events`, cookies });
  assert.equal(sse.headers['content-type'], 'text/event-stream');
  assert.match(sse.body, /event: progress\ndata: \{"step":"system.info","percent":10\}/);
  assert.match(sse.body, /event: done\n/);
  const resumed = await a.app.inject({
    method: 'GET',
    url: `/api/v1/jobs/${id}/events`,
    cookies,
    headers: { 'last-event-id': '3' },
  });
  assert.doesNotMatch(resumed.body, /system.info/);
  assert.equal(
    (await a.app.inject({ method: 'GET', url: `/api/v1/jobs/${crypto.randomUUID()}`, cookies })).statusCode,
    404,
  );
  assert.equal((await a.app.inject({ method: 'GET', url: '/api/v1/jobs/not-a-uuid', cookies })).statusCode, 400);
});

test('the audit table is append-only', async () => {
  const db = openDb(':memory:', apiMigrations);
  const a = await buildApi({
    db,
    directory,
    agent,
    nodeId: 'n',
    csrfKey: Buffer.alloc(32),
    idleMinutes: 30,
    absoluteHours: 12,
    webDir: null,
    validateResponses: true,
  });
  a.audit.append({
    actor: 'x',
    action: 'test',
    result: 'success',
    after: { password: 'p', nested: { apiToken: 't', ok: 1 } },
  });
  assert.throws(() => db.run("UPDATE audit SET actor = 'y'"), /append-only/);
  assert.throws(() => db.run('DELETE FROM audit'), /append-only/);
  const after = a.audit.list()[0]?.after as Record<string, unknown>;
  assert.deepEqual(after, { password: '[redacted]', nested: { apiToken: '[redacted]', ok: 1 } });
  // Simulate an attacker who drops the triggers and edits a row: verify() catches it.
  db.exec('DROP TRIGGER audit_no_update');
  db.run("UPDATE audit SET actor = 'mallory'");
  assert.throws(
    () => a.audit.verify(),
    (e: unknown) => e instanceof PlatformError && e.code === 'audit.chain-broken',
  );
});

test('OpenAPI lists every API route with its auth declaration', async () => {
  const a = await api();
  const doc = buildOpenApi(a.routes.routes) as {
    paths: Record<string, Record<string, { operationId: string; 'x-opendc-auth': unknown }>>;
  };
  assert.equal(doc.paths['/api/v1/session']?.post?.operationId, 'login');
  assert.deepEqual(doc.paths['/api/v1/audit']?.get?.['x-opendc-auth'], { permission: 'core.audit.read' });
  assert.ok(doc.paths['/api/v1/jobs/{id}/events']);
});

test('routes registered without an auth declaration stop the server', async () => {
  const a = await buildApi({
    db: openDb(':memory:', apiMigrations),
    directory,
    agent,
    nodeId: 'n',
    csrfKey: Buffer.alloc(32),
    idleMinutes: 30,
    absoluteHours: 12,
    webDir: null,
    validateResponses: true,
  });
  assert.throws(() => a.app.get('/sneaky', async () => 'x'), /without an authorization declaration/);
});

test('static console: files, SPA fallback, no traversal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendc-web-'));
  try {
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>OpenDC</title>');
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(join(dirname(dir), 'secret.txt'), 'nope');
    const a = await api({ webDir: dir });
    const root = await a.app.inject({ method: 'GET', url: '/' });
    assert.equal(root.statusCode, 302);
    assert.equal(root.headers.location, '/console/');
    const js = await a.app.inject({ method: 'GET', url: '/console/assets/app.js' });
    assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.match(String(js.headers['cache-control']), /immutable/);
    const spa = await a.app.inject({ method: 'GET', url: '/console/users/alice' });
    assert.match(spa.body, /<title>OpenDC<\/title>/);
    assert.equal((await a.app.inject({ method: 'GET', url: '/console/assets/missing.js' })).statusCode, 404);
    assert.equal((await a.app.inject({ method: 'GET', url: '/console/..%2f..%2fsecret.txt' })).statusCode, 404);
    assert.equal(
      (await a.app.inject({ method: 'GET', url: '/nothing' })).json<{ code: string }>().code,
      'request.not-found',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function dirname(p: string): string {
  return join(p, '..');
}

test('watcher status and metrics; audit entries from the watcher inbox', async () => {
  const { mkdtempSync, writeFileSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const join = (...p: string[]) => path.join(...p);
  const { ingestInbox } = await import('./audit-inbox.ts');
  const dir = mkdtempSync(join(tmpdir(), 'odc-watch-'));
  const statusPath = join(dir, 'status.json');
  const a = await api({ watcherStatusPath: statusPath });
  const { cookie } = await login(a, 'admin', 'Secret-1');
  const get = (url: string) =>
    a.app.inject({ method: 'GET', url, cookies: { '__Host-opendc_sid': cookie?.value ?? '' } });

  assert.deepEqual((await get('/api/v1/watcher')).json(), { status: null });
  assert.equal((await get('/api/v1/watcher/metrics')).statusCode, 503);
  const status = {
    updatedAt: '2026-10-25T10:00:00.000Z',
    dc: 'dc1.example.test',
    leader: true,
    connected: true,
    lastError: null,
    passes: 7,
    handlers: [
      {
        module: 'domain',
        id: 'posix-ids',
        state: 'quarantined',
        dc: 'CN=NTDS Settings,CN=DC1',
        lastSuccessAt: null,
        lastError: 'boom',
        failures: 5,
        events: 3,
        resyncs: 2,
      },
    ],
  };
  writeFileSync(statusPath, JSON.stringify(status));
  assert.equal((await get('/api/v1/watcher')).json<{ status: { passes: number } }>().status.passes, 7);
  const m = await get('/api/v1/watcher/metrics');
  assert.equal(m.statusCode, 200);
  assert.match(m.body, /opendc_watcher_resyncs_total\{handler="posix-ids"\} 2/);
  assert.match(m.body, /opendc_watcher_handler_quarantined\{handler="posix-ids"\} 1/);

  const inbox = join(dir, 'inbox');
  (await import('node:fs')).mkdirSync(inbox);
  const entry = {
    ts: '2026-10-25T10:00:00.000Z',
    actor: 'opendc-watcher@dc1',
    action: 'directory.posix-ids.fill',
    result: 'success',
    targetGuid: '6f9619ff-8b86-d011-b42d-00c04fc964ff',
    targetDn: 'CN=bob,CN=Users,DC=example,DC=test',
    after: { uidNumber: 101234 },
  };
  writeFileSync(join(inbox, '000000000000001-a.json'), JSON.stringify(entry));
  writeFileSync(join(inbox, '.000000000000002-b.json'), JSON.stringify(entry)); // still being written
  writeFileSync(join(inbox, '000000000000003-c.json'), JSON.stringify({ ...entry, actor: 'mallory' }));
  writeFileSync(join(inbox, '000000000000004-d.json'), 'x'.repeat(70 * 1024));
  const warnings: string[] = [];
  assert.equal(
    ingestInbox(inbox, a.audit, (_l, msg, extra) => warnings.push(`${msg} ${String(extra.file)}`)),
    1,
  );
  assert.deepEqual(readdirSync(inbox), ['.000000000000002-b.json']);
  assert.equal(warnings.length, 2);
  const last = a.audit.list({ limit: 1 })[0];
  assert.equal(last?.actor, 'opendc-watcher@dc1');
  assert.deepEqual(last?.after, { uidNumber: 101234 });
  assert.equal(
    ingestInbox(join(dir, 'missing'), a.audit, () => undefined),
    0,
  );
});

test('registry policies may only set policy-settable keys with valid values', async () => {
  const { validateRegistrySettings } = await import('./routes/policies.ts');
  validateRegistrySettings({ 'core.session.requireTotpForTier0': false });
  assert.throws(() => validateRegistrySettings({ 'core.nope': 1 }), /unknown registry key/);
  assert.throws(() => validateRegistrySettings({ 'core.api.listenPort': 9443 }), /can't be set by a domain policy/);
  assert.throws(() => validateRegistrySettings({ 'core.session.requireTotpForTier0': 'yes' }), /invalid value/);
});
