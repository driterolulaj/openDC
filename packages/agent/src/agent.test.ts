// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformError } from '@opendc/shared';
import { AgentClient, mintConfirmation, catalogue, type AgentRequest } from '@opendc/shared/agent';
import type { OsActions, OsFacts } from '@opendc/os';
import { parseOsRelease, DebianFacts } from '@opendc/os';
import { Allowlist, loadAllowlist, type AllowlistData } from './allowlist.ts';
import { AgentServer, type LogLine } from './server.ts';
import { CommitLock, summarize } from './ops.ts';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

function fakeOs(): { os: OsActions; files: Map<string, string>; calls: string[] } {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const facts = {
    adapter: 'debian',
    release: { id: 'debian', idLike: [], versionId: '13', prettyName: 'Debian 13', arch: 'x86_64' },
    paths: {
      etc: '/etc/opendc',
      secrets: '/etc/opendc/secrets',
      lib: '/usr/lib/opendc',
      state: '/var/lib/opendc',
      run: '/run/opendc',
      managedFile: (k: string) => `/managed/${k}`,
      managedRoots: () => ['/managed'],
    },
    samba: { mode: async () => 'native', version: async () => ({ major: 4, minor: 22, patch: 11, raw: 'Version 4.22.11' }), paths: () => ({}) },
  } as unknown as OsFacts;
  const os: OsActions = {
    facts,
    services: {
      status: async (u) => {
        calls.push(`status ${u}`);
        return { active: 'active', sub: 'running', enabled: true };
      },
      start: async (u) => void calls.push(`start ${u}`),
      stop: async (u) => void calls.push(`stop ${u}`),
      restart: async (u) => void calls.push(`restart ${u}`),
      reload: async (u) => void calls.push(`reload ${u}`),
    },
    files: {
      writeManaged: async (p, c) => {
        const prev = files.get(p);
        files.set(p, c);
        return { changed: prev !== c, sha256: sha(c), previousSha256: prev === undefined ? null : sha(prev) };
      },
      readManaged: async (p) => {
        const c = files.get(p);
        return c === undefined ? null : { content: c, sha256: sha(c) };
      },
      restorePrevious: async () => ({ restored: false, sha256: null }),
    },
    system: { info: async () => ({ hostname: 'dc1', fqdn: 'dc1.standard.opendc.test', kernel: '6.12', uptimeSec: 1, memTotal: 1, cpus: 2 }) },
  };
  return { os, files, calls };
}

const testAllowlist: AllowlistData = {
  sockets: {
    api: ['system.info', 'service.status', 'file.readManaged', 'registry.commitLock'],
    watch: ['file.writeManaged', 'file.readManaged', 'service.reload'],
    cli: ['file.writeManaged', 'service.restart', 'service.status', 'samba.version', 'file.restorePrevious'],
  },
  files: { 'core.demo': { module: 'core', pathKey: 'opendc.demo', owner: 'root', mode: 0o644, comment: 'hash' } },
  units: { 'opendc-api': ['status', 'restart'], 'samba-ad-dc': ['status'] },
};

function agent(opts: { allowlist?: AllowlistData; confirmKey?: Buffer } = {}) {
  const fake = fakeOs();
  const logs: LogLine[] = [];
  const server = new AgentServer({
    os: fake.os,
    allowlist: new Allowlist(opts.allowlist ?? testAllowlist),
    role: 'dc',
    confirmKey: opts.confirmKey ?? null,
    log: (l) => logs.push(l),
  });
  return { server, logs, ...fake };
}

let seq = 0;
const frame = (method: string, args: unknown, extra: Partial<AgentRequest['params']> = {}, v = 1): string =>
  JSON.stringify({ jsonrpc: '2.0', id: `r${String(++seq)}`, method, params: { v, args, actor: { name: 'test', via: 'cli' }, ...extra } });

type Reply = { result?: unknown; error?: { code: number; data: { code: string; params: Record<string, unknown> } } };
const parse = (s: string): Reply => JSON.parse(s) as Reply;
const errCode = (s: string): string | undefined => parse(s).error?.data.code;

test('a permitted op runs and is logged without secrets', async () => {
  const a = agent();
  const r = parse(await a.server.handleFrame('api', frame('system.info', {})));
  assert.equal((r.result as { fqdn: string }).fqdn, 'dc1.standard.opendc.test');
  assert.equal((r.result as { os: { adapter: string } }).os.adapter, 'debian');
  assert.equal(a.logs.at(-1)?.msg, 'op ok');
});

test('rejects: unknown op, op not allowed on this socket, wrong version, extra args', async () => {
  const a = agent();
  assert.equal(errCode(await a.server.handleFrame('api', frame('samba.tool', { argv: ['x'] }))), 'agent.unknown-op');
  // catalogued and implemented, but not on the api socket
  assert.equal(errCode(await a.server.handleFrame('api', frame('file.writeManaged', { fileId: 'core.demo', content: 'x' }))), 'agent.op-not-allowed');
  // catalogued but not allowlisted anywhere for this build
  assert.equal(errCode(await a.server.handleFrame('cli', frame('service.start', { unit: 'opendc-api' }))), 'agent.op-not-allowed');
  assert.equal(errCode(await a.server.handleFrame('api', frame('system.info', {}, {}, 2))), 'agent.unknown-op');
  assert.equal(errCode(await a.server.handleFrame('api', frame('system.info', { extra: 1 }))), 'agent.invalid-args');
  assert.equal(errCode(await a.server.handleFrame('api', frame('service.status', { unit: 'opendc-api', force: true }))), 'agent.invalid-args');
  assert.equal(parse(await a.server.handleFrame('api', frame('samba.tool', {}))).error?.code, -32601);
  assert.equal(parse(await a.server.handleFrame('api', frame('system.info', { extra: 1 }))).error?.code, -32602);
  assert.equal(a.logs.filter((l) => l.msg === 'op failed').length, 8);
});

test('rejects path traversal and unmanaged files or units', async () => {
  const a = agent();
  for (const fileId of ['../../etc/shadow', '/etc/shadow', 'core.demo/../../x', 'core']) {
    assert.equal(errCode(await a.server.handleFrame('cli', frame('file.writeManaged', { fileId, content: 'x' }))), 'agent.invalid-args', fileId);
  }
  assert.equal(errCode(await a.server.handleFrame('cli', frame('file.writeManaged', { fileId: 'core.other', content: 'x' }))), 'agent.op-not-allowed');
  assert.equal(errCode(await a.server.handleFrame('api', frame('service.status', { unit: 'sshd' }))), 'agent.op-not-allowed');
  // samba-ad-dc is managed for status only
  assert.equal(errCode(await a.server.handleFrame('cli', frame('service.restart', { unit: 'samba-ad-dc' }))), 'agent.op-not-allowed');
  assert.equal(errCode(await a.server.handleFrame('api', frame('service.status', { unit: 'samba-ad-dc;rm -rf /' }))), 'agent.invalid-args');
  assert.deepEqual(a.calls, []);
  const ok = parse(await a.server.handleFrame('cli', frame('service.restart', { unit: 'opendc-api' })));
  assert.deepEqual(ok.result, { unit: 'opendc-api' });
  assert.deepEqual(a.calls, ['restart opendc-api']);
});

test('managed writes: path from the allowlist, stale-file protection, read back', async () => {
  const a = agent();
  const w = parse(await a.server.handleFrame('watch', frame('file.writeManaged', { fileId: 'core.demo', content: 'one', expectedPrevSha256: null })));
  assert.equal((w.result as { changed: boolean }).changed, true);
  assert.equal(a.files.get('/managed/opendc.demo'), 'one');
  assert.equal(
    errCode(await a.server.handleFrame('watch', frame('file.writeManaged', { fileId: 'core.demo', content: 'two', expectedPrevSha256: null }))),
    'agent.stale-file',
  );
  const ok = await a.server.handleFrame('watch', frame('file.writeManaged', { fileId: 'core.demo', content: 'two', expectedPrevSha256: sha('one') }));
  assert.equal((parse(ok).result as { previousSha256: string }).previousSha256, sha('one'));
  const read = parse(await a.server.handleFrame('api', frame('file.readManaged', { fileId: 'core.demo' })));
  assert.deepEqual(read.result, { content: 'two', sha256: sha('two') });
  const logged = a.logs.filter((l) => l.op === 'file.writeManaged' && l.msg === 'op ok').map((l) => JSON.stringify(l));
  assert.ok(logged.length >= 2 && logged.every((l) => !l.includes('"two"') && !l.includes('"one"')), 'file content must not be logged');
  assert.deepEqual(parse(await a.server.handleFrame('cli', frame('file.restorePrevious', { fileId: 'core.demo' }))).result, { restored: false, sha256: null });
  assert.equal((parse(await a.server.handleFrame('cli', frame('samba.version', {}))).result as { minor: number }).minor, 22);
});

test('malformed frames get JSON-RPC errors', async () => {
  const a = agent();
  assert.equal(errCode(await a.server.handleFrame('api', 'not json')), 'agent.protocol');
  assert.equal(errCode(await a.server.handleFrame('api', JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'system.info' }))), 'agent.protocol');
  assert.equal(parse(await a.server.handleFrame('api', JSON.stringify({ jsonrpc: '1.0', id: 'x' }))).error?.code, -32600);
});

test('commit lock: one holder at a time, expiry, release by token only', async () => {
  let now = 1_000_000;
  const lock = new CommitLock(() => now);
  const first = lock.acquire('cli:alice', 30);
  assert.ok(first.acquired && first.token);
  const second = lock.acquire('watcher', 30);
  assert.equal(second.acquired, false);
  assert.equal(second.heldBy, 'cli:alice');
  lock.release('0'.repeat(32));
  assert.equal(lock.acquire('watcher', 30).acquired, false);
  now += 31_000;
  const third = lock.acquire('watcher', 30);
  assert.ok(third.acquired);
  lock.release(third.token ?? '');
  assert.ok(lock.acquire('api', 30).acquired);

  const a = agent();
  const r = parse(await a.server.handleFrame('api', frame('registry.commitLock', { action: 'acquire', holder: 'api', ttlSec: 5 })));
  const token = (r.result as { token: string }).token;
  assert.match(token, /^[0-9a-f]{32}$/);
  assert.equal((parse(await a.server.handleFrame('api', frame('registry.commitLock', { action: 'acquire', holder: 'x', ttlSec: 5 }))).result as { acquired: boolean }).acquired, false);
  assert.equal((parse(await a.server.handleFrame('api', frame('registry.commitLock', { action: 'release', token }))).result as { acquired: boolean }).acquired, false);
  assert.deepEqual(summarize('registry.commitLock', { action: 'release', token }), { action: 'release', holder: undefined });
});

test('typed confirmation: required, verified against args and actor', async () => {
  // Pretend system.info needs a typed confirmation to exercise the mechanism (no Phase 1 op does).
  const entry = catalogue['system.info'] as { confirm?: 'typed' };
  entry.confirm = 'typed';
  try {
    const key = Buffer.alloc(32, 1);
    const a = agent({ confirmKey: key });
    assert.equal(errCode(await a.server.handleFrame('api', frame('system.info', {}))), 'agent.confirmation-required');
    const good = mintConfirmation(key, { op: 'system.info', args: {}, actor: 'test' });
    assert.ok(parse(await a.server.handleFrame('api', frame('system.info', {}, { confirmation: good }))).result);
    const other = mintConfirmation(key, { op: 'system.info', args: {}, actor: 'mallory' });
    assert.equal(errCode(await a.server.handleFrame('api', frame('system.info', {}, { confirmation: other }))), 'agent.confirmation-invalid');
    const noKey = agent();
    assert.equal(errCode(await noKey.server.handleFrame('api', frame('system.info', {}, { confirmation: good }))), 'agent.confirmation-invalid');
  } finally {
    delete entry.confirm;
  }
});

test('the agent refuses to start with an allowlist naming unimplemented ops', () => {
  assert.throws(
    () => new Allowlist({ ...testAllowlist, sockets: { ...testAllowlist.sockets, cli: ['samba.provision'] } }),
    (e: unknown) => e instanceof PlatformError && e.code === 'agent.unknown-op',
  );
});

test('the generated allowlist loads and every managed file maps to a Debian path', () => {
  const al = loadAllowlist();
  const facts = new DebianFacts({ release: parseOsRelease('ID=debian\nVERSION_ID=13\n') });
  for (const [fileId, f] of al.files()) {
    const path = facts.paths.managedFile(f.pathKey);
    assert.ok(facts.paths.managedRoots().some((r) => path.startsWith(r)), `${fileId} -> ${path}`);
  }
  assert.throws(() => al.op('api', 'file.writeManaged'), PlatformError);
  assert.equal(al.op('cli', 'file.writeManaged'), 'file.writeManaged');
});

test('end to end over a socket with the shared client, including the frame limit', async () => {
  const a = agent();
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\opendc-agent-test-${String(process.pid)}` : join(tmpdir(), `opendc-agent-${String(process.pid)}.sock`);
  const server = a.server.createServer('api');
  await new Promise<void>((r) => server.listen(path, r));
  try {
    const client = new AgentClient(path, 'api');
    const info = await client.call('system.info', {}, { actor: { name: 'test', via: 'api' } });
    assert.equal(info.hostname, 'dc1');
    await assert.rejects(
      client.call('file.writeManaged', { fileId: 'core.demo', content: 'x' }, { actor: { name: 'test', via: 'api' } }),
      (e: unknown) => e instanceof PlatformError && e.code === 'agent.op-not-allowed',
    );
    // a frame above 4 MiB is refused with a protocol error, then the connection closes
    const big = await new Promise<string>((resolve) => {
      void import('node:net').then(({ connect }) => {
        const s = connect(path);
        let out = '';
        s.on('data', (d) => (out += d.toString()));
        s.on('close', () => resolve(out));
        s.on('error', () => resolve(out));
        s.write(Buffer.alloc(4 * 1024 * 1024 + 10, 0x61));
      });
    });
    assert.equal(errCode(big.trim()), 'agent.protocol');
    await assert.rejects(
      new AgentClient(path + '-missing', 'api').call('system.info', {}, { actor: { name: 't', via: 'api' }, timeoutMs: 2000 }),
      (e: unknown) => e instanceof PlatformError && e.code === 'agent.unreachable',
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
