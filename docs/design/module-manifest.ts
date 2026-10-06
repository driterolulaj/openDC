/**
 * MyUCS module manifest contract (ADR-0022).
 *
 * A manifest is a PLAIN DATA object: no functions, no imports of module code, no side effects.
 * Code is referenced by module-relative entry paths, which `npm run gen` turns into per-target
 * generated registries (API, web, watcher, registry, agent allowlist, permissions, i18n).
 *
 * Phase 1: moves to packages/shared/src/manifest/types.ts, with a matching Zod schema
 * (manifest.schema.ts) used by the generator to validate every manifest.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** kebab-case, 2–32 chars, e.g. "dhcp", "users", "app-center". */
export type ModuleId = string & { readonly __brand: 'ModuleId' };
/** Semantic version "1.4.2". */
export type SemVer = string & { readonly __brand: 'SemVer' };
/** Semver range, e.g. ">=1.2.0 <2.0.0". */
export type SemVerRange = string & { readonly __brand: 'SemVerRange' };
/** i18n key "<namespace>:<key>", e.g. "dhcp:title". */
export type I18nKey = string & { readonly __brand: 'I18nKey' };
/** Module-relative path to a TS/TSX entry, e.g. "./api/index.ts". Must stay inside the module dir. */
export type EntryPath = `./${string}`;
/** "<moduleId>.<resource>.<action>", e.g. "users.user.resetPassword". */
export type PermissionName = string & { readonly __brand: 'PermissionName' };
/** Agent operation id from the catalogue, e.g. "service.reload". */
export type AgentOperationId = string & { readonly __brand: 'AgentOperationId' };
/** Dotted registry key, must start with "<moduleId>.", e.g. "dhcp.dhcp4.interfaces". */
export type RegistryKeyName = string & { readonly __brand: 'RegistryKeyName' };
/** Managed file id, "<moduleId>.<name>", e.g. "dhcp.kea-dhcp4". Mapped to a path by the OS adapter. */
export type ManagedFileId = string & { readonly __brand: 'ManagedFileId' };
/** Managed systemd unit id (logical), resolved to a real unit name by the OS adapter, e.g. "kea-dhcp4". */
export type ManagedUnitId = string & { readonly __brand: 'ManagedUnitId' };

export type NodeRole = 'primary-dc' | 'dc' | 'rodc' | 'member' | 'managed-node';
/** Convenience groups used in manifests. */
export type RoleSelector = NodeRole | 'any-dc' | 'writable-dc' | 'any';

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface ModuleManifest {
  /** Manifest format version; the generator rejects unknown majors. */
  manifestVersion: 1;
  id: ModuleId;
  version: SemVer;
  title: I18nKey;
  description: I18nKey;

  /** Compatibility and dependencies. */
  requires?: {
    platform?: SemVerRange;
    modules?: Partial<Record<ModuleId, SemVerRange>>;
    /** Capabilities computed from the domain (min across writable DCs) — module disabled otherwise. */
    capabilities?: DomainCapability[];
  };

  /** Where node-side parts (watcher handlers, registry templates, diagnostics) activate. */
  roles: RoleSelector[];

  /** Can admins disable this module per installation? Core modules (auth, audit, nodes) cannot. */
  optional: boolean;

  permissions: PermissionDefinition[];
  api?: ApiContribution;
  ui?: UiContribution;
  registry?: RegistryContribution;
  watchers?: WatcherHandlerDefinition[];
  /** Agent operations this module's code may call (must exist in the catalogue; per-caller socket). */
  agentOperations?: AgentOperationUse[];
  /** Managed resources the agent will accept on this module's behalf. Compiled into the allowlist. */
  managed?: ManagedResources;
  directory?: DirectoryContribution;
  diagnostics?: DiagnosticDefinition[];
  jobs?: JobDefinition[];
  /** Deployment-profile section this module owns (Phase 4), validated by its schema entry. */
  profile?: { section: string; schema: EntryPath; apply: EntryPath; export: EntryPath };
  i18n: { namespaces: string[] };
}

export type DomainCapability =
  | 'rfc2307'
  | 'cloud-extension-attributes' // msDS-cloudExtensionAttribute1..20 (2012+ schema)
  | 'fl-2012r2'
  | 'fl-2016'
  | 'gmsa'
  | 'rodc'
  | 'dns-bind9-dlz'
  | 'claims';

// ---------------------------------------------------------------------------
// Permissions / RBAC
// ---------------------------------------------------------------------------

export interface PermissionDefinition {
  name: PermissionName;
  title: I18nKey;
  /**
   * How the permission is scoped when assigned in a role:
   *  - "ou":     evaluated against the target object's DN (subtree of the assignment's scope OUs)
   *  - "node":   evaluated against target node(s) / node OU
   *  - "global": no scope (e.g. view diagnostics)
   */
  scope: 'ou' | 'node' | 'global';
  /** Tier-0 permissions are only grantable to roles flagged tier0 and require re-auth/TOTP when used. */
  tier0?: boolean;
  /** Permissions implied by this one (e.g. write implies read). */
  implies?: PermissionName[];
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface ApiContribution {
  /** Fastify plugin entry; mounted under /api/v1/<moduleId>. Routes declare operationId + permission. */
  entry: EntryPath;
  /** Optional node-RPC handlers (mTLS listener), mounted under /node/v1/<moduleId>. */
  nodeRpcEntry?: EntryPath;
  /** Public (unauthenticated) routes this module exposes, listed explicitly for review + rate limiting. */
  publicRoutes?: { method: 'GET' | 'POST'; path: string; rateLimit: { max: number; windowSec: number } }[];
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export type UiArea = 'console' | 'portal' | 'self-service';

export interface UiContribution {
  routes: UiRoute[];
  /** Navigation entries in the console sidebar. */
  navigation?: UiNavItem[];
  /** Widgets for the console dashboard. */
  dashboardWidgets?: { id: string; entry: EntryPath; permission?: PermissionName; size: 'sm' | 'md' | 'lg' }[];
  /** Tabs/sections contributed into another module's object form (e.g. "Unix" tab on users). */
  formExtensions?: { target: `${string}:${string}`; entry: EntryPath; permission?: PermissionName }[];
}

export interface UiRoute {
  area: UiArea;
  /** Path relative to the area root, e.g. "dhcp/subnets/:id". */
  path: string;
  /** Lazy-loaded React component (default export). */
  entry: EntryPath;
  /** Route is hidden and 403s client-side without it (server enforces regardless). */
  permission?: PermissionName;
}

export interface UiNavItem {
  id: string;
  label: I18nKey;
  /** Icon name from the bundled icon set (no runtime icon loading). */
  icon: string;
  to: string;
  group: 'directory' | 'network' | 'services' | 'apps' | 'system' | 'security';
  order: number;
  permission?: PermissionName;
}

// ---------------------------------------------------------------------------
// Config Registry
// ---------------------------------------------------------------------------

export interface RegistryContribution {
  /** Exports `keys: RegistryKeyDefinition[]` (Zod schemas need code, so keys live in an entry). */
  keysEntry: EntryPath;
  templates: TemplateDefinition[];
}

/** Shape exported by keysEntry (documented here for reference). */
export interface RegistryKeyDefinition {
  name: RegistryKeyName;
  /** Zod schema (runtime object in the entry file). */
  schema: unknown;
  default?: unknown;
  description: I18nKey;
  /** Whether a domain policy of type "registry" may set this key. */
  policySettable: boolean;
  /** Restart/reload hint shown in the UI when changed. */
  effect?: 'none' | 'reload' | 'restart' | 'reboot';
}

export interface TemplateDefinition {
  fileId: ManagedFileId;
  /** Template function entry: `export default (view, ctx) => string`. */
  entry: EntryPath;
  /** Keys read — used to compute which templates a change affects. Globs allowed: "dhcp.*". */
  reads: (RegistryKeyName | `${string}.*`)[];
  /** Also re-render when these directory-derived inputs change (provided by watcher handlers). */
  inputs?: string[];
  /** Actions after the file changed, in order. */
  onChange?: TemplateHandler[];
  roles: RoleSelector[];
}

export type TemplateHandler =
  | { kind: 'service'; action: 'reload' | 'restart' | 'try-reload-or-restart'; unit: ManagedUnitId }
  | { kind: 'agent-op'; op: AgentOperationId; args?: Record<string, unknown> }
  | { kind: 'validate'; op: AgentOperationId; args?: Record<string, unknown> }; // e.g. kea config-test before swap

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

export interface WatcherHandlerDefinition {
  id: string;
  /** Base DN relative to the domain DN, or a token: "{platform}" = CN=MyUCS,CN=System,<domain>. */
  base: string;
  scope: 'base' | 'one' | 'sub';
  /** LDAP filter (static, validated at gen time). */
  filter: string;
  attributes: string[];
  roles: RoleSelector[];
  /** Handler entry: `export default { onChange(evt, ctx), onSync?(all, ctx) }`. */
  entry: EntryPath;
  timeoutMs?: number;
  /** Debounce identical-target events (ms) — e.g. bulk DHCP edits → one Kea render. */
  debounceMs?: number;
}

// ---------------------------------------------------------------------------
// Agent / managed resources
// ---------------------------------------------------------------------------

export interface AgentOperationUse {
  op: AgentOperationId;
  /** Which caller socket(s) the module's code calls it from. */
  from: ('api' | 'watcher' | 'cli')[];
}

export interface ManagedResources {
  files?: ManagedFileDefinition[];
  units?: ManagedUnitDefinition[];
  /** Named package sets the agent may install/remove (resolved per distro by the OS adapter). */
  packageSets?: { id: string; logicalPackages: string[]; roles: RoleSelector[] }[];
  /** Firewall port sets the agent may open. */
  firewall?: { id: string; ports: { port: number | [number, number]; proto: 'tcp' | 'udp' }[]; roles: RoleSelector[] }[];
  /** Secrets the module owns (generated/rotated by the agent; delivered via systemd credential or podman secret). */
  secrets?: { id: string; kind: 'password' | 'tsig-key' | 'keytab' | 'private-key' | 'token'; rotateDays?: number }[];
}

export interface ManagedFileDefinition {
  fileId: ManagedFileId;
  /** Logical path key resolved by OsFacts.paths.managedFile(fileId); never a literal path here. */
  pathKey: string;
  owner: 'root' | 'service';
  /** Octal string, e.g. "0644". Files under /etc/myucs/secrets are rejected here. */
  mode: string;
  comment: 'hash' | 'semicolon' | 'slash' | 'xml' | 'json-field' | 'none';
}

export interface ManagedUnitDefinition {
  unit: ManagedUnitId;
  allowed: ('start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable' | 'status')[];
}

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

export interface DirectoryContribution {
  /** Sub-containers this module owns under CN=MyUCS,CN=System (created at provisioning/upgrade). */
  containers?: { rdn: string; purpose: I18nKey }[];
  /** Platform object kinds (payload schemas) — see directory-object-model.md. */
  objectKinds?: { kind: string; container: string; schemaEntry: EntryPath; payloadVersion: number }[];
  /** Standard AD classes the module reads/writes (documentation + permission generation). */
  usesClasses?: { objectClass: string; access: 'read' | 'write' }[];
  /** Upgrade migrations for this module's payloads (run by the leader, idempotent). */
  migrations?: { toVersion: number; entry: EntryPath }[];
}

// ---------------------------------------------------------------------------
// Diagnostics & jobs
// ---------------------------------------------------------------------------

export type Severity = 'info' | 'warning' | 'error' | 'critical';

export interface DiagnosticDefinition {
  id: string;
  title: I18nKey;
  roles: RoleSelector[];
  /** `export default async (ctx) => DiagnosticResult[]` (results carry severity, message key, fix key, params). */
  entry: EntryPath;
  /** Run interval; "manual" = only on demand. */
  interval: 'manual' | `${number}m` | `${number}h`;
  /** Whether a one-click remediation exists (calls a named agent op after confirmation). */
  fix?: { op: AgentOperationId; confirm: 'simple' | 'typed' };
}

export interface JobDefinition {
  id: string;
  title: I18nKey;
  entry: EntryPath;
  /** "leader" = only on the PDC emulator (ADR-0017). */
  runOn: 'leader' | 'each-node' | 'on-demand';
  schedule?: string; // systemd OnCalendar syntax, overridable by policy
  permission: PermissionName;
}
