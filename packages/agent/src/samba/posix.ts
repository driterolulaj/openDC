// SPDX-License-Identifier: AGPL-3.0-only
/**
 * directory.posixIds.fill (ADR-0018, Q22): gives a user or group created outside OpenDC (RSAT, samba-tool,
 * a migration) its RFC2307 IDs, idBase + RID, the same rule OpenDC applies on creation. The caller only names
 * the object; the agent computes the values, never overwrites an existing one and refuses a value that another
 * object already has. Computers and BUILTIN objects are skipped.
 */
import { PlatformError } from '@opendc/shared';
import type { OpResult } from '@opendc/shared/agent';
import { childDn, eq, guidBase } from '@opendc/shared/ldap';
import { first, modifyRecord, type LdifEntry, type Mod } from './ldif.ts';
import type { SambaLocal } from './local.ts';

const DEFAULT_ID_BASE = 100_000;
const PREFIX = 'opendc:v1:';

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

const classes = (e: LdifEntry): string[] => (e.attrs.get('objectclass') ?? []).map((c) => c.toLowerCase());
const ridOf = (sid: string): number => Number(sid.slice(sid.lastIndexOf('-') + 1));

export async function fillPosixIds(samba: SambaLocal, guid: string): Promise<OpResult<'directory.posixIds.fill'>> {
  const e = await samba.get(guidBase(guid), ['objectClass', 'objectSid', 'uidNumber', 'gidNumber', 'primaryGroupID']);
  if (!e) throw new PlatformError('request.not-found', { what: `Object ${guid}` });
  const skip = (skipped: string): OpResult<'directory.posixIds.fill'> => ({ dn: e.dn, set: {}, skipped });
  const cls = classes(e);
  const isGroup = cls.includes('group');
  const isUser = cls.includes('user') && !cls.includes('computer');
  if (!isGroup && !isUser) return skip('not a user or group');
  const sid = first(e, 'objectSid') ?? '';
  const domainDn = await samba.domainDn();
  const domainSid = first(await samba.get(domainDn, ['objectSid']), 'objectSid') ?? '';
  if (!domainSid || !sid.startsWith(`${domainSid}-`)) return skip('not a domain account (BUILTIN or foreign)');
  const idBase = await idBaseOf(samba, domainDn);
  const rid = ridOf(sid);

  const taken = async (attr: 'uidNumber' | 'gidNumber', value: number): Promise<void> => {
    const hits = await samba.search(domainDn, 'sub', eq(attr, String(value)), ['objectGUID']);
    const other = hits.find((h) => h.dn.toLowerCase() !== e.dn.toLowerCase());
    if (other)
      throw new PlatformError('directory.invalid', {
        reason: `${attr} ${String(value)} is already used by ${other.dn}; set the IDs of ${e.dn} by hand`,
      });
  };

  const set: { uidNumber?: number; gidNumber?: number } = {};
  if (isUser) {
    if (!first(e, 'uidNumber')) set.uidNumber = idBase + rid;
    if (!first(e, 'gidNumber')) {
      // the primary group's GID, or the rule applied to its RID
      const pg = Number(first(e, 'primaryGroupID') ?? 513);
      const [g] = await samba.search(domainDn, 'sub', eq('objectSid', `${domainSid}-${String(pg)}`), ['gidNumber']);
      set.gidNumber = Number(first(g, 'gidNumber') ?? idBase + pg);
    }
    if (set.uidNumber !== undefined) await taken('uidNumber', set.uidNumber);
  } else if (!first(e, 'gidNumber')) {
    set.gidNumber = idBase + rid;
    await taken('gidNumber', set.gidNumber);
  }
  if (set.uidNumber === undefined && set.gidNumber === undefined) return skip('already has its IDs');
  const mods: Mod[] = Object.entries(set).map(([attr, v]) => ({ op: 'add', attr, values: [String(v)] }));
  await samba.modify(modifyRecord(e.dn, mods));
  return { dn: e.dn, set, skipped: null };
}
