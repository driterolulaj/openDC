// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mapping between AD entries and the API's directory objects (packages/shared/src/api/directory.ts):
 * attribute sets per type, AD time formats, userAccountControl/groupType bits, tier-0 detection.
 */
import type { Entry } from 'ldapts';
import type { ListItem, ObjectRef, ObjectType } from '@opendc/shared/api';
import {
  guidFromBytes,
  parentDn,
  parseDn,
  PROTECTED_BUILTIN_SIDS,
  sidFromBytes,
  WELL_KNOWN_RIDS,
} from '@opendc/shared/ldap';

export const UAC = {
  disabled: 0x2,
  passwordNotRequired: 0x20,
  normal: 0x200,
  workstationTrust: 0x1000,
  serverTrust: 0x2000,
  dontExpirePassword: 0x10000,
} as const;
/** msDS-User-Account-Control-Computed */
export const UAC_COMPUTED = { lockout: 0x10, passwordExpired: 0x800000 } as const;
export const GROUP_TYPE = {
  builtin: 0x1,
  global: 0x2,
  domainLocal: 0x4,
  universal: 0x8,
  security: 0x80000000,
} as const;

/** AD "never" values for FILETIME attributes. */
const NEVER = new Set(['0', '9223372036854775807']);
const EPOCH_DIFF_MS = 11_644_473_600_000n;

export function filetimeToIso(v: string | null): string | null {
  if (!v || NEVER.has(v) || !/^\d+$/.test(v)) return null;
  const ms = BigInt(v) / 10_000n - EPOCH_DIFF_MS;
  return new Date(Number(ms)).toISOString();
}

export function isoToFiletime(iso: string | null): string {
  if (iso === null) return '0';
  const ms = BigInt(new Date(iso).getTime());
  return String((ms + EPOCH_DIFF_MS) * 10_000n);
}

/** "20261024235555.0Z" -> ISO */
export function generalizedToIso(v: string | null): string | null {
  const m = v ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(v) : null;
  if (!m) return null;
  return new Date(
    Date.UTC(+(m[1] ?? 0), +(m[2] ?? 1) - 1, +(m[3] ?? 1), +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)),
  ).toISOString();
}

export function str(e: Entry, attr: string): string | null {
  const v = e[attr];
  const x = Array.isArray(v) ? v[0] : v;
  if (x === undefined) return null;
  return Buffer.isBuffer(x) ? x.toString('utf8') : x;
}

export function strs(e: Entry, attr: string): string[] {
  const v = e[attr];
  const arr = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return arr.map((x) => (Buffer.isBuffer(x) ? x.toString('utf8') : x));
}

export function int(e: Entry, attr: string): number | null {
  const s = str(e, attr);
  if (s === null || !/^-?\d+$/.test(s)) return null;
  return Number(s);
}

export function buf(e: Entry, attr: string): Buffer | null {
  const v = e[attr];
  const x = Array.isArray(v) ? v[0] : v;
  return Buffer.isBuffer(x) ? x : null;
}

export function bufs(e: Entry, attr: string): Buffer[] {
  const v = e[attr];
  const arr = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return arr.filter((x): x is Buffer => Buffer.isBuffer(x));
}

export const guidOf = (e: Entry): string => {
  const b = buf(e, 'objectGUID');
  return b ? guidFromBytes(b) : '';
};
export const sidOf = (e: Entry): string | null => {
  const b = buf(e, 'objectSid');
  return b ? sidFromBytes(b) : null;
};

/** The RDN value of a DN ("CN=Alice Smith,OU=Staff,..." -> "Alice Smith"). */
export function rdnValue(dn: string): string {
  try {
    return parseDn(dn)[0]?.[0]?.value ?? dn;
  } catch {
    return dn;
  }
}

export function typeOf(e: Entry): ObjectType | 'other' {
  const classes = strs(e, 'objectClass').map((c) => c.toLowerCase());
  if (classes.includes('computer')) return 'computer';
  if (classes.includes('user')) return 'user';
  if (classes.includes('group')) return 'group';
  if (classes.includes('contact')) return 'contact';
  if (classes.includes('organizationalunit')) return 'ou';
  if (classes.includes('container') || classes.includes('builtindomain') || classes.includes('lostandfound'))
    return 'container';
  return 'other';
}

export const COMMON_ATTRS = [
  'objectClass',
  'objectGUID',
  'objectSid',
  'distinguishedName',
  'name',
  'description',
  'whenCreated',
  'whenChanged',
  'uSNChanged',
  'adminCount',
  'isCriticalSystemObject',
];

export const USER_ATTRS = [
  ...COMMON_ATTRS,
  'sAMAccountName',
  'userPrincipalName',
  'givenName',
  'sn',
  'initials',
  'displayName',
  'mail',
  'telephoneNumber',
  'mobile',
  'title',
  'department',
  'company',
  'physicalDeliveryOfficeName',
  'streetAddress',
  'l',
  'postalCode',
  'c',
  'employeeID',
  'manager',
  'accountExpires',
  'homeDirectory',
  'homeDrive',
  'profilePath',
  'scriptPath',
  'uidNumber',
  'gidNumber',
  'loginShell',
  'unixHomeDirectory',
  'userAccountControl',
  'msDS-User-Account-Control-Computed',
  'pwdLastSet',
  'lastLogonTimestamp',
  'badPwdCount',
  'memberOf',
  'primaryGroupID',
  'thumbnailPhoto',
];

export const GROUP_ATTRS = [
  ...COMMON_ATTRS,
  'sAMAccountName',
  'mail',
  'groupType',
  'gidNumber',
  'managedBy',
  'memberOf',
];
export const COMPUTER_ATTRS = [
  ...COMMON_ATTRS,
  'sAMAccountName',
  'dNSHostName',
  'operatingSystem',
  'operatingSystemVersion',
  'location',
  'managedBy',
  'userAccountControl',
  'lastLogonTimestamp',
  'memberOf',
  'primaryGroupID',
];
export const CONTACT_ATTRS = [
  ...COMMON_ATTRS,
  'givenName',
  'sn',
  'displayName',
  'mail',
  'telephoneNumber',
  'mobile',
  'company',
  'title',
  'department',
  'memberOf',
];
export const CONTAINER_ATTRS = [...COMMON_ATTRS, 'systemFlags'];
export const LIST_ATTRS = [
  ...COMMON_ATTRS,
  'sAMAccountName',
  'displayName',
  'mail',
  'userAccountControl',
  'msDS-User-Account-Control-Computed',
];
export const ALL_ATTRS = [
  ...new Set([...USER_ATTRS, ...GROUP_ATTRS, ...COMPUTER_ATTRS, ...CONTACT_ATTRS, 'systemFlags']),
];

/** API field <-> LDAP attribute for user string fields. */
export const USER_STRING_FIELDS = {
  givenName: 'givenName',
  sn: 'sn',
  initials: 'initials',
  displayName: 'displayName',
  description: 'description',
  mail: 'mail',
  telephoneNumber: 'telephoneNumber',
  mobile: 'mobile',
  title: 'title',
  department: 'department',
  company: 'company',
  office: 'physicalDeliveryOfficeName',
  streetAddress: 'streetAddress',
  city: 'l',
  postalCode: 'postalCode',
  country: 'c',
  employeeId: 'employeeID',
  userPrincipalName: 'userPrincipalName',
  homeDirectory: 'homeDirectory',
  homeDrive: 'homeDrive',
  profilePath: 'profilePath',
  scriptPath: 'scriptPath',
  loginShell: 'loginShell',
  unixHomeDirectory: 'unixHomeDirectory',
} as const;
export const USER_INT_FIELDS = { uidNumber: 'uidNumber', gidNumber: 'gidNumber' } as const;

/** ETag: the object's uSNChanged on the DC this API talks to (writes go to the same DC). */
export const etagOf = (e: Entry): string => str(e, 'uSNChanged') ?? '0';

/** SIDs whose members are tier 0 (AdminSDHolder protected groups and accounts). */
export function protectedSids(domainSid: string): Set<string> {
  return new Set([
    ...[
      WELL_KNOWN_RIDS.administrator,
      WELL_KNOWN_RIDS.krbtgt,
      WELL_KNOWN_RIDS.domainAdmins,
      WELL_KNOWN_RIDS.domainControllers,
      WELL_KNOWN_RIDS.schemaAdmins,
      WELL_KNOWN_RIDS.enterpriseAdmins,
      WELL_KNOWN_RIDS.readOnlyDomainControllers,
    ].map((r) => `${domainSid}-${String(r)}`),
    ...PROTECTED_BUILTIN_SIDS,
  ]);
}

/**
 * Tier 0: adminCount=1 (set by SDProp), a protected SID itself, or (when tokenGroups was read) transitive
 * membership in a protected group. The last check closes the window before the next SDProp run.
 */
export function isProtectedEntry(e: Entry, protectedSet: Set<string>): boolean {
  if (str(e, 'adminCount') === '1') return true;
  const sid = sidOf(e);
  if (sid && protectedSet.has(sid)) return true;
  if (typeOf(e) === 'computer' && ((int(e, 'userAccountControl') ?? 0) & UAC.serverTrust) !== 0) return true;
  return bufs(e, 'tokenGroups').some((b) => protectedSet.has(sidFromBytes(b)));
}

export function listItemOf(e: Entry, protectedSet: Set<string>): ListItem {
  const type = typeOf(e);
  const uac = int(e, 'userAccountControl');
  const computed = int(e, 'msDS-User-Account-Control-Computed') ?? 0;
  const account = type === 'user' || type === 'computer';
  return {
    guid: guidOf(e),
    dn: e.dn,
    type,
    name: str(e, 'name') ?? rdnValue(e.dn),
    sam: str(e, 'sAMAccountName'),
    displayName: str(e, 'displayName'),
    mail: str(e, 'mail'),
    description: str(e, 'description'),
    enabled: account && uac !== null ? (uac & UAC.disabled) === 0 : null,
    locked: account ? (computed & UAC_COMPUTED.lockout) !== 0 : null,
    protected: isProtectedEntry(e, protectedSet),
    parentDn: parentDn(e.dn) ?? '',
    whenChanged: generalizedToIso(str(e, 'whenChanged')),
  };
}

/** A reference whose GUID is resolved later (refs are built from DN-valued attributes). */
export function refOf(dn: string, guids: Map<string, { guid: string; type: ObjectRef['type'] }>): ObjectRef {
  const r = guids.get(dn.toLowerCase());
  return { guid: r?.guid ?? '', dn, name: rdnValue(dn), type: r?.type ?? 'other' };
}

export { parentDn };
