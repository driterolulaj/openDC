// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Validation of the names a domain is built from (setup wizard, CLI, agent). Browser-safe. The rules are the
 * intersection of DNS (RFC 1123), NetBIOS (15 characters) and what Samba's provisioning accepts.
 */
import { z } from 'zod';

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Host names that break Windows clients, Samba or Kerberos when used as a computer name. */
const RESERVED_HOSTS = new Set(['localhost', 'domain', 'gateway', 'admin', 'administrator', 'krbtgt', 'guest']);

export type NameIssue =
  | 'empty'
  | 'too-long'
  | 'invalid-chars'
  | 'numeric'
  | 'reserved'
  | 'single-label'
  | 'mdns-local'
  | 'netbios-dot'
  | 'netbios-equals-host';

/** Short host name: a DNS label that is also a valid NetBIOS name (≤ 15 characters, not all digits). */
export function hostLabelIssue(name: string): NameIssue | null {
  const n = name.toLowerCase();
  if (!n) return 'empty';
  if (n.length > 15) return 'too-long';
  if (!LABEL.test(n)) return 'invalid-chars';
  if (/^\d+$/.test(n)) return 'numeric';
  if (RESERVED_HOSTS.has(n)) return 'reserved';
  return null;
}

/** DNS domain of the AD domain (the realm in lower case): at least two labels, no `.local`. */
export function dnsDomainIssue(domain: string): NameIssue | null {
  const d = domain.toLowerCase().replace(/\.$/, '');
  if (!d) return 'empty';
  if (d.length > 200) return 'too-long';
  const labels = d.split('.');
  if (labels.length < 2) return 'single-label';
  if (!labels.every((l) => LABEL.test(l))) return 'invalid-chars';
  if (/^\d+$/.test(labels[labels.length - 1] ?? '')) return 'numeric';
  if (labels[labels.length - 1] === 'local') return 'mdns-local';
  return null;
}

/** NetBIOS domain name: ≤ 15 characters, letters, digits and hyphens, not the host name. */
export function netbiosIssue(name: string, hostShort?: string): NameIssue | null {
  if (!name) return 'empty';
  if (name.includes('.')) return 'netbios-dot';
  if (name.length > 15) return 'too-long';
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name)) return 'invalid-chars';
  if (/^\d+$/.test(name)) return 'numeric';
  if (hostShort && name.toLowerCase() === hostShort.toLowerCase()) return 'netbios-equals-host';
  return null;
}

/** Default NetBIOS name for a DNS domain: its first label, upper case, cut to 15 characters. */
export function defaultNetbios(domain: string): string {
  return (domain.split('.')[0] ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 15);
}

export type PasswordIssue = 'too-short' | 'too-long' | 'complexity' | 'contains-name';

/**
 * AD default complexity (also what Samba enforces at provisioning): at least 8 characters, three of four
 * character classes, and not containing the account name.
 */
export function passwordIssue(password: string, accountName = 'Administrator', minLength = 8): PasswordIssue | null {
  if (password.length < minLength) return 'too-short';
  if (password.length > 256) return 'too-long';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) return 'complexity';
  if (accountName.length >= 3 && password.toLowerCase().includes(accountName.toLowerCase())) return 'contains-name';
  return null;
}

const refineIssue =
  <T extends string>(check: (v: string) => string | null) =>
  (v: T, ctx: z.RefinementCtx): void => {
    const issue = check(v);
    if (issue) ctx.addIssue({ code: 'custom', message: issue });
  };

export const hostLabelSchema = z.string().max(15).superRefine(refineIssue(hostLabelIssue));
export const dnsDomainSchema = z
  .string()
  .max(200)
  .transform((s) => s.toLowerCase().replace(/\.$/, ''))
  .superRefine(refineIssue(dnsDomainIssue));
export const netbiosSchema = z
  .string()
  .max(15)
  .transform((s) => s.toUpperCase())
  .superRefine(refineIssue((v) => netbiosIssue(v)));
/** FQDN of a DC: a valid host label followed by the DNS domain. */
export const fqdnSchema = z
  .string()
  .max(253)
  .transform((s) => s.toLowerCase().replace(/\.$/, ''))
  .superRefine((v, ctx) => {
    const [host = '', ...rest] = v.split('.');
    const issue = hostLabelIssue(host) ?? dnsDomainIssue(rest.join('.'));
    if (issue) ctx.addIssue({ code: 'custom', message: issue });
  });
export const adminPasswordSchema = z
  .string()
  .max(256)
  .superRefine(refineIssue((v) => passwordIssue(v)));

/** IPv4 network in CIDR notation. */
export const cidr4Schema = z.string().regex(/^(\d{1,3}\.){3}\d{1,3}\/(\d|[12]\d|3[0-2])$/, 'IPv4 CIDR');
