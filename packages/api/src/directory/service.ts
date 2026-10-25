// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Directory operations behind the /api/v1/directory routes. Pure LDAP + mapping: authorization and audit
 * happen in the routes (every method here expects its caller to have checked RBAC on the DNs involved).
 */
import { randomInt } from 'node:crypto';
import type { Entry } from 'ldapts';
import { PlatformError } from '@opendc/shared';
import {
  and,
  childDn,
  contains,
  eq,
  guidBase,
  isWithin,
  not,
  or,
  parentDn,
  present,
  ridOf,
  bitAnd,
  domainFromDn,
  type LdapFilter,
} from '@opendc/shared/ldap';
import type {
  Computer,
  Contact,
  Container,
  DirectoryObject,
  Group,
  ListResponse,
  ObjectRef,
  User,
  listQuery,
  userCreate,
  userPatch,
} from '@opendc/shared/api';
import type { z } from 'zod';
import type { LdapLike, Mod } from './ldap.ts';
import {
  ALL_ATTRS,
  COMMON_ATTRS,
  CONTAINER_ATTRS,
  GROUP_TYPE,
  LIST_ATTRS,
  UAC,
  UAC_COMPUTED,
  USER_INT_FIELDS,
  USER_STRING_FIELDS,
  buf,
  etagOf,
  filetimeToIso,
  generalizedToIso,
  guidOf,
  int,
  isProtectedEntry,
  isoToFiletime,
  listItemOf,
  protectedSids,
  rdnValue,
  refOf,
  sidOf,
  str,
  strs,
  typeOf,
} from './model.ts';

export const MAX_LIST = 10_000;

/** Fields every object view shares. */
type Common = Pick<
  Container,
  'guid' | 'dn' | 'parentDn' | 'name' | 'description' | 'whenCreated' | 'whenChanged' | 'protected' | 'etag'
>;
const DOMAIN_USERS_RID = 513;

/** A random password that meets AD complexity: 16 characters from all four classes. */
export function generatePassword(length = 16): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!#%+-=?@_'];
  const all = sets.join('');
  const chars = sets.map((s) => s[randomInt(s.length)] ?? 'x');
  while (chars.length < length) chars.push(all[randomInt(all.length)] ?? 'x');
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] ?? '', chars[i] ?? ''];
  }
  return chars.join('');
}

export const unicodePwd = (pw: string): Buffer => Buffer.from(`"${pw}"`, 'utf16le');

export interface DirectoryConfig {
  domainDn: string;
  domainSid: string;
}

export class DirectoryService {
  readonly ldap: LdapLike;
  readonly domainDn: string;
  readonly domainSid: string;
  readonly protectedSet: Set<string>;
  #idBase: number | null = null;

  constructor(ldap: LdapLike, cfg: DirectoryConfig) {
    this.ldap = ldap;
    this.domainDn = cfg.domainDn;
    this.domainSid = cfg.domainSid;
    this.protectedSet = protectedSids(cfg.domainSid);
  }

  get platformDn(): string {
    return childDn(childDn(this.domainDn, 'CN', 'System'), 'CN', 'OpenDC');
  }

  /** idBase from CN=Settings (ADR-0018); cached. */
  async idBase(): Promise<number> {
    if (this.#idBase !== null) return this.#idBase;
    const [e] = await this.ldap.search(childDn(this.platformDn, 'CN', 'Settings'), {
      scope: 'base',
      attributes: ['msDS-Settings'],
    });
    const raw = e ? str(e, 'msDS-Settings') : null;
    let base = 100_000;
    if (raw?.startsWith('opendc:v1:')) {
      try {
        const v = (JSON.parse(raw.slice('opendc:v1:'.length)) as { data?: { idBase?: unknown } }).data?.idBase;
        if (typeof v === 'number' && Number.isInteger(v)) base = v;
      } catch {
        // keep the default
      }
    }
    this.#idBase = base;
    return base;
  }

  // ---- reading ----

  async entryByGuid(guid: string, attrs: string[] = ALL_ATTRS, tokenGroups = false): Promise<Entry> {
    const [e] = await this.ldap.search(guidBase(guid), {
      scope: 'base',
      attributes: tokenGroups ? [...attrs, 'tokenGroups'] : attrs,
    });
    if (!e) throw new PlatformError('request.not-found', { what: `Object ${guid}` });
    return e;
  }

  async entryByDn(dn: string, attrs: string[] = COMMON_ATTRS): Promise<Entry | null> {
    const [e] = await this.ldap.search(dn, { scope: 'base', attributes: attrs });
    return e ?? null;
  }

  /** The DN of a container given by GUID (default: the domain head), checked to be a container. */
  async containerDn(guid: string | undefined, fallback?: string): Promise<string> {
    if (!guid) return fallback ?? this.domainDn;
    const e = await this.entryByGuid(guid, COMMON_ATTRS);
    const t = typeOf(e);
    if (t !== 'ou' && t !== 'container' && e.dn.toLowerCase() !== this.domainDn.toLowerCase())
      throw new PlatformError('validation.invalid', { issues: `${e.dn} is not an OU or container` });
    return e.dn;
  }

  /** GUID and type of DN-valued references (memberOf, manager, managedBy). */
  async resolveRefs(dns: string[]): Promise<Map<string, { guid: string; type: ObjectRef['type'] }>> {
    const out = new Map<string, { guid: string; type: ObjectRef['type'] }>();
    const unique = [...new Set(dns.map((d) => d.toLowerCase()))];
    for (let i = 0; i < unique.length; i += 100) {
      const chunk = dns.filter((d) => unique.slice(i, i + 100).includes(d.toLowerCase()));
      if (!chunk.length) continue;
      const found = await this.ldap.search(this.domainDn, {
        scope: 'sub',
        filter: or(...chunk.map((d) => eq('distinguishedName', d))),
        attributes: ['objectGUID', 'objectClass'],
      });
      for (const e of found) out.set(e.dn.toLowerCase(), { guid: guidOf(e), type: typeOf(e) });
    }
    return out;
  }

  isProtected(e: Entry): boolean {
    return isProtectedEntry(e, this.protectedSet);
  }

  async getObject(guid: string): Promise<{ object: DirectoryObject; entry: Entry }> {
    const e = await this.entryByGuid(guid, ALL_ATTRS, true);
    const type = typeOf(e);
    const refDns = [
      ...strs(e, 'memberOf'),
      ...(str(e, 'manager') ? [str(e, 'manager') ?? ''] : []),
      ...(str(e, 'managedBy') ? [str(e, 'managedBy') ?? ''] : []),
    ];
    const refs = await this.resolveRefs(refDns);
    const common = {
      guid: guidOf(e),
      dn: e.dn,
      parentDn: parentDn(e.dn) ?? '',
      name: str(e, 'name') ?? rdnValue(e.dn),
      description: str(e, 'description'),
      whenCreated: generalizedToIso(str(e, 'whenCreated')),
      whenChanged: generalizedToIso(str(e, 'whenChanged')),
      protected: this.isProtected(e),
      etag: etagOf(e),
    };
    const memberOf = strs(e, 'memberOf').map((d) => refOf(d, refs));
    const managedBy = str(e, 'managedBy');
    switch (type) {
      case 'user':
        return { object: await this.#user(e, common, memberOf, refs), entry: e };
      case 'group': {
        const gt = int(e, 'groupType') ?? 0;
        const scope: Group['scope'] =
          gt & GROUP_TYPE.builtin
            ? 'builtin'
            : gt & GROUP_TYPE.universal
              ? 'universal'
              : gt & GROUP_TYPE.domainLocal
                ? 'domainLocal'
                : 'global';
        const memberCount = (
          await this.ldap.search(this.domainDn, {
            scope: 'sub',
            filter: eq('memberOf', e.dn),
            attributes: ['1.1'],
            sizeLimit: MAX_LIST,
          })
        ).length;
        const g: Group = {
          ...common,
          type: 'group',
          sid: sidOf(e) ?? '',
          sam: str(e, 'sAMAccountName') ?? '',
          mail: str(e, 'mail'),
          scope,
          kind: (gt & GROUP_TYPE.security) !== 0 ? 'security' : 'distribution',
          gidNumber: int(e, 'gidNumber'),
          managedBy: managedBy ? refOf(managedBy, refs) : null,
          memberCount,
          memberOf,
        };
        return { object: g, entry: e };
      }
      case 'computer': {
        const uac = int(e, 'userAccountControl') ?? 0;
        const c: Computer = {
          ...common,
          type: 'computer',
          sid: sidOf(e) ?? '',
          sam: str(e, 'sAMAccountName') ?? '',
          dnsHostName: str(e, 'dNSHostName'),
          operatingSystem: str(e, 'operatingSystem'),
          operatingSystemVersion: str(e, 'operatingSystemVersion'),
          location: str(e, 'location'),
          managedBy: managedBy ? refOf(managedBy, refs) : null,
          enabled: (uac & UAC.disabled) === 0,
          isDc: (uac & UAC.serverTrust) !== 0,
          lastLogon: filetimeToIso(str(e, 'lastLogonTimestamp')),
          memberOf,
        };
        return { object: c, entry: e };
      }
      case 'contact': {
        const c: Contact = {
          ...common,
          type: 'contact',
          givenName: str(e, 'givenName'),
          sn: str(e, 'sn'),
          displayName: str(e, 'displayName'),
          mail: str(e, 'mail'),
          telephoneNumber: str(e, 'telephoneNumber'),
          mobile: str(e, 'mobile'),
          company: str(e, 'company'),
          title: str(e, 'title'),
          department: str(e, 'department'),
          memberOf,
        };
        return { object: c, entry: e };
      }
      case 'ou':
      case 'container':
        return { object: await this.#container(e, common, type), entry: e };
      default:
        throw new PlatformError('directory.unsupported', { what: `Viewing ${e.dn}` });
    }
  }

  async #user(
    e: Entry,
    common: Common,
    memberOf: ObjectRef[],
    refs: Map<string, { guid: string; type: ObjectRef['type'] }>,
  ): Promise<User> {
    const uac = int(e, 'userAccountControl') ?? 0;
    const computed = int(e, 'msDS-User-Account-Control-Computed') ?? 0;
    const pwdLastSet = str(e, 'pwdLastSet');
    const sid = sidOf(e) ?? '';
    const primaryRid = int(e, 'primaryGroupID');
    let primaryGroup: ObjectRef | null = null;
    if (primaryRid !== null) {
      const [g] = await this.ldap.search(this.domainDn, {
        scope: 'sub',
        filter: eq('objectSid', `${this.domainSid}-${String(primaryRid)}`),
        attributes: ['objectGUID', 'name'],
      });
      if (g) primaryGroup = { guid: guidOf(g), dn: g.dn, name: str(g, 'name') ?? rdnValue(g.dn), type: 'group' };
    }
    const manager = str(e, 'manager');
    const fields = Object.fromEntries(Object.entries(USER_STRING_FIELDS).map(([k, a]) => [k, str(e, a)])) as Record<
      keyof typeof USER_STRING_FIELDS,
      string | null
    >;
    return {
      ...common,
      ...fields,
      type: 'user',
      sid,
      sam: str(e, 'sAMAccountName') ?? '',
      manager: manager ? refOf(manager, refs) : null,
      accountExpires: filetimeToIso(str(e, 'accountExpires')),
      uidNumber: int(e, 'uidNumber'),
      gidNumber: int(e, 'gidNumber'),
      enabled: (uac & UAC.disabled) === 0,
      locked: (computed & UAC_COMPUTED.lockout) !== 0,
      passwordExpired: (computed & UAC_COMPUTED.passwordExpired) !== 0,
      passwordNeverExpires: (uac & UAC.dontExpirePassword) !== 0,
      mustChangePassword: pwdLastSet === '0',
      passwordLastSet: filetimeToIso(pwdLastSet),
      lastLogon: filetimeToIso(str(e, 'lastLogonTimestamp')),
      badPasswordCount: int(e, 'badPwdCount') ?? 0,
      memberOf,
      primaryGroup,
      hasPhoto: buf(e, 'thumbnailPhoto') !== null,
    };
  }

  async #container(e: Entry, common: Common, type: 'ou' | 'container'): Promise<Container> {
    const children = await this.ldap
      .search(e.dn, {
        scope: 'one',
        filter: or(
          eq('objectClass', 'organizationalUnit'),
          eq('objectClass', 'container'),
          eq('objectClass', 'builtinDomain'),
        ),
        attributes: ['1.1'],
        sizeLimit: 1,
      })
      .catch(() => []);
    const systemFlags = int(e, 'systemFlags') ?? 0;
    return {
      ...common,
      type,
      hasChildren: children.length > 0,
      // FLAG_DISALLOW_DELETE (0x80000000) or critical system objects
      system: (systemFlags & 0x80000000) !== 0 || str(e, 'isCriticalSystemObject') === 'TRUE',
    };
  }

  /** Child containers of `baseDn` (the OU tree). */
  async tree(baseDn: string): Promise<Container[]> {
    const entries = await this.ldap.search(baseDn, {
      scope: 'one',
      filter: or(
        eq('objectClass', 'organizationalUnit'),
        eq('objectClass', 'container'),
        eq('objectClass', 'builtinDomain'),
      ),
      attributes: CONTAINER_ATTRS,
    });
    const out: Container[] = [];
    for (const e of entries) {
      const type = typeOf(e);
      if (type !== 'ou' && type !== 'container') continue;
      out.push(
        await this.#container(
          e,
          {
            guid: guidOf(e),
            dn: e.dn,
            parentDn: parentDn(e.dn) ?? '',
            name: str(e, 'name') ?? rdnValue(e.dn),
            description: str(e, 'description'),
            whenCreated: generalizedToIso(str(e, 'whenCreated')),
            whenChanged: generalizedToIso(str(e, 'whenChanged')),
            protected: false,
            etag: etagOf(e),
          },
          type,
        ),
      );
    }
    return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'ou' ? -1 : 1));
  }

  /**
   * Lists objects. `bases` are the subtrees the caller may read (null = the whole domain); results outside
   * them are never returned.
   */
  async list(q: z.output<typeof listQuery>, bases: string[] | null): Promise<ListResponse> {
    const base = await this.containerDn(q.base);
    const types = (q.types ?? 'user,group,computer,contact,ou').split(',').filter(Boolean);
    const typeFilters: LdapFilter[] = [];
    if (types.includes('user')) typeFilters.push(and(eq('objectCategory', 'person'), eq('objectClass', 'user')));
    if (types.includes('group')) typeFilters.push(eq('objectClass', 'group'));
    if (types.includes('computer')) typeFilters.push(eq('objectClass', 'computer'));
    if (types.includes('contact')) typeFilters.push(eq('objectClass', 'contact'));
    if (types.includes('ou')) typeFilters.push(eq('objectClass', 'organizationalUnit'));
    if (types.includes('container')) typeFilters.push(eq('objectClass', 'container'));
    if (!typeFilters.length) return { items: [], total: 0, truncated: false };
    const parts: LdapFilter[] = [or(...typeFilters)];
    if (q.q) {
      const t = q.q.trim();
      parts.push(
        or(contains('name', t), contains('sAMAccountName', t), contains('displayName', t), contains('mail', t)),
      );
    }
    if (q.status === 'disabled') parts.push(bitAnd('userAccountControl', UAC.disabled));
    if (q.status === 'enabled')
      parts.push(present('userAccountControl'), not(bitAnd('userAccountControl', UAC.disabled)));
    if (q.status === 'locked') parts.push(bitAnd('msDS-User-Account-Control-Computed', UAC_COMPUTED.lockout));
    // expired accounts: accountExpires in the past (and not "never")
    if (q.status === 'expired')
      parts.push(
        present('accountExpires'),
        not(eq('accountExpires', '0')),
        not(eq('accountExpires', '9223372036854775807')),
      );
    const filter = and(...parts);

    // search the requested base, intersected with what the caller may read
    let searchBases: string[];
    if (bases === null) searchBases = [base];
    else
      searchBases = [
        ...bases.filter((b) => isWithin(b, base)),
        ...(bases.some((b) => isWithin(base, b)) ? [base] : []),
      ];
    const seen = new Map<string, Entry>();
    let truncated = false;
    for (const b of [...new Set(searchBases)]) {
      const entries = await this.ldap
        .search(b, {
          scope: q.scope === 'one' && b === base ? 'one' : 'sub',
          filter,
          attributes: [...LIST_ATTRS, 'accountExpires'],
          sizeLimit: MAX_LIST + 1,
        })
        .catch((e: unknown) => {
          if (e instanceof PlatformError && e.code === 'request.not-found') return [];
          throw e;
        });
      if (entries.length > MAX_LIST) truncated = true;
      for (const e of entries.slice(0, MAX_LIST)) seen.set(e.dn.toLowerCase(), e);
    }
    let rows = [...seen.values()];
    if (q.status === 'expired') {
      const now = Date.now();
      rows = rows.filter((e) => {
        const iso = filetimeToIso(str(e, 'accountExpires'));
        return iso !== null && Date.parse(iso) < now;
      });
    }
    const items = rows.map((e) => listItemOf(e, this.protectedSet));
    const key = (i: (typeof items)[number]): string =>
      q.sort === 'sam' ? (i.sam ?? i.name) : q.sort === 'whenChanged' ? (i.whenChanged ?? '') : i.name;
    items.sort(
      (a, b) => key(a).localeCompare(key(b), undefined, { sensitivity: 'base' }) * (q.order === 'desc' ? -1 : 1),
    );
    return { items: items.slice(q.offset, q.offset + q.limit), total: items.length, truncated };
  }

  // ---- users ----

  async createUser(
    parent: string,
    input: z.output<typeof userCreate>,
    password: string,
  ): Promise<{ guid: string; dn: string }> {
    const display = input.displayName ?? ([input.givenName, input.sn].filter(Boolean).join(' ') || null);
    const cn = input.cn ?? display ?? input.sam;
    const dn = childDn(parent, 'CN', cn);
    const domain = domainFromDn(this.domainDn);
    const attrs: Record<string, (string | Buffer)[]> = {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      sAMAccountName: [input.sam],
      userPrincipalName: [input.userPrincipalName ?? `${input.sam}@${domain}`],
      // created disabled; enabled after the password is set (AD refuses an enabled account without one)
      userAccountControl: [String(UAC.normal | UAC.disabled)],
    };
    if (display) attrs.displayName = [display];
    for (const [field, attr] of Object.entries(USER_STRING_FIELDS)) {
      if (field === 'userPrincipalName' || field === 'displayName') continue;
      const v = input[field as keyof typeof USER_STRING_FIELDS];
      if (typeof v === 'string' && v !== '') attrs[attr] = [v];
    }
    if (input.accountExpires) attrs.accountExpires = [isoToFiletime(input.accountExpires)];
    if (input.manager) attrs.manager = [(await this.entryByGuid(input.manager, ['objectGUID'])).dn];
    await this.ldap.add(dn, attrs);
    try {
      const created = await this.entryByDn(dn, ['objectGUID', 'objectSid']);
      if (!created) throw new PlatformError('request.not-found', { what: dn });
      const sid = sidOf(created) ?? '';
      const idBase = await this.idBase();
      const mods: Mod[] = [
        { op: 'replace', attr: 'unicodePwd', values: [unicodePwd(password)] },
        // RID-based POSIX IDs (ADR-0018)
        { op: 'replace', attr: 'uidNumber', values: [String(input.uidNumber ?? idBase + ridOf(sid))] },
        { op: 'replace', attr: 'gidNumber', values: [String(input.gidNumber ?? idBase + DOMAIN_USERS_RID)] },
        { op: 'replace', attr: 'loginShell', values: [input.loginShell ?? '/bin/bash'] },
        { op: 'replace', attr: 'unixHomeDirectory', values: [input.unixHomeDirectory ?? `/home/${input.sam}`] },
      ];
      await this.ldap.modify(dn, mods);
      const uac = UAC.normal | (input.enabled ? 0 : UAC.disabled);
      await this.ldap.modify(dn, [
        { op: 'replace', attr: 'userAccountControl', values: [String(uac)] },
        ...(input.mustChangePassword ? [{ op: 'replace' as const, attr: 'pwdLastSet', values: ['0'] }] : []),
      ]);
      return { guid: guidOf(created), dn };
    } catch (e) {
      // don't leave a half-created, passwordless account behind
      await this.ldap.del(dn).catch(() => undefined);
      throw e;
    }
  }

  /** Builds the modifications for a user PATCH; returns them with a before/after summary for the audit. */
  async userMods(
    e: Entry,
    patch: z.output<typeof userPatch>,
  ): Promise<{ mods: Mod[]; before: Record<string, unknown>; after: Record<string, unknown> }> {
    const mods: Mod[] = [];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const set = (field: string, attr: string, value: string | null, current: string | null): void => {
      if ((value ?? null) === current) return;
      before[field] = current;
      after[field] = value;
      mods.push(value === null ? { op: 'replace', attr, values: [] } : { op: 'replace', attr, values: [value] });
    };
    for (const [field, attr] of Object.entries(USER_STRING_FIELDS)) {
      const v = (patch as Record<string, unknown>)[field];
      if (v === undefined) continue;
      set(field, attr, (v as string | null) || null, str(e, attr));
    }
    for (const [field, attr] of Object.entries(USER_INT_FIELDS)) {
      const v = (patch as Record<string, unknown>)[field];
      if (v === undefined) continue;
      if (v !== null) await this.#assertIdFree(attr, v as number, e.dn);
      set(field, attr, v === null ? null : (v as number).toString(), str(e, attr));
    }
    if (patch.accountExpires !== undefined) {
      const cur = filetimeToIso(str(e, 'accountExpires'));
      if (cur !== patch.accountExpires) {
        before.accountExpires = cur;
        after.accountExpires = patch.accountExpires;
        mods.push({ op: 'replace', attr: 'accountExpires', values: [isoToFiletime(patch.accountExpires)] });
      }
    }
    if (patch.manager !== undefined) {
      const cur = str(e, 'manager');
      const next = patch.manager ? (await this.entryByGuid(patch.manager, ['objectGUID'])).dn : null;
      if ((cur ?? '').toLowerCase() !== (next ?? '').toLowerCase()) {
        before.manager = cur;
        after.manager = next;
        mods.push({ op: 'replace', attr: 'manager', values: next ? [next] : [] });
      }
    }
    return { mods, before, after };
  }

  /** uidNumber/gidNumber uniqueness (ADR-0018: manual overrides are checked before saving). */
  async #assertIdFree(attr: string, value: number, selfDn: string): Promise<void> {
    if (attr === 'gidNumber') return; // users share their primary group's GID
    const found = await this.ldap.search(this.domainDn, {
      scope: 'sub',
      filter: eq(attr, String(value)),
      attributes: ['1.1'],
      sizeLimit: 2,
    });
    if (found.some((f) => f.dn.toLowerCase() !== selfDn.toLowerCase()))
      throw new PlatformError('directory.exists', { what: `${attr} ${String(value)}` });
  }

  async setPassword(dn: string, password: string, mustChange: boolean, unlock: boolean): Promise<void> {
    await this.ldap.modify(dn, [
      { op: 'replace', attr: 'unicodePwd', values: [unicodePwd(password)] },
      ...(mustChange ? [{ op: 'replace' as const, attr: 'pwdLastSet', values: ['0'] }] : []),
      ...(unlock ? [{ op: 'replace' as const, attr: 'lockoutTime', values: ['0'] }] : []),
    ]);
  }

  async setEnabled(e: Entry, enabled: boolean): Promise<void> {
    const uac = int(e, 'userAccountControl') ?? UAC.normal;
    const next = enabled ? uac & ~UAC.disabled : uac | UAC.disabled;
    if (next !== uac)
      await this.ldap.modify(e.dn, [{ op: 'replace', attr: 'userAccountControl', values: [String(next)] }]);
  }

  async unlock(dn: string): Promise<void> {
    await this.ldap.modify(dn, [{ op: 'replace', attr: 'lockoutTime', values: ['0'] }]);
  }

  async photo(guid: string): Promise<Buffer | null> {
    return buf(await this.entryByGuid(guid, ['thumbnailPhoto']), 'thumbnailPhoto');
  }

  async setPhoto(dn: string, jpeg: Buffer | null): Promise<void> {
    await this.ldap.modify(dn, [{ op: 'replace', attr: 'thumbnailPhoto', values: jpeg ? [jpeg] : [] }]);
  }

  // ---- groups ----

  async createGroup(
    parent: string,
    g: {
      name: string;
      sam?: string | undefined;
      scope: 'global' | 'domainLocal' | 'universal';
      kind: 'security' | 'distribution';
      description?: string | null | undefined;
      mail?: string | null | undefined;
    },
  ): Promise<{ guid: string; dn: string }> {
    const dn = childDn(parent, 'CN', g.name);
    const groupType =
      (g.scope === 'global'
        ? GROUP_TYPE.global
        : g.scope === 'universal'
          ? GROUP_TYPE.universal
          : GROUP_TYPE.domainLocal) | (g.kind === 'security' ? GROUP_TYPE.security : 0);
    await this.ldap.add(dn, {
      objectClass: ['top', 'group'],
      sAMAccountName: [g.sam ?? g.name],
      // groupType is a signed 32-bit integer in AD
      groupType: [String(groupType | 0)],
      ...(g.description ? { description: [g.description] } : {}),
      ...(g.mail ? { mail: [g.mail] } : {}),
    });
    const created = await this.entryByDn(dn, ['objectGUID', 'objectSid']);
    if (!created) throw new PlatformError('request.not-found', { what: dn });
    const sid = sidOf(created);
    if (sid && g.kind === 'security') {
      await this.ldap.modify(dn, [
        { op: 'replace', attr: 'gidNumber', values: [String((await this.idBase()) + ridOf(sid))] },
      ]);
    }
    return { guid: guidOf(created), dn };
  }

  async members(groupDn: string): Promise<{ members: ObjectRef[]; truncated: boolean }> {
    const found = await this.ldap.search(this.domainDn, {
      scope: 'sub',
      filter: eq('memberOf', groupDn),
      attributes: ['objectGUID', 'objectClass', 'name'],
      sizeLimit: MAX_LIST + 1,
    });
    return {
      members: found
        .slice(0, MAX_LIST)
        .map((e) => ({ guid: guidOf(e), dn: e.dn, name: str(e, 'name') ?? rdnValue(e.dn), type: typeOf(e) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      truncated: found.length > MAX_LIST,
    };
  }

  async changeMembers(groupDn: string, add: string[], remove: string[]): Promise<void> {
    const mods: Mod[] = [];
    if (add.length) mods.push({ op: 'add', attr: 'member', values: add });
    if (remove.length) mods.push({ op: 'delete', attr: 'member', values: remove });
    await this.ldap.modify(groupDn, mods);
  }

  // ---- generic ----

  async move(dn: string, newParent: string, newName?: string): Promise<string> {
    const rdnType = /^([A-Za-z]+)=/.exec(dn)?.[1] ?? 'CN';
    const target = childDn(newParent, rdnType, newName ?? rdnValue(dn));
    if (target.toLowerCase() !== dn.toLowerCase()) await this.ldap.rename(dn, target);
    return target;
  }

  async delete(dn: string, recursive: boolean): Promise<void> {
    await this.ldap.del(dn, { tree: recursive });
  }

  async modify(dn: string, mods: Mod[]): Promise<void> {
    await this.ldap.modify(dn, mods);
  }

  async add(dn: string, attrs: Record<string, (string | Buffer)[]>): Promise<{ guid: string; dn: string }> {
    await this.ldap.add(dn, attrs);
    const created = await this.entryByDn(dn, ['objectGUID']);
    return { guid: created ? guidOf(created) : '', dn };
  }
}
