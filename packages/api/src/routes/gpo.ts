// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /api/v1/gpo (ROADMAP Phase 3): group policy objects and their links, read over LDAP; create, backup and restore
 * through the agent on the PDC emulator (SYSVOL's source of truth, ADR-0019; elsewhere the agent refuses and names
 * the PDC emulator); links through the agent on this DC. Links on the domain itself and on the Domain Controllers
 * OU, and every restore, need a tier-0 role; a restore is confirmed by typing the GPO's name. Editing a GPO's
 * settings stays with GPMC (RSAT) or `samba-tool gpo manage`, against the PDC emulator.
 */
import { hostname } from 'node:os';
import { PlatformError } from '@opendc/shared';
import { mintConfirmation, type AgentClient } from '@opendc/shared/agent';
import { empty } from '@opendc/shared/api';
import { gpoBackupInfo, gpoName, parseGpLink, splitVersion } from '@opendc/shared/gpo';
import { childDn, eq, guidFromBytes, guidToBytes, present } from '@opendc/shared/ldap';
import { z } from 'zod';
import type { AuditLog } from '../audit.ts';
import type { RouteContext, RouteTable } from '../http/route.ts';
import type { DirectoryService } from '../directory/service.ts';

type Ctx = RouteContext<unknown, unknown, unknown>;
const first = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? '') : typeof v === 'string' ? v : '');
const lower = (s: string): string => s.toLowerCase();

const link = z.object({
  container: z.string(),
  dn: z.string(),
  name: z.string(),
  enforced: z.boolean(),
  disabled: z.boolean(),
  order: z.number().int(),
  /** the domain itself or the Domain Controllers OU: tier 0 */
  protected: z.boolean(),
});
export const gpoOverview = z.object({
  pdc: z.string().nullable(),
  /** this DC holds the PDC emulator role (create, backup and restore work only there) */
  isPdc: z.boolean(),
  /** the domain head, a link target like the OUs */
  domain: z.object({ container: z.string(), name: z.string() }),
  gpos: z.array(
    z.object({
      id: z.string(),
      gpo: z.string(),
      displayName: z.string(),
      userVersion: z.number().int(),
      computerVersion: z.number().int(),
      userDisabled: z.boolean(),
      computerDisabled: z.boolean(),
      changedAt: z.string().nullable(),
      links: z.array(link),
    }),
  ),
});
const gpoParams = z.strictObject({ id: z.guid() });
const linkParams = z.strictObject({ id: z.guid(), container: z.guid() });
const backupParams = z.strictObject({ backupId: z.uuid() });
const toGpo = (id: string): string => `{${id.toUpperCase()}}`;
/** GeneralizedTime (20261026010203.0Z) -> ISO */
const isoTime = (t: string): string | null => {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(t);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
};

export function gpoRoutes(
  t: RouteTable,
  d: {
    directory: () => DirectoryService;
    agent: () => Pick<AgentClient, 'call'>;
    audit: AuditLog;
    confirmKey: Buffer;
  },
): void {
  const actor = (c: Ctx) => ({ name: c.user.username, sid: c.user.sid, via: 'api' as const });
  const audit = (c: Ctx, action: string, before: unknown, after: unknown): void => {
    d.audit.append({
      actor: c.user.username,
      actorSid: c.user.sid,
      sourceIp: c.ip,
      action,
      result: 'success',
      before,
      after,
      requestId: c.requestId,
    });
  };
  const policiesDn = (): string => childDn(childDn(d.directory().domainDn, 'CN', 'System'), 'CN', 'Policies');
  const isProtected = (dn: string): boolean => {
    const domain = lower(d.directory().domainDn);
    return lower(dn) === domain || lower(dn) === `ou=domain controllers,${domain}`;
  };

  /** A container by objectGUID (the domain or an OU). */
  const container = async (guid: string): Promise<{ dn: string; name: string }> => {
    const [e] = await d.directory().ldap.search(d.directory().domainDn, {
      scope: 'sub',
      filter: eq('objectGUID', guidToBytes(guid)),
      attributes: ['name'],
    });
    if (!e) throw new PlatformError('gpo.not-found', { what: `Container ${guid}` });
    return { dn: e.dn, name: first(e.name) || e.dn };
  };
  const gpoEntry = async (gpo: string): Promise<{ displayName: string }> => {
    const [e] = await d
      .directory()
      .ldap.search(policiesDn(), { scope: 'one', filter: eq('cn', gpo), attributes: ['displayName'] });
    if (!e) throw new PlatformError('gpo.not-found', { what: `GPO ${gpo}` });
    return { displayName: first(e.displayName) || gpo };
  };

  t.add({
    method: 'GET',
    url: '/api/v1/gpo',
    operationId: 'listGpos',
    summary: 'Group policy objects with their links, and where they can be changed',
    tags: ['gpo'],
    auth: { permission: 'gpo.read' },
    response: gpoOverview,
    handler: async (c) => {
      const dir = d.directory();
      const [gpos, linked, fsmo, head] = await Promise.all([
        dir.ldap.search(policiesDn(), {
          scope: 'one',
          filter: eq('objectClass', 'groupPolicyContainer'),
          attributes: ['cn', 'displayName', 'versionNumber', 'flags', 'whenChanged'],
        }),
        dir.ldap.search(dir.domainDn, {
          scope: 'sub',
          filter: present('gPLink'),
          attributes: ['gPLink', 'objectGUID', 'name'],
          buffers: ['objectGUID'],
        }),
        d
          .agent()
          .call('samba.fsmo.show', {}, { actor: actor(c) })
          .catch(() => ({ roles: [] })),
        dir.ldap.search(dir.domainDn, { scope: 'base', attributes: ['objectGUID'], buffers: ['objectGUID'] }),
      ]);
      const headGuid = head[0] && Buffer.isBuffer(head[0].objectGUID) ? guidFromBytes(head[0].objectGUID) : '';
      const pdc = fsmo.roles.find((r) => r.role === 'pdc')?.ownerServer ?? null;
      const links = new Map<string, z.infer<typeof link>[]>();
      for (const e of linked) {
        const guid = Buffer.isBuffer(e.objectGUID) ? guidFromBytes(e.objectGUID) : '';
        for (const l of parseGpLink(first(e.gPLink))) {
          const list = links.get(l.gpo) ?? [];
          list.push({
            container: guid,
            dn: e.dn,
            name: first(e.name) || e.dn,
            enforced: l.enforced,
            disabled: l.disabled,
            order: l.order,
            protected: isProtected(e.dn),
          });
          links.set(l.gpo, list);
        }
      }
      return {
        pdc,
        isPdc: pdc !== null && lower(pdc) === lower(hostname().split('.')[0] ?? ''),
        domain: {
          container: headGuid,
          name: dir.domainDn
            .split(',')
            .map((p) => p.replace(/^dc=/i, ''))
            .join('.'),
        },
        gpos: gpos
          .map((e) => {
            const gpo = first(e.cn).toUpperCase();
            const v = splitVersion(Number(first(e.versionNumber) || 0));
            const flags = Number(first(e.flags) || 0);
            return {
              id: gpo.slice(1, -1).toLowerCase(),
              gpo,
              displayName: first(e.displayName) || gpo,
              userVersion: v.user,
              computerVersion: v.computer,
              userDisabled: (flags & 1) !== 0,
              computerDisabled: (flags & 2) !== 0,
              changedAt: isoTime(first(e.whenChanged)),
              links: links.get(gpo) ?? [],
            };
          })
          .sort((a, b) => a.displayName.localeCompare(b.displayName)),
      };
    },
  });

  t.add({
    method: 'POST',
    url: '/api/v1/gpo',
    operationId: 'createGpo',
    summary: 'Create an empty GPO (on the PDC emulator)',
    tags: ['gpo'],
    auth: { permission: 'gpo.write' },
    body: z.strictObject({ displayName: gpoName }),
    response: z.object({ gpo: z.string(), dn: z.string() }),
    status: 201,
    handler: async (c) => {
      const r = await d.agent().call('samba.gpo.create', { displayName: c.body.displayName }, { actor: actor(c) });
      audit(c, 'gpo.create', null, { gpo: r.gpo, displayName: c.body.displayName });
      return r;
    },
  });

  t.add({
    method: 'POST',
    url: '/api/v1/gpo/:id/backup',
    operationId: 'backupGpo',
    summary: 'Back up a GPO (container and SYSVOL folder; kept on the PDC emulator)',
    tags: ['gpo'],
    auth: { permission: 'gpo.write' },
    params: gpoParams,
    response: gpoBackupInfo,
    status: 201,
    handler: async (c) => {
      const r = await d.agent().call('samba.gpo.backup', { gpo: toGpo(c.params.id) }, { actor: actor(c) });
      audit(c, 'gpo.backup', null, r);
      return r;
    },
  });

  t.add({
    method: 'GET',
    url: '/api/v1/gpo/backups',
    operationId: 'listGpoBackups',
    summary: "This DC's GPO backups",
    tags: ['gpo'],
    auth: { permission: 'gpo.read' },
    response: z.object({ backups: z.array(gpoBackupInfo) }),
    handler: async (c) => d.agent().call('samba.gpo.backup.list', {}, { actor: actor(c) }),
  });

  t.add({
    method: 'DELETE',
    url: '/api/v1/gpo/backups/:backupId',
    operationId: 'deleteGpoBackup',
    summary: 'Delete a GPO backup',
    tags: ['gpo'],
    auth: { permission: 'gpo.write' },
    params: backupParams,
    response: empty,
    handler: async (c) => {
      await d.agent().call('samba.gpo.backup.delete', { id: c.params.backupId }, { actor: actor(c) });
      audit(c, 'gpo.backup.delete', { id: c.params.backupId }, null);
      return {};
    },
  });

  t.add({
    method: 'POST',
    url: '/api/v1/gpo/backups/:backupId/restore',
    operationId: 'restoreGpo',
    summary: "Restore a backup over its GPO or as a new GPO (tier 0; type the GPO's name to confirm)",
    tags: ['gpo'],
    auth: { permission: 'gpo.write' },
    params: backupParams,
    body: z.strictObject({ newName: gpoName.nullable().default(null), confirm: z.string() }),
    response: z.object({ gpo: z.string(), created: z.boolean(), version: z.number().int() }),
    handler: async (c) => {
      c.require('gpo.write', { protected: true, label: 'GPO restore' });
      const backup = (await d.agent().call('samba.gpo.backup.list', {}, { actor: actor(c) })).backups.find(
        (b) => b.id === c.params.backupId,
      );
      if (!backup) throw new PlatformError('gpo.not-found', { what: `GPO backup ${c.params.backupId}` });
      // the name of the GPO that will change (or be created)
      const target = c.body.newName ?? backup.displayName;
      if (lower(c.body.confirm.trim()) !== lower(target))
        throw new PlatformError('agent.confirmation-required', { op: 'samba.gpo.restore' });
      const args = { backupId: backup.id, newName: c.body.newName };
      const confirmation = mintConfirmation(d.confirmKey, { op: 'samba.gpo.restore', args, actor: c.user.sid });
      const r = await d.agent().call('samba.gpo.restore', args, { actor: actor(c), confirmation });
      audit(c, 'gpo.restore', { backup: backup.id, gpo: backup.gpo, version: backup.version }, r);
      return r;
    },
  });

  t.add({
    method: 'PUT',
    url: '/api/v1/gpo/:id/links/:container',
    operationId: 'setGpoLink',
    summary: 'Link a GPO to the domain or an OU, or change the link (domain and Domain Controllers OU: tier 0)',
    tags: ['gpo'],
    auth: { permission: 'gpo.write' },
    params: linkParams,
    body: z.strictObject({ enforced: z.boolean().default(false), disabled: z.boolean().default(false) }),
    response: z.object({ container: z.string() }),
    handler: async (c) => {
      const gpo = toGpo(c.params.id);
      const [g, target] = await Promise.all([gpoEntry(gpo), container(c.params.container)]);
      if (isProtected(target.dn)) c.require('gpo.write', { protected: true, label: target.name });
      const r = await d
        .agent()
        .call(
          'samba.gpo.setlink',
          { gpo, container: c.params.container, enforced: c.body.enforced, disabled: c.body.disabled },
          { actor: actor(c) },
        );
      audit(c, 'gpo.link.set', null, {
        gpo,
        displayName: g.displayName,
        container: target.dn,
        enforced: c.body.enforced,
        disabled: c.body.disabled,
      });
      return r;
    },
  });

  t.add({
    method: 'DELETE',
    url: '/api/v1/gpo/:id/links/:container',
    operationId: 'deleteGpoLink',
    summary: 'Unlink a GPO (domain and Domain Controllers OU: tier 0)',
    tags: ['gpo'],
    auth: { permission: 'gpo.write' },
    params: linkParams,
    response: z.object({ container: z.string() }),
    handler: async (c) => {
      const gpo = toGpo(c.params.id);
      const target = await container(c.params.container);
      if (isProtected(target.dn)) c.require('gpo.write', { protected: true, label: target.name });
      const r = await d.agent().call('samba.gpo.dellink', { gpo, container: c.params.container }, { actor: actor(c) });
      audit(c, 'gpo.link.delete', { gpo, container: target.dn }, null);
      return r;
    },
  });
}
