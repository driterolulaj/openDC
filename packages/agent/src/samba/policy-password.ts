// SPDX-License-Identifier: AGPL-3.0-only
/**
 * policy.password.reconcile (directory-object-model.md §3.2): OU-linked password policies on top of AD's PSOs,
 * which can't be linked to OUs. A "what should be" reconciler, run by the leader's watcher:
 * - the policy that wins at the domain head (no filter) becomes the Default Domain Policy password settings;
 * - every other password policy gets a PSO `OpenDC-<id>` applied to a shadow group `pso-<id>` in
 *   OU=OpenDC Shadow Groups, whose members are exactly the users whose effective password policy it is
 *   (resolved with the same resolver as the console's viewer);
 * - PSOs and shadow groups of deleted policies are removed.
 * Only differences are written. With `users`, only those users' memberships are checked (a user moved or
 * created); the PSOs and groups are still brought up to date.
 */
import type { OpResult } from '@opendc/shared/agent';
import { policyInput, type PolicyData } from '@opendc/shared/api';
import type { PasswordSettings } from '@opendc/shared/domain';
import { and, childDn, eq, guidToBytes, inChain, or } from '@opendc/shared/ldap';
import { applicablePolicies, chainOf, type ResolvablePolicy } from '@opendc/shared/policy';
import { addRecord, deleteRecord, first, modifyRecord, type LdifEntry } from './ldif.ts';
import type { SambaLocal } from './local.ts';
import { setPolicy, showPolicies } from './password-policy.ts';
import { SHADOW_OU } from './platform.ts';

const PREFIX = 'opendc:v1:';
const PSO_PREFIX = 'OpenDC-';
const GROUP_PREFIX = 'pso-';
/** OpenDC PSOs rank after PSOs an admin applied to groups directly (lower precedence wins in AD) */
const PRECEDENCE_BASE = 1000;
const GLOBAL_SECURITY_GROUP = -2147483646;
const CHUNK = 100;

type PasswordPolicy = ResolvablePolicy & { settings: PasswordSettings };
type Result = OpResult<'policy.password.reconcile'>;

const chunks = <T>(xs: readonly T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const lower = (s: string): string => s.toLowerCase();
const groupSam = (id: string): string => `${GROUP_PREFIX}${id.replace(/-/g, '').slice(0, 16)}`;
const sameSettings = (a: PasswordSettings, b: PasswordSettings): boolean =>
  (Object.keys(a) as (keyof PasswordSettings)[]).every((k) => a[k] === b[k]);

/** Password policies stored under CN=Policies. */
export async function readPasswordPolicies(samba: SambaLocal, platformDn: string): Promise<PasswordPolicy[]> {
  const entries = await samba
    .search(childDn(platformDn, 'CN', 'Policies'), 'one', eq('objectClass', 'msDS-App-Configuration'), [
      'cn',
      'msDS-Settings',
    ])
    .catch(() => [] as LdifEntry[]);
  const out: PasswordPolicy[] = [];
  for (const e of entries) {
    const raw = first(e, 'msDS-Settings');
    if (!raw?.startsWith(PREFIX)) continue;
    try {
      const env = JSON.parse(raw.slice(PREFIX.length)) as { kind?: string; data?: unknown };
      if (env.kind !== 'policy') continue;
      const d: PolicyData = policyInput.parse(env.data);
      if (d.type !== 'password') continue;
      out.push({
        id: first(e, 'cn') ?? '',
        name: d.name,
        type: d.type,
        priority: d.priority,
        links: d.links,
        ...(d.filter ? { filter: d.filter } : {}),
        settings: d.settings,
      });
    } catch {
      // a payload from a newer version or a damaged one: leave its PSO alone rather than guess
    }
  }
  return out;
}

export async function reconcilePasswordPolicies(
  samba: SambaLocal,
  opts: { users?: readonly string[] } = {},
): Promise<Result> {
  const r: Result = {
    policies: 0,
    domainDefault: null,
    psos: { created: 0, updated: 0, removed: 0 },
    members: { added: 0, removed: 0 },
    users: 0,
  };
  const domainDn = await samba.domainDn();
  const platformDn = `CN=OpenDC,CN=System,${domainDn}`;
  const policies = await readPasswordPolicies(samba, platformDn);
  r.policies = policies.length;

  // containers that can carry links: GUID by DN
  const guidOf = new Map<string, string>();
  const head = await samba.get(domainDn, ['objectGUID']);
  guidOf.set(lower(domainDn), first(head, 'objectGUID') ?? '');
  for (const e of await samba.search(
    domainDn,
    'sub',
    or(eq('objectClass', 'organizationalUnit'), eq('objectClass', 'container')),
    ['objectGUID'],
  ))
    guidOf.set(lower(e.dn), first(e, 'objectGUID') ?? '');
  const headLevel = { guid: guidOf.get(lower(domainDn)) ?? '', dn: domainDn };

  // 1. the domain default: the winner among the unfiltered policies linked at the domain head
  const unfiltered = policies.filter((p) => !p.filter?.groupGuids?.length && !p.filter?.nodeRoles?.length);
  const defaultPolicy = applicablePolicies({ chain: [headLevel] }, unfiltered, 'password')[0]?.policy ?? null;
  const current = await showPolicies(samba);
  if (defaultPolicy) {
    r.domainDefault = defaultPolicy.id;
    if (!sameSettings(current.default, defaultPolicy.settings))
      await setPolicy(samba, { kind: 'default', settings: defaultPolicy.settings });
  }

  // 2. a PSO and a shadow group per other policy
  const shadowOu = childDn(domainDn, 'OU', SHADOW_OU);
  const groups = new Map<string, { dn: string; guid: string; members: Set<string> }>();
  const psoPolicies = policies.filter((p) => p.id !== defaultPolicy?.id);
  for (const p of psoPolicies) {
    const cn = `${GROUP_PREFIX}${p.id}`;
    const dn = childDn(shadowOu, 'CN', cn);
    let g = await samba.get(dn, ['objectGUID', 'member']);
    if (!g) {
      if (!(await samba.exists(shadowOu)))
        await samba.add(addRecord(shadowOu, { objectClass: 'organizationalUnit', description: 'Managed by OpenDC' }));
      await samba.add(
        addRecord(dn, {
          objectClass: 'group',
          sAMAccountName: groupSam(p.id),
          groupType: String(GLOBAL_SECURITY_GROUP),
          description: `Members get the password policy "${p.name}". Managed by OpenDC; changes are overwritten.`,
        }),
      );
      g = await samba.get(dn, ['objectGUID', 'member']);
    }
    const guid = first(g, 'objectGUID') ?? '';
    groups.set(p.id, { dn, guid, members: new Set((g?.attrs.get('member') ?? []).map(lower)) });
    const name = `${PSO_PREFIX}${p.id}`;
    const pso = current.psos.find((x) => lower(x.name) === lower(name));
    const precedence = PRECEDENCE_BASE + p.priority;
    const applied = pso?.appliesTo.length === 1 && lower(pso.appliesTo[0]?.guid ?? '') === lower(guid);
    if (!pso || pso.precedence !== precedence || !sameSettings(pso.settings, p.settings) || !applied) {
      await setPolicy(samba, { kind: 'pso', name, precedence, settings: p.settings, appliesTo: [guid] });
      if (pso) r.psos.updated++;
      else r.psos.created++;
    }
  }

  // 3. memberships: every user (or the given ones) in exactly the group of its effective policy
  const users = opts.users
    ? (
        await Promise.all(
          chunks([...new Set(opts.users.map(lower))], CHUNK).map((part) =>
            samba.search(domainDn, 'sub', or(...part.map((g) => eq('objectGUID', guidToBytes(g)))), ['memberOf']),
          ),
        )
      ).flat()
    : await samba.search(domainDn, 'sub', and(eq('objectCategory', 'person'), eq('objectClass', 'user')), ['memberOf']);
  r.users = users.length;
  // members of the groups that policy filters name (transitive)
  const filterGroups = [...new Set(policies.flatMap((p) => p.filter?.groupGuids ?? []).map(lower))];
  const inGroup = new Map<string, Set<string>>(); // user dn -> filter group guids
  for (const fg of filterGroups) {
    const g = (await samba.search(domainDn, 'sub', eq('objectGUID', guidToBytes(fg)), ['objectGUID']))[0];
    if (!g) continue;
    const members = await samba.search(domainDn, 'sub', inChain('memberOf', g.dn), ['cn']);
    for (const m of members) {
      const s = inGroup.get(lower(m.dn)) ?? new Set<string>();
      s.add(fg);
      inGroup.set(lower(m.dn), s);
    }
  }
  const changes = new Map<string, { add: string[]; del: string[] }>();
  const change = (policyId: string): { add: string[]; del: string[] } => {
    let c = changes.get(policyId);
    if (!c) changes.set(policyId, (c = { add: [], del: [] }));
    return c;
  };
  for (const u of users) {
    const chain = chainOf(u.dn, domainDn, (dn) => guidOf.get(lower(dn)));
    const win = applicablePolicies(
      { chain, groupGuids: [...(inGroup.get(lower(u.dn)) ?? [])] },
      policies,
      'password',
    )[0];
    const want = win && win.policy.id !== defaultPolicy?.id ? win.policy.id : null;
    for (const [pid, g] of groups) {
      const has = g.members.has(lower(u.dn));
      if (pid === want && !has) change(pid).add.push(u.dn);
      if (pid !== want && has) change(pid).del.push(u.dn);
    }
  }
  // a full run also drops members that aren't users any more (deleted, or a group someone added)
  if (!opts.users) {
    const userDns = new Set(users.map((u) => lower(u.dn)));
    for (const [pid, g] of groups) for (const m of g.members) if (!userDns.has(m)) change(pid).del.push(m);
  }
  for (const [pid, c] of changes) {
    const g = groups.get(pid);
    if (!g) continue;
    for (const part of chunks(c.add, CHUNK)) {
      await samba.modify(modifyRecord(g.dn, [{ op: 'add', attr: 'member', values: part }]));
      r.members.added += part.length;
    }
    for (const part of chunks(c.del, CHUNK)) {
      await samba.modify(modifyRecord(g.dn, [{ op: 'delete', attr: 'member', values: part }]));
      r.members.removed += part.length;
    }
  }

  // 4. PSOs and shadow groups of policies that no longer exist (or became the domain default)
  const keep = new Set(psoPolicies.map((p) => lower(`${PSO_PREFIX}${p.id}`)));
  for (const pso of current.psos) {
    if (!lower(pso.name).startsWith(lower(PSO_PREFIX)) || keep.has(lower(pso.name))) continue;
    await setPolicy(samba, { kind: 'psoDelete', name: pso.name });
    r.psos.removed++;
    const id = pso.name.slice(PSO_PREFIX.length);
    const dn = childDn(shadowOu, 'CN', `${GROUP_PREFIX}${id}`);
    if (await samba.exists(dn)) await samba.modify(deleteRecord(dn));
  }
  return r;
}
