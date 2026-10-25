// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CSV user import (ROADMAP Phase 2, acceptance 5): a dry run computes exactly what would change per row
 * (create, update with a per-attribute diff, unchanged, or an error with the reason); applying re-plans on the
 * server (the client's preview is never trusted) and executes the plan. Every row is checked against RBAC the
 * same way the single-object routes are; protected (tier-0) accounts are never touched by an import.
 *
 * Empty cells leave attributes unchanged. `groups` lists group account names separated by "|". `enabled` takes
 * true/false/yes/no/1/0. `accountExpires` takes a date (YYYY-MM-DD), an ISO date-time or "never".
 */
import type { Entry } from 'ldapts';
import { PlatformError, isPlatformError } from '@opendc/shared';
import { userCreate, userFields, type ImportPreview } from '@opendc/shared/api';
import { domainFromDn, eq, or } from '@opendc/shared/ldap';
import type { z } from 'zod';
import { canonicalColumn, parseCsv } from './csv.ts';
import type { DirectoryService } from './service.ts';
import {
  USER_ATTRS,
  USER_STRING_FIELDS,
  filetimeToIso,
  guidOf,
  int,
  isoToFiletime,
  rdnValue,
  str,
  strs,
  UAC,
} from './model.ts';
import type { Mod } from './ldap.ts';

export interface TemplateLike {
  defaults: Record<string, string | undefined>;
  groups: string[];
  mustChangePassword: boolean;
  enabled: boolean;
}

export interface ImportContext {
  dir: DirectoryService;
  /** Non-throwing permission check (RBAC engine). */
  can: (permission: string, target: { dn: string; protected?: boolean }) => boolean;
  parentDn: string;
  template: TemplateLike | null;
  mode: 'create' | 'update' | 'upsert';
}

export interface PlannedRow {
  line: number;
  sam: string;
  action: 'create' | 'update' | 'unchanged' | 'error';
  changes: Record<string, { from: string | null; to: string | null }>;
  error: string | null;
  create?: z.output<typeof userCreate>;
  update?: { dn: string; guid: string; mods: Mod[] };
  /** Group DNs to add the account to. */
  groups: string[];
  password: string | null;
}

const MAX_ROWS = 20_000;
const TRUE = new Set(['true', 'yes', '1', 'ja', 'y', 'x']);
const FALSE = new Set(['false', 'no', '0', 'nein', 'n']);

/** Expands {firstname} {lastname} {sam} {domain}; mail/UPN values are lower-cased ASCII. */
export function expand(template: string, vars: Record<string, string>, ascii: boolean): string {
  const out = template.replace(/\{(firstname|lastname|sam|domain)\}/g, (_m, k: string) => vars[k] ?? '');
  return ascii ? out.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, '') : out;
}

function parseDate(v: string): string | null | undefined {
  const s = v.trim().toLowerCase();
  if (s === 'never' || s === 'nie') return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : new Date(v.trim());
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export async function planImport(
  csv: string,
  ctx: ImportContext,
): Promise<{ preview: ImportPreview; rows: PlannedRow[] }> {
  const table = parseCsv(csv);
  const header = table[0];
  if (!header) throw new PlatformError('validation.invalid', { issues: 'csv: empty file' });
  if (table.length - 1 > MAX_ROWS)
    throw new PlatformError('validation.invalid', { issues: `csv: more than ${String(MAX_ROWS)} rows` });
  const cols = header.map((h) => canonicalColumn(h));
  const ignored = header.filter((_h, i) => cols[i] === null);
  if (!cols.includes('sam'))
    throw new PlatformError('validation.invalid', { issues: 'csv: a "sam" (account name) column is required' });

  const records = table.slice(1).map((r, idx) => {
    const rec: Record<string, string> = {};
    cols.forEach((c, i) => {
      if (c) rec[c] = (r[i] ?? '').trim();
    });
    return { line: idx + 2, rec };
  });

  // existing accounts, by sAMAccountName (case-insensitive in AD)
  const sams = [...new Set(records.map((r) => r.rec.sam ?? '').filter(Boolean))];
  const existing = new Map<string, Entry>();
  for (let i = 0; i < sams.length; i += 100) {
    const found = await ctx.dir.ldap.search(ctx.dir.domainDn, {
      scope: 'sub',
      filter: or(...sams.slice(i, i + 100).map((s) => eq('sAMAccountName', s))),
      attributes: [...USER_ATTRS, 'tokenGroups'],
    });
    for (const e of found) existing.set((str(e, 'sAMAccountName') ?? '').toLowerCase(), e);
  }

  // group names -> DN (cached), with the permission to change their members
  const groupCache = new Map<string, { dn: string; error: string | null }>();
  const group = async (name: string): Promise<{ dn: string; error: string | null }> => {
    const key = name.toLowerCase();
    const hit = groupCache.get(key);
    if (hit) return hit;
    const [g] = await ctx.dir.ldap.search(ctx.dir.domainDn, {
      scope: 'sub',
      filter: eq('sAMAccountName', name),
      attributes: ['objectClass', 'adminCount', 'objectSid'],
    });
    const res = !g
      ? { dn: '', error: `group ${name} not found` }
      : ctx.dir.isProtected(g)
        ? { dn: g.dn, error: `group ${name} is protected (tier 0)` }
        : !ctx.can('domain.groups.members', { dn: g.dn })
          ? { dn: g.dn, error: `no permission to change members of ${name}` }
          : { dn: g.dn, error: null };
    groupCache.set(key, res);
    return res;
  };

  const domain = domainFromDn(ctx.dir.domainDn);
  const seen = new Set<string>();
  const rows: PlannedRow[] = [];
  const canCreate = ctx.can('domain.users.create', { dn: ctx.parentDn });

  for (const { line, rec } of records) {
    const sam = rec.sam ?? '';
    const row: PlannedRow = {
      line,
      sam,
      action: 'error',
      changes: {},
      error: null,
      groups: [],
      password: rec.password || null,
    };
    const fail = (msg: string): void => {
      row.action = 'error';
      row.error = msg;
      rows.push(row);
    };
    if (!sam) {
      fail('sam is empty');
      continue;
    }
    if (seen.has(sam.toLowerCase())) {
      fail(`duplicate sam ${sam} in the file`);
      continue;
    }
    seen.add(sam.toLowerCase());

    // fields from the row (empty = not given)
    const given: Record<string, string> = {};
    for (const f of Object.keys(userFields)) if (rec[f]) given[f] = rec[f] ?? '';
    let enabled: boolean | undefined;
    if (rec.enabled) {
      const v = rec.enabled.toLowerCase();
      if (TRUE.has(v)) enabled = true;
      else if (FALSE.has(v)) enabled = false;
      else {
        fail(`enabled: "${rec.enabled}" is not true/false`);
        continue;
      }
    }
    let accountExpires: string | null | undefined;
    if (rec.accountExpires) {
      accountExpires = parseDate(rec.accountExpires);
      if (accountExpires === undefined) {
        fail(`accountExpires: "${rec.accountExpires}" is not a date`);
        continue;
      }
    }
    const groupErrors: string[] = [];
    for (const gname of (rec.groups ?? '')
      .split('|')
      .map((x) => x.trim())
      .filter(Boolean)) {
      const g = await group(gname);
      if (g.error) groupErrors.push(g.error);
      else row.groups.push(g.dn);
    }
    if (groupErrors.length) {
      fail(groupErrors.join('; '));
      continue;
    }

    const cur = existing.get(sam.toLowerCase());
    if (!cur) {
      if (ctx.mode === 'update') {
        fail(`no account ${sam} (mode "update" doesn't create)`);
        continue;
      }
      if (!canCreate) {
        fail('no permission to create users in the target OU');
        continue;
      }
      // template defaults, then the row's own values
      const vars = { firstname: given.givenName ?? '', lastname: given.sn ?? '', sam, domain };
      const fromTemplate: Record<string, string> = {};
      for (const [k, v] of Object.entries(ctx.template?.defaults ?? {})) {
        if (v) fromTemplate[k] = expand(v, vars, k === 'mail' || k === 'userPrincipalName');
      }
      for (const g of ctx.template?.groups ?? []) row.groups.push(g);
      const input = {
        sam,
        ...fromTemplate,
        ...given,
        ...(accountExpires !== undefined ? { accountExpires } : {}),
        ...(rec.password ? { password: rec.password } : {}),
        mustChangePassword: ctx.template?.mustChangePassword ?? true,
        enabled: enabled ?? ctx.template?.enabled ?? true,
      };
      const parsed = userCreate.safeParse(input);
      if (!parsed.success) {
        fail(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        continue;
      }
      row.action = 'create';
      row.create = parsed.data;
      if (row.groups.length) row.changes.groups = { from: null, to: row.groups.map((g) => rdnValue(g)).join('|') };
      for (const [k, v] of Object.entries(input)) {
        if (k === 'password' || k === 'mustChangePassword' || k === 'sam') continue;
        row.changes[k] = { from: null, to: v === null ? null : String(v) };
      }
      rows.push(row);
      continue;
    }

    // update
    if (ctx.mode === 'create') {
      fail(`account ${sam} exists (mode "create" doesn't update)`);
      continue;
    }
    if (ctx.dir.isProtected(cur)) {
      fail(`${sam} is protected (tier 0); imports never change protected accounts`);
      continue;
    }
    if (!ctx.can('domain.users.write', { dn: cur.dn })) {
      fail(`no permission to change ${sam}`);
      continue;
    }
    const mods: Mod[] = [];
    for (const [field, value] of Object.entries(given)) {
      const attr = (USER_STRING_FIELDS as Record<string, string>)[field];
      if (!attr) {
        if (field === 'uidNumber' || field === 'gidNumber') {
          if (String(int(cur, field)) !== value) {
            row.changes[field] = { from: str(cur, field), to: value };
            mods.push({ op: 'replace', attr: field, values: [value] });
          }
        }
        continue;
      }
      const before = str(cur, attr);
      if (before !== value) {
        const check = (userFields as Record<string, z.ZodType>)[field]?.safeParse(value);
        if (check && !check.success) {
          fail(`${field}: ${check.error.issues[0]?.message ?? 'invalid'}`);
          break;
        }
        row.changes[field] = { from: before, to: value };
        mods.push({ op: 'replace', attr, values: [value] });
      }
    }
    if (row.action === 'error' && row.error) continue;
    if (accountExpires !== undefined) {
      const before = filetimeToIso(str(cur, 'accountExpires'));
      if (before !== accountExpires) {
        row.changes.accountExpires = { from: before, to: accountExpires };
        mods.push({ op: 'replace', attr: 'accountExpires', values: [isoToFiletime(accountExpires)] });
      }
    }
    if (enabled !== undefined) {
      const uac = int(cur, 'userAccountControl') ?? UAC.normal;
      const was = (uac & UAC.disabled) === 0;
      if (was !== enabled) {
        row.changes.enabled = { from: String(was), to: String(enabled) };
        mods.push({
          op: 'replace',
          attr: 'userAccountControl',
          values: [String(enabled ? uac & ~UAC.disabled : uac | UAC.disabled)],
        });
      }
    }
    const memberOf = new Set(strs(cur, 'memberOf').map((x) => x.toLowerCase()));
    row.groups = row.groups.filter((g) => !memberOf.has(g.toLowerCase()));
    if (row.groups.length) row.changes.groups = { from: null, to: row.groups.map((g) => rdnValue(g)).join('|') };
    if (rec.password) row.changes.password = { from: null, to: '(new password)' };
    row.update = { dn: cur.dn, guid: guidOf(cur), mods };
    row.action = mods.length || row.groups.length || rec.password ? 'update' : 'unchanged';
    rows.push(row);
  }

  const counts = { create: 0, update: 0, unchanged: 0, error: 0 };
  for (const r of rows) counts[r.action]++;
  return {
    rows,
    preview: {
      rows: rows.map(({ line, sam, action, changes, error }) => ({ line, sam, action, changes, error })),
      counts,
      columns: cols.filter((c): c is string => c !== null),
      ignored,
    },
  };
}

export interface ApplyResult {
  created: { guid: string; sam: string }[];
  updated: number;
  failed: { line: number; sam: string; error: string }[];
  generated: { sam: string; password: string }[];
}

/** Executes a plan. Rows fail independently; `progress` reports every 25 rows. */
export async function applyImport(
  rows: PlannedRow[],
  ctx: ImportContext,
  generatePassword: () => string,
  progress: (done: number, total: number) => void,
): Promise<ApplyResult> {
  const out: ApplyResult = { created: [], updated: 0, failed: [], generated: [] };
  const work = rows.filter((r) => r.action === 'create' || r.action === 'update');
  let done = 0;
  for (const r of work) {
    try {
      if (r.action === 'create' && r.create) {
        const pw = r.password ?? generatePassword();
        const created = await ctx.dir.createUser(ctx.parentDn, r.create, pw);
        out.created.push({ guid: created.guid, sam: r.sam });
        if (!r.password) out.generated.push({ sam: r.sam, password: pw });
        for (const g of r.groups) await ctx.dir.changeMembers(g, [created.dn], []);
      } else if (r.update) {
        await ctx.dir.modify(r.update.dn, r.update.mods);
        if (r.password) await ctx.dir.setPassword(r.update.dn, r.password, false, false);
        for (const g of r.groups) await ctx.dir.changeMembers(g, [r.update.dn], []);
        out.updated++;
      }
    } catch (e) {
      out.failed.push({ line: r.line, sam: r.sam, error: isPlatformError(e) ? e.message : String(e) });
    }
    done++;
    if (done % 25 === 0 || done === work.length) progress(done, work.length);
  }
  return out;
}
