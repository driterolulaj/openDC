// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Directory administration API (ROADMAP Phase 2): users, groups, computers, contacts, OUs/containers.
 * Objects are addressed by objectGUID. Times are ISO-8601 strings; "never" is null. Browser-safe.
 */
import { z } from 'zod';

export const objectTypes = ['user', 'group', 'computer', 'contact', 'ou', 'container'] as const;
export type ObjectType = (typeof objectTypes)[number];

const guid = z.uuid();
const optText = (max: number) => z.string().max(max).nullable();

export const objectRef = z.object({
  guid: z.string(),
  dn: z.string(),
  name: z.string(),
  type: z.enum([...objectTypes, 'other']),
});
export type ObjectRef = z.infer<typeof objectRef>;

/** Common to every object: identity, location, timestamps, tier-0 flag and the concurrency token. */
const base = {
  guid: z.string(),
  dn: z.string(),
  parentDn: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  whenCreated: z.string().nullable(),
  whenChanged: z.string().nullable(),
  /** Protected (tier 0): AdminSDHolder territory. Changing it needs a tier-0 role and typed confirmation. */
  protected: z.boolean(),
  /** Pass back unchanged in PATCH; a mismatch means someone else changed the object (409). */
  etag: z.string(),
};

/** Editable user attributes (PATCH body and create fields); null clears an attribute. */
export const userFields = {
  givenName: optText(64),
  sn: optText(64),
  initials: optText(6),
  displayName: optText(256),
  description: optText(1024),
  mail: z.email().max(256).nullable(),
  telephoneNumber: optText(64),
  mobile: optText(64),
  title: optText(128),
  department: optText(64),
  company: optText(64),
  office: optText(128),
  streetAddress: optText(1024),
  city: optText(128),
  postalCode: optText(40),
  country: z.string().length(2).nullable(),
  employeeId: optText(16),
  userPrincipalName: z
    .string()
    .max(256)
    .regex(/^[^@\s]+@[^@\s]+$/, 'user@domain')
    .nullable(),
  /** objectGUID of the manager, or null. */
  manager: guid.nullable(),
  /** ISO date-time when the account expires, or null (never). */
  accountExpires: z.iso.datetime({ offset: true }).nullable(),
  homeDirectory: optText(256),
  homeDrive: z
    .string()
    .regex(/^[A-Z]:$/)
    .nullable(),
  profilePath: optText(256),
  scriptPath: optText(256),
  uidNumber: z.number().int().min(1000).max(2_147_483_647).nullable(),
  gidNumber: z.number().int().min(1000).max(2_147_483_647).nullable(),
  loginShell: optText(128),
  unixHomeDirectory: optText(256),
};

export const user = z.object({
  ...base,
  type: z.literal('user'),
  sid: z.string(),
  sam: z.string(),
  givenName: z.string().nullable(),
  sn: z.string().nullable(),
  initials: z.string().nullable(),
  displayName: z.string().nullable(),
  mail: z.string().nullable(),
  telephoneNumber: z.string().nullable(),
  mobile: z.string().nullable(),
  title: z.string().nullable(),
  department: z.string().nullable(),
  company: z.string().nullable(),
  office: z.string().nullable(),
  streetAddress: z.string().nullable(),
  city: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string().nullable(),
  employeeId: z.string().nullable(),
  userPrincipalName: z.string().nullable(),
  manager: objectRef.nullable(),
  accountExpires: z.string().nullable(),
  homeDirectory: z.string().nullable(),
  homeDrive: z.string().nullable(),
  profilePath: z.string().nullable(),
  scriptPath: z.string().nullable(),
  uidNumber: z.number().nullable(),
  gidNumber: z.number().nullable(),
  loginShell: z.string().nullable(),
  unixHomeDirectory: z.string().nullable(),
  enabled: z.boolean(),
  locked: z.boolean(),
  passwordExpired: z.boolean(),
  passwordNeverExpires: z.boolean(),
  mustChangePassword: z.boolean(),
  passwordLastSet: z.string().nullable(),
  lastLogon: z.string().nullable(),
  badPasswordCount: z.number(),
  memberOf: z.array(objectRef),
  primaryGroup: objectRef.nullable(),
  hasPhoto: z.boolean(),
});
export type User = z.infer<typeof user>;

export const groupScopes = ['global', 'domainLocal', 'universal'] as const;
export const groupKinds = ['security', 'distribution'] as const;

export const group = z.object({
  ...base,
  type: z.literal('group'),
  sid: z.string(),
  sam: z.string(),
  mail: z.string().nullable(),
  scope: z.enum([...groupScopes, 'builtin']),
  kind: z.enum(groupKinds),
  gidNumber: z.number().nullable(),
  managedBy: objectRef.nullable(),
  memberCount: z.number(),
  memberOf: z.array(objectRef),
});
export type Group = z.infer<typeof group>;

export const computer = z.object({
  ...base,
  type: z.literal('computer'),
  sid: z.string(),
  sam: z.string(),
  dnsHostName: z.string().nullable(),
  operatingSystem: z.string().nullable(),
  operatingSystemVersion: z.string().nullable(),
  location: z.string().nullable(),
  managedBy: objectRef.nullable(),
  enabled: z.boolean(),
  isDc: z.boolean(),
  lastLogon: z.string().nullable(),
  memberOf: z.array(objectRef),
});
export type Computer = z.infer<typeof computer>;

export const contact = z.object({
  ...base,
  type: z.literal('contact'),
  givenName: z.string().nullable(),
  sn: z.string().nullable(),
  displayName: z.string().nullable(),
  mail: z.string().nullable(),
  telephoneNumber: z.string().nullable(),
  mobile: z.string().nullable(),
  company: z.string().nullable(),
  title: z.string().nullable(),
  department: z.string().nullable(),
  memberOf: z.array(objectRef),
});
export type Contact = z.infer<typeof contact>;

export const container = z.object({
  ...base,
  type: z.enum(['ou', 'container']),
  hasChildren: z.boolean(),
  /** System containers (CN=System, Builtin, ...) can't be renamed or deleted from the console. */
  system: z.boolean(),
});
export type Container = z.infer<typeof container>;

export const directoryObject = z.discriminatedUnion('type', [user, group, computer, contact, container]);
export type DirectoryObject = z.infer<typeof directoryObject>;

// ---- list / search ----

/** A row in a list: enough to render tables without loading every object. */
export const listItem = z.object({
  guid: z.string(),
  dn: z.string(),
  type: z.enum([...objectTypes, 'other']),
  name: z.string(),
  sam: z.string().nullable(),
  displayName: z.string().nullable(),
  mail: z.string().nullable(),
  description: z.string().nullable(),
  enabled: z.boolean().nullable(),
  locked: z.boolean().nullable(),
  protected: z.boolean(),
  parentDn: z.string(),
  whenChanged: z.string().nullable(),
});
export type ListItem = z.infer<typeof listItem>;

export const listQuery = z.strictObject({
  /** Container to list (objectGUID); default: the domain head. */
  base: guid.optional(),
  scope: z.enum(['one', 'sub']).default('sub'),
  types: z
    .string()
    .regex(/^[a-z,]+$/)
    .optional(),
  /** Free text: matches name, sAMAccountName, display name, mail (substring). */
  q: z.string().max(128).optional(),
  status: z.enum(['enabled', 'disabled', 'locked', 'expired']).optional(),
  sort: z.enum(['name', 'sam', 'whenChanged']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
export type ListQuery = z.input<typeof listQuery>;

export const listResponse = z.object({
  items: z.array(listItem),
  total: z.number(),
  /** The search hit the server-side cap; refine the query. */
  truncated: z.boolean(),
});
export type ListResponse = z.infer<typeof listResponse>;

export const guidParams = z.strictObject({ guid });

// ---- writes ----

const editableUser = z.strictObject(userFields).partial();

export const userCreate = editableUser.extend({
  /** OU/container to create in (objectGUID); default: the template's or CN=Users. */
  parent: guid.optional(),
  templateId: z.uuid().optional(),
  sam: z
    .string()
    .min(1)
    .max(20)
    .regex(/^[^"/\\[\]:;|=,+*?<>@\s]+$/, 'sAMAccountName characters'),
  /** RDN value (cn); default: display name, else "<givenName> <sn>", else sam. */
  cn: z.string().min(1).max(64).optional(),
  /** Initial password; omitted: the API generates one and returns it once. */
  password: z.string().min(1).max(256).optional(),
  mustChangePassword: z.boolean().default(true),
  enabled: z.boolean().default(true),
  /** Group objectGUIDs to add the new user to. */
  groups: z.array(guid).max(200).default([]),
});
export type UserCreate = z.input<typeof userCreate>;

export const userPatch = editableUser.extend({ etag: z.string().max(64).optional() });
export type UserPatch = z.input<typeof userPatch>;

export const passwordReset = z.strictObject({
  /** omitted: generate one and return it once */
  password: z.string().min(1).max(256).optional(),
  mustChangePassword: z.boolean().default(true),
  unlock: z.boolean().default(true),
  /** Tier-0 targets: the target's sAMAccountName, typed by the user. */
  confirm: z.string().max(256).optional(),
});

export const accountAction = z.strictObject({
  action: z.enum(['enable', 'disable', 'unlock']),
  confirm: z.string().max(256).optional(),
});

export const moveRequest = z.strictObject({
  /** Target OU/container objectGUID. */
  parent: guid,
  /** New RDN value (rename), optional. */
  name: z.string().min(1).max(64).optional(),
});

export const groupCreate = z.strictObject({
  parent: guid.optional(),
  name: z.string().min(1).max(64),
  sam: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^"/\\[\]:;|=,+*?<>@]+$/)
    .optional(),
  scope: z.enum(groupScopes).default('global'),
  kind: z.enum(groupKinds).default('security'),
  description: optText(1024).optional(),
  mail: z.email().max(256).nullable().optional(),
  members: z.array(guid).max(1000).default([]),
});
export const groupPatch = z.strictObject({
  etag: z.string().max(64).optional(),
  description: optText(1024).optional(),
  mail: z.email().max(256).nullable().optional(),
  managedBy: guid.nullable().optional(),
  scope: z.enum(groupScopes).optional(),
  kind: z.enum(groupKinds).optional(),
  gidNumber: z.number().int().min(1000).max(2_147_483_647).nullable().optional(),
});
export const membersChange = z.strictObject({
  add: z.array(guid).max(1000).default([]),
  remove: z.array(guid).max(1000).default([]),
  confirm: z.string().max(256).optional(),
});
export const membersResponse = z.object({ members: z.array(objectRef), truncated: z.boolean() });

export const computerPatch = z.strictObject({
  etag: z.string().max(64).optional(),
  description: optText(1024).optional(),
  location: optText(256).optional(),
  managedBy: guid.nullable().optional(),
});

export const contactCreate = z.strictObject({
  parent: guid.optional(),
  cn: z.string().min(1).max(64),
  givenName: optText(64).optional(),
  sn: optText(64).optional(),
  displayName: optText(256).optional(),
  description: optText(1024).optional(),
  mail: z.email().max(256).nullable().optional(),
  telephoneNumber: optText(64).optional(),
  mobile: optText(64).optional(),
  company: optText(64).optional(),
  title: optText(128).optional(),
  department: optText(64).optional(),
});
export const contactPatch = contactCreate.omit({ parent: true, cn: true }).extend({
  etag: z.string().max(64).optional(),
});

export const ouCreate = z.strictObject({
  parent: guid.optional(),
  name: z.string().min(1).max(64),
  description: optText(1024).optional(),
});
export const ouPatch = z.strictObject({
  etag: z.string().max(64).optional(),
  description: optText(1024).optional(),
});

export const deleteRequest = z.strictObject({
  /** Delete an OU with everything in it (tree delete). */
  recursive: z.boolean().default(false),
  confirm: z.string().max(256).optional(),
});

/** Results that may carry a generated password (shown once, never stored or logged). */
export const createdResponse = z.object({
  guid: z.string(),
  dn: z.string(),
  generatedPassword: z.string().nullable(),
});
export const passwordResponse = z.object({ generatedPassword: z.string().nullable() });

export const treeResponse = z.object({ items: z.array(container) });

export const domainInfo = z.object({
  domain: z.string(),
  netbios: z.string().nullable(),
  domainDn: z.string(),
  domainSid: z.string(),
  forestLevel: z.string().nullable(),
  domainLevel: z.string().nullable(),
  idBase: z.number(),
  dcs: z.array(
    z.object({
      name: z.string(),
      dnsHostName: z.string().nullable(),
      site: z.string().nullable(),
      readOnly: z.boolean(),
      guid: z.string(),
      os: z.string().nullable(),
    }),
  ),
  fsmo: z.array(z.object({ role: z.string(), owner: z.string().nullable() })),
  headGuid: z.string(),
  usersGuid: z.string().nullable(),
  computersGuid: z.string().nullable(),
});
export type DomainInfo = z.infer<typeof domainInfo>;

/** Object history: audit entries about one object, with their before/after diffs (no secrets). */
export const objectHistory = z.object({
  entries: z.array(
    z.object({
      originNodeId: z.string(),
      seq: z.number(),
      ts: z.string(),
      actor: z.string(),
      actorSid: z.string().nullable(),
      sourceIp: z.string().nullable(),
      action: z.string(),
      result: z.string(),
      targetGuid: z.string().nullable(),
      targetDn: z.string().nullable(),
      requestId: z.string().nullable(),
      before: z.unknown(),
      after: z.unknown(),
    }),
  ),
});
