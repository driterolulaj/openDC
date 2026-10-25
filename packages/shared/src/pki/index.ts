// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Internal PKI (ADR-0007): certificate profiles, the OpenSSL extension sections they turn into, the renewal rule
 * and the directory payloads (public data only: certificates, CRLs, the issued-certificate index, issuer
 * requests). Pure; the agent runs openssl, the API and watcher read the directory.
 */
import { z } from 'zod';

export const PKI_PROFILES = ['root', 'issuer', 'node', 'web', 'ldaps'] as const;
export type PkiProfile = (typeof PKI_PROFILES)[number];

/** Default lifetimes in days (ADR-0007 §1-3). */
export const LIFETIME_DAYS: Record<PkiProfile, number> = {
  root: 3650,
  issuer: 1095,
  node: 365,
  web: 365,
  ldaps: 365,
};

const DNS_NAME = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;
export const isDnsName = (s: string): boolean => DNS_NAME.test(s);

/** A subject common name we put into `-subj`: letters, digits, space, dot, hyphen only (no `/`, `=`, `+`). */
export function safeCn(s: string): string {
  const v = s
    .replace(/[^A-Za-z0-9 .-]/g, '')
    .trim()
    .slice(0, 64);
  if (!v) throw new TypeError(`empty subject name from ${JSON.stringify(s)}`);
  return v;
}

export interface LeafRequest {
  profile: Exclude<PkiProfile, 'root' | 'issuer'>;
  fqdn: string;
  /** objectGUID of the node's computer account (node profile) */
  nodeGuid?: string;
  /** additional DNS names (web: console aliases; ldaps: the domain name) */
  extraNames?: string[];
}

/** The SANs of a leaf certificate, validated against the profile's rules. */
export function leafSans(r: LeafRequest): string[] {
  const names = [r.fqdn, ...(r.extraNames ?? [])];
  for (const n of names) if (!isDnsName(n)) throw new TypeError(`not a DNS name: ${n}`);
  const sans = [...new Set(names.map((n) => n.toLowerCase()))].map((n) => `DNS:${n}`);
  if (r.profile === 'node') {
    if (!r.nodeGuid || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.nodeGuid))
      throw new TypeError('a node certificate needs the node GUID');
    sans.push(`URI:urn:opendc:node:${r.nodeGuid.toLowerCase()}`);
  }
  return sans;
}

/** OpenSSL extension section (`-extfile … -extensions v3`) for a profile. */
export function extensionSection(o: { profile: PkiProfile; sans?: string[]; crlUrl?: string }): string {
  const lines = ['[v3]', 'subjectKeyIdentifier = hash'];
  if (o.profile !== 'root') lines.push('authorityKeyIdentifier = keyid:always');
  switch (o.profile) {
    case 'root':
      lines.push('basicConstraints = critical, CA:TRUE, pathlen:1', 'keyUsage = critical, keyCertSign, cRLSign');
      break;
    case 'issuer':
      lines.push('basicConstraints = critical, CA:TRUE, pathlen:0', 'keyUsage = critical, keyCertSign, cRLSign');
      break;
    case 'node':
      lines.push(
        'basicConstraints = critical, CA:FALSE',
        'keyUsage = critical, digitalSignature, keyAgreement',
        'extendedKeyUsage = serverAuth, clientAuth',
      );
      break;
    case 'web':
    case 'ldaps':
      lines.push(
        'basicConstraints = critical, CA:FALSE',
        'keyUsage = critical, digitalSignature, keyAgreement',
        'extendedKeyUsage = serverAuth',
      );
      break;
  }
  if (o.sans?.length) {
    for (const s of o.sans) if (!/^(DNS|URI):[A-Za-z0-9.:_-]+$/.test(s)) throw new TypeError(`bad SAN ${s}`);
    lines.push(`subjectAltName = ${o.sans.join(', ')}`);
  }
  if (o.crlUrl) {
    if (!/^https?:\/\/[A-Za-z0-9.:-]+\/pki\/crl\/[A-Za-z0-9-]+\.crl$/.test(o.crlUrl))
      throw new TypeError('bad CRL URL');
    lines.push(`crlDistributionPoints = URI:${o.crlUrl}`);
  }
  return lines.join('\n') + '\n';
}

/** ADR-0007 §3: renew at 2/3 of the lifetime. */
export function renewalDue(notBefore: Date, notAfter: Date, now: Date, fraction = 2 / 3): boolean {
  const life = notAfter.getTime() - notBefore.getTime();
  return now.getTime() >= notBefore.getTime() + life * fraction;
}

/** A positive 128-bit serial in hex (top bit clear). */
export function serialHex(random: Uint8Array): string {
  if (random.length !== 16) throw new TypeError('16 random bytes');
  const b = Uint8Array.from(random);
  b[0] = (b[0] ?? 0) & 0x7f;
  if (b[0] === 0) b[0] = 1;
  return Buffer.from(b).toString('hex').toUpperCase();
}

// ---------------------------------------------------------------- directory payloads (CN=PKI)

const pem = z.string().max(16_384).startsWith('-----BEGIN ');
const guid = z.string().regex(/^[0-9a-f-]{36}$/i);

/** CN=Root,CN=PKI: the root certificate (nodes pin its fingerprint; this copy is for display and new nodes). */
export const pkiRoot = z.object({
  certPem: pem,
  fingerprint: z.string(),
  holderNodeGuid: guid,
  holder: z.string(),
  /** the root's CRL (revoked issuing CAs); verifiers need it for the whole chain */
  crlPem: pem.nullable().default(null),
  crlNumber: z.number().int().nonnegative().default(0),
  crlNextUpdate: z.string().nullable().default(null),
});
/** CN=<issuer id>,CN=Issuers,CN=PKI: one issuing CA per writable DC, with its current CRL. */
export const pkiIssuer = z.object({
  id: z.string(),
  nodeGuid: guid,
  host: z.string(),
  certPem: pem,
  crlPem: pem.nullable(),
  crlNumber: z.number().int().nonnegative(),
  crlNextUpdate: z.string().nullable(),
  /** the revoked serials the current CRL lists (regenerate when the index differs) */
  crlSerials: z.array(z.string()).default([]),
});
/** CN=<serial>,CN=Certificates,CN=PKI: what was issued (public metadata only). */
export const pkiCert = z.object({
  serial: z.string(),
  issuerId: z.string(),
  profile: z.enum(PKI_PROFILES),
  subject: z.string(),
  sans: z.array(z.string()),
  nodeGuid: guid.nullable(),
  notBefore: z.string(),
  notAfter: z.string(),
  revoked: z.object({ at: z.string(), reason: z.string() }).nullable(),
});
/** CN=<node guid>,CN=Requests,CN=PKI: a DC without the root key asks for its issuing CA (admin approves). */
export const pkiIssuerRequest = z.object({
  nodeGuid: guid,
  host: z.string(),
  csrPem: pem,
  requestedAt: z.string(),
  state: z.enum(['pending', 'signed', 'rejected']),
});
export type PkiRoot = z.infer<typeof pkiRoot>;
export type PkiIssuer = z.infer<typeof pkiIssuer>;
export type PkiCert = z.infer<typeof pkiCert>;
export type PkiIssuerRequest = z.infer<typeof pkiIssuerRequest>;

export const REVOCATION_REASONS = ['unspecified', 'keyCompromise', 'superseded', 'cessationOfOperation'] as const;
