// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applicablePolicies, chainOf, effectiveSettings, splitDn, type Subject } from './resolve.ts';
import {
  FIXTURE_DOMAIN,
  FIXTURE_EXPECTED,
  FIXTURE_OUS,
  FIXTURE_POLICIES,
  fixtureGuid as guid,
  fixtureLink as link,
  fixturePolicy as pol,
} from './fixture.ts';

const L5 = guid(FIXTURE_OUS[0] ?? '');

const subject = (extra: Partial<Subject> = {}): Subject => ({
  chain: FIXTURE_OUS.map((dn) => ({ guid: guid(dn), dn })),
  ...extra,
});

const values = (s: Subject) =>
  Object.fromEntries(
    Object.entries(effectiveSettings(applicablePolicies(s, FIXTURE_POLICIES, 'registry'))).map(([k, v]) => [
      k,
      `${String(v.value)}@${v.source.level.dn.split(',')[0] ?? ''}`,
    ]),
  );

test('5-level OU fixture: order of the applicable policies', () => {
  const order = applicablePolicies(subject(), FIXTURE_POLICIES, 'registry').map((a) => a.policy.id);
  assert.deepEqual(order, ['twice', 'l1-enforced', 'l4-enforced', 'l5-first', 'l5-second', 'l3', 'dom']);
});

test('5-level OU fixture: per-key merge with enforced links, priority, disabled links and filters', () => {
  assert.deepEqual(values(subject()), FIXTURE_EXPECTED);
  // group filter
  assert.equal(values(subject({ groupGuids: ['g-staff'] })).c, 'staff-only@OU=L5');
  // node role filter
  assert.equal(values(subject({ nodeRole: 'dc' })).f, 'dc-only@DC=example');
  assert.equal(values(subject({ nodeRole: 'member' })).f, undefined);
});

test('an object higher up sees fewer policies; whole-policy types use the winner', () => {
  const l2 = subject({ chain: subject().chain.slice(3) });
  assert.deepEqual(values(l2), {
    g: 'twice@DC=example',
    b: 'l1-enforced@OU=L1',
    a: 'dom@DC=example',
    c: 'dom@DC=example',
  });
  const pw = applicablePolicies(subject(), FIXTURE_POLICIES, 'password');
  assert.equal(pw[0]?.policy.id, 'other-type');
  assert.equal(applicablePolicies({ chain: [] }, FIXTURE_POLICIES, 'registry').length, 0);
});

test('ties within a level: priority, then name', () => {
  const a = pol('b-name', [link(L5)], { x: 'b' }, 1);
  const b = pol('a-name', [link(L5)], { x: 'a' }, 1);
  const order = applicablePolicies(subject(), [a, b], 'registry').map((p) => p.policy.id);
  assert.deepEqual(order, ['a-name', 'b-name']);
  const same = pol('a-name', [link(L5)], { x: 'c' }, 1, { id: 'z' });
  assert.deepEqual(
    applicablePolicies(subject(), [same, b], 'registry').map((p) => p.policy.id),
    ['a-name', 'z'],
  );
});

test('chainOf and splitDn: containers up to the domain head, escaped commas', () => {
  const guids = new Map(
    [...FIXTURE_OUS, 'OU=Sales\\, East,DC=example,DC=test'].map((dn) => [dn.toLowerCase(), guid(dn)]),
  );
  const lookup = (dn: string) => guids.get(dn.toLowerCase());
  const chain = chainOf(`CN=Bob,${FIXTURE_OUS[0] ?? ''}`, FIXTURE_DOMAIN, lookup);
  assert.deepEqual(
    chain.map((c) => c.dn.split(',')[0]),
    ['OU=L5', 'OU=L4', 'OU=L3', 'OU=L2', 'OU=L1', 'DC=example'],
  );
  assert.deepEqual(splitDn('CN=Smith\\, John,OU=Sales\\, East,DC=example'), [
    'CN=Smith\\, John',
    'OU=Sales\\, East',
    'DC=example',
  ]);
  assert.deepEqual(
    chainOf('CN=Smith\\, John,OU=Sales\\, East,DC=example,DC=test', FIXTURE_DOMAIN, lookup).map((c) => c.dn),
    ['OU=Sales\\, East,DC=example,DC=test', 'DC=example,DC=test'],
  );
  // containers without a known GUID (e.g. CN=Users) are skipped
  assert.deepEqual(
    chainOf('CN=x,CN=Users,DC=example,DC=test', FIXTURE_DOMAIN, lookup).map((c) => c.dn),
    ['DC=example,DC=test'],
  );
});
