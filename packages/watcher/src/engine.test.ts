// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Entry } from 'ldapts';
import { guidToBytes } from '@opendc/shared/ldap';
import { openDb } from '@opendc/shared/db';
import type { WatchBatch, WatchContext, WatchHandler } from '@opendc/shared/manifest';
import { watcherMetrics as metrics } from '@opendc/shared/api';
import { WatcherEngine, toEvent, type DcIdentity, type DirectoryPort, type WatchedHandler } from './engine.ts';
import { SqliteCheckpoints, watcherMigrations } from './state.ts';

const DOMAIN = 'DC=example,DC=test';
const PLATFORM = `CN=OpenDC,CN=System,${DOMAIN}`;

/** A fake DC: objects with a USN; a cookie is the DC name and the highest USN seen. */
class FakeDc implements DirectoryPort {
  objects = new Map<string, { dn: string; usn: number; deleted: boolean; kind: string; lkp?: string }>();
  usn = 100;
  id: DcIdentity = { dsServiceName: 'CN=NTDS Settings,CN=DC1', invocationId: 'inv-1', dnsHostName: 'dc1', pdc: true };
  down = false;
  failFilter: string | null = null;

  put(guid: string, dn: string, kind = 'item'): void {
    this.objects.set(guid, { dn, usn: ++this.usn, deleted: false, kind });
  }

  remove(guid: string): void {
    const o = this.objects.get(guid);
    if (!o) return;
    this.objects.set(guid, {
      dn: `CN=x\\0ADEL:${guid},CN=Deleted Objects,${DOMAIN}`,
      usn: ++this.usn,
      deleted: true,
      kind: o.kind,
      lkp: o.dn.slice(o.dn.indexOf(',') + 1),
    });
  }

  identity(): Promise<DcIdentity> {
    return this.down ? Promise.reject(unreachable()) : Promise.resolve(this.id);
  }

  dirsync(_nc: string, o: { filter: string; attributes: string[]; cookie: Buffer }) {
    if (this.down) return Promise.reject(unreachable());
    if (this.failFilter === o.filter) return Promise.reject(new Error('insufficient access rights'));
    const ck = o.cookie.length ? (JSON.parse(o.cookie.toString()) as { dc: string; usn: number }) : null;
    // a cookie from another DC would be meaningless here; the engine must never send one
    assert.ok(!ck || ck.dc === this.id.dsServiceName, 'cookie from another DC');
    const since = ck?.usn ?? 0;
    const kind = /\(kind=(\w+)\)/.exec(o.filter)?.[1] ?? 'item';
    const entries: Entry[] = [...this.objects]
      .filter(([, x]) => x.usn > since && x.kind === kind && (!x.deleted || since > 0))
      .map(([guid, x]) => ({
        dn: x.dn,
        objectGUID: Buffer.from(guidToBytes(guid)),
        ...(x.deleted ? { isDeleted: 'TRUE', lastKnownParent: x.lkp ?? '' } : {}),
      }));
    const cookie = Buffer.from(JSON.stringify({ dc: this.id.dsServiceName, usn: this.usn }));
    return Promise.resolve({ entries, cookie });
  }
}

const unreachable = (): Error =>
  Object.assign(new Error('Domain controller is not reachable'), { code: 'ldap.unreachable' });

/** A reconciler: keeps `state` equal to the set of live objects it was told about. */
function reconciler(opts: { failTimes?: number; partial?: boolean } = {}) {
  const state = new Map<string, string>();
  const batches: WatchBatch[] = [];
  let fails = opts.failTimes ?? 0;
  const handler: WatchHandler = {
    onChange(batch) {
      batches.push(batch);
      for (const [i, e] of batch.events.entries()) {
        // crash halfway through, after part of the batch was applied
        if (fails > 0 && opts.partial && i === Math.floor(batch.events.length / 2)) {
          fails--;
          return Promise.reject(new Error('crashed mid-batch'));
        }
        if (e.deleted) state.delete(e.guid);
        else state.set(e.guid, e.dn);
      }
      if (fails > 0 && !opts.partial) {
        fails--;
        return Promise.reject(new Error('handler failed'));
      }
      return Promise.resolve();
    },
  };
  return { handler, state, batches };
}

const guid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function setup(handlers: Partial<WatchedHandler>[], opts: { maxFailures?: number } = {}) {
  const dc = new FakeDc();
  const db = openDb(':memory:', watcherMigrations);
  const state = new SqliteCheckpoints(db);
  let now = 1_000_000;
  const logs: { level: string; msg: string; extra?: Record<string, unknown> }[] = [];
  const engine = new WatcherEngine({
    domainDn: DOMAIN,
    platformDn: PLATFORM,
    handlers: handlers.map((h, i) => ({
      module: 'test',
      id: `h${String(i)}`,
      base: '',
      scope: 'sub',
      filter: '(kind=item)',
      attributes: [],
      handler: reconciler().handler,
      ...h,
    })),
    dir: dc,
    state,
    context: (_h, o) =>
      ({ leader: o.leader, signal: o.signal, since: new Date(o.since).toISOString() }) as unknown as WatchContext,
    log: (level, msg, extra) => logs.push({ level, msg, ...(extra ? { extra } : {}) }),
    retryBaseMs: 1000,
    ...(opts.maxFailures ? { maxFailures: opts.maxFailures } : {}),
    now: () => now,
  });
  return {
    dc,
    state,
    engine,
    logs,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('first pass is a full resync; later passes deliver only changes, once', async () => {
  const r = reconciler();
  const { dc, engine, state } = setup([{ handler: r.handler }]);
  dc.put(guid(1), `CN=a,${DOMAIN}`);
  dc.put(guid(2), `CN=b,${DOMAIN}`);
  let s = await engine.pass();
  assert.equal(r.batches[0]?.sync, true);
  assert.equal(r.batches[0]?.events.length, 2);
  assert.equal(s.handlers[0]?.state, 'ok');
  assert.equal(s.handlers[0]?.resyncs, 1);

  await engine.pass();
  assert.equal(r.batches.length, 1, 'nothing changed: no batch');

  dc.put(guid(3), `CN=c,${DOMAIN}`);
  dc.remove(guid(1));
  s = await engine.pass();
  assert.equal(r.batches[1]?.sync, false);
  assert.deepEqual(r.batches[1]?.events.map((e) => [e.guid, e.deleted]).sort(), [
    [guid(1), true],
    [guid(3), false],
  ]);
  assert.deepEqual([...r.state.keys()].sort(), [guid(2), guid(3)]);
  assert.equal(s.handlers[0]?.events, 4);
  assert.equal(state.get('h0')?.dc, dc.id.dsServiceName);
});

test('a crash mid-batch replays the batch and reaches the same end state (idempotency)', async () => {
  const clean = reconciler();
  const crashing = reconciler({ failTimes: 1, partial: true });
  const a = setup([{ handler: clean.handler }]);
  const b = setup([{ handler: crashing.handler }]);
  for (const x of [a, b]) for (let i = 1; i <= 10; i++) x.dc.put(guid(i), `CN=u${String(i)},${DOMAIN}`);
  await a.engine.pass();
  let s = await b.engine.pass();
  assert.equal(s.handlers[0]?.state, 'failing');
  assert.equal(b.state.get('h0')?.cookie, '', 'checkpoint not advanced');
  // before the backoff has passed nothing is retried
  await b.engine.pass();
  assert.equal(crashing.batches.length, 1);
  b.advance(1000);
  s = await b.engine.pass();
  assert.equal(s.handlers[0]?.state, 'ok');
  assert.deepEqual([...crashing.state].sort(), [...clean.state].sort());
});

test('another DC or a restored DC means a full resync, logged and counted', async () => {
  const r = reconciler();
  const { dc, engine, logs, state, advance } = setup([{ handler: r.handler }]);
  dc.put(guid(1), `CN=a,${DOMAIN}`);
  await engine.pass();
  const since = state.get('h0')?.since;
  assert.ok(since);
  advance(60_000);
  dc.id = { ...dc.id, dsServiceName: 'CN=NTDS Settings,CN=DC2', dnsHostName: 'dc2' };
  let s = await engine.pass();
  assert.equal(r.batches.at(-1)?.sync, true);
  assert.equal(s.handlers[0]?.resyncs, 2);
  assert.ok(logs.some((l) => l.msg === 'full resync' && l.extra?.reason === 'another DC' && l.level === 'warn'));
  dc.id = { ...dc.id, invocationId: 'inv-2' };
  s = await engine.pass();
  assert.equal(s.handlers[0]?.resyncs, 3);
  assert.ok(logs.some((l) => l.extra?.reason === 'DC restored (new invocationId)'));
  assert.match(metrics(s), /opendc_watcher_resyncs_total\{handler="h0"\} 3/);
  assert.equal(state.get('h0')?.since, since, 'a resync keeps the activation time');
});

test('a handler that keeps failing is quarantined; the others carry on; release retries it', async () => {
  const bad = reconciler({ failTimes: 99 });
  const good = reconciler();
  const { dc, engine, state, advance } = setup([{ handler: bad.handler }, { handler: good.handler }], {
    maxFailures: 3,
  });
  dc.put(guid(1), `CN=a,${DOMAIN}`);
  let s = await engine.pass();
  for (let i = 0; i < 5; i++) {
    advance(10 * 60_000);
    s = await engine.pass();
  }
  assert.equal(s.handlers[0]?.state, 'quarantined');
  assert.equal(bad.batches.length, 3, 'no attempts after the quarantine');
  assert.equal(s.handlers[1]?.state, 'ok');
  dc.put(guid(2), `CN=b,${DOMAIN}`);
  await engine.pass();
  assert.ok(good.state.has(guid(2)));
  assert.match(metrics(engine.status), /opendc_watcher_handler_quarantined\{handler="h0"\} 1/);
  assert.equal(state.release('h0'), true);
  await engine.pass();
  assert.equal(bad.batches.length, 4);
  for (let i = 0; i < 3; i++) {
    advance(10 * 60_000);
    await engine.pass();
  }
  assert.deepEqual(state.releaseAll(), ['h0'], 'a start lifts every quarantine');
  assert.deepEqual(state.releaseAll(), []);
  assert.equal(state.resync('h1'), true);
  await engine.pass();
  assert.equal(good.batches.at(-1)?.sync, true);
});

test('an empty attribute list asks for every change; a list adds the attributes every stream needs', async () => {
  const seen: string[][] = [];
  const { dc, engine } = setup([{ attributes: [] }, { filter: '(kind=other)', attributes: ['name'] }]);
  const orig = dc.dirsync.bind(dc);
  dc.dirsync = (nc, o) => {
    seen.push(o.attributes);
    return orig(nc, o);
  };
  await engine.pass();
  assert.deepEqual(seen, [[], ['objectGUID', 'isDeleted', 'lastKnownParent', 'name']]);
});

test('a stream error (e.g. access denied) counts against that handler only', async () => {
  const r = reconciler();
  const { dc, engine } = setup([{ filter: '(kind=item)' }, { filter: '(kind=other)', handler: r.handler }]);
  dc.failFilter = '(kind=item)';
  dc.put(guid(1), `CN=a,${DOMAIN}`, 'other');
  const s = await engine.pass();
  assert.equal(s.handlers[0]?.state, 'failing');
  assert.match(s.handlers[0]?.lastError ?? '', /insufficient access/);
  assert.equal(s.handlers[1]?.state, 'ok');
  assert.ok(r.state.has(guid(1)));
});

test('leader handlers stand by on a DC without the PDC emulator role', async () => {
  const r = reconciler();
  const { dc, engine } = setup([{ handler: r.handler, leader: true }]);
  dc.id = { ...dc.id, pdc: false };
  dc.put(guid(1), `CN=a,${DOMAIN}`);
  let s = await engine.pass();
  assert.equal(s.handlers[0]?.state, 'standby');
  assert.equal(r.batches.length, 0);
  dc.id = { ...dc.id, pdc: true };
  s = await engine.pass();
  assert.equal(s.handlers[0]?.state, 'ok');
  assert.equal(s.leader, true);
});

test("losing the DC is not the handler's fault", async () => {
  const r = reconciler();
  const { dc, engine, state } = setup([{ handler: r.handler }]);
  dc.put(guid(1), `CN=a,${DOMAIN}`);
  await engine.pass();
  dc.down = true;
  let s = await engine.pass();
  assert.equal(s.connected, false);
  assert.equal(state.get('h0')?.failures, 0);
  // the DC answers the identity query, then drops during DirSync
  dc.down = false;
  const orig = dc.dirsync.bind(dc);
  dc.dirsync = () => Promise.reject(unreachable());
  s = await engine.pass();
  assert.equal(s.connected, false);
  assert.equal(s.handlers[0]?.state, 'pending');
  assert.equal(state.get('h0')?.failures, 0);
  dc.dirsync = orig;
  s = await engine.pass();
  assert.equal(s.connected, true);
});

test('handler timeout counts as a failure and aborts its signal', async () => {
  let aborted = false;
  const slow: WatchHandler = {
    onChange: (_b, ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        });
      }),
  };
  const { dc, engine } = setup([{ handler: slow, timeoutMs: 20 }]);
  dc.put(guid(1), `CN=a,${DOMAIN}`);
  const s = await engine.pass();
  assert.equal(s.handlers[0]?.state, 'failing');
  assert.match(s.handlers[0]?.lastError ?? '', /timed out/);
  assert.equal(aborted, true);
});

test('base and scope: one level, subtree, base, {platform}, deletions by last known parent', () => {
  const { engine } = setup([]);
  const h = (base: string, scope: 'base' | 'one' | 'sub') =>
    ({
      base,
      scope,
      module: 'm',
      id: 'x',
      filter: '(a=b)',
      attributes: [],
      handler: reconciler().handler,
    }) as WatchedHandler;
  const ev = (dn: string, extra: Record<string, unknown> = {}) => toEvent({ dn, ...extra });
  const ous = h('OU=Staff', 'one');
  assert.equal(engine.baseOf(ous), `OU=Staff,${DOMAIN}`);
  assert.ok(engine.inScope(ous, ev(`CN=a,OU=Staff,${DOMAIN}`)));
  assert.ok(!engine.inScope(ous, ev(`CN=a,OU=Sub,OU=Staff,${DOMAIN}`)));
  assert.ok(engine.inScope(h('OU=Staff', 'sub'), ev(`CN=a,OU=Sub,OU=staff,${DOMAIN}`)));
  assert.ok(!engine.inScope(h('OU=Staff', 'sub'), ev(`CN=a,OU=NotStaff,${DOMAIN}`)));
  assert.ok(engine.inScope(h('OU=Staff', 'base'), ev(`OU=Staff,${DOMAIN}`)));
  assert.ok(engine.inScope(h('', 'sub'), ev(`CN=x,${DOMAIN}`)));
  const p = h('{platform}', 'sub');
  assert.equal(engine.baseOf(p), PLATFORM);
  assert.equal(engine.baseOf(h('{platform},CN=MFA', 'one')), `CN=MFA,${PLATFORM}`);
  assert.ok(engine.inScope(p, ev(`CN=Settings,${PLATFORM}`)));
  const del = { isDeleted: 'TRUE', lastKnownParent: `OU=Staff,${DOMAIN}` };
  assert.ok(engine.inScope(ous, ev(`CN=a\\0ADEL:x,CN=Deleted Objects,${DOMAIN}`, del)));
  assert.ok(!engine.inScope(h('OU=Other', 'one'), ev('CN=d', del)));
  assert.ok(engine.inScope(h('OU=Other', 'one'), ev('CN=d', { isDeleted: 'TRUE' })), 'unknown parent: deliver');
  assert.ok(engine.inScope(h('', 'sub'), ev('CN=d', { isDeleted: ['TRUE'], lastKnownParent: `OU=Staff,${DOMAIN}` })));
  // extended DN form, as AD returns it
  const ext = { isDeleted: 'TRUE', lastKnownParent: `<GUID=0f00>;OU=Staff,${DOMAIN}` };
  assert.ok(engine.inScope(ous, ev('CN=d', ext)));
  assert.ok(!engine.inScope(h('OU=Other', 'one'), ev('CN=d', ext)));
});

test('a member watching the PDC is not the leader', async () => {
  const r = reconciler();
  const dc = new FakeDc();
  const { openDb: od } = await import('@opendc/shared/db');
  const engine = new WatcherEngine({
    domainDn: DOMAIN,
    platformDn: PLATFORM,
    handlers: [
      {
        module: 't',
        id: 'l',
        base: '',
        scope: 'sub',
        filter: '(kind=item)',
        attributes: [],
        handler: r.handler,
        leader: true,
      },
    ],
    dir: dc,
    state: new SqliteCheckpoints(od(':memory:', watcherMigrations)),
    context: (_h, o) => ({ leader: o.leader }) as unknown as WatchContext,
    log: () => undefined,
    canLead: false,
  });
  const s = await engine.pass();
  assert.equal(s.leader, false);
  assert.equal(s.handlers[0]?.state, 'standby');
});
