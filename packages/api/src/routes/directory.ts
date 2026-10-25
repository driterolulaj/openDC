// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /api/v1/directory: users, groups, computers, contacts, OUs (ROADMAP Phase 2).
 *
 * Authorization per object: the permission for the object type, scoped by the object's DN (or the parent's
 * for creation), and the tier-0 guard for protected objects (RBAC engine). Tier-0 writes can't go through
 * the delegated platform account (SDProp protects those objects), so they go to the agent's
 * samba.protectedObject.modify with a typed confirmation (the object's account name). Every write is audited
 * with a before/after diff; passwords never appear in responses (except a generated one, once), logs or the
 * audit log.
 */
import { PlatformError } from '@opendc/shared';
import {
  accountAction,
  computerPatch,
  contactCreate,
  contactPatch,
  createdResponse,
  deleteRequest,
  directoryObject,
  domainInfo,
  empty,
  groupCreate,
  groupPatch,
  guidParams,
  listQuery,
  listResponse,
  membersChange,
  membersResponse,
  moveRequest,
  ouCreate,
  ouPatch,
  passwordReset,
  passwordResponse,
  treeResponse,
  userCreate,
  userPatch,
  type ObjectType,
  objectHistory,
} from '@opendc/shared/api';
import { mintConfirmation, type AgentClient, type OpArgs } from '@opendc/shared/agent';
import { childDn, domainFromDn, eq, isWithin } from '@opendc/shared/ldap';
import { z } from 'zod';
import type { Entry } from 'ldapts';
import type { AuditLog } from '../audit.ts';
import type { RouteContext, RouteTable } from '../http/route.ts';
import type { RbacEngine, Scope } from '../rbac/engine.ts';
import type { Session } from '../sessions.ts';
import { DirectoryService, generatePassword } from '../directory/service.ts';
import { guidOf, int, rdnValue, str, typeOf, UAC } from '../directory/model.ts';
import type { Mod } from '../directory/ldap.ts';
import type { UserTemplates } from '../directory/templates.ts';

export interface DirectoryDeps {
  directory: () => DirectoryService;
  audit: AuditLog;
  agent: Pick<AgentClient, 'call'> | null;
  confirmKey: Buffer;
  engineFor(domainSid: string): RbacEngine;
  templates: UserTemplates;
}

type Ctx = RouteContext<unknown, unknown, unknown>;

const PERM: Record<ObjectType, { read: string; write: string; create: string; delete: string }> = {
  user: {
    read: 'domain.users.read',
    write: 'domain.users.write',
    create: 'domain.users.create',
    delete: 'domain.users.delete',
  },
  group: {
    read: 'domain.groups.read',
    write: 'domain.groups.write',
    create: 'domain.groups.create',
    delete: 'domain.groups.delete',
  },
  computer: {
    read: 'domain.computers.read',
    write: 'domain.computers.write',
    create: 'domain.computers.write',
    delete: 'domain.computers.delete',
  },
  contact: {
    read: 'domain.contacts.read',
    write: 'domain.contacts.write',
    create: 'domain.contacts.write',
    delete: 'domain.contacts.write',
  },
  ou: { read: 'domain.ous.read', write: 'domain.ous.write', create: 'domain.ous.write', delete: 'domain.ous.delete' },
  container: {
    read: 'domain.ous.read',
    write: 'domain.ous.write',
    create: 'domain.ous.write',
    delete: 'domain.ous.delete',
  },
};

const permFor = (type: ObjectType | 'other', kind: keyof (typeof PERM)['user']): string => {
  if (type === 'other') throw new PlatformError('directory.unsupported', { what: 'This object type' });
  return PERM[type][kind];
};

const photoBody = z.strictObject({ jpeg: z.base64().max(140_000).nullable() });
const historyQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(500).optional() });

/** Subtree bases where the session holds `permission`; null = the whole domain. */
function readableBases(engine: RbacEngine, s: Session, permission: string): string[] | null {
  const e = engine.effective({ sid: s.sid, groupSids: s.groupSids }).find((p) => p.permission === permission);
  if (!e) return [];
  if (e.scopes.some((x: Scope) => x.kind === 'domain')) return null;
  return e.scopes.filter((x): x is Extract<Scope, { kind: 'subtree' }> => x.kind === 'subtree').map((x) => x.dn);
}

export function directoryRoutes(t: RouteTable, d: DirectoryDeps): void {
  const actor = (c: Ctx): { name: string; sid: string; via: 'api' } => ({
    name: c.user.username,
    sid: c.user.sid,
    via: 'api',
  });

  const audit = (
    c: Ctx,
    action: string,
    target: { guid?: string; dn?: string },
    before?: unknown,
    after?: unknown,
    result: 'success' | 'failure' = 'success',
  ): void => {
    d.audit.append({
      actor: c.user.username,
      actorSid: c.user.sid,
      sourceIp: c.ip,
      action,
      result,
      ...(target.guid ? { targetGuid: target.guid } : {}),
      ...(target.dn ? { targetDn: target.dn } : {}),
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      requestId: c.requestId,
    });
  };

  /** Loads the object, checks `kind` permission on it and the tier-0 guard. */
  const target = async (
    c: Ctx,
    guid: string,
    kind: 'read' | 'write' | 'delete',
    expect?: ObjectType[],
  ): Promise<{ e: Entry; type: ObjectType; protected: boolean }> => {
    const dir = d.directory();
    const e = await dir.entryByGuid(guid, undefined, true);
    const type = typeOf(e);
    if (type === 'other' || (expect && !expect.includes(type)))
      throw new PlatformError('request.not-found', { what: `${expect?.join('/') ?? 'Object'} ${guid}` });
    const prot = dir.isProtected(e);
    c.require(permFor(type, kind), {
      dn: e.dn,
      protected: kind !== 'read' && prot,
      label: str(e, 'sAMAccountName') ?? e.dn,
    });
    return { e, type, protected: prot };
  };

  /** Tier-0 change through the agent: typed confirmation = the target's account name (or RDN). */
  const viaAgent = async (
    c: Ctx,
    e: Entry,
    change: OpArgs<'samba.protectedObject.modify'>['change'],
    confirm: string | undefined,
  ): Promise<void> => {
    if (!d.agent)
      throw new PlatformError('agent.unreachable', { socket: '(not configured)', reason: 'no agent socket' });
    const phrase = str(e, 'sAMAccountName') ?? rdnValue(e.dn);
    if ((confirm ?? '').trim().toLowerCase() !== phrase.toLowerCase())
      throw new PlatformError('agent.confirmation-required', { op: 'samba.protectedObject.modify' });
    const args = { targetGuid: guidOf(e), change };
    const confirmation = mintConfirmation(d.confirmKey, {
      op: 'samba.protectedObject.modify',
      args,
      actor: c.user.sid,
    });
    await d.agent.call('samba.protectedObject.modify', args, { actor: actor(c), confirmation, timeoutMs: 300_000 });
  };

  const checkEtag = (e: Entry, etag: string | undefined): void => {
    if (etag !== undefined && etag !== (str(e, 'uSNChanged') ?? '0'))
      throw new PlatformError('request.conflict', { what: rdnValue(e.dn) });
  };

  // ---------------- domain, tree, lists ----------------

  t.add({
    method: 'GET',
    url: '/api/v1/directory/info',
    operationId: 'getDomainInfo',
    summary: 'Domain overview: name, SID, levels, DCs, FSMO roles',
    tags: ['directory'],
    auth: { permission: 'domain.info.read' },
    response: domainInfo,
    handler: async (c) => {
      const dir = d.directory();
      const head = await dir.entryByDn(dir.domainDn, ['objectGUID', 'msDS-Behavior-Version', 'nETBIOSName']);
      // single-domain forest: the configuration NC sits below the domain head's DN
      const partitions = childDn(childDn(dir.domainDn, 'CN', 'Configuration'), 'CN', 'Partitions');
      const [users, computers] = await Promise.all([
        dir.entryByDn(childDn(dir.domainDn, 'CN', 'Users'), ['objectGUID']),
        dir.entryByDn(childDn(dir.domainDn, 'CN', 'Computers'), ['objectGUID']),
      ]);
      const dcEntries = await dir.ldap.search(childDn(dir.domainDn, 'OU', 'Domain Controllers'), {
        scope: 'sub',
        filter: eq('objectClass', 'computer'),
        attributes: ['objectGUID', 'name', 'dNSHostName', 'operatingSystem', 'userAccountControl', 'msDS-SiteName'],
      });
      const levels: Record<string, string> = { '4': '2008_R2', '5': '2012', '6': '2012_R2', '7': '2016' };
      const fsmo = d.agent
        ? await d.agent.call('samba.fsmo.show', {}, { actor: actor(c) }).catch(() => ({ roles: [] }))
        : { roles: [] };
      const crossRef = await dir.ldap
        .search(partitions, { scope: 'one', filter: eq('nCName', dir.domainDn), attributes: ['nETBIOSName'] })
        .catch(() => []);
      const forest = await dir.ldap
        .search(partitions, { scope: 'base', attributes: ['msDS-Behavior-Version'] })
        .catch(() => []);
      return {
        domain: domainFromDn(dir.domainDn),
        netbios: crossRef[0] ? str(crossRef[0], 'nETBIOSName') : null,
        domainDn: dir.domainDn,
        domainSid: dir.domainSid,
        forestLevel: forest[0] ? (levels[str(forest[0], 'msDS-Behavior-Version') ?? ''] ?? null) : null,
        domainLevel: head ? (levels[str(head, 'msDS-Behavior-Version') ?? ''] ?? null) : null,
        idBase: await dir.idBase(),
        dcs: dcEntries.map((e) => ({
          name: str(e, 'name') ?? rdnValue(e.dn),
          dnsHostName: str(e, 'dNSHostName'),
          site: str(e, 'msDS-SiteName'),
          readOnly: ((int(e, 'userAccountControl') ?? 0) & 0x4000000) !== 0,
          guid: guidOf(e),
          os: str(e, 'operatingSystem'),
        })),
        fsmo: fsmo.roles.map((r) => ({ role: r.role, owner: r.ownerServer })),
        headGuid: head ? guidOf(head) : '',
        usersGuid: users ? guidOf(users) : null,
        computersGuid: computers ? guidOf(computers) : null,
      };
    },
  });

  t.add({
    method: 'GET',
    url: '/api/v1/directory/tree',
    operationId: 'getDirectoryTree',
    summary: 'OUs and containers below a container (default: the domain head)',
    tags: ['directory'],
    auth: { permission: 'domain.ous.read' },
    query: z.strictObject({ base: z.uuid().optional() }),
    response: treeResponse,
    handler: async (c) => {
      const dir = d.directory();
      const base = await dir.containerDn(c.query.base);
      const engine = d.engineFor(c.user.domainSid);
      const bases = readableBases(engine, c.user, 'domain.ous.read');
      // containers inside a readable subtree, plus the ancestors needed to navigate down to one
      const visible = (dn: string): boolean => bases === null || bases.some((b) => isWithin(dn, b) || isWithin(b, dn));
      if (!visible(base)) throw new PlatformError('auth.forbidden', { permission: 'domain.ous.read' });
      return { items: (await dir.tree(base)).filter((x) => visible(x.dn)) };
    },
  });

  t.add({
    method: 'GET',
    url: '/api/v1/directory/objects',
    operationId: 'listDirectoryObjects',
    summary: 'Search/list users, groups, computers, contacts and OUs (scoped to what the caller may read)',
    tags: ['directory'],
    auth: 'session',
    query: listQuery,
    response: listResponse,
    handler: async (c) => {
      const dir = d.directory();
      const engine = d.engineFor(c.user.domainSid);
      const types = (c.query.types ?? 'user,group,computer,contact,ou').split(',') as ObjectType[];
      const readable = types.filter((ty) => Object.hasOwn(PERM, ty) && engine.can(c.user, PERM[ty].read).allow);
      if (!readable.length) throw new PlatformError('auth.forbidden', { permission: 'domain.users.read' });
      const allBases = readable.map((ty) => readableBases(engine, c.user, PERM[ty].read));
      const bases = allBases.some((b) => b === null) ? null : [...new Set(allBases.flat() as string[])];
      const r = await dir.list({ ...c.query, types: readable.join(',') }, bases);
      // per item: the read permission of its type at its DN
      const items = r.items.filter(
        (i) => i.type !== 'other' && engine.can(c.user, permFor(i.type, 'read'), { dn: i.dn }).allow,
      );
      return { ...r, items, total: r.total - (r.items.length - items.length) };
    },
  });

  t.add({
    method: 'GET',
    url: '/api/v1/directory/objects/:guid',
    operationId: 'getDirectoryObject',
    summary: 'One object with all attributes the console shows',
    tags: ['directory'],
    auth: 'session',
    params: guidParams,
    response: directoryObject,
    handler: async (c) => {
      await target(c, c.params.guid, 'read');
      return (await d.directory().getObject(c.params.guid)).object;
    },
  });

  t.add({
    method: 'GET',
    url: '/api/v1/directory/objects/:guid/history',
    operationId: 'getDirectoryObjectHistory',
    summary: 'Audit entries about this object, newest first',
    tags: ['directory'],
    auth: { permission: 'core.audit.read' },
    params: guidParams,
    query: historyQuery,
    response: objectHistory,
    handler: async (c) => {
      await target(c, c.params.guid, 'read');
      return {
        entries: d.audit
          .list({ targetGuid: c.params.guid, limit: c.query.limit ?? 200 })
          .map(({ prevHash: _p, hash: _h, ...e }) => e),
      };
    },
  });

  t.add({
    method: 'DELETE',
    url: '/api/v1/directory/objects/:guid',
    operationId: 'deleteDirectoryObject',
    summary: 'Delete an object (OUs: recursively on request)',
    tags: ['directory'],
    auth: 'session',
    params: guidParams,
    body: deleteRequest,
    response: empty,
    handler: async (c) => {
      const { e, type, protected: prot } = await target(c, c.params.guid, 'delete');
      if (prot) throw new PlatformError('directory.unsupported', { what: `Deleting the protected object ${e.dn}` });
      if (str(e, 'isCriticalSystemObject') === 'TRUE')
        throw new PlatformError('directory.unsupported', { what: `Deleting the system object ${e.dn}` });
      if (c.body.recursive && type !== 'ou')
        throw new PlatformError('validation.invalid', { issues: 'recursive: only OUs can be deleted recursively' });
      if (c.body.recursive) {
        // everything below must be deletable by the caller as well
        const below = await d
          .directory()
          .ldap.search(e.dn, { scope: 'sub', attributes: ['objectClass', 'adminCount', 'objectSid'] });
        for (const b of below) {
          const bt = typeOf(b);
          if (bt === 'other') continue;
          c.require(permFor(bt, 'delete'), { dn: b.dn, protected: d.directory().isProtected(b) });
        }
      }
      await d.directory().delete(e.dn, c.body.recursive);
      audit(
        c,
        `directory.${type}.delete`,
        { guid: c.params.guid, dn: e.dn },
        { dn: e.dn, recursive: c.body.recursive },
      );
      return {};
    },
  });

  t.add({
    method: 'POST',
    url: '/api/v1/directory/objects/:guid/move',
    operationId: 'moveDirectoryObject',
    summary: 'Move and/or rename an object',
    tags: ['directory'],
    auth: 'session',
    params: guidParams,
    body: moveRequest,
    response: createdResponse,
    handler: async (c) => {
      const { e, type, protected: prot } = await target(c, c.params.guid, 'write');
      if (prot) throw new PlatformError('directory.unsupported', { what: `Moving the protected object ${e.dn}` });
      const dir = d.directory();
      const parent = await dir.containerDn(c.body.parent);
      c.require(permFor(type, 'create'), { dn: parent });
      c.require(permFor(type, 'delete'), { dn: e.dn });
      const dn = await dir.move(e.dn, parent, c.body.name);
      audit(c, `directory.${type}.move`, { guid: c.params.guid, dn }, { dn: e.dn }, { dn });
      return { guid: c.params.guid, dn, generatedPassword: null };
    },
  });

  // ---------------- users ----------------

  t.add({
    method: 'POST',
    url: '/api/v1/directory/users',
    operationId: 'createUser',
    summary: 'Create a user (RID-based POSIX IDs; a generated password is returned once)',
    tags: ['directory'],
    auth: { permission: 'domain.users.create' },
    body: userCreate,
    response: createdResponse,
    status: 201,
    handler: async (c) => {
      const dir = d.directory();
      // a template supplies defaults (placeholders expanded), its OU and groups; the request's values win
      const tpl = c.body.templateId ? await d.templates.resolve(c.body.templateId) : null;
      const body = tpl
        ? {
            ...c.body,
            ...Object.fromEntries(
              Object.entries(d.templates.expandFor(tpl.t, c.body)).filter(
                ([k]) => (c.body as Record<string, unknown>)[k] === undefined,
              ),
            ),
          }
        : c.body;
      const parent = await dir.containerDn(
        c.body.parent ?? tpl?.parent ?? undefined,
        childDn(dir.domainDn, 'CN', 'Users'),
      );
      c.require('domain.users.create', { dn: parent });
      const groups = [...(tpl?.t.groups ?? [])];
      for (const g of c.body.groups) {
        const ge = await dir.entryByGuid(g, undefined, true);
        if (typeOf(ge) !== 'group')
          throw new PlatformError('validation.invalid', { issues: `groups: ${g} is not a group` });
        c.require('domain.groups.members', { dn: ge.dn, protected: dir.isProtected(ge), label: rdnValue(ge.dn) });
        if (dir.isProtected(ge))
          throw new PlatformError('directory.unsupported', {
            what: 'Adding a new user to a protected group at creation',
          });
        groups.push(ge.dn);
      }
      const generated = c.body.password ? null : generatePassword();
      const r = await dir.createUser(parent, userCreate.parse(body), c.body.password ?? generated ?? '');
      for (const g of groups) await dir.changeMembers(g, [r.dn], []);
      const { password: _p, ...logged } = c.body;
      audit(c, 'directory.user.create', r, undefined, { ...logged, dn: r.dn });
      return { ...r, generatedPassword: generated };
    },
  });

  t.add({
    method: 'PATCH',
    url: '/api/v1/directory/users/:guid',
    operationId: 'updateUser',
    summary: 'Change user attributes (optimistic concurrency through etag)',
    tags: ['directory'],
    auth: 'session',
    params: guidParams,
    body: userPatch.extend({ confirm: z.string().max(256).optional() }),
    response: directoryObject,
    handler: async (c) => {
      const { e, protected: prot } = await target(c, c.params.guid, 'write', ['user']);
      checkEtag(e, c.body.etag);
      const { etag: _e, confirm, ...patch } = c.body;
      const { mods, before, after } = await d.directory().userMods(e, patch);
      if (mods.length) {
        if (prot) {
          const values: Record<string, string | null> = {};
          for (const m of mods) values[m.attr] = (m.values[0] as string | undefined) ?? null;
          await viaAgent(c, e, { kind: 'attributes', values }, confirm);
        } else await d.directory().modify(e.dn, mods);
        audit(c, 'directory.user.update', { guid: c.params.guid, dn: e.dn }, before, after);
      }
      return (await d.directory().getObject(c.params.guid)).object;
    },
  });

  t.add({
    method: 'POST',
    url: '/api/v1/directory/users/:guid/password',
    operationId: 'resetUserPassword',
    summary: 'Reset the password (generated one returned once), optionally unlock and force a change',
    tags: ['directory'],
    auth: { permission: 'domain.users.password' },
    params: guidParams,
    body: passwordReset,
    response: passwordResponse,
    rateLimit: { max: 30, windowSec: 60 },
    handler: async (c) => {
      const dir = d.directory();
      const e = await dir.entryByGuid(c.params.guid, undefined, true);
      if (typeOf(e) !== 'user') throw new PlatformError('request.not-found', { what: `User ${c.params.guid}` });
      const prot = dir.isProtected(e);
      c.require('domain.users.password', { dn: e.dn, protected: prot, label: str(e, 'sAMAccountName') ?? e.dn });
      const generated = c.body.password ? null : generatePassword();
      const password = c.body.password ?? generated ?? '';
      if (prot)
        await viaAgent(
          c,
          e,
          { kind: 'password', password, mustChange: c.body.mustChangePassword, unlock: c.body.unlock },
          c.body.confirm,
        );
      else await dir.setPassword(e.dn, password, c.body.mustChangePassword, c.body.unlock);
      audit(c, 'directory.user.password-reset', { guid: c.params.guid, dn: e.dn }, undefined, {
        mustChangePassword: c.body.mustChangePassword,
        unlock: c.body.unlock,
        generated: generated !== null,
      });
      return { generatedPassword: generated };
    },
  });

  t.add({
    method: 'POST',
    url: '/api/v1/directory/users/:guid/account',
    operationId: 'changeUserAccount',
    summary: 'Enable, disable or unlock a user account',
    tags: ['directory'],
    auth: 'session',
    params: guidParams,
    body: accountAction,
    response: directoryObject,
    handler: async (c) => {
      const dir = d.directory();
      const e = await dir.entryByGuid(c.params.guid, undefined, true);
      const type = typeOf(e);
      if (type !== 'user' && type !== 'computer')
        throw new PlatformError('request.not-found', { what: `Account ${c.params.guid}` });
      const prot = dir.isProtected(e);
      const perm = c.body.action === 'unlock' ? 'domain.users.password' : permFor(type, 'write');
      c.require(perm, { dn: e.dn, protected: prot, label: str(e, 'sAMAccountName') ?? e.dn });
      const wasEnabled = ((int(e, 'userAccountControl') ?? 0) & UAC.disabled) === 0;
      if (prot) await viaAgent(c, e, { kind: c.body.action }, c.body.confirm);
      else if (c.body.action === 'unlock') await dir.unlock(e.dn);
      else await dir.setEnabled(e, c.body.action === 'enable');
      audit(
        c,
        `directory.${type}.${c.body.action}`,
        { guid: c.params.guid, dn: e.dn },
        { enabled: wasEnabled },
        {
          enabled: c.body.action === 'unlock' ? wasEnabled : c.body.action === 'enable',
        },
      );
      return (await dir.getObject(c.params.guid)).object;
    },
  });

  t.add({
    method: 'GET',
    url: '/api/v1/directory/users/:guid/photo',
    operationId: 'getUserPhoto',
    summary: 'The user photo (JPEG), base64',
    tags: ['directory'],
    auth: 'session',
    params: guidParams,
    response: z.object({ jpeg: z.string().nullable() }),
    handler: async (c) => {
      await target(c, c.params.guid, 'read', ['user']);
      const p = await d.directory().photo(c.params.guid);
      return { jpeg: p ? p.toString('base64') : null };
    },
  });

  t.add({
    method: 'PUT',
    url: '/api/v1/directory/users/:guid/photo',
    operationId: 'setUserPhoto',
    summary: 'Set (JPEG ≤ 100 KB) or remove the user photo',
    tags: ['directory'],
    auth: 'session',
    params: guidParams,
    body: photoBody,
    response: empty,
    handler: async (c) => {
      const { e, protected: prot } = await target(c, c.params.guid, 'write', ['user']);
      if (prot) throw new PlatformError('directory.unsupported', { what: 'Changing the photo of a protected account' });
      const jpeg = c.body.jpeg ? Buffer.from(c.body.jpeg, 'base64') : null;
      if (jpeg && (jpeg.length > 100 * 1024 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8))
        throw new PlatformError('validation.invalid', { issues: 'jpeg: a JPEG image of at most 100 KB' });
      await d.directory().setPhoto(e.dn, jpeg);
      audit(c, 'directory.user.photo', { guid: c.params.guid, dn: e.dn }, undefined, { bytes: jpeg?.length ?? 0 });
      return {};
    },
  });

  // ---------------- groups ----------------

  t.add({
    method: 'POST',
    url: '/api/v1/directory/groups',
    operationId: 'createGroup',
    summary: 'Create a group (security groups get a RID-based gidNumber)',
    tags: ['directory'],
    auth: { permission: 'domain.groups.create' },
    body: groupCreate,
    response: createdResponse,
    status: 201,
    handler: async (c) => {
      const dir = d.directory();
      const parent = await dir.containerDn(c.body.parent, childDn(dir.domainDn, 'CN', 'Users'));
      c.require('domain.groups.create', { dn: parent });
      const r = await dir.createGroup(parent, c.body);
      if (c.body.members.length) {
        const dns = [];
        for (const m of c.body.members) dns.push((await dir.entryByGuid(m, ['objectGUID'])).dn);
        await dir.changeMembers(r.dn, dns, []);
      }
      audit(c, 'directory.group.create', r, undefined, { ...c.body, dn: r.dn });
      return { ...r, generatedPassword: null };
    },
  });

  t.add({
    method: 'PATCH',
    url: '/api/v1/directory/groups/:guid',
    operationId: 'updateGroup',
    summary: 'Change group attributes, scope or type',
    tags: ['directory'],
    auth: 'session',
    params: guidParams,
    body: groupPatch,
    response: directoryObject,
    handler: async (c) => {
      const { e, protected: prot } = await target(c, c.params.guid, 'write', ['group']);
      if (prot) throw new PlatformError('directory.unsupported', { what: 'Changing a protected group' });
      checkEtag(e, c.body.etag);
      const dir = d.directory();
      const mods: Mod[] = [];
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const set = (field: string, attr: string, v: string | null | undefined): void => {
        if (v === undefined || (v ?? null) === str(e, attr)) return;
        before[field] = str(e, attr);
        after[field] = v;
        mods.push({ op: 'replace', attr, values: v === null ? [] : [v] });
      };
      set('description', 'description', c.body.description);
      set('mail', 'mail', c.body.mail);
      if (c.body.gidNumber !== undefined)
        set('gidNumber', 'gidNumber', c.body.gidNumber === null ? null : String(c.body.gidNumber));
      if (c.body.managedBy !== undefined)
        set(
          'managedBy',
          'managedBy',
          c.body.managedBy ? (await dir.entryByGuid(c.body.managedBy, ['objectGUID'])).dn : null,
        );
      if (c.body.scope || c.body.kind) {
        const gt = int(e, 'groupType') ?? 0;
        const scopeBits =
          c.body.scope === 'global'
            ? 0x2
            : c.body.scope === 'universal'
              ? 0x8
              : c.body.scope === 'domainLocal'
                ? 0x4
                : gt & 0xe;
        const sec = c.body.kind ? (c.body.kind === 'security' ? 0x80000000 : 0) : gt & 0x80000000;
        const next = scopeBits | sec | 0;
        if (next !== gt) {
          // AD allows global <-> domain local only through universal
          if ((gt & 0x2 && scopeBits === 0x4) || (gt & 0x4 && scopeBits === 0x2)) {
            await dir.modify(e.dn, [{ op: 'replace', attr: 'groupType', values: [String(0x8 | sec | 0)] }]);
          }
          before.groupType = gt;
          after.groupType = next;
          mods.push({ op: 'replace', attr: 'groupType', values: [String(next)] });
        }
      }
      if (mods.length) {
        await dir.modify(e.dn, mods);
        audit(c, 'directory.group.update', { guid: c.params.guid, dn: e.dn }, before, after);
      }
      return (await dir.getObject(c.params.guid)).object;
    },
  });

  t.add({
    method: 'GET',
    url: '/api/v1/directory/groups/:guid/members',
    operationId: 'listGroupMembers',
    summary: 'Direct members of a group',
    tags: ['directory'],
    auth: 'session',
    params: guidParams,
    response: membersResponse,
    handler: async (c) => {
      const { e } = await target(c, c.params.guid, 'read', ['group']);
      return d.directory().members(e.dn);
    },
  });

  t.add({
    method: 'POST',
    url: '/api/v1/directory/groups/:guid/members',
    operationId: 'changeGroupMembers',
    summary: 'Add and remove members (protected groups: tier 0 with typed confirmation)',
    tags: ['directory'],
    auth: { permission: 'domain.groups.members' },
    params: guidParams,
    body: membersChange,
    response: membersResponse,
    handler: async (c) => {
      const dir = d.directory();
      const e = await dir.entryByGuid(c.params.guid, undefined, true);
      if (typeOf(e) !== 'group') throw new PlatformError('request.not-found', { what: `Group ${c.params.guid}` });
      const prot = dir.isProtected(e);
      c.require('domain.groups.members', { dn: e.dn, protected: prot, label: str(e, 'sAMAccountName') ?? e.dn });
      const resolve = async (guids: string[]): Promise<string[]> => {
        const out: string[] = [];
        for (const g of guids) out.push((await dir.entryByGuid(g, ['objectGUID'])).dn);
        return out;
      };
      const add = await resolve(c.body.add);
      const remove = await resolve(c.body.remove);
      if (prot) {
        if (add.length) await viaAgent(c, e, { kind: 'memberAdd', memberGuids: c.body.add }, c.body.confirm);
        if (remove.length) await viaAgent(c, e, { kind: 'memberRemove', memberGuids: c.body.remove }, c.body.confirm);
      } else await dir.changeMembers(e.dn, add, remove);
      audit(c, 'directory.group.members', { guid: c.params.guid, dn: e.dn }, { remove }, { add });
      return dir.members(e.dn);
    },
  });

  // ---------------- computers, contacts, OUs ----------------

  t.add({
    method: 'PATCH',
    url: '/api/v1/directory/computers/:guid',
    operationId: 'updateComputer',
    summary: 'Change computer description, location or manager',
    tags: ['directory'],
    auth: 'session',
    params: guidParams,
    body: computerPatch,
    response: directoryObject,
    handler: async (c) => {
      const { e, protected: prot } = await target(c, c.params.guid, 'write', ['computer']);
      if (prot) throw new PlatformError('directory.unsupported', { what: 'Changing a domain controller account' });
      checkEtag(e, c.body.etag);
      const dir = d.directory();
      const mods: Mod[] = [];
      if (c.body.description !== undefined)
        mods.push({ op: 'replace', attr: 'description', values: c.body.description ? [c.body.description] : [] });
      if (c.body.location !== undefined)
        mods.push({ op: 'replace', attr: 'location', values: c.body.location ? [c.body.location] : [] });
      if (c.body.managedBy !== undefined)
        mods.push({
          op: 'replace',
          attr: 'managedBy',
          values: c.body.managedBy ? [(await dir.entryByGuid(c.body.managedBy, ['objectGUID'])).dn] : [],
        });
      await dir.modify(e.dn, mods);
      audit(c, 'directory.computer.update', { guid: c.params.guid, dn: e.dn }, undefined, c.body);
      return (await dir.getObject(c.params.guid)).object;
    },
  });

  const contactAttrs = (b: Record<string, unknown>): Record<string, (string | Buffer)[]> => {
    const out: Record<string, string[]> = {};
    for (const k of [
      'givenName',
      'sn',
      'displayName',
      'description',
      'mail',
      'telephoneNumber',
      'mobile',
      'company',
      'title',
      'department',
    ]) {
      const v = b[k];
      if (typeof v === 'string' && v) out[k] = [v];
    }
    return out;
  };

  t.add({
    method: 'POST',
    url: '/api/v1/directory/contacts',
    operationId: 'createContact',
    summary: 'Create a contact',
    tags: ['directory'],
    auth: { permission: 'domain.contacts.write' },
    body: contactCreate,
    response: createdResponse,
    status: 201,
    handler: async (c) => {
      const dir = d.directory();
      const parent = await dir.containerDn(c.body.parent, childDn(dir.domainDn, 'CN', 'Users'));
      c.require('domain.contacts.write', { dn: parent });
      const r = await dir.add(childDn(parent, 'CN', c.body.cn), {
        objectClass: ['top', 'person', 'organizationalPerson', 'contact'],
        ...contactAttrs(c.body),
      });
      audit(c, 'directory.contact.create', r, undefined, c.body);
      return { ...r, generatedPassword: null };
    },
  });

  t.add({
    method: 'PATCH',
    url: '/api/v1/directory/contacts/:guid',
    operationId: 'updateContact',
    summary: 'Change contact attributes',
    tags: ['directory'],
    auth: 'session',
    params: guidParams,
    body: contactPatch,
    response: directoryObject,
    handler: async (c) => {
      const { e } = await target(c, c.params.guid, 'write', ['contact']);
      checkEtag(e, c.body.etag);
      const { etag: _e, ...patch } = c.body;
      const mods: Mod[] = Object.entries(patch)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => ({ op: 'replace' as const, attr: k, values: v ? [v] : [] }));
      await d.directory().modify(e.dn, mods);
      audit(c, 'directory.contact.update', { guid: c.params.guid, dn: e.dn }, undefined, patch);
      return (await d.directory().getObject(c.params.guid)).object;
    },
  });

  t.add({
    method: 'POST',
    url: '/api/v1/directory/ous',
    operationId: 'createOu',
    summary: 'Create an organizational unit',
    tags: ['directory'],
    auth: { permission: 'domain.ous.write' },
    body: ouCreate,
    response: createdResponse,
    status: 201,
    handler: async (c) => {
      const dir = d.directory();
      const parent = await dir.containerDn(c.body.parent);
      c.require('domain.ous.write', { dn: parent });
      const r = await dir.add(childDn(parent, 'OU', c.body.name), {
        objectClass: ['top', 'organizationalUnit'],
        ...(c.body.description ? { description: [c.body.description] } : {}),
      });
      audit(c, 'directory.ou.create', r, undefined, c.body);
      return { ...r, generatedPassword: null };
    },
  });

  t.add({
    method: 'PATCH',
    url: '/api/v1/directory/ous/:guid',
    operationId: 'updateOu',
    summary: 'Change an OU description',
    tags: ['directory'],
    auth: 'session',
    params: guidParams,
    body: ouPatch,
    response: directoryObject,
    handler: async (c) => {
      const { e } = await target(c, c.params.guid, 'write', ['ou', 'container']);
      checkEtag(e, c.body.etag);
      if (c.body.description !== undefined) {
        await d
          .directory()
          .modify(e.dn, [
            { op: 'replace', attr: 'description', values: c.body.description ? [c.body.description] : [] },
          ]);
        audit(
          c,
          'directory.ou.update',
          { guid: c.params.guid, dn: e.dn },
          { description: str(e, 'description') },
          { description: c.body.description },
        );
      }
      return (await d.directory().getObject(c.params.guid)).object;
    },
  });
}
