// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Entry } from 'ldapts';
import { guidToBytes, sidToBytes } from '@opendc/shared/ldap';
import type { WatchContext } from '@opendc/shared/manifest';
import handler, { nodePolicyValues } from './registry-policy.ts';

const DOMAIN = 'DC=example,DC=test';
const PLATFORM = `CN=OpenDC,CN=System,${DOMAIN}`;
const ME = `CN=DC1,OU=Domain Controllers,${DOMAIN}`;
const G = {
  head: '11111111-1111-4111-8111-111111111111',
  dcs: '22222222-2222-4222-8222-222222222222',
  group: '33333333-3333-4333-8333-333333333333',
};
const GROUP_SID = 'S-1-5-21-1-2-3-5000';
const payload = (data: object): string =>
  `opendc:v1:${JSON.stringify({ schemaVersion: 1, kind: 'policy', rev: 1, data })}`;
const pol = (name: string, links: { targetGuid: string; enforced?: boolean }[], settings: object, extra = {}) =>
  payload({
    type: 'registry',
    name,
    description: null,
    priority: 100,
    links: links.map((l) => ({ enforced: false, enabled: true, ...l })),
    settings,
    ...extra,
  });

function ctx(o: { found?: boolean; role?: string } = {}) {
  const applied: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const search = (base: string, s: { scope: string; filter?: { text: string }; attributes: string[] }): Entry[] => {
    const f = s.filter?.text ?? '';
    if (f.includes('sAMAccountName=DC1$')) return o.found === false ? [] : [{ dn: ME }];
    if (base === ME) return [{ dn: ME, tokenGroups: [Buffer.from(sidToBytes(GROUP_SID))] }];
    if (f.includes('distinguishedName'))
      return [
        { dn: DOMAIN, objectGUID: Buffer.from(guidToBytes(G.head)) },
        { dn: `OU=Domain Controllers,${DOMAIN}`, objectGUID: Buffer.from(guidToBytes(G.dcs)) },
      ];
    if (base === `CN=Policies,${PLATFORM}`)
      return [
        {
          dn: 'CN=a',
          cn: 'a',
          'msDS-Settings': pol('domain', [{ targetGuid: G.head }], { 't.k': 1, 't.x': 'domain' }),
        },
        {
          dn: 'CN=b',
          cn: 'b',
          'msDS-Settings': pol('dcs', [{ targetGuid: G.dcs }], { 't.k': 2 }, { filter: { nodeRoles: ['dc'] } }),
        },
        {
          dn: 'CN=c',
          cn: 'c',
          'msDS-Settings': pol(
            'grp',
            [{ targetGuid: G.head, enforced: true }],
            { 't.j': true },
            {
              filter: { groupGuids: [G.group] },
            },
          ),
        },
        // a password policy and a foreign value are ignored
        { dn: 'CN=d', cn: 'd', 'msDS-Settings': payload({ type: 'password', name: 'p', links: [], settings: {} }) },
        { dn: 'CN=e', cn: 'e', 'msDS-Settings': 'something else' },
      ];
    if (base.startsWith('<GUID=')) return [{ dn: 'CN=g', objectSid: Buffer.from(sidToBytes(GROUP_SID)) }];
    return [];
  };
  const c = {
    domainDn: DOMAIN,
    platformDn: PLATFORM,
    node: { hostname: 'dc1', fqdn: 'dc1.example.test', role: o.role ?? 'dc' },
    ldap: { search: (b: string, s: never) => Promise.resolve(search(b, s)) },
    registry: {
      applyPolicyLayer: (v: Record<string, unknown>) => {
        applied.push(v);
        return Promise.resolve({ changed: ['x'] });
      },
    },
    log: (_l: string, m: string) => logs.push(m),
  } as unknown as WatchContext;
  return { c, applied, logs };
}

test('registry policies for this node: OU chain, role filter, group filter, per-key merge', async () => {
  assert.deepEqual(await nodePolicyValues(ctx().c), { 't.j': true, 't.k': 2, 't.x': 'domain' });
  // a member doesn't match the DC-only policy
  assert.deepEqual(await nodePolicyValues(ctx({ role: 'member' }).c), { 't.j': true, 't.k': 1, 't.x': 'domain' });
  assert.equal(await nodePolicyValues(ctx({ found: false }).c), null);
});

test('registry policy handler: applies the layer; ignores other computers; warns without a computer object', async () => {
  const a = ctx();
  await handler.onChange({ handlerId: 'registry-policy', sync: false, events: [] }, a.c);
  assert.deepEqual(a.applied, [{ 't.j': true, 't.k': 2, 't.x': 'domain' }]);
  const ev = (dn: string) => ({ guid: 'g', dn, deleted: false, entry: { dn } });
  await handler.onChange({ handlerId: 'registry-policy-node', sync: false, events: [ev(`CN=PC9,${DOMAIN}`)] }, a.c);
  assert.equal(a.applied.length, 1, 'another computer moved: nothing to do');
  await handler.onChange({ handlerId: 'registry-policy-node', sync: false, events: [ev(ME)] }, a.c);
  assert.equal(a.applied.length, 2);
  const b = ctx({ found: false });
  await handler.onChange({ handlerId: 'registry-policy', sync: true, events: [] }, b.c);
  assert.equal(b.applied.length, 0);
  assert.match(b.logs[0] ?? '', /no computer object/);
});
