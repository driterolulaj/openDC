// SPDX-License-Identifier: AGPL-3.0-only
/** Setup wizard API: token gating (verified by the agent), typed confirmation, job flow, restart, audit. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { PlatformError } from '@opendc/shared';
import { openDb } from '@opendc/shared/db';
import { verifyConfirmation } from '@opendc/shared/agent';
import { apiMigrations } from './db.ts';
import { buildApi, type ApiDeps } from './server.ts';

const TOKEN = 'abcde-fghjk-mnpqr-stuvw-xyz23';
const KEY = Buffer.alloc(32, 7);
const ORIGIN = { origin: 'https://dc1:8443', host: 'dc1:8443' };

interface Call {
  op: string;
  args: unknown;
  opts: { setupToken?: string; confirmation?: string; onProgress?: (p: { step: string; percent?: number }) => void };
}

function fakeAgent(state: { provisioned: boolean }) {
  const calls: Call[] = [];
  const call = async (op: string, args: unknown, opts: Call['opts']): Promise<unknown> => {
    calls.push({ op, args, opts });
    const valid = opts.setupToken === TOKEN && !state.provisioned;
    if (op === 'setup.status') {
      return {
        provisioned: state.provisioned,
        role: state.provisioned ? 'primary-dc' : null,
        domain: state.provisioned ? 'example.com' : null,
        tokenValid: opts.setupToken ? valid : null,
        hostname: 'dc1',
        fqdn: 'dc1.example.com',
        os: 'Debian 13',
        addresses: [{ iface: 'eth0', address: '10.0.0.11', prefix: 24, dynamic: false }],
        nameservers: ['1.1.1.1'],
      };
    }
    if (!valid) throw new PlatformError('setup.token-invalid');
    if (op === 'setup.preflight') return { checks: [{ id: 'hostname', status: 'pass', params: {} }], ok: true };
    if (op === 'samba.provision') {
      // the agent verifies the confirmation over the exact arguments
      const check = verifyConfirmation(KEY, opts.confirmation ?? '', { op, args, actor: 'setup' });
      if (!check.ok) throw new PlatformError('agent.confirmation-invalid', { op, ttlSec: 120 });
      opts.onProgress?.({ step: 'provision', percent: 45 });
      state.provisioned = true;
      return {
        domain: 'example.com',
        realm: 'EXAMPLE.COM',
        domainDn: 'DC=example,DC=com',
        domainSid: 'S-1-5-21-1-2-3',
        dcFqdn: 'dc1.example.com',
        serviceAccounts: [{ name: 'opendc-svc-dc1', sam: 'odcs-dc1', guid: 'g' }],
      };
    }
    throw new Error(op);
  };
  return { calls, agent: { call } as unknown as NonNullable<ApiDeps['agent']> };
}

async function setupApi(state = { provisioned: false }) {
  const fake = fakeAgent(state);
  let restarts = 0;
  const a = await buildApi({
    db: openDb(':memory:', apiMigrations),
    directory: { authenticate: () => Promise.reject(new PlatformError('auth.invalid-credentials')) },
    agent: fake.agent,
    nodeId: 'dc1',
    csrfKey: KEY,
    idleMinutes: 30,
    absoluteHours: 12,
    webDir: null,
    validateResponses: true,
    restartSelf: () => {
      restarts++;
    },
  });
  await a.app.ready();
  return { a, fake, restarts: () => restarts };
}

const provisionBody = {
  fqdn: 'dc1.example.com',
  hostIp: '10.0.0.11',
  domain: 'example.com',
  netbiosDomain: 'EXAMPLE',
  adminPassword: 'Secret-Pass1',
  dnsForwarders: ['1.1.1.1'],
  confirm: 'example.com',
};

test('setup status hides host details without a valid token', async () => {
  const { a } = await setupApi();
  const anon = (await a.app.inject({ method: 'GET', url: '/api/v1/setup/status' })).json<{
    addresses: unknown[];
    tokenValid: unknown;
  }>();
  assert.deepEqual(anon.addresses, []);
  assert.equal(anon.tokenValid, null);
  const wrong = (
    await a.app.inject({ method: 'GET', url: '/api/v1/setup/status', headers: { 'x-setup-token': 'nope' } })
  ).json<{ tokenValid: unknown; addresses: unknown[] }>();
  assert.equal(wrong.tokenValid, false);
  assert.deepEqual(wrong.addresses, []);
  const ok = (
    await a.app.inject({ method: 'GET', url: '/api/v1/setup/status', headers: { 'x-setup-token': TOKEN } })
  ).json<{ tokenValid: unknown; addresses: unknown[] }>();
  assert.equal(ok.tokenValid, true);
  assert.equal(ok.addresses.length, 1);
});

test('pre-flight and provisioning need the token; provisioning needs the typed confirmation', async () => {
  const { a } = await setupApi();
  const pre = (headers: Record<string, string>) =>
    a.app.inject({
      method: 'POST',
      url: '/api/v1/setup/preflight',
      headers: { ...ORIGIN, ...headers },
      payload: { role: 'primary-dc', fqdn: 'dc1.example.com', hostIp: '10.0.0.11', domain: 'example.com' },
    });
  assert.equal((await pre({})).statusCode, 401);
  assert.equal((await pre({ 'x-setup-token': 'nope' })).statusCode, 401);
  assert.equal((await pre({ 'x-setup-token': TOKEN })).json<{ ok: boolean }>().ok, true);

  const wrongConfirm = await a.app.inject({
    method: 'POST',
    url: '/api/v1/setup/provision',
    headers: { ...ORIGIN, 'x-setup-token': TOKEN },
    payload: { ...provisionBody, confirm: 'other.com' },
  });
  assert.equal(wrongConfirm.json<{ code: string }>().code, 'agent.confirmation-required');
  const weak = await a.app.inject({
    method: 'POST',
    url: '/api/v1/setup/provision',
    headers: { ...ORIGIN, 'x-setup-token': TOKEN },
    payload: { ...provisionBody, adminPassword: 'weak' },
  });
  assert.equal(weak.statusCode, 400);
  const foreign = await a.app.inject({
    method: 'POST',
    url: '/api/v1/setup/provision',
    headers: { origin: 'https://evil.example', host: 'dc1:8443', 'x-setup-token': TOKEN },
    payload: provisionBody,
  });
  assert.equal(foreign.statusCode, 403, 'cross-origin requests are refused');
});

test('provisioning runs as a job with progress, restarts the API and closes setup', async () => {
  const { a, fake, restarts } = await setupApi();
  const r = await a.app.inject({
    method: 'POST',
    url: '/api/v1/setup/provision',
    headers: { ...ORIGIN, 'x-setup-token': TOKEN },
    payload: provisionBody,
  });
  assert.equal(r.statusCode, 202);
  const id = r.json<{ id: string }>().id;
  let job: { job: { status: string; result: { dcFqdn: string } }; events: { kind: string }[] } | null = null;
  for (let i = 0; i < 50; i++) {
    job = (await a.app.inject({ method: 'GET', url: `/api/v1/setup/jobs/${id}` })).json();
    if (job?.job.status !== 'running') break;
    await sleep(10);
  }
  assert.equal(job?.job.status, 'succeeded');
  assert.equal(job.job.result.dcFqdn, 'dc1.example.com');
  assert.deepEqual(
    job.events.map((e) => e.kind),
    ['progress', 'done'],
  );
  assert.equal(restarts(), 1);
  const provisionCall = fake.calls.find((c) => c.op === 'samba.provision');
  assert.ok(provisionCall?.opts.confirmation, 'a confirmation token was minted');
  assert.ok(!('confirm' in (provisionCall.args as object)), 'the confirmation phrase is not an agent argument');
  const actions = a.audit.list().map((e) => e.action);
  assert.ok(actions.includes('setup.provision.start') && actions.includes('setup.provision'));
  assert.ok(!JSON.stringify(a.audit.list()).includes('Secret-Pass1'), 'no password in the audit log');
  // setup is closed now
  const again = await a.app.inject({
    method: 'POST',
    url: '/api/v1/setup/provision',
    headers: { ...ORIGIN, 'x-setup-token': TOKEN },
    payload: provisionBody,
  });
  assert.equal(again.json<{ code: string }>().code, 'setup.already-provisioned');
});
