// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Setup contract (ROADMAP Phase 2: setup wizard and `opendc setup`): pre-flight checks, primary-DC
 * provisioning and DC join. The same schemas validate the wizard, the CLI, the API and the agent operations.
 */
import { z } from 'zod';
import { adminPasswordSchema, cidr4Schema, dnsDomainSchema, fqdnSchema, netbiosSchema } from './names.ts';

export const setupRoles = ['primary-dc', 'dc'] as const;
export type SetupRole = (typeof setupRoles)[number];

/** Base schemas offered for new domains (ROADMAP: 2012_R2/2016 schema choice). */
export const baseSchemas = ['2012_R2', '2016'] as const;
export const functionalLevels = ['2008_R2', '2012', '2012_R2', '2016'] as const;

/** Default first ID for RID-based UIDs/GIDs (ADR-0018; OPEN-QUESTIONS Q14 proposal). */
export const DEFAULT_ID_BASE = 100_000;
export const DEFAULT_SITE = 'Default-First-Site-Name';

const ipv4 = z.ipv4();
const siteName = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, 'letters, digits and hyphens');
const ntpServer = z
  .string()
  .max(253)
  .regex(/^[A-Za-z0-9.-]+$/, 'host name or IPv4 address');
/** Where to reach an existing DC: IPv4 address or FQDN. */
const dcHost = z.union([ipv4, fqdnSchema]);

export const networkSettings = z.strictObject({
  /** The host's own FQDN: <host>.<DNS domain of the realm>. */
  fqdn: fqdnSchema,
  /** Static IPv4 address of the host, already configured on an interface. */
  hostIp: ipv4,
  /** Upstream DNS servers the DC forwards to (Samba internal DNS: global forwarders only). */
  dnsForwarders: z.array(ipv4).max(2),
  /** Upstream NTP servers for the DC. */
  ntpServers: z.array(ntpServer).max(4).default([]),
  /** Networks allowed to query this DC's time service. */
  ntpAllow: z.array(cidr4Schema).max(16).default([]),
});

export const provisionArgs = z.strictObject({
  ...networkSettings.shape,
  /** DNS domain of the AD domain; the Kerberos realm is its upper-case form. */
  domain: dnsDomainSchema,
  netbiosDomain: netbiosSchema,
  /** Initial password of the domain Administrator. Redacted from logs; never stored. */
  adminPassword: adminPasswordSchema,
  baseSchema: z.enum(baseSchemas).default('2016'),
  /** 2008_R2 works with every supported Samba; 2016 needs Samba ≥ 4.19 on every DC. */
  functionalLevel: z.enum(functionalLevels).default('2008_R2'),
  dnsBackend: z.literal('SAMBA_INTERNAL').default('SAMBA_INTERNAL'),
  siteName: siteName.default(DEFAULT_SITE),
  idBase: z.number().int().min(1000).max(2_000_000_000).default(DEFAULT_ID_BASE),
});
export type ProvisionArgs = z.input<typeof provisionArgs>;

export const joinArgs = z.strictObject({
  ...networkSettings.shape,
  domain: dnsDomainSchema,
  /** An existing writable DC of the domain. */
  dcHost,
  /** Domain account allowed to add DCs (normally a Domain Admin): sAMAccountName or UPN. */
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(256),
  siteName: siteName.default(DEFAULT_SITE),
});
export type JoinArgs = z.input<typeof joinArgs>;

export const preflightArgs = z.strictObject({
  role: z.enum(setupRoles),
  fqdn: z.string().max(253),
  hostIp: z.string().max(45),
  domain: z.string().max(253),
  netbiosDomain: z.string().max(32).optional(),
  dnsForwarders: z.array(z.string().max(45)).max(2).default([]),
  /** Join only: the existing DC. */
  dcHost: z.string().max(253).optional(),
});
export type PreflightArgs = z.input<typeof preflightArgs>;

export const checkStatus = z.enum(['pass', 'warn', 'fail']);
export type CheckStatus = z.infer<typeof checkStatus>;

/** Check ids. Texts: `setup:check.<id>.<status>` and `setup:check.<id>.fix` (setupI18n). */
export const preflightCheckIds = [
  'os-support',
  'samba-version',
  'not-provisioned',
  'hostname',
  'fqdn-domain',
  'netbios',
  'ip-assigned',
  'ip-static',
  'port-53',
  'ports',
  'disk',
  'filesystem',
  'memory',
  'mac',
  'time',
  'dns-forwarder',
  'dc-resolve',
  'dc-reachable',
  'dc-dns',
  'dc-time',
] as const;
export type PreflightCheckId = (typeof preflightCheckIds)[number];

export const preflightCheck = z.object({
  id: z.enum(preflightCheckIds),
  status: checkStatus,
  params: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type PreflightCheck = z.infer<typeof preflightCheck>;

export const preflightResult = z.object({
  checks: z.array(preflightCheck),
  /** No check failed. Warnings don't block. */
  ok: z.boolean(),
});
export type PreflightResult = z.infer<typeof preflightResult>;

export const setupState = z.object({
  /** This host is a DC of a domain (or a member) and the setup token is gone. */
  provisioned: z.boolean(),
  role: z.string().nullable(),
  domain: z.string().nullable(),
  /** Whether the presented setup token is valid; null when none was presented. */
  tokenValid: z.boolean().nullable(),
  hostname: z.string(),
  fqdn: z.string(),
  os: z.string(),
  addresses: z.array(z.object({ iface: z.string(), address: z.string(), prefix: z.number(), dynamic: z.boolean() })),
  nameservers: z.array(z.string()),
});
export type SetupState = z.infer<typeof setupState>;

export const provisionResult = z.object({
  domain: z.string(),
  realm: z.string(),
  domainDn: z.string(),
  domainSid: z.string(),
  dcFqdn: z.string(),
  serviceAccounts: z.array(z.object({ name: z.string(), sam: z.string(), guid: z.string() })),
});
export type ProvisionResult = z.infer<typeof provisionResult>;

/** The confirmation phrase a user types before provisioning or joining: the domain name. */
export const confirmationPhrase = (args: { domain: string }): string => args.domain.toLowerCase();
