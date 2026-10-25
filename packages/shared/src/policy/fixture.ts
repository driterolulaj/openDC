// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The 5-level OU fixture with enforced links (ROADMAP Phase 3 acceptance 3). The resolver unit tests and the
 * lab check of the console's effective-policy viewer use the same fixture and the same expected result.
 */
import type { ResolvablePolicy } from './resolve.ts';

export const FIXTURE_DOMAIN = 'DC=example,DC=test';
export const FIXTURE_OUS = [
  'OU=L5,OU=L4,OU=L3,OU=L2,OU=L1,DC=example,DC=test',
  'OU=L4,OU=L3,OU=L2,OU=L1,DC=example,DC=test',
  'OU=L3,OU=L2,OU=L1,DC=example,DC=test',
  'OU=L2,OU=L1,DC=example,DC=test',
  'OU=L1,DC=example,DC=test',
  'DC=example,DC=test',
];
export const fixtureGuid = (dn: string): string => `g-${dn.split(',')[0]?.slice(3).toLowerCase() ?? ''}`;
const guid = fixtureGuid;
const D = guid(FIXTURE_DOMAIN);
const [L5, L4, L3, L2, L1] = FIXTURE_OUS.slice(0, 5).map(guid) as [string, string, string, string, string];

export const fixtureLink = (targetGuid: string, enforced = false, enabled = true) => ({
  targetGuid,
  enforced,
  enabled,
});
export const fixturePolicy = (
  id: string,
  links: ReturnType<typeof fixtureLink>[],
  settings: Record<string, unknown>,
  priority = 0,
  extra: Partial<ResolvablePolicy> = {},
): ResolvablePolicy => ({ id, name: id, type: 'registry', priority, links, settings, ...extra });

const link = fixtureLink;
const pol = fixturePolicy;

export const FIXTURE_POLICIES: ResolvablePolicy[] = [
  pol('dom', [link(D)], { a: 'dom', b: 'dom', c: 'dom' }, 1),
  pol('l1-enforced', [link(L1, true)], { b: 'l1-enforced' }),
  pol('l3', [link(L3)], { a: 'l3', b: 'l3', d: 'l3' }),
  pol('l4-enforced', [link(L4, true)], { b: 'l4-enforced', d: 'l4-enforced' }),
  pol('l5-second', [link(L5)], { a: 'l5-second', e: 'l5-second' }, 2),
  pol('l5-first', [link(L5)], { a: 'l5-first' }, 1),
  pol('disabled', [link(L5, false, false)], { c: 'disabled' }),
  pol('staff-only', [link(L5)], { c: 'staff-only' }, 0, { filter: { groupGuids: ['G-STAFF'] } }),
  pol('dc-only', [link(D)], { f: 'dc-only' }, 0, { filter: { nodeRoles: ['dc', 'primary-dc'] } }),
  pol('other-type', [link(L5)], { a: 'other' }, 0, { type: 'password' }),
  // linked twice: the enforced link at the domain head is the one that counts
  pol('twice', [link(L2), link(D, true)], { g: 'twice' }, 9),
];

/** Effective registry settings for an object in OU=L5 (no group, no node role): value@level. */
export const FIXTURE_EXPECTED = {
  g: 'twice@DC=example',
  b: 'l1-enforced@OU=L1',
  d: 'l4-enforced@OU=L4',
  a: 'l5-first@OU=L5',
  e: 'l5-second@OU=L5',
  c: 'dom@DC=example',
};
