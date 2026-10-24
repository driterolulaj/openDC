// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FrameReader,
  errorResponse,
  progressFrame,
  requestSchema,
  resultResponse,
  responseSchema,
} from './protocol.ts';
import { canonicalJson, mintConfirmation, verifyConfirmation } from './confirm.ts';
import { catalogue, isCatalogued } from './catalogue.ts';
import { ops } from './ops.ts';
import { PlatformError } from '../errors.ts';

test('FrameReader splits frames across chunk boundaries and skips blank lines', () => {
  const frames: string[] = [];
  const r = new FrameReader(
    (l) => frames.push(l),
    () => assert.fail('too large'),
  );
  r.push(Buffer.from('{"a":1}\n{"b"'));
  r.push(Buffer.from(':2}\n\n'));
  r.push(Buffer.from('{"c":3}'));
  r.push(Buffer.from('\n'));
  assert.deepEqual(frames, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test('FrameReader stops at the size limit', () => {
  let tooLarge = 0;
  const frames: string[] = [];
  const r = new FrameReader(
    (l) => frames.push(l),
    () => tooLarge++,
    8,
  );
  r.push(Buffer.from('12345'));
  r.push(Buffer.from('6789\n{"x":1}\n'));
  assert.equal(tooLarge, 1);
  assert.deepEqual(frames, []);
  r.push(Buffer.from('more\n'));
  assert.equal(tooLarge, 1);
});

test('wire helpers produce frames the schemas accept', () => {
  const body = new PlatformError('agent.unknown-op', { op: 'x', version: 1 }).toBody();
  assert.ok(responseSchema.safeParse(JSON.parse(errorResponse('1', -32601, body))).success);
  assert.ok(responseSchema.safeParse(JSON.parse(resultResponse('1', { ok: true }))).success);
  assert.ok(progressFrame({ id: '1', step: 'x', percent: 5 }).endsWith('\n'));
  assert.ok(
    requestSchema.safeParse({
      jsonrpc: '2.0',
      id: '1',
      method: 'system.info',
      params: { v: 1, args: {}, actor: { name: 'a', via: 'cli' } },
    }).success,
  );
  assert.ok(
    !requestSchema.safeParse({
      jsonrpc: '2.0',
      id: '1',
      method: 'x',
      params: { v: 1, args: {}, actor: { name: 'a', via: 'cli' }, extra: 1 },
    }).success,
  );
});

test('every implemented op is in the catalogue with a matching Phase 1 entry', () => {
  for (const op of Object.keys(ops)) {
    assert.ok(isCatalogued(op), op);
    assert.equal(catalogue[op].phase, 1, op);
  }
  assert.ok(!isCatalogued('samba.tool'));
});

test('op argument schemas are strict', () => {
  assert.ok(!ops['service.status'].args.safeParse({ unit: 'x', extra: true }).success);
  assert.ok(!ops['file.writeManaged'].args.safeParse({ fileId: '../etc/passwd', content: '' }).success);
  assert.ok(
    !ops['file.writeManaged'].args.safeParse({ fileId: 'core.demo', content: 'x'.repeat(1024 * 1024 + 1) }).success,
  );
  assert.ok(
    ops['file.writeManaged'].args.safeParse({ fileId: 'core.demo', content: 'x', expectedPrevSha256: null }).success,
  );
});

test('confirmation tokens bind op, canonical args, actor and expiry', () => {
  const key = Buffer.alloc(32, 7);
  const args = { roles: ['pdc', 'rid'], target: { b: 1, a: 2 } };
  const t = mintConfirmation(key, { op: 'samba.fsmo.transfer', args, actor: 'S-1-5-21-1', nowSec: 1000 });
  const ok = (o: Partial<{ op: string; args: unknown; actor: string; nowSec: number }>, tok = t) =>
    verifyConfirmation(key, tok, { op: 'samba.fsmo.transfer', args, actor: 'S-1-5-21-1', nowSec: 1000, ...o });
  assert.deepEqual(ok({}), { ok: true });
  assert.deepEqual(ok({ args: { target: { a: 2, b: 1 }, roles: ['pdc', 'rid'] } }), { ok: true });
  assert.deepEqual(ok({ args: { roles: ['pdc'] } }), { ok: false, reason: 'mismatch' });
  assert.deepEqual(ok({ op: 'samba.fsmo.seize' }), { ok: false, reason: 'mismatch' });
  assert.deepEqual(ok({ actor: 'S-1-5-21-2' }), { ok: false, reason: 'mismatch' });
  assert.deepEqual(ok({ nowSec: 1000 + 121 }), { ok: false, reason: 'expired' });
  assert.deepEqual(
    verifyConfirmation(Buffer.alloc(32, 8), t, { op: 'samba.fsmo.transfer', args, actor: 'S-1-5-21-1', nowSec: 1000 }),
    {
      ok: false,
      reason: 'signature',
    },
  );
  assert.deepEqual(ok({}, 'garbage'), { ok: false, reason: 'malformed' });
  assert.deepEqual(ok({}, (t.split('.')[0] ?? '') + '.AAAA'), { ok: false, reason: 'signature' });
  const [p, s] = t.split('.');
  assert.deepEqual(ok({}, `${p}x.${s}`), { ok: false, reason: 'signature' });
  assert.equal(canonicalJson({ b: [{ d: 1, c: 2 }], a: null }), '{"a":null,"b":[{"c":2,"d":1}]}');
});
