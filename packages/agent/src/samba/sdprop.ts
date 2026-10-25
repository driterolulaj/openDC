// SPDX-License-Identifier: AGPL-3.0-only
/**
 * samba.sdprop.run: OpenDC's equivalent of the Windows SDProp task, which Samba doesn't implement.
 *
 * On Windows, members of protected groups (Domain Admins, Administrators, ...) get adminCount=1 and the
 * AdminSDHolder security descriptor with inheritance blocked, so delegations granted on OUs or the domain
 * head never reach them. Samba sets adminCount on Administrator at provisioning but never protects any DACL
 * and never stamps new members. Without this, the delegated API account (ADR-0012, tier 1) could modify
 * Domain Admins through its inherited delegation.
 *
 * For every protected group, every transitive member and the built-in protected accounts, this sets
 * adminCount=1 and replaces the DACL with a protected copy of AdminSDHolder's explicit ACEs (plus the
 * standard change-password and administrator ACEs Samba's AdminSDHolder lacks). Idempotent; only objects
 * whose DACL or adminCount differ are written. Runs at the end of setup, after OpenDC changes a protected
 * group, and from the opendc-sdprop timer on the PDC emulator.
 */
import { childDn, eq, inChain, or } from '@opendc/shared/ldap';
import { first, modifyRecord } from './ldif.ts';
import type { SambaLocal } from './local.ts';
import { parseFsmoShow } from './info.ts';

/** RIDs (domain-relative) and builtin SIDs of the groups whose members are protected (MS-ADTS 3.1.1.6.1.2). */
export const PROTECTED_DOMAIN_RIDS = [512, 516, 518, 519, 521] as const; // DA, DCs, Schema, Enterprise, RODCs
export const PROTECTED_BUILTIN_SIDS = [
  'S-1-5-32-544', // Administrators
  'S-1-5-32-548', // Account Operators
  'S-1-5-32-549', // Server Operators
  'S-1-5-32-550', // Print Operators
  'S-1-5-32-551', // Backup Operators
  'S-1-5-32-552', // Replicator
] as const;
const PROTECTED_ACCOUNT_RIDS = [500, 502] as const; // Administrator, krbtgt

const CHANGE_PASSWORD = 'ab721a53-1e2f-11d0-9819-00aa0040529b';

/** The protected DACL: AdminSDHolder's explicit ACEs plus the Windows defaults Samba's copy lacks. */
export function protectedDacl(adminSdHolderSddl: string): string {
  const dacl = /D:[A-Z]*((?:\([^)]*\))+)/.exec(adminSdHolderSddl)?.[1] ?? '';
  const explicit = (dacl.match(/\([^)]*\)/g) ?? []).filter((ace) => !(ace.split(';')[1] ?? '').includes('ID'));
  const extra = [
    '(A;;CCDCLCSWRPWPLOCRRCWDWO;;;BA)',
    '(A;;CCDCLCSWRPWPLOCRRCWDWO;;;EA)',
    `(OA;;CR;${CHANGE_PASSWORD};;WD)`,
    `(OA;;CR;${CHANGE_PASSWORD};;PS)`,
  ];
  const aces = [...explicit, ...extra.filter((a) => !explicit.includes(a))];
  return `D:P${aces.join('')}`;
}

/**
 * Whether the DACL in `sddl` is the protected target: the P flag set and exactly the target's ACEs (as a
 * set; Samba may return ACEs in canonical order).
 */
export function daclMatches(sddl: string, target: string): boolean {
  const parse = (s: string): { flags: string; aces: string[] } => {
    const m = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(s);
    return { flags: m?.[1] ?? '', aces: [...(m?.[2] ?? '').matchAll(/\([^)]*\)/g)].map((x) => x[0]).sort() };
  };
  const a = parse(sddl);
  const b = parse(target);
  return a.flags.includes('P') && a.aces.length === b.aces.length && a.aces.every((x, i) => x === b.aces[i]);
}

export interface SdPropResult {
  checked: number;
  updated: string[];
}

export async function runSdProp(samba: SambaLocal): Promise<SdPropResult> {
  const domainDn = await samba.domainDn();
  const domainSid = first(await samba.get(domainDn, ['objectSid']), 'objectSid');
  if (!domainSid) throw new Error(`${domainDn} has no objectSid`);
  const holder = first(
    await samba.get(childDn(childDn(domainDn, 'CN', 'System'), 'CN', 'AdminSDHolder'), ['nTSecurityDescriptor']),
    'nTSecurityDescriptor',
  );
  if (!holder) throw new Error('AdminSDHolder has no security descriptor');
  const target = protectedDacl(holder);

  const groupSids = [...PROTECTED_DOMAIN_RIDS.map((r) => `${domainSid}-${String(r)}`), ...PROTECTED_BUILTIN_SIDS];
  const groups = await samba.search(domainDn, 'sub', or(...groupSids.map((s) => eq('objectSid', s))), ['dn']);
  const dns = new Set<string>(groups.map((g) => g.dn));
  for (const g of groups) {
    const members = await samba.search(
      domainDn,
      'sub',
      // transitive membership (LDAP_MATCHING_RULE_IN_CHAIN)
      inChain('memberOf', g.dn),
      ['dn'],
    );
    for (const m of members) dns.add(m.dn);
  }
  const accounts = await samba.search(
    domainDn,
    'sub',
    or(...PROTECTED_ACCOUNT_RIDS.map((r) => eq('objectSid', `${domainSid}-${String(r)}`))),
    ['dn'],
  );
  for (const a of accounts) dns.add(a.dn);

  const updated: string[] = [];
  for (const dn of [...dns].sort()) {
    const cur = await samba.get(dn, ['nTSecurityDescriptor', 'adminCount', 'objectClass']);
    if (!cur) continue;
    // Domain Controllers' computer accounts keep their own SD (they are protected by group, not by DACL)
    const classes = cur.attrs.get('objectclass') ?? [];
    if (classes.includes('computer')) continue;
    const sd = first(cur, 'nTSecurityDescriptor') ?? '';
    const mods = [];
    if (!daclMatches(sd, target)) mods.push({ op: 'replace' as const, attr: 'nTSecurityDescriptor', values: [target] });
    if (first(cur, 'adminCount') !== '1') mods.push({ op: 'replace' as const, attr: 'adminCount', values: ['1'] });
    if (!mods.length) continue;
    // sd_flags 4: only the DACL is written; owner, group and SACL stay as they are
    await samba.modify(modifyRecord(dn, mods), ['sd_flags:1:4']);
    updated.push(dn);
  }
  return { checked: dns.size, updated };
}

/**
 * Runs SDProp only on the DC that holds the PDC emulator role (one writer avoids replication churn), as the
 * Windows task does. Returns `skipped` with the reason otherwise.
 */
export async function runSdPropIfPdc(
  samba: SambaLocal,
  hostname: string,
): Promise<SdPropResult & { skipped: string | null }> {
  if (!(await samba.provisioned())) return { checked: 0, updated: [], skipped: 'not a DC' };
  const pdc = parseFsmoShow(await samba.tool(['fsmo', 'show', '-H', samba.samDb])).find((r) => r.role === 'pdc');
  if (pdc?.ownerServer?.toLowerCase() !== hostname.toLowerCase()) {
    return { checked: 0, updated: [], skipped: `PDC emulator is ${pdc?.ownerServer ?? 'unknown'}` };
  }
  return { ...(await runSdProp(samba)), skipped: null };
}
