// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Group policy objects (ROADMAP Phase 3): the pieces the agent and the API share. A GPO is a groupPolicyContainer
 * `CN={GUID},CN=Policies,CN=System,<domain>` plus its SYSVOL folder; `versionNumber` (and `GPT.INI`'s `Version`)
 * counts user changes in the high 16 bits and computer changes in the low 16 bits, and clients only reapply a GPO
 * whose version went up. Links live in each container's `gPLink`: `[LDAP://<GPO DN>;<options>]…`, options bit 0 =
 * link disabled, bit 1 = enforced; the last link in the attribute has link order 1 (it wins).
 */
import { z } from 'zod';

/** A GPO's name in the directory: `{GUID}`, upper case as Windows and samba-tool write it. */
export const gpoGuid = z
  .string()
  .regex(/^\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$/, 'a GPO id: {GUID}')
  .transform((s) => s.toUpperCase());

/** A GPO's display name (no control characters; GPMC limits names to 255). */
export const gpoName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'no control characters');

export const gpoBackupInfo = z.object({
  id: z.uuid(),
  gpo: z.string(),
  displayName: z.string(),
  version: z.number().int(),
  createdAt: z.string(),
  files: z.number().int(),
  bytes: z.number().int(),
});
export type GpoBackupInfo = z.infer<typeof gpoBackupInfo>;

/** What a backup keeps of the container (the files are a copy of the SYSVOL folder). */
export const gpoBackupMeta = gpoBackupInfo.extend({
  flags: z.number().int(),
  machineExtensionNames: z.string().nullable(),
  userExtensionNames: z.string().nullable(),
  wqlFilter: z.string().nullable(),
});
export type GpoBackupMeta = z.infer<typeof gpoBackupMeta>;

/** versionNumber as AD stores it (signed 32 bit) -> its user and computer halves. */
export function splitVersion(v: number): { user: number; computer: number } {
  const u = v >>> 0;
  return { user: u >>> 16, computer: u & 0xffff };
}

/**
 * The version a restored GPO gets: both halves above the current GPO's and the backup's, so every client
 * reapplies it. Returned as AD stores it (signed 32 bit).
 */
export function restoredVersion(current: number, backup: number): number {
  const c = splitVersion(current);
  const b = splitVersion(backup);
  const user = (Math.max(c.user, b.user) + 1) & 0xffff;
  const computer = (Math.max(c.computer, b.computer) + 1) & 0xffff;
  return (user << 16) | computer | 0;
}

/** GPT.INI with `Version` set (other lines kept; CRLF as Windows writes it). */
export function withGptVersion(text: string | null, version: number): string {
  // an INI line, not LDAP (built without a template so the LDAP lint doesn't take it for a DN)
  const entry = 'Version=' + String(version >>> 0);
  const lines = (text ?? '[General]\r\n').split(/\r?\n/);
  while (lines.length && lines.at(-1) === '') lines.pop();
  const i = lines.findIndex((l) => /^\s*version\s*=/i.test(l));
  if (i >= 0) lines[i] = entry;
  else {
    const g = lines.findIndex((l) => /^\s*\[general\]\s*$/i.test(l));
    if (g < 0) lines.unshift('[General]', entry);
    else lines.splice(g + 1, 0, entry);
  }
  return `${lines.join('\r\n')}\r\n`;
}

export interface GpLink {
  /** `{GUID}` of the linked GPO (upper case) */
  gpo: string;
  dn: string;
  disabled: boolean;
  enforced: boolean;
  /** 1 = applied last (wins), as GPMC numbers them */
  order: number;
}

/** Parses a gPLink value; entries that don't name a GPO are skipped. */
export function parseGpLink(value: string | null | undefined): GpLink[] {
  const raw = [...(value ?? '').matchAll(/\[LDAP:\/\/([^;\]]+);(\d+)\]/gi)];
  const out: GpLink[] = [];
  raw.forEach((m, i) => {
    const dn = m[1] ?? '';
    const gpo = /^cn=(\{[0-9a-f-]{36}\}),/i.exec(dn)?.[1]?.toUpperCase();
    if (!gpo) return;
    const options = Number(m[2]);
    out.push({ gpo, dn, disabled: (options & 1) !== 0, enforced: (options & 2) !== 0, order: raw.length - i });
  });
  return out.sort((a, b) => a.order - b.order);
}
