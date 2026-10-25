// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Saved searches, user templates, bulk operations, CSV export and import (ROADMAP Phase 2).
 *
 * Bulk work runs as a job and checks every object like the single-object routes (type permission scoped by
 * DN, tier-0 guard); objects the caller may not change are reported as failed, never silently changed.
 * Generated import passwords never reach the database or a log: they stay in this process's memory for
 * 15 minutes and can be downloaded once by the user who ran the import.
 */
import { randomUUID } from 'node:crypto';
import { PlatformError, isPlatformError } from '@opendc/shared';
import {
  bulkRequest,
  empty,
  exportQuery,
  idParams,
  importBatches,
  importPreview,
  importRequest,
  job as jobSchema,
  savedSearchInput,
  savedSearches,
  userTemplateInput,
  userTemplates,
  csvColumns,
} from '@opendc/shared/api';
import type { PlatformDb } from '@opendc/shared/db';
import { childDn } from '@opendc/shared/ldap';
import { z } from 'zod';
import type { AgentClient } from '@opendc/shared/agent';
import type { Entry } from 'ldapts';
import type { AuditLog } from '../audit.ts';
import type { JobRunner } from '../jobs.ts';
import type { RouteContext, RouteTable } from '../http/route.ts';
import type { RbacEngine, Scope } from '../rbac/engine.ts';
import type { Session } from '../sessions.ts';
import { PlatformObjects } from '../directory/platform-objects.ts';
import { DirectoryService, generatePassword } from '../directory/service.ts';
import { applyImport, planImport, type ImportContext } from '../directory/import.ts';
import type { UserTemplates } from '../directory/templates.ts';
import { toCsv } from '../directory/csv.ts';
import {
  USER_ATTRS,
  USER_STRING_FIELDS,
  UAC,
  filetimeToIso,
  int,
  isoToFiletime,
  rdnValue,
  str,
  strs,
  typeOf,
} from '../directory/model.ts';

type Ctx = RouteContext<unknown, unknown, unknown>;

export interface BulkDeps {
  directory: () => DirectoryService;
  db: PlatformDb;
  jobs: JobRunner;
  audit: AuditLog;
  engineFor(domainSid: string): RbacEngine;
  templates: UserTemplates;
  /** The agent on this DC (bulk POSIX IDs); null without one. */
  agent?: Pick<AgentClient, 'call'> | null;
}

const searchData = z.object({
  name: z.string(),
  query: savedSearchInput.shape.query,
  shared: z.boolean(),
  ownerSid: z.string(),
  ownerName: z.string(),
});

/** In-memory, one-time downloads of generated import passwords. */
class GeneratedPasswords {
  readonly #items = new Map<string, { actorSid: string; csv: string; expires: number }>();

  put(batchId: string, actorSid: string, rows: { sam: string; password: string }[]): void {
    if (!rows.length) return;
    this.#purge();
    this.#items.set(batchId, {
      actorSid,
      csv: toCsv([['sam', 'password'], ...rows.map((r) => [r.sam, r.password])]),
      expires: Date.now() + 15 * 60_000,
    });
  }

  has(batchId: string): boolean {
    this.#purge();
    return this.#items.has(batchId);
  }

  take(batchId: string, actorSid: string): string {
    this.#purge();
    const item = this.#items.get(batchId);
    if (!item || item.actorSid !== actorSid)
      throw new PlatformError('request.not-found', { what: `Generated passwords of import ${batchId}` });
    this.#items.delete(batchId);
    return item.csv;
  }

  #purge(): void {
    const now = Date.now();
    for (const [k, v] of this.#items) if (v.expires < now) this.#items.delete(k);
  }
}

function readableBases(engine: RbacEngine, s: Session, permission: string): string[] | null {
  const e = engine.effective({ sid: s.sid, groupSids: s.groupSids }).find((p) => p.permission === permission);
  if (!e) return [];
  if (e.scopes.some((x: Scope) => x.kind === 'domain')) return null;
  return e.scopes.filter((x): x is Extract<Scope, { kind: 'subtree' }> => x.kind === 'subtree').map((x) => x.dn);
}

export function bulkRoutes(t: RouteTable, d: BulkDeps): void {
  const passwords = new GeneratedPasswords();
  const searches = new PlatformObjects({
    dir: d.directory,
    path: ['SavedSearches'],
    kind: 'savedSearch',
    schemaVersion: 1,
    data: searchData,
    name: (x) => x.name,
  });
  const templates = d.templates.store;

  const can =
    (c: Ctx) =>
    (permission: string, target: { dn: string; protected?: boolean }): boolean =>
      d.engineFor(c.user.domainSid).can({ sid: c.user.sid, groupSids: c.user.groupSids }, permission, target).allow;
  const audit = (c: Ctx, action: string, after: unknown, target: { guid?: string; dn?: string } = {}): void => {
    d.audit.append({
      actor: c.user.username,
      actorSid: c.user.sid,
      sourceIp: c.ip,
      action,
      result: 'success',
      ...(target.guid ? { targetGuid: target.guid } : {}),
      ...(target.dn ? { targetDn: target.dn } : {}),
      after,
      requestId: c.requestId,
    });
  };

  // ---------------- saved searches ----------------

  t.add({
    method: 'GET',
    url: '/api/v1/directory/searches',
    operationId: 'listSavedSearches',
    summary: 'Saved searches: your own and the shared ones',
    tags: ['directory'],
    auth: { permission: 'core.console.access' },
    response: savedSearches,
    handler: async (c) => ({
      searches: (await searches.list())
        .filter((s) => s.data.shared || s.data.ownerSid === c.user.sid)
        .map((s) => ({
          id: s.id,
          name: s.data.name,
          query: s.data.query,
          shared: s.data.shared,
          owner: s.data.ownerName,
          mine: s.data.ownerSid === c.user.sid,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }),
  });

  t.add({
    method: 'POST',
    url: '/api/v1/directory/searches',
    operationId: 'createSavedSearch',
    summary: 'Save a search (shared: needs domain.search.share)',
    tags: ['directory'],
    auth: { permission: 'core.console.access' },
    body: savedSearchInput,
    response: z.object({ id: z.string() }),
    status: 201,
    handler: async (c) => {
      if (c.body.shared) c.require('domain.search.share');
      const id = await searches.create(
        { sid: c.user.sid, name: c.user.username },
        { ...c.body, ownerSid: c.user.sid, ownerName: c.user.username },
      );
      return { id };
    },
  });

  t.add({
    method: 'DELETE',
    url: '/api/v1/directory/searches/:id',
    operationId: 'deleteSavedSearch',
    summary: 'Delete one of your saved searches (shared ones: domain.search.share)',
    tags: ['directory'],
    auth: { permission: 'core.console.access' },
    params: idParams,
    response: empty,
    handler: async (c) => {
      const s = await searches.get(c.params.id);
      if (s.data.ownerSid !== c.user.sid) {
        if (!s.data.shared) throw new PlatformError('request.not-found', { what: `Saved search ${c.params.id}` });
        c.require('domain.search.share');
      }
      await searches.delete(s);
      return {};
    },
  });

  // ---------------- user templates ----------------

  const templateView = async (s: Awaited<ReturnType<typeof templates.list>>[number]) => {
    const dir = d.directory();
    const parent = s.data.parent ? await dir.entryByGuid(s.data.parent, ['objectGUID']).catch(() => null) : null;
    const groups = [];
    for (const g of s.data.groups) {
      const e = await dir.entryByGuid(g, ['objectGUID', 'name']).catch(() => null);
      if (e) groups.push({ guid: g, name: str(e, 'name') ?? rdnValue(e.dn) });
    }
    return {
      id: s.id,
      name: s.data.name,
      description: s.data.description,
      parent: s.data.parent,
      parentDn: parent?.dn ?? null,
      defaults: s.data.defaults,
      groups,
      mustChangePassword: s.data.mustChangePassword,
      enabled: s.data.enabled,
    };
  };

  t.add({
    method: 'GET',
    url: '/api/v1/directory/templates',
    operationId: 'listUserTemplates',
    summary: 'User templates',
    tags: ['directory'],
    auth: { permission: 'domain.users.read' },
    response: userTemplates,
    handler: async () => {
      const out = [];
      for (const s of await templates.list()) out.push(await templateView(s));
      return { templates: out.sort((a, b) => a.name.localeCompare(b.name)) };
    },
  });

  const saveTemplate = async (c: Ctx, body: z.output<typeof userTemplateInput>, id?: string): Promise<string> => {
    const dir = d.directory();
    if (body.parent) await dir.containerDn(body.parent);
    for (const g of body.groups) {
      const e = await dir.entryByGuid(g, undefined, true);
      if (typeOf(e) !== 'group')
        throw new PlatformError('validation.invalid', { issues: `groups: ${g} is not a group` });
      if (dir.isProtected(e))
        throw new PlatformError('validation.invalid', { issues: `groups: ${rdnValue(e.dn)} is protected` });
    }
    const actor = { sid: c.user.sid, name: c.user.username };
    if (id) {
      await templates.update(actor, await templates.get(id), body);
      return id;
    }
    return templates.create(actor, body);
  };

  t.add({
    method: 'POST',
    url: '/api/v1/directory/templates',
    operationId: 'createUserTemplate',
    summary: 'Create a user template',
    tags: ['directory'],
    auth: { permission: 'domain.templates.manage' },
    body: userTemplateInput,
    response: z.object({ id: z.string() }),
    status: 201,
    handler: async (c) => {
      const id = await saveTemplate(c, c.body);
      audit(c, 'directory.template.create', { id, ...c.body });
      return { id };
    },
  });

  t.add({
    method: 'PUT',
    url: '/api/v1/directory/templates/:id',
    operationId: 'updateUserTemplate',
    summary: 'Replace a user template',
    tags: ['directory'],
    auth: { permission: 'domain.templates.manage' },
    params: idParams,
    body: userTemplateInput,
    response: empty,
    handler: async (c) => {
      await saveTemplate(c, c.body, c.params.id);
      audit(c, 'directory.template.update', { id: c.params.id, ...c.body });
      return {};
    },
  });

  t.add({
    method: 'DELETE',
    url: '/api/v1/directory/templates/:id',
    operationId: 'deleteUserTemplate',
    summary: 'Delete a user template',
    tags: ['directory'],
    auth: { permission: 'domain.templates.manage' },
    params: idParams,
    response: empty,
    handler: async (c) => {
      await templates.delete(await templates.get(c.params.id));
      audit(c, 'directory.template.delete', { id: c.params.id });
      return {};
    },
  });

  // ---------------- bulk ----------------

  t.add({
    method: 'POST',
    url: '/api/v1/directory/bulk',
    operationId: 'startBulkOperation',
    summary: 'Enable, disable, delete, move, set attributes or change group membership of many objects (job)',
    tags: ['directory'],
    auth: { permission: 'core.console.access' },
    body: bulkRequest,
    response: jobSchema,
    status: 202,
    handler: async (c) => {
      const dir = d.directory();
      const allowed = can(c);
      const a = c.body.action;
      const targetParent = a.kind === 'move' ? await dir.containerDn(a.parent) : null;
      let groupEntry: Entry | null = null;
      if (a.kind === 'addToGroup' || a.kind === 'removeFromGroup') {
        groupEntry = await dir.entryByGuid(a.group, undefined, true);
        if (typeOf(groupEntry) !== 'group')
          throw new PlatformError('validation.invalid', { issues: 'group: not a group' });
        c.require('domain.groups.members', {
          dn: groupEntry.dn,
          protected: dir.isProtected(groupEntry),
          label: rdnValue(groupEntry.dn),
        });
        if (dir.isProtected(groupEntry))
          throw new PlatformError('directory.unsupported', { what: 'Bulk changes to a protected group' });
      }
      const guids = [...new Set(c.body.guids)];
      const job = d.jobs.start('directory.bulk', { name: c.user.username, sid: c.user.sid }, async (progress) => {
        const items: { guid: string; name: string; ok: boolean; error: string | null }[] = [];
        const posix: { guid: string; name: string }[] = [];
        let n = 0;
        for (const guid of guids) {
          let name = guid;
          try {
            const e = await dir.entryByGuid(guid, undefined, true);
            name = str(e, 'name') ?? rdnValue(e.dn);
            const type = typeOf(e);
            if (type === 'other') throw new PlatformError('directory.unsupported', { what: e.dn });
            const prot = dir.isProtected(e);
            if (prot) throw new PlatformError('auth.tier0-required', { target: name });
            const perm = (k: 'write' | 'delete'): string =>
              `domain.${{ user: 'users', group: 'groups', computer: 'computers', contact: 'contacts', ou: 'ous', container: 'ous' }[type]}.${k}`;
            const need = (p: string, dn: string): void => {
              if (!allowed(p, { dn })) throw new PlatformError('auth.forbidden', { permission: p });
            };
            switch (a.kind) {
              case 'enable':
              case 'disable':
                if (type !== 'user' && type !== 'computer')
                  throw new PlatformError('directory.unsupported', { what: `${a.kind} of ${type}` });
                need(perm('write'), e.dn);
                await dir.setEnabled(e, a.kind === 'enable');
                break;
              case 'delete':
                need(perm('delete'), e.dn);
                if (str(e, 'isCriticalSystemObject') === 'TRUE')
                  throw new PlatformError('directory.unsupported', { what: `Deleting ${e.dn}` });
                await dir.delete(e.dn, false);
                break;
              case 'move':
                need(perm('delete'), e.dn);
                need(type === 'user' ? 'domain.users.create' : perm('write'), targetParent ?? '');
                await dir.move(e.dn, targetParent ?? '');
                break;
              case 'set': {
                if (type !== 'user')
                  throw new PlatformError('directory.unsupported', { what: `Setting attributes on ${type}` });
                need('domain.users.write', e.dn);
                const mods = Object.entries(a.values).map(([k, v]) =>
                  k === 'accountExpires'
                    ? {
                        op: 'replace' as const,
                        attr: 'accountExpires',
                        values: [isoToFiletime((v as string | null) ?? null)],
                      }
                    : {
                        op: 'replace' as const,
                        attr: (USER_STRING_FIELDS as Record<string, string>)[k] ?? k,
                        values: v ? [v] : [],
                      },
                );
                await dir.modify(e.dn, mods);
                break;
              }
              case 'fillPosixIds':
                if (type !== 'user' && type !== 'group')
                  throw new PlatformError('directory.unsupported', { what: `POSIX IDs for ${type}` });
                need(perm('write'), e.dn);
                // done in batches by the agent after the checks (below)
                posix.push({ guid, name });
                n++;
                continue;
              case 'addToGroup':
              case 'removeFromGroup':
                if (!groupEntry) throw new PlatformError('validation.invalid', { issues: 'group' });
                if (
                  a.kind === 'addToGroup' &&
                  strs(e, 'memberOf').some((m) => m.toLowerCase() === groupEntry.dn.toLowerCase())
                )
                  break;
                await dir.changeMembers(
                  groupEntry.dn,
                  a.kind === 'addToGroup' ? [e.dn] : [],
                  a.kind === 'removeFromGroup' ? [e.dn] : [],
                );
                break;
            }
            items.push({ guid, name, ok: true, error: null });
          } catch (e) {
            items.push({ guid, name, ok: false, error: isPlatformError(e) ? e.code : 'internal' });
          }
          n++;
          if (n % 25 === 0 || n === guids.length)
            progress({ step: 'objects', percent: Math.round((n / guids.length) * 100) });
        }
        const agent = d.agent;
        for (let i = 0; i < posix.length; i += 500) {
          const part = posix.slice(i, i + 500);
          try {
            if (!agent) throw new PlatformError('agent.unreachable', { socket: 'api', reason: 'no agent' });
            const { results } = await agent.call(
              'directory.posixIds.fill',
              { guids: part.map((p) => p.guid) },
              { actor: { name: c.user.username, sid: c.user.sid, via: 'api' }, timeoutMs: 600_000 },
            );
            const byGuid = new Map(results.map((r) => [r.guid.toLowerCase(), r]));
            for (const p of part) {
              const r = byGuid.get(p.guid.toLowerCase());
              items.push({ guid: p.guid, name: p.name, ok: !r?.error, error: r?.error ?? (r ? null : 'internal') });
            }
          } catch (e) {
            for (const p of part)
              items.push({ guid: p.guid, name: p.name, ok: false, error: isPlatformError(e) ? e.code : 'internal' });
          }
        }
        const failed = items.filter((i) => !i.ok).length;
        d.audit.append({
          actor: c.user.username,
          actorSid: c.user.sid,
          sourceIp: c.ip,
          action: `directory.bulk.${a.kind}`,
          result: failed ? 'failure' : 'success',
          after: {
            action: a,
            done: items.length - failed,
            failed,
            objects: items.map((i) => ({ guid: i.guid, ok: i.ok })),
          },
          requestId: c.requestId,
        });
        return { done: items.length - failed, failed, items };
      });
      return Promise.resolve(job);
    },
  });

  // ---------------- export ----------------

  t.add({
    method: 'GET',
    url: '/api/v1/directory/export',
    operationId: 'exportUsersCsv',
    summary: 'Users matching a search as CSV (only what the caller may read)',
    tags: ['directory'],
    auth: { permission: 'domain.users.read' },
    query: exportQuery,
    response: empty,
    stream: true,
    handler: async (c) => {
      const dir = d.directory();
      const engine = d.engineFor(c.user.domainSid);
      const columns = (
        c.query.columns ? c.query.columns.split(',') : csvColumns.filter((x) => x !== 'password')
      ).filter(
        (x): x is (typeof csvColumns)[number] => (csvColumns as readonly string[]).includes(x) && x !== 'password',
      );
      const { entries } = await dir.search(
        { ...c.query, types: 'user' },
        readableBases(engine, c.user, 'domain.users.read'),
        USER_ATTRS,
      );
      const rows = entries
        .filter((e) => engine.can(c.user, 'domain.users.read', { dn: e.dn }).allow)
        .map((e) =>
          columns.map((col) => {
            if (col === 'sam') return str(e, 'sAMAccountName');
            if (col === 'enabled') return ((int(e, 'userAccountControl') ?? 0) & UAC.disabled) === 0;
            if (col === 'accountExpires') return filetimeToIso(str(e, 'accountExpires'));
            if (col === 'groups')
              return strs(e, 'memberOf')
                .map((m) => rdnValue(m))
                .join('|');
            const attr = (USER_STRING_FIELDS as Record<string, string>)[col];
            return attr ? str(e, attr) : '';
          }),
        );
      audit(c, 'directory.export', { rows: rows.length, columns, query: c.query });
      void c.reply
        .header('content-disposition', 'attachment; filename="users.csv"')
        .type('text/csv; charset=utf-8')
        .send('\uFEFF' + toCsv([columns, ...rows]));
      return undefined;
    },
  });

  // ---------------- import ----------------

  const importContext = async (c: Ctx, body: z.output<typeof importRequest>): Promise<ImportContext> => {
    const dir = d.directory();
    const tpl = body.templateId ? await d.templates.resolve(body.templateId) : null;
    const parentGuid = body.parent ?? tpl?.parent ?? undefined;
    const parentDn = await dir.containerDn(parentGuid ?? undefined, childDn(dir.domainDn, 'CN', 'Users'));
    return { dir, can: can(c), parentDn, template: tpl?.t ?? null, mode: body.mode };
  };

  t.add({
    method: 'POST',
    url: '/api/v1/directory/import/preview',
    operationId: 'previewImport',
    summary: 'Dry run of a CSV user import: what would be created or changed, per row',
    tags: ['directory'],
    auth: { permission: 'domain.users.read' },
    body: importRequest,
    response: importPreview,
    handler: async (c) => (await planImport(c.body.csv, await importContext(c, c.body))).preview,
  });

  t.add({
    method: 'POST',
    url: '/api/v1/directory/import',
    operationId: 'startImport',
    summary: 'Run a CSV user import (re-planned on the server); undo by deleting the batch',
    tags: ['directory'],
    auth: { permission: 'domain.users.read' },
    body: importRequest,
    response: jobSchema,
    status: 202,
    handler: async (c) => {
      const ctx = await importContext(c, c.body);
      const { rows, preview } = await planImport(c.body.csv, ctx);
      const batchId = randomUUID();
      const job = d.jobs.start('directory.import', { name: c.user.username, sid: c.user.sid }, async (progress) => {
        const r = await applyImport(
          rows,
          ctx,
          () => generatePassword(),
          (done, total) => {
            progress({ step: 'rows', percent: total ? Math.round((done / total) * 100) : 100 });
          },
        );
        d.db.run(
          'INSERT INTO import_batches (id, actor, actor_sid, created_at, created_json, updated_count, failed_count) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            batchId,
            c.user.username,
            c.user.sid,
            new Date().toISOString(),
            JSON.stringify(r.created),
            r.updated,
            r.failed.length,
          ],
        );
        passwords.put(batchId, c.user.sid, r.generated);
        d.audit.append({
          actor: c.user.username,
          actorSid: c.user.sid,
          sourceIp: c.ip,
          action: 'directory.import',
          result: r.failed.length ? 'failure' : 'success',
          after: {
            batch: batchId,
            created: r.created.length,
            updated: r.updated,
            failed: r.failed.length,
            skippedInPreview: preview.counts.error,
          },
          requestId: c.requestId,
        });
        return {
          batch: batchId,
          created: r.created.length,
          updated: r.updated,
          failed: r.failed,
          generatedPasswords: r.generated.length,
        };
      });
      return Promise.resolve(job);
    },
  });

  t.add({
    method: 'GET',
    url: '/api/v1/directory/imports',
    operationId: 'listImports',
    summary: 'Recent imports (for undo and password download)',
    tags: ['directory'],
    auth: { permission: 'domain.users.read' },
    response: importBatches,
    handler: async () =>
      Promise.resolve({
        batches: d.db
          .all<{
            id: string;
            actor: string;
            created_at: string;
            created_json: string;
            updated_count: number;
            failed_count: number;
            undone_at: string | null;
          }>('SELECT * FROM import_batches ORDER BY created_at DESC LIMIT 50')
          .map((b) => ({
            id: b.id,
            actor: b.actor,
            createdAt: b.created_at,
            created: (JSON.parse(b.created_json) as unknown[]).length,
            updated: b.updated_count,
            failed: b.failed_count,
            passwordsAvailable: passwords.has(b.id),
            undone: b.undone_at !== null,
          })),
      }),
  });

  t.add({
    method: 'GET',
    url: '/api/v1/directory/imports/:id/passwords',
    operationId: 'downloadImportPasswords',
    summary: 'The generated passwords of an import, as CSV, once and only for its author',
    tags: ['directory'],
    auth: { permission: 'domain.users.read' },
    params: idParams,
    response: empty,
    stream: true,
    handler: async (c) => {
      const csv = passwords.take(c.params.id, c.user.sid);
      audit(c, 'directory.import.passwords-downloaded', { batch: c.params.id });
      void c.reply
        .header('content-disposition', `attachment; filename="passwords-${c.params.id}.csv"`)
        .header('cache-control', 'no-store')
        .type('text/csv; charset=utf-8')
        .send(csv);
      return Promise.resolve(undefined);
    },
  });

  t.add({
    method: 'DELETE',
    url: '/api/v1/directory/imports/:id',
    operationId: 'undoImport',
    summary: 'Undo an import: delete the accounts it created (bulk delete job)',
    tags: ['directory'],
    auth: { permission: 'domain.users.delete' },
    params: idParams,
    response: jobSchema,
    status: 202,
    handler: async (c) => {
      const b = d.db.get<{ created_json: string; undone_at: string | null }>(
        'SELECT created_json, undone_at FROM import_batches WHERE id = ?',
        [c.params.id],
      );
      if (!b) throw new PlatformError('request.not-found', { what: `Import ${c.params.id}` });
      if (b.undone_at) throw new PlatformError('request.conflict', { what: `Import ${c.params.id} (already undone)` });
      const created = JSON.parse(b.created_json) as { guid: string; sam: string }[];
      const dir = d.directory();
      const allowed = can(c);
      const job = d.jobs.start(
        'directory.import.undo',
        { name: c.user.username, sid: c.user.sid },
        async (progress) => {
          let deleted = 0;
          const failed: { sam: string; error: string }[] = [];
          let n = 0;
          for (const x of created) {
            try {
              const e = await dir.entryByGuid(x.guid, undefined, true).catch((err: unknown) => {
                if (isPlatformError(err) && err.code === 'request.not-found') return null;
                throw err;
              });
              if (e) {
                if (dir.isProtected(e)) throw new PlatformError('auth.tier0-required', { target: x.sam });
                if (!allowed('domain.users.delete', { dn: e.dn }))
                  throw new PlatformError('auth.forbidden', { permission: 'domain.users.delete' });
                await dir.delete(e.dn, false);
                deleted++;
              }
            } catch (e) {
              failed.push({ sam: x.sam, error: isPlatformError(e) ? e.code : 'internal' });
            }
            n++;
            if (n % 25 === 0 || n === created.length)
              progress({ step: 'objects', percent: Math.round((n / created.length) * 100) });
          }
          d.db.run('UPDATE import_batches SET undone_at = ? WHERE id = ?', [new Date().toISOString(), c.params.id]);
          d.audit.append({
            actor: c.user.username,
            actorSid: c.user.sid,
            sourceIp: c.ip,
            action: 'directory.import.undo',
            result: failed.length ? 'failure' : 'success',
            after: { batch: c.params.id, deleted, failed },
            requestId: c.requestId,
          });
          return { deleted, failed };
        },
      );
      return Promise.resolve(job);
    },
  });
}
