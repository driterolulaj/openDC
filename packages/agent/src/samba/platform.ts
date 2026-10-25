// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Platform objects a new domain (or a newly joined DC) needs, written to the local sam.ldb:
 *  - OU=OpenDC Service Accounts and OU=OpenDC Shadow Groups (OPEN-QUESTIONS Q14 default skeleton)
 *  - CN=OpenDC,CN=System with its containers and CN=Settings (directory-object-model.md §2)
 *  - the group "OpenDC Platform Services" and its delegations (ADR-0012 §2, tier 1):
 *      create/delete and full control of users, groups, computers, contacts and OUs below the domain head,
 *      an explicit deny of every write and extended right on OU=Domain Controllers and the DC accounts in it,
 *      full control of CN=OpenDC,CN=System
 *  - per DC: opendc-svc-<host> (API, member of the group) and opendc-watch-<host> (watcher: read +
 *    Replicating Directory Changes), with random passwords (ADR-0012 §3/§4)
 * Every step is idempotent so setup can be re-run after a failure.
 */
import { childDn, eq } from '@opendc/shared/ldap';
import { addRecord, first, modifyRecord, unicodePwd } from './ldif.ts';
import type { SambaLocal } from './local.ts';

export const SERVICE_OU = 'OpenDC Service Accounts';
export const SHADOW_OU = 'OpenDC Shadow Groups';
export const PLATFORM_GROUP = 'OpenDC Platform Services';
export const PLATFORM_GROUP_SAM = 'opendc-platform';

const PLATFORM_CONTAINERS = [
  ['Nodes'],
  ['RBAC'],
  ['Roles', 'RBAC'],
  ['Assignments', 'RBAC'],
  ['Policies'],
  ['UserTemplates'],
  ['SavedSearches'],
  ['ExtendedAttributes'],
  ['MFA'],
  ['APITokens'],
] as const;

/** Containers only platform services, Domain/Enterprise Admins and SYSTEM may read (object model §2). */
const CONFIDENTIAL = ['Settings', 'RBAC', 'MFA', 'APITokens'] as const;

/** Protected DACL for a confidential container (inheritance from CN=System blocked). */
export function confidentialDacl(groupSid: string): string {
  return `D:P(A;CI;GA;;;SY)(A;CI;GA;;;DA)(A;CI;GA;;;EA)(A;CI;GA;;;${groupSid})`;
}

/** schemaIDGUIDs of the classes the platform account administers (MS-ADSC). */
const CLASS_GUIDS = {
  user: 'bf967aba-0de6-11d0-a285-00aa003049e2',
  group: 'bf967a9c-0de6-11d0-a285-00aa003049e2',
  computer: 'bf967a86-0de6-11d0-a285-00aa003049e2',
  contact: '5cb41ed0-0e4c-11d0-a286-00aa003049e2',
  organizationalUnit: 'bf967aa5-0de6-11d0-a285-00aa003049e2',
} as const;
/** DS-Replication-Get-Changes (DirSync for the watcher). */
const GET_CHANGES = '1131f6aa-9c07-11d1-f79f-00c04fc2dcd2';

const UAC_NORMAL_NO_EXPIRY = 0x200 | 0x10000;
const GLOBAL_SECURITY_GROUP = -2147483646;

export interface ServiceAccount {
  name: string;
  sam: string;
  guid: string;
  dn: string;
  password: string;
}

/** Delegation ACEs (SDDL) for the platform group on the domain head. */
export function domainHeadAces(groupSid: string): string {
  const create = Object.values(CLASS_GUIDS)
    .map((g) => `(OA;CI;CCDC;${g};;${groupSid})`)
    .join('');
  const control = Object.values(CLASS_GUIDS)
    .map((g) => `(OA;CIIO;GA;;${g};${groupSid})`)
    .join('');
  return create + control;
}

export class PlatformBootstrap {
  readonly #s: SambaLocal;
  readonly #domainDn: string;

  constructor(samba: SambaLocal, domainDn: string) {
    this.#s = samba;
    this.#domainDn = domainDn;
  }

  get serviceOu(): string {
    return childDn(this.#domainDn, 'OU', SERVICE_OU);
  }

  get platformDn(): string {
    return childDn(childDn(this.#domainDn, 'CN', 'System'), 'CN', 'OpenDC');
  }

  async #ensure(dn: string, attrs: Record<string, string | string[]>): Promise<boolean> {
    if (await this.#s.exists(dn)) return false;
    await this.#s.add(addRecord(dn, attrs));
    return true;
  }

  /** Domain-wide objects; run once on the first DC (and harmlessly again on re-runs). */
  async domainObjects(settings: Record<string, unknown>): Promise<void> {
    await this.#ensure(this.serviceOu, {
      objectClass: 'organizationalUnit',
      description: 'OpenDC platform service accounts',
    });
    await this.#ensure(childDn(this.#domainDn, 'OU', SHADOW_OU), {
      objectClass: 'organizationalUnit',
      description: 'Groups OpenDC maintains automatically (password policy targeting)',
    });
    await this.#ensure(this.platformDn, { objectClass: 'container', description: 'OpenDC platform objects' });
    for (const [cn, parent] of PLATFORM_CONTAINERS) {
      const base = parent ? childDn(this.platformDn, 'CN', parent) : this.platformDn;
      await this.#ensure(childDn(base, 'CN', cn), { objectClass: 'container' });
    }
    const envelope = {
      schemaVersion: 1,
      kind: 'settings',
      rev: 1,
      updatedBy: { sid: 'S-1-5-18', name: 'opendc-setup', nodeGuid: '' },
      updatedAt: new Date().toISOString(),
      data: settings,
    };
    await this.#ensure(childDn(this.platformDn, 'CN', 'Settings'), {
      objectClass: 'msDS-App-Configuration',
      displayName: 'OpenDC settings',
      'msDS-Settings': `opendc:v1:${JSON.stringify(envelope)}`,
    });
    // RFC2307 GIDs for the default primary group and Domain Admins (ADR-0018: idBase + RID)
    const idBase = typeof settings.idBase === 'number' ? settings.idBase : 100_000;
    const domainSid = first(await this.#s.get(this.#domainDn, ['objectSid']), 'objectSid');
    for (const rid of [512, 513]) {
      const [g] = domainSid
        ? await this.#s.search(this.#domainDn, 'sub', eq('objectSid', `${domainSid}-${String(rid)}`), ['gidNumber'])
        : [];
      if (g && !first(g, 'gidNumber'))
        await this.#s.modify(
          modifyRecord(g.dn, [{ op: 'replace', attr: 'gidNumber', values: [String(idBase + rid)] }]),
        );
    }
    const groupDn = childDn(this.serviceOu, 'CN', PLATFORM_GROUP);
    const created = await this.#ensure(groupDn, {
      objectClass: 'group',
      sAMAccountName: PLATFORM_GROUP_SAM,
      groupType: String(GLOBAL_SECURITY_GROUP),
      description: 'OpenDC API service accounts (delegated directory administration, tier 1)',
    });
    const groupSid = first(await this.#s.get(groupDn, ['objectSid']), 'objectSid');
    if (!groupSid) throw new Error(`${groupDn} has no objectSid`);
    if (created || !(await this.#hasAce(this.#domainDn, groupSid))) {
      await this.#acl(this.#domainDn, domainHeadAces(groupSid));
      await this.#acl(childDn(this.#domainDn, 'OU', 'Domain Controllers'), `(D;CI;CCDCSWWPCRSDWDWODT;;;${groupSid})`);
      await this.#acl(this.platformDn, `(A;CI;GA;;;${groupSid})`);
    }
    for (const cn of CONFIDENTIAL) {
      const dn = childDn(this.platformDn, 'CN', cn);
      const sd = first(await this.#s.get(dn, ['nTSecurityDescriptor']), 'nTSecurityDescriptor') ?? '';
      if (!/D:P/.test(sd))
        await this.#s.modify(
          modifyRecord(dn, [{ op: 'replace', attr: 'nTSecurityDescriptor', values: [confidentialDacl(groupSid)] }]),
          ['sd_flags:1:4'],
        );
    }
  }

  async #hasAce(dn: string, sid: string): Promise<boolean> {
    const sd = first(await this.#s.get(dn, ['nTSecurityDescriptor']), 'nTSecurityDescriptor') ?? '';
    return sd.includes(sid);
  }

  async #acl(dn: string, sddl: string): Promise<void> {
    await this.#s.tool(['dsacl', 'set', '-H', this.#s.samDb, `--objectdn=${dn}`, `--sddl=${sddl}`]);
  }

  /** The API and watcher accounts of one DC (`host` = NetBIOS-safe short name, ≤ 15 characters). */
  async dcAccounts(host: string, passwords: { svc: string; watch: string }): Promise<ServiceAccount[]> {
    const h = host.toLowerCase();
    const svc = await this.#account(`opendc-svc-${h}`, `odcs-${h}`, passwords.svc, 'OpenDC API on ' + h);
    const watch = await this.#account(`opendc-watch-${h}`, `odcw-${h}`, passwords.watch, 'OpenDC watcher on ' + h);
    const groupDn = childDn(this.serviceOu, 'CN', PLATFORM_GROUP);
    const members = (await this.#s.get(groupDn, ['member']))?.attrs.get('member') ?? [];
    if (!members.some((m) => m.toLowerCase() === svc.dn.toLowerCase())) {
      await this.#s.modify(modifyRecord(groupDn, [{ op: 'add', attr: 'member', values: [svc.dn] }]));
    }
    const sid = first(await this.#s.get(watch.dn, ['objectSid']), 'objectSid');
    if (sid) await this.watchAccess(sid);
    return [svc, watch];
  }

  /**
   * What a watch account needs (ADR-0004; idempotent): DS-Replication-Get-Changes on the domain head for DirSync,
   * and read on CN=Deleted Objects, without which DirSync silently drops tombstones (deletions would go unseen).
   * Tombstones keep no secrets (unicodePwd and the other secret attributes are stripped on deletion).
   */
  async watchAccess(sid: string): Promise<string[]> {
    const changed: string[] = [];
    if (!(await this.#hasAce(this.#domainDn, sid))) {
      await this.#acl(this.#domainDn, `(OA;;CR;${GET_CHANGES};;${sid})`);
      changed.push('dirsync');
    }
    const deleted = childDn(this.#domainDn, 'CN', 'Deleted Objects');
    const sd = first(await this.#s.getDeleted(deleted, ['nTSecurityDescriptor']), 'nTSecurityDescriptor') ?? '';
    const dacl = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sd);
    if (dacl && !sd.includes(sid)) {
      const sddl = `D:${dacl[1] ?? ''}${dacl[2] ?? ''}(A;;LCRP;;;${sid})`;
      await this.#s.modify(modifyRecord(deleted, [{ op: 'replace', attr: 'nTSecurityDescriptor', values: [sddl] }]), [
        'show_deleted:1',
        'sd_flags:1:4',
      ]);
      changed.push('deleted-objects');
    }
    return changed;
  }

  async #account(cn: string, sam: string, password: string, description: string): Promise<ServiceAccount> {
    const found = await this.#s.search(this.#domainDn, 'sub', eq('sAMAccountName', sam), ['objectGUID']);
    let dn: string;
    if (found[0]) {
      // re-run or re-join of the same host: the old password is unknown, so set a new one
      dn = found[0].dn;
      await this.#s.modify(
        modifyRecord(dn, [
          { op: 'replace', attr: 'unicodePwd', values: [unicodePwd(password)] },
          { op: 'replace', attr: 'userAccountControl', values: [String(UAC_NORMAL_NO_EXPIRY)] },
        ]),
      );
    } else {
      dn = childDn(this.serviceOu, 'CN', cn);
      await this.#s.add(
        addRecord(dn, {
          objectClass: 'user',
          sAMAccountName: sam,
          displayName: cn,
          description,
          userAccountControl: String(UAC_NORMAL_NO_EXPIRY),
          unicodePwd: unicodePwd(password),
        }),
      );
    }
    const guid = first(await this.#s.get(dn, ['objectGUID']), 'objectGUID');
    if (!guid) throw new Error(`${dn} has no objectGUID`);
    return { name: cn, sam, guid, dn, password };
  }
}
