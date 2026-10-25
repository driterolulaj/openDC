// SPDX-License-Identifier: AGPL-3.0-only
/**
 * directory.posixIds.fill (ADR-0018, Q22): gives users and groups created outside OpenDC (RSAT, samba-tool,
 * a migration) their RFC2307 IDs, idBase + RID, the same rule OpenDC applies on creation. The caller only names
 * the objects; the agent computes the values, never overwrites an existing one and refuses a value that another
 * user (uidNumber) or group (gidNumber) already has. Computers and BUILTIN objects are skipped.
 *
 * Batched: the shared lookups happen once, objects are read and uniqueness is checked with chunked OR filters,
 * and the changes go out as one LDIF. Problems with one object are reported in its result, not thrown.
 */
import type { OpResult } from '@opendc/shared/agent';
import { and, childDn, eq, guidToBytes, or } from '@opendc/shared/ldap';
import { first, modifyRecord, type LdifEntry } from './ldif.ts';
import type { SambaLocal } from './local.ts';

const DEFAULT_ID_BASE = 100_000;
const PREFIX = 'opendc:v1:';
const CHUNK = 100;

type Result = OpResult<'directory.posixIds.fill'>['results'][number];

/** idBase from CN=Settings (written at provisioning). */
export async function idBaseOf(samba: SambaLocal, domainDn: string): Promise<number> {
  const s = await samba.get(childDn(`CN=OpenDC,CN=System,${domainDn}`, 'CN', 'Settings'), ['msDS-Settings']);
  const raw = first(s, 'msDS-Settings');
  if (!raw?.startsWith(PREFIX)) return DEFAULT_ID_BASE;
  try {
    const v = (JSON.parse(raw.slice(PREFIX.length)) as { data?: { idBase?: unknown } }).data?.idBase;
    return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : DEFAULT_ID_BASE;
  } catch {
    return DEFAULT_ID_BASE;
  }
}

const chunks = <T>(xs: readonly T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const classes = (e: LdifEntry): string[] => (e.attrs.get('objectclass') ?? []).map((c) => c.toLowerCase());
const ridOf = (sid: string): number => Number(sid.slice(sid.lastIndexOf('-') + 1));

export async function fillPosixIds(
  samba: SambaLocal,
  guids: readonly string[],
): Promise<OpResult<'directory.posixIds.fill'>> {
  const wanted = [...new Set(guids.map((g) => g.toLowerCase()))];
  const domainDn = await samba.domainDn();
  const domainSid = first(await samba.get(domainDn, ['objectSid']), 'objectSid') ?? '';
  const idBase = await idBaseOf(samba, domainDn);

  const found = new Map<string, LdifEntry>();
  for (const part of chunks(wanted, CHUNK)) {
    const f = or(...part.map((g) => eq('objectGUID', guidToBytes(g))));
    for (const e of await samba.search(domainDn, 'sub', f, [
      'objectGUID',
      'objectClass',
      'objectSid',
      'uidNumber',
      'gidNumber',
      'primaryGroupID',
    ]))
      found.set((first(e, 'objectGUID') ?? '').toLowerCase(), e);
  }

  // GIDs of primary groups, looked up once each
  const groupGid = new Map<number, number>();
  const gidOfGroup = async (rid: number): Promise<number> => {
    let v = groupGid.get(rid);
    if (v === undefined) {
      const [g] = await samba.search(domainDn, 'sub', eq('objectSid', `${domainSid}-${String(rid)}`), ['gidNumber']);
      v = Number(first(g, 'gidNumber') ?? idBase + rid);
      groupGid.set(rid, v);
    }
    return v;
  };

  const results: Result[] = [];
  const plans: { r: Result; e: LdifEntry; kind: 'user' | 'group' }[] = [];
  for (const guid of wanted) {
    const e = found.get(guid);
    const r: Result = { guid, dn: e?.dn ?? null, set: {}, skipped: null, error: null };
    results.push(r);
    if (!e) {
      r.error = 'not found';
      continue;
    }
    const cls = classes(e);
    const kind = cls.includes('group') ? 'group' : cls.includes('user') && !cls.includes('computer') ? 'user' : null;
    const sid = first(e, 'objectSid') ?? '';
    if (!kind) r.skipped = 'not a user or group';
    else if (!domainSid || !sid.startsWith(`${domainSid}-`)) r.skipped = 'not a domain account (BUILTIN or foreign)';
    else {
      if (kind === 'user') {
        if (!first(e, 'uidNumber')) r.set.uidNumber = idBase + ridOf(sid);
        if (!first(e, 'gidNumber')) r.set.gidNumber = await gidOfGroup(Number(first(e, 'primaryGroupID') ?? 513));
      } else if (!first(e, 'gidNumber')) r.set.gidNumber = idBase + ridOf(sid);
      if (r.set.uidNumber === undefined && r.set.gidNumber === undefined) r.skipped = 'already has its IDs';
      else plans.push({ r, e, kind });
    }
  }

  // uniqueness: uidNumber among all objects, a group's gidNumber among groups (users share their group's GID)
  const owners = new Map<string, string>();
  const uids = plans.flatMap((p) => (p.r.set.uidNumber !== undefined ? [p.r.set.uidNumber] : []));
  const gids = plans.flatMap((p) => (p.kind === 'group' && p.r.set.gidNumber !== undefined ? [p.r.set.gidNumber] : []));
  for (const part of chunks(uids, CHUNK))
    for (const h of await samba.search(domainDn, 'sub', or(...part.map((v) => eq('uidNumber', v))), ['uidNumber']))
      owners.set(`u${first(h, 'uidNumber') ?? ''}`, h.dn);
  for (const part of chunks(gids, CHUNK))
    for (const h of await samba.search(
      domainDn,
      'sub',
      and(eq('objectClass', 'group'), or(...part.map((v) => eq('gidNumber', v)))),
      ['gidNumber'],
    ))
      owners.set(`g${first(h, 'gidNumber') ?? ''}`, h.dn);

  const writes: { r: Result; ldif: string }[] = [];
  for (const { r, e, kind } of plans) {
    const clash =
      (r.set.uidNumber !== undefined && owners.get(`u${String(r.set.uidNumber)}`)) ||
      (kind === 'group' && r.set.gidNumber !== undefined && owners.get(`g${String(r.set.gidNumber)}`));
    if (clash && clash.toLowerCase() !== e.dn.toLowerCase()) {
      r.error = `the computed ID is already used by ${clash}; set the IDs of ${e.dn} by hand`;
      r.set = {};
      continue;
    }
    writes.push({
      r,
      ldif: modifyRecord(
        e.dn,
        Object.entries(r.set).map(([attr, v]) => ({ op: 'add' as const, attr, values: [String(v)] })),
      ),
    });
  }
  if (writes.length) {
    try {
      await samba.modify(writes.map((w) => w.ldif).join('\n'));
    } catch {
      // ldbmodify stops at the failing record: retry one by one; "already exists" means it went through before
      for (const w of writes) {
        try {
          await samba.modify(w.ldif);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/attribute or value exists/i.test(msg)) continue;
          w.r.error = msg.slice(0, 300);
          w.r.set = {};
        }
      }
    }
  }
  return { results };
}
