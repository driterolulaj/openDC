// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Saved searches, user templates, bulk operations and CSV import/export (ROADMAP Phase 2). Browser-safe.
 */
import { z } from 'zod';
import { listQuery } from './directory.ts';

// ---- saved searches ----
export const savedSearchQuery = listQuery.pick({ base: true, scope: true, types: true, q: true, status: true });
export const savedSearch = z.object({
  id: z.string(),
  name: z.string(),
  query: savedSearchQuery,
  shared: z.boolean(),
  owner: z.string(),
  mine: z.boolean(),
});
export type SavedSearch = z.infer<typeof savedSearch>;
export const savedSearchInput = z.strictObject({
  name: z.string().min(1).max(64),
  query: savedSearchQuery,
  /** Visible to everyone with console access (needs domain.search.share). */
  shared: z.boolean().default(false),
});
export const savedSearches = z.object({ searches: z.array(savedSearch) });

// ---- user templates ----
/**
 * Defaults applied when a user is created from the template. String values may use the placeholders
 * {firstname}, {lastname}, {sam} and {domain} (e.g. mail "{firstname}.{lastname}@example.com").
 */
export const templateDefaults = z.strictObject({
  title: z.string().max(128).optional(),
  department: z.string().max(64).optional(),
  company: z.string().max(64).optional(),
  office: z.string().max(128).optional(),
  description: z.string().max(1024).optional(),
  mail: z.string().max(256).optional(),
  userPrincipalName: z.string().max(256).optional(),
  homeDirectory: z.string().max(256).optional(),
  homeDrive: z.string().max(2).optional(),
  profilePath: z.string().max(256).optional(),
  scriptPath: z.string().max(256).optional(),
  loginShell: z.string().max(128).optional(),
  unixHomeDirectory: z.string().max(256).optional(),
});
export const userTemplateInput = z.strictObject({
  name: z.string().min(1).max(64),
  description: z.string().max(512).nullable().default(null),
  /** OU to create users in (objectGUID). */
  parent: z.uuid().nullable().default(null),
  defaults: templateDefaults.default({}),
  groups: z.array(z.uuid()).max(100).default([]),
  mustChangePassword: z.boolean().default(true),
  enabled: z.boolean().default(true),
});
export const userTemplate = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  parent: z.string().nullable(),
  parentDn: z.string().nullable(),
  defaults: templateDefaults,
  groups: z.array(z.object({ guid: z.string(), name: z.string() })),
  mustChangePassword: z.boolean(),
  enabled: z.boolean(),
});
export type UserTemplate = z.infer<typeof userTemplate>;
export const userTemplates = z.object({ templates: z.array(userTemplate) });

// ---- bulk ----
export const bulkRequest = z.strictObject({
  guids: z.array(z.uuid()).min(1).max(10_000),
  action: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('enable') }),
    z.strictObject({ kind: z.literal('disable') }),
    z.strictObject({ kind: z.literal('delete') }),
    z.strictObject({ kind: z.literal('move'), parent: z.uuid() }),
    z.strictObject({
      kind: z.literal('set'),
      /** Attributes set on every user (empty string clears). */
      values: z
        .strictObject({
          description: z.string().max(1024),
          department: z.string().max(64),
          company: z.string().max(64),
          title: z.string().max(128),
          office: z.string().max(128),
          accountExpires: z.iso.datetime({ offset: true }).nullable(),
        })
        .partial(),
    }),
    z.strictObject({ kind: z.literal('addToGroup'), group: z.uuid() }),
    z.strictObject({ kind: z.literal('removeFromGroup'), group: z.uuid() }),
    /** RFC2307 IDs (idBase + RID) for users and groups that have none (ADR-0018, Q22). */
    z.strictObject({ kind: z.literal('fillPosixIds') }),
  ]),
});
export type BulkRequest = z.input<typeof bulkRequest>;
export const bulkItemResult = z.object({
  guid: z.string(),
  name: z.string(),
  ok: z.boolean(),
  /** error code (from the error catalogue) when not ok */
  error: z.string().nullable(),
});
export const bulkResult = z.object({ done: z.number(), failed: z.number(), items: z.array(bulkItemResult) });

// ---- CSV import/export ----
/** Columns understood by import and produced by export (header names; aliases are accepted on import). */
export const csvColumns = [
  'sam',
  'givenName',
  'sn',
  'displayName',
  'initials',
  'description',
  'mail',
  'userPrincipalName',
  'telephoneNumber',
  'mobile',
  'title',
  'department',
  'company',
  'office',
  'streetAddress',
  'city',
  'postalCode',
  'country',
  'employeeId',
  'homeDirectory',
  'homeDrive',
  'profilePath',
  'scriptPath',
  'loginShell',
  'unixHomeDirectory',
  'accountExpires',
  'enabled',
  'groups',
  'password',
] as const;
export type CsvColumn = (typeof csvColumns)[number];

export const importRequest = z.strictObject({
  /** CSV text (UTF-8; comma or semicolon separated; header row required). */
  csv: z.string().min(1).max(5_000_000),
  /** OU for new users (objectGUID); default: the template's or CN=Users. */
  parent: z.uuid().optional(),
  templateId: z.string().max(64).optional(),
  /** create: only new accounts; update: only existing; upsert: both. Matching is by sam. */
  mode: z.enum(['create', 'update', 'upsert']).default('create'),
});
export type ImportRequest = z.input<typeof importRequest>;

export const importRow = z.object({
  line: z.number(),
  sam: z.string(),
  action: z.enum(['create', 'update', 'unchanged', 'error']),
  changes: z.record(z.string(), z.object({ from: z.string().nullable(), to: z.string().nullable() })),
  error: z.string().nullable(),
});
export const importPreview = z.object({
  rows: z.array(importRow),
  counts: z.object({ create: z.number(), update: z.number(), unchanged: z.number(), error: z.number() }),
  /** Columns that were recognised, and ones that weren't (ignored). */
  columns: z.array(z.string()),
  ignored: z.array(z.string()),
});
export type ImportPreview = z.infer<typeof importPreview>;

export const importBatch = z.object({
  id: z.string(),
  actor: z.string(),
  createdAt: z.string(),
  created: z.number(),
  updated: z.number(),
  failed: z.number(),
  /** Generated passwords can be downloaded once, for a short time, while the API keeps them in memory. */
  passwordsAvailable: z.boolean(),
  undone: z.boolean(),
});
export const importBatches = z.object({ batches: z.array(importBatch) });
export const exportQuery = listQuery.omit({ offset: true, limit: true, sort: true, order: true }).extend({
  columns: z
    .string()
    .regex(/^[A-Za-z,]+$/)
    .optional(),
});
