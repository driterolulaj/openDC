// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Module manifest contract (ADR-0022, docs/design/module-manifest.ts). The Zod schema is the single source
 * of truth; `ModuleManifest` is derived from it. A manifest is plain data: modules write
 * `export default { ... } satisfies ModuleManifest` with a type-only import, so loading a manifest runs no
 * module code.
 */
import { z } from 'zod';

const moduleId = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, 'kebab-case, 2-32 characters');
const semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'semantic version');
const semverRange = z.string().min(1);
const i18nKey = z.string().regex(/^[a-z][a-z0-9-]*:[A-Za-z0-9_.-]+$/, '"<namespace>:<key>"');
const entryPath = z
  .string()
  .regex(/^\.\/[A-Za-z0-9_./-]+\.tsx?$/, 'module-relative "./path.ts"')
  .refine((p) => !p.split('/').includes('..'), 'must stay inside the module directory');
const dotted = z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-zA-Z0-9-]+)+$/);

export const nodeRoles = ['primary-dc', 'dc', 'rodc', 'member', 'managed-node'] as const;
export const roleSelector = z.enum([...nodeRoles, 'any-dc', 'writable-dc', 'any']);
export type NodeRole = (typeof nodeRoles)[number];
export type RoleSelector = z.infer<typeof roleSelector>;

export const domainCapability = z.enum([
  'rfc2307',
  'cloud-extension-attributes',
  'fl-2012r2',
  'fl-2016',
  'gmsa',
  'rodc',
  'dns-bind9-dlz',
  'claims',
]);

export const permissionDefinition = z.strictObject({
  /** "<moduleId>.<resource>.<action>" */
  name: dotted,
  title: i18nKey,
  scope: z.enum(['ou', 'node', 'global']),
  tier0: z.boolean().optional(),
  implies: z.array(dotted).optional(),
});

const apiContribution = z.strictObject({
  entry: entryPath,
  nodeRpcEntry: entryPath.optional(),
  publicRoutes: z
    .array(
      z.strictObject({
        method: z.enum(['GET', 'POST']),
        path: z.string().startsWith('/'),
        rateLimit: z.strictObject({ max: z.number().int().positive(), windowSec: z.number().int().positive() }),
      }),
    )
    .optional(),
});

const uiContribution = z.strictObject({
  routes: z.array(
    z.strictObject({
      area: z.enum(['console', 'portal', 'self-service']),
      path: z.string(),
      entry: entryPath,
      permission: dotted.optional(),
    }),
  ),
  navigation: z
    .array(
      z.strictObject({
        id: z.string(),
        label: i18nKey,
        icon: z.string(),
        to: z.string(),
        group: z.enum(['directory', 'network', 'services', 'apps', 'system', 'security']),
        order: z.number().int(),
        permission: dotted.optional(),
      }),
    )
    .optional(),
  dashboardWidgets: z
    .array(
      z.strictObject({
        id: z.string(),
        entry: entryPath,
        permission: dotted.optional(),
        size: z.enum(['sm', 'md', 'lg']),
      }),
    )
    .optional(),
  formExtensions: z
    .array(
      z.strictObject({
        target: z.string().regex(/^[a-z0-9-]+:[A-Za-z0-9-]+$/),
        entry: entryPath,
        permission: dotted.optional(),
      }),
    )
    .optional(),
});

const templateHandler = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('service'),
    action: z.enum(['reload', 'restart', 'try-reload-or-restart']),
    unit: z.string(),
  }),
  z.strictObject({ kind: z.literal('agent-op'), op: dotted, args: z.record(z.string(), z.unknown()).optional() }),
  z.strictObject({ kind: z.literal('validate'), op: dotted, args: z.record(z.string(), z.unknown()).optional() }),
]);

export const templateDefinition = z.strictObject({
  fileId: dotted,
  entry: entryPath,
  reads: z.array(z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-zA-Z0-9-]+)*(?:\.\*)?$/)).min(1),
  inputs: z.array(z.string()).optional(),
  onChange: z.array(templateHandler).optional(),
  roles: z.array(roleSelector).min(1),
});

const registryContribution = z.strictObject({
  keysEntry: entryPath,
  templates: z.array(templateDefinition),
});

const watcherHandler = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  base: z.string(),
  scope: z.enum(['base', 'one', 'sub']),
  filter: z.string().startsWith('('),
  /**
   * DirSync semantics: with a list, an object is delivered only when one of these attributes changed (objectGUID
   * doesn't count; a move changes `name`, a deletion `isDeleted`); an empty list means any change. The event
   * carries only the changed attributes.
   */
  attributes: z.array(z.string()),
  roles: z.array(roleSelector).min(1),
  /** Runs only on the DC that holds the PDC emulator role (ADR-0017), e.g. handlers that write shared state. */
  leader: z.boolean().optional(),
  entry: entryPath,
  timeoutMs: z.number().int().positive().optional(),
  debounceMs: z.number().int().nonnegative().optional(),
});

export const managedFileDefinition = z.strictObject({
  fileId: dotted,
  pathKey: z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/),
  owner: z.enum(['root', 'service']),
  mode: z.string().regex(/^0[0-7]{3}$/),
  comment: z.enum(['hash', 'semicolon', 'slash', 'xml', 'json-field', 'none']),
});

export const managedUnitDefinition = z.strictObject({
  unit: z.string().regex(/^[a-z][a-z0-9@._-]*$/),
  allowed: z.array(z.enum(['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'status'])).min(1),
});

const managedResources = z.strictObject({
  files: z.array(managedFileDefinition).optional(),
  units: z.array(managedUnitDefinition).optional(),
  packageSets: z
    .array(
      z.strictObject({
        id: z.string(),
        logicalPackages: z.array(z.string()).min(1),
        roles: z.array(roleSelector).min(1),
      }),
    )
    .optional(),
  firewall: z
    .array(
      z.strictObject({
        id: z.string(),
        ports: z.array(
          z.strictObject({
            port: z.union([z.number().int().min(1).max(65535), z.tuple([z.number().int(), z.number().int()])]),
            proto: z.enum(['tcp', 'udp']),
          }),
        ),
        roles: z.array(roleSelector).min(1),
      }),
    )
    .optional(),
  secrets: z
    .array(
      z.strictObject({
        id: z.string(),
        kind: z.enum(['password', 'tsig-key', 'keytab', 'private-key', 'token']),
        rotateDays: z.number().int().positive().optional(),
      }),
    )
    .optional(),
});

const directoryContribution = z.strictObject({
  containers: z.array(z.strictObject({ rdn: z.string(), purpose: i18nKey })).optional(),
  objectKinds: z
    .array(
      z.strictObject({
        kind: z.string(),
        container: z.string(),
        schemaEntry: entryPath,
        payloadVersion: z.number().int().positive(),
      }),
    )
    .optional(),
  usesClasses: z.array(z.strictObject({ objectClass: z.string(), access: z.enum(['read', 'write']) })).optional(),
  migrations: z.array(z.strictObject({ toVersion: z.number().int().positive(), entry: entryPath })).optional(),
});

const diagnosticDefinition = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9.-]*$/),
  title: i18nKey,
  roles: z.array(roleSelector).min(1),
  entry: entryPath,
  interval: z.union([z.literal('manual'), z.string().regex(/^\d+[mh]$/)]),
  fix: z.strictObject({ op: dotted, confirm: z.enum(['simple', 'typed']) }).optional(),
});

const jobDefinition = z.strictObject({
  id: z.string(),
  title: i18nKey,
  entry: entryPath,
  runOn: z.enum(['leader', 'each-node', 'on-demand']),
  schedule: z.string().optional(),
  permission: dotted,
});

export const agentSocket = z.enum(['api', 'watch', 'cli']);
export type AgentSocket = z.infer<typeof agentSocket>;

export const manifestSchema = z.strictObject({
  manifestVersion: z.literal(1),
  id: moduleId,
  version: semver,
  title: i18nKey,
  description: i18nKey,
  requires: z
    .strictObject({
      platform: semverRange.optional(),
      modules: z.record(moduleId, semverRange).optional(),
      capabilities: z.array(domainCapability).optional(),
    })
    .optional(),
  roles: z.array(roleSelector).min(1),
  optional: z.boolean(),
  permissions: z.array(permissionDefinition),
  api: apiContribution.optional(),
  ui: uiContribution.optional(),
  registry: registryContribution.optional(),
  watchers: z.array(watcherHandler).optional(),
  agentOperations: z.array(z.strictObject({ op: dotted, from: z.array(agentSocket).min(1) })).optional(),
  managed: managedResources.optional(),
  directory: directoryContribution.optional(),
  diagnostics: z.array(diagnosticDefinition).optional(),
  jobs: z.array(jobDefinition).optional(),
  profile: z.strictObject({ section: z.string(), schema: entryPath, apply: entryPath, export: entryPath }).optional(),
  i18n: z.strictObject({ namespaces: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).min(1) }),
});

export type ModuleManifest = z.input<typeof manifestSchema>;
export type PermissionDefinition = z.infer<typeof permissionDefinition>;
export type TemplateDefinition = z.infer<typeof templateDefinition>;
export type ManagedFileDefinition = z.infer<typeof managedFileDefinition>;
export type ManagedUnitDefinition = z.infer<typeof managedUnitDefinition>;

/** Does a node with `role` match any of the selectors? */
export function roleMatches(role: NodeRole, selectors: readonly RoleSelector[]): boolean {
  return selectors.some(
    (s) =>
      s === 'any' ||
      s === role ||
      (s === 'any-dc' && (role === 'primary-dc' || role === 'dc' || role === 'rodc')) ||
      (s === 'writable-dc' && (role === 'primary-dc' || role === 'dc')),
  );
}
